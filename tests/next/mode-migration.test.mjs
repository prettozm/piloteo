// tests/next/mode-migration.test.mjs
//
// Couvre docs/next/MIGRATION_MODE_CONTRACT.md §4 (scénarios 1-6) pour
// `src/integration/migration.js` (module PUR) : migration à la bascule de
// mode (solo -> Dossier/Organisation/Google Drive), Point 5. Réutilise les
// mêmes primitives que le reste de la suite next (EventLog, solo-store,
// org-runtime/org-engine, crypto-service) — rien n'est dupliqué, cf. en-tête
// de migration.js.
//
// Nommé `mode-migration.test.mjs` (et non `migration.test.mjs`, littéralement
// cité par le contrat) pour ne PAS entrer en collision avec le fichier de
// tests DÉJÀ EXISTANT (et sans rapport : import V1 -> Next,
// `src/migration/v1-import.js`, lot licence/import antérieur) qui porte ce
// nom — voir le rapport du maker pour la justification complète de cet écart.

import "fake-indexeddb/auto";

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  snapshotToSeedEvents,
  verifyRoundTrip,
  diffSnapshots,
  planMigration,
} from "../../src/integration/migration.js";
import { createIndexedDbEventBackend } from "../../src/integration/solo-store.js";
import { canonicalize } from "../../src/events/event-schema.js";
import { EventLog } from "../../src/events/event-log.js";

import { FolderStorageAdapter } from "../../src/storage/folder-storage-adapter.js";
import { NodeFsPort } from "../../src/storage/node-fs-port.js";
import { newMemberIdentity, createOrganization } from "../../src/workspace/org-runtime.js";
import { writeManifest, writeMemberRecord } from "../../src/workspace/org-folder-store.js";
import * as cryptoService from "../../src/crypto/crypto-service.js";
import { openOrgEngine } from "../../src/workspace/org-engine.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COLLECTIONS = [
  "consultants", "organisations", "affaires", "methodes", "typesTerritoire",
  "domainesIntervention", "categoriesFrais", "missions", "factures",
  "saisies", "bordereauxFrais", "notesFrais",
];

function emptySnapshot() {
  const s = {};
  for (const c of COLLECTIONS) s[c] = [];
  return s;
}

function consultant(id, nom) {
  return { id, nom, trigramme: nom.slice(0, 3).toUpperCase(), statut: "en poste", admin: false, tempsPartiel: [] };
}
function mission(id, consultantId) {
  return {
    id, consultantId, affaireId: "a-1", nom: "Mission " + id,
    statut: "en cours", enveloppe: 10, taux: 500,
  };
}
function saisie(id, consultantId) {
  return {
    id, date: "2026-08-30", consultantId, type: "interne", missionId: null,
    categorie: "adm", dureeH: 1, pctFact: 0, commentaire: "",
  };
}

function freshIdentity() {
  return { workspaceId: globalThis.crypto.randomUUID(), actorId: globalThis.crypto.randomUUID(), epoch: 1 };
}

let dbCounter = 0;
function freshDbName() {
  dbCounter += 1;
  return `piloteo-migration-test-${process.pid}-${Date.now()}-${dbCounter}`;
}

// ---------------------------------------------------------------------------
// 1. Snapshot réaliste (plusieurs collections) -> verifyRoundTrip OK
// ---------------------------------------------------------------------------

test("mode-migration : 1. snapshot réaliste (plusieurs collections) -> verifyRoundTrip OK", () => {
  const snapshot = {
    ...emptySnapshot(),
    consultants: [consultant("c-1", "Alice"), consultant("c-2", "Bob")],
    missions: [mission("m-1", "c-1")],
    saisies: [saisie("s-1", "c-1"), saisie("s-2", "c-2")],
  };
  const identity = freshIdentity();

  const { events, rejected } = snapshotToSeedEvents(snapshot, identity);
  assert.equal(rejected.length, 0, "aucune entité rejetée sur un snapshot valide");
  assert.equal(events.length, 5, "un event create par entité du snapshot");
  assert.ok(events.every((e) => e.operation === "create"), "diff depuis ∅ -> uniquement des create");
  assert.ok(events.every((e) => e.parentEventId === null), "aucun lineage antérieur (seed initial)");
  assert.ok(events.every((e) => e.workspaceId === identity.workspaceId && e.actorId === identity.actorId));

  const result = verifyRoundTrip(snapshot, events);
  assert.equal(result.ok, true, "round-trip OK : " + JSON.stringify(result.diff));
  assert.deepEqual(result.diff, []);
});

test("mode-migration : 1bis. déterminisme (même snapshot -> mêmes events au contenu près, pas au eventId)", () => {
  const snapshot = { ...emptySnapshot(), consultants: [consultant("c-1", "Alice")] };
  const identity = freshIdentity();

  const a = snapshotToSeedEvents(snapshot, identity);
  const b = snapshotToSeedEvents(snapshot, identity);
  assert.equal(a.events.length, b.events.length);
  // Contenu identique (entityType/entityId/operation/payload/baseVersion/epoch), eventId différent.
  for (let i = 0; i < a.events.length; i++) {
    assert.notEqual(a.events[i].eventId, b.events[i].eventId, "eventId toujours régénéré (UUID)");
    assert.equal(a.events[i].entityType, b.events[i].entityType);
    assert.equal(a.events[i].entityId, b.events[i].entityId);
    assert.equal(a.events[i].operation, b.events[i].operation);
    assert.deepEqual(a.events[i].payload, b.events[i].payload);
  }
});

// ---------------------------------------------------------------------------
// 2. Snapshot avec un "trou" (entité déjà supprimée avant migration) -> non
//    ré-injectée, round-trip OK.
// ---------------------------------------------------------------------------

test("mode-migration : 2. entité déjà supprimée (absente du snapshot) -> non ré-injectée, round-trip OK", () => {
  // c-2 a existé puis a été supprimée AVANT la migration : le snapshot solo
  // courant ne la porte plus (comme le rend `projectionToSnapshot`, qui
  // exclut les tombstones — cf. solo-store.js). Le jeu d'événements initial
  // ne doit donc jamais la recréer, ni laisser de trace fantôme.
  const snapshot = {
    ...emptySnapshot(),
    consultants: [consultant("c-1", "Alice"), consultant("c-3", "Carole")],
  };
  const identity = freshIdentity();

  const { events, rejected } = snapshotToSeedEvents(snapshot, identity);
  assert.equal(rejected.length, 0);
  assert.equal(events.length, 2, "seules c-1 et c-3 génèrent un event (c-2 n'a jamais existé pour ce diff)");
  assert.ok(events.every((e) => e.entityId !== "c-2"));

  const log = new EventLog(events);
  const rebuilt = log.replay();
  assert.equal(rebuilt.consultants["c-2"], undefined, "aucune trace (même tombstone) pour c-2 : jamais vue par le diff");

  const result = verifyRoundTrip(snapshot, events);
  assert.equal(result.ok, true, "round-trip OK malgré le trou dans l'espace d'identité : " + JSON.stringify(result.diff));
});

// ---------------------------------------------------------------------------
// 3. `rejected` non vide (clé réservée injectée) -> migration signalée en échec.
// ---------------------------------------------------------------------------

test("mode-migration : 3. entité avec clé réservée -> rejected non vide, migration signalée en échec", () => {
  const snapshot = {
    ...emptySnapshot(),
    consultants: [
      consultant("c-1", "Alice"),
      { id: "c-piege", nom: "Piégé", __deleted: true }, // clé réservée : interdite dans un payload métier
    ],
  };
  const identity = freshIdentity();

  const { events, rejected } = snapshotToSeedEvents(snapshot, identity);
  assert.equal(rejected.length, 1, "l'entité à clé réservée est rejetée explicitement");
  assert.equal(rejected[0].entityType, "consultants");
  assert.equal(rejected[0].entityId, "c-piege");
  assert.match(rejected[0].reason, /réservée|__deleted/i);
  assert.equal(events.length, 1, "seule l'entité valide produit un event");

  // Filet de sûreté : même si l'appelant ignorait `rejected`, `verifyRoundTrip`
  // contre le snapshot SOURCE (qui porte encore l'entité piégée) échoue —
  // l'état partiel n'est JAMAIS pris pour un succès silencieux (contrat §1).
  const result = verifyRoundTrip(snapshot, events);
  assert.equal(result.ok, false, "round-trip refusé : l'entité rejetée manque dans la cible rejouée");
  assert.ok(result.diff.some((d) => d.entityId === "c-piege"));
});

// ---------------------------------------------------------------------------
// 4. Idempotence : appliquer deux fois les mêmes seed events dans un store
//    neuf (backend write-once) -> une seule occurrence par entité, projection
//    identique. Simule une migration interrompue puis relancée (contrat §2.6).
// ---------------------------------------------------------------------------

test("mode-migration : 4. idempotence — seed events appliqués deux fois dans un backend neuf -> dédup, projection identique", async () => {
  const snapshot = {
    ...emptySnapshot(),
    consultants: [consultant("c-1", "Alice"), consultant("c-2", "Bob")],
    saisies: [saisie("s-1", "c-1")],
  };
  const identity = freshIdentity();
  const { events, rejected } = snapshotToSeedEvents(snapshot, identity);
  assert.equal(rejected.length, 0);

  const backend = createIndexedDbEventBackend({ indexedDB: globalThis.indexedDB, dbName: freshDbName() });
  await backend.init();

  // 1re "tentative" de migration : écrit tous les events.
  for (const e of events) await backend.appendEvent(e);
  const afterFirst = await backend.listEvents();
  assert.equal(afterFirst.length, events.length);

  // Migration RELANCÉE (ex: coupée puis reprise) : ré-écrit LES MÊMES events
  // (mêmes eventId, calculés une seule fois ci-dessus) -> write-once, no-op.
  for (const e of events) await backend.appendEvent(e);
  const afterSecond = await backend.listEvents();
  assert.equal(afterSecond.length, events.length, "aucun doublon après ré-application (dédup par eventId)");

  const result = verifyRoundTrip(snapshot, afterSecond);
  assert.equal(result.ok, true, "projection après double application == snapshot source");
});

// ---------------------------------------------------------------------------
// 5. planMigration : solo vide -> nothing-to-migrate ; cible non vide ->
//    target-not-empty ; sinon seed avec les bons compteurs.
// ---------------------------------------------------------------------------

test("mode-migration : 5. planMigration — solo vide -> nothing-to-migrate", () => {
  const plan = planMigration({ soloSnapshot: emptySnapshot(), targetExisting: null });
  assert.equal(plan.kind, "nothing-to-migrate");
  assert.equal(plan.counts.total, 0);
});

test("mode-migration : 5. planMigration — cible déjà peuplée (étrangère) -> target-not-empty (jamais d'écrasement)", () => {
  const solo = { ...emptySnapshot(), consultants: [consultant("c-1", "Alice")] };
  const target = { ...emptySnapshot(), consultants: [consultant("c-x", "Déjà là")] };
  const plan = planMigration({ soloSnapshot: solo, targetExisting: target });
  assert.equal(plan.kind, "target-not-empty");
});

test("mode-migration : 5. planMigration — solo non vide, cible vide -> seed, compteurs corrects", () => {
  const solo = {
    ...emptySnapshot(),
    consultants: [consultant("c-1", "Alice"), consultant("c-2", "Bob")],
    missions: [mission("m-1", "c-1")],
  };
  const plan = planMigration({ soloSnapshot: solo, targetExisting: null });
  assert.equal(plan.kind, "seed");
  assert.equal(plan.counts.total, 3);
  assert.equal(plan.counts.byEntityType.consultants, 2);
  assert.equal(plan.counts.byEntityType.missions, 1);
  assert.equal(plan.counts.byEntityType.saisies, 0);

  // Cible EXPLICITEMENT vide (toutes collections vides mais objet fourni) -> seed aussi.
  const plan2 = planMigration({ soloSnapshot: solo, targetExisting: emptySnapshot() });
  assert.equal(plan2.kind, "seed");
});

test("mode-migration : 5. planMigration — cible = sous-ensemble cohérent du solo (migration coupée) -> seed (reprise), pas target-not-empty", () => {
  // Contrat §2 point 6 : une migration COUPÉE en cours de route laisse un
  // journal PARTIEL sur la cible (ex: consultants déjà écrits, saisies pas
  // encore) — une nouvelle tentative doit RESSAISIR (idempotent), jamais être
  // refusée comme si la cible portait des données étrangères.
  const solo = {
    ...emptySnapshot(),
    consultants: [consultant("c-1", "Alice"), consultant("c-2", "Bob")],
    saisies: [saisie("s-1", "c-1")],
  };
  const partialTarget = { ...emptySnapshot(), consultants: [consultant("c-1", "Alice")] };
  const plan = planMigration({ soloSnapshot: solo, targetExisting: partialTarget });
  assert.equal(plan.kind, "seed", "sous-ensemble cohérent -> reprise, pas un refus");
  assert.equal(plan.counts.total, 3);
});

test("mode-migration : 5. planMigration — cible avec une entité DIVERGENTE (même id, contenu différent) -> target-not-empty", () => {
  const solo = { ...emptySnapshot(), consultants: [consultant("c-1", "Alice")] };
  const divergentTarget = { ...emptySnapshot(), consultants: [{ ...consultant("c-1", "Alice"), nom: "Quelqu'un d'autre" }] };
  const plan = planMigration({ soloSnapshot: solo, targetExisting: divergentTarget });
  assert.equal(plan.kind, "target-not-empty", "contenu divergent sur le même id -> jamais un mélange silencieux");
});

// diffSnapshots : sanity directe (utilisé en interne par verifyRoundTrip, et
// exposé pour comparer un snapshot solo à l'état RÉEL rechargé d'une cible
// déjà écrite, cf. en-tête de migration.js décision 2).
test("mode-migration : diffSnapshots — ensembliste, ordre ignoré, détecte un écart réel", () => {
  const a = { ...emptySnapshot(), consultants: [consultant("c-1", "Alice"), consultant("c-2", "Bob")] };
  const bSameOrderDifferent = { ...emptySnapshot(), consultants: [consultant("c-2", "Bob"), consultant("c-1", "Alice")] };
  assert.deepEqual(diffSnapshots(a, bSameOrderDifferent), [], "ordre ignoré");

  const cMissing = { ...emptySnapshot(), consultants: [consultant("c-1", "Alice")] };
  const diff = diffSnapshots(a, cMissing);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].entityId, "c-2");
});

// ---------------------------------------------------------------------------
// 6. Mode org : seed events signés -> verifyRoundTrip OK et signatures valides
//    (réutilise org-engine.js#openOrgEngine, jamais reconstruit ici).
// ---------------------------------------------------------------------------

test("mode-migration : 6. mode org — seed via engine.commit() -> events signés, verifyRoundTrip OK, signatures valides", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-migration-org-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "migration-org-test" });
    await adapter.connect();

    const aliceIdentity = await newMemberIdentity();
    const org = createOrganization({ name: "Cabinet Migration", identity: aliceIdentity, consultantId: "c-alice" });
    await writeManifest(adapter, org.manifest);
    await writeMemberRecord(adapter, org.memberRecord);

    const engine = await openOrgEngine({ adapter, identity: aliceIdentity, consultantId: "c-alice" });

    // État solo à migrer (plusieurs collections, comme un vrai appareil).
    const soloSnapshot = {
      ...emptySnapshot(),
      consultants: [consultant("c-alice", "Alice"), consultant("c-bob", "Bob")],
      missions: [mission("m-1", "c-alice")],
      saisies: [saisie("s-1", "c-alice"), saisie("s-2", "c-bob")],
    };

    // Sanity préalable (pure, sans E/S) : les seed events calculés round-trip
    // correctement AVANT même d'écrire quoi que ce soit sur le dossier.
    const identityForSeed = { workspaceId: org.workspace.workspaceId, actorId: aliceIdentity.memberId, epoch: 1 };
    const seed = snapshotToSeedEvents(soloSnapshot, identityForSeed);
    assert.equal(seed.rejected.length, 0);
    assert.equal(verifyRoundTrip(soloSnapshot, seed.events).ok, true, "pré-vérification pure OK");

    // Écriture RÉELLE via l'engine org existant (signe + publie sur le dossier
    // — jamais reconstruit ici, cf. org-engine.js#commit).
    const commitResult = await engine.commit(soloSnapshot);
    assert.equal(commitResult.ok, true, "commit sur l'org fraîchement créée accepté (owner, aucune concurrence)");
    assert.equal(commitResult.applied.count, 5);
    assert.equal(commitResult.applied.rejected.length, 0);

    // Relit les events RÉELLEMENT écrits sur le dossier (signés) — jamais les
    // seed events "locaux" calculés ci-dessus (eventId/signature différents).
    const { changes } = await adapter.listChanges();
    const storedEvents = [];
    for (const change of changes) {
      if (change.kind !== "event") continue;
      storedEvents.push(await adapter.get("event", change.id));
    }
    assert.equal(storedEvents.length, 5, "5 events réellement publiés sur le dossier");
    assert.ok(storedEvents.every((e) => typeof e.signature === "string" && e.signature.length > 0), "chaque event est signé");

    // Garde de sûreté du contrat §1 : round-trip contre le snapshot SOURCE.
    const roundTrip = verifyRoundTrip(soloSnapshot, storedEvents);
    assert.equal(roundTrip.ok, true, "verifyRoundTrip OK sur les events réellement publiés : " + JSON.stringify(roundTrip.diff));

    // Signatures valides (réutilise crypto-service.verify — jamais réimplémenté).
    for (const event of storedEvents) {
      assert.equal(event.actorId, aliceIdentity.memberId, "seul membre écrivain de ce test");
      const valid = await cryptoService.verify(aliceIdentity.publicKeyJwk, canonicalize(event), event.signature);
      assert.equal(valid, true, `signature invalide pour l'event ${event.eventId}`);
    }

    // La projection de l'engine (rechargée) est elle-même identique au snapshot
    // solo source — c'est ce que l'orchestration (local-backend.js) compare
    // réellement avant de basculer `piloteo_storage_mode` (§2 point 4).
    const reloaded = await engine.load();
    assert.deepEqual(diffSnapshots(soloSnapshot, reloaded.state), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
