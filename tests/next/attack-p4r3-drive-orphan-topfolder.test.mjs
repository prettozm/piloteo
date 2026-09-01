// tests/next/attack-p4r3-drive-orphan-topfolder.test.mjs
//
// CONTRARIANT round 3 — Point 4 (Google Drive live), angle "dossier top-level orphelin".
//
// §9b (_liveTopFolder) garantit qu'une instance déjà vivante finit par ADOPTER
// le dossier top-level réellement le plus ancien pour ses écritures FUTURES.
// Mais ce correctif ne dit RIEN de ce qui arrive au contenu déjà écrit dans le
// dossier qu'elle abandonne : ce contenu n'est jamais migré, et surtout,
// PLUS AUCUNE instance — même une instance FRAÎCHE qui n'a jamais connu
// l'ancien dossier, même APRÈS convergence complète de tout le monde — ne le
// reverra jamais, parce que TOUTES les lectures (`listChanges`, `get`,
// `readMetadata`, `exists`) ne regardent QUE le sous-arbre du dossier
// GAGNANT (`_liveTopFolder`), jamais les autres dossiers du même nom.
//
// Le contrat §9a l'interdit pourtant explicitement : « Interdit : tout chemin
// où un event réel n'est jamais renvoyé. » Le test round 2
// (attack-p4r2-drive-connect-sweep) prouve DÉJÀ que `ev-from-a` n'est plus
// jamais renvoyé par `listChanges` — mais il documente ça comme un « résidu
// de course », pas comme une violation. Ce test va plus loin sur deux points :
//
//  1. Il montre que ce n'est PAS une simple histoire de "propagation pas
//     encore terminée" : même une TROISIÈME instance, connectée LONGTEMPS
//     après que tout le monde a convergé (et qui n'a donc jamais vu l'ancien
//     dossier "vivant"), ne verra JAMAIS l'event orphelin. Ce n'est pas un
//     retard temporaire, c'est une exclusion PERMANENTE et STRUCTURELLE.
//  2. Il montre que le MÊME mécanisme s'applique aux SINGLETONS à nom
//     constant (`manifest.piloteo`) : `get()` n'y détecte pas un
//     `IMMUTABLE_CONFLICT` (comme documenté pour la divergence de contenu
//     DANS le même dossier) — il renvoie silencieusement `null`, comme si le
//     manifeste n'avait JAMAIS été écrit, alors qu'il existe bel et bien sur
//     le Drive. C'est une régression par rapport à la garantie affichée de
//     DRIVE_CONFLITS_LOCKS.md §2bis (« jamais un choix arbitraire invisible »)
//     : ici il n'y a même pas de "choix" — juste un `null` qui masque
//     l'existence réelle du fichier.

import test from "node:test";
import assert from "node:assert/strict";

import { GoogleDriveStorageAdapter, ImmutableConflictError } from "../../src/storage/google-drive-adapter.js";
import { FakeDrive } from "./helpers/fake-drive.mjs";

const ROOT_ID = "root-workspace-r3-orphan";

function makeAdapter(drive) {
  return new GoogleDriveStorageAdapter({
    oauthTokenProvider: async () => "fake-access-token",
    rootFolderId: ROOT_ID,
    fetchImpl: drive.fetch,
    sleepFn: async () => {},
    maxRetries: 4,
  });
}

test("CORRIGÉ §10a — un event écrit dans un dossier top-level devenu orphelin est désormais VU par listChanges, même par une instance fraîche connectée après convergence complète", async () => {
  const drive = new FakeDrive();

  // A est seul sur un workspace tout neuf : connect() crée ses 5 dossiers.
  const adapterA = makeAdapter(drive);
  await adapterA.connect();
  const aEventsFolderId = adapterA._topFolders.event;

  // A écrit un event réel dans SON dossier "events" (légitime à cet instant).
  await adapterA.putImmutable("event", "ev-orphan", { eventId: "ev-orphan", createdAt: "2026-08-01T00:00:00.000Z" });

  // Un dossier "events" concurrent, RÉELLEMENT plus ancien, devient visible
  // ensuite (retard de propagation Drive — même mise en scène que le test
  // round 2 attack-p4r2-drive-connect-sweep, qui documente ce point de
  // départ comme un "résidu de course" acceptable).
  const aEventsNode = drive.nodes.get(aEventsFolderId);
  const earlierTime = new Date(new Date(aEventsNode.createdTime).getTime() - 60_000).toISOString();
  const winningFolderId = drive.addFolder("events", ROOT_ID, { createdTime: earlierTime });

  // A converge (§9b) dès sa prochaine écriture.
  await adapterA.putImmutable("event", "ev-after-convergence", { eventId: "ev-after-convergence", createdAt: "2026-08-02T00:00:00.000Z" });
  assert.equal(adapterA._topFolders.event, winningFolderId, "précondition : A a bien convergé vers le dossier gagnant");

  // Le temps passe. TOUT LE MONDE a maintenant convergé. Une TROISIÈME
  // instance, C, se connecte pour la toute première fois, LONGTEMPS après —
  // elle n'a JAMAIS eu de dossier "à elle", elle voit d'emblée le monde
  // pleinement convergé.
  const adapterC = makeAdapter(drive);
  await adapterC.connect();
  assert.equal(adapterC._topFolders.event, winningFolderId, "précondition : C résout directement le dossier gagnant, comme tout le monde");

  const seenByC = await adapterC.listChanges();
  const ids = seenByC.changes.map((c) => c.id).sort();

  // CORRIGÉ §10a : `listChanges` unit désormais TOUS les dossiers top-level
  // "events" sous la racine (`_allTopFolderIds`), pas seulement le dossier
  // GAGNANT — C, bien que fraîche et pleinement convergée (elle résout le
  // dossier gagnant comme tout le monde pour ses propres écritures), voit
  // maintenant bien "ev-orphan", physiquement présent dans le dossier
  // "events" abandonné par A.
  assert.ok(
    ids.includes("ev-orphan"),
    "CORRIGÉ §10a : 'ev-orphan' (dossier top-level orphelin) est désormais VU par listChanges, même par une instance fraîche pleinement convergée"
  );
  assert.ok(ids.includes("ev-after-convergence"), "sanity : l'event écrit APRÈS convergence, lui, est bien vu");
  assert.deepEqual(ids, ["ev-after-convergence", "ev-orphan"], "les DEUX events sont vus, sans doublon logique ni omission");

  // Preuve que le fichier existe RÉELLEMENT sur Drive (pas une fausse repro) :
  // il est bien présent, seulement dans le mauvais sous-arbre.
  const orphanNode = [...drive.nodes.values()].find((n) => n.name === "ev-orphan.piloteo");
  assert.ok(orphanNode, "sanity : le fichier ev-orphan.piloteo existe physiquement sur le FakeDrive");
  assert.notEqual(orphanNode.parents[0], winningFolderId, "sanity : il est bien dans le dossier PERDANT, pas dans celui qu'énumère listChanges");
});

test("CORRIGÉ §10b — un manifeste écrit dans un dossier 'workspace' top-level devenu orphelin reste VU par get(), plus de null silencieux", async () => {
  const drive = new FakeDrive();

  const adapterA = makeAdapter(drive);
  await adapterA.connect();
  const aWorkspaceFolderId = adapterA._topFolders.workspace;

  // A écrit le manifeste de genèse — c'est un succès légitime à cet instant :
  // A est seul, aucun autre manifeste n'existe encore nulle part.
  const manifest = { orgId: "org-1", createdBy: "member-a" };
  await adapterA.putImmutable("workspace", "genesis", manifest);
  assert.deepEqual(await adapterA.get("workspace", "genesis"), manifest, "précondition : A relit bien son propre manifeste juste après l'avoir écrit");

  // Un dossier "workspace" concurrent, réellement plus ancien, devient
  // visible ensuite (même mécanisme que le test précédent).
  const aWorkspaceNode = drive.nodes.get(aWorkspaceFolderId);
  const earlierTime = new Date(new Date(aWorkspaceNode.createdTime).getTime() - 60_000).toISOString();
  drive.addFolder("workspace", ROOT_ID, { createdTime: earlierTime }); // vide : personne n'y a encore rien écrit.

  // A relit son PROPRE manifeste juste après la re-résolution paresseuse du
  // dossier GAGNANT (§9b, pour les écritures futures) déclenchée par ce
  // `get()` lui-même — mais la LECTURE, elle (§10b), unit désormais tous les
  // dossiers "workspace" candidats, pas seulement ce gagnant.
  const reread = await adapterA.get("workspace", "genesis");

  // CORRIGÉ §10b : `get()` unit tous les dossiers top-level "workspace"
  // candidats (`_allTopFolderIds`) avant de conclure à une absence — le
  // nouveau dossier "workspace" (plus ancien, mais VIDE) ne masque plus le
  // manifeste réel, physiquement présent dans le dossier original de A. Pas
  // de `IMMUTABLE_CONFLICT` ici : un SEUL candidat existe au total (le
  // dossier concurrent est vide), donc pas de divergence à signaler — juste
  // le contenu réel, retrouvé.
  assert.deepEqual(
    reread,
    manifest,
    "CORRIGÉ §10b : get('workspace','genesis') retrouve le manifeste réel malgré l'apparition d'un dossier 'workspace' plus ancien VIDE — plus de disparition silencieuse"
  );

  // Preuve que le fichier existe toujours réellement sur Drive, avec son contenu intact.
  const manifestNode = [...drive.nodes.values()].find((n) => n.name === "manifest.piloteo");
  assert.ok(manifestNode, "sanity : manifest.piloteo existe toujours physiquement");
  assert.deepEqual(JSON.parse(manifestNode.content), manifest, "sanity : son contenu est bien le manifeste écrit par A, intact");
});

// ---------------------------------------------------------------------------
// Vérification demandée par le round de correction (§10) : le correctif "unit
// tous les dossiers dupliqués" ne doit PAS casser la détection
// IMMUTABLE_CONFLICT (§8b/§9d) quand le doublon dans l'AUTRE dossier top-level
// porte, lui, un contenu RÉELLEMENT divergent — jamais un choix arbitraire ni
// un null silencieux, mais bien un conflit détecté.
// ---------------------------------------------------------------------------
test("§10b (non-régression) — IMMUTABLE_CONFLICT toujours détecté quand le doublon divergent vit dans un AUTRE dossier top-level", async () => {
  const drive = new FakeDrive();
  const adapterA = makeAdapter(drive);
  await adapterA.connect();
  const aWorkspaceFolderId = adapterA._topFolders.workspace;

  const manifestA = { orgId: "org-A", createdBy: "member-a" };
  await adapterA.putImmutable("workspace", "genesis", manifestA);

  // Un dossier "workspace" concurrent, plus ancien, apparaît — mais cette
  // fois il contient DÉJÀ un manifeste DIFFÉRENT (pas vide), simulant un
  // deuxième créateur ayant écrit dans SON PROPRE dossier top-level avant que
  // les deux dossiers ne soient réconciliés.
  const aWorkspaceNode = drive.nodes.get(aWorkspaceFolderId);
  const earlierTime = new Date(new Date(aWorkspaceNode.createdTime).getTime() - 60_000).toISOString();
  const otherTopFolderId = drive.addFolder("workspace", ROOT_ID, { createdTime: earlierTime });
  const manifestB = { orgId: "org-B", createdBy: "member-b" };
  drive.nodes.set("manifest-in-other-top-folder", {
    id: "manifest-in-other-top-folder",
    name: "manifest.piloteo",
    mimeType: "application/octet-stream",
    parents: [otherTopFolderId],
    createdTime: new Date(new Date(earlierTime).getTime() + 500).toISOString(),
    content: JSON.stringify(manifestB),
    size: JSON.stringify(manifestB).length,
  });

  // CORRIGÉ §10b (non-régression) : la lecture unit les deux dossiers
  // top-level, trouve DEUX manifestes de contenus DIFFÉRENTS -> lève bien
  // IMMUTABLE_CONFLICT, jamais un choix arbitraire ni un null.
  await assert.rejects(
    () => adapterA.get("workspace", "genesis"),
    (err) => err instanceof ImmutableConflictError && err.code === "IMMUTABLE_CONFLICT",
    "IMMUTABLE_CONFLICT toujours détecté quand la divergence vient d'un AUTRE dossier top-level (non-régression §8b/§9d)"
  );
});

// ---------------------------------------------------------------------------
// Vérification demandée par le round de correction (§10) : le winner-first
// best-effort (§9c) doit continuer de fonctionner quand le gagnant et
// l'orphelin illisible vivent chacun dans un dossier top-level DIFFÉRENT.
// ---------------------------------------------------------------------------
test("§10b (non-régression) — winner-first best-effort (§9c) toujours correct quand gagnant et orphelin illisible vivent dans des dossiers top-level différents", async () => {
  const drive = new FakeDrive();
  const adapterA = makeAdapter(drive);
  await adapterA.connect();

  const manifest = { orgId: "org-1", createdBy: "member-a" };
  await adapterA.putImmutable("workspace", "genesis", manifest);
  const winnerNode = [...drive.nodes.values()].find((n) => n.name === "manifest.piloteo");

  // Un dossier "workspace" concurrent, plus RÉCENT (donc jamais le gagnant),
  // contient un doublon de contenu IDENTIQUE (résidu de course inoffensif,
  // §8b) — mais son téléchargement échoue de façon persistante.
  const laterTime = new Date(new Date(winnerNode.createdTime).getTime() + 60_000).toISOString();
  const otherTopFolderId = drive.addFolder("workspace", ROOT_ID, { createdTime: laterTime });
  const dupId = "manifest-dup-in-other-top-folder";
  drive.nodes.set(dupId, {
    id: dupId,
    name: "manifest.piloteo",
    mimeType: "application/octet-stream",
    parents: [otherTopFolderId],
    createdTime: new Date(new Date(laterTime).getTime() + 500).toISOString(),
    content: winnerNode.content, // même contenu logique -> pas un conflit si lisible.
    size: winnerNode.size,
  });
  drive.forceDownloadFailure(dupId, 500, "Internal Server Error");

  // CORRIGÉ §10b + §9c (non-régression) : le gagnant (A, plus ancien) est
  // téléchargé en premier et suffit — l'orphelin illisible, situé dans un
  // AUTRE dossier top-level, n'empêche pas la lecture de réussir.
  assert.deepEqual(
    await adapterA.get("workspace", "genesis"),
    manifest,
    "get() réussit malgré un doublon illisible situé dans un AUTRE dossier top-level (winner-first best-effort, §9c, préservé par §10)"
  );
});
