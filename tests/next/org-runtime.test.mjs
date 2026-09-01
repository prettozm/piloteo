// tests/next/org-runtime.test.mjs
//
// Couvre docs/next/ORG_CONTRACT.md §3 : `src/workspace/org-runtime.js`
// (fonctions pures composant crypto-service/memberships/invitations/workspace)
// + une intégration légère avec `sync/sync-engine.js` en mode `trusted`
// (docs/next/ORG_CONTRACT.md §3 dernier point).

import test from "node:test";
import assert from "node:assert/strict";

import {
  newMemberIdentity,
  createOrganization,
  inviteMember,
  acceptInvitation,
  buildMemberRegistry,
  buildMembershipStore,
} from "../../src/workspace/org-runtime.js";
import * as cryptoService from "../../src/crypto/crypto-service.js";
import { canonicalize } from "../../src/events/event-schema.js";
import { EventLog } from "../../src/events/event-log.js";
import * as policy from "../../src/core/permissions.js";
import { InMemoryStorageAdapter } from "../../src/storage/in-memory-adapter.js";
import { SyncEngine } from "../../src/sync/sync-engine.js";

// ---------------------------------------------------------------------------
// newMemberIdentity
// ---------------------------------------------------------------------------

test("newMemberIdentity : produit un memberId UUID + une paire Ed25519 (publicKeyJwk/privateKeyRef)", async () => {
  const identity = await newMemberIdentity();
  assert.match(identity.memberId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(identity.publicKeyJwk.kty, "OKP");
  assert.equal(identity.publicKeyJwk.crv, "Ed25519");
  assert.equal(identity.privateKeyRef.keyType, "ed25519");

  // Deux identités distinctes ne partagent jamais de memberId ni de clé.
  const other = await newMemberIdentity();
  assert.notEqual(identity.memberId, other.memberId);
  assert.notEqual(identity.publicKeyJwk.x, other.publicKeyJwk.x);
});

// ---------------------------------------------------------------------------
// createOrganization
// ---------------------------------------------------------------------------

test("createOrganization : le créateur a role:owner, la fiche membre porte sa clé publique et son membership", async () => {
  const identity = await newMemberIdentity();
  const org = createOrganization({ name: "Le Clat d'Théia", identity, consultantId: "c-alice" });

  assert.ok(org.workspace.workspaceId);
  assert.match(org.workspace.workspaceId, /^[0-9a-f-]{36}$/i);
  assert.equal(org.workspace.name, "Le Clat d'Théia");
  assert.equal(typeof org.workspace.schemaVersion, "number");

  assert.equal(org.ownerMembership.role, "owner");
  assert.equal(org.ownerMembership.status, "active");
  assert.equal(org.ownerMembership.workspaceId, org.workspace.workspaceId);
  assert.equal(org.ownerMembership.memberId, identity.memberId);
  assert.equal(org.ownerMembership.consultantId, "c-alice");

  assert.equal(org.memberRecord.kind, "member");
  assert.equal(org.memberRecord.memberId, identity.memberId);
  assert.deepEqual(org.memberRecord.publicKeyJwk, identity.publicKeyJwk);
  assert.deepEqual(org.memberRecord.membership, org.ownerMembership);
});

test("createOrganization : deux organisations créées par la même identité ont des workspaceId distincts", async () => {
  const identity = await newMemberIdentity();
  const orgA = createOrganization({ name: "Org A", identity, consultantId: "c-alice" });
  const orgB = createOrganization({ name: "Org B", identity, consultantId: "c-alice" });
  assert.notEqual(orgA.workspace.workspaceId, orgB.workspace.workspaceId);
});

// ---------------------------------------------------------------------------
// inviteMember + acceptInvitation
// ---------------------------------------------------------------------------

test("inviteMember + acceptInvitation : le nouvel arrivant reçoit le rôle porté par l'invitation", async () => {
  const aliceIdentity = await newMemberIdentity();
  const org = createOrganization({ name: "Org", identity: aliceIdentity, consultantId: "c-alice" });

  const signer = (bytes) => cryptoService.sign(aliceIdentity.privateKeyRef, bytes);
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin", signer,
  });
  assert.equal(invitation.role, "admin");
  assert.equal(invitation.status, "pending");
  assert.equal(invitation.workspaceId, org.workspace.workspaceId);

  const bobIdentity = await newMemberIdentity();
  const { membership, memberRecord } = await acceptInvitation({
    invitation, identity: bobIdentity, consultantId: "c-bob",
  });

  assert.equal(membership.role, "admin");
  assert.equal(membership.workspaceId, org.workspace.workspaceId);
  assert.equal(membership.memberId, bobIdentity.memberId);
  assert.equal(membership.consultantId, "c-bob");
  assert.equal(membership.status, "active");

  assert.equal(memberRecord.kind, "member");
  assert.equal(memberRecord.memberId, bobIdentity.memberId);
  assert.deepEqual(memberRecord.publicKeyJwk, bobIdentity.publicKeyJwk);
});

test("inviteMember : rôle par défaut 'user' quand non précisé", async () => {
  const workspaceId = globalThis.crypto.randomUUID();
  const invitation = await inviteMember({ workspaceId });
  assert.equal(invitation.role, "user");
});

test("acceptInvitation : invitation expirée => rejet", async () => {
  const workspaceId = globalThis.crypto.randomUUID();
  const invitation = await inviteMember({ workspaceId, ttlMs: 1 });
  // Laisse le temps à l'expiration de passer (ttlMs=1ms, largement dépassé par le temps d'exécution du test).
  await new Promise((resolve) => setTimeout(resolve, 10));
  const identity = await newMemberIdentity();
  await assert.rejects(
    () => acceptInvitation({ invitation, identity, consultantId: "c-x" }),
    /invalide|expirée/
  );
});

test("acceptInvitation : invitation révoquée => rejet", async () => {
  const { revoke } = await import("../../src/workspace/invitations.js");
  const workspaceId = globalThis.crypto.randomUUID();
  const invitation = await inviteMember({ workspaceId });
  const revoked = revoke(invitation);
  const identity = await newMemberIdentity();
  await assert.rejects(() => acceptInvitation({ invitation: revoked, identity, consultantId: "c-x" }));
});

test("acceptInvitation : invitation déjà consommée => rejet (pas de double enrôlement)", async () => {
  // org-runtime n'a pas de store d'invitations (aucune E/S) : c'est l'objet
  // "consumed" retourné par le premier acceptInvitation (à charge pour
  // l'appelant/2c de le persister) qui matérialise l'état "déjà consommée" —
  // on le repasse ici en second essai pour vérifier le rejet.
  const workspaceId = globalThis.crypto.randomUUID();
  const invitation = await inviteMember({ workspaceId });
  const identity1 = await newMemberIdentity();
  const { invitation: consumedInvitation } = await acceptInvitation({
    invitation, identity: identity1, consultantId: "c-1",
  });
  assert.equal(consumedInvitation.status, "consumed");

  const identity2 = await newMemberIdentity();
  await assert.rejects(() => acceptInvitation({ invitation: consumedInvitation, identity: identity2, consultantId: "c-2" }));
});

test("acceptInvitation : mauvaise identité Google attendue => rejet", async () => {
  const workspaceId = globalThis.crypto.randomUUID();
  const invitation = await inviteMember({ workspaceId, expectedGoogleId: "google-sub-alice" });
  const identity = await newMemberIdentity();
  await assert.rejects(
    () => acceptInvitation({ invitation, identity, consultantId: "c-x", googleId: "google-sub-MALLORY" }),
    /identité Google/
  );
});

test("acceptInvitation : bonne identité Google attendue => accepté", async () => {
  const workspaceId = globalThis.crypto.randomUUID();
  const invitation = await inviteMember({ workspaceId, expectedGoogleId: "google-sub-alice" });
  const identity = await newMemberIdentity();
  const { membership } = await acceptInvitation({
    invitation, identity, consultantId: "c-x", googleId: "google-sub-alice",
  });
  assert.equal(membership.googleSubject, "google-sub-alice");
});

// ---------------------------------------------------------------------------
// buildMemberRegistry / buildMembershipStore
// ---------------------------------------------------------------------------

test("buildMemberRegistry/buildMembershipStore : à partir de 3 fiches, getPublicKey et MembershipStore.get renvoient les bonnes valeurs", async () => {
  const ownerIdentity = await newMemberIdentity();
  const org = createOrganization({ name: "Org", identity: ownerIdentity, consultantId: "c-owner" });

  const signer = (bytes) => cryptoService.sign(ownerIdentity.privateKeyRef, bytes);
  const invitationAdmin = await inviteMember({ workspaceId: org.workspace.workspaceId, role: "admin", signer });
  const adminIdentity = await newMemberIdentity();
  const { memberRecord: adminRecord } = await acceptInvitation({
    invitation: invitationAdmin, identity: adminIdentity, consultantId: "c-admin",
  });

  const invitationUser = await inviteMember({ workspaceId: org.workspace.workspaceId, role: "user", signer });
  const userIdentity = await newMemberIdentity();
  const { membership: userMembership, memberRecord: userRecord } = await acceptInvitation({
    invitation: invitationUser, identity: userIdentity, consultantId: "c-user",
  });

  const memberRecords = [org.memberRecord, adminRecord, userRecord];
  const registry = buildMemberRegistry(memberRecords);
  const store = buildMembershipStore(memberRecords);

  assert.deepEqual(registry.getPublicKey(ownerIdentity.memberId), ownerIdentity.publicKeyJwk);
  assert.deepEqual(registry.getPublicKey(adminIdentity.memberId), adminIdentity.publicKeyJwk);
  assert.deepEqual(registry.getPublicKey(userIdentity.memberId), userIdentity.publicKeyJwk);
  assert.equal(registry.getPublicKey("inconnu"), null);

  assert.equal(store.get(org.workspace.workspaceId, ownerIdentity.memberId).role, "owner");
  assert.equal(store.get(org.workspace.workspaceId, adminIdentity.memberId).role, "admin");
  assert.equal(store.get(org.workspace.workspaceId, userIdentity.memberId).role, "user");

  // Un membre révoqué (transformation en aval, hors de ce module) est vu révoqué.
  store.revoke(org.workspace.workspaceId, userIdentity.memberId);
  assert.equal(store.get(org.workspace.workspaceId, userIdentity.memberId).status, "revoked");
  assert.deepEqual(userMembership.status, "active", "l'objet original passé n'est jamais muté (revoke renvoie une copie)");
});

test("buildMemberRegistry/buildMembershipStore : ignorent silencieusement les entrées qui ne sont pas des fiches membres", () => {
  const registry = buildMemberRegistry([null, { kind: "key" }, undefined]);
  const store = buildMembershipStore([null, { kind: "license" }]);
  assert.equal(registry.getPublicKey("x"), null);
  assert.equal(store.get("ws", "x"), null);
});

// ---------------------------------------------------------------------------
// Intégration légère : org-runtime + SyncEngine trusted
// ---------------------------------------------------------------------------

test("intégration : Alice (owner) crée l'org, invite Bob (user), Bob rejoint ; ils convergent en clair signé ; une usurpation est rejetée", async () => {
  const aliceIdentity = await newMemberIdentity();
  const org = createOrganization({ name: "Cabinet Alice", identity: aliceIdentity, consultantId: "c-alice" });
  const workspaceId = org.workspace.workspaceId;

  const signer = (bytes) => cryptoService.sign(aliceIdentity.privateKeyRef, bytes);
  const invitation = await inviteMember({ workspaceId, role: "user", signer });

  const bobIdentity = await newMemberIdentity();
  const { memberRecord: bobRecord } = await acceptInvitation({
    invitation, identity: bobIdentity, consultantId: "c-bob",
  });

  const memberRecords = [org.memberRecord, bobRecord];
  const memberRegistry = buildMemberRegistry(memberRecords);
  const membershipStore = buildMembershipStore(memberRecords);

  const adapter = new InMemoryStorageAdapter();

  const aliceEngine = new SyncEngine({
    adapter, eventLog: new EventLog(), crypto: cryptoService, policy,
    memberRegistry, membershipStore,
    actor: { workspaceId, memberId: aliceIdentity.memberId, privateKeyRef: aliceIdentity.privateKeyRef },
    trusted: true,
  });
  const bobEngine = new SyncEngine({
    adapter, eventLog: new EventLog(), crypto: cryptoService, policy,
    memberRegistry, membershipStore,
    actor: { workspaceId, memberId: bobIdentity.memberId, privateKeyRef: bobIdentity.privateKeyRef },
    trusted: true,
  });

  // Alice (owner => droits admin métier) crée un consultant (ADMIN_ONLY).
  aliceEngine.createLocalEvent({
    entityType: "consultants", entityId: "cBob", operation: "create",
    payload: { id: "cBob", nom: "Bob" },
  });
  // Bob (user) saisit sur lui-même.
  bobEngine.createLocalEvent({
    entityType: "saisies", entityId: "sBob1", operation: "create",
    payload: {
      id: "sBob1", date: "2026-02-01", consultantId: "c-bob", type: "interne",
      missionId: null, dureeH: 2, pctFact: 0,
    },
  });

  await aliceEngine.push();
  await bobEngine.push();
  await aliceEngine.pull();
  await bobEngine.pull();

  assert.equal(aliceEngine.getRejections().length, 0);
  assert.equal(bobEngine.getRejections().length, 0);
  assert.ok(aliceEngine.getProjection().saisies.sBob1, "Alice voit la saisie de Bob après sync");
  assert.ok(bobEngine.getProjection().consultants.cBob, "Bob voit le consultant créé par Alice après sync");

  // Vérifie que le blob transporté est bien en clair (payload) et signé (pas de ciphertext).
  const bobEvent = bobEngine.eventLog.list().find((e) => e.entityId === "sBob1");
  const publishedBlob = await adapter.get("event", bobEvent.eventId);
  assert.ok(publishedBlob.payload, "payload en clair dans le blob publié");
  assert.ok(!("ciphertext" in publishedBlob));
  assert.ok(typeof publishedBlob.signature === "string" && publishedBlob.signature.length > 0);

  // Usurpation : Bob signe un événement au nom d'Alice (actorId falsifié).
  const forged = {
    version: 1,
    eventId: globalThis.crypto.randomUUID(),
    workspaceId,
    entityType: "consultants",
    entityId: "cForged",
    operation: "create",
    actorId: aliceIdentity.memberId, // usurpe Alice
    baseVersion: 0,
    epoch: 1,
    createdAt: new Date().toISOString(),
    payload: { id: "cForged", nom: "Usurpation" },
  };
  // Bob signe avec SA propre clé (il n'a pas la clé privée d'Alice) : la
  // vérification via la clé publique d'Alice doit échouer.
  forged.signature = await cryptoService.sign(bobIdentity.privateKeyRef, canonicalize(forged));
  await adapter.putImmutable("event", forged.eventId, forged);

  const forgedResult = await aliceEngine.pull();
  const forgedRejection = forgedResult.rejections.find((r) => r.eventId === forged.eventId);
  assert.ok(forgedRejection, "l'usurpation est rejetée");
  assert.equal(forgedRejection.stage, "signature");
  assert.equal(aliceEngine.getProjection().consultants.cForged, undefined, "jamais appliqué");
});
