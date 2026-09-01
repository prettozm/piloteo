// tests/next/org-engine.test.mjs
//
// Couvre docs/next/ORG_ENGINE_CONTRACT.md §3 : les 6 scénarios du pont
// org-engine, sur UN dossier partagé réel (NodeFsPort sur mkdtemp), en
// réutilisant le même harnais que tests/next/org-folder.test.mjs (genèse +
// invitation + révocation via org-runtime.js/org-folder-store.js), mais en
// passant systématiquement par `openOrgEngine` (org-engine.js, lot 2c-C1)
// plutôt que par `openOrgSync` brut.
//
// Un seul test séquentiel (les scénarios s'enchaînent sur le MÊME dossier,
// chacun bâtissant sur l'état publié par le précédent) — dossier temporaire
// nettoyé en `finally`.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FolderStorageAdapter } from "../../src/storage/folder-storage-adapter.js";
import { NodeFsPort } from "../../src/storage/node-fs-port.js";

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
} from "../../src/workspace/org-folder-store.js";
import * as cryptoService from "../../src/crypto/crypto-service.js";
import { openOrgEngine } from "../../src/workspace/org-engine.js";

function makeAdapter(root) {
  return new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "org-engine-test" });
}

/** Compare deux tableaux d'entités comme des ENSEMBLES (par clé d'identité),
 *  jamais positionnellement — cf. solo-store.js §4 : "ensemblistement
 *  identique", pas forcément le même ordre. */
function byKey(arr, key = "id") {
  const map = new Map();
  for (const item of arr || []) map.set(String(item[key]), item);
  return map;
}
function assertSameSet(actual, expected, key = "id", label = "") {
  const a = byKey(actual, key);
  const e = byKey(expected, key);
  assert.equal(a.size, e.size, `${label}: taille différente (${a.size} vs ${e.size})`);
  for (const [id, val] of e) {
    assert.ok(a.has(id), `${label}: entité ${id} absente`);
    assert.deepEqual(a.get(id), val, `${label}: entité ${id} différente`);
  }
}

test("org-engine : pont snapshot <-> sync multi-membre — 6 scénarios du contrat", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-org-engine-"));
  try {
    const adapter = makeAdapter(root);
    await adapter.connect();

    // -------------------------------------------------------------------
    // Genèse (harnais identique à org-folder.test.mjs) : Alice owner,
    // Bob invité "user".
    // -------------------------------------------------------------------
    const aliceIdentity = await newMemberIdentity();
    const org = createOrganization({ name: "Cabinet Alice", identity: aliceIdentity, consultantId: "c-alice" });
    const aliceSigner = (bytes) => cryptoService.sign(aliceIdentity.privateKeyRef, bytes);

    await writeManifest(adapter, org.manifest);
    await writeMemberRecord(adapter, org.memberRecord);

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

    // -------------------------------------------------------------------
    // 1. Alice openOrgEngine -> commit (1 consultant + 1 saisie) -> load ->
    //    snapshot identique (aller-retour).
    // -------------------------------------------------------------------
    const aliceOrgEngine = await openOrgEngine({ adapter, identity: aliceIdentity, consultantId: "c-alice" });
    assert.equal(aliceOrgEngine.manifest.workspaceId, org.workspace.workspaceId);
    assert.equal(aliceOrgEngine.membership.role, "owner");

    const load0 = await aliceOrgEngine.load();
    assert.equal(load0.conflicts.length, 0);
    assert.deepEqual(load0.state.consultants, []);

    const consultantAlice = { id: "c-alice", nom: "Alice Dupont" };
    const saisieAlice = {
      id: "sAlice1",
      date: "2026-08-05",
      consultantId: "c-alice",
      type: "interne",
      missionId: null,
      dureeH: 2,
      pctFact: 0,
    };
    const next1 = {
      ...load0.state,
      consultants: [...load0.state.consultants, consultantAlice],
      saisies: [...load0.state.saisies, saisieAlice],
    };
    const commit1 = await aliceOrgEngine.commit(next1);
    assert.equal(commit1.ok, true, JSON.stringify(commit1.conflicts));
    assert.equal(commit1.conflicts.length, 0);
    assert.equal(commit1.applied.rejected.length, 0);
    assert.equal(commit1.applied.count, 2, "2 events créés (1 consultant + 1 saisie)");

    const load1 = await aliceOrgEngine.load();
    assertSameSet(load1.state.consultants, next1.consultants, "id", "consultants (aller-retour Alice)");
    assertSameSet(load1.state.saisies, next1.saisies, "id", "saisies (aller-retour Alice)");
    assert.ok(load1.revision >= 2, "revision monotone après 2 events");

    // -------------------------------------------------------------------
    // 2. Bob openOrgEngine -> load voit les données d'Alice (convergence).
    // -------------------------------------------------------------------
    const bobOrgEngine = await openOrgEngine({ adapter, identity: bobIdentity, consultantId: "c-bob" });
    const bobLoad2 = await bobOrgEngine.load();
    assertSameSet(bobLoad2.state.consultants, next1.consultants, "id", "consultants (Bob voit Alice)");
    assertSameSet(bobLoad2.state.saisies, next1.saisies, "id", "saisies (Bob voit Alice)");

    const members2 = await aliceOrgEngine.members();
    assertSameSet(
      members2,
      [
        { memberId: aliceIdentity.memberId, consultantId: "c-alice", role: "owner", status: "active" },
        { memberId: bobIdentity.memberId, consultantId: "c-bob", role: "user", status: "active" },
      ],
      "memberId",
      "members() après invitation"
    );

    // -------------------------------------------------------------------
    // 3. Bob commit une saisie qui lui appartient -> Alice load la voit.
    // -------------------------------------------------------------------
    const saisieBob = {
      id: "sBob1",
      date: "2026-08-06",
      consultantId: "c-bob",
      type: "interne",
      missionId: null,
      dureeH: 1,
      pctFact: 0,
    };
    const next3 = { ...bobLoad2.state, saisies: [...bobLoad2.state.saisies, saisieBob] };
    const commit3 = await bobOrgEngine.commit(next3);
    assert.equal(commit3.ok, true, JSON.stringify(commit3.conflicts));
    assert.equal(commit3.conflicts.length, 0);
    assert.equal(commit3.applied.count, 1);

    const aliceLoad3 = await aliceOrgEngine.load();
    assert.ok(aliceLoad3.state.saisies.some((s) => s.id === "sBob1"), "Alice voit la saisie de Bob après convergence");

    // -------------------------------------------------------------------
    // 4. Rôle : Bob (user) commit une modif d'un `consultant` (ADMIN_ONLY) ->
    //    commit signale l'échec (conflicts non vide, ok:false), et Alice ne
    //    voit JAMAIS cette modif.
    // -------------------------------------------------------------------
    const bobLoad4 = await bobOrgEngine.load();
    const forgedConsultant = { id: "cForgedByBob", nom: "Créé par un simple user" };
    const next4 = { ...bobLoad4.state, consultants: [...bobLoad4.state.consultants, forgedConsultant] };
    const commit4 = await bobOrgEngine.commit(next4);
    assert.equal(commit4.ok, false, "commit doit signaler l'échec, jamais un faux succès");
    assert.equal(commit4.conflicts.length, 1, JSON.stringify(commit4.conflicts));
    assert.equal(commit4.conflicts[0].entityType, "consultants");
    assert.equal(commit4.conflicts[0].entityId, "cForgedByBob");
    assert.equal(commit4.conflicts[0].stage, "policy");

    const aliceLoad4 = await aliceOrgEngine.load();
    assert.equal(
      aliceLoad4.state.consultants.some((c) => c.id === "cForgedByBob"),
      false,
      "Alice ne voit jamais le consultant forgé par Bob"
    );

    // -------------------------------------------------------------------
    // 5. Révocation : Alice révoque Bob (via org-runtime/org-folder-store).
    //    - Un NOUVEL openOrgEngine pour Bob (identité révoquée) échoue.
    //    - Le org-engine de Bob OUVERT AVANT sa révocation publie malgré
    //      tout un nouvel événement (client hostile ou pas encore informé) ;
    //      côté Alice (rechargée après la révocation), il n'a AUCUN effet
    //      (rejeté à l'étape membership, jamais appliqué).
    // -------------------------------------------------------------------
    const revocation = await createRevocation({
      workspaceId: org.workspace.workspaceId,
      revokedMemberId: bobIdentity.memberId,
      issuer: { memberId: aliceIdentity.memberId },
      issuerMembership: org.ownerMembership,
      revokedRole: "user",
      signer: aliceSigner,
    });
    await writeRevocation(adapter, revocation);

    await assert.rejects(
      () => openOrgEngine({ adapter, identity: bobIdentity, consultantId: "c-bob" }),
      /révoqué/,
      "un nouvel openOrgEngine pour Bob révoqué doit échouer"
    );

    const bobLoad5 = await bobOrgEngine.load();
    const saisieBobPostRevocation = {
      id: "sBobPostRevocation",
      date: "2026-08-07",
      consultantId: "c-bob",
      type: "interne",
      missionId: null,
      dureeH: 1,
      pctFact: 0,
    };
    const next5 = { ...bobLoad5.state, saisies: [...bobLoad5.state.saisies, saisieBobPostRevocation] };
    // Le org-engine de Bob a été ouvert AVANT la révocation : son
    // `membershipStore` interne reste figé sur "Bob actif" (cf. org-engine.js
    // décision 3/5) — il ne peut donc pas détecter LUI-MÊME sa propre
    // révocation. C'est côté Alice (rechargée) que l'événement est rejeté.
    await bobOrgEngine.commit(next5);

    const aliceOrgEngine2 = await openOrgEngine({ adapter, identity: aliceIdentity, consultantId: "c-alice" });
    const aliceLoad5 = await aliceOrgEngine2.load();
    assert.equal(
      aliceLoad5.state.saisies.some((s) => s.id === "sBobPostRevocation"),
      false,
      "Alice (rechargée après révocation) ne voit jamais l'événement post-révocation de Bob"
    );
    const members5 = await aliceOrgEngine2.members();
    const bobMembership5 = members5.find((m) => m.memberId === bobIdentity.memberId);
    assert.equal(bobMembership5.status, "revoked", "members() reflète la révocation de Bob");

    // -------------------------------------------------------------------
    // 6. Idempotence : commit d'un état identique -> 0 event créé.
    // -------------------------------------------------------------------
    const load6 = await aliceOrgEngine2.load();
    const commit6 = await aliceOrgEngine2.commit(load6.state);
    assert.equal(commit6.ok, true, JSON.stringify(commit6.conflicts));
    assert.equal(commit6.applied.count, 0, "aucun event créé pour un état identique");
    assert.equal(commit6.conflicts.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
