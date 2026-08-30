// tests/next/integration.test.mjs
//
// Couvre src/integration/localstore-bridge.js (docs/next/03 Phase 1,
// docs/next/01 §4 écran de démarrage) : round-trip mirrorServerState /
// loadMirroredState via un vrai LocalStore (IndexedDB fourni par
// fake-indexeddb hors navigateur), les 3 chemins de chooseStartMode +
// entrée invalide, et la preuve que le pont n'écrit rien tant qu'il n'est
// pas explicitement appelé (inertie par défaut).
//
// `node:test` ; `fake-indexeddb/auto` importé AVANT tout import de
// src/storage/local-store.js (voir tests/next/local-store.test.mjs pour le
// même motif).

import "fake-indexeddb/auto";

import test from "node:test";
import assert from "node:assert/strict";

import { LocalStore } from "../../src/storage/local-store.js";
import {
  mirrorServerState,
  loadMirroredState,
  chooseStartMode,
  START_MODES,
} from "../../src/integration/localstore-bridge.js";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";

let dbCounter = 0;
function freshDbName() {
  dbCounter += 1;
  return `piloteo-bridge-test-${process.pid}-${Date.now()}-${dbCounter}`;
}

function sampleServerState(overrides = {}) {
  return {
    consultants: [{ id: "c1", nom: "Alice", trigramme: "ALI" }],
    organisations: [],
    affaires: [],
    methodes: [],
    typesTerritoire: [],
    domainesIntervention: [],
    categoriesFrais: [],
    missions: [],
    factures: [],
    saisies: [],
    bordereauxFrais: [],
    notesFrais: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// mirrorServerState / loadMirroredState — round-trip
// ---------------------------------------------------------------------------

test("mirrorServerState puis loadMirroredState restituent la même projection", async () => {
  const store = await LocalStore.open(freshDbName());
  try {
    const state = sampleServerState();

    const before = await loadMirroredState(store, WORKSPACE_A);
    assert.equal(before, null, "aucune projection avant le premier miroir");

    const result = await mirrorServerState(store, WORKSPACE_A, state);
    assert.deepEqual(result, { mirrored: true, workspaceId: WORKSPACE_A });

    const after = await loadMirroredState(store, WORKSPACE_A);
    assert.deepEqual(after, state);
  } finally {
    store.close();
  }
});

test("mirrorServerState remplace la projection précédente (pas de fusion)", async () => {
  const store = await LocalStore.open(freshDbName());
  try {
    await mirrorServerState(store, WORKSPACE_A, sampleServerState({ consultants: [{ id: "c1" }] }));
    await mirrorServerState(store, WORKSPACE_A, sampleServerState({ consultants: [{ id: "c2" }] }));

    const final = await loadMirroredState(store, WORKSPACE_A);
    assert.deepEqual(final.consultants, [{ id: "c2" }]);
  } finally {
    store.close();
  }
});

test("isolation stricte entre workspaces", async () => {
  const store = await LocalStore.open(freshDbName());
  try {
    await mirrorServerState(store, WORKSPACE_A, sampleServerState({ consultants: [{ id: "only-a" }] }));
    const stateB = await loadMirroredState(store, WORKSPACE_B);
    assert.equal(stateB, null, "workspace B non affecté par le miroir de A");
  } finally {
    store.close();
  }
});

test("mirrorServerState/loadMirroredState valident leurs arguments", async () => {
  const store = await LocalStore.open(freshDbName());
  try {
    await assert.rejects(() => mirrorServerState(store, "", sampleServerState()), TypeError);
    await assert.rejects(() => mirrorServerState(null, WORKSPACE_A, sampleServerState()), TypeError);
    await assert.rejects(() => mirrorServerState(store, WORKSPACE_A, undefined), TypeError);
    await assert.rejects(() => loadMirroredState(store, ""), TypeError);
    await assert.rejects(() => loadMirroredState({}, WORKSPACE_A), TypeError);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// chooseStartMode — 3 chemins + entrée invalide
// ---------------------------------------------------------------------------

test("chooseStartMode: create/join/solo", () => {
  assert.equal(chooseStartMode({ intent: "create" }), "create");
  assert.equal(chooseStartMode({ intent: "join" }), "join");
  assert.equal(chooseStartMode({ intent: "solo" }), "solo");
  assert.deepEqual(START_MODES, ["create", "join", "solo"]);
});

test("chooseStartMode: un invitationCode force 'join' même si intent diffère", () => {
  assert.equal(chooseStartMode({ invitationCode: "ABC-123" }), "join");
  assert.equal(chooseStartMode({ intent: "solo", invitationCode: "ABC-123" }), "join");
  assert.equal(chooseStartMode({ intent: "create", invitationCode: "  " }), "create", "code blanc ignoré");
});

test("chooseStartMode: entrée invalide lève TypeError, jamais de mode par défaut silencieux", () => {
  assert.throws(() => chooseStartMode(undefined), TypeError);
  assert.throws(() => chooseStartMode(null), TypeError);
  assert.throws(() => chooseStartMode("solo"), TypeError, "une chaîne nue n'est pas le contrat attendu");
  assert.throws(() => chooseStartMode([]), TypeError);
  assert.throws(() => chooseStartMode({}), TypeError);
  assert.throws(() => chooseStartMode({ intent: "delete-everything" }), TypeError);
});

// ---------------------------------------------------------------------------
// Inertie par défaut : importer le module ne doit rien écrire tant qu'aucune
// fonction n'est appelée.
// ---------------------------------------------------------------------------

test("le pont est inerte tant qu'il n'est pas invoqué (aucune écriture implicite)", async () => {
  const store = await LocalStore.open(freshDbName());
  try {
    // Le seul fait d'avoir importé mirrorServerState/loadMirroredState/
    // chooseStartMode en tête de fichier n'a rien écrit : la projection reste
    // absente jusqu'au premier appel explicite.
    const state = await loadMirroredState(store, WORKSPACE_A);
    assert.equal(state, null);
    const allProjections = await store.getAll("projections");
    assert.deepEqual(allProjections, []);
  } finally {
    store.close();
  }
});
