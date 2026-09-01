// storage/local-store.js
//
// Décisions/hypothèses (CONTRACTS.md §9, docs/next/02 §4, docs/next/03 Phase 1,
// docs/next/05 §6/§15) :
// - Persistance IndexedDB pure : le module lit `globalThis.indexedDB` (fourni
//   nativement par le navigateur ; en Node les tests l'injectent via
//   `import 'fake-indexeddb/auto'` AVANT d'importer ce fichier). Aucune
//   dépendance npm en prod, aucun accès `localStorage` nulle part ici.
// - 8 object stores fixes (CONTRACTS.md §9) : `workspaces`(keyPath `id`),
//   `memberships`(keyPath composite `[workspaceId, memberId]`), `events`
//   (keyPath `eventId`, index `by_workspaceId` + index `by_state`),
//   `projections`(keyPath `workspaceId`), `sync_cursors`(keyPath
//   `workspaceId`), `keys`(keyPath `id`), `licenses`(keyPath `workspaceId`),
//   `settings`(keyPath `key`). `settings` ne porte jamais de donnée métier
//   (juste des préférences d'app locales) — la donnée métier vit uniquement
//   dans `events`/`projections`, jamais dans `localStorage`.
// - Migration de schéma : une liste ordonnée `SCHEMA_MIGRATIONS` (une entrée
//   par numéro de version IndexedDB) est rejouée dans `onupgradeneeded` pour
//   toute étape telle que `oldVersion < step.version <= newVersion` — donc un
//   saut direct 0 -> 2 (première installation) rejoue les étapes 1 puis 2, et
//   une mise à niveau 1 -> 2 (base déjà existante) ne rejoue que l'étape 2,
//   sans jamais toucher aux données déjà présentes. Chaque étape est elle-même
//   idempotente (elle vérifie `objectStoreNames.contains`/`indexNames.contains`
//   avant de créer), donc rejouer une étape déjà appliquée est un no-op sûr.
//   La version 1 crée les 7 premiers stores + l'index `by_workspaceId` sur
//   `events` ; la version 2 ajoute le store `settings` et l'index `by_state`
//   sur `events` (démontrant une vraie migration additive sans perte, cf.
//   docs/next/07 §3).
// - État local d'un événement (`events` store) : le champ `state` est ajouté
//   par ce module (pas par `events/event-schema.js`, qui ignore le stockage)
//   et vaut `pending` par défaut sur `appendLocalEvent`, avec les transitions
//   `pending -> published -> applied`, ou `rejected`, ou `conflict`, pilotées
//   par l'appelant (SyncEngine) via un futur `put`/`appendLocalEvent(event,
//   {state})`.
// - `appendLocalEvent` est idempotent sur `eventId` : un événement déjà
//   présent n'est JAMAIS réécrit par un nouvel appel (préserve son `state`
//   local, ex. ne fait pas régresser un événement `applied` en `pending`).
//   `importBackup`, à l'inverse, écrase volontairement via `put` direct car il
//   restaure un état de référence faisant autorité (idempotent par construction :
//   ré-importer le même backup produit le même résultat).
// - `exportBackup` ne lit JAMAIS le store `keys` : aucune clé (privée ou
//   wrappée) ne quitte donc jamais un export, conformément à CONTRACTS.md §4/§9
//   et docs/next/05 §6/§15 (« jamais de clé privée d'un autre membre dans un
//   export », étendu ici par prudence à « jamais aucune clé »). Le format
//   `.piloteobackup` renvoyé est un objet JS sérialisable
//   (`{format:"piloteo-backup-v1", workspaceId, exportedAt, manifest, events,
//   projection, meta}`) ; le sérialiser en Blob/fichier est la responsabilité
//   de l'appelant (UI), hors périmètre IndexedDB de ce module.
// - Isolation stricte entre workspaces : toute API haut niveau prenant un
//   `workspaceId` ne lit/écrit que les enregistrements de ce workspace (via la
//   clé primaire ou l'index `by_workspaceId`), jamais un scan global implicite.
// - Résistance aux stores absents/corrompus : `#assertStore` vérifie
//   `db.objectStoreNames.contains(name)` AVANT d'ouvrir toute transaction, et
//   toute erreur IndexedDB (requête ou transaction) est enveloppée dans une
//   `Error` explicite (message + `cause`) plutôt que de laisser fuiter une
//   `DOMException` brute ou de planter silencieusement.

const STORE_NAMES = Object.freeze([
  "workspaces",
  "memberships",
  "events",
  "projections",
  "sync_cursors",
  "keys",
  "licenses",
  "settings",
]);

export { STORE_NAMES };

export const CURRENT_SCHEMA_VERSION = 2;

export const BACKUP_FORMAT = "piloteo-backup-v1";

function ensureStore(db, name, options) {
  if (!db.objectStoreNames.contains(name)) {
    db.createObjectStore(name, options);
  }
}

function ensureIndex(tx, storeName, indexName, keyPath, options) {
  const store = tx.objectStore(storeName);
  if (!store.indexNames.contains(indexName)) {
    store.createIndex(indexName, keyPath, options);
  }
}

// Une entrée par numéro de version IndexedDB ; voir décision en tête de fichier.
const SCHEMA_MIGRATIONS = [
  {
    version: 1,
    apply(db /*, tx */) {
      ensureStore(db, "workspaces", { keyPath: "id" });
      ensureStore(db, "memberships", { keyPath: ["workspaceId", "memberId"] });
      ensureStore(db, "events", { keyPath: "eventId" });
      ensureStore(db, "projections", { keyPath: "workspaceId" });
      ensureStore(db, "sync_cursors", { keyPath: "workspaceId" });
      ensureStore(db, "keys", { keyPath: "id" });
      ensureStore(db, "licenses", { keyPath: "workspaceId" });
    },
  },
  {
    version: 2,
    apply(db, tx) {
      ensureStore(db, "settings", { keyPath: "key" });
      ensureIndex(tx, "events", "by_workspaceId", "workspaceId", { unique: false });
      ensureIndex(tx, "events", "by_state", "state", { unique: false });
    },
  },
];

function applyMigrations(db, tx, oldVersion, newVersion) {
  for (const step of SCHEMA_MIGRATIONS) {
    if (step.version > oldVersion && step.version <= newVersion) {
      step.apply(db, tx);
    }
  }
}

/** Enveloppe une erreur IndexedDB brute dans une `Error` explicite (jamais de crash silencieux). */
function wrapError(err, context) {
  const detail = err && err.message ? err.message : String(err);
  const wrapped = new Error(`${context}: ${detail}`);
  wrapped.cause = err;
  return wrapped;
}

function compareEventsByTime(a, b) {
  const ta = Date.parse(a && a.createdAt);
  const tb = Date.parse(b && b.createdAt);
  const validA = Number.isFinite(ta);
  const validB = Number.isFinite(tb);
  if (validA && validB && ta !== tb) return ta - tb;
  const ea = (a && a.eventId) || "";
  const eb = (b && b.eventId) || "";
  if (ea < eb) return -1;
  if (ea > eb) return 1;
  return 0;
}

export class LocalStore {
  /** @private */
  constructor(db, { dbName, schemaVersion }) {
    this.db = db;
    this.dbName = dbName;
    this.schemaVersion = schemaVersion;
  }

  /**
   * Ouvre (ou crée/migre) la base IndexedDB `dbName` à la version `schemaVersion`.
   * Gère l'upgrade de schéma via `onupgradeneeded` (voir SCHEMA_MIGRATIONS).
   */
  static async open(dbName, { schemaVersion = CURRENT_SCHEMA_VERSION } = {}) {
    if (typeof dbName !== "string" || dbName.length === 0) {
      throw new TypeError("LocalStore.open: dbName doit être une chaîne non vide");
    }
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
      throw new TypeError("LocalStore.open: schemaVersion doit être un entier >= 1");
    }
    const idb = globalThis.indexedDB;
    if (!idb) {
      throw new Error(
        "LocalStore.open: globalThis.indexedDB indisponible (navigateur requis, ou " +
          "'fake-indexeddb/auto' non importé en tête du fichier de test)",
      );
    }

    const db = await new Promise((resolve, reject) => {
      let request;
      try {
        request = idb.open(dbName, schemaVersion);
      } catch (err) {
        reject(wrapError(err, `LocalStore.open("${dbName}")`));
        return;
      }
      request.onupgradeneeded = (event) => {
        try {
          applyMigrations(request.result, request.transaction, event.oldVersion, event.newVersion);
        } catch (err) {
          // onupgradeneeded ne peut pas rejeter la promesse directement : on
          // annule la transaction pour que `onerror` porte l'erreur claire.
          try {
            request.transaction.abort();
          } catch {
            /* ignore */
          }
          reject(wrapError(err, `LocalStore.open("${dbName}"): migration de schéma`));
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(wrapError(request.error, `LocalStore.open("${dbName}")`));
      request.onblocked = () =>
        reject(new Error(`LocalStore.open("${dbName}"): bloqué par une autre connexion ouverte`));
    });

    return new LocalStore(db, { dbName, schemaVersion });
  }

  /** Ferme la connexion IndexedDB (une réouverture ultérieure retrouve les données persistées). */
  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------------
  // CRUD générique
  // ---------------------------------------------------------------------

  /** @private Store connu du contrat ET réellement créé dans cette base (sinon erreur claire). */
  #assertStore(storeName) {
    if (typeof storeName !== "string" || !this.db.objectStoreNames.contains(storeName)) {
      throw new Error(
        `LocalStore: store inconnu ou absent de la base "${this.dbName}": "${String(storeName)}"`,
      );
    }
  }

  /** @private Exécute `fn(objectStore)` dans une transaction et retourne une Promise du résultat. */
  #run(storeName, mode, fn) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = this.db.transaction(storeName, mode);
      } catch (err) {
        reject(wrapError(err, `LocalStore: transaction sur "${storeName}" impossible`));
        return;
      }
      tx.onerror = () => reject(wrapError(tx.error, `LocalStore: transaction sur "${storeName}" a échoué`));
      tx.onabort = () =>
        reject(wrapError(tx.error || new Error("transaction annulée"), `LocalStore: transaction sur "${storeName}" annulée`));

      const store = tx.objectStore(storeName);
      let request;
      try {
        request = fn(store);
      } catch (err) {
        reject(wrapError(err, `LocalStore: opération invalide sur "${storeName}"`));
        return;
      }
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(wrapError(request.error, `LocalStore: échec de l'opération sur "${storeName}"`));
    });
  }

  /** @private getAll via un index nommé (erreur claire si l'index n'existe pas). */
  #runByIndex(storeName, indexName, query) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = this.db.transaction(storeName, "readonly");
      } catch (err) {
        reject(wrapError(err, `LocalStore: transaction sur "${storeName}" impossible`));
        return;
      }
      const store = tx.objectStore(storeName);
      if (!store.indexNames.contains(indexName)) {
        reject(new Error(`LocalStore: index "${indexName}" absent du store "${storeName}"`));
        return;
      }
      const request = store.index(indexName).getAll(query);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(wrapError(request.error, `LocalStore: échec de la lecture par index "${indexName}" sur "${storeName}"`));
    });
  }

  async put(storeName, value) {
    this.#assertStore(storeName);
    await this.#run(storeName, "readwrite", (store) => store.put(value));
    return value;
  }

  async get(storeName, key) {
    this.#assertStore(storeName);
    const result = await this.#run(storeName, "readonly", (store) => store.get(key));
    return result === undefined ? null : result;
  }

  async getAll(storeName, query) {
    this.#assertStore(storeName);
    return this.#run(storeName, "readonly", (store) => store.getAll(query));
  }

  async delete(storeName, key) {
    this.#assertStore(storeName);
    await this.#run(storeName, "readwrite", (store) => store.delete(key));
  }

  async clear(storeName) {
    this.#assertStore(storeName);
    await this.#run(storeName, "readwrite", (store) => store.clear());
  }

  // ---------------------------------------------------------------------
  // API haut niveau — Phase 1 (docs/next/03 §Phase 1)
  // ---------------------------------------------------------------------

  /** Projection courante du workspace, ou `null` si jamais sauvegardée. Isolation stricte par `workspaceId`. */
  async loadWorkspaceState(workspaceId) {
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      throw new TypeError("LocalStore.loadWorkspaceState: workspaceId doit être une chaîne non vide");
    }
    const record = await this.get("projections", workspaceId);
    return record ? record.projection : null;
  }

  /** Sauvegarde (remplace) la projection locale d'un workspace. */
  async saveLocalProjection(workspaceId, projection) {
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      throw new TypeError("LocalStore.saveLocalProjection: workspaceId doit être une chaîne non vide");
    }
    await this.put("projections", {
      workspaceId,
      projection,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Ajoute un événement au journal local ; idempotent sur `eventId` (un événement
   * déjà présent n'est jamais réécrit, son `state` local est préservé).
   * `state` initial par défaut : `pending`.
   */
  async appendLocalEvent(event, { state = "pending" } = {}) {
    if (!event || typeof event.eventId !== "string" || event.eventId.length === 0) {
      throw new TypeError("LocalStore.appendLocalEvent: event.eventId (string) requis");
    }
    if (typeof event.workspaceId !== "string" || event.workspaceId.length === 0) {
      throw new TypeError("LocalStore.appendLocalEvent: event.workspaceId (string) requis");
    }
    const existing = await this.get("events", event.eventId);
    if (existing) {
      return { appended: false, duplicate: true };
    }
    await this.put("events", { ...event, state });
    return { appended: true, duplicate: false };
  }

  /**
   * Événements d'un workspace, ordonnés (createdAt puis eventId), isolés des
   * autres workspaces via l'index `by_workspaceId`. `fromCursor` = eventId
   * après lequel reprendre (curseur exclusif), pour une synchro incrémentale.
   */
  async listLocalEvents(workspaceId, { fromCursor } = {}) {
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      throw new TypeError("LocalStore.listLocalEvents: workspaceId doit être une chaîne non vide");
    }
    const rows = await this.#runByIndex("events", "by_workspaceId", workspaceId);
    const ordered = rows.slice().sort(compareEventsByTime);
    if (!fromCursor) return ordered;
    const idx = ordered.findIndex((e) => e.eventId === fromCursor);
    return idx === -1 ? ordered : ordered.slice(idx + 1);
  }

  // ---------------------------------------------------------------------
  // Curseurs de synchro
  // ---------------------------------------------------------------------

  async getCursor(workspaceId) {
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      throw new TypeError("LocalStore.getCursor: workspaceId doit être une chaîne non vide");
    }
    const record = await this.get("sync_cursors", workspaceId);
    return record ? record.cursor : null;
  }

  async setCursor(workspaceId, cursor) {
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      throw new TypeError("LocalStore.setCursor: workspaceId doit être une chaîne non vide");
    }
    await this.put("sync_cursors", { workspaceId, cursor });
  }

  // ---------------------------------------------------------------------
  // Sauvegarde (.piloteobackup) — CONTRACTS.md §9, docs/next/05 §15
  // ---------------------------------------------------------------------

  /**
   * Exporte un package de récupération complet pour `workspaceId` : jamais
   * aucune clé (le store `keys` n'est jamais lu ici).
   */
  async exportBackup(workspaceId) {
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      throw new TypeError("LocalStore.exportBackup: workspaceId doit être une chaîne non vide");
    }
    const workspace = await this.get("workspaces", workspaceId);
    if (!workspace) {
      throw new Error(`LocalStore.exportBackup: workspace introuvable: "${workspaceId}"`);
    }
    const events = await this.listLocalEvents(workspaceId);
    const projection = await this.loadWorkspaceState(workspaceId);
    const allMemberships = await this.getAll("memberships");
    const memberships = allMemberships.filter((m) => m.workspaceId === workspaceId);
    const license = await this.get("licenses", workspaceId);

    return {
      format: BACKUP_FORMAT,
      workspaceId,
      exportedAt: new Date().toISOString(),
      manifest: {
        workspaceId,
        eventCount: events.length,
        hasProjection: projection !== null,
        schemaVersion: this.schemaVersion,
      },
      events,
      projection,
      meta: { workspace, memberships, license: license || null },
    };
  }

  /**
   * Réhydrate un backup `.piloteobackup` (events + projection + meta).
   * Idempotent : ré-importer le même backup produit le même état.
   */
  async importBackup(data) {
    if (!data || typeof data !== "object" || data.format !== BACKUP_FORMAT) {
      throw new Error(`LocalStore.importBackup: format de backup invalide ou inconnu (attendu "${BACKUP_FORMAT}")`);
    }
    const workspaceId = data.workspaceId;
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      throw new Error("LocalStore.importBackup: workspaceId manquant dans le backup");
    }

    if (data.meta && data.meta.workspace) {
      await this.put("workspaces", data.meta.workspace);
    }
    if (data.meta && Array.isArray(data.meta.memberships)) {
      for (const membership of data.meta.memberships) {
        await this.put("memberships", membership);
      }
    }
    if (data.meta && data.meta.license) {
      await this.put("licenses", data.meta.license);
    }
    if (Array.isArray(data.events)) {
      for (const event of data.events) {
        await this.put("events", event);
      }
    }
    if (data.projection !== undefined) {
      await this.saveLocalProjection(workspaceId, data.projection);
    }

    return { workspaceId };
  }
}
