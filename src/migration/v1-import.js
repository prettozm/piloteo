// src/migration/v1-import.js
//
// Import V1 → Next — CONTRACTS.md §11, docs/next/03_MIGRATION_V1_VERS_LOCAL_FIRST.md
// Phase 9, V1_DOMAIN_MAP.md §1.
//
// Décisions/hypothèses :
//
// - Forme du genesis retenue : **les deux**, comme le permet la mission
//   ("entityType spécial documenté OU une série d'événements create par
//   entité"). Concrètement :
//     1. Une SÉRIE d'événements `create` standards (un par entité des 12
//        collections V1), produits via `buildEvent` (events/event-schema.js)
//        avec `baseVersion:0` et appliqués via `reduce` (events/reducer.js) —
//        EXACTEMENT le même pipeline que le trafic normal. C'est ce qui
//        garantit que « la projection finale est identique fonctionnellement
//        à `state` » : on ne réimplémente aucune logique de fusion/état,
//        on rejoue le reducer déjà testé et committé.
//     2. UN événement `genesisEvent` marqueur unique, `type:"workspace.imported"`
//        — PAS un événement d'entité au sens de `ENTITY_TYPES` (son
//        `entityType` n'existe pas dans `event-schema.js#ENTITY_TYPES`, donc
//        il ne peut pas passer par `buildEvent`/`reduce`, qui rejetteraient un
//        `entityType` inconnu). C'est un enregistrement d'AUDIT hors
//        reducer — pas destiné à être injecté dans le journal d'événements
//        métier, mais à être conservé (ex: méta du workspace, écran
//        "historique d'import") pour tracer la provenance (revision/
//        exportedAt de l'export V1 source, nombre d'entités importées).
//   Les événements `create` par entité sont aussi retournés (`events`) pour
//   permettre à l'appelant de les persister dans son EventLog s'il le
//   souhaite (usage optionnel, en plus du contrat minimal
//   `{workspace, genesisEvent, projection}`).
//
// - `importV1` NE MUTE JAMAIS `exportObj` : chaque entité est clonée
//   (`structuredClone`, ou repli JSON si indisponible) avant d'être portée
//   comme payload d'événement / stockée en projection.
//
// - Le `workspace` retourné est construit directement ici (pas via
//   `workspace/workspace.js#createTeamWorkspace`, qui génère son propre id
//   aléatoire) car l'appelant impose `workspaceId`. Mode par défaut `"team"`
//   (une organisation V1 a plusieurs consultants/utilisateurs) ; le
//   provisionnement Drive réel (Phase Google Drive) est un pas séparé, hors
//   périmètre de ce module — `storage` part donc de `{provider:"local",
//   rootId:null}` par défaut, ajustable via l'option `storage`.
//
// - Entités V1 malformées (identité absente) : ignorées silencieusement plutôt
//   que de faire échouer tout l'import — documenté ici, pas une régression
//   silencieuse : `compareCollections` les ferait de toute façon apparaître
//   comme un écart de compte si l'appelant les attend.
//
// - Ne crée PAS de memberships ici : lier les consultants V1 à de vraies
//   identités (Google ou locales) est un choix de bootstrap applicatif
//   distinct (CONTRACTS §8, `workspace/memberships.js`), hors du contrat exact
//   demandé (`importV1(exportObj, {workspaceId, actorId, epoch, now}) ->
//   {workspace, genesisEvent, projection}`). Les données `consultants`
//   elles-mêmes sont importées comme toute autre collection.

import { buildEvent, ENTITY_TYPES, identityKey } from "../events/event-schema.js";
import { initialProjection, reduce } from "../events/reducer.js";

export const V1_EXPORT_FORMAT = "piloteo-v1-export";

function cloneEntity(entity) {
  if (typeof structuredClone === "function") return structuredClone(entity);
  return JSON.parse(JSON.stringify(entity));
}

function toIsoOrThrow(value, label) {
  const d = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(d.getTime())) {
    throw new TypeError(`importV1: '${label}' invalide`);
  }
  return d.toISOString();
}

/**
 * Importe un export V1 (`{format:"piloteo-v1-export", schemaVersion,
 * exportedAt, revision, state:{...12 collections...}}`) vers un workspace
 * Next. Ne modifie jamais `exportObj`.
 *
 * @param {object} exportObj export V1
 * @param {object} opts
 * @param {string} opts.workspaceId UUID du workspace Next créé pour l'import
 * @param {string} opts.actorId UUID de l'acteur qui réalise l'import (ex: owner)
 * @param {number} [opts.epoch=1]
 * @param {Date|string|number} [opts.now] horodatage de l'import (défaut: maintenant)
 * @param {string} [opts.workspaceName]
 * @param {"local"|"team"} [opts.workspaceMode="team"]
 * @param {{provider:string, rootId:string|null}} [opts.storage]
 * @returns {{workspace:object, genesisEvent:object, projection:object, events:object[]}}
 */
export function importV1(exportObj, {
  workspaceId,
  actorId,
  epoch = 1,
  now,
  workspaceName,
  workspaceMode = "team",
  storage,
} = {}) {
  if (!exportObj || typeof exportObj !== "object") {
    throw new TypeError("importV1: exportObj requis");
  }
  if (exportObj.format !== V1_EXPORT_FORMAT) {
    throw new TypeError(`importV1: format d'export inattendu (${exportObj.format})`);
  }
  if (!exportObj.state || typeof exportObj.state !== "object") {
    throw new TypeError("importV1: exportObj.state requis");
  }
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new TypeError("importV1: workspaceId requis");
  }
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw new TypeError("importV1: actorId requis");
  }

  const nowIso = toIsoOrThrow(now, "now");

  const workspace = {
    id: workspaceId,
    name: workspaceName || "Import V1",
    mode: workspaceMode,
    createdAt: nowIso,
    schemaVersion: 1,
    storage: storage && storage.provider ? { provider: storage.provider, rootId: storage.rootId ?? null } : { provider: "local", rootId: null },
    importedFromV1: {
      format: exportObj.format,
      schemaVersion: exportObj.schemaVersion ?? null,
      exportedAt: exportObj.exportedAt ?? null,
      revision: exportObj.revision ?? null,
    },
  };

  let projection = initialProjection();
  const events = [];
  let totalEntities = 0;

  for (const entityType of Object.keys(ENTITY_TYPES)) {
    const key = identityKey(entityType);
    const collection = Array.isArray(exportObj.state[entityType]) ? exportObj.state[entityType] : [];

    for (const rawEntity of collection) {
      if (!rawEntity || typeof rawEntity !== "object") continue;
      const identity = rawEntity[key];
      if (identity === undefined || identity === null || identity === "") continue; // entité V1 mal formée : ignorée, pas fatale

      const payload = cloneEntity(rawEntity);
      const event = buildEvent({
        workspaceId,
        entityType,
        entityId: String(identity),
        operation: "create",
        actorId,
        baseVersion: 0,
        epoch,
        payload,
      });

      projection = reduce(projection, event, payload);
      events.push(event);
      totalEntities++;
    }
  }

  const genesisEvent = {
    type: "workspace.imported",
    eventId: globalThis.crypto.randomUUID(),
    workspaceId,
    actorId,
    createdAt: nowIso,
    epoch,
    source: {
      format: exportObj.format,
      schemaVersion: exportObj.schemaVersion ?? null,
      exportedAt: exportObj.exportedAt ?? null,
      revision: exportObj.revision ?? null,
    },
    entityCount: totalEntities,
  };

  return { workspace, genesisEvent, projection, events };
}

// ---------------------------------------------------------------------------
// Comparateur — gate d'équivalence V1 export vs projection Next.
// ---------------------------------------------------------------------------

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false; // primitifs déjà départagés par ===
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a).filter((k) => a[k] !== undefined);
  const bKeys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Compare, collection par collection (les 12 `ENTITY_TYPES`), un état V1
 * (`state`, tel que porté par l'export `piloteo-v1-export`) à une projection
 * Next (produite par `reducer.js#reduce`, ex. via `importV1`). Vérifie :
 * nombre d'entités, présence de chaque id/numero, égalité de champs.
 * Ignore les tombstones (`__deleted:true`) côté projection (une entité
 * supprimée n'existe plus fonctionnellement).
 *
 * @param {object} v1State `exportObj.state` (les 12 collections V1, tableaux)
 * @param {object} projection projection Next (`{[entityType]: {[id]: entity}}`)
 * @returns {{ok:boolean, differences:Array<object>}}
 */
export function compareCollections(v1State, projection) {
  if (!v1State || typeof v1State !== "object") {
    throw new TypeError("compareCollections: v1State requis");
  }
  if (!projection || typeof projection !== "object") {
    throw new TypeError("compareCollections: projection requise");
  }

  const differences = [];

  for (const entityType of Object.keys(ENTITY_TYPES)) {
    const key = identityKey(entityType);
    const v1Collection = Array.isArray(v1State[entityType]) ? v1State[entityType] : [];
    const projBucket = projection[entityType] || {};
    const activeEntries = Object.entries(projBucket).filter(([, v]) => !(v && v.__deleted));

    if (v1Collection.length !== activeEntries.length) {
      differences.push({
        entityType,
        kind: "count-mismatch",
        expectedCount: v1Collection.length,
        actualCount: activeEntries.length,
      });
    }

    const v1ById = new Map();
    for (const entity of v1Collection) {
      const id = entity ? String(entity[key]) : undefined;
      if (id !== undefined) v1ById.set(id, entity);
    }

    const seen = new Set();
    for (const [id, actualEntity] of activeEntries) {
      seen.add(id);
      if (!v1ById.has(id)) {
        differences.push({ entityType, kind: "unexpected-id", id });
        continue;
      }
      const expectedEntity = v1ById.get(id);
      if (!deepEqual(expectedEntity, actualEntity)) {
        differences.push({ entityType, kind: "field-mismatch", id });
      }
    }
    for (const id of v1ById.keys()) {
      if (!seen.has(id)) {
        differences.push({ entityType, kind: "missing-id", id });
      }
    }
  }

  return { ok: differences.length === 0, differences };
}
