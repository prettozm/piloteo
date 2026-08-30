// tests/next/sync.test.mjs
//
// Couvre docs/next/07_TESTS_ET_RECETTE.md §7 (concurrence), §8 (crypto, partiel)
// et §13 (résilience Drive, partiel — via InMemoryStorageAdapter) pour
// `sync/sync-engine.js`, ainsi que les helpers purs de `storage/*`.
//
// Harnais : deux "clients" (deux `SyncEngine`, chacun avec son PROPRE
// `EventLog`) partagent UN `InMemoryStorageAdapter` et la MÊME clé de
// workspace (même epoch 1) — simule deux appareils d'un même workspace Team.
// `FakeMemberRegistry` et `MembershipStore` (module committé) sont les deux
// interfaces injectées documentées en tête de `sync-engine.js`.

import test from "node:test";
import assert from "node:assert/strict";

import { EventLog } from "../../src/events/event-log.js";
import { buildEvent, canonicalize } from "../../src/events/event-schema.js";
import * as cryptoService from "../../src/crypto/crypto-service.js";
import { Keyring } from "../../src/crypto/keyring.js";
import * as policy from "../../src/core/permissions.js";
import { MembershipStore } from "../../src/workspace/memberships.js";
import { InMemoryStorageAdapter } from "../../src/storage/in-memory-adapter.js";
import { SyncEngine } from "../../src/sync/sync-engine.js";
import {
  buildDrivePath,
  folderForKind,
  driveQueryParams,
  DRIVE_SCOPE,
  GoogleDriveStorageAdapter,
  NotWiredError,
} from "../../src/storage/google-drive-adapter.js";

// ---------------------------------------------------------------------------
// Harnais de test
// ---------------------------------------------------------------------------

/** Registre de clés publiques de membres — fake minimal (interface documentée dans sync-engine.js). */
class FakeMemberRegistry {
  constructor() {
    this._byId = new Map();
  }
  register(memberId, publicKeyJwk) {
    this._byId.set(memberId, publicKeyJwk);
  }
  getPublicKey(memberId) {
    return this._byId.get(memberId) ?? null;
  }
}

async function makeMember({ workspaceId, membershipStore, memberRegistry, consultantId, role = "user" }) {
  const memberId = globalThis.crypto.randomUUID();
  const identity = await cryptoService.generateMemberIdentity();
  memberRegistry.register(memberId, identity.publicKeyJwk);
  membershipStore.add({ workspaceId, memberId, consultantId, role });
  return { memberId, privateKeyRef: identity.privateKeyRef };
}

function makeEngine({ adapter, workspaceId, memberId, privateKeyRef, keyring, memberRegistry, membershipStore }) {
  return new SyncEngine({
    adapter,
    eventLog: new EventLog(),
    crypto: cryptoService,
    keyring,
    policy,
    memberRegistry,
    membershipStore,
    actor: { workspaceId, memberId, privateKeyRef },
  });
}

/** Construit un workspace à deux membres (Alice/Bob) partageant un adaptateur et une clé d'epoch 1. */
async function makeHarness({ aliceRole = "user", bobRole = "user" } = {}) {
  const workspaceId = globalThis.crypto.randomUUID();
  const workspaceKey = await cryptoService.generateWorkspaceKey();
  const adapter = new InMemoryStorageAdapter();
  const memberRegistry = new FakeMemberRegistry();
  const membershipStore = new MembershipStore();

  const alice = await makeMember({ workspaceId, membershipStore, memberRegistry, consultantId: "c-alice", role: aliceRole });
  const bob = await makeMember({ workspaceId, membershipStore, memberRegistry, consultantId: "c-bob", role: bobRole });

  const aliceKeyring = new Keyring();
  aliceKeyring.addEpoch(1, workspaceKey);
  const bobKeyring = new Keyring();
  bobKeyring.addEpoch(1, workspaceKey);

  const aliceEngine = makeEngine({
    adapter, workspaceId, memberId: alice.memberId, privateKeyRef: alice.privateKeyRef,
    keyring: aliceKeyring, memberRegistry, membershipStore,
  });
  const bobEngine = makeEngine({
    adapter, workspaceId, memberId: bob.memberId, privateKeyRef: bob.privateKeyRef,
    keyring: bobKeyring, memberRegistry, membershipStore,
  });

  return {
    workspaceId, adapter, memberRegistry, membershipStore, workspaceKey,
    alice: { ...alice, engine: aliceEngine, keyring: aliceKeyring },
    bob: { ...bob, engine: bobEngine, keyring: bobKeyring },
  };
}

function saisiePayload(overrides = {}) {
  return {
    id: "sX", date: "2026-01-05", consultantId: "c-alice", type: "interne",
    missionId: null, dureeH: 1, pctFact: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Convergence — entités différentes
// ---------------------------------------------------------------------------

test("convergence : Alice modifie A, Bob modifie B => après sync les deux voient A+B", async () => {
  const h = await makeHarness();

  h.alice.engine.createLocalEvent({
    entityType: "saisies", entityId: "sA", operation: "create",
    payload: saisiePayload({ id: "sA", consultantId: "c-alice", dureeH: 3 }),
  });
  h.bob.engine.createLocalEvent({
    entityType: "saisies", entityId: "sB", operation: "create",
    payload: saisiePayload({ id: "sB", consultantId: "c-bob", dureeH: 4 }),
  });

  await h.alice.engine.push();
  await h.bob.engine.push();
  await h.alice.engine.pull();
  await h.bob.engine.pull();

  const aliceProj = h.alice.engine.getProjection();
  const bobProj = h.bob.engine.getProjection();

  assert.ok(aliceProj.saisies.sA, "Alice voit A (la sienne)");
  assert.ok(aliceProj.saisies.sB, "Alice voit B (celle de Bob, après sync)");
  assert.ok(bobProj.saisies.sA, "Bob voit A (celle d'Alice, après sync)");
  assert.ok(bobProj.saisies.sB, "Bob voit B (la sienne)");
  assert.equal(h.alice.engine.getRejections().length, 0);
  assert.equal(h.bob.engine.getRejections().length, 0);
  assert.equal(h.alice.engine.getConflicts().length, 0);
  assert.equal(h.bob.engine.getConflicts().length, 0);
});

// ---------------------------------------------------------------------------
// 2. Conflit — même entité, même base, deux acteurs
// ---------------------------------------------------------------------------

test("conflit : Alice et Bob modifient la MÊME entité sur la même base => une applique, l'autre en conflit", async () => {
  // Rôle admin des deux côtés pour isoler le test de concurrence de la question
  // des droits (consultants est ADMIN_ONLY) — la politique n'est pas l'objet ici.
  const h = await makeHarness({ aliceRole: "admin", bobRole: "admin" });

  const evAlice = h.alice.engine.createLocalEvent({
    entityType: "consultants", entityId: "cX", operation: "create",
    payload: { id: "cX", nom: "Version Alice" },
  });
  const evBob = h.bob.engine.createLocalEvent({
    entityType: "consultants", entityId: "cX", operation: "create",
    payload: { id: "cX", nom: "Version Bob" },
  });

  await h.alice.engine.push();
  await h.bob.engine.push();
  await h.alice.engine.pull();
  await h.bob.engine.pull();

  const aliceProj = h.alice.engine.getProjection();
  const bobProj = h.bob.engine.getProjection();

  // Convergence : les deux répliques, ayant fini par recevoir les DEUX
  // événements, retiennent la MÊME version gagnante (déterminisme d'EventLog).
  assert.deepEqual(aliceProj.consultants.cX, bobProj.consultants.cX);

  const aliceConflictIds = h.alice.engine.getConflicts().map((c) => c.eventId).sort();
  const bobConflictIds = h.bob.engine.getConflicts().map((c) => c.eventId).sort();
  assert.deepEqual(aliceConflictIds, bobConflictIds, "les deux répliques identifient le même conflit");
  assert.equal(aliceConflictIds.length, 1, "exactement un conflit, jamais deux résolutions divergentes");
  assert.ok(
    aliceConflictIds[0] === evAlice.eventId || aliceConflictIds[0] === evBob.eventId,
    "le conflit désigne bien l'un des deux événements concurrents"
  );

  // Aucune écriture n'est perdue : les DEUX événements restent dans le journal.
  const aliceEventIds = h.alice.engine.eventLog.list().map((e) => e.eventId);
  assert.ok(aliceEventIds.includes(evAlice.eventId));
  assert.ok(aliceEventIds.includes(evBob.eventId));
});

// ---------------------------------------------------------------------------
// 3. Idempotence — événement dupliqué
// ---------------------------------------------------------------------------

test("idempotence : un événement dupliqué (même eventId) est appliqué une seule fois", async () => {
  const h = await makeHarness();
  h.bob.engine.createLocalEvent({
    entityType: "saisies", entityId: "sD", operation: "create",
    payload: saisiePayload({ id: "sD", consultantId: "c-bob", dureeH: 2 }),
  });
  await h.bob.engine.push();

  await h.alice.engine.pull();
  const projAfterFirst = h.alice.engine.getProjection();
  assert.ok(projAfterFirst.saisies.sD);
  const versionAfterFirst = projAfterFirst.__versions.saisies.sD.version;

  // Simule une re-livraison du même événement par l'adaptateur (ex: reprise
  // après incident) en revenant en arrière sur le curseur local.
  h.alice.engine._cursor = 0;
  const result = await h.alice.engine.pull();
  assert.equal(result.rejections.length, 0, "un doublon n'est jamais une erreur");

  const projAfterSecond = h.alice.engine.getProjection();
  assert.equal(
    projAfterSecond.__versions.saisies.sD.version,
    versionAfterFirst,
    "aucune ré-application : la version de l'entité est inchangée"
  );
  assert.deepEqual(projAfterSecond.saisies.sD, projAfterFirst.saisies.sD);
});

// ---------------------------------------------------------------------------
// 4. Ordre de réception différent => projection déterministe identique
// ---------------------------------------------------------------------------

test("déterminisme : événements reçus dans un ordre différent => projection identique", async () => {
  const h = await makeHarness();

  const create = h.alice.engine.createLocalEvent({
    entityType: "saisies", entityId: "sOrd", operation: "create",
    payload: saisiePayload({ id: "sOrd", consultantId: "c-alice", dureeH: 1 }),
  });
  const update = h.alice.engine.createLocalEvent({
    entityType: "saisies", entityId: "sOrd", operation: "update",
    payload: saisiePayload({ id: "sOrd", consultantId: "c-alice", dureeH: 5 }),
  });
  await h.alice.engine.push();

  const blobCreate = await h.adapter.get("event", create.eventId);
  const blobUpdate = await h.adapter.get("event", update.eventId);

  const adapterNaturalOrder = new InMemoryStorageAdapter();
  await adapterNaturalOrder.putImmutable("event", create.eventId, blobCreate);
  await adapterNaturalOrder.putImmutable("event", update.eventId, blobUpdate);

  const adapterReversedOrder = new InMemoryStorageAdapter();
  await adapterReversedOrder.putImmutable("event", update.eventId, blobUpdate);
  await adapterReversedOrder.putImmutable("event", create.eventId, blobCreate);

  const observerNatural = await makeMember({
    workspaceId: h.workspaceId, membershipStore: h.membershipStore, memberRegistry: h.memberRegistry,
    consultantId: "c-observer-1", role: "user",
  });
  const observerReversed = await makeMember({
    workspaceId: h.workspaceId, membershipStore: h.membershipStore, memberRegistry: h.memberRegistry,
    consultantId: "c-observer-2", role: "user",
  });
  const keyringNatural = new Keyring();
  keyringNatural.addEpoch(1, h.workspaceKey);
  const keyringReversed = new Keyring();
  keyringReversed.addEpoch(1, h.workspaceKey);

  const engineNatural = makeEngine({
    adapter: adapterNaturalOrder, workspaceId: h.workspaceId, memberId: observerNatural.memberId,
    privateKeyRef: observerNatural.privateKeyRef, keyring: keyringNatural,
    memberRegistry: h.memberRegistry, membershipStore: h.membershipStore,
  });
  const engineReversed = makeEngine({
    adapter: adapterReversedOrder, workspaceId: h.workspaceId, memberId: observerReversed.memberId,
    privateKeyRef: observerReversed.privateKeyRef, keyring: keyringReversed,
    memberRegistry: h.memberRegistry, membershipStore: h.membershipStore,
  });

  await engineNatural.pull();
  await engineReversed.pull();

  assert.equal(engineNatural.getRejections().length, 0);
  assert.equal(engineReversed.getRejections().length, 0);
  assert.deepEqual(engineNatural.getProjection().saisies.sOrd, engineReversed.getProjection().saisies.sOrd);
  assert.equal(
    engineNatural.getProjection().saisies.sOrd.dureeH, 5,
    "l'update (dépendant causalement de baseVersion=0) l'emporte quel que soit l'ordre de réception"
  );
});

// ---------------------------------------------------------------------------
// 5. Client hostile — membre révoqué / inconnu
// ---------------------------------------------------------------------------

test("hostile : événement signé par un membre révoqué ou par un non-membre => rejeté (jamais appliqué)", async () => {
  const h = await makeHarness();

  // Membre révoqué : connu du registre de clés (signature vérifiable) mais membership revoked.
  const mallory = await makeMember({
    workspaceId: h.workspaceId, membershipStore: h.membershipStore, memberRegistry: h.memberRegistry,
    consultantId: "c-mallory", role: "user",
  });
  h.membershipStore.revoke(h.workspaceId, mallory.memberId);

  const revokedEvent = buildEvent({
    workspaceId: h.workspaceId, entityType: "saisies", entityId: "sMal", operation: "create",
    actorId: mallory.memberId, baseVersion: 0, epoch: 1,
    payload: saisiePayload({ id: "sMal", consultantId: "c-mallory" }),
  });
  const revokedCiphertext = await cryptoService.encryptPayload(h.workspaceKey, revokedEvent.payload);
  const { payload: _p1, ...revokedEnvelope } = revokedEvent;
  const revokedBlob = { ...revokedEnvelope, ciphertext: revokedCiphertext };
  revokedBlob.signature = await cryptoService.sign(mallory.privateKeyRef, canonicalize(revokedBlob));
  await h.adapter.putImmutable("event", revokedEvent.eventId, revokedBlob);

  // Non-membre : jamais enregistré, ni côté registre de clés ni côté memberships.
  const strangerIdentity = await cryptoService.generateMemberIdentity();
  const strangerMemberId = globalThis.crypto.randomUUID();
  const strangerEvent = buildEvent({
    workspaceId: h.workspaceId, entityType: "saisies", entityId: "sStr", operation: "create",
    actorId: strangerMemberId, baseVersion: 0, epoch: 1,
    payload: saisiePayload({ id: "sStr", consultantId: "c-stranger" }),
  });
  const strangerCiphertext = await cryptoService.encryptPayload(h.workspaceKey, strangerEvent.payload);
  const { payload: _p2, ...strangerEnvelope } = strangerEvent;
  const strangerBlob = { ...strangerEnvelope, ciphertext: strangerCiphertext };
  strangerBlob.signature = await cryptoService.sign(strangerIdentity.privateKeyRef, canonicalize(strangerBlob));
  await h.adapter.putImmutable("event", strangerEvent.eventId, strangerBlob);

  const result = await h.bob.engine.pull();

  assert.equal(result.rejections.length, 2);
  const stageByEventId = Object.fromEntries(result.rejections.map((r) => [r.eventId, r.stage]));
  assert.equal(stageByEventId[revokedEvent.eventId], "membership", "membre révoqué rejeté à l'étape membership");
  assert.equal(stageByEventId[strangerEvent.eventId], "signature", "non-membre rejeté dès la vérification de signature");

  const proj = h.bob.engine.getProjection();
  assert.equal(proj.saisies?.sMal, undefined);
  assert.equal(proj.saisies?.sStr, undefined);
  assert.equal(h.bob.engine.getConflicts().length, 0, "un rejet n'est jamais un conflit");
});

// ---------------------------------------------------------------------------
// 6. Politique métier — user modifiant la saisie d'autrui
// ---------------------------------------------------------------------------

test("politique : un user modifiant la saisie d'autrui => rejeté", async () => {
  const h = await makeHarness(); // Alice et Bob, tous deux role "user"

  // Bob (client hostile ou modifié côté UI) fabrique et publie un événement
  // usurpant une saisie appartenant à Alice.
  h.bob.engine.createLocalEvent({
    entityType: "saisies", entityId: "sTheft", operation: "create",
    payload: saisiePayload({ id: "sTheft", consultantId: "c-alice", dureeH: 9 }),
  });
  await h.bob.engine.push();

  const result = await h.alice.engine.pull();
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].stage, "policy");

  assert.equal(h.alice.engine.getProjection().saisies?.sTheft, undefined, "jamais appliqué côté Alice");
});

// ---------------------------------------------------------------------------
// 7. Résilience — panne réseau pendant push
// ---------------------------------------------------------------------------

test("résilience : panne réseau pendant push => reste pending ; retour en ligne => publié et convergent", async () => {
  const h = await makeHarness();
  const ev = h.alice.engine.createLocalEvent({
    entityType: "saisies", entityId: "sOff", operation: "create",
    payload: saisiePayload({ id: "sOff", consultantId: "c-alice", dureeH: 2 }),
  });

  h.adapter.setOffline(true);
  const pushResult1 = await h.alice.engine.push();
  assert.equal(pushResult1.published.length, 0);
  assert.equal(pushResult1.stillPending.length, 1);
  assert.equal(h.alice.engine.getEventStatus(ev.eventId), "pending", "l'écriture locale n'est jamais perdue");

  h.adapter.setOffline(false);
  const pushResult2 = await h.alice.engine.push();
  assert.deepEqual(pushResult2.published, [ev.eventId]);
  assert.equal(h.alice.engine.getEventStatus(ev.eventId), "published");

  await h.bob.engine.pull();
  assert.ok(h.bob.engine.getProjection().saisies.sOff, "Bob converge une fois la publication confirmée");
  assert.equal(h.bob.engine.getRejections().length, 0);
});

// ---------------------------------------------------------------------------
// 8. Confidentialité — aucun champ métier en clair dans le blob transporté
// ---------------------------------------------------------------------------

test("confidentialité : le blob stocké ne porte aucun champ métier en clair (payload chiffré)", async () => {
  const h = await makeHarness();
  const secretMarker = "SECRET-MARKER-42-XYZ";
  const ev = h.alice.engine.createLocalEvent({
    entityType: "saisies", entityId: "sSecret", operation: "create",
    payload: saisiePayload({ id: "sSecret", consultantId: "c-alice", dureeH: 2, commentaire: secretMarker }),
  });
  await h.alice.engine.push();

  const blob = await h.adapter.get("event", ev.eventId);
  const raw = JSON.stringify(blob);

  assert.ok(!("payload" in blob), "le blob publié ne porte jamais le payload en clair");
  assert.equal(typeof blob.ciphertext, "string");
  assert.ok(blob.ciphertext.length > 0);
  assert.ok(typeof blob.signature === "string" && blob.signature.length > 0);
  assert.ok(!raw.includes(secretMarker), "le commentaire métier n'apparaît jamais en clair");
  assert.ok(!raw.includes("c-alice"), "l'identifiant métier du consultant n'apparaît jamais en clair");
});

// ---------------------------------------------------------------------------
// InMemoryStorageAdapter — write-once, curseur, panne simulée
// ---------------------------------------------------------------------------

test("InMemoryStorageAdapter : write-once refuse d'écraser un (kind,id) déjà écrit", async () => {
  const adapter = new InMemoryStorageAdapter();
  await adapter.connect();
  await adapter.putImmutable("event", "e1", { a: 1 });
  await assert.rejects(() => adapter.putImmutable("event", "e1", { a: 2 }));
  assert.deepEqual(await adapter.get("event", "e1"), { a: 1 });
});

test("InMemoryStorageAdapter : listChanges(cursor) est incrémental, et rejouable sans trou ni doublon", async () => {
  const adapter = new InMemoryStorageAdapter();
  await adapter.putImmutable("event", "e1", {});
  const first = await adapter.listChanges();
  assert.deepEqual(first.changes, [{ kind: "event", id: "e1" }]);

  await adapter.putImmutable("event", "e2", {});
  const second = await adapter.listChanges(first.cursor);
  assert.deepEqual(second.changes, [{ kind: "event", id: "e2" }]);

  const replay = await adapter.listChanges(0);
  assert.deepEqual(replay.changes, [{ kind: "event", id: "e1" }, { kind: "event", id: "e2" }]);
});

test("InMemoryStorageAdapter : setOffline simule une panne (put/get/listChanges échouent), health répond sans lever", async () => {
  const adapter = new InMemoryStorageAdapter();
  adapter.setOffline(true);
  await assert.rejects(() => adapter.putImmutable("event", "e1", {}));
  await assert.rejects(() => adapter.get("event", "e1"));
  await assert.rejects(() => adapter.listChanges());
  const health = await adapter.health();
  assert.equal(health.ok, false);

  adapter.setOffline(false);
  await adapter.putImmutable("event", "e1", { ok: true });
  assert.deepEqual(await adapter.get("event", "e1"), { ok: true });
  assert.equal((await adapter.health()).ok, true);
});

test("InMemoryStorageAdapter : kind invalide rejeté", async () => {
  const adapter = new InMemoryStorageAdapter();
  await assert.rejects(() => adapter.putImmutable("bogus", "x", {}));
});

// ---------------------------------------------------------------------------
// GoogleDriveStorageAdapter — helpers purs + squelette non câblé
// ---------------------------------------------------------------------------

test("google-drive-adapter : mapping kind -> dossier (docs/next/04 §2)", () => {
  assert.equal(folderForKind("workspace"), "workspace");
  assert.equal(folderForKind("member"), "members");
  assert.equal(folderForKind("event"), "events");
  assert.equal(folderForKind("key"), "keys");
  assert.equal(folderForKind("license"), "licenses");
  assert.throws(() => folderForKind("bogus"));
});

test("google-drive-adapter : buildDrivePath produit l'arborescence attendue", () => {
  assert.equal(buildDrivePath("workspace", "ignored"), "workspace/manifest.piloteo");
  assert.equal(buildDrivePath("member", "mem-1"), "members/mem-1.piloteo");
  assert.equal(
    buildDrivePath("event", "ev-1", { createdAt: "2026-08-30T12:00:00.000Z" }),
    "events/2026-08/ev-1.piloteo"
  );
  assert.equal(buildDrivePath("key", "mem-1", { epoch: 3 }), "keys/epoch-0003/mem-1.key");
  assert.equal(buildDrivePath("license", "ignored"), "licenses/current.license");
  assert.throws(() => buildDrivePath("event", "ev-1"), /createdAt/);
  assert.throws(() => buildDrivePath("key", "mem-1"), /epoch/);
});

test("google-drive-adapter : driveQueryParams distingue My Drive / Shared Drive (docs/next/04 §8-9)", () => {
  const myDrive = driveQueryParams({});
  assert.equal(myDrive.supportsAllDrives, false);
  assert.equal(myDrive.includeItemsFromAllDrives, false);

  const shared = driveQueryParams({ driveId: "drv-1" });
  assert.equal(shared.supportsAllDrives, true);
  assert.equal(shared.includeItemsFromAllDrives, true);
  assert.equal(shared.driveId, "drv-1");
});

test("google-drive-adapter : scope cible drive.file (docs/next/04 §6)", () => {
  assert.equal(DRIVE_SCOPE, "https://www.googleapis.com/auth/drive.file");
});

test("google-drive-adapter : oauthTokenProvider requis, jamais copié/transformé (référence de fonction conservée telle quelle)", () => {
  assert.throws(() => new GoogleDriveStorageAdapter({}));
  const provider = async () => "token";
  const adapter = new GoogleDriveStorageAdapter({ oauthTokenProvider: provider });
  assert.equal(adapter._oauthTokenProvider, provider);
  assert.equal(adapter.isSharedDrive, false);
  const shared = new GoogleDriveStorageAdapter({ oauthTokenProvider: provider, driveId: "drv-1" });
  assert.equal(shared.isSharedDrive, true);
});

test("google-drive-adapter : méthodes réseau NON câblées lèvent NotWiredError (documenté, cf. en-tête du fichier)", async () => {
  const adapter = new GoogleDriveStorageAdapter({ oauthTokenProvider: async () => "fake-token" });
  await assert.rejects(() => adapter.connect(), NotWiredError);
  await assert.rejects(() => adapter.putImmutable("event", "e1", {}), NotWiredError);
  await assert.rejects(() => adapter.get("event", "e1"), NotWiredError);
  await assert.rejects(() => adapter.listChanges(), NotWiredError);
  await assert.rejects(() => adapter.readMetadata("event", "e1"), NotWiredError);
  await assert.rejects(() => adapter.share("m1"), NotWiredError);
  await assert.rejects(() => adapter.revoke("m1"), NotWiredError);
  await assert.rejects(() => adapter.health(), NotWiredError);
});
