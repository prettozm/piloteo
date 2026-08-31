// src/storage/folder-storage-adapter.js
//
// FolderStorageAdapter — StorageAdapter (CONTRACTS.md §5) sur un DOSSIER choisi
// par l'utilisateur. Le dossier peut être local OU synchronisé par une
// infrastructure EXTERNE à Pilotéo (OneDrive, SharePoint via OneDrive, Google
// Drive Desktop, Dropbox, NAS, dossier réseau). Pilotéo ne connaît JAMAIS le
// fournisseur : il ne voit qu'un dossier et des fichiers. La responsabilité de
// la synchronisation appartient à l'utilisateur / à son organisation.
//
// Format sur disque — IDENTIQUE à celui de l'adaptateur Google Drive (mêmes
// helpers `buildDrivePath`) pour que les deux transports partagent le même
// format de données (event-per-file immuable) :
//
//   <root>/
//     workspace/manifest.piloteo
//     members/<memberId>.piloteo
//     events/<AAAA-MM>/<eventId>.piloteo      <- un événement = un fichier immuable
//     keys/epoch-XXXX/<memberId>.key
//     licenses/current.license
//
// Pourquoi event-per-file immuable (docs/next, §8 de la passe) : chaque
// événement a un nom unique (uuid) et n'est JAMAIS réécrit. Deux appareils qui
// créent A.piloteo et B.piloteo produisent deux fichiers DISTINCTS ; l'outil de
// synchronisation externe les transporte sans jamais devoir fusionner de
// contenu — il n'y a donc pas de conflit fichier. Pilotéo assure ensuite, à la
// relecture, la validation, la causalité (`parentEventId`), la détection de
// conflit métier et la projection. On n'utilise PAS un `state.json` unique
// réécrit par tous (source de conflits pour les synchros externes).
//
// Correspondance avec le contrat conceptuel de la passe (§7) :
//   connect()                 -> connect()
//   list()                    -> listChanges(cursor)  (renvoie {changes,cursor})
//   read(id)                  -> get(kind, id)
//   writeImmutable(id, blob)  -> putImmutable(kind, id, blob)  (write-once STRICT)
//   exists(id)                -> exists(kind, id)
//   health()                  -> health()
// On implémente l'interface StorageAdapter complète (et pas une API filesystem
// générique) pour rester enfichable tel quel dans SyncEngine.
//
// Décisions/hypothèses :
// - Le module ne fait AUCUNE E/S lui-même : il délègue à un « port filesystem »
//   minimal injecté (`fsPort`), ce qui le rend testable en Node (port `node:fs`)
//   ET utilisable dans le navigateur (port File System Access API). Le port est
//   volontairement réduit aux opérations RÉELLEMENT nécessaires (pas d'API fs
//   générique) : ensureDir, writeExclusive, readText, exists, listFiles, stat.
// - Write-once : `putImmutable` échoue si le fichier existe déjà (le port doit
//   écrire en mode exclusif — flag `wx` côté Node). Aucune méthode de
//   suppression/écrasement n'est exposée (immutabilité, cohérent avec les
//   events et avec l'InMemoryStorageAdapter).
// - Curseur : le système de fichiers, surtout synchronisé de l'extérieur, n'a
//   AUCUN ordre d'écriture fiable ni monotone (un fichier d'un mois ancien peut
//   arriver tard). `listChanges` fait donc une ÉNUMÉRATION COMPLÈTE des fichiers
//   présents à chaque appel (jamais de « depuis le curseur » basé sur un
//   high-water lexicographique qui pourrait rater un fichier synchronisé en
//   retard). Le curseur retourné est purement informatif (horodatage du scan).
//   La déduplication (ne pas retraiter un événement déjà vu) est faite en amont
//   par SyncEngine (`_seen`) — c'est correct et sans perte, au prix d'un simple
//   listage de noms de fichiers à chaque pull (pas de lecture de contenu ici).
// - `share`/`revoke` : NO-OP documenté. Le partage d'un dossier n'est pas du
//   ressort de Pilotéo — il est assuré par le fournisseur de synchronisation
//   (partage OneDrive/SharePoint, dossier partagé Drive Desktop, etc.) ou par
//   les permissions du système de fichiers. Aucune ACL à gérer ici.
// - Aucune règle métier (invariant StorageAdapter, CONTRACTS §5).

import { StorageAdapter, assertValidKind, STORAGE_KINDS } from "./storage-adapter.js";
import { buildDrivePath, folderForKind, fileNameForKind } from "./google-drive-adapter.js";

function nowIso() {
  return new Date().toISOString();
}

/**
 * Dérive les métadonnées de chemin nécessaires à `buildDrivePath` depuis le
 * blob lui-même : `createdAt` pour un événement (sous-dossier mensuel), `epoch`
 * pour une clé (sous-dossier d'epoch). Les autres kinds n'en ont pas besoin.
 */
function pathMetaFromBlob(kind, blob) {
  if (kind === "event") {
    const createdAt = blob && blob.createdAt;
    if (!createdAt) {
      throw new TypeError(
        "FolderStorageAdapter: un blob kind:'event' doit porter `createdAt` (sous-dossier mensuel)."
      );
    }
    return { createdAt };
  }
  if (kind === "key") {
    const epoch = blob && blob.epoch;
    if (epoch === undefined) {
      throw new TypeError("FolderStorageAdapter: un blob kind:'key' doit porter `epoch` (sous-dossier d'epoch).");
    }
    return { epoch };
  }
  return {};
}

/** Retire le suffixe de nom de fichier d'un `kind` pour retrouver l'`id`. */
function idFromFileName(kind, fileName) {
  switch (kind) {
    case "workspace":
      return "manifest"; // singleton : tout id mappe sur le même fichier
    case "license":
      return "current"; // singleton
    case "key":
      return fileName.endsWith(".key") ? fileName.slice(0, -4) : fileName;
    case "member":
    case "event":
      return fileName.endsWith(".piloteo") ? fileName.slice(0, -8) : fileName;
    default:
      return fileName;
  }
}

/**
 * Port filesystem minimal. Chemins TOUJOURS relatifs à la racine, séparés par
 * « / » (le port concret traduit vers le séparateur natif). Toutes les méthodes
 * sont asynchrones.
 *
 * @typedef {Object} FsPort
 * @property {(relDir:string)=>Promise<void>} ensureDir           crée le dossier (récursif), no-op s'il existe
 * @property {(relPath:string,text:string)=>Promise<void>} writeExclusive écrit en mode EXCLUSIF (échoue si le fichier existe déjà)
 * @property {(relPath:string)=>Promise<string>} readText         lit le contenu texte (rejette si absent)
 * @property {(relPath:string)=>Promise<boolean>} exists          vrai si le fichier existe
 * @property {(relDir:string)=>Promise<string[]>} listFiles       liste RÉCURSIVE des fichiers sous relDir (chemins relatifs à la racine, « / ») ; [] si le dossier n'existe pas
 * @property {(relPath:string)=>Promise<{mtimeMs:number,size:number}>} stat  métadonnées (rejette si absent)
 */

export class FolderStorageAdapter extends StorageAdapter {
  /**
   * @param {{fsPort:FsPort, label?:string}} deps `fsPort` = port filesystem injecté (voir NodeFsPort / un port File System Access).
   */
  constructor({ fsPort, label = "dossier" } = {}) {
    super();
    if (!fsPort || typeof fsPort.writeExclusive !== "function" || typeof fsPort.readText !== "function") {
      throw new TypeError("FolderStorageAdapter: `fsPort` (port filesystem) requis.");
    }
    for (const m of ["ensureDir", "exists", "listFiles", "stat"]) {
      if (typeof fsPort[m] !== "function") {
        throw new TypeError(`FolderStorageAdapter: fsPort.${m} manquant.`);
      }
    }
    this.fsPort = fsPort;
    this.label = label;
    this._connected = false;
  }

  async connect() {
    // Crée l'arborescence de premier niveau si absente (idempotent).
    for (const kind of STORAGE_KINDS) {
      await this.fsPort.ensureDir(folderForKind(kind));
    }
    this._connected = true;
  }

  async putImmutable(kind, id, blob) {
    assertValidKind(kind);
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("FolderStorageAdapter.putImmutable: id doit être une chaîne non vide.");
    }
    const relPath = buildDrivePath(kind, id, pathMetaFromBlob(kind, blob));
    const text = JSON.stringify(blob);
    try {
      await this.fsPort.writeExclusive(relPath, text);
    } catch (err) {
      // Un port conforme lève avec code 'EEXIST' (ou message équivalent) quand
      // le fichier existe déjà : on le remonte comme violation de write-once,
      // uniforme avec l'InMemoryStorageAdapter.
      if (err && (err.code === "EEXIST" || /exist/i.test(String(err.message || err)))) {
        throw new Error(
          `FolderStorageAdapter.putImmutable: write-once violé — (${kind}, ${id}) existe déjà (${relPath}).`
        );
      }
      throw err;
    }
    return { id };
  }

  async get(kind, id) {
    assertValidKind(kind);
    // Le chemin d'un event/key dépend d'une méta (mois/epoch) que l'interface
    // StorageAdapter ne transporte pas (elle ne porte que l'id) : on localise
    // alors le fichier par son nom, unique, dans le sous-arbre du kind. Les
    // autres kinds ont un chemin direct.
    const relPath =
      kind === "event" || kind === "key"
        ? await this._resolvePathById(kind, id)
        : buildDrivePath(kind, id, {});
    if (!relPath) {
      throw new Error(`FolderStorageAdapter.get: introuvable (${kind}, ${id}).`);
    }
    let text;
    try {
      text = await this.fsPort.readText(relPath);
    } catch (err) {
      throw new Error(`FolderStorageAdapter.get: introuvable (${kind}, ${id}) [${relPath}] — ${(err && err.message) || err}`);
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`FolderStorageAdapter.get: contenu JSON invalide (${kind}, ${id}) — ${(err && err.message) || err}`);
    }
  }

  // Localise le fichier d'un `(kind,id)` par son nom (unique) dans le sous-arbre
  // du kind — utilisé pour event/key dont le sous-dossier (mois/epoch) n'est pas
  // déductible du seul id.
  async _resolvePathById(kind, id) {
    const base = folderForKind(kind);
    const wanted = fileNameForKind(kind, id);
    const files = await this.fsPort.listFiles(base);
    for (const rel of files) {
      const name = rel.slice(rel.lastIndexOf("/") + 1);
      if (name === wanted) return rel;
    }
    return null;
  }

  async exists(kind, id) {
    assertValidKind(kind);
    // Singletons et kinds sans sous-dossier variable : chemin direct.
    if (kind === "workspace" || kind === "member" || kind === "license") {
      return this.fsPort.exists(buildDrivePath(kind, id, {}));
    }
    // event/key : le sous-dossier (mois/epoch) est inconnu ici -> recherche par nom.
    return (await this._resolvePathById(kind, id)) !== null;
  }

  async readMetadata(kind, id) {
    assertValidKind(kind);
    const relPath =
      kind === "event" || kind === "key"
        ? await this._resolvePathById(kind, id)
        : buildDrivePath(kind, id, {});
    if (!relPath) {
      throw new Error(`FolderStorageAdapter.readMetadata: introuvable (${kind}, ${id}).`);
    }
    const st = await this.fsPort.stat(relPath);
    return { kind, id, path: relPath, writtenAt: new Date(st.mtimeMs).toISOString(), size: st.size };
  }

  /**
   * Énumération COMPLÈTE des blobs présents dans le dossier (voir décision
   * « Curseur » en tête). `cursor` est ignoré pour le filtrage (le FS synchronisé
   * n'a pas d'ordre fiable) ; il est retourné informatif (horodatage). SyncEngine
   * déduplique via `_seen`.
   */
  async listChanges(_cursor) {
    const changes = [];
    for (const kind of STORAGE_KINDS) {
      const base = folderForKind(kind);
      let files;
      try {
        files = await this.fsPort.listFiles(base);
      } catch {
        files = [];
      }
      for (const rel of files) {
        const name = rel.slice(rel.lastIndexOf("/") + 1);
        // Ignore les fichiers parasites (ex: .DS_Store, fichiers de conflit du
        // synchroniseur externe qui ne correspondent pas à un nom attendu).
        if (name.startsWith(".")) continue;
        changes.push({ kind, id: idFromFileName(kind, name) });
      }
    }
    return { changes, cursor: nowIso() };
  }

  /** NO-OP : le partage d'un dossier est du ressort du fournisseur de synchro / de l'OS. */
  async share(_member) {
    return { ok: true, delegated: true };
  }

  /** NO-OP : cf. `share`. */
  async revoke(_member) {
    return { ok: true, delegated: true };
  }

  async health() {
    try {
      // Un dossier sain = racine accessible et énumérable.
      await this.fsPort.listFiles(folderForKind("event"));
      return { ok: true, detail: `ok (${this.label})` };
    } catch (err) {
      return { ok: false, detail: `dossier inaccessible: ${(err && err.message) || err}` };
    }
  }
}
