// tests/next/org-runtime.test.mjs
//
// Couvre docs/next/ORG_CONTRACT.md §3 : `src/workspace/org-runtime.js`
// (fonctions pures composant crypto-service/memberships/invitations/workspace)
// + §5 (correctifs sécurité « chaîne de confiance », suite revue red team) :
// manifeste de genèse, invitations avec autorité vérifiée, fiche membre
// adossée à une preuve de détention de clé, et `buildTrustedMembership`
// (construction VÉRIFIÉE du registre/store, qui remplace les anciens
// `buildMemberRegistry`/`buildMembershipStore` naïfs — SUPPRIMÉS)
// + une intégration légère avec `sync/sync-engine.js` en mode `trusted`.

import test from "node:test";
import assert from "node:assert/strict";

import {
  newMemberIdentity,
  createOrganization,
  inviteMember,
  acceptInvitation,
  verifyInvitation,
  buildTrustedMembership,
} from "../../src/workspace/org-runtime.js";
import * as cryptoService from "../../src/crypto/crypto-service.js";
import { canonicalize } from "../../src/events/event-schema.js";
import { EventLog } from "../../src/events/event-log.js";
import * as policy from "../../src/core/permissions.js";
import { InMemoryStorageAdapter } from "../../src/storage/in-memory-adapter.js";
import { SyncEngine } from "../../src/sync/sync-engine.js";
import { createMembership } from "../../src/workspace/memberships.js";
import { createInvitation, revoke } from "../../src/workspace/invitations.js";

/** Construit une organisation fraîche : owner + son signer Ed25519. */
async function makeOrg(name = "Org") {
  const ownerIdentity = await newMemberIdentity();
  const org = createOrganization({ name, identity: ownerIdentity, consultantId: "c-owner" });
  const ownerSigner = (bytes) => cryptoService.sign(ownerIdentity.privateKeyRef, bytes);
  return { ownerIdentity, org, ownerSigner };
}

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
// createOrganization — §5.1 : manifeste de genèse
// ---------------------------------------------------------------------------

test("createOrganization : le créateur a role:owner, la fiche membre porte sa clé publique, son membership, et authorization:{genesis:true}", async () => {
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
  assert.deepEqual(org.memberRecord.authorization, { genesis: true });

  // Manifeste de genèse (§5.1) — racine de confiance immuable.
  assert.equal(org.manifest.workspaceId, org.workspace.workspaceId);
  assert.equal(org.manifest.ownerMemberId, identity.memberId);
  assert.deepEqual(org.manifest.ownerPublicKeyJwk, identity.publicKeyJwk);
  assert.ok(org.manifest.createdAt);
});

test("createOrganization : deux organisations créées par la même identité ont des workspaceId distincts", async () => {
  const identity = await newMemberIdentity();
  const orgA = createOrganization({ name: "Org A", identity, consultantId: "c-alice" });
  const orgB = createOrganization({ name: "Org B", identity, consultantId: "c-alice" });
  assert.notEqual(orgA.workspace.workspaceId, orgB.workspace.workspaceId);
});

// ---------------------------------------------------------------------------
// inviteMember — §5.2 : signer réel exigé, autorité de l'émetteur vérifiée
// ---------------------------------------------------------------------------

test("inviteMember : lève si aucun 'signer' réel n'est fourni (jamais le repli hash non-authentifiant)", async () => {
  const { org, ownerIdentity } = await makeOrg();
  await assert.rejects(
    () =>
      inviteMember({
        workspaceId: org.workspace.workspaceId,
        role: "user",
        issuer: { memberId: ownerIdentity.memberId },
        issuerMembership: org.ownerMembership,
        // signer absent
      }),
    /signer/
  );
});

test("inviteMember : lève si 'issuer'/'issuerMembership' est absent ou incohérent", async () => {
  const { org, ownerSigner } = await makeOrg();
  await assert.rejects(
    () => inviteMember({ workspaceId: org.workspace.workspaceId, role: "user", signer: ownerSigner }),
    /issuer/
  );
  const stranger = await newMemberIdentity();
  await assert.rejects(
    () =>
      inviteMember({
        workspaceId: org.workspace.workspaceId,
        role: "user",
        issuer: { memberId: stranger.memberId }, // ne correspond pas à issuerMembership
        issuerMembership: org.ownerMembership,
        signer: ownerSigner,
      }),
    /issuerMembership/
  );
});

test("inviteMember : lève si l'émetteur n'a pas l'autorité (rôle 'user', ou membership révoqué)", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();

  const userInvitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const userIdentity = await newMemberIdentity();
  const { membership: userMembership } = await acceptInvitation({
    invitation: userInvitation, identity: userIdentity, consultantId: "c-user",
  });
  const userSigner = (bytes) => cryptoService.sign(userIdentity.privateKeyRef, bytes);

  // Un simple 'user' n'a aucune autorité pour inviter.
  await assert.rejects(
    () =>
      inviteMember({
        workspaceId: org.workspace.workspaceId, role: "user",
        issuer: { memberId: userIdentity.memberId }, issuerMembership: userMembership, signer: userSigner,
      }),
    /autorité/
  );

  // Un owner révoqué n'a plus d'autorité non plus.
  const revokedOwnerMembership = { ...org.ownerMembership, status: "revoked" };
  await assert.rejects(
    () =>
      inviteMember({
        workspaceId: org.workspace.workspaceId, role: "user",
        issuer: { memberId: ownerIdentity.memberId }, issuerMembership: revokedOwnerMembership, signer: ownerSigner,
      }),
    /actif|révoqué/
  );
});

test("inviteMember : le rôle 'owner' ne peut être délégué que par un émetteur 'owner' (un admin ne peut pas)", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();

  const adminInvitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const adminIdentity = await newMemberIdentity();
  const { membership: adminMembership } = await acceptInvitation({
    invitation: adminInvitation, identity: adminIdentity, consultantId: "c-admin",
  });
  const adminSigner = (bytes) => cryptoService.sign(adminIdentity.privateKeyRef, bytes);

  await assert.rejects(
    () =>
      inviteMember({
        workspaceId: org.workspace.workspaceId, role: "owner",
        issuer: { memberId: adminIdentity.memberId }, issuerMembership: adminMembership, signer: adminSigner,
      }),
    /owner/
  );

  // Un owner, lui, peut déléguer le rôle owner.
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "owner",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  assert.equal(invitation.role, "owner");
  assert.equal(invitation.issuerId, ownerIdentity.memberId);
});

test("inviteMember : rôle par défaut 'user' quand non précisé, invitation porte issuerId", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId,
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  assert.equal(invitation.role, "user");
  assert.equal(invitation.issuerId, ownerIdentity.memberId);
});

// ---------------------------------------------------------------------------
// verifyInvitation — §5.2
// ---------------------------------------------------------------------------

test("verifyInvitation : accepte une invitation légitime émise par un owner de confiance", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const registry = {
    getPublicKey: (id) => (id === ownerIdentity.memberId ? ownerIdentity.publicKeyJwk : null),
    getMembership: (id) => (id === ownerIdentity.memberId ? { role: "owner", status: "active" } : null),
  };
  const result = await verifyInvitation(invitation, { registry });
  assert.equal(result.ok, true);
});

test("verifyInvitation : rejette un émetteur inconnu du registre de confiance", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const emptyRegistry = { getPublicKey: () => null, getMembership: () => null };
  const result = await verifyInvitation(invitation, { registry: emptyRegistry });
  assert.equal(result.ok, false);
  assert.match(result.reason, /inconnu/);
});

test("verifyInvitation : rejette une invitation dont le proof a été altéré (bidon)", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const tampered = { ...invitation, proof: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
  const registry = {
    getPublicKey: (id) => (id === ownerIdentity.memberId ? ownerIdentity.publicKeyJwk : null),
    getMembership: (id) => (id === ownerIdentity.memberId ? { role: "owner", status: "active" } : null),
  };
  const result = await verifyInvitation(tampered, { registry });
  assert.equal(result.ok, false);
  assert.match(result.reason, /proof/);
});

// ---------------------------------------------------------------------------
// acceptInvitation
// ---------------------------------------------------------------------------

test("inviteMember + acceptInvitation : le nouvel arrivant reçoit le rôle porté par l'invitation, avec joinProof", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();

  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
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
  assert.equal(memberRecord.authorization.invitation.status, "consumed");
  assert.equal(typeof memberRecord.authorization.joinProof, "string");
  assert.ok(memberRecord.authorization.joinProof.length > 0);
});

test("acceptInvitation : invitation expirée => rejet", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId,
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
    ttlMs: 1,
  });
  // Laisse le temps à l'expiration de passer (ttlMs=1ms, largement dépassé par le temps d'exécution du test).
  await new Promise((resolve) => setTimeout(resolve, 10));
  const identity = await newMemberIdentity();
  await assert.rejects(
    () => acceptInvitation({ invitation, identity, consultantId: "c-x" }),
    /invalide|expirée/
  );
});

test("acceptInvitation : invitation révoquée => rejet", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId,
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const revoked = revoke(invitation);
  const identity = await newMemberIdentity();
  await assert.rejects(() => acceptInvitation({ invitation: revoked, identity, consultantId: "c-x" }));
});

test("acceptInvitation : invitation déjà consommée (par le MÊME appelant, en 2 temps) => rejet local", async () => {
  // org-runtime n'a pas de store d'invitations (aucune E/S) : c'est l'objet
  // "consumed" retourné par le premier acceptInvitation (à charge pour
  // l'appelant/2c de le persister) qui matérialise l'état "déjà consommée" —
  // on le repasse ici en second essai pour vérifier le rejet local. La
  // protection AUTORITATIVE contre le rejeu à travers deux fiches DIFFÉRENTES
  // publiées est celle de `buildTrustedMembership` (§5.4, voir plus bas).
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId,
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const identity1 = await newMemberIdentity();
  const { invitation: consumedInvitation } = await acceptInvitation({
    invitation, identity: identity1, consultantId: "c-1",
  });
  assert.equal(consumedInvitation.status, "consumed");

  const identity2 = await newMemberIdentity();
  await assert.rejects(() => acceptInvitation({ invitation: consumedInvitation, identity: identity2, consultantId: "c-2" }));
});

test("acceptInvitation : mauvaise identité Google attendue => rejet", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, expectedGoogleId: "google-sub-alice",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const identity = await newMemberIdentity();
  await assert.rejects(
    () => acceptInvitation({ invitation, identity, consultantId: "c-x", googleId: "google-sub-MALLORY" }),
    /identité Google/
  );
});

test("acceptInvitation : bonne identité Google attendue => accepté", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, expectedGoogleId: "google-sub-alice",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const identity = await newMemberIdentity();
  const { membership } = await acceptInvitation({
    invitation, identity, consultantId: "c-x", googleId: "google-sub-alice",
  });
  assert.equal(membership.googleSubject, "google-sub-alice");
});

// ---------------------------------------------------------------------------
// buildTrustedMembership — §5.4 / §5.6
// ---------------------------------------------------------------------------

test("buildTrustedMembership : scénario légitime complet (owner invite admin, admin invite user) — tout admis, rien rejeté", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();

  const invitationAdmin = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const adminIdentity = await newMemberIdentity();
  const { membership: adminMembership, memberRecord: adminRecord } = await acceptInvitation({
    invitation: invitationAdmin, identity: adminIdentity, consultantId: "c-admin",
  });
  const adminSigner = (bytes) => cryptoService.sign(adminIdentity.privateKeyRef, bytes);

  const invitationUser = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: adminIdentity.memberId }, issuerMembership: adminMembership, signer: adminSigner,
  });
  const userIdentity = await newMemberIdentity();
  const { memberRecord: userRecord } = await acceptInvitation({
    invitation: invitationUser, identity: userIdentity, consultantId: "c-user",
  });

  const memberRecords = [org.memberRecord, adminRecord, userRecord];
  const { registry, membershipStore, trusted, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords,
  });

  assert.equal(rejected.length, 0, JSON.stringify(rejected));
  assert.equal(trusted.length, 3);
  assert.deepEqual(registry.getPublicKey(ownerIdentity.memberId), ownerIdentity.publicKeyJwk);
  assert.deepEqual(registry.getPublicKey(adminIdentity.memberId), adminIdentity.publicKeyJwk);
  assert.deepEqual(registry.getPublicKey(userIdentity.memberId), userIdentity.publicKeyJwk);
  assert.equal(registry.getPublicKey("inconnu"), null);

  assert.equal(membershipStore.get(org.workspace.workspaceId, ownerIdentity.memberId).role, "owner");
  assert.equal(membershipStore.get(org.workspace.workspaceId, adminIdentity.memberId).role, "admin");
  assert.equal(membershipStore.get(org.workspace.workspaceId, userIdentity.memberId).role, "user");
});

test("buildTrustedMembership : admet indépendamment de l'ordre des fiches (point fixe / BFS)", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();

  const invitationAdmin = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const adminIdentity = await newMemberIdentity();
  const { membership: adminMembership, memberRecord: adminRecord } = await acceptInvitation({
    invitation: invitationAdmin, identity: adminIdentity, consultantId: "c-admin",
  });
  const adminSigner = (bytes) => cryptoService.sign(adminIdentity.privateKeyRef, bytes);

  const invitationUser = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: adminIdentity.memberId }, issuerMembership: adminMembership, signer: adminSigner,
  });
  const userIdentity = await newMemberIdentity();
  const { memberRecord: userRecord } = await acceptInvitation({
    invitation: invitationUser, identity: userIdentity, consultantId: "c-user",
  });

  // Ordre volontairement "inversé" : la fiche du user (dont l'émetteur est
  // l'admin) précède la fiche de son émetteur ; la genèse arrive en dernier.
  const memberRecords = [userRecord, adminRecord, org.memberRecord];
  const { trusted, rejected } = await buildTrustedMembership({ manifest: org.manifest, memberRecords });

  assert.equal(rejected.length, 0, JSON.stringify(rejected));
  assert.equal(trusted.length, 3);
});

test("buildTrustedMembership : une fiche admin auto-déclarée (aucune invitation) est REJETÉE, absente du registre/store", async () => {
  const { org, ownerIdentity } = await makeOrg();

  const malloryIdentity = await newMemberIdentity();
  const forgedRecord = {
    kind: "member",
    memberId: malloryIdentity.memberId,
    publicKeyJwk: malloryIdentity.publicKeyJwk,
    membership: createMembership({
      workspaceId: org.workspace.workspaceId, memberId: malloryIdentity.memberId,
      consultantId: "c-mallory", role: "admin",
    }),
    // Pas d'authorization.invitation/joinProof : auto-déclaration.
  };

  const { registry, membershipStore, trusted, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, forgedRecord],
  });

  assert.equal(trusted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].record, forgedRecord);
  assert.equal(registry.getPublicKey(malloryIdentity.memberId), null);
  assert.equal(membershipStore.get(org.workspace.workspaceId, malloryIdentity.memberId), null);

  // Un événement signé par ce faux admin, sur une collection ADMIN_ONLY, est
  // refusé par SyncEngine : il n'est simplement pas dans le registre.
  const adapter = new InMemoryStorageAdapter();
  const bobEngine = new SyncEngine({
    adapter, eventLog: new EventLog(), crypto: cryptoService, policy,
    memberRegistry: registry, membershipStore,
    actor: { workspaceId: org.workspace.workspaceId, memberId: ownerIdentity.memberId, privateKeyRef: ownerIdentity.privateKeyRef },
    trusted: true,
  });
  const forgedEvent = {
    version: 1, eventId: globalThis.crypto.randomUUID(), workspaceId: org.workspace.workspaceId,
    entityType: "consultants", entityId: "cForged", operation: "create",
    actorId: malloryIdentity.memberId, baseVersion: 0, epoch: 1,
    createdAt: new Date().toISOString(), payload: { id: "cForged", nom: "Faux admin" },
  };
  forgedEvent.signature = await cryptoService.sign(malloryIdentity.privateKeyRef, canonicalize(forgedEvent));
  await adapter.putImmutable("event", forgedEvent.eventId, forgedEvent);

  const result = await bobEngine.pull();
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].stage, "signature", "acteur absent du registre => rejeté dès la vérification de signature");
});

test("buildTrustedMembership : une invitation 'owner' forgée par un émetteur non-owner (admin de confiance) est rejetée", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();

  const invitationAdmin = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const adminIdentity = await newMemberIdentity();
  const { memberRecord: adminRecord } = await acceptInvitation({
    invitation: invitationAdmin, identity: adminIdentity, consultantId: "c-admin",
  });
  const adminSigner = (bytes) => cryptoService.sign(adminIdentity.privateKeyRef, bytes);

  // L'admin (réellement de confiance une fois admis) contourne `inviteMember`
  // (qui aurait levé) et forge directement une invitation "owner" via
  // `createInvitation`, en s'auto-attribuant `issuerId`.
  const forgedOwnerInvitation = await createInvitation({
    workspaceId: org.workspace.workspaceId, role: "owner", signer: adminSigner,
  });
  forgedOwnerInvitation.issuerId = adminIdentity.memberId;

  const forgedOwnerIdentity = await newMemberIdentity();
  const { memberRecord: forgedOwnerRecord } = await acceptInvitation({
    invitation: forgedOwnerInvitation, identity: forgedOwnerIdentity, consultantId: "c-forged-owner",
  });

  const memberRecords = [org.memberRecord, adminRecord, forgedOwnerRecord];
  const { trusted, rejected } = await buildTrustedMembership({ manifest: org.manifest, memberRecords });

  assert.equal(trusted.length, 2, "genèse + admin légitime seulement");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].record, forgedOwnerRecord);
  assert.match(rejected[0].reason, /owner/);
});

test("buildTrustedMembership : une invitation au proof bidon (altéré) est rejetée", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();

  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const tamperedInvitation = { ...invitation, proof: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };

  const attackerIdentity = await newMemberIdentity();
  const { memberRecord: attackerRecord } = await acceptInvitation({
    invitation: tamperedInvitation, identity: attackerIdentity, consultantId: "c-attacker",
  });

  const { trusted, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, attackerRecord],
  });

  assert.equal(trusted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].record, attackerRecord);
  assert.match(rejected[0].reason, /invitation invalide/);
});

test("buildTrustedMembership : joinProof substitué (clé remplacée après coup) est rejeté", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();

  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const bobIdentity = await newMemberIdentity();
  const { memberRecord: bobRecord } = await acceptInvitation({
    invitation, identity: bobIdentity, consultantId: "c-bob",
  });

  // Mallory falsifie la fiche : elle y substitue SA PROPRE clé publique, mais
  // ne peut pas re-forger le joinProof (elle n'a pas la clé privée de Bob).
  const malloryIdentity = await newMemberIdentity();
  const substitutedRecord = { ...bobRecord, memberId: malloryIdentity.memberId, publicKeyJwk: malloryIdentity.publicKeyJwk };

  const { trusted, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, substitutedRecord],
  });

  assert.equal(trusted.length, 1, "seule la genèse est admise");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].record, substitutedRecord);
  assert.match(rejected[0].reason, /joinProof/);
});

test("buildTrustedMembership : rejeu d'une même invitation par deux fiches distinctes — une seule admise, la 2e rejetée", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();

  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });

  const bobIdentity = await newMemberIdentity();
  const { memberRecord: bobRecord } = await acceptInvitation({
    invitation, identity: bobIdentity, consultantId: "c-bob",
  });
  const malloryIdentity = await newMemberIdentity();
  const { memberRecord: malloryRecord } = await acceptInvitation({
    invitation, identity: malloryIdentity, consultantId: "c-mallory",
  });

  const { trusted, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, bobRecord, malloryRecord],
  });

  assert.equal(trusted.length, 2, "genèse + première fiche seulement");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].record, malloryRecord);
  assert.match(rejected[0].reason, /rejeu|déjà utilisée/);
});

test("buildTrustedMembership : collision de rôle sur un même memberId — un user ne peut pas être promu admin via une 2e fiche", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const sharedIdentity = await newMemberIdentity();

  const invitationUser = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const { memberRecord: userRecord } = await acceptInvitation({
    invitation: invitationUser, identity: sharedIdentity, consultantId: "c-1",
  });

  const invitationAdmin = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const { memberRecord: adminPromotionRecord } = await acceptInvitation({
    invitation: invitationAdmin, identity: sharedIdentity, consultantId: "c-2",
  });

  const { trusted, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, userRecord, adminPromotionRecord],
  });

  assert.equal(trusted.length, 2, "genèse + première fiche (user) seulement");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].record, adminPromotionRecord);
  assert.match(rejected[0].reason, /déjà admis/);
});

test("buildTrustedMembership : une fiche genèse forgée (mauvaise clé) est rejetée, la vraie genèse (manifeste) prime", async () => {
  const { org } = await makeOrg();
  const attackerIdentity = await newMemberIdentity();
  const forgedGenesis = {
    kind: "member",
    memberId: org.manifest.ownerMemberId, // usurpe le memberId de l'owner
    publicKeyJwk: attackerIdentity.publicKeyJwk, // mais avec SA PROPRE clé
    membership: createMembership({
      workspaceId: org.workspace.workspaceId, memberId: org.manifest.ownerMemberId,
      consultantId: "c-attacker", role: "owner",
    }),
    authorization: { genesis: true },
  };

  const { registry, trusted, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [forgedGenesis],
  });

  assert.equal(trusted.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].record, forgedGenesis);
  // La clé de l'owner reste celle du manifeste, jamais celle de l'attaquant.
  assert.deepEqual(registry.getPublicKey(org.manifest.ownerMemberId), org.manifest.ownerPublicKeyJwk);
});

// ---------------------------------------------------------------------------
// Intégration légère : org-runtime + SyncEngine trusted
// ---------------------------------------------------------------------------

test("intégration : Alice (owner) crée l'org, invite Bob (user), Bob rejoint ; ils convergent en clair signé ; une usurpation est rejetée", async () => {
  const { org, ownerIdentity: aliceIdentity, ownerSigner: signer } = await makeOrg("Cabinet Alice");
  const workspaceId = org.workspace.workspaceId;

  const invitation = await inviteMember({
    workspaceId, role: "user",
    issuer: { memberId: aliceIdentity.memberId }, issuerMembership: org.ownerMembership, signer,
  });

  const bobIdentity = await newMemberIdentity();
  const { memberRecord: bobRecord } = await acceptInvitation({
    invitation, identity: bobIdentity, consultantId: "c-bob",
  });

  const memberRecords = [org.memberRecord, bobRecord];
  const { registry: memberRegistry, membershipStore, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords,
  });
  assert.equal(rejected.length, 0);

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
