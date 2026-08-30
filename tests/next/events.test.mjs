// tests/next/events.test.mjs
//
// Couvre docs/next/07_TESTS_ET_RECETTE.md §4 (EventLog), §6 (validation
// structurelle), §7 (concurrence), pour le moteur événementiel de
// src/events/*. `node:test`, aucune dépendance npm requise pour ces tests
// (fake-indexeddb du package.json sert à d'autres modules, pas à celui-ci).

import test from "node:test";
import assert from "node:assert/strict";

import { buildEvent, canonicalize, isWellFormedEnvelope, ENTITY_TYPES } from "../../src/events/event-schema.js";
import { validateEnvelope, validatePayload, MAX_PAYLOAD_BYTES } from "../../src/events/validation.js";
import { initialProjection, reduce } from "../../src/events/reducer.js";
import { classify } from "../../src/events/conflict.js";
import { EventLog } from "../../src/events/event-log.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACTOR_BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeSaisieEvent({ entityId, baseVersion = 0, actorId = ACTOR_ALICE, operation = "create", payload } = {}) {
  return buildEvent({
    workspaceId: WORKSPACE_ID,
    entityType: "saisies",
    entityId,
    operation,
    actorId,
    baseVersion,
    epoch: 1,
    payload:
      payload !== undefined
        ? payload
        : {
            id: entityId,
            date: "2026-08-30",
            consultantId: "cns-1",
            type: "interne",
            missionId: null,
            categorie: "adm",
            dureeH: 7,
            pctFact: 0,
            commentaire: "",
          },
  });
}

// ---------------------------------------------------------------------------
// event-schema.js
// ---------------------------------------------------------------------------

test("event-schema: ENTITY_TYPES liste les 12 collections avec leur clé d'identité", () => {
  assert.equal(Object.keys(ENTITY_TYPES).length, 12);
  assert.equal(ENTITY_TYPES.bordereauxFrais, "numero");
  assert.equal(ENTITY_TYPES.saisies, "id");
  assert.equal(ENTITY_TYPES.notesFrais, "id");
});

test("event-schema: buildEvent produit une enveloppe bien formée sans signature/ciphertext", () => {
  const event = makeSaisieEvent({ entityId: "s-1" });
  assert.equal(isWellFormedEnvelope(event), true);
  assert.equal(event.signature, undefined);
  assert.equal(event.ciphertext, undefined);
  assert.equal(event.version, 1);
  assert.equal(typeof event.eventId, "string");
});

test("event-schema: canonicalize est déterministe indépendamment de l'ordre des clés", () => {
  const eventA = { b: 1, a: { z: 1, y: 2 }, workspaceId: WORKSPACE_ID };
  const eventB = { a: { y: 2, z: 1 }, workspaceId: WORKSPACE_ID, b: 1 };
  const bytesA = canonicalize(eventA);
  const bytesB = canonicalize(eventB);
  assert.deepEqual(Array.from(bytesA), Array.from(bytesB));
});

test("event-schema: canonicalize exclut signature mais inclut le reste", () => {
  const event = { a: 1, signature: "sig-xyz" };
  const bytes = canonicalize(event);
  const text = new TextDecoder().decode(bytes);
  assert.equal(text.includes("sig-xyz"), false);
  assert.equal(text.includes('"a":1'), true);
});

test("event-schema: canonicalize refuse NaN/Infinity", () => {
  assert.throws(() => canonicalize({ a: NaN }));
  assert.throws(() => canonicalize({ a: Infinity }));
  assert.throws(() => canonicalize({ a: -Infinity }));
});

test("event-schema: isWellFormedEnvelope rejette une enveloppe incomplète", () => {
  assert.equal(isWellFormedEnvelope(null), false);
  assert.equal(isWellFormedEnvelope({}), false);
  const event = makeSaisieEvent({ entityId: "s-1" });
  const { workspaceId, ...withoutWorkspace } = event;
  assert.equal(isWellFormedEnvelope(withoutWorkspace), false);
});

// ---------------------------------------------------------------------------
// validation.js — enveloppe (événement inconnu / schema version incompatible)
// ---------------------------------------------------------------------------

test("validation: validateEnvelope accepte une enveloppe correcte", () => {
  const event = makeSaisieEvent({ entityId: "s-1" });
  assert.deepEqual(validateEnvelope(event), { ok: true });
});

test("validation: validateEnvelope rejette une version de schéma incompatible", () => {
  const event = { ...makeSaisieEvent({ entityId: "s-1" }), version: 2 };
  const result = validateEnvelope(event);
  assert.equal(result.ok, false);
  assert.match(result.reason, /version/i);
});

test("validation: validateEnvelope rejette un entityType inconnu", () => {
  const event = { ...makeSaisieEvent({ entityId: "s-1" }), entityType: "entiteInconnue" };
  const result = validateEnvelope(event);
  assert.equal(result.ok, false);
  assert.match(result.reason, /entityType/i);
});

// ---------------------------------------------------------------------------
// validation.js — validatePayload (§6 : NaN/Infinity/type/enum/date/taille/refs)
// ---------------------------------------------------------------------------

function saisieValide(overrides = {}) {
  return {
    id: "s-1",
    date: "2026-08-30",
    consultantId: "cns-1",
    type: "interne",
    missionId: null,
    categorie: "adm",
    dureeH: 7,
    pctFact: 50,
    commentaire: "ok",
    ...overrides,
  };
}

test("validation: accepte un payload saisies valide", () => {
  assert.deepEqual(validatePayload("saisies", "create", saisieValide()), { ok: true });
});

test("validation: refuse NaN dans le payload", () => {
  const result = validatePayload("saisies", "create", saisieValide({ dureeH: NaN }));
  assert.equal(result.ok, false);
});

test("validation: refuse Infinity/-Infinity dans le payload, y compris imbriqué", () => {
  assert.equal(validatePayload("saisies", "create", saisieValide({ dureeH: Infinity })).ok, false);
  assert.equal(validatePayload("saisies", "create", saisieValide({ dureeH: -Infinity })).ok, false);
  const nested = validatePayload(
    "notesFrais",
    "create",
    {
      id: "nf-1",
      date: "2026-08-30",
      consultantId: "cns-1",
      affaireId: null,
      categorieTempsInterne: "adm",
      categorieFraisId: "cat-1",
      refacturable: false,
      numeroBordereau: "FRAIS_ABC_2026_001",
      lignesTVA: [{ tauxTVA: 20, montantHT: 100, montantTVA: NaN }],
      commentaire: "",
    },
  );
  assert.equal(nested.ok, false);
});

test("validation: refuse une chaîne à la place d'un nombre", () => {
  const result = validatePayload("saisies", "create", saisieValide({ dureeH: "7" }));
  assert.equal(result.ok, false);
});

test("validation: refuse un objet à la place d'une date", () => {
  const result = validatePayload("saisies", "create", saisieValide({ date: {} }));
  assert.equal(result.ok, false);
});

test("validation: refuse une date invalide", () => {
  const result = validatePayload("saisies", "create", saisieValide({ date: "pas-une-date" }));
  assert.equal(result.ok, false);
});

test("validation: refuse un enum inconnu", () => {
  const result = validatePayload("saisies", "create", saisieValide({ type: "vacances" }));
  assert.equal(result.ok, false);

  const affaire = {
    id: "a-1",
    nom: "Affaire test",
    organisationId: "org-1",
    statut: "statut-inexistant",
  };
  assert.equal(validatePayload("affaires", "create", affaire).ok, false);
});

test("validation: refuse un payload géant (> MAX_PAYLOAD_BYTES)", () => {
  const enormeCommentaire = "x".repeat(MAX_PAYLOAD_BYTES + 1024);
  const result = validatePayload("saisies", "create", saisieValide({ commentaire: enormeCommentaire }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /taille/i);
});

test("validation: refuse une référence vers un workspaceId étranger", () => {
  const result = validatePayload("saisies", "create", { ...saisieValide(), workspaceId: OTHER_WORKSPACE_ID }, {
    refs: { workspaceId: WORKSPACE_ID },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /workspace/i);
});

test("validation: refuse une référence inexistante (missionId hors ensemble connu)", () => {
  const result = validatePayload(
    "saisies",
    "create",
    saisieValide({ type: "mission", missionId: "m-inconnue" }),
    { refs: { missions: new Set(["m-connue"]) } },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /référence inexistante/i);
});

test("validation: id manquant/mal formé rejeté", () => {
  assert.equal(validatePayload("saisies", "create", saisieValide({ id: "" })).ok, false);
  assert.equal(validatePayload("saisies", "create", saisieValide({ id: undefined })).ok, false);
});

test("validation: bordereauxFrais/missions/affaires/notesFrais valides passent", () => {
  assert.equal(
    validatePayload("bordereauxFrais", "create", {
      numero: "FRAIS_ABC_2026_001",
      consultantId: "cns-1",
      annee: 2026,
      seq: 1,
      statut: "en saisie",
      datePaiement: null,
    }).ok,
    true,
  );
  assert.equal(
    validatePayload("missions", "create", {
      id: "m-1",
      affaireId: "a-1",
      nom: "Mission test",
      consultantId: "cns-1",
      statut: "en cours",
      enveloppe: 20,
      taux: 500,
      dateDebut: "2026-01-01",
      dateFin: "2026-12-31",
      commentaires: "",
      projectionManuelle: { "2026-08": 5 },
    }).ok,
    true,
  );
});

test("validation: entityType générique exige un id bien formé", () => {
  assert.equal(validatePayload("consultants", "create", { id: "c-1", nom: "X" }).ok, true);
  assert.equal(validatePayload("consultants", "create", { nom: "X" }).ok, false);
});

// ---------------------------------------------------------------------------
// reducer.js
// ---------------------------------------------------------------------------

test("reducer: reduce est pur (ne mute pas la projection d'entrée)", () => {
  const before = initialProjection();
  const frozenBefore = JSON.parse(JSON.stringify(before));
  const event = makeSaisieEvent({ entityId: "s-1" });
  const after = reduce(before, event, event.payload);
  assert.deepEqual(before, frozenBefore);
  assert.notEqual(after, before);
  assert.equal(after.saisies["s-1"].dureeH, 7);
  assert.equal(after.__versions.saisies["s-1"].version, 1);
});

test("reducer: delete pose un tombstone et conserve la version", () => {
  let projection = initialProjection();
  const created = makeSaisieEvent({ entityId: "s-1", baseVersion: 0 });
  projection = reduce(projection, created, created.payload);

  const deleted = makeSaisieEvent({ entityId: "s-1", baseVersion: 1, operation: "delete", payload: null });
  const afterDelete = reduce(projection, deleted, null);

  assert.equal(afterDelete.saisies["s-1"].__deleted, true);
  assert.equal(afterDelete.saisies["s-1"].dureeH, 7); // champs métier conservés dans le tombstone
  assert.equal(afterDelete.__versions.saisies["s-1"].version, 2);
});

// ---------------------------------------------------------------------------
// conflict.js
// ---------------------------------------------------------------------------

test("conflict: apply/duplicate/conflict — logique de base", () => {
  const event = makeSaisieEvent({ entityId: "s-1", baseVersion: 0 });
  assert.equal(classify(undefined, event), "apply");
  assert.equal(classify({ version: 0, lastEventId: null }, event), "apply");
  assert.equal(classify({ version: 1, lastEventId: event.eventId }, event), "duplicate");
  assert.equal(classify({ version: 1, lastEventId: "autre-event-id" }, event), "conflict");
});

// ---------------------------------------------------------------------------
// EventLog — §4 : événement unique, doublon, replay, rebuild, ordre, inconnu
// ---------------------------------------------------------------------------

test("EventLog: événement unique -> apparaît dans la projection", () => {
  const log = new EventLog();
  const event = makeSaisieEvent({ entityId: "s-1" });
  log.append(event);
  const projection = log.replay();
  assert.equal(projection.saisies["s-1"].consultantId, "cns-1");
  assert.equal(projection.__versions.saisies["s-1"].version, 1);
});

test("EventLog: doublon (même eventId) est idempotent", () => {
  const log = new EventLog();
  const event = makeSaisieEvent({ entityId: "s-1" });
  const first = log.append(event);
  const second = log.append(event);
  assert.equal(first.appended, true);
  assert.equal(second.appended, false);
  assert.equal(second.duplicate, true);
  assert.equal(log.size(), 1);
  const projection = log.replay();
  assert.equal(projection.__versions.saisies["s-1"].version, 1);
});

test("EventLog: replay reconstruit la projection depuis une séquence create+update", () => {
  const log = new EventLog();
  const created = makeSaisieEvent({ entityId: "s-1", baseVersion: 0 });
  log.append(created);
  const updated = makeSaisieEvent({
    entityId: "s-1",
    baseVersion: 1,
    operation: "update",
    payload: { ...created.payload, dureeH: 3.5 },
  });
  log.append(updated);

  const projection = log.replay();
  assert.equal(projection.saisies["s-1"].dureeH, 3.5);
  assert.equal(projection.__versions.saisies["s-1"].version, 2);
});

test("EventLog: destruction de la projection puis rebuild -> résultat identique", () => {
  const log = new EventLog();
  log.append(makeSaisieEvent({ entityId: "s-1", baseVersion: 0 }));
  log.append(makeSaisieEvent({ entityId: "s-2", baseVersion: 0, payload: saisieValide({ id: "s-2", dureeH: 2 }) }));

  const projection1 = log.replay();
  // "destruction" simulée : on ne garde aucune référence à projection1, on
  // reconstruit entièrement depuis le journal seul.
  const projection2 = log.replay();

  assert.deepEqual(projection1, projection2);
});

test("EventLog: ordre de réception différent => même projection (invariant clé)", () => {
  const e1 = makeSaisieEvent({ entityId: "s-1", baseVersion: 0 });
  const e2 = makeSaisieEvent({
    entityId: "s-1",
    baseVersion: 1,
    operation: "update",
    payload: { ...e1.payload, dureeH: 4 },
  });
  const e3 = makeSaisieEvent({ entityId: "s-2", baseVersion: 0, payload: saisieValide({ id: "s-2", dureeH: 9 }) });

  const logA = new EventLog();
  logA.append(e1);
  logA.append(e2);
  logA.append(e3);

  const logB = new EventLog();
  logB.append(e3);
  logB.append(e2);
  logB.append(e1);

  const logC = new EventLog();
  logC.append(e2);
  logC.append(e1);
  logC.append(e3);

  const projA = logA.replay();
  const projB = logB.replay();
  const projC = logC.replay();

  assert.deepEqual(projA, projB);
  assert.deepEqual(projA, projC);
  assert.equal(projA.saisies["s-1"].dureeH, 4);
  assert.equal(projA.saisies["s-2"].dureeH, 9);
});

test("EventLog: rebuildInto pousse la projection dans un store minimal", () => {
  const log = new EventLog();
  log.append(makeSaisieEvent({ entityId: "s-1" }));

  const store = {};
  const projection = log.rebuildInto(store);
  assert.equal(store.projection, projection);

  let received = null;
  const storeWithApi = { replaceProjection(p) { received = p; } };
  const projection2 = log.rebuildInto(storeWithApi);
  assert.equal(received, projection2);
  assert.equal(received.saisies["s-1"].dureeH, 7);
});

// ---------------------------------------------------------------------------
// Concurrence — §7 : entités différentes (convergence) / même entité (conflit)
// ---------------------------------------------------------------------------

test("concurrence: entités différentes => convergence (Alice modifie A, Bob modifie B)", () => {
  const log = new EventLog();
  const eventA = makeSaisieEvent({ entityId: "A", baseVersion: 0, actorId: ACTOR_ALICE });
  const eventB = makeSaisieEvent({ entityId: "B", baseVersion: 0, actorId: ACTOR_BOB, payload: saisieValide({ id: "B", dureeH: 1 }) });

  log.append(eventA);
  log.append(eventB);
  const projection = log.replay();

  assert.ok(projection.saisies["A"]);
  assert.ok(projection.saisies["B"]);
  assert.equal(projection.__conflicts, undefined);
});

test("concurrence: même entité, même base, deux acteurs => un apply, un conflict, aucun écrasement", () => {
  const log = new EventLog();
  const base = makeSaisieEvent({ entityId: "M1", baseVersion: 0, actorId: ACTOR_ALICE });
  log.append(base);

  const projectionAfterCreate = log.replay();
  assert.equal(projectionAfterCreate.__versions.saisies["M1"].version, 1);

  // Alice et Bob éditent tous les deux sur la base "version 1".
  const aliceEdit = makeSaisieEvent({
    entityId: "M1",
    baseVersion: 1,
    actorId: ACTOR_ALICE,
    operation: "update",
    payload: { ...base.payload, commentaire: "édité par Alice" },
  });
  const bobEdit = makeSaisieEvent({
    entityId: "M1",
    baseVersion: 1,
    actorId: ACTOR_BOB,
    operation: "update",
    payload: { ...base.payload, commentaire: "édité par Bob" },
  });

  log.append(aliceEdit);
  log.append(bobEdit);

  const projection = log.replay();

  // Un seul des deux a été appliqué (celui traité en premier dans l'ordre
  // déterministe createdAt puis eventId), l'autre est un conflit conservé,
  // jamais un écrasement silencieux du gagnant.
  const winnerComment = projection.saisies["M1"].commentaire;
  assert.ok(["édité par Alice", "édité par Bob"].includes(winnerComment));
  assert.equal(projection.__versions.saisies["M1"].version, 2);

  assert.ok(Array.isArray(projection.__conflicts));
  assert.equal(projection.__conflicts.length, 1);
  const conflictEventId = projection.__conflicts[0].eventId;
  const loser = conflictEventId === aliceEdit.eventId ? aliceEdit : bobEdit;
  const winnerEventId = loser === aliceEdit ? bobEdit.eventId : aliceEdit.eventId;
  assert.equal(projection.__versions.saisies["M1"].lastEventId, winnerEventId);

  // Directement via classify aussi, en rejouant la même séquence que EventLog :
  // le gagnant est "apply" sur l'état de base (version 1), puis, une fois son
  // eventId devenu `lastEventId` sur la version résultante (2), le perdant
  // (toujours baseVersion=1) devient "conflict" — jamais deux "apply".
  const winnerEdit = winnerEventId === aliceEdit.eventId ? aliceEdit : bobEdit;
  const stateAtVersion1 = { version: 1, lastEventId: base.eventId };
  assert.equal(classify(stateAtVersion1, winnerEdit), "apply");
  const stateAfterWinner = { version: 2, lastEventId: winnerEventId };
  assert.equal(classify(stateAfterWinner, loser), "conflict");
});
