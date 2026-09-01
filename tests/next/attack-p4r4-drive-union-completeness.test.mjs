// tests/next/attack-p4r4-drive-union-completeness.test.mjs
//
// CONTRARIANT round 4 (FINAL) — Point 4 (Google Drive live), classe
// "duplication de dossiers / perte de données". §10 a fait unir toutes les
// LECTURES (`listChanges`, `_findAllFilesByNameInKindSubtree` donc
// `get`/`exists`/`readMetadata`) sur TOUS les dossiers top-level dupliqués,
// pendant que les ÉCRITURES continuent de converger vers le plus ancien
// (`_liveTopFolder`, oldest-wins, §9b, inchangé).
//
// Ce fichier tente de re-casser cette classe de faille avec des scénarios PLUS
// exigeants que ceux des rounds précédents : 3 dossiers top-level "events"
// dupliqués (pas 2) avec l'event physiquement dans le 3e ; une pagination
// forcée pendant la résolution des dossiers dupliqués eux-mêmes ; un
// sous-dossier mensuel dupliqué À L'INTÉRIEUR d'un même dossier top-level ;
// les deux issues d'IMMUTABLE_CONFLICT inter-dossiers (vraie divergence vs.
// faux conflit sur contenu identique) ; le winner-first best-effort à travers
// deux dossiers différents (succès ET échec attendu) ; et une non-régression
// explicite sur la convergence des ÉCRITURES (le refactor
// _liveTopFolder/_allTopFolderIds ne doit PAS avoir fait déraper les écritures
// vers plusieurs dossiers).
//
// Verdict rendu en fin de fichier (commentaire) après exécution.

import test from "node:test";
import assert from "node:assert/strict";

import { GoogleDriveStorageAdapter, ImmutableConflictError } from "../../src/storage/google-drive-adapter.js";
import { FakeDrive } from "./helpers/fake-drive.mjs";

const ROOT_ID = "root-workspace-r4-union";

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
// Angle 1a — TROIS dossiers top-level "events" dupliqués, event physiquement
// dans le 3e (le plus RÉCENT, donc jamais le gagnant en écriture) ; pagination
// forcée à 1 élément par page pendant la résolution de _allTopFolderIds elle-
// même, pour vérifier qu'aucun des 3 dossiers n'est perdu par une pagination
// partielle.
// ---------------------------------------------------------------------------
test("angle 1a — 3 dossiers top-level 'events' dupliqués + event dans le 3e + pagination forcée : listChanges/get le voient", async () => {
  const drive = new FakeDrive();

  // Trois dossiers "events" concurrents, créés directement (simulateur d'une
  // triple course de création — pire cas que les rounds précédents qui n'en
  // testaient que 2).
  const t0 = "2026-01-01T00:00:00.000Z";
  const folderOldest = drive.addFolder("events", ROOT_ID, { createdTime: t0 });
  const folderMiddle = drive.addFolder("events", ROOT_ID, { createdTime: "2026-01-01T00:01:00.000Z" });
  const folderThird = drive.addFolder("events", ROOT_ID, { createdTime: "2026-01-01T00:02:00.000Z" });

  // Un event écrit directement dans le 3e dossier (le plus récent) — simule un
  // membre qui a écrit là AVANT que la convergence oldest-wins ne s'établisse.
  const monthFolder = drive.addFolder("2026-01", folderThird, { createdTime: "2026-01-01T00:03:00.000Z" });
  drive.nodes.set("ev-in-third", {
    id: "ev-in-third",
    name: "ev-in-third.piloteo",
    mimeType: "application/octet-stream",
    parents: [monthFolder],
    createdTime: "2026-01-01T00:04:00.000Z",
    content: JSON.stringify({ eventId: "ev-in-third", createdAt: "2026-01-01T00:04:00.000Z" }),
    size: 10,
  });

  const adapter = makeAdapter(drive);
  // Force la pagination à 1 élément par page PENDANT la résolution des
  // dossiers top-level dupliqués eux-mêmes (et de leurs sous-dossiers) — un
  // `_allTopFolderIds`/`_findAllFolders` qui ne suivrait pas `nextPageToken`
  // jusqu'au bout perdrait silencieusement le 2e et/ou 3e dossier "events".
  drive.maxPageItems = 1;
  await adapter.connect();

  const { changes } = await adapter.listChanges();
  assert.deepEqual(
    changes.map((c) => c.id).sort(),
    ["ev-in-third"],
    "listChanges trouve l'event physiquement présent dans le 3e dossier top-level dupliqué, malgré une pagination forcée à 1 élément/page"
  );

  const got = await adapter.get("event", "ev-in-third");
  assert.deepEqual(got, { eventId: "ev-in-third", createdAt: "2026-01-01T00:04:00.000Z" }, "get() trouve aussi l'event du 3e dossier");
  assert.equal(await adapter.exists("event", "ev-in-third"), true, "exists() aussi");

  // Sanity : les écritures, elles, convergent bien vers le dossier le plus
  // ancien (oldest-wins, §9b) — pas vers le 3e.
  await adapter.putImmutable("event", "ev-new", { eventId: "ev-new", createdAt: "2026-01-02T00:00:00.000Z" });
  const newNode = [...drive.nodes.values()].find((n) => n.name === "ev-new.piloteo");
  const newNodeMonthFolder = drive.nodes.get(newNode.parents[0]);
  assert.equal(newNodeMonthFolder.parents[0], folderOldest, "sanity : les nouvelles écritures convergent vers le dossier top-level le PLUS ANCIEN, pas le 3e");
});

// ---------------------------------------------------------------------------
// Angle 1b — sous-dossier mensuel DUPLIQUÉ à l'intérieur d'un même dossier
// top-level "events" (deux dossiers "2026-08" sous le MÊME parent) — event
// dans chacun. Aucune perte attendue : `_listSubfolders` énumère tous les
// sous-dossiers sans filtrer par nom.
// ---------------------------------------------------------------------------
test("angle 1b — sous-dossier mensuel dupliqué DANS un même dossier top-level : les deux events sont vus", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();
  const eventsTopId = adapter._topFolders.event;

  await adapter.putImmutable("event", "ev-month-a", { eventId: "ev-month-a", createdAt: "2026-08-01T00:00:00.000Z" });
  const monthNodeId = [...drive.nodes.values()].find((n) => n.name === "ev-month-a.piloteo").parents[0];
  const monthNode = drive.nodes.get(monthNodeId);

  // Un SECOND dossier "2026-08" apparaît sous le MÊME parent "events" (course
  // de création sur `_ensureFolder(monthFolder(...), topId)` par un autre
  // client, jamais nettoyée).
  const duplicateMonthId = drive.addFolder("2026-08", eventsTopId, {
    createdTime: new Date(new Date(monthNode.createdTime).getTime() + 1000).toISOString(),
  });
  drive.nodes.set("ev-month-b", {
    id: "ev-month-b",
    name: "ev-month-b.piloteo",
    mimeType: "application/octet-stream",
    parents: [duplicateMonthId],
    createdTime: "2026-08-01T00:05:00.000Z",
    content: JSON.stringify({ eventId: "ev-month-b", createdAt: "2026-08-01T00:05:00.000Z" }),
    size: 10,
  });

  const { changes } = await adapter.listChanges();
  assert.deepEqual(
    changes.map((c) => c.id).sort(),
    ["ev-month-a", "ev-month-b"],
    "les deux events, dans les deux dossiers mensuels dupliqués du MÊME dossier top-level, sont vus"
  );
  assert.deepEqual(await adapter.get("event", "ev-month-b"), { eventId: "ev-month-b", createdAt: "2026-08-01T00:05:00.000Z" });
});

// ---------------------------------------------------------------------------
// Angle 2a — IMMUTABLE_CONFLICT inter-dossiers : deux manifestes RÉELLEMENT
// divergents dans deux dossiers "workspace" dupliqués -> conflit levé, jamais
// un null ni un choix arbitraire (corrobore §10b avec un contenu different de
// celui du test p4r3 : le doublon divergent est cette fois dans le dossier le
// PLUS ANCIEN, pas le plus récent, pour vérifier que ça ne dépend pas de
// l'ordre).
// ---------------------------------------------------------------------------
test("angle 2a — IMMUTABLE_CONFLICT bien levé quand le manifeste divergent vit dans le dossier top-level le PLUS ANCIEN (pas le plus récent)", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();
  const workspaceTopId = adapter._topFolders.workspace;

  const manifestA = { orgId: "org-A", createdBy: "member-a" };
  await adapter.putImmutable("workspace", "genesis", manifestA);
  const nodeA = [...drive.nodes.values()].find((n) => n.name === "manifest.piloteo");

  // Dossier "workspace" concurrent, PLUS ANCIEN que celui de A, contenant DÉJÀ
  // un manifeste DIFFÉRENT.
  const earlier = new Date(new Date(nodeA.createdTime).getTime() - 120_000).toISOString();
  const olderTopFolderId = drive.addFolder("workspace", ROOT_ID, { createdTime: earlier });
  const manifestB = { orgId: "org-B", createdBy: "member-b" };
  drive.nodes.set("manifest-in-older-top-folder", {
    id: "manifest-in-older-top-folder",
    name: "manifest.piloteo",
    mimeType: "application/octet-stream",
    parents: [olderTopFolderId],
    createdTime: earlier,
    content: JSON.stringify(manifestB),
    size: JSON.stringify(manifestB).length,
  });

  await assert.rejects(
    () => adapter.get("workspace", "genesis"),
    (err) => err instanceof ImmutableConflictError && err.code === "IMMUTABLE_CONFLICT",
    "IMMUTABLE_CONFLICT bien levé, même quand le candidat divergent est dans le dossier top-level le PLUS ANCIEN"
  );
  await assert.rejects(
    () => adapter.readMetadata("workspace", "genesis"),
    (err) => err instanceof ImmutableConflictError,
    "readMetadata() lève aussi IMMUTABLE_CONFLICT, cohérent avec get()"
  );
});

// ---------------------------------------------------------------------------
// Angle 2b — cas inverse : deux manifestes de contenu IDENTIQUE (même JSON
// canonique) dans deux dossiers "workspace" dupliqués -> PAS de faux conflit.
// ---------------------------------------------------------------------------
test("angle 2b — deux manifestes IDENTIQUES dans deux dossiers top-level dupliqués -> PAS de faux IMMUTABLE_CONFLICT", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();
  const workspaceTopId = adapter._topFolders.workspace;

  const manifest = { orgId: "org-1", createdBy: "member-a" };
  await adapter.putImmutable("workspace", "genesis", manifest);
  const nodeA = [...drive.nodes.values()].find((n) => n.name === "manifest.piloteo");

  // Dossier "workspace" concurrent, contenant un manifeste IDENTIQUE (résidu
  // de course inoffensif — les deux créateurs avaient exactement le même
  // contenu logique, ex: rejeu du même appelant après un timeout).
  const olderTopFolderId = drive.addFolder("workspace", ROOT_ID, {
    createdTime: new Date(new Date(nodeA.createdTime).getTime() - 60_000).toISOString(),
  });
  drive.nodes.set("manifest-identical-dup", {
    id: "manifest-identical-dup",
    name: "manifest.piloteo",
    mimeType: "application/octet-stream",
    parents: [olderTopFolderId],
    createdTime: new Date(new Date(nodeA.createdTime).getTime() - 60_000).toISOString(),
    content: nodeA.content, // BYTE-identique
    size: nodeA.size,
  });

  const result = await adapter.get("workspace", "genesis");
  assert.deepEqual(result, manifest, "pas de conflit : contenu identique entre les deux dossiers dupliqués -> lecture réussie normale");

  const meta = await adapter.readMetadata("workspace", "genesis");
  assert.equal(meta.fileId, "manifest-identical-dup", "readMetadata() retient bien le PLUS ANCIEN des deux candidats identiques (oldest-wins cohérent)");
});

// ---------------------------------------------------------------------------
// Angle 3 — winner-first best-effort À TRAVERS deux dossiers top-level
// différents : (a) gagnant dans A lisible + orphelin 5xx persistant dans B ->
// succès ; (b) 5xx PERSISTANT sur le gagnant lui-même -> get() échoue (ne
// bascule jamais silencieusement sur un candidat non-gagnant).
// ---------------------------------------------------------------------------
test("angle 3a — gagnant lisible dans le dossier A, orphelin 5xx persistant dans le dossier B -> get() réussit quand même", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  const manifest = { orgId: "org-1" };
  await adapter.putImmutable("workspace", "genesis", manifest);
  const winnerNode = [...drive.nodes.values()].find((n) => n.name === "manifest.piloteo");

  const otherTopFolderId = drive.addFolder("workspace", ROOT_ID, {
    createdTime: new Date(new Date(winnerNode.createdTime).getTime() + 30_000).toISOString(),
  });
  const orphanId = "orphan-in-B";
  drive.nodes.set(orphanId, {
    id: orphanId,
    name: "manifest.piloteo",
    mimeType: "application/octet-stream",
    parents: [otherTopFolderId],
    createdTime: new Date(new Date(winnerNode.createdTime).getTime() + 31_000).toISOString(),
    content: winnerNode.content,
    size: winnerNode.size,
  });
  drive.forceDownloadFailure(orphanId, 503, "Service Unavailable");

  assert.deepEqual(
    await adapter.get("workspace", "genesis"),
    manifest,
    "get() réussit : le gagnant (dossier A) est lisible, l'orphelin illisible (dossier B) est absorbé en best-effort"
  );
});

test("angle 3b — 5xx PERSISTANT sur le GAGNANT lui-même -> get() échoue (ne bascule jamais sur un non-gagnant)", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  const manifest = { orgId: "org-1" };
  await adapter.putImmutable("workspace", "genesis", manifest);
  const winnerNode = [...drive.nodes.values()].find((n) => n.name === "manifest.piloteo");

  // Un doublon PLUS RÉCENT (jamais le gagnant), parfaitement lisible, existe
  // dans un AUTRE dossier top-level.
  const otherTopFolderId = drive.addFolder("workspace", ROOT_ID, {
    createdTime: new Date(new Date(winnerNode.createdTime).getTime() + 30_000).toISOString(),
  });
  drive.nodes.set("dup-in-B-readable", {
    id: "dup-in-B-readable",
    name: "manifest.piloteo",
    mimeType: "application/octet-stream",
    parents: [otherTopFolderId],
    createdTime: new Date(new Date(winnerNode.createdTime).getTime() + 31_000).toISOString(),
    content: winnerNode.content,
    size: winnerNode.size,
  });

  // Le GAGNANT lui-même devient illisible de façon persistante.
  drive.forceDownloadFailure(winnerNode.id, 500, "Internal Server Error");

  await assert.rejects(
    () => adapter.get("workspace", "genesis"),
    "get() DOIT échouer si le gagnant lui-même est illisible, même si un doublon lisible existe ailleurs (rien ne peut légitimement le remplacer)"
  );
});

// ---------------------------------------------------------------------------
// Angle 4 — régression écriture : les écritures convergent TOUJOURS vers UN
// SEUL dossier malgré le refactor _liveTopFolder -> _allTopFolderIds. Deux
// putImmutable (kinds différents ET même kind) avec 3 dossiers top-level
// dupliqués déjà en place dès le départ ne doivent JAMAIS se disperser.
// ---------------------------------------------------------------------------
test("angle 4 — régression écriture : deux putImmutable ne se dispersent PAS dans plusieurs dossiers top-level malgré 3 dossiers dupliqués préexistants", async () => {
  const drive = new FakeDrive();

  // 3 dossiers "events" dupliqués, déjà présents AVANT connect().
  const oldest = drive.addFolder("events", ROOT_ID, { createdTime: "2026-01-01T00:00:00.000Z" });
  drive.addFolder("events", ROOT_ID, { createdTime: "2026-01-01T00:01:00.000Z" });
  drive.addFolder("events", ROOT_ID, { createdTime: "2026-01-01T00:02:00.000Z" });

  const adapter = makeAdapter(drive);
  await adapter.connect();
  assert.equal(adapter._topFolders.event, oldest, "connect() résout bien le plus ancien des 3 dossiers dupliqués");

  await adapter.putImmutable("event", "ev-1", { eventId: "ev-1", createdAt: "2026-02-01T00:00:00.000Z" });
  await adapter.putImmutable("event", "ev-2", { eventId: "ev-2", createdAt: "2026-02-02T00:00:00.000Z" });
  await adapter.putImmutable("event", "ev-3", { eventId: "ev-3", createdAt: "2026-02-02T00:00:00.000Z" });

  const monthFolderIds = new Set(
    [...drive.nodes.values()].filter((n) => n.name.endsWith(".piloteo")).map((n) => n.parents[0])
  );
  const topFoldersUsed = new Set([...monthFolderIds].map((mfId) => drive.nodes.get(mfId).parents[0]));
  assert.deepEqual(
    [...topFoldersUsed],
    [oldest],
    "toutes les écritures d'events convergent vers le SEUL dossier top-level le plus ancien, jamais dispersées entre les 3 dossiers dupliqués"
  );

  // Idem pour un AUTRE kind (license, singleton) — même garantie. Workspace
  // ISOLÉ (racine et FakeDrive séparés) pour que les dossiers "licenses"
  // dupliqués posés ICI, avec des `createdTime` choisis à la main, ne soient
  // pas court-circuités par le dossier "licenses" que `connect()` a déjà créé
  // plus tôt dans CE test (à l'horodatage interne du FakeDrive partagé,
  // antérieur à tout ce qu'on pose ensuite).
  const drive2 = new FakeDrive();
  const ROOT_ID_2 = "root-workspace-r4-union-license";
  const oldestLicense = drive2.addFolder("licenses", ROOT_ID_2, { createdTime: "2026-01-01T00:00:00.000Z" });
  drive2.addFolder("licenses", ROOT_ID_2, { createdTime: "2026-01-01T00:01:00.000Z" });
  const adapter2 = makeAdapter(drive2, { rootFolderId: ROOT_ID_2 });
  await adapter2.connect();
  await adapter2.putImmutable("license", "current", { licenseId: "current", seats: 5 });
  const licenseNode = [...drive2.nodes.values()].find((n) => n.name === "current.license");
  assert.equal(licenseNode.parents[0], oldestLicense, "l'écriture d'un singleton (license) converge aussi vers le SEUL dossier top-level le plus ancien");
});

// ---------------------------------------------------------------------------
// Angle 6 (spot checks anti-régression, un par round précédent) —
// (a) round 1 §8a : deux events de même createdTime -> ni sauté ni perdu, curseur cohérent.
// (b) round 1/2 §8d/§9e : 403 quota (format google.rpc.Status) -> retry, pas AUTH_ERROR.
// (c) round 2 §9d : canonicalStringify — deux ordres de clés -> même texte.
// ---------------------------------------------------------------------------
test("angle 6a (non-régression §8a) — deux events de MÊME createdTime : aucun sauté, aucun perdu", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  await adapter.putImmutable("event", "ev-tie-1", { eventId: "ev-tie-1", createdAt: "2026-03-01T00:00:00.000Z" });
  await adapter.putImmutable("event", "ev-tie-2", { eventId: "ev-tie-2", createdAt: "2026-03-01T00:00:00.000Z" });
  const n1 = [...drive.nodes.values()].find((n) => n.name === "ev-tie-1.piloteo");
  const n2 = [...drive.nodes.values()].find((n) => n.name === "ev-tie-2.piloteo");
  n1.createdTime = n2.createdTime; // force une collision EXACTE de createdTime.

  const { changes } = await adapter.listChanges();
  assert.deepEqual(changes.map((c) => c.id).sort(), ["ev-tie-1", "ev-tie-2"], "non-régression §8a : collision de createdTime -> les deux events sont bien présents");
});

test("angle 6b (non-régression §9e) — 403 RESOURCE_EXHAUSTED (google.rpc.Status) -> retry, pas AUTH_ERROR", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  drive.forceNext(403, JSON.stringify({ error: { code: 403, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } }));
  await adapter.connect();
  assert.equal(adapter._connected, true, "non-régression §9e : un 403 RESOURCE_EXHAUSTED est bien retenté (connect() aboutit), pas une AUTH_ERROR immédiate");
});

test("angle 6c (non-régression §9d) — canonicalStringify : deux ordres de clés -> pas de faux conflit sur un blob 'key'", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  const blobA = { epoch: 3, keyId: "k1", material: { x: 1, y: 2 } };
  const blobB = { material: { y: 2, x: 1 }, keyId: "k1", epoch: 3 };
  await adapter.putImmutable("key", "k1", blobA);
  const result = await adapter.putImmutable("key", "k1", blobB);
  assert.deepEqual(result, { id: "k1" }, "non-régression §9d : ordre de clés différent, contenu logique identique -> succès idempotent, pas de conflit");
});
