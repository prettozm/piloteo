// src/storage/fsaccess-port.js
//
// Port filesystem NAVIGATEUR pour FolderStorageAdapter, bâti sur la File System
// Access API (`showDirectoryPicker()` -> FileSystemDirectoryHandle). Implémente
// exactement la même petite interface que NodeFsPort
// (ensureDir/writeExclusive/readText/exists/listFiles/stat), si bien que
// FolderStorageAdapter fonctionne à l'identique au-dessus d'un vrai dossier
// choisi par l'utilisateur (local ou synchronisé OneDrive/SharePoint/Drive
// Desktop/Dropbox/NAS — Pilotéo ne voit qu'un dossier).
//
// Disponibilité : Chromium desktop (Chrome/Edge/Opera). Firefox/Safari
// n'exposent PAS `showDirectoryPicker` -> le mode Dossier y est indisponible sans
// wrapper desktop (cf. docs/modes/FOLDER_STORAGE.md).
//
// Write-once : la File System Access API n'offre pas de création exclusive
// atomique. On implémente le write-once par « vérifier-puis-créer » : on refuse
// d'écrire si le fichier existe déjà. Suffisant pour des fichiers immuables à nom
// unique (uuid) jamais réécrits ; la fenêtre TOCTOU est inoffensive (un même
// eventId ne peut pas être produit deux fois par deux acteurs).
//
// Chemins : toujours relatifs à la racine, séparés par « / ».

const SEP = "/";

function splitPath(rel) {
  return String(rel).split(SEP).filter(Boolean);
}

function isNotFound(err) {
  return err && (err.name === "NotFoundError" || err.code === "ENOENT");
}

/**
 * Crée un port filesystem à partir d'un `FileSystemDirectoryHandle` racine.
 * @param {FileSystemDirectoryHandle} rootHandle
 * @returns {import("./folder-storage-adapter.js").FsPort}
 */
export function createFsAccessPort(rootHandle) {
  if (!rootHandle || typeof rootHandle.getDirectoryHandle !== "function") {
    throw new TypeError("createFsAccessPort: un FileSystemDirectoryHandle racine est requis.");
  }

  // Descend jusqu'au dossier `parts`, en créant les niveaux si `create`.
  async function resolveDir(parts, { create }) {
    let dir = rootHandle;
    for (const name of parts) {
      dir = await dir.getDirectoryHandle(name, { create });
    }
    return dir;
  }

  // Résout {dir, name} pour un chemin de fichier ; crée les dossiers parents si `create`.
  async function resolveParent(relPath, { create }) {
    const parts = splitPath(relPath);
    if (parts.length === 0) throw new TypeError("chemin de fichier vide.");
    const name = parts.pop();
    const dir = await resolveDir(parts, { create });
    return { dir, name };
  }

  return {
    async ensureDir(relDir) {
      await resolveDir(splitPath(relDir), { create: true });
    },

    async writeExclusive(relPath, text) {
      const { dir, name } = await resolveParent(relPath, { create: true });
      // Write-once : refuser si le fichier existe déjà.
      let exists = false;
      try {
        await dir.getFileHandle(name, { create: false });
        exists = true;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      if (exists) {
        const e = new Error(`write-once: le fichier existe déjà (${relPath}).`);
        e.code = "EEXIST";
        throw e;
      }
      const fileHandle = await dir.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      try {
        await writable.write(text);
      } finally {
        await writable.close();
      }
    },

    async readText(relPath) {
      const { dir, name } = await resolveParent(relPath, { create: false });
      const fileHandle = await dir.getFileHandle(name, { create: false });
      const file = await fileHandle.getFile();
      return file.text();
    },

    async exists(relPath) {
      try {
        const { dir, name } = await resolveParent(relPath, { create: false });
        await dir.getFileHandle(name, { create: false });
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },

    async listFiles(relDir) {
      const out = [];
      let baseDir;
      try {
        baseDir = await resolveDir(splitPath(relDir), { create: false });
      } catch (err) {
        if (isNotFound(err)) return []; // dossier absent : rien
        throw err;
      }
      const basePrefix = splitPath(relDir).join(SEP);
      const walk = async (dirHandle, prefix) => {
        for await (const entry of dirHandle.values()) {
          const childRel = prefix ? `${prefix}${SEP}${entry.name}` : entry.name;
          if (entry.kind === "directory") {
            await walk(entry, childRel);
          } else if (entry.kind === "file") {
            out.push(childRel);
          }
        }
      };
      await walk(baseDir, basePrefix);
      return out;
    },

    async stat(relPath) {
      const { dir, name } = await resolveParent(relPath, { create: false });
      const fileHandle = await dir.getFileHandle(name, { create: false });
      const file = await fileHandle.getFile();
      return { mtimeMs: file.lastModified, size: file.size };
    },
  };
}

/**
 * Vérifie/demande l'autorisation de lecture-écriture sur un handle de dossier.
 * Retourne true si accordée. À appeler après restauration d'un handle persisté
 * (l'autorisation ne survit pas toujours au rechargement — re-consentement).
 * @param {FileSystemHandle} handle
 * @param {"read"|"readwrite"} [mode]
 */
export async function ensureHandlePermission(handle, mode = "readwrite", interactive = false) {
  if (!handle || typeof handle.queryPermission !== "function") return false;
  const opts = { mode };
  // Toujours SANS effet de bord d'abord : `queryPermission` ne requiert jamais
  // d'activation utilisateur, il est donc sûr au boot (reprise).
  try {
    if ((await handle.queryPermission(opts)) === "granted") return true;
  } catch (e) { /* certains navigateurs lèvent aussi sur query : traiter comme non accordé */ }
  // La DEMANDE de permission (`requestPermission`) exige une ACTIVATION
  // UTILISATEUR (un clic) : l'appeler hors geste lève « User activation is
  // required to request permissions ». On ne la tente donc QUE si l'appelant
  // déclare être dans un geste (`interactive === true`), et on l'enveloppe pour
  // ne JAMAIS propager cette exception — un boot renvoie proprement `false`
  // (=> l'UI affiche « Redonner l'accès », le clic rappelle avec interactive).
  if (interactive && typeof handle.requestPermission === "function") {
    try {
      return (await handle.requestPermission(opts)) === "granted";
    } catch (e) { return false; }
  }
  return false;
}

/**
 * Ouvre le sélecteur de dossier natif (interaction utilisateur requise) et
 * renvoie le `FileSystemDirectoryHandle` choisi. `readwrite` demandé d'emblée.
 * Lève si l'API n'est pas disponible (Firefox/Safari) ou si l'utilisateur annule.
 */
export async function pickDirectory() {
  if (typeof globalThis.showDirectoryPicker !== "function") {
    throw new Error(
      "File System Access API indisponible (navigateur non compatible : Firefox/Safari). " +
        "Utilisez Chrome/Edge/Opera sur ordinateur, ou un autre mode de stockage."
    );
  }
  return globalThis.showDirectoryPicker({ mode: "readwrite" });
}
