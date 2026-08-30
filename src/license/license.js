// src/license/license.js
//
// Licence Pilotéo Next — CONTRACTS.md §10, docs/next/06_LICENCE_ET_ESSAI.md.
//
// Décisions/hypothèses :
// - La licence est vérifiée localement, signée Ed25519 par l'éditeur (clé
//   privée hors PWA, cf. `tools/license-gen/`). Ce module n'embarque QUE la
//   clé publique de vérification (`EDITOR_PUBLIC_KEY_JWK`, placeholder ici —
//   voir note à côté de la constante).
// - `canonicalizeLicense` réutilise `canonicalize` de `events/event-schema.js`
//   (tri récursif des clés, rejet des nombres non finis/undefined, retire la
//   clé `signature`) : mêmes principes déterministes que la canonicalisation
//   des événements, sans dupliquer la logique.
// - `verifyLicense` sépare deux notions volontairement : `valid` (forme +
//   signature Ed25519 + workspace correspondant + fenêtre `notBefore<=now`
//   respectée) et `expired` (calculé indépendamment : `expiresAt != null &&
//   now > expiresAt`). Une licence peut donc être `valid:true, expired:true`
//   (licence authentique mais échue) — c'est `licenseStatus`/`enforcement`
//   qui en tirent la politique d'usage, pas `verifyLicense`.
// - Une licence malformée, une signature invalide ou un `workspaceId` différent
//   rendent `valid:false` (avec `reason` et `expired:null`, indéterminé).
// - `notBefore > now` ⇒ `valid:false, reason:'not-yet-valid'` (licence pas
//   encore entrée en vigueur) — distinct d'une expiration.
// - `expiresAt:null` = licence perpétuelle (jamais expirée).
// - `trialStatus(workspaceCreatedAt, now, {trialDays=20})` : essai ancré à
//   `workspace.created` (docs/next/06 §3). `daysLeft` est le nombre de jours
//   PLEINS restants avant expiration, jamais négatif (clampé à 0) ; l'état
//   passe à `"expired"` dès que `daysLeft` atteint 0 (donc au jour J20 pour un
//   essai de 20 jours démarré à J0), conformément aux cas de test attendus
//   (J0/J19 => trial, J20/J21 => expired).
// - `licenseStatus(workspace, license, now, {publicKeyJwk})` compose essai +
//   licence : un workspace en mode `"local"` est toujours `"none"` (gratuit,
//   docs/next/06 §2 — pas de licence à vérifier) ; sinon une licence valide
//   l'emporte sur l'essai (`"active"`/`"expired"` selon `expired`), et en son
//   absence (ou invalide) on retombe sur l'état d'essai (`"trial"`/`"expired"`).
//   Une licence invalide n'est PAS traitée comme une erreur bloquante : elle
//   est simplement ignorée au profit de l'essai (pas de fraude à punir plus
//   que documenté, cf. docs/next/06 §10 — limites assumées).
// - `enforcement(status)` : jamais de blocage de lecture/export/sauvegarde/
//   consultation de la licence, quel que soit le statut (docs/next/06 §8).
//   Seules création/modification/invitation sont bloquées quand `status ===
//   "expired"`. Les statuts `"trial"`, `"active"`, `"none"` autorisent tout.
// - `canAddMember(activeCount, maxMembers)` : `maxMembers` non défini/`null`
//   = illimité (`true`). Compare aux memberships **actifs** uniquement (à la
//   charge de l'appelant de ne compter que `status:"active"`, cf. CONTRACTS §8).
// - Aucun secret de génération ici : `sign()` (clé privée) n'est jamais importé
//   par ce module, seul `verify()` l'est (crypto/crypto-service.js).

import { verify } from "../crypto/crypto-service.js";
import { canonicalize } from "../events/event-schema.js";

export const LICENSE_FORMAT = "piloteo-license-v1";
export const DEFAULT_TRIAL_DAYS = 20;

// ---------------------------------------------------------------------------
// Clé publique éditeur — PLACEHOLDER.
//
// ⚠️ Ceci N'EST PAS une vraie clé. Elle doit être remplacée, avant toute
// distribution de la PWA, par la clé publique JWK réelle imprimée par
// `tools/license-gen/generate-license.mjs` lors de la génération de la paire
// éditeur. La clé PRIVÉE correspondante ne doit JAMAIS apparaître ici, dans
// ce dépôt, ni dans aucun artefact livré à un navigateur.
//
// Toute vérification de licence avec ce placeholder échouera systématiquement
// (aucune signature ne peut correspondre) — c'est le comportement voulu tant
// que la vraie clé n'a pas été injectée.
// ---------------------------------------------------------------------------
export const EDITOR_PUBLIC_KEY_JWK = Object.freeze({
  __PLACEHOLDER__: true,
  kty: "OKP",
  crv: "Ed25519",
  x: "PLACEHOLDER-A-REMPLACER-PAR-LA-CLE-PUBLIQUE-REELLE",
});

// ---------------------------------------------------------------------------
// Canonicalisation
// ---------------------------------------------------------------------------

/**
 * Bytes déterministes de la licence, SANS `signature` — mêmes principes que
 * `events/event-schema.js#canonicalize` (tri récursif des clés, rejet des
 * nombres non finis / valeurs non sérialisables).
 * @param {object} license
 * @returns {Uint8Array}
 */
export function canonicalizeLicense(license) {
  if (!license || typeof license !== "object" || Array.isArray(license)) {
    throw new TypeError("canonicalizeLicense: license doit être un objet");
  }
  return canonicalize(license);
}

// ---------------------------------------------------------------------------
// Validation de forme
// ---------------------------------------------------------------------------

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function isIsoDateTimeString(v) {
  return typeof v === "string" && ISO_DATETIME_RE.test(v) && Number.isFinite(Date.parse(v));
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function isFiniteInteger(v) {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}

/**
 * Vérifie uniquement la FORME du payload de licence (pas la signature).
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function checkLicenseShape(license) {
  if (!license || typeof license !== "object" || Array.isArray(license)) {
    return { ok: false, reason: "malformed: license doit être un objet" };
  }
  if (license.format !== LICENSE_FORMAT) {
    return { ok: false, reason: `malformed: format inattendu (${license.format})` };
  }
  if (!isNonEmptyString(license.licenseId)) {
    return { ok: false, reason: "malformed: licenseId manquant/mal formé" };
  }
  if (!isNonEmptyString(license.workspaceId)) {
    return { ok: false, reason: "malformed: workspaceId manquant/mal formé" };
  }
  if (!isNonEmptyString(license.plan)) {
    return { ok: false, reason: "malformed: plan manquant/mal formé" };
  }
  if (
    license.maxMembers !== null &&
    license.maxMembers !== undefined &&
    (!isFiniteInteger(license.maxMembers) || license.maxMembers < 0)
  ) {
    return { ok: false, reason: "malformed: maxMembers invalide" };
  }
  if (!isIsoDateTimeString(license.issuedAt)) {
    return { ok: false, reason: "malformed: issuedAt invalide" };
  }
  if (!isIsoDateTimeString(license.notBefore)) {
    return { ok: false, reason: "malformed: notBefore invalide" };
  }
  if (license.expiresAt !== null && !isIsoDateTimeString(license.expiresAt)) {
    return { ok: false, reason: "malformed: expiresAt invalide (doit être ISO ou null)" };
  }
  if (license.features !== undefined && !Array.isArray(license.features)) {
    return { ok: false, reason: "malformed: features doit être un tableau" };
  }
  if (!isNonEmptyString(license.signature)) {
    return { ok: false, reason: "malformed: signature manquante/mal formée" };
  }
  return { ok: true };
}

function toDate(value) {
  if (value instanceof Date) return value;
  const d = new Date(value ?? Date.now());
  if (!Number.isFinite(d.getTime())) {
    throw new TypeError("date invalide");
  }
  return d;
}

// ---------------------------------------------------------------------------
// Vérification
// ---------------------------------------------------------------------------

/**
 * Vérifie une licence localement : forme, signature Ed25519, workspace
 * correspondant, fenêtre de validité `notBefore`.
 * @param {object} license
 * @param {{publicKeyJwk:object, workspaceId:string, now?: Date|string|number}} opts
 * @returns {Promise<{valid:boolean, reason:string|null, plan:string|null, expired:boolean|null}>}
 */
export async function verifyLicense(license, { publicKeyJwk, workspaceId, now } = {}) {
  const shape = checkLicenseShape(license);
  if (!shape.ok) {
    return { valid: false, reason: shape.reason, plan: license && license.plan != null ? license.plan : null, expired: null };
  }

  if (workspaceId !== undefined && license.workspaceId !== workspaceId) {
    return { valid: false, reason: "workspace-mismatch", plan: license.plan, expired: null };
  }

  let sigOk = false;
  try {
    const bytes = canonicalizeLicense(license);
    sigOk = await verify(publicKeyJwk, bytes, license.signature);
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return { valid: false, reason: "invalid-signature", plan: license.plan, expired: null };
  }

  let nowDate;
  try {
    nowDate = toDate(now);
  } catch {
    return { valid: false, reason: "malformed: now invalide", plan: license.plan, expired: null };
  }

  const notBefore = new Date(license.notBefore);
  if (nowDate.getTime() < notBefore.getTime()) {
    return { valid: false, reason: "not-yet-valid", plan: license.plan, expired: false };
  }

  const expired = license.expiresAt != null && nowDate.getTime() > new Date(license.expiresAt).getTime();
  return { valid: true, reason: null, plan: license.plan, expired };
}

// ---------------------------------------------------------------------------
// Essai
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * État de l'essai Team (20 jours par défaut), ancré à `workspace.created`.
 * @param {Date|string|number} workspaceCreatedAt
 * @param {Date|string|number} now
 * @param {{trialDays?:number}} opts
 * @returns {{state:"trial"|"expired", daysLeft:number}}
 */
export function trialStatus(workspaceCreatedAt, now, { trialDays = DEFAULT_TRIAL_DAYS } = {}) {
  const created = toDate(workspaceCreatedAt);
  const nowDate = toDate(now);
  const elapsedMs = nowDate.getTime() - created.getTime();
  const elapsedDays = Math.floor(elapsedMs / DAY_MS);
  const remaining = trialDays - elapsedDays;
  const state = remaining > 0 ? "trial" : "expired";
  return { state, daysLeft: Math.max(0, remaining) };
}

// ---------------------------------------------------------------------------
// Statut composé
// ---------------------------------------------------------------------------

/**
 * Compose essai + licence pour produire le statut effectif du workspace.
 * Un workspace `mode:"local"` est toujours gratuit (`"none"`) : aucune
 * licence n'est requise (docs/next/06 §2).
 * @param {object} workspace {id, mode, createdAt, ...}
 * @param {object|null|undefined} license
 * @param {Date|string|number} now
 * @param {{publicKeyJwk?:object, trialDays?:number}} opts
 * @returns {Promise<"trial"|"active"|"expired"|"none">}
 */
export async function licenseStatus(workspace, license, now, opts = {}) {
  if (!workspace || typeof workspace !== "object") {
    return "none";
  }
  if (workspace.mode === "local") {
    return "none";
  }

  const publicKeyJwk = opts.publicKeyJwk ?? EDITOR_PUBLIC_KEY_JWK;

  if (license) {
    const result = await verifyLicense(license, { publicKeyJwk, workspaceId: workspace.id, now });
    if (result.valid) {
      return result.expired ? "expired" : "active";
    }
    // Licence fournie mais invalide (signature, workspace, forme) : on ne
    // punit pas plus que l'essai (cf. docs/next/06 §10, pas de backend
    // d'activation) — on retombe sur l'état d'essai ci-dessous.
  }

  const trial = trialStatus(workspace.createdAt, now, { trialDays: opts.trialDays ?? DEFAULT_TRIAL_DAYS });
  return trial.state;
}

// ---------------------------------------------------------------------------
// Capacités (docs/next/06 §8) — jamais de blocage lecture/export/sauvegarde.
// ---------------------------------------------------------------------------

/**
 * @param {"trial"|"active"|"expired"|"none"} status
 * @returns {{read:boolean, export:boolean, backup:boolean, viewLicense:boolean,
 *            create:boolean, update:boolean, invite:boolean, write:boolean}}
 */
export function enforcement(status) {
  const blocked = status === "expired";
  return {
    read: true,
    export: true,
    backup: true,
    viewLicense: true,
    create: !blocked,
    update: !blocked,
    invite: !blocked,
    write: !blocked,
  };
}

// ---------------------------------------------------------------------------
// Membres (docs/next/06 §7) — `maxMembers` vérifié sur memberships actifs.
// ---------------------------------------------------------------------------

/**
 * @param {number} activeCount nombre de memberships `status:"active"` actuels
 * @param {number|null|undefined} maxMembers limite de la licence (`null`/`undefined` = illimité)
 * @returns {boolean}
 */
export function canAddMember(activeCount, maxMembers) {
  if (maxMembers === null || maxMembers === undefined) return true;
  if (!isFiniteInteger(maxMembers) || maxMembers < 0) {
    throw new TypeError("canAddMember: maxMembers invalide");
  }
  if (!isFiniteInteger(activeCount) || activeCount < 0) {
    throw new TypeError("canAddMember: activeCount invalide");
  }
  return activeCount < maxMembers;
}
