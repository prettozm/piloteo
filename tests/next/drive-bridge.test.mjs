// tests/next/drive-bridge.test.mjs
//
// `piloteo-drive-bridge.mjs` (Point 4 §2) — isolation inter-workspace via le
// hook de test `__engineFromAdapter` (contourne l'OAuth/GIS, impossible à
// automatiser ici, cf. docs/next/DRIVE_LIVE_MANUAL.md), et couverture minimale
// de `createDriveEngine`/`createDriveEventBackend` au travers de ce même hook.
//
// Correction #1 (revue vérificateur, bug bloquant) : `_findFileByName` (Drive)
// interrogeait un nom SANS contrainte de dossier parent. `fileNameForKind`
// renvoie des noms CONSTANTS pour `kind:"workspace"` (`manifest.piloteo`) —
// exactement le fichier que `createDriveEventBackend#init()` lit/crée pour
// poser l'identité (`workspaceId`/`actorId`) de CHAQUE engine. Ce test construit
// DEUX adaptateurs Drive PARTAGEANT LE MÊME `FakeDrive` (même « compte Google »)
// mais avec deux `rootFolderId` DIFFÉRENTS (deux workspaces distincts), chacun
// via `window.PiloteoDrive.__engineFromAdapter` (donc `createDriveEventBackend`
// + `createSoloStore`, exactement ce que `createDriveEngine` câble), et prouve
// qu'après la correction #1, chaque instance lit SON PROPRE manifeste — jamais
// celui de l'autre. Une version d'avant la correction #1 échoue ici (prouvé
// séparément dans le rapport du lot : script `run-isolation-check.mjs` rejouant
// les mêmes assertions contre une copie du module où `_findFileByNameInFolder`
// ignore le dossier parent — FAIL avant, PASS après).
//
// `piloteo-drive-bridge.mjs` référence `window` au chargement (pose
// `window.PiloteoDrive`) : ce module est écrit pour un navigateur, jamais
// importé par un test `node:test` ailleurs dans ce dépôt (les autres ponts,
// `piloteo-solo-bridge.mjs`/`piloteo-org-bridge.mjs`, ne sont exercés QUE par
// les e2e Playwright, un vrai navigateur). On shim donc `globalThis.window`
// AVANT l'import dynamique — le hook `__engineFromAdapter` n'utilise ensuite
// que `crypto.randomUUID()` (global Node >=19) et l'adaptateur injecté, jamais
// `google.accounts`/GIS (non exercé par ce test, cf. le manuel navigateur).

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { GoogleDriveStorageAdapter } from "../../src/storage/google-drive-adapter.js";
import { FakeDrive } from "./helpers/fake-drive.mjs";

if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
}

// Le pont n'a AUCUN export ESM nommé : il pose `window.PiloteoDrive` comme
// effet de bord de son évaluation (exactement comme dans un navigateur) —
// on le récupère donc sur le global partagé après l'import, pas en destructurant.
const bridgePath = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..", "piloteo-drive-bridge.mjs");
await import(pathToFileURL(bridgePath).href);
const PiloteoDrive = globalThis.window.PiloteoDrive;

function makeAdapter(drive, rootFolderId) {
  return new GoogleDriveStorageAdapter({
    oauthTokenProvider: async () => "fake-access-token",
    rootFolderId,
    fetchImpl: drive.fetch,
    sleepFn: async () => {},
  });
}

test("piloteo-drive-bridge : window.PiloteoDrive est posé, indisponible sans GOOGLE_CLIENT_ID (gating §5)", () => {
  assert.ok(PiloteoDrive, "window.PiloteoDrive doit être posé au chargement du module");
  assert.equal(PiloteoDrive.isAvailable, false, "aucun window.PILOTEO_GOOGLE_CLIENT_ID dans cet environnement de test -> indisponible");
  assert.throws(
    () => PiloteoDrive.createDriveEngine({ rootFolderId: "root-x" }),
    /GOOGLE_CLIENT_ID/,
    "createDriveEngine doit échouer PROPREMENT (pas de tentative réseau) quand le mode Drive est indisponible"
  );
});

test("piloteo-drive-bridge : __engineFromAdapter — DEUX workspaces sur le MÊME Drive, chacun lit SON PROPRE manifeste (correction #1)", async () => {
  const drive = new FakeDrive(); // un seul « compte Google » partagé par les deux workspaces
  const rootA = drive.addFolder("Pilotéo - Workspace A", null);
  const rootB = drive.addFolder("Pilotéo - Workspace B", null);

  const adapterA = makeAdapter(drive, rootA);
  const adapterB = makeAdapter(drive, rootB);

  // __engineFromAdapter construit l'engine {load,commit} EXACTEMENT comme
  // createDriveEngine (createDriveEventBackend + createSoloStore), sans OAuth.
  const engineA = PiloteoDrive.__engineFromAdapter(adapterA);
  const engineB = PiloteoDrive.__engineFromAdapter(adapterB);

  // Premier load() de chaque engine -> createDriveEventBackend#init() crée
  // SON PROPRE manifeste (workspaceId/actorId générés indépendamment).
  const loadedA = await engineA.load();
  const loadedB = await engineB.load();
  assert.deepEqual(loadedA.state.consultants, [], "état initial vierge (12 collections vides)");
  assert.equal(loadedA.revision, 0);
  assert.equal(loadedB.revision, 0);

  const manifestA = await adapterA.get("workspace", "manifest");
  const manifestB = await adapterB.get("workspace", "manifest");
  assert.ok(manifestA && manifestA.workspaceId, "le workspace A doit avoir son propre manifeste");
  assert.ok(manifestB && manifestB.workspaceId, "le workspace B doit avoir son propre manifeste");
  assert.notEqual(
    manifestA.workspaceId,
    manifestB.workspaceId,
    "BUG #1 (avant correctif) : les deux adaptateurs auraient pu lire le MÊME manifeste (recherche Drive non scopée par nom constant 'manifest.piloteo')"
  );
  assert.notEqual(manifestA.actorId, manifestB.actorId);

  // Reload indépendant de chaque côté (nouvel appel get, pas de cache local) :
  // toujours la même identité que celle initialement créée, jamais celle de l'autre.
  assert.deepEqual(await adapterA.get("workspace", "manifest"), manifestA);
  assert.deepEqual(await adapterB.get("workspace", "manifest"), manifestB);

  // Preuve directe au niveau REQUÊTE (la cause du bug) : il existe bien, pour
  // CHAQUE adaptateur, un appel `files.list` scopant `manifest.piloteo` au bon
  // dossier racine (topFolders.workspace), jamais une recherche par nom seul.
  function hasScopedManifestLookup(drv, adapter) {
    return drv.calls.some((c) => {
      if (c.method !== "GET" || !c.url.includes("/drive/v3/files?")) return false;
      const q = new URL(c.url).searchParams.get("q") || "";
      return q.includes("manifest.piloteo") && q.includes(`'${adapter._topFolders.workspace}' in parents`);
    });
  }
  assert.ok(hasScopedManifestLookup(drive, adapterA), "adaptateur A : recherche du manifeste scopée à SON dossier workspace");
  assert.ok(hasScopedManifestLookup(drive, adapterB), "adaptateur B : recherche du manifeste scopée à SON dossier workspace");

  // Couverture minimale de createDriveEventBackend au-delà du seul manifeste :
  // commit() sur l'engine A crée un événement dans events/ SOUS root A, jamais
  // sous root B, et engine B ne le voit pas (deux workspaces indépendants).
  const nextStateA = { ...loadedA.state, consultants: [{ id: "c-1", nom: "Alice" }] };
  const committedA = await engineA.commit(nextStateA);
  assert.equal(committedA.ok, true);
  assert.equal(committedA.state.consultants.length, 1);
  assert.equal(committedA.state.consultants[0].nom, "Alice");

  const reloadedB = await engineB.load();
  assert.deepEqual(reloadedB.state.consultants, [], "le workspace B ne doit PAS voir l'écriture du workspace A");

  const reloadedA = await engineA.load();
  assert.equal(reloadedA.state.consultants.length, 1, "le workspace A retrouve bien sa propre écriture au reload");
});
