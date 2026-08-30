// tests/next/local-store.test.mjs
//
// Couvre docs/next/07_TESTS_ET_RECETTE.md §3 (LocalStore) pour
// src/storage/local-store.js : création workspace, fermeture/réouverture,
// isolation de deux workspaces, append idempotent, save/load projection,
// export/import round-trip, absence de clé privée dans l'export, migration
// de schéma IndexedDB (v1 -> v2 sans perte), store inexistant => erreur
// maîtrisée. `node:test` ; IndexedDB fourni hors navigateur par
// `fake-indexeddb` (import 'auto' AVANT tout import du module de prod, qui
// lui n'importe jamais fake-indexeddb).

import "fake-indexeddb/auto";

import test from "node:test";
import assert from "node:assert/strict";

import { LocalStore, STORE_NAMES, BACKUP_FORMAT } from "../../src/storage/local-store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const MEMBER_ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let dbCounter = 0;
function freshDbName() {
  dbCounter += 1;
  return `piloteo-test-${process.pid}-${Date.now()}-${dbCounter}`;
}

function makeWorkspace(id, overrides = {}) {
  return {
    id,
    name: "ACME",
    mode: "local",
    createdAt: "2026-08-30T12:00:00.000Z",
    schemaVersion: 2,
    storage: { provider: "none", rootId: null },
    ...overrides,
  };
}

function makeEvent({ workspaceId, entityId, eventId, baseVersion = 0, createdAt }) {
  return {
    version: 1,
    eventId,
    workspaceId,
    entityType: "saisies",
    entityId,
    operation: "create",
    actorId: MEMBER_ALICE,
    baseVersion,
    epoch: 1,
    createdAt: createdAt || new Date().toISOString(),
    payload: { id: entityId, dureeH: 7 },
  };
}

// ---------------------------------------------------------------------------
// Création workspace / CRUD générique
// ---------------------------------------------------------------------------

test("LocalStore: open crée les 8 stores attendus", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  for (const name of STORE_NAMES) {
    assert.equal(store.db.objectStoreNames.contains(name), true, `store manquant: ${name}`);
  }
  store.close();
});

test("LocalStore: création workspace via put puis get", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  const workspace = makeWorkspace(WORKSPACE_A);
  await store.put("workspaces", workspace);
  const loaded = await store.get("workspaces", WORKSPACE_A);
  assert.deepEqual(loaded, workspace);
  store.close();
});

test("LocalStore: get sur une clé absente renvoie null (pas undefined, pas d'exception)", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  const loaded = await store.get("workspaces", "inconnu");
  assert.equal(loaded, null);
  store.close();
});

// ---------------------------------------------------------------------------
// Fermeture / réouverture (persistance)
// ---------------------------------------------------------------------------

test("LocalStore: fermeture puis réouverture -> les données persistent", async () => {
  const dbName = freshDbName();
  const store1 = await LocalStore.open(dbName, { schemaVersion: 2 });
  await store1.put("workspaces", makeWorkspace(WORKSPACE_A));
  await store1.saveLocalProjection(WORKSPACE_A, { saisies: { s1: { dureeH: 7 } } });
  store1.close();

  const store2 = await LocalStore.open(dbName, { schemaVersion: 2 });
  const workspace = await store2.get("workspaces", WORKSPACE_A);
  const projection = await store2.loadWorkspaceState(WORKSPACE_A);
  assert.equal(workspace.id, WORKSPACE_A);
  assert.deepEqual(projection, { saisies: { s1: { dureeH: 7 } } });
  store2.close();
});

// ---------------------------------------------------------------------------
// Isolation entre deux workspaces
// ---------------------------------------------------------------------------

test("LocalStore: isolation stricte entre deux workspaces (projections + events)", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  await store.put("workspaces", makeWorkspace(WORKSPACE_A));
  await store.put("workspaces", makeWorkspace(WORKSPACE_B, { name: "BETA" }));

  await store.saveLocalProjection(WORKSPACE_A, { saisies: { a: 1 } });
  await store.saveLocalProjection(WORKSPACE_B, { saisies: { b: 2 } });

  await store.appendLocalEvent(makeEvent({ workspaceId: WORKSPACE_A, entityId: "sA", eventId: "eA-1" }));
  await store.appendLocalEvent(makeEvent({ workspaceId: WORKSPACE_B, entityId: "sB", eventId: "eB-1" }));

  const projA = await store.loadWorkspaceState(WORKSPACE_A);
  const projB = await store.loadWorkspaceState(WORKSPACE_B);
  assert.deepEqual(projA, { saisies: { a: 1 } });
  assert.deepEqual(projB, { saisies: { b: 2 } });

  const eventsA = await store.listLocalEvents(WORKSPACE_A);
  const eventsB = await store.listLocalEvents(WORKSPACE_B);
  assert.equal(eventsA.length, 1);
  assert.equal(eventsB.length, 1);
  assert.equal(eventsA[0].eventId, "eA-1");
  assert.equal(eventsB[0].eventId, "eB-1");
  assert.notEqual(eventsA[0].entityId, eventsB[0].entityId);

  store.close();
});

// ---------------------------------------------------------------------------
// Append idempotent d'événements
// ---------------------------------------------------------------------------

test("LocalStore: appendLocalEvent est idempotent sur eventId", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  const event = makeEvent({ workspaceId: WORKSPACE_A, entityId: "s1", eventId: "e-1" });

  const first = await store.appendLocalEvent(event);
  const second = await store.appendLocalEvent(event);

  assert.deepEqual(first, { appended: true, duplicate: false });
  assert.deepEqual(second, { appended: false, duplicate: true });

  const events = await store.listLocalEvents(WORKSPACE_A);
  assert.equal(events.length, 1);
  store.close();
});

test("LocalStore: appendLocalEvent ne fait jamais régresser le state local d'un doublon", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  const event = makeEvent({ workspaceId: WORKSPACE_A, entityId: "s1", eventId: "e-1" });

  await store.appendLocalEvent(event); // state par défaut: pending
  await store.put("events", { ...event, state: "applied" }); // simulateur de SyncEngine
  await store.appendLocalEvent(event); // ré-append : ne doit pas écraser "applied"

  const stored = await store.get("events", "e-1");
  assert.equal(stored.state, "applied");
  store.close();
});

test("LocalStore: listLocalEvents respecte fromCursor et l'ordre", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  await store.appendLocalEvent(
    makeEvent({ workspaceId: WORKSPACE_A, entityId: "s1", eventId: "e-1", createdAt: "2026-08-30T10:00:00.000Z" }),
  );
  await store.appendLocalEvent(
    makeEvent({ workspaceId: WORKSPACE_A, entityId: "s2", eventId: "e-2", createdAt: "2026-08-30T11:00:00.000Z" }),
  );
  await store.appendLocalEvent(
    makeEvent({ workspaceId: WORKSPACE_A, entityId: "s3", eventId: "e-3", createdAt: "2026-08-30T12:00:00.000Z" }),
  );

  const all = await store.listLocalEvents(WORKSPACE_A);
  assert.deepEqual(all.map((e) => e.eventId), ["e-1", "e-2", "e-3"]);

  const fromE1 = await store.listLocalEvents(WORKSPACE_A, { fromCursor: "e-1" });
  assert.deepEqual(fromE1.map((e) => e.eventId), ["e-2", "e-3"]);
  store.close();
});

// ---------------------------------------------------------------------------
// Save/load projection
// ---------------------------------------------------------------------------

test("LocalStore: saveLocalProjection puis loadWorkspaceState round-trip", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  const projection = { saisies: { s1: { dureeH: 7 } }, __versions: { saisies: { s1: { version: 1 } } } };
  await store.saveLocalProjection(WORKSPACE_A, projection);
  const loaded = await store.loadWorkspaceState(WORKSPACE_A);
  assert.deepEqual(loaded, projection);
  store.close();
});

test("LocalStore: loadWorkspaceState d'un workspace jamais sauvegardé renvoie null", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  const loaded = await store.loadWorkspaceState("jamais-vu");
  assert.equal(loaded, null);
  store.close();
});

// ---------------------------------------------------------------------------
// Export / import round-trip + jamais de clé privée
// ---------------------------------------------------------------------------

test("LocalStore: exportBackup puis importBackup round-trip (mêmes events/projection)", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  await store.put("workspaces", makeWorkspace(WORKSPACE_A));
  await store.put("memberships", {
    workspaceId: WORKSPACE_A,
    memberId: MEMBER_ALICE,
    googleSubject: null,
    email: "alice@example.com",
    consultantId: "cns-1",
    role: "owner",
    status: "active",
  });
  // Une clé privée EST stockée localement (autre membre simulé) : elle ne doit
  // JAMAIS se retrouver dans l'export.
  await store.put("keys", { id: "member-key-bob", kind: "member-private-key", secret: "TOP-SECRET-PRIVATE-KEY" });

  const projection = { saisies: { s1: { dureeH: 7 } } };
  await store.saveLocalProjection(WORKSPACE_A, projection);
  await store.appendLocalEvent(makeEvent({ workspaceId: WORKSPACE_A, entityId: "s1", eventId: "e-1" }));
  await store.appendLocalEvent(makeEvent({ workspaceId: WORKSPACE_A, entityId: "s2", eventId: "e-2" }));

  const backup = await store.exportBackup(WORKSPACE_A);
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.workspaceId, WORKSPACE_A);
  assert.equal(backup.events.length, 2);
  assert.deepEqual(backup.projection, projection);

  // Jamais de clé privée dans l'export : ni littéralement, ni via un store `keys`.
  const serialized = JSON.stringify(backup);
  assert.equal(serialized.includes("TOP-SECRET-PRIVATE-KEY"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(backup, "keys"), false);
  assert.equal(backup.meta.keys, undefined);

  // Import dans une base fraîche : round-trip identique.
  const store2 = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  const result = await store2.importBackup(backup);
  assert.deepEqual(result, { workspaceId: WORKSPACE_A });

  const eventsAfter = await store2.listLocalEvents(WORKSPACE_A);
  assert.equal(eventsAfter.length, 2);
  assert.deepEqual(eventsAfter.map((e) => e.eventId).sort(), ["e-1", "e-2"]);
  const projectionAfter = await store2.loadWorkspaceState(WORKSPACE_A);
  assert.deepEqual(projectionAfter, projection);
  const workspaceAfter = await store2.get("workspaces", WORKSPACE_A);
  assert.equal(workspaceAfter.id, WORKSPACE_A);

  // Ré-importer le même backup est idempotent (même état, pas de doublon).
  await store2.importBackup(backup);
  const eventsAfterSecondImport = await store2.listLocalEvents(WORKSPACE_A);
  assert.equal(eventsAfterSecondImport.length, 2);

  store.close();
  store2.close();
});

test("LocalStore: importBackup rejette un format inconnu", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  await assert.rejects(() => store.importBackup({ format: "autre-format", workspaceId: WORKSPACE_A }));
  await assert.rejects(() => store.importBackup(null));
  store.close();
});

test("LocalStore: exportBackup échoue clairement si le workspace n'existe pas", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  await assert.rejects(() => store.exportBackup("workspace-inconnu"));
  store.close();
});

// ---------------------------------------------------------------------------
// Migration de schéma IndexedDB
// ---------------------------------------------------------------------------

test("LocalStore: migration v1 -> v2 sans perte de données", async () => {
  const dbName = freshDbName();

  const storeV1 = await LocalStore.open(dbName, { schemaVersion: 1 });
  assert.equal(storeV1.db.objectStoreNames.contains("settings"), false);
  await storeV1.put("workspaces", makeWorkspace(WORKSPACE_A));
  await storeV1.saveLocalProjection(WORKSPACE_A, { saisies: { s1: { dureeH: 7 } } });
  await storeV1.appendLocalEvent(makeEvent({ workspaceId: WORKSPACE_A, entityId: "s1", eventId: "e-1" }));
  storeV1.close();

  const storeV2 = await LocalStore.open(dbName, { schemaVersion: 2 });
  assert.equal(storeV2.db.objectStoreNames.contains("settings"), true);

  // Données créées en v1 toujours présentes après la migration.
  const workspace = await storeV2.get("workspaces", WORKSPACE_A);
  assert.equal(workspace.id, WORKSPACE_A);
  const projection = await storeV2.loadWorkspaceState(WORKSPACE_A);
  assert.deepEqual(projection, { saisies: { s1: { dureeH: 7 } } });
  const events = await storeV2.listLocalEvents(WORKSPACE_A);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, "e-1");

  // Le nouveau store/index de v2 est bien utilisable.
  await storeV2.put("settings", { key: "theme", value: "dark" });
  assert.deepEqual(await storeV2.get("settings", "theme"), { key: "theme", value: "dark" });

  storeV2.close();
});

test("LocalStore: réouverture à la même version ne perd rien et reste idempotente", async () => {
  const dbName = freshDbName();
  const store1 = await LocalStore.open(dbName, { schemaVersion: 2 });
  await store1.put("workspaces", makeWorkspace(WORKSPACE_A));
  store1.close();

  const store2 = await LocalStore.open(dbName, { schemaVersion: 2 });
  const store3Workspace = await store2.get("workspaces", WORKSPACE_A);
  assert.equal(store3Workspace.id, WORKSPACE_A);
  store2.close();
});

// ---------------------------------------------------------------------------
// Store inexistant / corrompu => erreur maîtrisée
// ---------------------------------------------------------------------------

test("LocalStore: get sur un store inexistant lève une erreur claire (pas de crash silencieux)", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  await assert.rejects(() => store.get("store_qui_nexiste_pas", "x"), /store inconnu ou absent/);
  store.close();
});

test("LocalStore: put/getAll/delete/clear sur un store inexistant lèvent tous une erreur claire", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 2 });
  await assert.rejects(() => store.put("nope", { id: 1 }), /store inconnu ou absent/);
  await assert.rejects(() => store.getAll("nope"), /store inconnu ou absent/);
  await assert.rejects(() => store.delete("nope", 1), /store inconnu ou absent/);
  await assert.rejects(() => store.clear("nope"), /store inconnu ou absent/);
  store.close();
});

test("LocalStore: un store déclaré par le contrat mais pas encore créé (schemaVersion trop bas) échoue clairement", async () => {
  const store = await LocalStore.open(freshDbName(), { schemaVersion: 1 });
  // "settings" fait partie du contrat mais n'est créé qu'à partir de la v2.
  await assert.rejects(() => store.put("settings", { key: "x", value: 1 }), /store inconnu ou absent/);
  store.close();
});
