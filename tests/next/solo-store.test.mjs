// tests/next/solo-store.test.mjs
//
// Couvre docs/next/CONVERGENCE_CONTRACT.md §6 (8 scénarios) pour
// `src/integration/solo-store.js`. Chaque scénario est exécuté contre les DEUX
// backends du contrat (§5) : IndexedDB (`fake-indexeddb`) et Dossier
// (`NodeFsPort` sur un `mkdtemp`, nettoyé en fin de test) — via un petit
// harnais `withBackend` qui fabrique/nettoie le backend concerné et expose une
// fabrique `makeBackend()` pour simuler un « restart » (nouvelle instance sur
// le MÊME support physique : même `dbName` IndexedDB, même dossier racine).

import "fake-indexeddb/auto";

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  snapshotToEventsDiff,
  projectionToSnapshot,
  createSoloStore,
  createIndexedDbEventBackend,
  createFolderEventBackend,
} from "../../src/integration/solo-store.js";
import { buildEvent } from "../../src/events/event-schema.js";
import { EventLog } from "../../src/events/event-log.js";
import { NodeFsPort } from "../../src/storage/node-fs-port.js";

// ---------------------------------------------------------------------------
// Harnais backend (IndexedDB / Dossier)
// ---------------------------------------------------------------------------

let dbCounter = 0;
function freshDbName() {
  dbCounter += 1;
  return `piloteo-solo-test-${process.pid}-${Date.now()}-${dbCounter}`;
}

/**
 * Exécute `fn({ makeBackend })` pour le backend `kind` ("indexeddb" | "folder").
 * `makeBackend()` fabrique une NOUVELLE instance de backend pointant vers le
 * MÊME support physique (dbName / dossier racine) à chaque appel — utilisé
 * pour simuler un redémarrage de l'application. Le dossier temporaire est
 * nettoyé en fin d'appel.
 */
async function withBackend(kind, fn) {
  if (kind === "indexeddb") {
    const dbName = freshDbName();
    const makeBackend = () => createIndexedDbEventBackend({ indexedDB: globalThis.indexedDB, dbName });
    await fn({ makeBackend });
    return;
  }
  if (kind === "folder") {
    const root = await mkdtemp(join(tmpdir(), "piloteo-solo-store-"));
    try {
      const makeBackend = () => createFolderEventBackend({ fsPort: new NodeFsPort(root) });
      await fn({ makeBackend, root });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    return;
  }
  throw new Error(`withBackend: kind inconnu (${kind})`);
}

const BACKEND_KINDS = ["indexeddb", "folder"];

// ---------------------------------------------------------------------------
// Fixtures métier
// ---------------------------------------------------------------------------

function consultant(id, nom) {
  return { id, nom };
}

function saisie(id, { consultantId = "c-1", dureeH = 1, pctFact = 0 } = {}) {
  return {
    id,
    date: "2026-08-30",
    consultantId,
    type: "interne",
    missionId: null,
    categorie: "adm",
    dureeH,
    pctFact,
    commentaire: "",
  };
}

/** Snapshot vide des 12 collections (utile comme `oldState`/état de départ). */
function emptySnapshot() {
  const s = {};
  for (const coll of [
    "consultants", "organisations", "affaires", "methodes", "typesTerritoire",
    "domainesIntervention", "categoriesFrais", "missions", "factures", "saisies",
    "bordereauxFrais", "notesFrais",
  ]) {
    s[coll] = [];
  }
  return s;
}

/** Compare deux snapshots comme des ENSEMBLES par collection (ordre non significatif — contrat §4). */
function assertSnapshotsEqualAsSets(actual, expected) {
  const collections = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const coll of collections) {
    const a = (actual[coll] || []).slice().sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    const e = (expected[coll] || []).slice().sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    assert.deepEqual(a, e, `collection ${coll} diffère`);
  }
}

// ---------------------------------------------------------------------------
// 1. commit (create N entités) -> load -> snapshot identique
// ---------------------------------------------------------------------------

for (const kind of BACKEND_KINDS) {
  test(`solo-store [${kind}] : 1. commit create N entités -> load identique`, async () => {
    await withBackend(kind, async ({ makeBackend }) => {
      const store = createSoloStore({ backend: makeBackend() });

      const before = await store.load();
      assert.deepEqual(before.state.consultants, []);

      const nextState = {
        ...emptySnapshot(),
        consultants: [consultant("c-1", "Alice"), consultant("c-2", "Bob")],
        saisies: [saisie("s-1", { consultantId: "c-1", dureeH: 3 })],
      };

      const result = await store.commit(nextState);
      assert.equal(result.applied.count, 3);
      assert.equal(result.applied.rejected.length, 0);
      assertSnapshotsEqualAsSets(result.state, nextState);

      const after = await store.load();
      assertSnapshotsEqualAsSets(after.state, nextState);
      assert.equal(after.revision, result.revision);
    });
  });
}

// ---------------------------------------------------------------------------
// 2. update -> load -> nouvelle valeur ; lineage : parentEventId === eventId(create), baseVersion === 1
// ---------------------------------------------------------------------------

for (const kind of BACKEND_KINDS) {
  test(`solo-store [${kind}] : 2. update -> nouvelle valeur + lineage (parentEventId, baseVersion)`, async () => {
    await withBackend(kind, async ({ makeBackend }) => {
      const backend = makeBackend();
      const store = createSoloStore({ backend });

      const created = await store.commit({ ...emptySnapshot(), consultants: [consultant("c-1", "Alice")] });
      assert.equal(created.applied.count, 1);

      const updated = await store.commit({ ...emptySnapshot(), consultants: [consultant("c-1", "Alicia")] });
      assert.equal(updated.applied.count, 1);
      assert.equal(updated.applied.rejected.length, 0);
      assert.equal(updated.state.consultants.length, 1);
      assert.equal(updated.state.consultants[0].nom, "Alicia");

      const events = (await backend.listEvents()).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const createEvent = events.find((e) => e.operation === "create");
      const updateEvent = events.find((e) => e.operation === "update");
      assert.ok(createEvent && updateEvent);
      assert.equal(updateEvent.parentEventId, createEvent.eventId);
      assert.equal(updateEvent.baseVersion, 1);
      assert.equal(createEvent.baseVersion, 0);
      assert.equal(createEvent.parentEventId, null);
    });
  });
}

// ---------------------------------------------------------------------------
// 3. delete -> entité absente du snapshot ; tombstone présent dans la projection
// ---------------------------------------------------------------------------

for (const kind of BACKEND_KINDS) {
  test(`solo-store [${kind}] : 3. delete -> disparaît du snapshot, tombstone en projection`, async () => {
    await withBackend(kind, async ({ makeBackend }) => {
      const backend = makeBackend();
      const store = createSoloStore({ backend });

      await store.commit({ ...emptySnapshot(), consultants: [consultant("c-1", "Alice")] });
      const afterDelete = await store.commit({ ...emptySnapshot(), consultants: [] });

      assert.equal(afterDelete.applied.count, 1);
      assert.equal(afterDelete.state.consultants.length, 0);

      // La projection brute (hors snapshot) conserve un tombstone `__deleted`.
      const events = await backend.listEvents();
      const projection = new EventLog(events).replay();
      assert.equal(projection.consultants["c-1"].__deleted, true);
    });
  });
}

// ---------------------------------------------------------------------------
// 4. restart : nouveau store sur le MÊME backend -> même snapshot (persistance réelle)
// ---------------------------------------------------------------------------

for (const kind of BACKEND_KINDS) {
  test(`solo-store [${kind}] : 4. restart sur le même support -> même snapshot`, async () => {
    await withBackend(kind, async ({ makeBackend }) => {
      const storeA = createSoloStore({ backend: makeBackend() });
      const nextState = {
        ...emptySnapshot(),
        consultants: [consultant("c-1", "Alice")],
        saisies: [saisie("s-1", { consultantId: "c-1", dureeH: 5 })],
      };
      await storeA.commit(nextState);

      // Nouvelle instance de backend + de store, MÊME support physique.
      const storeB = createSoloStore({ backend: makeBackend() });
      const reloaded = await storeB.load();
      assertSnapshotsEqualAsSets(reloaded.state, nextState);
    });
  });
}

// ---------------------------------------------------------------------------
// 5. déterminisme : rejouer les mêmes événements dans un ordre différent -> même snapshot
// ---------------------------------------------------------------------------

for (const kind of BACKEND_KINDS) {
  test(`solo-store [${kind}] : 5. ordre d'insertion différent -> même snapshot`, async () => {
    await withBackend(kind, async ({ makeBackend }) => {
      const workspaceId = globalThis.crypto.randomUUID();
      const actorId = globalThis.crypto.randomUUID();

      const created = buildEvent({
        workspaceId, entityType: "consultants", entityId: "c-det", operation: "create",
        actorId, baseVersion: 0, epoch: 1, parentEventId: null,
        payload: consultant("c-det", "Alpha"),
      });
      const updated = buildEvent({
        workspaceId, entityType: "consultants", entityId: "c-det", operation: "update",
        actorId, baseVersion: 1, epoch: 1, parentEventId: created.eventId,
        payload: consultant("c-det", "Beta"),
      });
      const other = buildEvent({
        workspaceId, entityType: "saisies", entityId: "s-det", operation: "create",
        actorId, baseVersion: 0, epoch: 1, parentEventId: null,
        payload: saisie("s-det", { consultantId: "c-det", dureeH: 2 }),
      });

      const backendA = makeBackend();
      await backendA.init();
      for (const e of [created, updated, other]) await backendA.appendEvent(e);

      const backendB = kind === "indexeddb"
        ? createIndexedDbEventBackend({ indexedDB: globalThis.indexedDB, dbName: freshDbName() })
        : createFolderEventBackend({ fsPort: new NodeFsPort(await mkdtemp(join(tmpdir(), "piloteo-solo-store-det-"))) });
      await backendB.init();
      for (const e of [other, updated, created]) await backendB.appendEvent(e);

      const stateA = await createSoloStore({ backend: backendA }).currentSnapshot();
      const stateB = await createSoloStore({ backend: backendB }).currentSnapshot();
      assertSnapshotsEqualAsSets(stateA, stateB);
      assert.equal(stateA.consultants[0].nom, "Beta");
    });
  });
}

// ---------------------------------------------------------------------------
// 6. no-op : commit d'un snapshot identique -> 0 event écrit
// ---------------------------------------------------------------------------

for (const kind of BACKEND_KINDS) {
  test(`solo-store [${kind}] : 6. commit identique -> 0 événement écrit`, async () => {
    await withBackend(kind, async ({ makeBackend }) => {
      const store = createSoloStore({ backend: makeBackend() });
      const nextState = { ...emptySnapshot(), consultants: [consultant("c-1", "Alice")] };

      const first = await store.commit(nextState);
      assert.equal(first.applied.count, 1);

      const same = await store.currentSnapshot();
      const second = await store.commit(same);
      assert.equal(second.applied.count, 0);
      assert.equal(second.applied.rejected.length, 0);
      assert.equal(second.revision, first.revision);
    });
  });
}

// ---------------------------------------------------------------------------
// 7. backend Dossier : plusieurs commits -> fichiers events/AAAA-MM/*.piloteo créés ;
//    reload d'un nouveau store -> même snapshot.
// ---------------------------------------------------------------------------

test("solo-store [folder] : 7. plusieurs commits -> fichiers events/AAAA-MM/*.piloteo, reload identique", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-solo-store-folder-"));
  try {
    const fsPort = new NodeFsPort(root);
    const store = createSoloStore({ backend: createFolderEventBackend({ fsPort }) });

    await store.commit({ ...emptySnapshot(), consultants: [consultant("c-1", "Alice")] });
    await store.commit({
      ...emptySnapshot(),
      consultants: [consultant("c-1", "Alice")],
      saisies: [saisie("s-1", { consultantId: "c-1", dureeH: 4 })],
    });
    const finalState = {
      ...emptySnapshot(),
      consultants: [consultant("c-1", "Alicia")],
      saisies: [saisie("s-1", { consultantId: "c-1", dureeH: 4 })],
    };
    await store.commit(finalState);

    const eventFiles = (await fsPort.listFiles("events")).filter((f) => f.endsWith(".piloteo"));
    assert.ok(eventFiles.length >= 3, "au moins 3 fichiers événement écrits");
    assert.ok(eventFiles.every((f) => /^events\/\d{4}-\d{2}\/[0-9a-f-]+\.piloteo$/.test(f)), "chemin events/AAAA-MM/<eventId>.piloteo");
    assert.ok(await fsPort.exists("workspace/manifest.piloteo"), "manifest solo persisté");

    // Reload sur un nouveau store, même dossier.
    const reloadedStore = createSoloStore({ backend: createFolderEventBackend({ fsPort: new NodeFsPort(root) }) });
    const reloaded = await reloadedStore.load();
    assertSnapshotsEqualAsSets(reloaded.state, finalState);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. validation : payload invalide (NaN) rejeté, pas de throw, les autres events passent
// ---------------------------------------------------------------------------

for (const kind of BACKEND_KINDS) {
  test(`solo-store [${kind}] : 8. payload invalide (NaN) rejeté sans throw, les autres appliqués`, async () => {
    await withBackend(kind, async ({ makeBackend }) => {
      const store = createSoloStore({ backend: makeBackend() });

      const nextState = {
        ...emptySnapshot(),
        consultants: [consultant("c-1", "Alice")],
        saisies: [saisie("s-invalide", { consultantId: "c-1", dureeH: NaN })],
      };

      const result = await store.commit(nextState);
      assert.equal(result.applied.count, 1, "seul le consultant valide est écrit");
      assert.equal(result.applied.rejected.length, 1);
      assert.equal(result.applied.rejected[0].entityType, "saisies");
      assert.equal(result.applied.rejected[0].entityId, "s-invalide");
      assert.match(result.applied.rejected[0].reason, /non fini|NaN/i);

      // L'entité invalide n'apparaît nulle part dans l'état.
      assert.equal(result.state.saisies.length, 0);
      assert.equal(result.state.consultants.length, 1);

      const reloaded = await store.load();
      assert.equal(reloaded.state.saisies.length, 0);
      assert.equal(reloaded.state.consultants.length, 1);
    });
  });
}
