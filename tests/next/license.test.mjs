// tests/next/license.test.mjs
//
// Tests de la licence (src/license/license.js) — docs/next/07 §11.
// Couvre : essai J0/J19/J20/J21, licence valide, mauvaise signature, mauvais
// workspace, expirée, perpétuelle, limite membres, et à expiration
// lecture/export restent autorisés tandis que l'écriture est bloquée.
//
// Une paire de clés Ed25519 de test est générée ici (WebCrypto native) pour
// signer des licences de test — jamais la vraie clé éditeur.

import test from "node:test";
import assert from "node:assert/strict";

import {
  LICENSE_FORMAT,
  canonicalizeLicense,
  verifyLicense,
  trialStatus,
  licenseStatus,
  enforcement,
  canAddMember,
} from "../../src/license/license.js";
import { createLocalWorkspace, createTeamWorkspace } from "../../src/workspace/workspace.js";
import { sign } from "../../src/crypto/crypto-service.js";

// ---------------------------------------------------------------------------
// Helpers de test
// ---------------------------------------------------------------------------

async function generateTestEditorKeypair() {
  const s = globalThis.crypto.subtle;
  const keyPair = await s.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyJwk = await s.exportKey("jwk", keyPair.publicKey);
  return { publicKeyJwk, privateKeyRef: { keyType: "ed25519", cryptoKey: keyPair.privateKey } };
}

async function signLicense(privateKeyRef, licenseWithoutSignature) {
  const bytes = canonicalizeLicense(licenseWithoutSignature);
  const signature = await sign(privateKeyRef, bytes);
  return { ...licenseWithoutSignature, signature };
}

function makeLicenseFields(overrides = {}) {
  const now = new Date("2026-09-01T00:00:00.000Z");
  return {
    format: LICENSE_FORMAT,
    licenseId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    plan: "TEAM",
    maxMembers: 20,
    issuedAt: now.toISOString(),
    notBefore: now.toISOString(),
    expiresAt: "2027-09-01T00:00:00.000Z",
    features: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Essai (trialStatus)
// ---------------------------------------------------------------------------

test("trialStatus: J0 -> trial, 20 jours restants", () => {
  const created = "2026-08-30T00:00:00.000Z";
  const now = "2026-08-30T00:00:00.000Z";
  const status = trialStatus(created, now);
  assert.equal(status.state, "trial");
  assert.equal(status.daysLeft, 20);
});

test("trialStatus: J19 -> encore trial, 1 jour restant", () => {
  const created = "2026-08-30T00:00:00.000Z";
  const now = "2026-09-18T00:00:00.000Z"; // +19 jours
  const status = trialStatus(created, now);
  assert.equal(status.state, "trial");
  assert.equal(status.daysLeft, 1);
});

test("trialStatus: J20 -> expired, 0 jour restant", () => {
  const created = "2026-08-30T00:00:00.000Z";
  const now = "2026-09-19T00:00:00.000Z"; // +20 jours
  const status = trialStatus(created, now);
  assert.equal(status.state, "expired");
  assert.equal(status.daysLeft, 0);
});

test("trialStatus: J21 -> expired, jamais négatif", () => {
  const created = "2026-08-30T00:00:00.000Z";
  const now = "2026-09-20T00:00:00.000Z"; // +21 jours
  const status = trialStatus(created, now);
  assert.equal(status.state, "expired");
  assert.equal(status.daysLeft, 0);
});

test("trialStatus: trialDays personnalisé", () => {
  const created = "2026-08-30T00:00:00.000Z";
  const now = "2026-08-31T00:00:00.000Z"; // +1 jour
  const status = trialStatus(created, now, { trialDays: 1 });
  assert.equal(status.state, "expired");
});

// ---------------------------------------------------------------------------
// verifyLicense
// ---------------------------------------------------------------------------

test("verifyLicense: licence valide, signature correcte, workspace correspondant", async () => {
  const { publicKeyJwk, privateKeyRef } = await generateTestEditorKeypair();
  const fields = makeLicenseFields();
  const license = await signLicense(privateKeyRef, fields);

  const result = await verifyLicense(license, {
    publicKeyJwk,
    workspaceId: fields.workspaceId,
    now: "2026-09-15T00:00:00.000Z",
  });
  assert.equal(result.valid, true);
  assert.equal(result.expired, false);
  assert.equal(result.plan, "TEAM");
  assert.equal(result.reason, null);
});

test("verifyLicense: mauvaise signature => invalide", async () => {
  const { publicKeyJwk, privateKeyRef } = await generateTestEditorKeypair();
  const fields = makeLicenseFields();
  const license = await signLicense(privateKeyRef, fields);
  const tampered = { ...license, plan: "SOLO" }; // altère le payload signé

  const result = await verifyLicense(tampered, {
    publicKeyJwk,
    workspaceId: fields.workspaceId,
    now: "2026-09-15T00:00:00.000Z",
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "invalid-signature");
});

test("verifyLicense: signée avec une AUTRE clé privée => invalide", async () => {
  const { publicKeyJwk } = await generateTestEditorKeypair();
  const other = await generateTestEditorKeypair();
  const fields = makeLicenseFields();
  const license = await signLicense(other.privateKeyRef, fields);

  const result = await verifyLicense(license, {
    publicKeyJwk, // clé publique qui NE correspond PAS à la clé privée utilisée
    workspaceId: fields.workspaceId,
    now: "2026-09-15T00:00:00.000Z",
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "invalid-signature");
});

test("verifyLicense: mauvais workspace => invalide", async () => {
  const { publicKeyJwk, privateKeyRef } = await generateTestEditorKeypair();
  const fields = makeLicenseFields();
  const license = await signLicense(privateKeyRef, fields);

  const result = await verifyLicense(license, {
    publicKeyJwk,
    workspaceId: "99999999-9999-4999-8999-999999999999",
    now: "2026-09-15T00:00:00.000Z",
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "workspace-mismatch");
});

test("verifyLicense: licence expirée => valid:true mais expired:true", async () => {
  const { publicKeyJwk, privateKeyRef } = await generateTestEditorKeypair();
  const fields = makeLicenseFields({ expiresAt: "2026-09-10T00:00:00.000Z" });
  const license = await signLicense(privateKeyRef, fields);

  const result = await verifyLicense(license, {
    publicKeyJwk,
    workspaceId: fields.workspaceId,
    now: "2026-09-11T00:00:00.000Z",
  });
  assert.equal(result.valid, true);
  assert.equal(result.expired, true);
});

test("verifyLicense: expiresAt:null => perpétuelle, jamais expirée", async () => {
  const { publicKeyJwk, privateKeyRef } = await generateTestEditorKeypair();
  const fields = makeLicenseFields({ expiresAt: null });
  const license = await signLicense(privateKeyRef, fields);

  const result = await verifyLicense(license, {
    publicKeyJwk,
    workspaceId: fields.workspaceId,
    now: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(result.valid, true);
  assert.equal(result.expired, false);
});

test("verifyLicense: licence malformée => invalide, ne lève pas", async () => {
  const { publicKeyJwk } = await generateTestEditorKeypair();
  const result = await verifyLicense({ format: "wrong" }, { publicKeyJwk, workspaceId: "x", now: Date.now() });
  assert.equal(result.valid, false);
  assert.match(result.reason, /malformed/);
});

test("verifyLicense: notBefore dans le futur => invalide (not-yet-valid)", async () => {
  const { publicKeyJwk, privateKeyRef } = await generateTestEditorKeypair();
  const fields = makeLicenseFields({ notBefore: "2026-10-01T00:00:00.000Z" });
  const license = await signLicense(privateKeyRef, fields);

  const result = await verifyLicense(license, {
    publicKeyJwk,
    workspaceId: fields.workspaceId,
    now: "2026-09-15T00:00:00.000Z",
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "not-yet-valid");
});

// ---------------------------------------------------------------------------
// licenseStatus (composition essai + licence)
// ---------------------------------------------------------------------------

test("licenseStatus: workspace local => none (gratuit, pas de licence requise)", async () => {
  const ws = createLocalWorkspace("Perso");
  const status = await licenseStatus(ws, null, new Date());
  assert.equal(status, "none");
});

test("licenseStatus: workspace team sans licence, dans la fenêtre d'essai => trial", async () => {
  const ws = createTeamWorkspace("ACME", { provider: "google-drive", rootId: "r1" });
  const now = new Date(new Date(ws.createdAt).getTime() + 5 * 24 * 60 * 60 * 1000); // +5j
  const status = await licenseStatus(ws, null, now);
  assert.equal(status, "trial");
});

test("licenseStatus: workspace team sans licence, essai dépassé => expired", async () => {
  const ws = createTeamWorkspace("ACME", { provider: "google-drive", rootId: "r1" });
  const now = new Date(new Date(ws.createdAt).getTime() + 25 * 24 * 60 * 60 * 1000); // +25j
  const status = await licenseStatus(ws, null, now);
  assert.equal(status, "expired");
});

test("licenseStatus: licence valide non expirée => active (même si essai dépassé)", async () => {
  const { publicKeyJwk, privateKeyRef } = await generateTestEditorKeypair();
  const ws = createTeamWorkspace("ACME", { provider: "google-drive", rootId: "r1" });
  const fields = makeLicenseFields({ workspaceId: ws.id, expiresAt: null });
  const license = await signLicense(privateKeyRef, fields);
  const now = new Date(new Date(ws.createdAt).getTime() + 100 * 24 * 60 * 60 * 1000);

  const status = await licenseStatus(ws, license, now, { publicKeyJwk });
  assert.equal(status, "active");
});

test("licenseStatus: licence expirée => expired", async () => {
  const { publicKeyJwk, privateKeyRef } = await generateTestEditorKeypair();
  const ws = createTeamWorkspace("ACME", { provider: "google-drive", rootId: "r1" });
  const fields = makeLicenseFields({ workspaceId: ws.id, expiresAt: "2026-09-10T00:00:00.000Z" });
  const license = await signLicense(privateKeyRef, fields);

  const status = await licenseStatus(ws, license, "2026-09-11T00:00:00.000Z", { publicKeyJwk });
  assert.equal(status, "expired");
});

test("licenseStatus: licence invalide (mauvaise signature) => retombe sur l'état d'essai", async () => {
  const { publicKeyJwk, privateKeyRef } = await generateTestEditorKeypair();
  const ws = createTeamWorkspace("ACME", { provider: "google-drive", rootId: "r1" });
  const fields = makeLicenseFields({ workspaceId: ws.id });
  const license = await signLicense(privateKeyRef, fields);
  const tampered = { ...license, plan: "SOLO" };
  const now = new Date(new Date(ws.createdAt).getTime() + 5 * 24 * 60 * 60 * 1000); // dans l'essai

  const status = await licenseStatus(ws, tampered, now, { publicKeyJwk });
  assert.equal(status, "trial");
});

// ---------------------------------------------------------------------------
// enforcement — jamais de blocage lecture/export/sauvegarde/licence
// ---------------------------------------------------------------------------

test("enforcement: trial/active/none autorisent tout", () => {
  for (const status of ["trial", "active", "none"]) {
    const caps = enforcement(status);
    assert.equal(caps.read, true);
    assert.equal(caps.export, true);
    assert.equal(caps.backup, true);
    assert.equal(caps.viewLicense, true);
    assert.equal(caps.create, true);
    assert.equal(caps.update, true);
    assert.equal(caps.invite, true);
  }
});

test("enforcement: expired bloque création/modification/invitation mais jamais lecture/export/sauvegarde/licence", () => {
  const caps = enforcement("expired");
  assert.equal(caps.read, true);
  assert.equal(caps.export, true);
  assert.equal(caps.backup, true);
  assert.equal(caps.viewLicense, true);
  assert.equal(caps.create, false);
  assert.equal(caps.update, false);
  assert.equal(caps.invite, false);
  assert.equal(caps.write, false);
});

// ---------------------------------------------------------------------------
// canAddMember — limite de membres sur les memberships actifs
// ---------------------------------------------------------------------------

test("canAddMember: sous la limite => true", () => {
  assert.equal(canAddMember(19, 20), true);
});

test("canAddMember: à la limite => false", () => {
  assert.equal(canAddMember(20, 20), false);
});

test("canAddMember: au-delà de la limite => false", () => {
  assert.equal(canAddMember(25, 20), false);
});

test("canAddMember: maxMembers null/undefined => illimité", () => {
  assert.equal(canAddMember(1000, null), true);
  assert.equal(canAddMember(1000, undefined), true);
});
