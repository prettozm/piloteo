// src/integration/solo-store.js
//
// Store event-first du mode SOLO (docs/next/CONVERGENCE_CONTRACT.md, point 1).
//
// Décisions/hypothèses :
// - Ce module ne réécrit AUCUNE primitive canonique : l'enveloppe (`buildEvent`),
//   le journal (`EventLog`/replay), le reducer (`reduce`) et la validation
//   (`validatePayload`) viennent tous de `src/events/*`. Le seul code métier
//   réellement nouveau ici est la conversion snapshot <-> journal
//   (`snapshotToEventsDiff`/`projectionToSnapshot`), ré-implémentée en canonique
//   à partir de l'algorithme de référence `piloteo-events.js`
//   (`diffToEvents`/`projectionToState`), en AJOUTANT `parentEventId` — absent
//   du bundle de référence — pour que `conflict.js#classify` dispose de la
//   causalité explicite (P0.1) même si le solo est mono-acteur.
// - Le solo est « Folder Trusted » : mono-utilisateur, aucune crypto/signature/
//   membership. Les événements portent leur `payload` en clair (CONTRAT §1).
// - Identité solo : un `workspaceId` et un `actorId` (UUID) FIXES, générés une
//   seule fois puis PERSISTÉS par le backend lui-même (§5 du contrat) — ce
//   module ne les invente jamais à la volée à chaque appel, seulement au tout
//   premier `init()` d'un backend vierge. `epoch` reste constant à `1` (le
//   solo ne connaît pas la notion de ré-épochage de `Keyring`).
// - `snapshotToEventsDiff` est déterministe : à état égal (mêmes valeurs pour
//   une identité donnée, comparaison par `JSON.stringify`), aucun événement
//   n'est émis. L'ordre d'itération suit l'ordre d'insertion des tableaux
//   d'entrée (`Map` construite en un passage), donc deux appels avec les mêmes
//   arguments produisent toujours la même liste d'événements dans le même
//   ordre.
// - `projectionToSnapshot` exclut les tombstones (`__deleted`) et les clés de
//   méta-données (`__versions`/`__conflicts`, qui ne sont pas des entityTypes
//   de `ENTITY_TYPES`, donc jamais itérées). L'ordre du tableau résultant suit
//   l'ordre d'insertion dans le bucket de la projection — c'est-à-dire l'ordre
//   de traitement des événements par `EventLog.replay()` (tri causal par
//   entité, cf. event-log.js), PAS forcément l'ordre du tableau d'origine
//   commité : le contrat §4 est explicite là-dessus (« ensemblistement
//   identique », pas positionnellement identique).
// - `createSoloStore` est un simple orchestrateur : il ne connaît pas le
//   format de transport (IndexedDB, Dossier, mémoire...), seulement le contrat
//   `backend` du §5. `commit` ne jette JAMAIS pour un événement métier
//   invalide : `validatePayload` est appelée AVANT `backend.appendEvent`, un
//   rejet est consigné dans `applied.rejected` et les événements valides du
//   même commit continuent d'être appliqués (§6.8 du contrat).
// - Les deux backends (`createIndexedDbEventBackend`, `createFolderEventBackend`)
//   sont volontairement minces : ils ne connaissent que « écrire un événement
//   immuable », « les lister tous », « lire/écrire l'identité solo une fois »,
//   et « une révision monotone ». Aucune logique de conflit/replay n'y vit —
//   c'est le rôle d'`EventLog`/`reduce`, appelés uniquement par
//   `createSoloStore`.

import { buildEvent, ENTITY_TYPES, identityValue } from "../events/event-schema.js";
import { EventLog } from "../events/event-log.js";
import { validatePayload } from "../events/validation.js";
import { FolderStorageAdapter } from "../storage/folder-storage-adapter.js";

const COLLECTIONS = Object.keys(ENTITY_TYPES);

/** Indexe un tableau d'entités par leur valeur d'identité (clé propre à `entityType`). */
function mapByIdentity(list, entityType) {
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const value = identityValue(entityType, item);
    if (value !== undefined && value !== null) {
      map.set(String(value), item);
    }
  }
  return map;
}

/** `{version, lastEventId}` courants d'une entité dans `projection.__versions`, avec défauts « entité inconnue ». */
function lineageOf(versionBucket, id) {
  const v = versionBucket[id];
  const baseVersion = v && typeof v.version === "number" ? v.version : 0;
  const parentEventId = v && typeof v.lastEventId === "string" ? v.lastEventId : null;
  return { baseVersion, parentEventId };
}

/**
 * Diff de deux snapshots (12 collections tableaux, façon app.js) -> événements
 * create/update/delete canoniques (`buildEvent`), `parentEventId` inclus.
 *
 * @param {object} oldState  snapshot avant (forme `projectionToSnapshot`)
 * @param {object} newState  snapshot après
 * @param {{workspaceId:string, actorId:string, epoch:number, projection:object}} opts
 *   `projection` fournit `__versions` pour poser `baseVersion`/`parentEventId` justes sur update/delete.
 * @returns {object[]} événements, dans un ordre déterministe ; vide si `newState` == `oldState`.
 */
export function snapshotToEventsDiff(oldState, newState, { workspaceId, actorId, epoch, projection } = {}) {
  const events = [];
  const versionsRoot = (projection && projection.__versions) || {};

  for (const entityType of COLLECTIONS) {
    const oldMap = mapByIdentity(oldState && oldState[entityType], entityType);
    const newMap = mapByIdentity(newState && newState[entityType], entityType);
    const versionBucket = versionsRoot[entityType] || {};

    for (const [id, entity] of newMap) {
      if (!oldMap.has(id)) {
        events.push(
          buildEvent({
            workspaceId,
            entityType,
            entityId: id,
            operation: "create",
            actorId,
            baseVersion: 0,
            epoch,
            payload: entity,
            parentEventId: null,
          }),
        );
        continue;
      }
      const before = oldMap.get(id);
      if (JSON.stringify(before) !== JSON.stringify(entity)) {
        const { baseVersion, parentEventId } = lineageOf(versionBucket, id);
        events.push(
          buildEvent({
            workspaceId,
            entityType,
            entityId: id,
            operation: "update",
            actorId,
            baseVersion,
            epoch,
            payload: entity,
            parentEventId,
          }),
        );
      }
    }

    for (const [id] of oldMap) {
      if (newMap.has(id)) continue;
      const { baseVersion, parentEventId } = lineageOf(versionBucket, id);
      events.push(
        buildEvent({
          workspaceId,
          entityType,
          entityId: id,
          operation: "delete",
          actorId,
          baseVersion,
          epoch,
          payload: null,
          parentEventId,
        }),
      );
    }
  }

  return events;
}

/**
 * Projection (map par identité, cf. reducer.js) -> snapshot 12 collections
 * (forme app.js). Tombstones (`__deleted`) exclus, `__versions`/`__conflicts`
 * exclus (ce ne sont pas des entityTypes de `ENTITY_TYPES`), ordre d'insertion
 * de la projection conservé.
 */
export function projectionToSnapshot(projection) {
  const state = {};
  for (const entityType of COLLECTIONS) {
    const bucket = (projection && projection[entityType]) || {};
    const list = [];
    for (const id of Object.keys(bucket)) {
      const entity = bucket[id];
      if (entity && entity.__deleted) continue;
      list.push(entity);
    }
    state[entityType] = list;
  }
  return state;
}

/**
 * Store event-first solo : reconstruit toujours son état depuis le journal
 * (`backend.listEvents()` -> `EventLog.replay()`), n'a aucun état interne
 * persistant propre à l'instance (deux stores sur le même backend convergent
 * forcément — cf. tests §6.4).
 *
 * @param {{backend: object}} deps `backend` : voir le contrat §5 (`init`, `identity`,
 *   `listEvents`, `appendEvent`, `revision`).
 */
export function createSoloStore({ backend } = {}) {
  if (!backend || typeof backend.init !== "function") {
    throw new TypeError("createSoloStore: backend requis (contrat CONVERGENCE_CONTRACT.md §5)");
  }

  async function replayProjection() {
    await backend.init();
    const events = await backend.listEvents();
    return new EventLog(events).replay();
  }

  return {
    /** Reconstruit l'état courant depuis le journal. */
    async load() {
      const projection = await replayProjection();
      const revision = await backend.revision();
      return {
        revision,
        state: projectionToSnapshot(projection),
        conflicts: projection.__conflicts || [],
      };
    },

    /** Snapshot courant seul (sans revision), utilitaire pour comparer avant un commit. */
    async currentSnapshot() {
      const projection = await replayProjection();
      return projectionToSnapshot(projection);
    },

    /**
     * Calcule le diff vers `nextState`, valide chaque événement, écrit les
     * valides (immuables) dans le backend. Un événement invalide est consigné
     * dans `applied.rejected` — jamais de throw, les autres événements du même
     * commit continuent d'être traités.
     */
    async commit(nextState) {
      const projection = await replayProjection();
      const { workspaceId, actorId, epoch } = backend.identity();
      const currentSnapshot = projectionToSnapshot(projection);

      const events = snapshotToEventsDiff(currentSnapshot, nextState, {
        workspaceId,
        actorId,
        epoch,
        projection,
      });

      const rejected = [];
      let count = 0;
      for (const event of events) {
        const verdict = validatePayload(event.entityType, event.operation, event.payload);
        if (!verdict.ok) {
          rejected.push({
            eventId: event.eventId,
            entityType: event.entityType,
            entityId: event.entityId,
            reason: verdict.reason,
          });
          continue;
        }
        await backend.appendEvent(event);
        count += 1;
      }

      // Aucun événement écrit : la projection courante reste valable telle quelle.
      const finalProjection = count > 0 ? await replayProjection() : projection;
      const revision = await backend.revision();
      return {
        revision,
        state: projectionToSnapshot(finalProjection),
        applied: { count, rejected },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Backend IndexedDB (§5.1) — un store `events` (keyPath eventId) + un store
// `meta` (clé hors-ligne) portant l'identité solo persistée sous la clé
// "identity". Aucune dépendance à `local-store.js` (schéma volontairement plus
// petit et dédié : ce n'est pas le LocalStore multi-workspace du sync réel).
// ---------------------------------------------------------------------------

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * @param {{indexedDB: IDBFactory, dbName: string}} opts `indexedDB` injecté
 *   (navigateur natif ou `fake-indexeddb` en test), jamais lu depuis un global implicite.
 */
export function createIndexedDbEventBackend({ indexedDB, dbName } = {}) {
  if (!indexedDB || typeof indexedDB.open !== "function") {
    throw new TypeError("createIndexedDbEventBackend: `indexedDB` (IDBFactory) requis");
  }
  if (typeof dbName !== "string" || dbName.length === 0) {
    throw new TypeError("createIndexedDbEventBackend: `dbName` doit être une chaîne non vide");
  }

  let db = null;
  let cachedIdentity = null;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains("events")) {
          database.createObjectStore("events", { keyPath: "eventId" });
        }
        if (!database.objectStoreNames.contains("meta")) {
          database.createObjectStore("meta");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error(`createIndexedDbEventBackend: ouverture de "${dbName}" bloquée`));
    });
  }

  function run(storeName, mode, fn) {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    return idbRequest(fn(store));
  }

  return {
    async init() {
      if (!db) {
        db = await openDb();
      }
      if (!cachedIdentity) {
        const existing = await run("meta", "readonly", (store) => store.get("identity"));
        if (existing) {
          cachedIdentity = existing;
        } else {
          cachedIdentity = {
            workspaceId: globalThis.crypto.randomUUID(),
            actorId: globalThis.crypto.randomUUID(),
            epoch: 1,
          };
          await run("meta", "readwrite", (store) => store.put(cachedIdentity, "identity"));
        }
      }
    },

    identity() {
      if (!cachedIdentity) {
        throw new Error("createIndexedDbEventBackend: identity() appelé avant init()");
      }
      return cachedIdentity;
    },

    async listEvents() {
      return run("events", "readonly", (store) => store.getAll());
    },

    async appendEvent(event) {
      const existing = await run("events", "readonly", (store) => store.get(event.eventId));
      if (existing) return; // write-once : doublon d'eventId -> no-op, jamais un throw
      await run("events", "readwrite", (store) => store.add(event));
    },

    async revision() {
      return run("events", "readonly", (store) => store.count());
    },
  };
}

// ---------------------------------------------------------------------------
// Backend Dossier (§5.2) — via FolderStorageAdapter (event-per-file immuable,
// `workspace/manifest.piloteo` pour l'identité solo persistée).
// ---------------------------------------------------------------------------

/** @param {{fsPort: object}} opts `fsPort` : voir `node-fs-port.js` (Node/tests) ou `fsaccess-port.js` (navigateur). */
export function createFolderEventBackend({ fsPort } = {}) {
  if (!fsPort) {
    throw new TypeError("createFolderEventBackend: `fsPort` requis");
  }
  const adapter = new FolderStorageAdapter({ fsPort, label: "solo" });

  let connected = false;
  let cachedIdentity = null;

  return {
    async init() {
      if (!connected) {
        await adapter.connect();
        connected = true;
      }
      if (!cachedIdentity) {
        if (await adapter.exists("workspace", "manifest")) {
          cachedIdentity = await adapter.get("workspace", "manifest");
        } else {
          cachedIdentity = {
            workspaceId: globalThis.crypto.randomUUID(),
            actorId: globalThis.crypto.randomUUID(),
            epoch: 1,
          };
          await adapter.putImmutable("workspace", "manifest", cachedIdentity);
        }
      }
    },

    identity() {
      if (!cachedIdentity) {
        throw new Error("createFolderEventBackend: identity() appelé avant init()");
      }
      return cachedIdentity;
    },

    async listEvents() {
      const { changes } = await adapter.listChanges();
      const events = [];
      for (const change of changes) {
        if (change.kind !== "event") continue;
        events.push(await adapter.get("event", change.id));
      }
      return events;
    },

    async appendEvent(event) {
      if (await adapter.exists("event", event.eventId)) return; // write-once : doublon -> no-op
      await adapter.putImmutable("event", event.eventId, event);
    },

    async revision() {
      const { changes } = await adapter.listChanges();
      return changes.filter((c) => c.kind === "event").length;
    },
  };
}
