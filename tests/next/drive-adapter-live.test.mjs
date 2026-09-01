// tests/next/drive-adapter-live.test.mjs
//
// Câblage REST réel de `GoogleDriveStorageAdapter` (Point 4,
// docs/next/DRIVE_LIVE_CONTRACT.md §6, cas 1-8) — contre un `fetch` MOCKÉ
// simulant l'API Drive v3 (AUCUN réseau réel : l'OAuth interactif ne peut pas
// être automatisé dans cet environnement, voir docs/next/DRIVE_LIVE_MANUAL.md).
//
// `FakeDrive` ci-dessous simule un sous-ensemble minimal, mais FIDÈLE au
// FORMAT RÉEL, de l'API Drive v3 : `files.list` (avec pagination
// `nextPageToken`), `files.create` (dossier, JSON) et l'upload multipart
// (`uploadType=multipart`, mêmes en-têtes/format que `tools/team-spike/index.html`
// et `GoogleDriveStorageAdapter._uploadMultipart`), et `files.get?alt=media`.
// Elle NE modélise QUE ce que l'adaptateur peut effectivement émettre (elle
// n'a pas besoin d'implémenter la totalité de l'API Drive).

import test from "node:test";
import assert from "node:assert/strict";

import {
  GoogleDriveStorageAdapter,
  ImmutableConflictError,
  DriveAuthError,
} from "../../src/storage/google-drive-adapter.js";
import { FakeDrive, FOLDER_MIME } from "./helpers/fake-drive.mjs";

const ROOT_ID = "root-workspace-1";

function makeAdapter(drive, { sleepCalls } = {}) {
  return new GoogleDriveStorageAdapter({
    oauthTokenProvider: async () => "fake-access-token",
    rootFolderId: ROOT_ID,
    fetchImpl: drive.fetch,
    sleepFn: async (ms) => {
      if (sleepCalls) sleepCalls.push(ms);
    },
    maxRetries: 4,
  });
}

// ---------------------------------------------------------------------------
// Cas 1 — connect() crée/résout l'arbre (create appelé seulement pour les
// dossiers absents).
// ---------------------------------------------------------------------------

test("Drive live — cas 1 : connect() résout l'arbre, create() seulement pour les dossiers absents", async () => {
  const drive = new FakeDrive();
  // "workspace" existe déjà sous la racine -> ne doit PAS être recréé.
  const existingWorkspaceId = drive.addFolder("workspace", ROOT_ID);
  const adapter = makeAdapter(drive);

  await adapter.connect();

  // members/events/keys/licenses absents -> 4 créations ; workspace déjà là -> 0.
  assert.equal(drive.createFolderCalls, 4);
  assert.equal(adapter._topFolders.workspace, existingWorkspaceId);
  const names = [...drive.nodes.values()].filter((n) => n.parents.includes(ROOT_ID)).map((n) => n.name).sort();
  assert.deepEqual(names, ["events", "keys", "licenses", "members", "workspace"]);

  // Idempotent : un second connect() ne refait AUCUN appel réseau.
  const callsBefore = drive.calls.length;
  await adapter.connect();
  assert.equal(drive.calls.length, callsBefore);
});

// ---------------------------------------------------------------------------
// Cas 2, 3, 4 — putImmutable : create, idempotence write-once, conflit immuable.
// ---------------------------------------------------------------------------

test("Drive live — cas 2/3/4 : putImmutable crée, dédup par nom (idempotent), IMMUTABLE_CONFLICT si contenu différent", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  const blob = { eventId: "ev-1", createdAt: "2026-08-15T09:00:00.000Z", entityType: "saisies", operation: "create", payload: { ok: true } };

  // Cas 2 : premier putImmutable -> upload multipart dans events/2026-08/.
  const r1 = await adapter.putImmutable("event", "ev-1", blob);
  assert.deepEqual(r1, { id: "ev-1" });
  assert.equal(drive.uploadCalls, 1);

  const uploaded = [...drive.nodes.values()].find((n) => n.name === "ev-1.piloteo");
  assert.ok(uploaded, "le fichier ev-1.piloteo doit exister");
  const monthFolder = drive.nodes.get(uploaded.parents[0]);
  assert.equal(monthFolder.name, "2026-08");
  assert.equal(monthFolder.mimeType, FOLDER_MIME);
  const eventsTop = drive.nodes.get(monthFolder.parents[0]);
  assert.equal(eventsTop.name, "events");
  assert.deepEqual(JSON.parse(uploaded.content), blob);

  // Cas 3 : putImmutable RÉPÉTÉ (retry après timeout) du MÊME id, MÊME contenu
  // -> succès idempotent, PAS de 2e create (dédup par nom) -> un seul fichier.
  const r2 = await adapter.putImmutable("event", "ev-1", blob);
  assert.deepEqual(r2, { id: "ev-1" });
  assert.equal(drive.uploadCalls, 1, "aucun 2e upload : dédup par nom");
  const allNamed = [...drive.nodes.values()].filter((n) => n.name === "ev-1.piloteo");
  assert.equal(allNamed.length, 1, "un seul fichier ev-1.piloteo, jamais de doublon");

  // Cas 4 : putImmutable du MÊME id avec un contenu DIFFÉRENT -> IMMUTABLE_CONFLICT,
  // jamais d'écrasement.
  const differentBlob = { ...blob, payload: { ok: false } };
  await assert.rejects(
    () => adapter.putImmutable("event", "ev-1", differentBlob),
    (err) => err instanceof ImmutableConflictError && err.code === "IMMUTABLE_CONFLICT"
  );
  assert.equal(drive.uploadCalls, 1, "toujours aucun 2e upload après le conflit détecté");
  assert.equal(JSON.parse([...drive.nodes.values()].find((n) => n.name === "ev-1.piloteo").content).payload.ok, true, "le contenu original n'a PAS été écrasé");
});

// ---------------------------------------------------------------------------
// Cas 5 — get() : absent -> null ; présent -> contenu.
// ---------------------------------------------------------------------------

test("Drive live — cas 5 : get() d'un id absent renvoie null, présent renvoie le contenu", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  assert.equal(await adapter.get("event", "introuvable"), null);

  const blob = { eventId: "ev-9", createdAt: "2026-08-20T00:00:00.000Z", payload: { x: 42 } };
  await adapter.putImmutable("event", "ev-9", blob);
  assert.deepEqual(await adapter.get("event", "ev-9"), blob);
});

// ---------------------------------------------------------------------------
// Correction #1 (revue vérificateur, bug bloquant) — isolation inter-workspace :
// `get`/`exists`/`readMetadata`/`putImmutable` d'un `kind` à nom CONSTANT
// (`workspace` -> `manifest.piloteo`, `license` -> `current.license`) DOIVENT
// scoper leur recherche Drive au dossier de CE workspace, jamais une recherche
// globale sur tout le Drive du compte. Ce test échoue sur une version qui
// interrogerait `name = '...'` SANS `'<parentId>' in parents`.
// ---------------------------------------------------------------------------

test("Drive live — correction #1 : get('workspace'/'license') ignore un fichier DU MÊME NOM situé HORS du dossier de ce workspace", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  // Fichier LEURRE : même nom EXACT que le manifeste (`manifest.piloteo`), posé
  // AVANT (créé plus tôt, donc trié en premier par (createdTime,name)) dans un
  // dossier totalement ÉTRANGER à ce workspace — simule le manifeste d'un AUTRE
  // workspace Pilotéo sur le MÊME compte Google Drive. Une recherche Drive
  // SANS contrainte de dossier parent le retrouverait `files[0]` en premier.
  const otherWorkspaceRoot = drive.addFolder("root-autre-workspace", null);
  const otherWorkspaceEventsFolder = drive.addFolder("events", otherWorkspaceRoot);
  drive.nodes.set("rogue-manifest", {
    id: "rogue-manifest",
    name: "manifest.piloteo",
    mimeType: "application/octet-stream",
    parents: [otherWorkspaceRoot],
    createdTime: "1970-01-01T00:00:00.000Z", // antérieur à tout : gagnerait un tri global naïf
    content: JSON.stringify({ workspaceId: "AUTRE-WORKSPACE-NE-DOIT-JAMAIS-ETRE-LU" }),
  });
  // Idem pour `license` (nom constant `current.license`).
  drive.nodes.set("rogue-license", {
    id: "rogue-license",
    name: "current.license",
    mimeType: "application/octet-stream",
    parents: [otherWorkspaceRoot],
    createdTime: "1970-01-01T00:00:00.000Z",
    content: JSON.stringify({ licenseOf: "AUTRE-WORKSPACE" }),
  });
  void otherWorkspaceEventsFolder;

  // AVANT que ce workspace n'ait lui-même de manifeste : get()/exists() ne
  // doivent PAS remonter le leurre de l'autre workspace.
  assert.equal(await adapter.get("workspace", "manifest"), null, "ne doit JAMAIS lire le manifeste d'un autre workspace");
  assert.equal(await adapter.exists("workspace", "manifest"), false);
  assert.equal(await adapter.get("license", "current"), null, "ne doit JAMAIS lire la licence d'un autre workspace");

  // Ce workspace écrit ENSUITE son propre manifeste — même nom de fichier,
  // dossier différent.
  const ownManifest = { workspaceId: "CE-WORKSPACE" };
  await adapter.putImmutable("workspace", "manifest", ownManifest);

  // get() doit retrouver SON PROPRE manifeste, jamais celui de l'autre
  // workspace, quel que soit l'ordre de tri global (le leurre est
  // délibérément antérieur pour piéger une recherche non scopée).
  assert.deepEqual(await adapter.get("workspace", "manifest"), ownManifest);

  // Vérification directe de la CAUSE du bug : la requête `files.list` émise
  // pour cette recherche contraint bien `'<topFolders.workspace>' in parents`
  // (jamais une recherche par nom seul).
  const listCalls = drive.calls.filter((c) => c.method === "GET" && c.url.includes("/drive/v3/files?"));
  const workspaceLookup = listCalls.find((c) => {
    const q = new URL(c.url).searchParams.get("q") || "";
    return q.includes("manifest.piloteo") && q.includes(`'${adapter._topFolders.workspace}' in parents`);
  });
  assert.ok(workspaceLookup, "la requête Drive pour 'manifest.piloteo' doit contraindre le dossier du workspace (in parents)");
});

// ---------------------------------------------------------------------------
// Cas 6 — listChanges suit nextPageToken JUSQU'AU BOUT (ne saute aucun event
// sur 2 pages, y compris réparti sur PLUSIEURS sous-dossiers mensuels).
// ---------------------------------------------------------------------------

test("Drive live — cas 6 : listChanges suit nextPageToken jusqu'au bout (aucun event sauté sur 2 pages)", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  const blobs = [
    { eventId: "e-a", createdAt: "2026-08-01T00:00:00.000Z" },
    { eventId: "e-b", createdAt: "2026-08-15T00:00:00.000Z" },
    { eventId: "e-c", createdAt: "2026-09-01T00:00:00.000Z" },
    { eventId: "e-d", createdAt: "2026-09-02T00:00:00.000Z" },
  ];
  for (const b of blobs) {
    await adapter.putImmutable("event", b.eventId, b);
  }

  // Force la pagination : jamais plus d'un fichier par page, quelle que soit la
  // taille de page demandée par l'adaptateur -> plusieurs pages, sur 2 dossiers
  // mensuels distincts (2026-08 avec 2 events, 2026-09 avec 2 events).
  drive.maxPageItems = 1;
  const listCallsBefore = drive.calls.filter((c) => c.method === "GET" && c.url.includes("/drive/v3/files?")).length;

  const { changes, cursor } = await adapter.listChanges();

  const listCallsAfter = drive.calls.filter((c) => c.method === "GET" && c.url.includes("/drive/v3/files?")).length;
  assert.ok(listCallsAfter - listCallsBefore > 4, "plusieurs appels files.list ont bien eu lieu (pagination suivie)");

  const ids = changes.map((c) => c.kind === "event" && c.id).sort();
  assert.deepEqual(ids, ["e-a", "e-b", "e-c", "e-d"], "AUCUN event sauté malgré la pagination sur 2 sous-dossiers mensuels");
  // Curseur §8a (post-revue adverse) : {createdTime, seenIds}, plus un simple {createdTime,id}.
  assert.ok(cursor && cursor.createdTime && Array.isArray(cursor.seenIds) && cursor.seenIds.length > 0, "un curseur exploitable est renvoyé");

  // §9a (révision round 2, bug de FOND) : listChanges retourne désormais
  // l'ensemble ORDONNÉ COMPLET à CHAQUE appel — le curseur n'exclut plus rien
  // (createdTime Drive n'est pas garanti monotone avec l'ordre logique, cf.
  // en-tête de google-drive-adapter.js). Rejouer avec le curseur RE-livre donc
  // les 4 events déjà vus — SANS DANGER (SyncEngine/EventLog dédupliquent par
  // eventId) — plutôt que d'exclure quoi que ce soit.
  const second = await adapter.listChanges(cursor);
  assert.deepEqual(second.changes.map((c) => c.id).sort(), ["e-a", "e-b", "e-c", "e-d"], "§9a : ré-énumération complète, jamais un filtrage qui pourrait exclure");

  // Un nouvel event est bien inclus, EN PLUS des 4 déjà vus (jamais à leur place).
  drive.maxPageItems = Infinity;
  await adapter.putImmutable("event", "e-e", { eventId: "e-e", createdAt: "2026-09-03T00:00:00.000Z" });
  const third = await adapter.listChanges(cursor);
  assert.deepEqual(third.changes.map((c) => c.id).sort(), ["e-a", "e-b", "e-c", "e-d", "e-e"], "§9a : le nouvel event s'ajoute à l'ensemble complet, toujours renvoyé en entier");
});

// ---------------------------------------------------------------------------
// Cas 7 — 429 puis 200 : retry réussi (<= 4 essais, backoff appelé).
// ---------------------------------------------------------------------------

test("Drive live — cas 7 : 429 puis 200 -> retry réussi (backoff appelé, <= 4 essais)", async () => {
  const drive = new FakeDrive();
  const sleepCalls = [];
  const adapter = makeAdapter(drive, { sleepCalls });

  drive.forceNext(429, "Rate Limit Exceeded");
  await adapter.connect(); // ne doit PAS lever : le 2e essai (200) doit passer.

  assert.equal(sleepCalls.length, 1, "un seul retry -> backoff appelé une fois");
  assert.ok(adapter._topFolders && adapter._topFolders.workspace, "connect() a bien fini par réussir");
});

test("Drive live — cas 7bis : 5 x 429 d'affilée épuise les essais (<=4) et échoue explicitement", async () => {
  const drive = new FakeDrive();
  const sleepCalls = [];
  const adapter = makeAdapter(drive, { sleepCalls });

  for (let i = 0; i < 5; i++) drive.forceNext(429, "Rate Limit Exceeded");
  await assert.rejects(() => adapter.connect());
  assert.ok(sleepCalls.length <= 4, "jamais plus de 4 essais au total");
});

// ---------------------------------------------------------------------------
// Cas 8 — 401 -> AUTH_ERROR (déclenche re-token), sans retry.
// ---------------------------------------------------------------------------

test("Drive live — cas 8 : 401 -> AUTH_ERROR immédiat (pas de retry, re-token à la charge de l'appelant)", async () => {
  const drive = new FakeDrive();
  const sleepCalls = [];
  const adapter = makeAdapter(drive, { sleepCalls });

  drive.forceNext(401, "Invalid Credentials");
  await assert.rejects(
    () => adapter.connect(),
    (err) => err instanceof DriveAuthError && err.code === "AUTH_ERROR"
  );
  assert.equal(sleepCalls.length, 0, "401 ne déclenche AUCUN retry — juste une erreur immédiate à re-tenter avec un nouveau token");

  // Le module reste utilisable une fois un token valide de nouveau disponible
  // (simulé ici par un connect() sans 401 forcé — "re-demander un token" est la
  // responsabilité de l'appelant/piloteo-drive-bridge.mjs, cf. DRIVE_LIVE_MANUAL.md).
  await adapter.connect();
  assert.ok(adapter._topFolders && adapter._topFolders.workspace);
});

// ---------------------------------------------------------------------------
// §8 — Révision post-revue adverse (docs/next/DRIVE_LIVE_CONTRACT.md §8).
// Tests EXPLICITEMENT requis par le contrat, en plus des repros du
// contrariant réutilisées/corrigées dans attack-p4-drive-races.test.mjs et
// attack-p4-drive-misc.test.mjs (mêmes angles, mêmes scénarios — voir ces
// fichiers pour la démonstration détaillée « CASSÉ avant / CORRIGÉ après »).
// ---------------------------------------------------------------------------

test("§8a/§9a — listChanges : deux events du MÊME createdTime -> jamais sauté ; ré-énumération complète à chaque appel (§9a prime sur l'exclusion par curseur)", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  const T = "2026-08-20T10:00:00.000Z";
  await adapter.putImmutable("event", "ev-x", { eventId: "ev-x", createdAt: T });
  await adapter.putImmutable("event", "ev-y", { eventId: "ev-y", createdAt: T });
  // Force la collision EXACTE de createdTime (résolution finie de l'horodatage
  // serveur Drive — cf. attack-p4-drive-races.test.mjs angle 3).
  for (const n of drive.nodes.values()) {
    if (n.name === "ev-x.piloteo" || n.name === "ev-y.piloteo") n.createdTime = T;
  }

  const round1 = await adapter.listChanges();
  assert.deepEqual(round1.changes.map((c) => c.id).sort(), ["ev-x", "ev-y"], "aucun des deux n'est sauté");
  assert.equal(round1.cursor.createdTime, T);
  assert.equal(round1.cursor.seenIds.length, 2, "les deux fichiers du createdTime en collision sont dans seenIds (curseur informatif, §9a)");

  // §9a (révision round 2, PRIME sur §8a) : rejouer avec ce curseur RE-livre
  // les deux events déjà vus — listChanges ne filtre plus JAMAIS par curseur,
  // pour ne jamais risquer d'exclure un event à `createdTime` non-monotone
  // (voir en-tête de google-drive-adapter.js, §9a). La redélivrance est SANS
  // DANGER (SyncEngine/EventLog dédupliquent par eventId).
  const round2 = await adapter.listChanges(round1.cursor);
  assert.deepEqual(round2.changes.map((c) => c.id).sort(), ["ev-x", "ev-y"], "§9a : ré-énumération complète, jamais un filtrage");

  // Un troisième event au MÊME createdTime, ARRIVANT APRÈS le premier appel,
  // est bien inclus, EN PLUS des deux premiers (jamais à la place — §9a).
  await adapter.putImmutable("event", "ev-z", { eventId: "ev-z", createdAt: T });
  for (const n of drive.nodes.values()) {
    if (n.name === "ev-z.piloteo") n.createdTime = T;
  }
  const round3 = await adapter.listChanges(round2.cursor);
  assert.deepEqual(round3.changes.map((c) => c.id).sort(), ["ev-x", "ev-y", "ev-z"], "§9a : le nouvel arrivant s'ajoute, ev-x/ev-y restent présents (ensemble complet)");
});

test("§8b — double putImmutable('workspace','manifest') concurrent avec IDENTITÉS DIFFÉRENTES -> IMMUTABLE_CONFLICT détecté à la lecture", async () => {
  // Simule createDriveEventBackend#init() (piloteo-drive-bridge.mjs) : deux
  // « appareils » créent chacun leur propre identité de workspace (get-or-create
  // du manifeste) sur le MÊME workspace Drive tout neuf, en concurrence pure.
  const drive = new FakeDrive();
  const adapterA = makeAdapter(drive);
  const adapterB = makeAdapter(drive);
  await Promise.all([adapterA.connect(), adapterB.connect()]);

  const manifestA = { workspaceId: "WS-FROM-A", actorId: "actor-A", epoch: 1 };
  const manifestB = { workspaceId: "WS-FROM-B", actorId: "actor-B", epoch: 1 };

  const results = await Promise.allSettled([
    adapterA.putImmutable("workspace", "manifest", manifestA),
    adapterB.putImmutable("workspace", "manifest", manifestB),
  ]);

  const manifestFiles = [...drive.nodes.values()].filter((n) => n.name === "manifest.piloteo");
  if (manifestFiles.length > 1) {
    // Résidu de course accepté à l'écriture (§8b, best-effort) : la lecture
    // SUIVANTE doit détecter la divergence, jamais choisir l'un au hasard.
    await assert.rejects(
      () => adapterA.get("workspace", "manifest"),
      (err) => err instanceof ImmutableConflictError && err.code === "IMMUTABLE_CONFLICT",
      "IMMUTABLE_CONFLICT attendu : deux manifestes de contenus différents coexistent"
    );
    await assert.rejects(
      () => adapterB.get("workspace", "manifest"),
      (err) => err instanceof ImmutableConflictError,
      "le conflit est détecté quel que soit l'adaptateur qui lit"
    );
  } else {
    // L'un des deux putImmutable a vu l'autre AVANT d'écrire : conflit détecté
    // directement à l'écriture (pas de résidu de course dans cette exécution).
    const anyRejectedWithConflict = results.some((r) => r.status === "rejected" && r.reason instanceof ImmutableConflictError);
    assert.ok(anyRejectedWithConflict, "si un seul manifeste existe, l'AUTRE putImmutable doit avoir levé IMMUTABLE_CONFLICT");
    // Et la lecture reste cohérente (un seul contenu, pas de conflit à la lecture).
    const read = await adapterA.get("workspace", "manifest");
    assert.ok(read.workspaceId === "WS-FROM-A" || read.workspaceId === "WS-FROM-B");
  }
});
