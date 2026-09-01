// tests/next/org-revocation.test.mjs
//
// Couvre docs/next/ORG_REVOCATION_CONTRACT.md — lot 2c-A : révocation
// signée + durcissement issuerId. S'appuie sur le même harnais que
// tests/next/org-runtime.test.mjs (fonctions PURES composant
// crypto-service/memberships/invitations/workspace), étendu à
// `createRevocation`/`verifyRevocation`/`revocationCanonicalPayload` et à
// `buildTrustedMembership({..., revocations})` (algorithme 3 passes, §2).

import test from "node:test";
import assert from "node:assert/strict";

import {
  newMemberIdentity,
  createOrganization,
  inviteMember,
  acceptInvitation,
  verifyInvitation,
  buildTrustedMembership,
  createRevocation,
  verifyRevocation,
  revocationCanonicalPayload,
} from "../../src/workspace/org-runtime.js";
import * as cryptoService from "../../src/crypto/crypto-service.js";
import { canonicalize } from "../../src/events/event-schema.js";
import { EventLog } from "../../src/events/event-log.js";
import * as policy from "../../src/core/permissions.js";
import { InMemoryStorageAdapter } from "../../src/storage/in-memory-adapter.js";
import { SyncEngine } from "../../src/sync/sync-engine.js";
import { createMembership } from "../../src/workspace/memberships.js";
import { createInvitation } from "../../src/workspace/invitations.js";

/** Construit une organisation fraîche : owner + son signer Ed25519 (même
 *  harnais que tests/next/org-runtime.test.mjs). */
async function makeOrg(name = "Org") {
  const ownerIdentity = await newMemberIdentity();
  const org = createOrganization({ name, identity: ownerIdentity, consultantId: "c-owner" });
  const ownerSigner = (bytes) => cryptoService.sign(ownerIdentity.privateKeyRef, bytes);
  return { ownerIdentity, org, ownerSigner };
}

/** Fait entrer un admin de confiance dans une org fraîche (owner invite,
 *  admin accepte) — utilitaire réutilisé par plusieurs tests ci-dessous. */
async function makeOrgWithAdmin() {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitationAdmin = await inviteMember({
    workspaceId: org.workspace.workspaceId,
    role: "admin",
    issuer: { memberId: ownerIdentity.memberId },
    issuerMembership: org.ownerMembership,
    signer: ownerSigner,
  });
  const adminIdentity = await newMemberIdentity();
  const { membership: adminMembership, memberRecord: adminRecord } = await acceptInvitation({
    invitation: invitationAdmin,
    identity: adminIdentity,
    consultantId: "c-admin",
  });
  const adminSigner = (bytes) => cryptoService.sign(adminIdentity.privateKeyRef, bytes);
  return { org, ownerIdentity, ownerSigner, adminIdentity, adminMembership, adminRecord, adminSigner };
}

// ---------------------------------------------------------------------------
// createRevocation — §1 : autorité de révocation
// ---------------------------------------------------------------------------

test("createRevocation : owner révoque owner/admin/user (OK) ; admin révoque user (OK) ; admin révoque owner/admin (throw) ; user ne révoque personne (throw)", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const adminIdentity = await newMemberIdentity();
  const adminMembership = createMembership({
    workspaceId: org.workspace.workspaceId, memberId: adminIdentity.memberId, consultantId: "c-admin", role: "admin",
  });
  const adminSigner = (bytes) => cryptoService.sign(adminIdentity.privateKeyRef, bytes);
  const userIdentity = await newMemberIdentity();
  const userMembership = createMembership({
    workspaceId: org.workspace.workspaceId, memberId: userIdentity.memberId, consultantId: "c-user", role: "user",
  });
  const userSigner = (bytes) => cryptoService.sign(userIdentity.privateKeyRef, bytes);
  const otherOwnerId = globalThis.crypto.randomUUID();

  // owner révoque un admin.
  const ownerRevokesAdmin = await createRevocation({
    workspaceId: org.workspace.workspaceId, revokedMemberId: adminIdentity.memberId,
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership,
    revokedRole: "admin", signer: ownerSigner,
  });
  assert.equal(ownerRevokesAdmin.kind, "revocation");
  assert.equal(ownerRevokesAdmin.revokedMemberId, adminIdentity.memberId);
  assert.equal(ownerRevokesAdmin.issuerId, ownerIdentity.memberId);
  assert.ok(ownerRevokesAdmin.proof);

  // owner révoque un autre owner.
  await assert.doesNotReject(() =>
    createRevocation({
      workspaceId: org.workspace.workspaceId, revokedMemberId: otherOwnerId,
      issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership,
      revokedRole: "owner", signer: ownerSigner,
    })
  );

  // owner révoque un user.
  await assert.doesNotReject(() =>
    createRevocation({
      workspaceId: org.workspace.workspaceId, revokedMemberId: userIdentity.memberId,
      issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership,
      revokedRole: "user", signer: ownerSigner,
    })
  );

  // admin révoque un user.
  await assert.doesNotReject(() =>
    createRevocation({
      workspaceId: org.workspace.workspaceId, revokedMemberId: userIdentity.memberId,
      issuer: { memberId: adminIdentity.memberId }, issuerMembership: adminMembership,
      revokedRole: "user", signer: adminSigner,
    })
  );

  // admin révoque un owner => throw.
  await assert.rejects(
    () =>
      createRevocation({
        workspaceId: org.workspace.workspaceId, revokedMemberId: ownerIdentity.memberId,
        issuer: { memberId: adminIdentity.memberId }, issuerMembership: adminMembership,
        revokedRole: "owner", signer: adminSigner,
      }),
    /autorité/
  );

  // admin révoque un autre admin => throw.
  const admin2Id = globalThis.crypto.randomUUID();
  await assert.rejects(
    () =>
      createRevocation({
        workspaceId: org.workspace.workspaceId, revokedMemberId: admin2Id,
        issuer: { memberId: adminIdentity.memberId }, issuerMembership: adminMembership,
        revokedRole: "admin", signer: adminSigner,
      }),
    /autorité/
  );

  // user ne révoque personne => throw (même une cible user).
  await assert.rejects(
    () =>
      createRevocation({
        workspaceId: org.workspace.workspaceId, revokedMemberId: adminIdentity.memberId,
        issuer: { memberId: userIdentity.memberId }, issuerMembership: userMembership,
        revokedRole: "admin", signer: userSigner,
      }),
    /autorité/
  );
});

// ---------------------------------------------------------------------------
// verifyRevocation — §1
// ---------------------------------------------------------------------------

test("verifyRevocation : accepte une révocation légitime ; rejette proof bidon, émetteur inconnu, émetteur sans autorité suffisante", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const adminIdentity = await newMemberIdentity();
  const adminSigner = (bytes) => cryptoService.sign(adminIdentity.privateKeyRef, bytes);

  const registry = {
    getPublicKey: (id) => {
      if (id === ownerIdentity.memberId) return ownerIdentity.publicKeyJwk;
      if (id === adminIdentity.memberId) return adminIdentity.publicKeyJwk;
      return null;
    },
    getMembership: (id) => {
      if (id === ownerIdentity.memberId) return { role: "owner", status: "active" };
      if (id === adminIdentity.memberId) return { role: "admin", status: "active" };
      return null;
    },
  };

  const legit = await createRevocation({
    workspaceId: org.workspace.workspaceId, revokedMemberId: adminIdentity.memberId,
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership,
    revokedRole: "admin", signer: ownerSigner,
  });
  const ok = await verifyRevocation(legit, { registry });
  assert.equal(ok.ok, true);

  // proof altéré.
  const tampered = { ...legit, proof: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
  const tamperedResult = await verifyRevocation(tampered, { registry });
  assert.equal(tamperedResult.ok, false);
  assert.match(tamperedResult.reason, /proof/);

  // émetteur inconnu du registre de confiance.
  const unknownIssuer = { ...legit, issuerId: "inconnu-total" };
  const unknownResult = await verifyRevocation(unknownIssuer, { registry });
  assert.equal(unknownResult.ok, false);
  assert.match(unknownResult.reason, /inconnu/);

  // émetteur de confiance mais sans autorité suffisante : admin signe
  // valablement une révocation visant l'owner (proof correct, mais rang
  // insuffisant) — construite en direct pour contourner le garde-fou de
  // `createRevocation` et isoler la vérification faite par `verifyRevocation`.
  const revokedAt = new Date().toISOString();
  const forgedCanonical = revocationCanonicalPayload({
    workspaceId: org.workspace.workspaceId, revokedMemberId: ownerIdentity.memberId, revokedAt, issuerId: adminIdentity.memberId,
  });
  const forgedProof = await adminSigner(new TextEncoder().encode(forgedCanonical));
  const forgedRevocation = {
    kind: "revocation", workspaceId: org.workspace.workspaceId, revokedMemberId: ownerIdentity.memberId,
    revokedAt, issuerId: adminIdentity.memberId, proof: forgedProof,
  };
  const forgedResult = await verifyRevocation(forgedRevocation, { registry });
  assert.equal(forgedResult.ok, false);
  assert.match(forgedResult.reason, /autorité/);
});

// ---------------------------------------------------------------------------
// buildTrustedMembership + révocation — §2/§4
// ---------------------------------------------------------------------------

test("buildTrustedMembership : sans révocation, comportement identique au lot précédent (non-régression)", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitationAdmin = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const adminIdentity = await newMemberIdentity();
  const { memberRecord: adminRecord } = await acceptInvitation({
    invitation: invitationAdmin, identity: adminIdentity, consultantId: "c-admin",
  });

  const result = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, adminRecord],
  });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.trusted.length, 2);
  assert.deepEqual(result.revoked, []);
  assert.equal(result.membershipStore.get(org.workspace.workspaceId, adminIdentity.memberId).status, "active");
});

test("buildTrustedMembership : un admin révoqué a status:'revoked' dans le store, et SyncEngine rejette ses NOUVEAUX événements (stage:'membership')", async () => {
  const { org, ownerIdentity, ownerSigner, adminIdentity, adminRecord } = await makeOrgWithAdmin();

  const revocation = await createRevocation({
    workspaceId: org.workspace.workspaceId, revokedMemberId: adminIdentity.memberId,
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership,
    revokedRole: "admin", signer: ownerSigner,
  });

  const { registry, membershipStore, trusted, revoked, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, adminRecord], revocations: [revocation],
  });

  assert.equal(rejected.length, 0);
  assert.equal(trusted.length, 2, "l'admin reste dans l'ensemble de confiance (sa propre fiche reste légitime)");
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].memberId, adminIdentity.memberId);
  assert.equal(revoked[0].revokedBy, ownerIdentity.memberId);
  assert.equal(membershipStore.get(org.workspace.workspaceId, adminIdentity.memberId).status, "revoked");
  assert.equal(registry.getMembership(adminIdentity.memberId).status, "revoked");

  // Un événement publié par l'admin révoqué, APRÈS sa révocation, est
  // rejeté par SyncEngine dès la vérification de membership.
  const adapter = new InMemoryStorageAdapter();
  const forgedEvent = {
    version: 1, eventId: globalThis.crypto.randomUUID(), workspaceId: org.workspace.workspaceId,
    entityType: "consultants", entityId: "cPostRevocation", operation: "create",
    actorId: adminIdentity.memberId, baseVersion: 0, epoch: 1,
    createdAt: new Date().toISOString(), payload: { id: "cPostRevocation", nom: "Post révocation" },
  };
  forgedEvent.signature = await cryptoService.sign(adminIdentity.privateKeyRef, canonicalize(forgedEvent));
  await adapter.putImmutable("event", forgedEvent.eventId, forgedEvent);

  const ownerEngine = new SyncEngine({
    adapter, eventLog: new EventLog(), crypto: cryptoService, policy,
    memberRegistry: registry, membershipStore,
    actor: { workspaceId: org.workspace.workspaceId, memberId: ownerIdentity.memberId, privateKeyRef: ownerIdentity.privateKeyRef },
    trusted: true,
  });
  const pullResult = await ownerEngine.pull();
  assert.equal(pullResult.rejections.length, 1);
  assert.equal(pullResult.rejections[0].stage, "membership");
  assert.equal(ownerEngine.getProjection().consultants?.cPostRevocation, undefined, "jamais appliqué");
});

test("buildTrustedMembership : invitation émise par l'émetteur AVANT sa révocation reste valide ; émise APRÈS => rejetée (chaîne cassée)", async () => {
  const { org, ownerIdentity, ownerSigner, adminIdentity, adminRecord, adminSigner } = await makeOrgWithAdmin();
  const workspaceId = org.workspace.workspaceId;

  const t0 = new Date(); // instant de la révocation
  const before = new Date(t0.getTime() - 60_000);
  const after = new Date(t0.getTime() + 60_000);

  // Invitation émise par l'admin AVANT sa révocation.
  const invitationBefore = await createInvitation({
    workspaceId, role: "user", signer: adminSigner, issuerId: adminIdentity.memberId, now: before,
  });
  const beforeIdentity = await newMemberIdentity();
  const { memberRecord: beforeRecord } = await acceptInvitation({
    invitation: invitationBefore, identity: beforeIdentity, consultantId: "c-before",
  });

  const revocation = await createRevocation({
    workspaceId, revokedMemberId: adminIdentity.memberId,
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership,
    revokedRole: "admin", signer: ownerSigner, now: t0,
  });

  // Invitation émise par l'admin APRÈS sa révocation.
  const invitationAfter = await createInvitation({
    workspaceId, role: "user", signer: adminSigner, issuerId: adminIdentity.memberId, now: after,
  });
  const afterIdentity = await newMemberIdentity();
  const { memberRecord: afterRecord } = await acceptInvitation({
    invitation: invitationAfter, identity: afterIdentity, consultantId: "c-after",
  });

  const { trusted, rejected } = await buildTrustedMembership({
    manifest: org.manifest,
    memberRecords: [org.memberRecord, adminRecord, beforeRecord, afterRecord],
    revocations: [revocation],
  });

  const trustedIds = trusted.map((r) => r.memberId);
  assert.ok(trustedIds.includes(adminIdentity.memberId), "l'admin lui-même reste admis (révoqué, mais chaîne intacte)");
  assert.ok(trustedIds.includes(beforeIdentity.memberId), "invitation émise AVANT la révocation reste valide");
  assert.ok(!trustedIds.includes(afterIdentity.memberId), "invitation émise APRÈS la révocation est rejetée");

  const afterRejection = rejected.find((r) => r.record === afterRecord);
  assert.ok(afterRejection, "la fiche 'après révocation' est journalisée dans rejected");
  assert.match(afterRejection.reason, /chaîne cassée/);
});

test("buildTrustedMembership : cascade — admin A (révoqué) invite B (admin) après sa révocation, B invite C ; ni B ni C ne sont admis", async () => {
  const { org, ownerIdentity, ownerSigner, adminIdentity: aIdentity, adminRecord: aRecord, adminSigner: aSigner } =
    await makeOrgWithAdmin();
  const workspaceId = org.workspace.workspaceId;

  const t0 = new Date();
  const after = new Date(t0.getTime() + 60_000);

  const revocationOfA = await createRevocation({
    workspaceId, revokedMemberId: aIdentity.memberId,
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership,
    revokedRole: "admin", signer: ownerSigner, now: t0,
  });

  // A (révoqué) invite B (admin) APRÈS sa révocation.
  const invitationB = await createInvitation({
    workspaceId, role: "admin", signer: aSigner, issuerId: aIdentity.memberId, now: after,
  });
  const bIdentity = await newMemberIdentity();
  const { membership: bMembership, memberRecord: bRecord } = await acceptInvitation({
    invitation: invitationB, identity: bIdentity, consultantId: "c-b",
  });
  const bSigner = (bytes) => cryptoService.sign(bIdentity.privateKeyRef, bytes);

  // B (jamais légitimement de confiance) invite C.
  const invitationC = await inviteMember({
    workspaceId, role: "user",
    issuer: { memberId: bIdentity.memberId }, issuerMembership: bMembership, signer: bSigner,
  });
  const cIdentity = await newMemberIdentity();
  const { memberRecord: cRecord } = await acceptInvitation({
    invitation: invitationC, identity: cIdentity, consultantId: "c-c",
  });

  const { trusted, rejected } = await buildTrustedMembership({
    manifest: org.manifest,
    memberRecords: [org.memberRecord, aRecord, bRecord, cRecord],
    revocations: [revocationOfA],
  });

  const trustedIds = trusted.map((r) => r.memberId);
  assert.ok(trustedIds.includes(aIdentity.memberId), "A reste admis (révoqué, mais sa propre chaîne est intacte)");
  assert.ok(!trustedIds.includes(bIdentity.memberId), "B n'est PAS admis (invité par A après sa révocation)");
  assert.ok(!trustedIds.includes(cIdentity.memberId), "C n'est PAS admis (cascade via B)");

  assert.ok(rejected.some((r) => r.record === bRecord));
  assert.ok(rejected.some((r) => r.record === cRecord));
  const cRejection = rejected.find((r) => r.record === cRecord);
  assert.match(cRejection.reason, /cascade/);
});

test("buildTrustedMembership : une fiche de révocation forgée (non signée par une autorité de confiance) est rejetée, sans aucun effet", async () => {
  const { org, adminIdentity, adminRecord } = await makeOrgWithAdmin();

  // Mallory, jamais admise, forge (avec sa propre clé, valide en soi) une
  // révocation de l'admin en s'auto-déclarant 'owner'.
  const malloryIdentity = await newMemberIdentity();
  const mallorySigner = (bytes) => cryptoService.sign(malloryIdentity.privateKeyRef, bytes);
  const forgedRevocation = await createRevocation({
    workspaceId: org.workspace.workspaceId, revokedMemberId: adminIdentity.memberId,
    issuer: { memberId: malloryIdentity.memberId },
    issuerMembership: createMembership({
      workspaceId: org.workspace.workspaceId, memberId: malloryIdentity.memberId, consultantId: "c-mallory", role: "owner",
    }),
    revokedRole: "admin", signer: mallorySigner,
  });

  const { trusted, revoked, rejected, membershipStore } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, adminRecord], revocations: [forgedRevocation],
  });

  assert.equal(trusted.length, 2, "aucun effet sur l'admission normale");
  assert.equal(revoked.length, 0, "aucune révocation appliquée");
  assert.equal(membershipStore.get(org.workspace.workspaceId, adminIdentity.memberId).status, "active");

  const revocationRejection = rejected.find((r) => r.record === forgedRevocation);
  assert.ok(revocationRejection, "la fiche de révocation forgée est journalisée dans rejected");
  assert.match(revocationRejection.reason, /révocation invalide/);
});

// ---------------------------------------------------------------------------
// Durcissement issuerId — §3
// ---------------------------------------------------------------------------

test("verifyInvitation : une invitation dont 'issuerId' est modifié après signature est rejetée (le proof ne couvre plus l'issuerId annoncé)", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const adminIdentity2 = await newMemberIdentity();

  const invitationUser = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  assert.equal(invitationUser.issuerId, ownerIdentity.memberId);

  // Un attaquant réattribue l'invitation (déjà signée) à un autre membre de
  // confiance, sans pouvoir re-signer (il n'a pas la clé privée de l'owner).
  const tampered = { ...invitationUser, issuerId: adminIdentity2.memberId };

  const registry = {
    getPublicKey: (id) => {
      if (id === ownerIdentity.memberId) return ownerIdentity.publicKeyJwk;
      if (id === adminIdentity2.memberId) return adminIdentity2.publicKeyJwk;
      return null;
    },
    getMembership: (id) => {
      if (id === ownerIdentity.memberId) return { role: "owner", status: "active" };
      if (id === adminIdentity2.memberId) return { role: "admin", status: "active" };
      return null;
    },
  };

  const result = await verifyInvitation(tampered, { registry });
  assert.equal(result.ok, false);
  assert.match(result.reason, /proof/);

  // L'invitation ORIGINALE (issuerId intact) reste, elle, valide.
  const originalResult = await verifyInvitation(invitationUser, { registry });
  assert.equal(originalResult.ok, true);
});

test("invitations.js#canonicalPayload : rétro-compatible — octets identiques quand issuerId est absent", async () => {
  const { canonicalPayload } = await import("../../src/workspace/invitations.js");
  const fields = {
    workspaceId: "w1", invitationId: "i1", expectedGoogleId: null, role: "user",
    createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-08T00:00:00.000Z", nonce: "n1",
  };
  const withoutIssuerId = canonicalPayload(fields);
  const explicitUndefined = canonicalPayload({ ...fields, issuerId: undefined });
  assert.equal(withoutIssuerId, explicitUndefined);
  assert.equal(withoutIssuerId, JSON.stringify(["w1", "i1", null, "user", fields.createdAt, fields.expiresAt, "n1"]));

  const withIssuerId = canonicalPayload({ ...fields, issuerId: "owner-1" });
  assert.notEqual(withIssuerId, withoutIssuerId);
  assert.equal(withIssuerId, JSON.stringify(["w1", "i1", null, "user", fields.createdAt, fields.expiresAt, "n1", "owner-1"]));
});
