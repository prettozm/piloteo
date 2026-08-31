// tests/next/lineage.test.mjs
//
// Régression P0.1 (audit — causalité des événements).
//
// Défaut corrigé : `baseVersion` seul ne suffit pas à ordonner deux branches
// concurrentes. Scénario exact de l'audit :
//
//   version 1
//   Alice -> A(baseVersion=1)      (gagne)
//   Bob   -> B(baseVersion=1)      (devient conflit)
//   Bob   -> B2(baseVersion=2, parent=B)   descend d'une branche PERDANTE
//
// Avant correction, B2 pouvait devenir l'état officiel : sa `baseVersion=2`
// coïncide avec la version produite par A, alors même que B2 est bâti sur B.
// Après correction, chaque événement porte `parentEventId` (l'ascendance réelle)
// et `conflict.js#classify` exige `event.parentEventId === current.lastEventId`.
//
// Test pur : EventLog + reducer + classify, sans crypto ni réseau. On contrôle
// `createdAt` pour rendre le vainqueur de la concurrence déterministe (A avant B).

import test from "node:test";
import assert from "node:assert/strict";

import { EventLog } from "../../src/events/event-log.js";
import { buildEvent } from "../../src/events/event-schema.js";
import { classify } from "../../src/events/conflict.js";

const WS = globalThis.crypto.randomUUID();
const ACTOR_A = globalThis.crypto.randomUUID();
const ACTOR_B = globalThis.crypto.randomUUID();

function mk({ operation = "update", baseVersion, parentEventId, payload, actorId, createdAt }) {
  const e = buildEvent({
    workspaceId: WS,
    entityType: "saisies",
    entityId: "sL",
    operation,
    actorId,
    baseVersion,
    epoch: 1,
    payload,
    parentEventId,
  });
  if (createdAt) e.createdAt = createdAt; // ordre de concurrence déterministe
  return e;
}

test("P0.1 lineage : un descendant d'une branche perdante ne devient jamais l'état officiel", () => {
  // Entité amenée à la version 1 par une création E0.
  const E0 = mk({
    operation: "create", baseVersion: 0, parentEventId: null, actorId: ACTOR_A,
    payload: { id: "sL", state: "v1" }, createdAt: "2026-01-01T00:00:00.000Z",
  });
  // Deux updates concurrents sur la même base (version 1), même parent E0.
  const A = mk({
    baseVersion: 1, parentEventId: E0.eventId, actorId: ACTOR_A,
    payload: { id: "sL", state: "A-gagnant" }, createdAt: "2026-01-02T00:00:00.000Z",
  });
  const B = mk({
    baseVersion: 1, parentEventId: E0.eventId, actorId: ACTOR_B,
    payload: { id: "sL", state: "B-perdant" }, createdAt: "2026-01-03T00:00:00.000Z",
  });
  // B2 descend de B (la branche perdante), avec baseVersion=2 qui coïncide avec
  // la version produite par A — c'est précisément le piège.
  const B2 = mk({
    baseVersion: 2, parentEventId: B.eventId, actorId: ACTOR_B,
    payload: { id: "sL", state: "B2-descendant-du-perdant" }, createdAt: "2026-01-04T00:00:00.000Z",
  });

  // Insérés dans un ordre volontairement quelconque : la projection ne doit
  // dépendre que de l'ensemble, pas de l'ordre (invariant EventLog).
  const log = new EventLog([B2, B, E0, A]);
  const proj = log.replay();

  // L'état officiel de sL est celui d'A (gagnant), jamais celui de B2.
  assert.equal(proj.saisies.sL.state, "A-gagnant");
  assert.equal(proj.__versions.saisies.sL.lastEventId, A.eventId);
  assert.equal(proj.__versions.saisies.sL.version, 2);

  // B et B2 sont tous deux en conflit (jamais appliqués, jamais perdus).
  const conflictIds = (proj.__conflicts || []).map((c) => c.eventId);
  assert.ok(conflictIds.includes(B.eventId), "B (branche perdante) est en conflit");
  assert.ok(
    conflictIds.includes(B2.eventId),
    "B2 (descendant du perdant) est en conflit, jamais promu état officiel"
  );
  assert.equal(conflictIds.length, 2, "exactement deux conflits : B et B2");
});

test("P0.1 classify : parentEventId incohérent => conflict, même quand baseVersion correspond", () => {
  // Entité à la version 2, dernier événement = "evX".
  const current = { version: 2, lastEventId: "evX" };

  // Un événement dont baseVersion COLLE (2) mais dont le parent déclaré est un
  // autre événement : il descend d'ailleurs => conflit.
  const wrongParent = {
    eventId: "evWrong", baseVersion: 2, parentEventId: "evAutreBranche",
  };
  assert.equal(classify(current, wrongParent), "conflict");

  // Le même, avec le bon parent, s'applique.
  const rightParent = {
    eventId: "evRight", baseVersion: 2, parentEventId: "evX",
  };
  assert.equal(classify(current, rightParent), "apply");

  // Compat ascendante : un événement SANS parentEventId retombe sur baseVersion.
  const legacyOk = { eventId: "evLegacy", baseVersion: 2 };
  assert.equal(classify(current, legacyOk), "apply");
  const legacyConflict = { eventId: "evLegacy2", baseVersion: 1 };
  assert.equal(classify(current, legacyConflict), "conflict");
});

test("P0.1 classify : création initiale (parent null, entité inconnue) s'applique", () => {
  const create = { eventId: "evCreate", baseVersion: 0, parentEventId: null };
  assert.equal(classify(undefined, create), "apply");

  // Une prétendue création sur une entité déjà connue (parent null mais
  // lastEventId non nul) est un conflit.
  const bogusCreate = { eventId: "evBogus", baseVersion: 0, parentEventId: null };
  assert.equal(classify({ version: 1, lastEventId: "evPrev" }, bogusCreate), "conflict");
});
