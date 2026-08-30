// events/event-schema.js
//
// Décisions/hypothèses (CONTRACTS.md §1, V1_DOMAIN_MAP.md §1) :
// - `ENTITY_TYPES` liste les 12 collections V1 avec leur clé d'identité propre ;
//   `bordereauxFrais` s'identifie par `numero`, toutes les autres par `id`.
// - `buildEvent` produit l'enveloppe SANS `signature` ni `ciphertext` : en mode
//   local non chiffré le payload voyage en clair dans le champ `payload` ; le
//   CryptoService (autre module) peut ensuite le remplacer par `ciphertext` et
//   ajouter `signature` avant publication. Ce module ne connaît pas la crypto.
// - `canonicalize` sérialise TOUTES les clés de l'enveloppe sauf `signature`
//   (donc `ciphertext` et/ou `payload` en clair sont inclus dans les octets
//   signés/vérifiés), avec un tri récursif des clés d'objet pour un résultat
//   déterministe indépendant de l'ordre d'insertion. Les nombres non finis
//   (NaN/±Infinity) et `undefined` sont refusés pour ne jamais produire une
//   sérialisation ambiguë ou silencieusement dégradée par `JSON.stringify`.
// - `isWellFormedEnvelope` ne juge que la FORME de l'enveloppe (présence/type
//   des champs), pas les règles métier du payload (voir validation.js) ni les
//   droits (PolicyEngine) ni la crypto (CryptoService).
// - Aucune dépendance Node : `crypto.randomUUID()` et `TextEncoder` sont des
//   globals navigateur ET Node (>=19) via `globalThis`.

export const EVENT_SCHEMA_VERSION = 1;

export const OPERATIONS = Object.freeze(["create", "update", "delete"]);

// Les 12 collections V1 (server.py COLLECTION_KEYS) -> clé d'identité.
export const ENTITY_TYPES = Object.freeze({
  consultants: "id",
  organisations: "id",
  affaires: "id",
  methodes: "id",
  typesTerritoire: "id",
  domainesIntervention: "id",
  categoriesFrais: "id",
  missions: "id",
  factures: "id",
  saisies: "id",
  bordereauxFrais: "numero",
  notesFrais: "id",
});

export function identityKey(entityType) {
  if (!Object.prototype.hasOwnProperty.call(ENTITY_TYPES, entityType)) {
    throw new TypeError(`identityKey: entityType inconnu: ${String(entityType)}`);
  }
  return ENTITY_TYPES[entityType];
}

/** Extrait la valeur d'identité d'un payload pour son entityType (ex: `numero` pour bordereauxFrais). */
export function identityValue(entityType, payload) {
  const key = identityKey(entityType);
  return payload ? payload[key] : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidLike(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

// ISO 8601 UTC strict, ex: 2026-08-30T12:00:00.000Z (le format produit par
// `Date.prototype.toISOString()`). On accepte aussi une précision sans
// millisecondes tant que le suffixe est bien "Z" (UTC).
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isIsoDateTimeString(value) {
  if (typeof value !== "string" || !ISO_DATETIME_RE.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function isFiniteInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

/**
 * Construit l'enveloppe d'un nouvel événement, sans `signature` ni `ciphertext`.
 * Le payload (objet métier en clair) est porté par le champ `payload`.
 */
export function buildEvent({
  workspaceId,
  entityType,
  entityId,
  operation,
  actorId,
  baseVersion,
  epoch,
  payload = null,
} = {}) {
  if (!isUuidLike(workspaceId)) {
    throw new TypeError("buildEvent: workspaceId doit être un UUID");
  }
  if (!Object.prototype.hasOwnProperty.call(ENTITY_TYPES, entityType)) {
    throw new TypeError(`buildEvent: entityType inconnu: ${String(entityType)}`);
  }
  if (typeof entityId !== "string" || entityId.length === 0) {
    throw new TypeError("buildEvent: entityId doit être une chaîne non vide");
  }
  if (!OPERATIONS.includes(operation)) {
    throw new TypeError(`buildEvent: operation inconnue: ${String(operation)}`);
  }
  if (!isUuidLike(actorId)) {
    throw new TypeError("buildEvent: actorId doit être un UUID");
  }
  if (!isFiniteInteger(baseVersion) || baseVersion < 0) {
    throw new TypeError("buildEvent: baseVersion doit être un entier >= 0");
  }
  if (!isFiniteInteger(epoch) || epoch < 1) {
    throw new TypeError("buildEvent: epoch doit être un entier >= 1");
  }

  return {
    version: EVENT_SCHEMA_VERSION,
    eventId: globalThis.crypto.randomUUID(),
    workspaceId,
    entityType,
    entityId,
    operation,
    actorId,
    baseVersion,
    epoch,
    createdAt: new Date().toISOString(),
    payload,
  };
}

/** Tri récursif des clés d'objet ; refuse les valeurs non sérialisables de façon déterministe. */
function canonicalValue(value) {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonicalize: nombre non fini (NaN/Infinity) interdit");
    }
    return value;
  }
  if (t === "undefined") {
    throw new TypeError("canonicalize: valeur undefined interdite");
  }
  if (t === "function" || t === "symbol" || t === "bigint") {
    throw new TypeError(`canonicalize: type non sérialisable: ${t}`);
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (t === "object") {
    const keys = Object.keys(value).sort();
    const out = {};
    for (const k of keys) {
      const v = value[k];
      if (v === undefined) continue; // champ optionnel absent : omis, pas sérialisé en "null"
      out[k] = canonicalValue(v);
    }
    return out;
  }
  throw new TypeError(`canonicalize: type non géré: ${t}`);
}

/**
 * Bytes déterministes de l'enveloppe (hors `signature`) pour signature/vérif.
 * Inclut `ciphertext` et/ou `payload` selon ce que porte l'événement.
 */
export function canonicalize(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("canonicalize: event doit être un objet");
  }
  const { signature, ...rest } = event;
  const canonical = canonicalValue(rest);
  const json = JSON.stringify(canonical);
  return new TextEncoder().encode(json);
}

/**
 * Vérifie la FORME de l'enveloppe uniquement (pas les règles métier).
 * Un ciphertext OU un payload (objet ou null pour delete) doit être présent.
 */
export function isWellFormedEnvelope(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  if (event.version !== EVENT_SCHEMA_VERSION) return false;
  if (!isUuidLike(event.eventId)) return false;
  if (!isUuidLike(event.workspaceId)) return false;
  if (!Object.prototype.hasOwnProperty.call(ENTITY_TYPES, event.entityType)) return false;
  if (typeof event.entityId !== "string" || event.entityId.length === 0) return false;
  if (!OPERATIONS.includes(event.operation)) return false;
  if (!isUuidLike(event.actorId)) return false;
  if (!isFiniteInteger(event.baseVersion) || event.baseVersion < 0) return false;
  if (!isFiniteInteger(event.epoch) || event.epoch < 1) return false;
  if (!isIsoDateTimeString(event.createdAt)) return false;

  const hasCiphertext = typeof event.ciphertext === "string" && event.ciphertext.length > 0;
  const hasPayload =
    Object.prototype.hasOwnProperty.call(event, "payload") &&
    (event.payload === null || (typeof event.payload === "object" && !Array.isArray(event.payload)));
  if (!hasCiphertext && !hasPayload) return false;

  if (
    Object.prototype.hasOwnProperty.call(event, "signature") &&
    event.signature !== undefined &&
    event.signature !== null &&
    typeof event.signature !== "string"
  ) {
    return false;
  }

  return true;
}
