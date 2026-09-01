// tests/next/attack-p4r2-drive-cursor.test.mjs
//
// CONTRARIANT round 2 — Point 4 (Google Drive live), angle "curseur seenIds".
//
// Le correctif §8a (round 1) a bien réglé le cas COLLISION de `createdTime`
// (deux events au MÊME `createdTime` maximal). Ce round attaque un cas
// DIFFÉRENT et non couvert par ce correctif : un event dont le `createdTime`
// (assigné par le SERVEUR Drive, PAS par le client — voir `_listAllFiles`,
// `files(id,name,createdTime)`) se révèle être STRICTEMENT INFÉRIEUR au
// watermark déjà avancé par un appel `listChanges` antérieur, alors que cet
// event n'a JAMAIS été délivré. Ceci est plausible en Drive réel sans qu'aucun
// client ne triche : Drive n'offre PAS de garantie de cohérence globale
// immédiate entre "l'écriture est acceptée par le serveur" et "elle apparaît
// dans TOUS les `files.list` suivants, de TOUS les clients" — un fichier peut
// mettre un court instant à devenir listable (latence d'indexation/
// propagation documentée de façon informelle par de nombreux intégrateurs
// Drive), et deux requêtes `files.create` concurrentes traitées par des
// réplicas backend différents ne sont pas garanties retourner des
// `createdTime` strictement monotones dans l'ordre d'émission réel.
//
// Le code actuel (`listChanges`) traite `createdTime` comme un WATERMARK :
//   `if (f.createdTime < cursorCreatedTime) continue;`
// Cette ligne saute TOUT fichier dont le `createdTime` est strictement
// inférieur au curseur déjà émis — SANS AUCUN RATTRAPAGE POSSIBLE, puisque
// `createdTime` du curseur NE RECULE JAMAIS. `seenIds` (l'ensemble apparié à
// §8a) ne protège QUE contre la redélivrance/le saut sur ÉGALITÉ de
// `createdTime` avec le max courant — pas contre un retardataire dont le
// `createdTime` est déjà PASSÉ le max.
//
// On simule ce retardataire exactement comme le fait déjà
// `attack-p4-drive-races.test.mjs` (angle 3/3bis) pour simuler une collision :
// en forçant directement `createdTime` sur un noeud FakeDrive après coup —
// touche endossée par le mainteneur lui-même comme "comportement Drive réel
// possible" (voir ses commentaires). Ici on force un `createdTime` PLUS
// ANCIEN que ce qui a déjà été vu, pas égal.

import test from "node:test";
import assert from "node:assert/strict";

import { GoogleDriveStorageAdapter } from "../../src/storage/google-drive-adapter.js";
import { FakeDrive } from "./helpers/fake-drive.mjs";

const ROOT_ID = "root-workspace-r2-cursor";

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

test("CORRIGÉ §9a — listChanges : un event dont le createdTime Drive est ANTÉRIEUR au watermark déjà émis n'est PLUS jamais perdu", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  const T_EARLY = "2026-08-01T00:00:00.000Z"; // createdTime réel du retardataire (plus ancien)
  const T_LATE = "2026-08-01T00:10:00.000Z"; // createdTime du "premier" event vu par le poller

  // 1) Un premier event "ev-fast" est déjà visible avec un createdTime plus
  //    RÉCENT (T_LATE) — c'est celui qui, dans ce scénario, a fini de se
  //    propager/indexer en premier, même s'il a été écrit APRÈS 'ev-slow'.
  await adapter.putImmutable("event", "ev-fast", { eventId: "ev-fast", createdAt: "2026-08-01T00:00:00.000Z" });
  const fastNode = [...drive.nodes.values()].find((n) => n.name === "ev-fast.piloteo");
  fastNode.createdTime = T_LATE;

  const round1 = await adapter.listChanges();
  assert.deepEqual(round1.changes, [{ kind: "event", id: "ev-fast" }]);
  assert.deepEqual(round1.cursor, { createdTime: T_LATE, seenIds: [fastNode.id] });

  // 2) 'ev-slow' apparaît ENSUITE dans le listing (propagation/latence
  //    d'indexation, ou horodatage assigné par un réplica backend légèrement
  //    en retard) — mais avec un createdTime SERVEUR plus ANCIEN que ce qui a
  //    déjà été acquitté. Il n'a JAMAIS été délivré au poller.
  await adapter.putImmutable("event", "ev-slow", { eventId: "ev-slow", createdAt: "2026-08-01T00:00:00.000Z" });
  const slowNode = [...drive.nodes.values()].find((n) => n.name === "ev-slow.piloteo");
  slowNode.createdTime = T_EARLY; // strictement < round1.cursor.createdTime

  const round2 = await adapter.listChanges(round1.cursor);

  // CORRIGÉ §9a : listChanges retourne désormais l'ensemble ORDONNÉ COMPLET à
  // chaque appel — `cursor` n'est plus jamais utilisé pour EXCLURE quoi que ce
  // soit. 'ev-slow' (jamais vu) est bien délivré, et 'ev-fast' (déjà vu) est
  // re-livré aussi — SANS DANGER, cf. `SyncEngine._seen`/`EventLog` (voir
  // en-tête du fichier adaptateur, §9a).
  assert.deepEqual(
    round2.changes.map((c) => c.id).sort(),
    ["ev-fast", "ev-slow"],
    "CORRIGÉ §9a : 'ev-slow' (createdTime antérieur au watermark) est bien délivré — plus jamais sauté"
  );

  // Et il continue d'être délivré à chaque appel futur (énumération complète,
  // pas une fenêtre qui se refermerait) — jamais un souci de "perte
  // rattrapée une fois puis qui redisparaît".
  let cursor = round2.cursor;
  for (let i = 0; i < 3; i++) {
    const r = await adapter.listChanges(cursor);
    assert.ok(
      r.changes.some((c) => c.id === "ev-slow"),
      `ev-slow reste visible après ${i + 1} appel(s) supplémentaire(s) — plus de perte, sauté ou non`
    );
    cursor = r.cursor;
  }

  // IMPACT vérifié : un membre reçoit désormais bien 'ev-slow' via le flux de
  // synchronisation normal (`listChanges`), pas seulement via `get()` direct.
  assert.ok(
    (await adapter.get("event", "ev-slow")) !== null,
    "l'event existe bel et bien sur Drive, ET listChanges() le délivre désormais aussi"
  );
});

test("angle secondaire — seenIds peut grossir sans borne tant que des events continuent d'arriver au MÊME createdTime maximal (rafale)", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  const T = "2026-08-05T00:00:00.000Z";
  const N = 50; // rafale d'events partageant EXACTEMENT le même createdTime serveur (résolution Drive finie).
  for (let i = 0; i < N; i++) {
    const id = `burst-${String(i).padStart(3, "0")}`;
    await adapter.putImmutable("event", id, { eventId: id, createdAt: "2026-08-05T00:00:00.000Z" });
    const node = [...drive.nodes.values()].find((n) => n.name === `${id}.piloteo`);
    node.createdTime = T;
  }

  const { cursor } = await adapter.listChanges();
  // Confirmé : tant qu'aucun event n'a un createdTime STRICTEMENT supérieur,
  // seenIds contient TOUS les ids de la rafale (pas de purge tant que le
  // watermark n'avance pas) — un cursor persisté (ex: IndexedDB/localStorage
  // côté SyncEngine) grossit proportionnellement à la taille de la rafale, pas
  // à un nombre borné de collisions "occasionnelles".
  assert.equal(cursor.seenIds.length, N, "seenIds contient toute la rafale tant que le watermark n'avance pas — pas de fuite mémoire non bornée dans l'absolu (borné par la rafale), mais un cursor potentiellement volumineux à persister/sérialiser pour une rafale importante");
});
