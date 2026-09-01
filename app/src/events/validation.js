// events/validation.js
//
// Décisions/hypothèses (CONTRACTS.md §2, V1_DOMAIN_MAP.md §1 et §7) :
// - La V1 ne validait rien (JSON Python accepte NaN/Infinity). Ce module
//   corrige cette dette : toute valeur non finie est refusée, récursivement,
//   n'importe où dans le payload (tableaux et objets imbriqués compris).
// - `MAX_PAYLOAD_BYTES` = 256 Ko : borne raisonnable pour un événement métier
//   (le plus gros payload V1, `affaires`, reste largement en dessous en usage
//   normal ; au-delà c'est très probablement une anomalie/abus).
// - `validatePayload(entityType, operation, payload, {refs})` : `refs` est un
//   objet optionnel de vérification croisée, à la charge de l'appelant
//   (PolicyEngine/SyncEngine) :
//     refs.workspaceId       : workspaceId attendu — si le payload porte lui
//                               même un champ `workspaceId` différent, il est
//                               considéré comme une référence à un workspace
//                               étranger et rejeté.
//     refs.consultants / .affaires / .missions / .organisations /
//     .categoriesFrais / .bordereaux : `Set` des identifiants connus dans CE
//                               workspace. Si fourni, tout champ de référence
//                               correspondant du payload (consultantId,
//                               affaireId, missionId, organisationId,
//                               categorieFraisId, numeroBordereau) doit exister
//                               dans l'ensemble, sinon rejet « référence
//                               inexistante ». Un ensemble non fourni = pas de
//                               vérification (permet un usage partiel/dégradé).
// - `operation === "delete"` : payload minimal accepté (`null` ou objet ne
//   portant que la clé d'identité) — la V1 ne modifie que l'existence de
//   l'entité, pas ses champs, lors d'une suppression.
// - Validateurs dédiés pour saisies/notesFrais/missions/affaires/bordereauxFrais
//   (champs et énumérations lus dans `V1_DOMAIN_MAP.md` §1 et `app.js`,
//   ex. `STATUTS_AFFAIRE`, cycle de vie bordereau « en saisie → note à payer →
//   payée »). Les autres entityTypes reçoivent une validation générique
//   stricte : payload objet, identifiant présent et bien formé, aucune valeur
//   non finie/non sérialisable.

import {
  ENTITY_TYPES,
  OPERATIONS,
  identityKey,
} from "./event-schema.js";

export const MAX_PAYLOAD_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Enveloppe
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuidLike(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
function isIsoDateTimeString(v) {
  return typeof v === "string" && ISO_DATETIME_RE.test(v) && Number.isFinite(Date.parse(v));
}

const EVENT_SCHEMA_VERSION = 1;

export function validateEnvelope(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return { ok: false, reason: "envelope: un objet est attendu" };
  }
  if (event.version !== EVENT_SCHEMA_VERSION) {
    return { ok: false, reason: `envelope: version de schéma incompatible (${event.version})` };
  }
  if (!isUuidLike(event.eventId)) return { ok: false, reason: "envelope: eventId manquant/mal formé" };
  if (!isUuidLike(event.workspaceId)) return { ok: false, reason: "envelope: workspaceId manquant/mal formé" };
  if (!Object.prototype.hasOwnProperty.call(ENTITY_TYPES, event.entityType)) {
    return { ok: false, reason: `envelope: entityType inconnu (${event.entityType})` };
  }
  if (typeof event.entityId !== "string" || event.entityId.length === 0) {
    return { ok: false, reason: "envelope: entityId manquant/mal formé" };
  }
  if (!OPERATIONS.includes(event.operation)) {
    return { ok: false, reason: `envelope: operation inconnue (${event.operation})` };
  }
  if (!isUuidLike(event.actorId)) return { ok: false, reason: "envelope: actorId manquant/mal formé" };
  if (
    typeof event.baseVersion !== "number" ||
    !Number.isFinite(event.baseVersion) ||
    !Number.isInteger(event.baseVersion) ||
    event.baseVersion < 0
  ) {
    return { ok: false, reason: "envelope: baseVersion invalide" };
  }
  if (
    typeof event.epoch !== "number" ||
    !Number.isFinite(event.epoch) ||
    !Number.isInteger(event.epoch) ||
    event.epoch < 1
  ) {
    return { ok: false, reason: "envelope: epoch invalide" };
  }
  if (!isIsoDateTimeString(event.createdAt)) {
    return { ok: false, reason: "envelope: createdAt invalide" };
  }

  const hasCiphertext = typeof event.ciphertext === "string" && event.ciphertext.length > 0;
  const hasPayload =
    Object.prototype.hasOwnProperty.call(event, "payload") &&
    (event.payload === null || (typeof event.payload === "object" && !Array.isArray(event.payload)));
  if (!hasCiphertext && !hasPayload) {
    return { ok: false, reason: "envelope: ni ciphertext ni payload exploitable" };
  }
  if (
    Object.prototype.hasOwnProperty.call(event, "signature") &&
    event.signature !== undefined &&
    event.signature !== null &&
    typeof event.signature !== "string"
  ) {
    return { ok: false, reason: "envelope: signature mal formée" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers de type
// ---------------------------------------------------------------------------

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isFiniteInteger(v) {
  return isFiniteNumber(v) && Number.isInteger(v);
}
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isBoolean(v) {
  return typeof v === "boolean";
}
function isEnum(v, allowed) {
  return typeof v === "string" && allowed.includes(v);
}
// Une "date" doit être une chaîne parseable ; un objet (ex: `new Date()`, `{}`)
// est explicitement rejeté même si `Date.parse` accepterait sa version
// stringifiée par coercion implicite.
function isValidDateValue(v) {
  return typeof v === "string" && v.length > 0 && Number.isFinite(Date.parse(v));
}

/** Cherche récursivement un nombre non fini (NaN/Infinity/-Infinity) dans une valeur quelconque. */
function findNonFinite(value, path = "$") {
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : path;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = findNonFinite(value[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) {
      const r = findNonFinite(value[k], `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  return null;
}

function payloadByteSize(payload) {
  const json = JSON.stringify(payload === undefined ? null : payload);
  return new TextEncoder().encode(json).length;
}

// ---------------------------------------------------------------------------
// Validateurs par entité (V1_DOMAIN_MAP.md §1)
// ---------------------------------------------------------------------------

const SAISIE_TYPES = ["mission", "interne", "absence"];

function validateSaisiePayload(payload) {
  if (!isNonEmptyString(payload.id)) return { ok: false, reason: "saisies: id manquant/mal formé" };
  if (!isValidDateValue(payload.date)) return { ok: false, reason: "saisies: date invalide" };
  if (!isNonEmptyString(payload.consultantId)) return { ok: false, reason: "saisies: consultantId manquant" };
  if (!isEnum(payload.type, SAISIE_TYPES)) return { ok: false, reason: "saisies: type inconnu" };
  if (payload.missionId !== null && payload.missionId !== undefined && !isNonEmptyString(payload.missionId)) {
    return { ok: false, reason: "saisies: missionId mal formé" };
  }
  if (payload.type === "mission" && !isNonEmptyString(payload.missionId)) {
    return { ok: false, reason: "saisies: missionId requis quand type=mission" };
  }
  if (payload.categorie !== null && payload.categorie !== undefined && typeof payload.categorie !== "string") {
    return { ok: false, reason: "saisies: categorie mal formée" };
  }
  if (!isFiniteNumber(payload.dureeH) || payload.dureeH < 0) {
    return { ok: false, reason: "saisies: dureeH invalide" };
  }
  if (!isFiniteNumber(payload.pctFact) || payload.pctFact < 0 || payload.pctFact > 100) {
    return { ok: false, reason: "saisies: pctFact hors bornes [0,100]" };
  }
  if (payload.commentaire !== undefined && payload.commentaire !== null && typeof payload.commentaire !== "string") {
    return { ok: false, reason: "saisies: commentaire mal formé" };
  }
  return { ok: true };
}

function validateNotesFraisPayload(payload) {
  if (!isNonEmptyString(payload.id)) return { ok: false, reason: "notesFrais: id manquant/mal formé" };
  if (!isValidDateValue(payload.date)) return { ok: false, reason: "notesFrais: date invalide" };
  if (!isNonEmptyString(payload.consultantId)) return { ok: false, reason: "notesFrais: consultantId manquant" };

  const hasAffaire = payload.affaireId !== null && payload.affaireId !== undefined;
  if (hasAffaire && typeof payload.affaireId !== "string") {
    return { ok: false, reason: "notesFrais: affaireId mal formé" };
  }
  const hasCatInterne = payload.categorieTempsInterne !== null && payload.categorieTempsInterne !== undefined;
  if (hasCatInterne && typeof payload.categorieTempsInterne !== "string") {
    return { ok: false, reason: "notesFrais: categorieTempsInterne mal formé" };
  }
  if (hasAffaire && hasCatInterne) {
    return { ok: false, reason: "notesFrais: affaireId et categorieTempsInterne sont exclusifs" };
  }
  if (!isNonEmptyString(payload.categorieFraisId)) {
    return { ok: false, reason: "notesFrais: categorieFraisId manquant" };
  }
  if (!isBoolean(payload.refacturable)) {
    return { ok: false, reason: "notesFrais: refacturable doit être un booléen" };
  }
  if (!isNonEmptyString(payload.numeroBordereau)) {
    return { ok: false, reason: "notesFrais: numeroBordereau manquant" };
  }
  if (!Array.isArray(payload.lignesTVA)) {
    return { ok: false, reason: "notesFrais: lignesTVA doit être un tableau" };
  }
  for (let i = 0; i < payload.lignesTVA.length; i++) {
    const ligne = payload.lignesTVA[i];
    if (!isPlainObject(ligne)) return { ok: false, reason: `notesFrais: lignesTVA[${i}] doit être un objet` };
    if (!isFiniteNumber(ligne.tauxTVA) || ligne.tauxTVA < 0) {
      return { ok: false, reason: `notesFrais: lignesTVA[${i}].tauxTVA invalide` };
    }
    if (!isFiniteNumber(ligne.montantHT)) {
      return { ok: false, reason: `notesFrais: lignesTVA[${i}].montantHT invalide` };
    }
    if (!isFiniteNumber(ligne.montantTVA)) {
      return { ok: false, reason: `notesFrais: lignesTVA[${i}].montantTVA invalide` };
    }
  }
  if (payload.commentaire !== undefined && payload.commentaire !== null && typeof payload.commentaire !== "string") {
    return { ok: false, reason: "notesFrais: commentaire mal formé" };
  }
  return { ok: true };
}

const MISSION_STATUTS = ["en cours", "terminée"];
const MOIS_RE = /^\d{4}-\d{2}$/;

function validateMissionPayload(payload) {
  if (!isNonEmptyString(payload.id)) return { ok: false, reason: "missions: id manquant/mal formé" };
  if (!isNonEmptyString(payload.affaireId)) return { ok: false, reason: "missions: affaireId manquant" };
  if (!isNonEmptyString(payload.nom)) return { ok: false, reason: "missions: nom manquant" };
  if (!isNonEmptyString(payload.consultantId)) return { ok: false, reason: "missions: consultantId manquant" };
  if (!isEnum(payload.statut, MISSION_STATUTS)) return { ok: false, reason: "missions: statut inconnu" };
  if (!isFiniteNumber(payload.enveloppe) || payload.enveloppe < 0) {
    return { ok: false, reason: "missions: enveloppe invalide" };
  }
  if (!isFiniteNumber(payload.taux) || payload.taux < 0) {
    return { ok: false, reason: "missions: taux invalide" };
  }
  if (payload.dateDebut !== undefined && payload.dateDebut !== null && !isValidDateValue(payload.dateDebut)) {
    return { ok: false, reason: "missions: dateDebut invalide" };
  }
  if (payload.dateFin !== undefined && payload.dateFin !== null && !isValidDateValue(payload.dateFin)) {
    return { ok: false, reason: "missions: dateFin invalide" };
  }
  if (
    payload.commentaires !== undefined &&
    payload.commentaires !== null &&
    typeof payload.commentaires !== "string"
  ) {
    return { ok: false, reason: "missions: commentaires mal formé" };
  }
  if (payload.projectionManuelle !== undefined && payload.projectionManuelle !== null) {
    if (!isPlainObject(payload.projectionManuelle)) {
      return { ok: false, reason: "missions: projectionManuelle doit être un objet" };
    }
    for (const [mois, jours] of Object.entries(payload.projectionManuelle)) {
      if (!MOIS_RE.test(mois)) return { ok: false, reason: `missions: clé de projectionManuelle invalide (${mois})` };
      if (!isFiniteNumber(jours)) {
        return { ok: false, reason: `missions: valeur de projectionManuelle invalide (${mois})` };
      }
    }
  }
  return { ok: true };
}

const AFFAIRE_STATUTS = ["en commercialisation", "en production", "terminée", "perdue"];
const PARTENAIRE_ROLES = ["mandataire", "co-traitant", "sous-traitant direct", "sous-traitant indirect"];

function validateAffairePayload(payload) {
  if (!isNonEmptyString(payload.id)) return { ok: false, reason: "affaires: id manquant/mal formé" };
  if (!isNonEmptyString(payload.nom)) return { ok: false, reason: "affaires: nom manquant" };
  if (!isNonEmptyString(payload.organisationId)) return { ok: false, reason: "affaires: organisationId manquant" };
  if (!isEnum(payload.statut, AFFAIRE_STATUTS)) return { ok: false, reason: "affaires: statut inconnu" };

  if (payload.nomAbrege !== undefined && payload.nomAbrege !== null && typeof payload.nomAbrege !== "string") {
    return { ok: false, reason: "affaires: nomAbrege mal formé" };
  }
  if (payload.motsCles !== undefined && payload.motsCles !== null && typeof payload.motsCles !== "string") {
    return { ok: false, reason: "affaires: motsCles mal formé" };
  }
  if (payload.pilote !== undefined && payload.pilote !== null && typeof payload.pilote !== "string") {
    return { ok: false, reason: "affaires: pilote mal formé" };
  }
  if (
    payload.piloteCommercial !== undefined &&
    payload.piloteCommercial !== null &&
    typeof payload.piloteCommercial !== "string"
  ) {
    return { ok: false, reason: "affaires: piloteCommercial mal formé" };
  }
  if (payload.typeVente !== undefined && payload.typeVente !== null && typeof payload.typeVente !== "string") {
    return { ok: false, reason: "affaires: typeVente mal formé" };
  }
  if (payload.pctReussite !== undefined && payload.pctReussite !== null) {
    if (!isFiniteNumber(payload.pctReussite) || payload.pctReussite < 0 || payload.pctReussite > 100) {
      return { ok: false, reason: "affaires: pctReussite hors bornes [0,100]" };
    }
  }
  if (payload.dateDepot !== undefined && payload.dateDepot !== null && !isValidDateValue(payload.dateDepot)) {
    return { ok: false, reason: "affaires: dateDepot invalide" };
  }
  if (payload.budget !== undefined && payload.budget !== null && !isFiniteNumber(payload.budget)) {
    return { ok: false, reason: "affaires: budget invalide" };
  }
  if (payload.jours !== undefined && payload.jours !== null && !isFiniteNumber(payload.jours)) {
    return { ok: false, reason: "affaires: jours invalide" };
  }
  if (payload.frais !== undefined && payload.frais !== null && !isFiniteNumber(payload.frais)) {
    return { ok: false, reason: "affaires: frais invalide" };
  }
  if (payload.dateDebut !== undefined && payload.dateDebut !== null && !isValidDateValue(payload.dateDebut)) {
    return { ok: false, reason: "affaires: dateDebut invalide" };
  }
  if (payload.dateFin !== undefined && payload.dateFin !== null && !isValidDateValue(payload.dateFin)) {
    return { ok: false, reason: "affaires: dateFin invalide" };
  }
  for (const field of ["methodes", "territoires", "domaines"]) {
    if (payload[field] !== undefined && payload[field] !== null) {
      if (!Array.isArray(payload[field]) || !payload[field].every((v) => typeof v === "string")) {
        return { ok: false, reason: `affaires: ${field} doit être un tableau d'ids` };
      }
    }
  }
  if (payload.partenaires !== undefined && payload.partenaires !== null) {
    if (!Array.isArray(payload.partenaires)) return { ok: false, reason: "affaires: partenaires doit être un tableau" };
    for (let i = 0; i < payload.partenaires.length; i++) {
      const p = payload.partenaires[i];
      if (!isPlainObject(p)) return { ok: false, reason: `affaires: partenaires[${i}] doit être un objet` };
      if (!isNonEmptyString(p.organisationId)) {
        return { ok: false, reason: `affaires: partenaires[${i}].organisationId manquant` };
      }
      if (!isEnum(p.role, PARTENAIRE_ROLES)) return { ok: false, reason: `affaires: partenaires[${i}].role inconnu` };
      if (p.montant !== undefined && p.montant !== null && !isFiniteNumber(p.montant)) {
        return { ok: false, reason: `affaires: partenaires[${i}].montant invalide` };
      }
    }
  }
  if (payload.repartitionCommerciale !== undefined && payload.repartitionCommerciale !== null) {
    if (!Array.isArray(payload.repartitionCommerciale)) {
      return { ok: false, reason: "affaires: repartitionCommerciale doit être un tableau" };
    }
    for (let i = 0; i < payload.repartitionCommerciale.length; i++) {
      const r = payload.repartitionCommerciale[i];
      if (!isPlainObject(r)) return { ok: false, reason: `affaires: repartitionCommerciale[${i}] doit être un objet` };
      if (!isNonEmptyString(r.consultantId)) {
        return { ok: false, reason: `affaires: repartitionCommerciale[${i}].consultantId manquant` };
      }
      if (!isFiniteNumber(r.pct) || r.pct < 0 || r.pct > 100) {
        return { ok: false, reason: `affaires: repartitionCommerciale[${i}].pct hors bornes` };
      }
    }
  }
  return { ok: true };
}

const BORDEREAU_STATUTS = ["en saisie", "note à payer", "payée"];

function validateBordereauPayload(payload) {
  if (!isNonEmptyString(payload.numero)) return { ok: false, reason: "bordereauxFrais: numero manquant/mal formé" };
  if (!isNonEmptyString(payload.consultantId)) return { ok: false, reason: "bordereauxFrais: consultantId manquant" };
  if (!isFiniteInteger(payload.annee)) return { ok: false, reason: "bordereauxFrais: annee invalide" };
  if (!isFiniteInteger(payload.seq)) return { ok: false, reason: "bordereauxFrais: seq invalide" };
  if (!isEnum(payload.statut, BORDEREAU_STATUTS)) return { ok: false, reason: "bordereauxFrais: statut inconnu" };
  if (
    payload.datePaiement !== undefined &&
    payload.datePaiement !== null &&
    !isValidDateValue(payload.datePaiement)
  ) {
    return { ok: false, reason: "bordereauxFrais: datePaiement invalide" };
  }
  return { ok: true };
}

/** Validation générique stricte pour les entityTypes sans validateur dédié. */
function validateGenericPayload(entityType, payload) {
  const key = identityKey(entityType);
  if (!isNonEmptyString(payload[key])) {
    return { ok: false, reason: `${entityType}: ${key} manquant/mal formé` };
  }
  return { ok: true };
}

const ENTITY_VALIDATORS = {
  saisies: validateSaisiePayload,
  notesFrais: validateNotesFraisPayload,
  missions: validateMissionPayload,
  affaires: validateAffairePayload,
  bordereauxFrais: validateBordereauPayload,
};

// ---------------------------------------------------------------------------
// Taille + références croisées (workspace étranger, référence inexistante)
// ---------------------------------------------------------------------------

const REF_FIELD_TO_REFS_KEY = {
  consultantId: "consultants",
  affaireId: "affaires",
  missionId: "missions",
  organisationId: "organisations",
  categorieFraisId: "categoriesFrais",
  numeroBordereau: "bordereaux",
};

function sizeAndRefsCheck(entityType, payload, refs) {
  const size = payloadByteSize(payload);
  if (size > MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: `payload: taille ${size} octets > MAX_PAYLOAD_BYTES (${MAX_PAYLOAD_BYTES})` };
  }
  if (refs && isPlainObject(payload)) {
    if (
      Object.prototype.hasOwnProperty.call(payload, "workspaceId") &&
      refs.workspaceId !== undefined &&
      payload.workspaceId !== refs.workspaceId
    ) {
      return { ok: false, reason: "payload: référence à un workspaceId étranger" };
    }
    for (const [field, refsKey] of Object.entries(REF_FIELD_TO_REFS_KEY)) {
      const allowedSet = refs[refsKey];
      if (!allowedSet) continue; // ensemble non fourni par l'appelant : pas vérifié
      const value = payload[field];
      if (value === undefined || value === null) continue;
      if (!allowedSet.has(value)) {
        return { ok: false, reason: `payload: référence inexistante (${field}=${value})` };
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------

export function validatePayload(entityType, operation, payload, { refs } = {}) {
  if (!Object.prototype.hasOwnProperty.call(ENTITY_TYPES, entityType)) {
    return { ok: false, reason: `entityType inconnu: ${entityType}` };
  }
  if (!OPERATIONS.includes(operation)) {
    return { ok: false, reason: `operation inconnue: ${operation}` };
  }

  if (operation === "delete") {
    if (payload === null || payload === undefined) return { ok: true };
    if (!isPlainObject(payload)) return { ok: false, reason: "delete: payload doit être null ou un objet" };
    const badPath = findNonFinite(payload);
    if (badPath) return { ok: false, reason: `payload: nombre non fini (NaN/Infinity) en ${badPath}` };
    const key = identityKey(entityType);
    if (payload[key] !== undefined && !isNonEmptyString(payload[key])) {
      return { ok: false, reason: `${entityType}: ${key} mal formé` };
    }
    return sizeAndRefsCheck(entityType, payload, refs);
  }

  if (!isPlainObject(payload)) {
    return { ok: false, reason: `${entityType}: payload doit être un objet pour ${operation}` };
  }

  const badPath = findNonFinite(payload);
  if (badPath) return { ok: false, reason: `payload: nombre non fini (NaN/Infinity) en ${badPath}` };

  const sizeCheck = sizeAndRefsCheck(entityType, payload, refs);
  if (!sizeCheck.ok) return sizeCheck;

  const validator = ENTITY_VALIDATORS[entityType];
  return validator ? validator(payload) : validateGenericPayload(entityType, payload);
}
