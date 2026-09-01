// tests/next/attack-p4r2-drive-connect-sweep.test.mjs
//
// CONTRARIANT round 2 — Point 4 (Google Drive live), angle "connect() sweep".
//
// Le correctif §8b fait converger deux `connect()` concurrents SI le
// "retardataire" (le dossier réellement le plus ancien) est déjà VISIBLE au
// moment du balayage de réconciliation final de CHAQUE instance. Mais
// `connect()` est un NO-OP après la première réussite (`if (this._connected)
// return;`) et `_ensureFolder` met en cache le résultat POUR TOUJOURS
// (`this._folderCache`) : une instance qui a terminé son `connect()` (y
// compris son balayage final) AVANT qu'un dossier plus ancien qu'elle n'ait
// eu le temps de devenir visible dans ses propres requêtes `files.list` reste
// bloquée SUR SON PROPRE CHOIX pour toute la durée de vie de l'instance — il
// n'y a AUCUN mécanisme de "prochaine résolution" pour le TOP-LEVEL folder
// une fois `_connected = true`.
//
// C'est exactement la même famille de risque que l'angle "cursor watermark"
// (listChanges) : Drive n'offre pas de garantie de cohérence GLOBALE
// immédiate de `files.list` entre déférents clients — un dossier créé
// "avant" (au sens `createdTime` serveur) peut mettre un instant à devenir
// visible aux requêtes d'un AUTRE client. On simule ceci en ajoutant
// directement, via `drive.addFolder(..., {createdTime})` (fonction fournie
// PAR le harnais pour ce genre de setup), un dossier "events" concurrent
// portant un `createdTime` antérieur à celui déjà résolu par une première
// instance — représentant un create qui a réellement eu lieu plus tôt
// (horloge/réplica backend) mais dont la PROPAGATION vers les requêtes de la
// première instance n'était pas encore achevée au moment de son balayage.
//
// Le contrat documente une fenêtre de course "pas nécessairement dans la
// même microseconde, convergence à la PROCHAINE résolution" — ce test montre
// qu'il n'existe PAS de "prochaine résolution" pour une instance déjà
// connectée : la divergence est donc PERMANENTE pour cette instance, pas
// seulement temporaire.

import test from "node:test";
import assert from "node:assert/strict";

import { GoogleDriveStorageAdapter } from "../../src/storage/google-drive-adapter.js";
import { FakeDrive } from "./helpers/fake-drive.mjs";

const ROOT_ID = "root-workspace-r2-sweep";

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

test("CORRIGÉ §9b — une instance déjà connect()ée finit par adopter un dossier plus ancien devenu visible ensuite (re-résolution paresseuse, sans redémarrage)", async () => {
  const drive = new FakeDrive();
  const adapterA = makeAdapter(drive);

  // A est SEUL sur un workspace tout neuf : connect() crée les 5 dossiers,
  // son balayage final ne voit qu'eux-mêmes -> A converge (légitimement) sur
  // SES PROPRES dossiers, dont "events".
  await adapterA.connect();
  const aEventsFolderId = adapterA._topFolders.event;
  assert.ok(aEventsFolderId, "précondition : A a résolu un dossier events");

  // A écrit déjà un event dans SON dossier — c'est l'état "légitime" du
  // workspace du point de vue de A à cet instant.
  await adapterA.putImmutable("event", "ev-from-a", { eventId: "ev-from-a", createdAt: "2026-08-01T00:00:00.000Z" });

  // Un dossier "events" CONCURRENT apparaît ENSUITE dans le simulateur, mais
  // avec un `createdTime` ANTÉRIEUR à celui de A (représente une création
  // réellement plus ancienne dont la visibilité pour les requêtes de A a été
  // retardée — propagation/latence d'indexation, cf. commentaire d'en-tête).
  const aEventsNode = drive.nodes.get(aEventsFolderId);
  const earlierTime = new Date(new Date(aEventsNode.createdTime).getTime() - 60_000).toISOString();
  const phantomOlderId = drive.addFolder("events", ROOT_ID, { createdTime: earlierTime });

  // Un DEUXIÈME appareil (B) se connecte MAINTENANT — il voit TOUT ce qui
  // existe, y compris le dossier fantôme plus ancien -> converge, à raison,
  // sur le fantôme (oldest-wins, correctement appliqué).
  const adapterB = makeAdapter(drive);
  await adapterB.connect();
  assert.equal(
    adapterB._topFolders.event,
    phantomOlderId,
    "B, qui voit tout, résout correctement le dossier le PLUS ANCIEN (oldest-wins)"
  );

  // A reste sur SON dossier (plus récent) tant qu'aucune OPÉRATION ne
  // déclenche sa re-résolution paresseuse (§9b) — `connect()` lui-même reste
  // un no-op définitif, par conception (efficacité d'un connect() répété).
  assert.notEqual(
    adapterA._topFolders.event,
    phantomOlderId,
    "précondition : A n'a PAS encore adopté le dossier plus ancien (aucune opération déclenchant _liveTopFolder n'a encore eu lieu)"
  );

  // CORRIGÉ §9b : la PROCHAINE écriture de A déclenche `_liveTopFolder`, qui
  // re-résout le dossier "events" et adopte le PLUS ANCIEN actuellement
  // visible (le fantôme) — sans jamais redémarrer l'instance A.
  await adapterA.putImmutable("event", "ev-from-a-2", { eventId: "ev-from-a-2", createdAt: "2026-08-02T00:00:00.000Z" });
  assert.equal(
    adapterA._topFolders.event,
    phantomOlderId,
    "CORRIGÉ §9b : A a fini par adopter le dossier réellement le plus ancien, sans redémarrage"
  );

  // Impact concret : B voit maintenant BIEN les DEUX events de A — le second
  // (écrit APRÈS la convergence de A, dans le dossier désormais partagé) ET,
  // grâce à §10 (revue adverse round 3, `_allTopFolderIds` — la LECTURE unit
  // tous les dossiers "events" de même nom, pas seulement le gagnant),
  // 'ev-from-a' lui-même, pourtant écrit dans l'ANCIEN dossier de A (désormais
  // orphelin pour les écritures) AVANT sa convergence. Plus de split-brain
  // PERMANENT, ET plus aucun contenu invisible (§10 corrige l'affirmation
  // antérieure de ce test, qui acceptait 'ev-from-a' comme "résidu de course"
  // — c'était en réalité une perte de données, cf. DRIVE_CONFLITS_LOCKS.md §2bis).
  const seenByB = await adapterB.listChanges();
  assert.deepEqual(
    seenByB.changes.map((c) => c.id).sort(),
    ["ev-from-a", "ev-from-a-2"],
    "CORRIGÉ §9b+§10 : B voit les DEUX events de A — la nouvelle écriture (après convergence) ET l'ancienne (dans le dossier désormais orphelin de A), plus jamais invisible grâce à l'union des dossiers en lecture (§10)"
  );
});
