// tests/next/helpers/fake-drive.mjs
//
// FakeDrive — simulateur minimal, mais FIDÈLE AU FORMAT RÉEL, de l'API Drive
// v3 (`files.list` avec pagination `nextPageToken`, `files.create` JSON pour
// les dossiers, upload multipart, `files.get?alt=media`). Partagé entre
// `tests/next/drive-adapter-live.test.mjs` et `tests/next/drive-bridge.test.mjs`
// (pas de duplication — un seul simulateur, deux suites qui l'utilisent).
//
// Elle NE modélise QUE ce que `GoogleDriveStorageAdapter` peut effectivement
// émettre (elle n'a pas besoin d'implémenter la totalité de l'API Drive) —
// notamment, elle applique STRICTEMENT les contraintes `name = '...'` ET
// `'<parentId>' in parents` d'une requête `files.list`, ce qui est
// indispensable pour que les tests de scoping (isolation inter-workspace,
// correction #1) soient probants : une requête SANS `in parents` retrouve
// TOUS les fichiers de ce nom, tous dossiers/workspaces confondus, exactement
// comme le ferait la vraie API Drive.

import assert from "node:assert/strict";

export const FOLDER_MIME = "application/vnd.google-apps.folder";

export function fakeResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/**
 * Parse le sous-ensemble du langage de requête Drive que l'adaptateur émet réellement.
 *
 * Correction #8e (revue adverse) : `parentMatch` DOIT gérer l'échappement exactement
 * comme `nameMatch` (`(?:[^'\\]|\\.)*`, pas `[^']+`). Avant ce correctif, un `name`
 * hostile contenant la sous-chaîne échappée `\' in parents` (ex : id
 * `x' in parents or 'a'='a`, une fois passé par `escapeDriveQueryValue`) faisait
 * dérailler ce parseur NAÏF : `[^']+` s'arrête au premier caractère `'` rencontré,
 * y compris un `'` qui fait partie d'une séquence ÉCHAPPÉE `\'` À L'INTÉRIEUR de la
 * valeur de `name` déjà capturée par `nameMatch` — le simulateur capturait alors un
 * `parentId` BIDON tiré du contenu du nom, avant même d'atteindre la vraie clause
 * `'<parentId>' in parents` en fin de requête. Ce n'était PAS un bug de production
 * (`escapeDriveQueryValue` échappe correctement pour le VRAI moteur de requête
 * Drive) mais une fragilité du simulateur qui pouvait fausser un test construit
 * avec un tel id. `(?:[^'\\]|\\.)*` traite toute paire `\<car>` (donc `\'`) comme UNE
 * unité indivisible : le moteur regex ne peut alors jamais s'arrêter sur un guillemet
 * échappé, seulement sur un guillemet RÉEL (non précédé d'un backslash non consommé) —
 * exactement le même raisonnement que `nameMatch`.
 */
export function parseDriveQuery(q) {
  const folderOnly = q.includes(FOLDER_MIME);
  const nameMatch = q.match(/name = '((?:[^'\\]|\\.)*)'/);
  const name = nameMatch ? nameMatch[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\") : null;
  const parentMatch = q.match(/'((?:[^'\\]|\\.)*)' in parents/);
  const parentId = parentMatch ? parentMatch[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\") : null;
  return { folderOnly, name, parentId };
}

export class FakeDrive {
  constructor() {
    this._autoId = 1;
    this._clock = 1700000000000; // horodatage croissant déterministe (ms)
    this.nodes = new Map(); // id -> {id,name,mimeType,parents:[id],createdTime,content?,size?}
    this.calls = []; // {method, url} — journal pour assertions
    this._forced = []; // file d'attente de réponses forcées (429/401/5xx…) consommée AVANT le vrai handler
    this._downloadFailures = new Map(); // fileId -> {status,body} — panne PERSISTANTE ciblée sur UN téléchargement précis (§9c)
    this.maxPageItems = Infinity; // borne artificielle de pagination (tests de pagination)
    this.createFolderCalls = 0;
    this.uploadCalls = 0;
  }

  newId() {
    return `id-${this._autoId++}`;
  }
  nowIso() {
    this._clock += 1000;
    return new Date(this._clock).toISOString();
  }

  /** Ajoute un dossier déjà existant (setup de test) — ne compte pas dans `createFolderCalls`. */
  addFolder(name, parentId, { createdTime } = {}) {
    const id = this.newId();
    this.nodes.set(id, { id, name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : [], createdTime: createdTime || this.nowIso() });
    return id;
  }

  /** Force la/les PROCHAINE(S) réponse(s) fetch, avant même de regarder l'URL — simule 429/401/5xx. */
  forceNext(status, body) {
    this._forced.push({ status, body });
  }

  /**
   * Panne PERSISTANTE ciblée sur le téléchargement (`alt=media`) d'UN fichier précis, par
   * `fileId` — §9c (revue adverse round 2) : contrairement à `forceNext` (file d'attente
   * globale, consommée par le TOUT PROCHAIN appel fetch quel qu'il soit), cette panne ne
   * s'applique QU'AU fichier désigné et persiste tant que `clearDownloadFailure` n'est pas
   * appelé — nécessaire pour tester qu'un candidat SURNUMÉRAIRE précis (jamais le gagnant)
   * illisible n'empêche pas une lecture par ailleurs réussie.
   */
  forceDownloadFailure(fileId, status, body) {
    this._downloadFailures.set(fileId, { status, body });
  }

  /** Annule une panne posée par `forceDownloadFailure`. */
  clearDownloadFailure(fileId) {
    this._downloadFailures.delete(fileId);
  }

  /** `fetch` injectable dans `GoogleDriveStorageAdapter({ fetchImpl })`. */
  fetch = async (url, options = {}) => {
    const method = (options && options.method) || "GET";
    this.calls.push({ url, method });
    if (this._forced.length) {
      const f = this._forced.shift();
      return fakeResponse(f.status, f.body ?? "");
    }
    const u = new URL(url);
    if (u.pathname === "/drive/v3/files" && method === "GET") return this._handleList(u);
    if (u.pathname === "/drive/v3/files" && method === "POST") return this._handleCreateFolder(options);
    if (u.pathname === "/upload/drive/v3/files" && method === "POST") return this._handleUpload(options);
    const dl = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (dl && method === "GET" && u.searchParams.get("alt") === "media") return this._handleDownload(dl[1]);
    throw new Error(`FakeDrive: requête non simulée : ${method} ${url}`);
  };

  _handleList(u) {
    const q = u.searchParams.get("q") || "";
    const { folderOnly, name, parentId } = parseDriveQuery(q);
    let matched = [...this.nodes.values()].filter((n) => {
      if (folderOnly && n.mimeType !== FOLDER_MIME) return false;
      if (name !== null && n.name !== name) return false;
      if (parentId !== null && !(n.parents || []).includes(parentId)) return false;
      return true;
    });
    matched.sort((a, b) => {
      if (a.createdTime !== b.createdTime) return a.createdTime < b.createdTime ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    const requestedPageSize = Number(u.searchParams.get("pageSize")) || 1000;
    const pageSize = Math.min(requestedPageSize, this.maxPageItems);
    const pageToken = u.searchParams.get("pageToken");
    const start = pageToken ? Number(pageToken) : 0;
    const page = matched.slice(start, start + pageSize);
    const nextPageToken = start + pageSize < matched.length ? String(start + pageSize) : undefined;

    const files = page.map((n) => ({ id: n.id, name: n.name, createdTime: n.createdTime, size: n.size }));
    return fakeResponse(200, { files, nextPageToken });
  }

  _handleCreateFolder(options) {
    this.createFolderCalls++;
    const metadata = JSON.parse(options.body);
    const id = this.newId();
    this.nodes.set(id, { id, name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents || [], createdTime: this.nowIso() });
    return fakeResponse(200, { id, name: metadata.name });
  }

  _handleUpload(options) {
    this.uploadCalls++;
    const contentType = options.headers["Content-Type"];
    const boundary = contentType.match(/boundary=(.+)$/)[1];
    const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `--${escaped}\\r\\nContent-Type: application/json; charset=UTF-8\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--${escaped}\\r\\nContent-Type: application/octet-stream\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--${escaped}--`
    );
    const m = options.body.match(re);
    assert.ok(m, "FakeDrive: corps multipart mal formé — ne correspond pas au format attendu");
    const metadata = JSON.parse(m[1]);
    const content = m[2];
    const id = this.newId();
    this.nodes.set(id, {
      id,
      name: metadata.name,
      mimeType: "application/octet-stream",
      parents: metadata.parents || [],
      createdTime: this.nowIso(),
      content,
      size: content.length,
    });
    return fakeResponse(200, { id, name: metadata.name });
  }

  _handleDownload(fileId) {
    const forced = this._downloadFailures.get(fileId);
    if (forced) return fakeResponse(forced.status, forced.body ?? "");
    const node = this.nodes.get(fileId);
    if (!node) return fakeResponse(404, "Not Found");
    return fakeResponse(200, node.content ?? "");
  }
}
