// tests/next/org-folder.test.mjs
//
// Couvre docs/next/ORG_FOLDER_CONTRACT.md §4 : scénario multi-membre bout-en-
// bout sur UN dossier partagé réel (NodeFsPort sur mkdtemp), câblant
// org-runtime.js (chaîne de confiance) + org-folder-store.js (persistance
// gouvernance) + org-sync.js (SyncEngine trusted) + FolderStorageAdapter.
//
// Deux membres (Alice owner, Bob user) sur le MÊME dossier, chacun son propre
// `SyncEngine` (donc son propre `EventLog` local) obtenu via `openOrgSync`.
// Un seul test séquentiel (les 7 scénarios du contrat s'enchaînent sur le
// MÊME dossier, chacun bâtissant sur l'état publié par le précédent) — dossier
// temporaire nettoyé en `finally`.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FolderStorageAdapter } from "../../src/storage/folder-storage-adapter.js";
import { NodeFsPort } from "../../src/storage/node-fs-port.js";
import { buildEvent, canonicalize } from "../../src/events/event-schema.js";
import * as cryptoService from "../../src/crypto/crypto-service.js";

import {
  newMemberIdentity,
  createOrganization,
  inviteMember,
  acceptInvitation,
  createRevocation,
} from "../../src/workspace/org-runtime.js";
import {
  writeManifest,
  writeMemberRecord,
  writeRevocation,
  loadTrust,
} from "../../src/workspace/org-folder-store.js";
import { openOrgSync } from "../../src/workspace/org-sync.js";

function makeAdapter(root) {
  return new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "org-folder-test" });
}

test("org-folder : distribution multi-membre sur dossier + sync trusted — 7 scénarios du contrat", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-org-folder-"));
  try {
    const adapter = makeAdapter(root);
    await adapter.connect();

    // -------------------------------------------------------------------
    // 1. Genèse : Alice createOrganization -> writeManifest + writeMemberRecord(owner).
    //    Un 2e writeManifest (attaquant) -> throw (write-once, premier gagne).
    // -------------------------------------------------------------------
    const aliceIdentity = await newMemberIdentity();
    const org = createOrganization({ name: "Cabinet Alice", identity: aliceIdentity, consultantId: "c-alice" });
    const aliceSigner = (bytes) => cryptoService.sign(aliceIdentity.privateKeyRef, bytes);

    await writeManifest(adapter, org.manifest);
    await writeMemberRecord(adapter, org.memberRecord);

    const attackerIdentity = await newMemberIdentity();
    const forgedManifest = {
      workspaceId: globalThis.crypto.randomUUID(),
      ownerMemberId: attackerIdentity.memberId,
      ownerPublicKeyJwk: attackerIdentity.publicKeyJwk,
      createdAt: new Date().toISOString(),
    };
    await assert.rejects(() => writeManifest(adapter, forgedManifest), /manifeste existe déjà/);

    // -------------------------------------------------------------------
    // 2. Alice inviteMember(Bob, "user") (signée) ; Bob acceptInvitation ->
    //    writeMemberRecord(bob). loadTrust -> Alice owner, Bob user, 0 rejected.
    // -------------------------------------------------------------------
    const invitation = await inviteMember({
      workspaceId: org.workspace.workspaceId,
      role: "user",
      issuer: { memberId: aliceIdentity.memberId },
      issuerMembership: org.ownerMembership,
      signer: aliceSigner,
    });
    const bobIdentity = await newMemberIdentity();
    const { memberRecord: bobRecord } = await acceptInvitation({
      invitation,
      identity: bobIdentity,
      consultantId: "c-bob",
    });
    await writeMemberRecord(adapter, bobRecord);

    const trust1 = await loadTrust(adapter);
    assert.equal(trust1.rejected.length, 0, JSON.stringify(trust1.rejected));
    assert.equal(trust1.membershipStore.get(org.workspace.workspaceId, aliceIdentity.memberId).role, "owner");
    assert.equal(trust1.membershipStore.get(org.workspace.workspaceId, bobIdentity.memberId).role, "user");

    // -------------------------------------------------------------------
    // 3. openOrgSync pour Alice et Bob (chacun son EventLog, même dossier).
    //    Alice crée un event `saisies` -> push. Bob pull -> converge.
    // -------------------------------------------------------------------
    const { engine: aliceEngine } = await openOrgSync({ adapter, identity: aliceIdentity, consultantId: "c-alice" });
    let { engine: bobEngine } = await openOrgSync({ adapter, identity: bobIdentity, consultantId: "c-bob" });

    aliceEngine.createLocalEvent({
      entityType: "saisies",
      entityId: "sAlice1",
      operation: "create",
      payload: { id: "sAlice1", date: "2026-08-05", consultantId: "c-alice", type: "interne", missionId: null, dureeH: 2, pctFact: 0 },
    });
    await aliceEngine.push();
    const pullBob1 = await bobEngine.pull();
    assert.equal(pullBob1.rejections.length, 0, JSON.stringify(pullBob1.rejections));
    assert.ok(bobEngine.getProjection().saisies.sAlice1, "Bob voit la saisie d'Alice après convergence");

    // -------------------------------------------------------------------
    // 4. Rôle appliqué : Bob (user) tente un event sur `consultants` (ADMIN_ONLY)
    //    -> push par Bob, pull par Alice -> rejeté (stage:"policy"), jamais appliqué.
    // -------------------------------------------------------------------
    bobEngine.createLocalEvent({
      entityType: "consultants",
      entityId: "cForgedByBob",
      operation: "create",
      payload: { id: "cForgedByBob", nom: "Créé par un simple user" },
    });
    await bobEngine.push();
    const pullAlice4 = await aliceEngine.pull();
    const policyRejection = pullAlice4.rejections.find((r) => r.eventId && true);
    assert.equal(pullAlice4.rejections.length, 1, JSON.stringify(pullAlice4.rejections));
    assert.equal(pullAlice4.rejections[0].stage, "policy");
    assert.equal(aliceEngine.getProjection().consultants?.cForgedByBob, undefined, "jamais appliqué");

    // -------------------------------------------------------------------
    // 5. Signature vérifiée : un event forgé signé par une identité hors
    //    registre -> rejeté (stage:"signature").
    // -------------------------------------------------------------------
    const strangerIdentity = await newMemberIdentity();
    const forgedEvent = buildEvent({
      workspaceId: org.workspace.workspaceId,
      entityType: "saisies",
      entityId: "sStranger",
      operation: "create",
      actorId: strangerIdentity.memberId, // jamais admis dans la chaîne de confiance
      baseVersion: 0,
      epoch: 1,
      payload: { id: "sStranger", date: "2026-08-06", consultantId: "c-stranger", type: "interne", missionId: null, dureeH: 1, pctFact: 0 },
    });
    const forgedBlob = { ...forgedEvent };
    forgedBlob.signature = await cryptoService.sign(strangerIdentity.privateKeyRef, canonicalize(forgedBlob));
    await adapter.putImmutable("event", forgedEvent.eventId, forgedBlob);

    const pullAlice5 = await aliceEngine.pull();
    const strangerRejection = pullAlice5.rejections.find((r) => r.eventId === forgedEvent.eventId);
    assert.ok(strangerRejection, "l'event de l'inconnu est rejeté");
    assert.equal(strangerRejection.stage, "signature");
    assert.equal(aliceEngine.getProjection().saisies?.sStranger, undefined, "jamais appliqué");

    // -------------------------------------------------------------------
    // 6. Révocation : Alice createRevocation(Bob) -> writeRevocation.
    //    loadTrust -> Bob status:"revoked". openOrgSync(Bob) -> throw.
    //    Le SyncEngine d'Alice (rechargé après révocation) rejette désormais
    //    les nouveaux events de Bob (stage:"membership").
    // -------------------------------------------------------------------
    const revocation = await createRevocation({
      workspaceId: org.workspace.workspaceId,
      revokedMemberId: bobIdentity.memberId,
      issuer: { memberId: aliceIdentity.memberId },
      issuerMembership: org.ownerMembership,
      revokedRole: "user",
      signer: aliceSigner,
    });
    assert.ok(revocation.revocationId, "createRevocation pose un revocationId (adressage fichier, hors proof)");
    await writeRevocation(adapter, revocation);

    const trust6 = await loadTrust(adapter);
    assert.equal(trust6.membershipStore.get(org.workspace.workspaceId, bobIdentity.memberId).status, "revoked");
    assert.equal(trust6.revoked.length, 1);
    assert.equal(trust6.revoked[0].memberId, bobIdentity.memberId);

    // Bob (déjà révoqué) ne peut plus ouvrir de session sync sur ce dossier.
    await assert.rejects(() => openOrgSync({ adapter, identity: bobIdentity, consultantId: "c-bob" }), /révoqué/);

    // Bob, via son EngineSync OUVERT AVANT sa révocation (toujours capable de
    // signer/publier — client hostile ou simplement pas encore informé),
    // publie malgré tout un nouvel événement.
    bobEngine.createLocalEvent({
      entityType: "saisies",
      entityId: "sBobPostRevocation",
      operation: "create",
      payload: { id: "sBobPostRevocation", date: "2026-08-07", consultantId: "c-bob", type: "interne", missionId: null, dureeH: 1, pctFact: 0 },
    });
    await bobEngine.push();

    // Alice recharge sa session sync (nouvelle chaîne de confiance, avec Bob
    // révoqué) et pull : l'événement de Bob est rejeté à l'étape membership.
    const { engine: aliceEngineReloaded } = await openOrgSync({ adapter, identity: aliceIdentity, consultantId: "c-alice" });
    const pullAlice6 = await aliceEngineReloaded.pull();
    const membershipRejection = pullAlice6.rejections.find((r) => r.eventId && r.stage === "membership");
    assert.ok(membershipRejection, JSON.stringify(pullAlice6.rejections));
    assert.equal(aliceEngineReloaded.getProjection().saisies?.sBobPostRevocation, undefined, "jamais appliqué");

    // -------------------------------------------------------------------
    // 7. Non-membre : openOrgSync avec une identité inconnue -> throw.
    // -------------------------------------------------------------------
    const unknownIdentity = await newMemberIdentity();
    await assert.rejects(() => openOrgSync({ adapter, identity: unknownIdentity, consultantId: "c-inconnu" }), /non membre/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
