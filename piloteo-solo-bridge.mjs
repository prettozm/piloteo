// piloteo-solo-bridge.mjs — pont navigateur du mode Dossier (point 1b,
// docs/next/CONVERGENCE_CONTRACT.md §6bis).
//
// Décisions/hypothèses :
// - Ce module ne réécrit AUCUNE primitive canonique : il importe uniquement
//   `src/integration/solo-store.js` (store event-first + backend Dossier) et
//   `src/storage/fsaccess-port.js`/`fsaccess-handle-store.js` (port navigateur
//   File System Access + persistance du handle choisi). Rien n'est dupliqué.
// - `local-backend.js` est un script CLASSIQUE (pas de modules) : le seul point
//   de contact entre les deux mondes est `window.PiloteoNext`, posé ici. Ce
//   module est chargé en `<script type="module">` (différé de fait, comme
//   `defer`) : `local-backend.js` NE DOIT PAS supposer `window.PiloteoNext`
//   présent à son propre chargement — il le teste à l'usage (cf. §6bis point 3).
// - Un « engine » adapte le contrat `createSoloStore` au contrat HTTP attendu
//   par `app.js` pour `/api/state` :
//     GET  -> { revision, state }
//     PUT  -> { ok:true, revision, state, changes:{}, conflicts? }
//   `changes` reste vide (le solo est mono-écrivain, cf. commentaire de
//   `solo-store.js` sur le périmètre) ; `conflicts` n'est ajouté au retour de
//   `commit` que s'il y en a réellement (jamais un tableau vide qui polluerait
//   la réponse en dehors de ce cas).
// - `folderName` est un champ EXTRA (non exigé par le contrat, qui ne demande
//   que `{load, commit}`) ajouté à l'engine pour permettre à `local-backend.js`
//   d'afficher le dossier actif dans Réglages (§6bis point 2, "affichage du
//   dossier actif") sans dupliquer la lecture du handle.
// - `resumeFolder()` restitue exactement les trois issues du contrat :
//   `null` (aucun dossier mémorisé), `{needsPermission:true}` (permission à
//   ré-accorder par un geste utilisateur — la File System Access API refuse
//   `requestPermission` hors interaction), ou `{engine}`.
// - `__engineFromHandle(handle)` est un hook de TEST explicite : il permet à un
//   smoke e2e d'injecter un `FileSystemDirectoryHandle` en mémoire (même
//   sous-ensemble d'API que `tests/next/fsaccess-port.test.mjs`) sans dépendre
//   du sélecteur natif, indisponible en pilotage automatisé.

import { createSoloStore, createFolderEventBackend } from "./src/integration/solo-store.js";
import { createFsAccessPort, pickDirectory, ensureHandlePermission } from "./src/storage/fsaccess-port.js";
import { saveDirectoryHandle, loadDirectoryHandle } from "./src/storage/fsaccess-handle-store.js";

/** Construit un engine `{load, commit}` (+ `folderName`) au-dessus d'un handle de dossier. */
function buildEngine(handle) {
  const fsPort = createFsAccessPort(handle);
  const backend = createFolderEventBackend({ fsPort });
  const store = createSoloStore({ backend });

  return {
    folderName: (handle && handle.name) || null,

    async load() {
      const { revision, state } = await store.load();
      return { revision, state };
    },

    async commit(nextState) {
      const { revision, state, conflicts } = await store.commit(nextState);
      const out = { ok: true, revision, state, changes: {} };
      if (conflicts && conflicts.length) out.conflicts = conflicts;
      return out;
    },
  };
}

/**
 * Ouvre le sélecteur natif, mémorise le handle choisi, renvoie l'engine prêt.
 * Appelle `window.PiloteoNext.pickDirectory()` (late-bound, PAS l'import
 * fermé sur ce module) plutôt que `pickDirectory()` directement : un e2e (le
 * sélecteur natif n'est pas automatisable) peut ainsi substituer
 * `window.PiloteoNext.pickDirectory` par une fabrique de faux handle AVANT
 * d'appeler `window.PiloteoLocal._activateFolder()`, pour exercer le VRAI
 * chemin d'activation (§4 du contrat migration) de bout en bout — symétrique
 * de `window.PiloteoOrg.pickDirectory`, déjà appelé ainsi par
 * `local-backend.js` (jamais l'import direct).
 */
async function activateFolderFromPicker() {
  const handle = await window.PiloteoNext.pickDirectory();
  await ensureHandlePermission(handle, "readwrite");
  await saveDirectoryHandle(handle);
  return buildEngine(handle);
}

/**
 * Reprise du dossier mémorisé (au boot). `null` si jamais activé ;
 * `{needsPermission:true}` si le handle est connu mais l'autorisation n'a pas
 * pu être re-accordée SANS geste utilisateur (le cas normal au chargement) ;
 * `{engine}` sinon.
 */
async function resumeFolder() {
  const handle = await loadDirectoryHandle();
  if (!handle) return null;
  const granted = await ensureHandlePermission(handle, "readwrite");
  if (!granted) return { needsPermission: true };
  return { engine: buildEngine(handle) };
}

window.PiloteoNext = {
  hasFileSystemAccess: typeof globalThis.showDirectoryPicker === "function",
  pickDirectory,
  activateFolderFromPicker,
  resumeFolder,
  // Hook de test (docs/next/CONVERGENCE_CONTRACT.md §6bis point 5) : construit
  // l'engine depuis un FileSystemDirectoryHandle fourni, sans passer par le
  // sélecteur natif ni par la persistance du handle.
  __engineFromHandle: buildEngine,
};
