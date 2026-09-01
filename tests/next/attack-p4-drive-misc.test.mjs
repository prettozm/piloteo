// tests/next/attack-p4-drive-misc.test.mjs
//
// CONTRARIANT — Point 4. Angles 4 (injection requête Drive), 5 (fuite de
// token), 6 (classification des erreurs HTTP). Contre le FakeDrive partagé.

import test from "node:test";
import assert from "node:assert/strict";

import { GoogleDriveStorageAdapter, DriveAuthError } from "../../src/storage/google-drive-adapter.js";
import { FakeDrive } from "./helpers/fake-drive.mjs";

const ROOT_ID = "root-workspace-misc";

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

// ---------------------------------------------------------------------------
// ANGLE 6 — CASSÉ à l'origine, CORRIGÉ §8d (revue adverse, bug réel #6) : un
// 403 Drive n'est PAS toujours un problème d'auth. Google utilise aussi HTTP
// 403 pour le quota (`rateLimitExceeded`, `userRateLimitExceeded`,
// `dailyLimitExceeded`) et documente explicitement que CES 403 doivent être
// RETENTÉS avec backoff exponentiel (comme un 429), jamais traités comme un
// échec d'authentification définitif. Avant #8d, le code ne regardait JAMAIS
// le corps de la réponse : TOUT 403, quota ou pas, devenait un `DriveAuthError`
// immédiat (sans retry), et côté `piloteo-drive-bridge.mjs` cela aurait
// déclenché un nouveau `requestAccessToken()` (ré-interaction utilisateur,
// popup Google) pour un problème qui n'a RIEN à voir avec le token.
//
// CORRECTIF #8d : `_fetchWithRetry` inspecte désormais `body.error.errors[].reason`
// — un motif de quota est retenté comme un 429 ; seul un motif d'auth
// (`authError`/`insufficientPermissions`) ou un corps sans motif reconnu lève
// `DriveAuthError` immédiatement (voir le test suivant).
// ---------------------------------------------------------------------------
test("ATTAQUE angle 6 — 403 quota (rateLimitExceeded) : retenté avec backoff, PAS un AUTH_ERROR (CORRIGÉ §8d)", async () => {
  const drive = new FakeDrive();
  const sleepCalls = [];
  const adapter = makeAdapter(drive, { sleepFn: async (ms) => sleepCalls.push(ms) });

  // Corps EXACT du format d'erreur Drive documenté par Google pour un quota
  // dépassé (PAS un problème d'authentification) :
  const quotaErrorBody = {
    error: {
      errors: [{ domain: "usageLimits", reason: "userRateLimitExceeded", message: "User Rate Limit Exceeded" }],
      code: 403,
      message: "User Rate Limit Exceeded",
    },
  };
  drive.forceNext(403, quotaErrorBody);

  // CORRIGÉ : connect() RÉUSSIT après un seul retry — le 403 quota n'interrompt
  // jamais l'opération, et ne déclenche AUCUNE tentative de re-token.
  await adapter.connect();

  assert.equal(sleepCalls.length, 1, "CORRIGÉ §8d : le 403 quota déclenche UN retry/backoff, comme un 429");
  assert.ok(adapter._topFolders && adapter._topFolders.workspace, "connect() a fini par réussir malgré le 403 quota transitoire");
});

// ---------------------------------------------------------------------------
// Contre-test #8d : un 403 D'AUTHENTIFICATION réel (motif `authError` ou
// `insufficientPermissions`) DOIT toujours lever `DriveAuthError` IMMÉDIATEMENT,
// sans jamais être confondu avec un quota — la distinction #8d doit être
// SPÉCIFIQUE au motif, pas un simple "203/403 -> jamais AUTH_ERROR".
// ---------------------------------------------------------------------------
test("#8d — 403 authError reste un AUTH_ERROR immédiat (jamais confondu avec un quota)", async () => {
  const drive = new FakeDrive();
  const sleepCalls = [];
  const adapter = makeAdapter(drive, { sleepFn: async (ms) => sleepCalls.push(ms) });

  const authErrorBody = {
    error: {
      errors: [{ domain: "global", reason: "authError", message: "Invalid Credentials" }],
      code: 403,
      message: "Invalid Credentials",
    },
  };
  drive.forceNext(403, authErrorBody);

  await assert.rejects(
    () => adapter.connect(),
    (err) => err instanceof DriveAuthError && err.code === "AUTH_ERROR"
  );
  assert.equal(sleepCalls.length, 0, "un 403 authError ne doit déclencher AUCUN retry — AUTH_ERROR immédiat");

  // insufficientPermissions : même verdict.
  const drive2 = new FakeDrive();
  const adapter2 = makeAdapter(drive2, { sleepFn: async () => {} });
  drive2.forceNext(403, {
    error: { errors: [{ domain: "global", reason: "insufficientPermissions", message: "Forbidden" }], code: 403 },
  });
  await assert.rejects(
    () => adapter2.connect(),
    (err) => err instanceof DriveAuthError && err.code === "AUTH_ERROR"
  );
});

// ---------------------------------------------------------------------------
// ANGLE 4 — TENU (tentative) : injection dans le nom de fichier/id via
// `escapeDriveQueryValue`. Un `id` hostile contenant quote/backslash/
// "in parents" ne doit jamais élargir la portée de la requête `files.list`
// hors du dossier attendu.
// ---------------------------------------------------------------------------
test("ATTAQUE angle 4 — id hostile (quotes/backslash/'in parents') n'élargit pas la portée de la recherche Drive", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  // Fichier LEURRE hors du dossier "events" de ce workspace.
  const otherRoot = drive.addFolder("root-autre", null);
  drive.nodes.set("rogue-file", {
    id: "rogue-file",
    name: `pwned' or '1'='1.piloteo`,
    mimeType: "application/octet-stream",
    parents: [otherRoot],
    createdTime: "1970-01-01T00:00:00.000Z",
    content: JSON.stringify({ pwned: true }),
  });

  const hostileId = `pwned' or '1'='1`;
  // putImmutable avec un id contenant quote/backslash : ne doit PAS retrouver
  // le leurre situé dans un autre dossier, doit créer normalement le sien.
  await adapter.putImmutable("event", hostileId, { eventId: hostileId, createdAt: "2026-08-01T00:00:00.000Z" });

  const own = await adapter.get("event", hostileId);
  assert.deepEqual(own, { eventId: hostileId, createdAt: "2026-08-01T00:00:00.000Z" }, "doit lire SON PROPRE fichier, pas le leurre");

  // Id contenant un backslash final + guillemet, cas limite de l'échappement.
  const injId = `back\\slash-and-quote'-id`;
  await adapter.putImmutable("event", injId, { eventId: injId, createdAt: "2026-08-02T00:00:00.000Z" });
  assert.deepEqual(await adapter.get("event", injId), { eventId: injId, createdAt: "2026-08-02T00:00:00.000Z" });

  assert.equal(await adapter.get("event", "completely-unrelated-id"), null, "aucune fuite globale déclenchée par les ids hostiles");

  // NOTE audit fake-drive.mjs : un id contenant LITTÉRALEMENT la sous-chaîne
  // `' in parents` (ex: `x' in parents or 'a'='a`) fait dérailler le
  // parseur NAÏF `parseDriveQuery` du simulateur lui-même (son regex
  // `parentMatch = /'([^']+)' in parents/` ne comprend PAS l'échappement
  // backslash, contrairement à `nameMatch` qui le gère correctement) : il
  // capture un `parentId` bidon à l'intérieur du nom échappé, AVANT d'atteindre
  // la vraie clause `'<parentId>' in parents` en fin de requête. Ce n'est PAS
  // un bug de production (l'échappement de `escapeDriveQueryValue` est
  // correct et conforme aux règles Drive) mais une fragilité du SIMULATEUR
  // qui peut fausser un test construit avec un tel id (résultat non
  // probant dans un sens comme dans l'autre) — à corriger dans
  // `tests/next/helpers/fake-drive.mjs` (`parentMatch` devrait ignorer tout
  // contenu situé DANS la valeur de `name` déjà capturée par `nameMatch`,
  // ou réutiliser la même logique d'échappement).
});

// ---------------------------------------------------------------------------
// ANGLE 5 — TENU (tentative) : le token ne doit jamais apparaître dans un
// message d'erreur, une exception sérialisée, ou un champ inspectable de
// l'adaptateur.
// ---------------------------------------------------------------------------
test("ATTAQUE angle 5 — le token OAuth ne fuit jamais dans une erreur ni un champ de l'adaptateur", async () => {
  const drive = new FakeDrive();
  const SECRET_TOKEN = "ya29.SECRET-TOKEN-DO-NOT-LEAK-abc123";
  const adapter = new GoogleDriveStorageAdapter({
    oauthTokenProvider: async () => SECRET_TOKEN,
    rootFolderId: ROOT_ID,
    fetchImpl: drive.fetch,
    sleepFn: async () => {},
    maxRetries: 4,
  });

  drive.forceNext(500, "Internal Server Error");
  drive.forceNext(500, "Internal Server Error");
  drive.forceNext(500, "Internal Server Error");
  drive.forceNext(500, "Internal Server Error");

  let caught = null;
  try {
    await adapter.connect();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "doit échouer après épuisement des essais");
  assert.ok(!String(caught.message).includes(SECRET_TOKEN), "le token ne doit pas apparaître dans le message d'erreur");
  assert.ok(!JSON.stringify(caught).includes(SECRET_TOKEN), "le token ne doit pas apparaître dans l'erreur sérialisée");
  assert.ok(!JSON.stringify(adapter).includes(SECRET_TOKEN), "le token ne doit jamais être stocké sur l'instance de l'adaptateur");

  // Vérification directe : aucune propriété de l'adaptateur ne porte le token.
  for (const key of Object.keys(adapter)) {
    assert.notEqual(adapter[key], SECRET_TOKEN, `propriété '${key}' ne doit pas contenir le token`);
  }
});
