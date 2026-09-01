// tests/next/attack-p4r2-drive-403.test.mjs
//
// CONTRARIANT round 2 — Point 4 (Google Drive live), angle "403 quota vs
// auth", formes de corps alternatives non couvertes par §8d/round 1.
//
// Round 1 (§8d) a corrigé le cas nominal : `error.errors[].reason` porte un
// motif de quota classique (Discovery-style, `rateLimitExceeded` etc.) — bien
// testé, TENU sur ce format précis. Ce round attaque deux variantes réalistes
// non couvertes par `is403QuotaBody` :
//   (a) le format d'erreur "google.rpc.Status" (`error.status`, PAS de tableau
//       `errors[]`) — utilisé par de nombreuses API Google modernes/passant
//       par un API Gateway, y compris parfois pour des 403 de quota
//       (`error.status === "RESOURCE_EXHAUSTED"`). `is403QuotaBody` ne
//       regarde QUE `error.errors[].reason` : un corps sans `errors[]` est
//       traité comme "pas de motif reconnu" -> AUTH_ERROR immédiat, alors que
//       c'est un quota.
//   (b) un tableau `errors[]` MÉLANGEANT un motif d'auth ET un motif de quota
//       (cas pathologique mais accepté tel quel par `.some()`) : le code
//       actuel classe ça comme "quota" (retry) dès qu'AU MOINS UN motif de
//       quota est présent, même si un AUTRE motif du même tableau signale un
//       problème d'authentification RÉEL et PERMANENT — masquant ainsi un
//       échec définitif derrière des retries qui ne le résoudront jamais.

import test from "node:test";
import assert from "node:assert/strict";

import { GoogleDriveStorageAdapter, DriveAuthError } from "../../src/storage/google-drive-adapter.js";
import { FakeDrive } from "./helpers/fake-drive.mjs";

const ROOT_ID = "root-workspace-r2-403";

function makeAdapter(drive, opts = {}) {
  return new GoogleDriveStorageAdapter({
    oauthTokenProvider: async () => "fake-access-token",
    rootFolderId: ROOT_ID,
    fetchImpl: drive.fetch,
    sleepFn: async () => {},
    maxRetries: 4,
    ...opts,
  });
}

test("CORRIGÉ §9e — 403 quota au format google.rpc.Status (error.status, sans errors[]) est retenté comme un 429, PAS un AUTH_ERROR", async () => {
  const drive = new FakeDrive();
  const sleepCalls = [];
  const adapter = makeAdapter(drive, { sleepFn: async (ms) => sleepCalls.push(ms) });

  // Forme "google.rpc.Status" (status utilisée par de nombreuses API Google
  // récentes/passerelles) pour un dépassement de quota — PAS le format
  // Discovery `errors[]` classique testé par §8d.
  const quotaRpcStatusBody = {
    error: {
      code: 403,
      message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute'",
      status: "RESOURCE_EXHAUSTED",
    },
  };
  drive.forceNext(403, quotaRpcStatusBody);

  // CORRIGÉ : connect() RÉUSSIT après un seul retry — `is403QuotaBody`
  // reconnaît désormais `error.status === "RESOURCE_EXHAUSTED"` même sans
  // tableau `errors[]` (format google.rpc.Status).
  await adapter.connect();

  assert.equal(sleepCalls.length, 1, "CORRIGÉ §9e : le 403 RESOURCE_EXHAUSTED (google.rpc.Status) déclenche UN retry/backoff, comme un 429");
  assert.ok(adapter._topFolders && adapter._topFolders.workspace, "connect() a fini par réussir malgré le 403 quota transitoire");
});

test("CORRIGÉ §9e — errors[] mélangeant un motif d'auth PERMANENT et un motif de quota : l'auth PRIME -> AUTH_ERROR immédiat, ZÉRO retry gaspillé", async () => {
  const drive = new FakeDrive();
  const sleepCalls = [];
  const adapter = makeAdapter(drive, { sleepFn: async (ms) => sleepCalls.push(ms) });

  const mixedBody = {
    error: {
      code: 403,
      message: "mixed",
      errors: [
        { domain: "global", reason: "authError", message: "Invalid Credentials" }, // PERMANENT, non résolu par un retry
        { domain: "usageLimits", reason: "userRateLimitExceeded", message: "User Rate Limit Exceeded" },
      ],
    },
  };
  // Une SEULE occurrence suffit désormais : plus aucun retry n'est consommé.
  drive.forceNext(403, mixedBody);

  let caught = null;
  try {
    await adapter.connect();
  } catch (err) {
    caught = err;
  }
  // CORRIGÉ : le motif d'auth PERMANENT (`authError`) présent dans `errors[]`
  // PRIME sur le motif de quota cohabitant -> `DriveAuthError` immédiat.
  // L'appelant (`piloteo-drive-bridge.mjs`) reçoit donc bien le signal "il
  // faut ré-obtenir un token" pour ce cas mixte, sans gaspiller de retries.
  assert.ok(
    caught instanceof DriveAuthError && caught.code === "AUTH_ERROR",
    "CORRIGÉ §9e : le motif d'auth PERMANENT dans errors[] PRIME sur le motif de quota cohabitant -> DriveAuthError"
  );
  assert.equal(sleepCalls.length, 0, "CORRIGÉ §9e : AUCUN retry gaspillé — l'auth est détectée dès le premier 403, pas après épuisement du quota");
});
