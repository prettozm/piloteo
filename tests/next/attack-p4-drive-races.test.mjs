// tests/next/attack-p4-drive-races.test.mjs
//
// CONTRARIANT — Point 4 (Google Drive live). Attaques contre
// `GoogleDriveStorageAdapter` (round post-correction #1, isolation
// inter-workspace). Angles 1, 2, 3, 7 du brief.
//
// Utilise le FakeDrive PARTAGÉ (tests/next/helpers/fake-drive.mjs), sans
// aucune modification de la production. Chaque test documente l'angle
// attaqué et le verdict (CASSÉ / TENU) dans son titre et ses commentaires.

import test from "node:test";
import assert from "node:assert/strict";

import { GoogleDriveStorageAdapter, ImmutableConflictError } from "../../src/storage/google-drive-adapter.js";
import { FakeDrive, FOLDER_MIME } from "./helpers/fake-drive.mjs";

const ROOT_ID = "root-workspace-attack";

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
// ANGLE 7 / 1 (lock-free & isolation) — CASSÉ à l'origine, puis CORRIGÉ (§8b,
// revue adverse, réconciliation déterministe).
//
// Le contrat §4.2 affirme : « le modèle append-only immuable rend le verrou
// inutile : on n'a jamais à MODIFIER un fichier existant ». C'est vrai pour
// les FICHIERS d'event, mais c'était FAUX pour les DOSSIERS : `connect()`
// faisait un find-or-create NON ATOMIQUE (`_ensureFolder` : `_findFolder` puis
// `_createFolder`, sans jamais revérifier) sur `workspace/members/events/
// keys/licenses`. Deux instances (= deux appareils/onglets) qui appellent
// `connect()` en même temps sur un workspace TOUT NEUF pouvaient chacune créer
// LEUR PROPRE dossier "events" (split-brain).
//
// CORRECTIF §8b : `_ensureFolder` re-résout (oldest-wins) après toute création
// plutôt que de supposer que SA création a gagné, et `connect()` fait un
// balayage de réconciliation FINAL après le passage find-or-create des 5
// dossiers. Résultat vérifié ci-dessous : le doublon PHYSIQUE peut encore
// survenir (fenêtre de course résiduelle, assumée et documentée —
// `docs/next/DRIVE_CONFLITS_LOCKS.md` §2bis, orphelin vide et inoffensif),
// MAIS les DEUX instances convergent désormais sur le MÊME dossier "events"
// (`_topFolders.event` identique des deux côtés) — B voit bien l'event écrit
// par A. Le split-brain silencieux est neutralisé.
// ---------------------------------------------------------------------------
test("ATTAQUE angle 1/7 — connect() concurrent sur workspace neuf : doublon physique possible, mais convergence garantie (CORRIGÉ §8b)", async () => {
  const drive = new FakeDrive();
  const adapterA = makeAdapter(drive);
  const adapterB = makeAdapter(drive);

  // Deux "appareils" appellent connect() EN MÊME TEMPS sur un workspace tout
  // neuf (aucun sous-dossier n'existe encore sous ROOT_ID).
  await Promise.all([adapterA.connect(), adapterB.connect()]);

  const eventsFolders = [...drive.nodes.values()].filter(
    (n) => n.mimeType === FOLDER_MIME && n.name === "events" && n.parents.includes(ROOT_ID)
  );
  // Le doublon PHYSIQUE peut encore se produire (fenêtre de course résiduelle,
  // documentée §8c) — ce n'est PLUS le problème : la réconciliation à la
  // résolution garantit que les DEUX instances pointent sur le MÊME gagnant.
  if (eventsFolders.length > 1) {
    // Vérifie que le "perdant" est bien un orphelin harmless : aucune des deux
    // instances ne l'utilise.
    for (const f of eventsFolders) {
      if (f.id !== adapterA._topFolders.event) {
        assert.notEqual(adapterB._topFolders.event, f.id, "B ne doit pas non plus pointer sur l'orphelin");
      }
    }
  }
  assert.equal(
    adapterA._topFolders.event,
    adapterB._topFolders.event,
    "CORRIGÉ §8b : les deux instances convergent sur le MÊME dossier 'events', même si un doublon physique a transitoirement existé"
  );

  // Impact concret vérifié : A écrit un event, B LE VOIT (convergence, pas de split-brain).
  await adapterA.putImmutable("event", "ev-from-a", { eventId: "ev-from-a", createdAt: "2026-08-01T00:00:00.000Z" });
  const seenByB = await adapterB.listChanges();
  assert.deepEqual(
    seenByB.changes,
    [{ kind: "event", id: "ev-from-a" }],
    "CORRIGÉ §8b : B voit bien l'event écrit par A — plus de divergence permanente/silencieuse"
  );
});

// ---------------------------------------------------------------------------
// ANGLE 2 (idempotence percée À L'ÉCRITURE) — putImmutable concurrent du MÊME
// event. RECLASSÉ après §8a/§8b (revue adverse) : la course à l'ÉCRITURE n'est
// PAS empêchée (`putImmutable` reste best-effort, jamais un verrou — §4/§8b
// l'assument explicitement : « la course résiduelle est rattrapée par la
// réconciliation à la lecture »), MAIS son IMPACT est neutralisé : `listChanges`
// déduplique désormais par nom physique (§8a) — le doublon (même contenu, même
// nom logique) ne produit jamais deux entrées logiques, donc jamais un
// double-traitement de l'event par `SyncEngine`/`solo-store`.
//
// `putImmutable` fait un check-then-act NON ATOMIQUE (recherche async puis
// upload async, sans jamais reverrouiller) : deux appels concurrents du MÊME
// (kind,id) (ex: deux onglets qui retentent le même append après un timeout
// réseau) peuvent CHACUN voir "absent" avant que l'autre n'ait fini de créer
// -> DEUX fichiers "ev-x.piloteo" physiques dans le MÊME dossier mensuel.
// ---------------------------------------------------------------------------
test("ATTAQUE angle 2 — putImmutable concurrent du même eventId : doublon physique possible (best-effort, §8b), mais SANS IMPACT logique (dédup listChanges, §8a)", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect(); // pas de course sur connect() ici : on isole l'angle 2.

  const blob = { eventId: "ev-race", createdAt: "2026-08-10T00:00:00.000Z", payload: { x: 1 } };

  const [r1, r2] = await Promise.all([
    adapter.putImmutable("event", "ev-race", blob),
    adapter.putImmutable("event", "ev-race", blob),
  ]);

  const filesNamed = [...drive.nodes.values()].filter((n) => n.name === "ev-race.piloteo");

  // Le doublon PHYSIQUE reste possible sous course (best-effort assumé, §8b) —
  // ce n'est PLUS l'enjeu : ce qui compte est son IMPACT, vérifié ci-dessous.
  assert.ok(filesNamed.length >= 1, "au moins un fichier 'ev-race.piloteo' existe");
  assert.deepEqual(r1, { id: "ev-race" });
  assert.deepEqual(r2, { id: "ev-race" });

  // CORRIGÉ §8a : même si `filesNamed.length > 1`, `listChanges` déduplique par
  // nom physique -> UNE SEULE entrée logique, jamais un double-traitement.
  const { changes } = await adapter.listChanges();
  assert.deepEqual(changes, [{ kind: "event", id: "ev-race" }], "CORRIGÉ §8a : un seul event logique malgré un éventuel doublon physique");

  // Et `get()` renvoie un contenu cohérent (les deux fichiers ont le MÊME
  // contenu ici -> pas de IMMUTABLE_CONFLICT, cas normal de retry idempotent).
  assert.deepEqual(await adapter.get("event", "ev-race"), blob);
});

// ---------------------------------------------------------------------------
// ANGLE 2bis — putImmutable concurrent du MÊME id avec DEUX CONTENUS
// DIFFÉRENTS. RECLASSÉ après §8b (revue adverse) : sous course PURE (les deux
// "check" voient "absent" en même temps), `putImmutable` peut encore laisser
// coexister deux fichiers physiques de contenus DIFFÉRENTS SANS lever
// `IMMUTABLE_CONFLICT` à l'écriture — ceci est un résidu EXPLICITEMENT accepté
// par le contrat §8b (« putImmutable reste best-effort idempotent ; la course
// résiduelle est rattrapée par la réconciliation À LA LECTURE »), PAS une
// violation silencieuse : `get`/`readMetadata` DÉTECTENT désormais la
// divergence et lèvent `IMMUTABLE_CONFLICT` dès la prochaine lecture — plus
// aucun risque de servir silencieusement l'un des deux contenus au hasard.
// ---------------------------------------------------------------------------
test("ATTAQUE angle 2bis — putImmutable concurrent, contenus DIFFÉRENTS : résidu accepté à l'écriture (§8b), mais IMMUTABLE_CONFLICT détecté à la LECTURE (CORRIGÉ)", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  const blobA = { eventId: "ev-conflict", createdAt: "2026-08-11T00:00:00.000Z", payload: { winner: "A" } };
  const blobB = { eventId: "ev-conflict", createdAt: "2026-08-11T00:00:00.000Z", payload: { winner: "B" } };

  const results = await Promise.allSettled([
    adapter.putImmutable("event", "ev-conflict", blobA),
    adapter.putImmutable("event", "ev-conflict", blobB),
  ]);

  const filesNamed = [...drive.nodes.values()].filter((n) => n.name === "ev-conflict.piloteo");
  const anyConflictRaisedAtWrite = results.some(
    (r) => r.status === "rejected" && r.reason instanceof ImmutableConflictError
  );

  if (filesNamed.length > 1) {
    // Résidu de course EXPLICITEMENT accepté par §8b (best-effort à l'écriture) —
    // documenté, pas une régression : ce test vérifie maintenant ce qui se
    // passe ENSUITE, à la lecture.
    assert.equal(anyConflictRaisedAtWrite, false, "confirmé : §8b n'exige PAS de détecter le conflit AU MOMENT de l'écriture concurrente elle-même");

    // CORRIGÉ §8b : la PROCHAINE lecture détecte la divergence et lève
    // IMMUTABLE_CONFLICT — jamais un choix silencieux entre les deux contenus.
    await assert.rejects(
      () => adapter.get("event", "ev-conflict"),
      (err) => err instanceof ImmutableConflictError && err.code === "IMMUTABLE_CONFLICT",
      "CORRIGÉ §8b : get() détecte la divergence de contenu et lève IMMUTABLE_CONFLICT, ne renvoie JAMAIS l'un des deux au hasard"
    );
    await assert.rejects(
      () => adapter.readMetadata("event", "ev-conflict"),
      (err) => err instanceof ImmutableConflictError,
      "readMetadata détecte aussi la divergence"
    );
  } else {
    // L'ordonnancement microtask de CETTE exécution a fait que l'une des deux
    // écritures a vu l'autre AVANT d'uploader : IMMUTABLE_CONFLICT a alors été
    // levé DIRECTEMENT à l'écriture (comportement normal, non concurrent réel).
    assert.equal(filesNamed.length, 1);
    assert.equal(anyConflictRaisedAtWrite, true, "un seul fichier créé -> l'autre appel doit avoir détecté le conflit à l'écriture");
  }
});

// ---------------------------------------------------------------------------
// ANGLE 3 (listChanges) — CASSÉ à l'origine (le curseur comparait `id`, opaque
// et NON corrélé au tri `(createdTime,name)` : sur collision de `createdTime`,
// un event neuf pouvait être sauté DÉFINITIVEMENT). CORRIGÉ §8a (round 1),
// puis SUPERSÉDÉ par §9a (round 2, revue adverse — bug de FOND #1) : le
// contrariant round 2 a montré qu'un simple curseur composite `(createdTime,
// seenIds)` restait dangereux pour un cas plus grave que la collision
// (`createdTime` Drive non garanti monotone avec l'ordre logique — voir
// `attack-p4r2-drive-cursor.test.mjs`). §9a fait donc PRIMER la correction sur
// l'efficacité : `listChanges` retourne désormais l'ensemble ordonné COMPLET
// à CHAQUE appel, curseur ignoré pour toute exclusion. La garantie "jamais
// sauté" tenue ici par §8a est donc encore plus fortement garantie par §9a —
// mais "jamais redélivré" (promesse spécifique à §8a) ne tient plus : c'est un
// arbitrage ASSUMÉ (voir en-tête de google-drive-adapter.js, §9a — la
// redélivrance est sans danger, SyncEngine/EventLog dédupliquent par eventId).
//
// On force la collision de `createdTime` directement sur les nodes du
// FakeDrive (legit : c'est le comportement RÉEL de Drive qu'on simule, pas
// une triche du test — Drive tronque `createdTime` à une résolution finie et
// deux écritures concurrentes PEUVENT obtenir le même horodatage serveur).
// ---------------------------------------------------------------------------
test("ATTAQUE angle 3 — listChanges : event à createdTime en collision n'est PLUS jamais sauté (CORRIGÉ §8a, ré-énumération complète §9a)", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  const T = "2026-08-15T12:00:00.000Z";

  // Étape 1 : un premier event "zzzz" (nom trié APRÈS "aaaa") est déjà présent,
  // avec un id Drive interne "lexicalement grand" (analogue à un id Drive
  // opaque réel — rien ne garantit qu'un id "récent" soit lexicalement plus
  // grand qu'un id "ancien").
  await adapter.putImmutable("event", "zzzz-event", { eventId: "zzzz-event", createdAt: T });
  const zNode = [...drive.nodes.values()].find((n) => n.name === "zzzz-event.piloteo");
  zNode.createdTime = T; // force la collision de timestamp (comportement Drive réel possible).
  drive.nodes.set("id-zz-BIG", { ...zNode, id: "id-zz-BIG" });
  drive.nodes.delete(zNode.id);

  const round1 = await adapter.listChanges();
  assert.deepEqual(round1.changes, [{ kind: "event", id: "zzzz-event" }]);
  assert.deepEqual(round1.cursor, { createdTime: T, seenIds: ["id-zz-BIG"] });

  // Étape 2 : un DEUXIÈME event "aaaa" arrive ENSUITE (il est donc réellement
  // "plus récent" côté application), avec le MÊME createdTime (collision) mais
  // un id Drive interne LEXICALEMENT PLUS PETIT que le cursor déjà émis
  // ("id-aa-SMALL" < "id-zz-BIG" en comparaison de chaînes) — parfaitement
  // plausible avec des ids Drive opaques réels (non ordonnés par le temps).
  await adapter.putImmutable("event", "aaaa-event", { eventId: "aaaa-event", createdAt: T });
  const aNode = [...drive.nodes.values()].find((n) => n.name === "aaaa-event.piloteo");
  aNode.createdTime = T;
  drive.nodes.set("id-aa-SMALL", { ...aNode, id: "id-aa-SMALL" });
  drive.nodes.delete(aNode.id);

  const round2 = await adapter.listChanges(round1.cursor);

  // §9a : round2.changes contient 'aaaa-event' ET 'zzzz-event' (ré-énumération
  // complète — le curseur n'exclut plus rien). La redélivrance de
  // 'zzzz-event' est un arbitrage ASSUMÉ (§9a prime la sûreté du "jamais
  // sauté" sur l'efficacité du "jamais redélivré").
  assert.deepEqual(
    round2.changes.map((c) => c.id).sort(),
    ["aaaa-event", "zzzz-event"],
    "§9a : 'aaaa-event' (createdTime en collision) est bien renvoyé — plus de perte silencieuse — et 'zzzz-event' est re-livré sans danger"
  );

  // Un 3e appel continue de renvoyer les DEUX (ensemble complet, toujours).
  const round3 = await adapter.listChanges(round2.cursor);
  assert.deepEqual(round3.changes.map((c) => c.id).sort(), ["aaaa-event", "zzzz-event"], "§9a : énumération complète stable, aucun des deux n'est jamais exclu");
});

// ---------------------------------------------------------------------------
// ANGLE 3bis — CASSÉ à l'origine (duplication au lieu du skip : selon l'ordre
// des ids en collision, le MÊME event déjà livré pouvait être REDÉLIVRÉ
// indéfiniment, alors que le CURSEUR restait figé — la préoccupation exacte de
// round 1). SUPERSÉDÉ par §9a (round 2) : la redélivrance elle-même n'est plus
// considérée comme une faute (voir angle 3 ci-dessus) — ce qui compte
// désormais est que RIEN ne soit jamais EXCLU, ce que ce test vérifie toujours.
// ---------------------------------------------------------------------------
test("ATTAQUE angle 3bis — listChanges : ensemble complet toujours renvoyé sur collision de createdTime (redélivrance assumée, §9a)", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  const T = "2026-09-01T00:00:00.000Z";

  // "xxxx" existe déjà, id lexicalement "moyen".
  await adapter.putImmutable("event", "xxxx-event", { eventId: "xxxx-event", createdAt: T });
  const xNode = [...drive.nodes.values()].find((n) => n.name === "xxxx-event.piloteo");
  xNode.createdTime = T;
  drive.nodes.set("id-m", { ...xNode, id: "id-m" });
  drive.nodes.delete(xNode.id);

  // "yyyy" existe déjà aussi, id lexicalement petit ("id-b" < "id-m").
  await adapter.putImmutable("event", "yyyy-event", { eventId: "yyyy-event", createdAt: T });
  const yNode = [...drive.nodes.values()].find((n) => n.name === "yyyy-event.piloteo");
  yNode.createdTime = T;
  drive.nodes.set("id-b", { ...yNode, id: "id-b" });
  drive.nodes.delete(yNode.id);

  const round1 = await adapter.listChanges();
  assert.deepEqual(round1.changes.map((c) => c.id).sort(), ["xxxx-event", "yyyy-event"]);
  assert.deepEqual(round1.cursor, { createdTime: T, seenIds: ["id-b", "id-m"] }, "seenIds couvre les DEUX ids vus, triés (createdTime,id) — curseur informatif, §9a");

  // Un nouvel event "wwww" arrive, même createdTime T, id lexicalement GRAND ("id-z" > "id-b").
  await adapter.putImmutable("event", "wwww-event", { eventId: "wwww-event", createdAt: T });
  const wNode = [...drive.nodes.values()].find((n) => n.name === "wwww-event.piloteo");
  wNode.createdTime = T;
  drive.nodes.set("id-z", { ...wNode, id: "id-z" });
  drive.nodes.delete(wNode.id);

  const round2 = await adapter.listChanges(round1.cursor);
  const ids2 = round2.changes.map((c) => c.id).sort();

  // §9a : les TROIS events sont renvoyés — le nouvel arrivant 'wwww-event' EST
  // livré (jamais sauté), et 'xxxx-event'/'yyyy-event' sont re-livrés (jamais
  // exclus) — la redélivrance est un arbitrage assumé, jamais une perte.
  assert.deepEqual(ids2, ["wwww-event", "xxxx-event", "yyyy-event"], "§9a : ensemble complet — le nouvel arrivant s'ajoute, rien n'est jamais exclu");

  // Un 3e appel continue de renvoyer les TROIS (ensemble complet, stable).
  const round3 = await adapter.listChanges(round2.cursor);
  assert.deepEqual(round3.changes.map((c) => c.id).sort(), ["wwww-event", "xxxx-event", "yyyy-event"]);
});
