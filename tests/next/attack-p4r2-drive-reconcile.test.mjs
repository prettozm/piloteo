// tests/next/attack-p4r2-drive-reconcile.test.mjs
//
// CONTRARIANT round 2 — Point 4 (Google Drive live), angle
// `_reconcileFileCandidates` (coût/erreur + comparaison de contenu).
//
// `_reconcileFileCandidates` télécharge INCONDITIONNELLEMENT le contenu de
// TOUS les candidats physiques `(kind,id)` trouvés (pas seulement du
// "gagnant" oldest-wins) pour pouvoir détecter une divergence. Ceci introduit
// deux effets de bord non couverts par les tests round 1 :
//   (a) un candidat SURNUMÉRAIRE (doublon inoffensif, contenu identique —
//       résidu de course explicitement accepté par §8b) dont le
//       TÉLÉCHARGEMENT échoue (erreur réseau persistante, 5xx, etc.) fait
//       échouer TOUTE la lecture, alors que le "gagnant" (le plus ancien) est,
//       lui, parfaitement lisible et suffirait à répondre correctement ;
//   (b) la comparaison d'immutabilité est BYTE-EXACTE (`JSON.stringify` texte
//       à texte) : deux blobs logiquement identiques mais sérialisés avec un
//       ORDRE DE CLÉS différent (plausible entre deux implémentations/
//       versions clientes qui construisent le même objet différemment)
//       déclenchent un FAUX `IMMUTABLE_CONFLICT`.

import test from "node:test";
import assert from "node:assert/strict";

import { GoogleDriveStorageAdapter, ImmutableConflictError } from "../../src/storage/google-drive-adapter.js";
import { FakeDrive } from "./helpers/fake-drive.mjs";

const ROOT_ID = "root-workspace-r2-reconcile";

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

test("CORRIGÉ §9c — un doublon physique SURNUMÉRAIRE (non-gagnant) dont le TÉLÉCHARGEMENT échoue de façon persistante n'empêche PLUS une lecture réussie du gagnant", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  const blob = { eventId: "ev-dup", createdAt: "2026-08-01T00:00:00.000Z", payload: { x: 1 } };

  // Écrit une première fois -> fichier "gagnant" (le plus ancien), lisible.
  await adapter.putImmutable("event", "ev-dup", blob);

  // Simule le résidu de course EXPLICITEMENT accepté par §8b : un DEUXIÈME
  // fichier physique du même nom logique, même contenu (doublon idempotent
  // inoffensif), ajouté directement (représente un putImmutable concurrent
  // qui a vu "absent" avant que le premier ne finisse).
  const winnerNode = [...drive.nodes.values()].find((n) => n.name === "ev-dup.piloteo");
  const dupId = "id-dup-orphan";
  drive.nodes.set(dupId, {
    ...winnerNode,
    id: dupId,
    createdTime: new Date(new Date(winnerNode.createdTime).getTime() + 1000).toISOString(), // plus récent -> PAS le gagnant
  });

  // `get()` sans panne réussit normalement (les deux ont le même contenu).
  assert.deepEqual(await adapter.get("event", "ev-dup"), blob);

  // Maintenant, SEUL le doublon orphelin (jamais le gagnant) devient
  // inaccessible en téléchargement de façon PERSISTANTE (ex: incident propre à
  // CE fichier, ACL Drive incohérente sur ce doublon précis, etc.) — ciblé
  // PAR fileId (`forceDownloadFailure`), pas une file d'attente globale, pour
  // isoler précisément l'angle "orphelin illisible", indépendamment de l'ORDRE
  // dans lequel `_reconcileFileCandidates` télécharge les candidats.
  drive.forceDownloadFailure(dupId, 500, "Internal Server Error");

  // CORRIGÉ §9c : `_reconcileFileCandidates` télécharge le GAGNANT en premier
  // (lisible) et n'échoue QUE de façon best-effort sur l'orphelin — la lecture
  // RÉUSSIT et renvoie le contenu du gagnant, malgré l'orphelin illisible.
  assert.deepEqual(
    await adapter.get("event", "ev-dup"),
    blob,
    "CORRIGÉ §9c : get() réussit et renvoie le gagnant malgré un doublon surnuméraire illisible de façon persistante"
  );
  assert.deepEqual(
    await adapter.readMetadata("event", "ev-dup"),
    { kind: "event", id: "ev-dup", fileId: winnerNode.id, writtenAt: winnerNode.createdTime, size: winnerNode.size },
    "readMetadata() réussit également, malgré l'orphelin illisible"
  );

  // Preuve additionnelle que l'orphelin est bien RÉELLEMENT sollicité en
  // téléchargement (le test ne réussit pas par accident faute d'avoir vraiment
  // exercé le chemin best-effort) :
  drive.calls.length = 0;
  await adapter.get("event", "ev-dup");
  const downloadCallsForOrphan = drive.calls.filter((c) => c.url.includes(`/drive/v3/files/${dupId}?`));
  assert.ok(downloadCallsForOrphan.length > 0, "l'orphelin a bien été SOLLICITÉ en téléchargement (pas simplement ignoré)");
});

test("CORRIGÉ §9d — comparaison d'immutabilité : même contenu LOGIQUE, ordre de clés différent -> PLUS de faux IMMUTABLE_CONFLICT (sérialisation canonique)", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  // Deux blobs strictement identiques en CONTENU logique (mêmes clés, mêmes
  // valeurs), mais construits/sérialisés avec un ORDRE de clés différent —
  // plausible si deux clients (versions différentes du code, ou l'un ayant
  // reconstruit l'objet via un spread/merge) produisent le même manifeste
  // "logique" sans coordination sur l'ordre d'insertion des clés JS.
  const blobA = { eventId: "ev-order", createdAt: "2026-08-01T00:00:00.000Z", payload: { a: 1, b: 2 } };
  const blobB = { payload: { b: 2, a: 1 }, createdAt: "2026-08-01T00:00:00.000Z", eventId: "ev-order" };

  // Vérifie d'abord que ces deux objets sont bien "le même événement" au sens
  // métier (même id, mêmes champs, seul l'ORDRE diffère) mais PAS le même
  // texte JSON BRUT — c'est précisément le piège qu'une comparaison naïve
  // `JSON.stringify` percutait, et que `canonicalStringify` (clés triées)
  // neutralise désormais AU NIVEAU adaptateur (§9d).
  assert.notEqual(JSON.stringify(blobA), JSON.stringify(blobB), "prérequis du test : sérialisations JSON BRUTES différentes pour un contenu logique identique");

  await adapter.putImmutable("event", "ev-order", blobA);

  // CORRIGÉ §9d : le "deuxième créateur" (ex: retry applicatif ayant
  // reconstruit le blob dans un ordre différent, ou un autre client) écrit le
  // MÊME événement logique -> succès idempotent, PLUS de faux conflit.
  const result = await adapter.putImmutable("event", "ev-order", blobB);
  assert.deepEqual(result, { id: "ev-order" }, "CORRIGÉ §9d : succès idempotent, aucun IMMUTABLE_CONFLICT pour un contenu logiquement identique");

  // Un fichier physique unique existe toujours (pas de doublon créé non plus).
  const filesNamed = [...drive.nodes.values()].filter((n) => n.name === "ev-order.piloteo");
  assert.equal(filesNamed.length, 1);

  // Un contenu RÉELLEMENT différent, lui, continue de lever IMMUTABLE_CONFLICT
  // (la canonicalisation ne masque jamais un VRAI conflit).
  const blobDifferent = { eventId: "ev-order", createdAt: "2026-08-01T00:00:00.000Z", payload: { a: 1, b: 999 } };
  await assert.rejects(
    () => adapter.putImmutable("event", "ev-order", blobDifferent),
    (err) => err instanceof ImmutableConflictError,
    "un contenu réellement différent lève toujours IMMUTABLE_CONFLICT (la canonicalisation ne masque pas un vrai conflit)"
  );
});
