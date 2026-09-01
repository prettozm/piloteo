// src/storage/fsaccess-handle-store.js
//
// Persistance du dossier choisi (mode Dossier, navigateur). Un
// `FileSystemDirectoryHandle` est structured-cloneable : on peut donc le stocker
// tel quel dans IndexedDB et le restaurer au rechargement, ce qui évite de
// re-demander le dossier à chaque session. L'AUTORISATION, elle, ne survit pas
// toujours au rechargement : après restauration, appeler
// `ensureHandlePermission()` (fsaccess-port.js) pour re-consentement éventuel.
//
// Module minimal (pas de dépendance) : un seul handle « courant » est conservé.
// IndexedDB est disponible dans le navigateur ET en test via `fake-indexeddb`.

const DB_NAME = "piloteo-fsaccess";
const DB_VERSION = 1;
const STORE = "handles";
const CURRENT_KEY = "current";

function idbFactory() {
  const f = globalThis.indexedDB;
  if (!f) throw new Error("fsaccess-handle-store: IndexedDB indisponible dans cet environnement.");
  return f;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = idbFactory().open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; }).catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Enregistre le handle du dossier courant (écrase le précédent). */
export async function saveDirectoryHandle(handle) {
  const db = await openDb();
  try {
    await tx(db, "readwrite", (store) => reqToPromise(store.put(handle, CURRENT_KEY)));
  } finally {
    db.close();
  }
}

/** Restaure le handle du dossier courant, ou `null` s'il n'y en a pas. */
export async function loadDirectoryHandle() {
  const db = await openDb();
  try {
    const value = await tx(db, "readonly", (store) => reqToPromise(store.get(CURRENT_KEY)));
    return value ?? null;
  } finally {
    db.close();
  }
}

/** Oublie le dossier courant (l'utilisateur en choisira un autre). */
export async function clearDirectoryHandle() {
  const db = await openDb();
  try {
    await tx(db, "readwrite", (store) => reqToPromise(store.delete(CURRENT_KEY)));
  } finally {
    db.close();
  }
}
