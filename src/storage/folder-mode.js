// src/storage/folder-mode.js
//
// Couture d'orchestration du mode Dossier côté NAVIGATEUR : compose le sélecteur
// de dossier, la persistance du handle, la re-permission et l'adaptateur, pour
// que l'UI n'ait qu'UN appel à faire. Deux entrées :
//   - startFolderMode()  : l'utilisateur choisit un dossier (interaction requise) ;
//   - resumeFolderMode() : reprend le dossier mémorisé au démarrage (sans dialogue
//                          si la permission est encore accordée).
// Ce module ne touche pas `app.js` : c'est le point d'accroche que l'UI appellera.

import { pickDirectory, createFsAccessPort, ensureHandlePermission } from "./fsaccess-port.js";
import { saveDirectoryHandle, loadDirectoryHandle } from "./fsaccess-handle-store.js";
import { FolderStorageAdapter } from "./folder-storage-adapter.js";

function adapterFor(handle) {
  return new FolderStorageAdapter({ fsPort: createFsAccessPort(handle), label: handle?.name || "dossier" });
}

// Collaborateurs par défaut (effets de bord navigateur). Injectables pour les
// tests — c'est le seul moyen de simuler proprement le dialogue natif et de ne
// pas dépendre du round-trip IndexedDB d'un handle (non fidèle hors navigateur).
const DEFAULTS = {
  pick: pickDirectory,
  ensurePermission: ensureHandlePermission,
  save: saveDirectoryHandle,
  load: loadDirectoryHandle,
  makeAdapter: adapterFor,
};

/**
 * Choix d'un dossier par l'utilisateur (interaction obligatoire), mémorisé pour
 * les sessions suivantes. Retourne `{ handle, adapter }` (adaptateur déjà connecté).
 */
export async function startFolderMode(deps = {}) {
  const { pick, ensurePermission, save, makeAdapter } = { ...DEFAULTS, ...deps };
  const handle = await pick();
  await ensurePermission(handle, "readwrite");
  await save(handle);
  const adapter = makeAdapter(handle);
  await adapter.connect();
  return { handle, adapter };
}

/**
 * Reprise du dossier mémorisé au démarrage.
 * - `null`                                : aucun dossier mémorisé (mode Dossier jamais activé).
 * - `{ handle, adapter:null, needsPermission:true }` : dossier connu mais permission
 *   à re-accorder par un geste utilisateur (appeler `grantAndConnect(handle)`).
 * - `{ handle, adapter }`                 : prêt (adaptateur connecté).
 */
export async function resumeFolderMode(deps = {}) {
  const { load, ensurePermission, makeAdapter } = { ...DEFAULTS, ...deps };
  const handle = await load();
  if (!handle) return null;
  const granted = await ensurePermission(handle, "readwrite");
  if (!granted) return { handle, adapter: null, needsPermission: true };
  const adapter = makeAdapter(handle);
  await adapter.connect();
  return { handle, adapter };
}

/** Re-demande la permission (dans un gestionnaire de clic) puis connecte l'adaptateur. */
export async function grantAndConnect(handle, deps = {}) {
  const { ensurePermission, makeAdapter } = { ...DEFAULTS, ...deps };
  const granted = await ensurePermission(handle, "readwrite");
  if (!granted) return { handle, adapter: null, needsPermission: true };
  const adapter = makeAdapter(handle);
  await adapter.connect();
  return { handle, adapter };
}
