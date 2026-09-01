// src/storage/node-fs-port.js
//
// NodeFsPort — implémentation `node:fs` du port filesystem attendu par
// FolderStorageAdapter. Sert aux TESTS et à un éventuel wrapper desktop
// (Electron/Tauri) où Pilotéo a un accès `fs` direct au dossier choisi.
//
// Dans le NAVIGATEUR, ce fichier n'est jamais importé : on fournit à la place
// un port équivalent bâti sur la File System Access API
// (`showDirectoryPicker()` -> FileSystemDirectoryHandle), qui implémente la même
// petite interface (ensureDir/writeExclusive/readText/exists/listFiles/stat).
// FolderStorageAdapter ne dépend QUE de cette interface, pas de Node.
//
// Chemins : toujours RELATIFS à la racine, séparés par « / ». Le port traduit
// vers le séparateur natif via `path.join`.

import { promises as fs } from "node:fs";
import path from "node:path";

export class NodeFsPort {
  /** @param {string} root chemin absolu du dossier racine Pilotéo. */
  constructor(root) {
    if (typeof root !== "string" || root.length === 0) {
      throw new TypeError("NodeFsPort: `root` (chemin du dossier) requis.");
    }
    this.root = root;
  }

  _abs(rel) {
    // `rel` est en « / » ; on éclate pour rester correct sous Windows aussi.
    return path.join(this.root, ...String(rel).split("/").filter(Boolean));
  }

  async ensureDir(relDir) {
    await fs.mkdir(this._abs(relDir), { recursive: true });
  }

  async writeExclusive(relPath, text) {
    const abs = this._abs(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // flag `wx` : échoue avec EEXIST si le fichier existe déjà (write-once).
    await fs.writeFile(abs, text, { flag: "wx", encoding: "utf8" });
  }

  async readText(relPath) {
    return fs.readFile(this._abs(relPath), "utf8");
  }

  async exists(relPath) {
    try {
      await fs.access(this._abs(relPath));
      return true;
    } catch {
      return false;
    }
  }

  /** Liste RÉCURSIVE des fichiers sous `relDir` ; chemins relatifs à la racine en « / ». [] si absent. */
  async listFiles(relDir) {
    const baseAbs = this._abs(relDir);
    const out = [];
    const walk = async (absDir, relPrefix) => {
      let entries;
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch (err) {
        if (err && err.code === "ENOENT") return; // dossier absent : rien
        throw err;
      }
      for (const ent of entries) {
        const childRel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          await walk(path.join(absDir, ent.name), childRel);
        } else if (ent.isFile()) {
          out.push(childRel);
        }
      }
    };
    await walk(baseAbs, String(relDir).replace(/\/+$/, ""));
    return out;
  }

  async stat(relPath) {
    const st = await fs.stat(this._abs(relPath));
    return { mtimeMs: st.mtimeMs, size: st.size };
  }
}
