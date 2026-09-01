// src/storage/google-drive-adapter.js
//
// GoogleDriveStorageAdapter — StorageAdapter (CONTRACTS.md §5) câblé sur l'API
// REST Google Drive v3, conforme à docs/next/DRIVE_LIVE_CONTRACT.md §1 et à
// l'arborescence docs/next/04_SYNC_ET_STOCKAGE_DRIVE.md §2, §5, §6, §9.
//
// CE QUI EST CÂBLÉ DANS CE LOT (Point 4) :
//   - `connect()` : résout/crée l'arbre de dossiers du workspace (racine
//     `rootFolderId` -> workspace/, members/, events/, keys/, licenses/),
//     idempotent, mis en cache par instance.
//   - `putImmutable(kind,id,blob)` : IDEMPOTENT / WRITE-ONCE. Avant tout
//     `files.create`, recherche un fichier du même NOM (opaque, jamais un nom
//     métier) ; s'il existe déjà avec un contenu IDENTIQUE -> succès idempotent
//     sans doublon (résout le "duplicate upload on retry") ; avec un contenu
//     DIFFÉRENT -> `ImmutableConflictError` (code `IMMUTABLE_CONFLICT`), jamais
//     d'écrasement. Sinon, upload multipart (mêmes en-têtes/format que le
//     spike `tools/team-spike/index.html`).
//   - `get(kind,id)` : localise par nom, `alt=media` ; absent -> `null` (PAS une
//     exception — déviation volontaire par rapport à la convention générale de
//     `StorageAdapter`/`InMemoryStorageAdapter`, explicitement demandée par le
//     contrat Drive §1).
//   - `listChanges(cursor)` : énumère `events/<AAAA-MM>/` (récursif mensuel),
//     triés par `(createdTime,name)`, en suivant `nextPageToken` jusqu'au bout
//     à CHAQUE appel `files.list` (jamais de retour partiel qui sauterait un
//     event) ; `cursor` = `{createdTime,id}` du dernier vu.
//   - `readMetadata`, `health()` : implémentations réelles légères (recherche
//     par nom / `files.list` minimal), ne lèvent plus `NotWiredError`.
//   - `share`/`revoke` : restent déclaratifs (hors scope de ce lot — gestion
//     d'ACL Drive), documentés `{ok:true, delegated:true}`, jamais un throw.
//   - Erreurs HTTP : 401/403 -> `DriveAuthError` (code `AUTH_ERROR`, immédiat,
//     sans retry — c'est à l'appelant de ré-obtenir un token et de réessayer) ;
//     404 -> `null` sur `get`/recherche (jamais une exception) ; 429/5xx ->
//     retry avec backoff exponentiel + jitter, `maxRetries` essais au total
//     (4 par défaut) ; l'idempotence de `putImmutable` rend ce retry sûr.
//
// CE QUI RESTE VÉRIFIABLE UNIQUEMENT EN NAVIGATEUR RÉEL (voir
// docs/next/DRIVE_LIVE_MANUAL.md) : l'obtention interactive d'un token OAuth
// (Google Identity Services exige un geste utilisateur + une fenêtre Google),
// et donc toute la matrice Drive réelle (My Drive, Shared Drive, token expiré,
// accès retiré, offline). Ce module ne dépend QUE de `fetch` et d'un
// `oauthTokenProvider` injecté : il est testé ici avec un `fetch` MOCKÉ
// (tests/next/drive-adapter-live.test.mjs), aucun réseau réel.
//
// Décisions/hypothèses (déviations documentées) :
// - `oauthTokenProvider` est appelée à CHAQUE opération réseau (jamais mise en
//   cache par CETTE classe : le cache mémoire + le re-déclenchement à
//   expiration sont la responsabilité de l'appelant navigateur,
//   `piloteo-drive-bridge.mjs`). Sa valeur de retour n'est JAMAIS stockée sur
//   `this` ni journalisée (seul un en-tête `Authorization` éphémère par requête
//   l'utilise).
// - Localisation d'un `(kind,id)` pour `get`/`putImmutable`/`exists`/`readMetadata` :
//   TOUJOURS scopée à un dossier, JAMAIS une recherche globale sur tout le
//   Drive du compte (correction #1, revue vérificateur — bug bloquant corrigé
//   dans ce lot). ATTENTION : contrairement à une hypothèse initiale erronée,
//   les noms de fichiers ne sont PAS tous des identifiants opaques uniques —
//   `fileNameForKind` renvoie des noms CONSTANTS pour `kind:"workspace"`
//   (toujours `manifest.piloteo`) et `kind:"license"` (toujours
//   `current.license`). Un compte Google membre de PLUSIEURS workspaces
//   Pilotéo sur le même Drive verrait donc, sans ce scoping, `get`/`exists`
//   retrouver N'IMPORTE QUEL `manifest.piloteo` du Drive (ordre non
//   déterministe côté API) — potentiellement celui d'un AUTRE workspace,
//   corrompant la chaîne causale/de signature locale. `putImmutable` résout
//   donc LE DOSSIER CIBLE EXACT en premier (mois/epoch pour event/key, dossier
//   de kind direct sinon) puis n'interroge QUE ce dossier
//   (`_findFileByNameInFolder`) ; `get`/`exists`/`readMetadata`, qui ne
//   reçoivent pas les métadonnées (`createdAt`/`epoch`) nécessaires pour
//   viser directement le sous-dossier mensuel/d'epoch d'un event/key, restent
//   NÉANMOINS scopés au sous-ARBRE de CE `kind` de CE workspace
//   (`_findFileByNameInKindSubtree` : dossier direct pour workspace/member/
//   license, énumération des sous-dossiers mois/epoch pour event/key) —
//   jamais hors de l'arborescence de `this.rootFolderId`. `listChanges`, lui,
//   reste scopé à `events/` par arborescence (parcours des sous-dossiers
//   mensuels), conformément au contrat §1 (« lister les fichiers d'events/ »).
// - Comparaison d'immutabilité (`putImmutable`) : sérialisation `JSON.stringify`
//   du blob (identique à `FolderStorageAdapter`), comparée en TEXTE au contenu
//   déjà stocké. Deux appels avec le MÊME objet logique produisent le même
//   texte (mêmes clés, même ordre — c'est l'appelant, `SyncEngine`/`solo-store`,
//   qui construit ce blob de façon déterministe) ; un contenu réellement
//   différent est donc bien détecté comme conflit.
// - `fetchImpl`/`sleepFn`/`maxRetries` sont des points d'injection additifs
//   (au constructeur), nécessaires pour tester le transport sans réseau réel
//   (fetch mocké) et sans attendre les délais de backoff réels en test. En
//   l'absence d'injection, `fetchImpl` retombe sur le `fetch` global de
//   l'environnement (navigateur) et `sleepFn` sur un vrai `setTimeout`.
// - `appDataFolder` n'est délibérément pas utilisé (privé à l'app, ne peut pas
//   être partagé — inadapté à un workspace d'équipe).
// - Aucune règle métier ici (comme pour tout StorageAdapter, CONTRACTS §5).
//
// RÉVISION POST-REVUE ADVERSE (docs/next/DRIVE_LIVE_CONTRACT.md §8, tests
// tests/next/attack-p4-drive-races.test.mjs / attack-p4-drive-misc.test.mjs) :
// - §8a `listChanges` : le tri ET le curseur utilisent désormais la MÊME clé
//   composite totale `(createdTime, fileId)` (`compareByCreatedTimeThenId`),
//   avec un curseur `{createdTime, seenIds}` (ensemble d'ids déjà délivrés au
//   `createdTime` maximal, pas un simple id-watermark) — élimine le
//   sauté-définitif et le redélivré-infini sur collision de `createdTime`.
//   Dédup physique par nom en sortie.
// - §8b `connect()`/`_ensureFolder`/fichiers à nom constant (`manifest.piloteo`,
//   `current.license`) : RÉCONCILIATION DÉTERMINISTE (« oldest-wins » par
//   `(createdTime,id)`), jamais un verrou — `_findFolder`/`_findFileByName*`
//   choisissent TOUJOURS le plus ancien candidat parmi tout ce qui existe ;
//   `connect()` fait un balayage de réconciliation final après le premier
//   passage find-or-create ; `get`/`readMetadata`/`putImmutable` détectent une
//   DIVERGENCE de contenu entre candidats et lèvent `ImmutableConflictError`
//   plutôt que de choisir au hasard. Fenêtre de course résiduelle documentée
//   dans `docs/next/DRIVE_CONFLITS_LOCKS.md` §2bis.
// - §8d 403 : seul un motif d'authentification/permission
//   (`authError`/`insufficientPermissions`, ou un corps sans motif reconnu)
//   lève `DriveAuthError` immédiatement ; un motif de QUOTA
//   (`rateLimitExceeded`/`userRateLimitExceeded`/`dailyLimitExceeded`) est
//   retenté comme un 429 (`is403QuotaBody`).
//
// RÉVISION POST-REVUE ADVERSE — ROUND 2 (docs/next/DRIVE_LIVE_CONTRACT.md §9,
// tests tests/next/attack-p4r2-drive-*.test.mjs) :
// - §9a `listChanges` (bug de FOND, PRIME sur l'efficacité) : retourne
//   désormais l'ensemble ordonné COMPLET des events à CHAQUE appel — le
//   `cursor` n'EXCLUT plus jamais rien (`createdTime` Drive n'est pas garanti
//   monotone avec l'ordre logique ; un filtre par watermark pouvait sauter un
//   event pour toujours). La re-livraison est sans danger : `SyncEngine`
//   déduplique par `_seen:Set<eventId>`, `EventLog` par `eventId`.
// - §9b `connect()`/`_liveTopFolder` : une instance déjà connectée re-résout
//   PARESSEUSEMENT (à chaque opération, pas seulement à `connect()`) le
//   dossier top-level qu'elle s'apprête à utiliser, et adopte tout candidat
//   prouvé plus ancien — plus de split-brain PERMANENT pour une instance
//   vivante quand un dossier plus ancien devient visible après coup.
// - §9c `_reconcileFileCandidates` : télécharge le gagnant (oldest) d'abord et
//   propage son échec ; les autres candidats ne sont téléchargés qu'en
//   best-effort — un orphelin surnuméraire illisible ne fait plus jamais
//   échouer une lecture que le seul gagnant aurait suffi à satisfaire.
// - §9d `canonicalStringify` : sérialisation à clés triées au lieu d'un
//   `JSON.stringify` brut — deux blobs logiquement identiques mais
//   sérialisés avec un ordre de clés différent ne déclenchent plus de FAUX
//   `IMMUTABLE_CONFLICT`.
// - §9e 403 : `is403QuotaBody` reconnaît aussi `error.status ===
//   "RESOURCE_EXHAUSTED"` (format `google.rpc.Status`) ; un motif d'auth
//   PERMANENT mélangé à un motif de quota dans `errors[]` PRIME toujours —
//   jamais masqué derrière des retries voués à échouer.
//
// RÉVISION POST-REVUE ADVERSE — ROUND 3 (docs/next/DRIVE_LIVE_CONTRACT.md §10,
// PERTE DE DONNÉES PERMANENTE, tests
// tests/next/attack-p4r3-drive-orphan-topfolder.test.mjs) :
// - §9b avait fait converger les ÉCRITURES vers le dossier top-level le plus
//   ancien (oldest-wins), mais les LECTURES (`listChanges`/`get`/
//   `readMetadata`/`exists`) ne parcouraient QUE le sous-arbre de ce gagnant —
//   un event ou un singleton écrit dans un dossier top-level DUPLIQUÉ
//   « perdant » (orphelin d'une course de création, §8b) devenait alors
//   INVISIBLE EN PERMANENCE pour TOUTE instance (même fraîche, même
//   pleinement convergée, même l'auteur de l'écriture) — violation directe de
//   §9a.
// - §10 corrige : `_allTopFolderIds` (remplace l'usage de `_liveTopFolder`
//   pour les LECTURES) renvoie TOUS les dossiers top-level `kind`, pas
//   seulement le gagnant. `_findAllFilesByNameInKindSubtree` (donc `get`/
//   `exists`/`readMetadata`) et `listChanges` UNISSENT désormais tous les
//   dossiers de même nom avant de conclure à une absence ou d'énumérer les
//   events. Les ÉCRITURES (`_resolveWriteParentId`, via `_liveTopFolder`)
//   continuent, elles, de converger vers le seul gagnant (oldest-wins,
//   inchangé) — seule la LECTURE change de portée. Coût assumé : une requête
//   par dossier top-level candidat (normalement UN SEUL en l'absence de
//   course de création) — correction PRIME sur l'efficacité, même arbitrage
//   que §9a/§9b.

import { StorageAdapter, assertValidKind } from "./storage-adapter.js";

/** Scope OAuth cible (docs/next/04 §6) — éviter le scope `drive` complet. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** Nom du dossier racine du workspace (informatif — l'id réel est `rootFolderId`, pas ce nom). */
export const WORKSPACE_ROOT_LABEL_HINT = "Pilotéo - <organisation>";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Conservée pour compatibilité de nommage historique — plus jamais levée par
 * les méthodes réseau de cette classe depuis ce lot (voir en-tête). Un appelant
 * qui l'importait pour distinguer « non câblé » peut continuer à le faire ; il
 * ne la verra simplement plus jamais survenir depuis `GoogleDriveStorageAdapter`.
 */
export class NotWiredError extends Error {
  constructor(methodName) {
    super(`GoogleDriveStorageAdapter.${methodName}: NOT_WIRED (historique — n'est plus levée depuis le câblage réseau réel).`);
    this.name = "NotWiredError";
    this.code = "NOT_WIRED";
    this.method = methodName;
  }
}

/** 401/403 Drive : token invalide/expiré ou accès refusé — l'appelant doit ré-obtenir un token et réessayer. */
export class DriveAuthError extends Error {
  constructor(status, body) {
    super(
      `GoogleDriveStorageAdapter: erreur d'authentification Drive (HTTP ${status}) — ` +
        `token invalide/expiré ou accès refusé.${body ? ` [${String(body).slice(0, 200)}]` : ""}`
    );
    this.name = "DriveAuthError";
    this.code = "AUTH_ERROR";
    this.status = status;
  }
}

/** `putImmutable` : le fichier `(kind,id)` existe déjà avec un contenu DIFFÉRENT — jamais d'écrasement d'un immuable. */
export class ImmutableConflictError extends Error {
  constructor(kind, id) {
    super(`GoogleDriveStorageAdapter.putImmutable: IMMUTABLE_CONFLICT — (${kind}, ${id}) existe déjà avec un contenu différent.`);
    this.name = "ImmutableConflictError";
    this.code = "IMMUTABLE_CONFLICT";
    this.kind = kind;
    this.id = id;
  }
}

// ---------------------------------------------------------------------------
// Helpers purs (testables sans réseau) — structure de dossiers docs/next/04 §2
// ---------------------------------------------------------------------------

/** Dossier de premier niveau pour un `kind` donné (docs/next/04 §2). */
export function folderForKind(kind) {
  assertValidKind(kind);
  switch (kind) {
    case "workspace":
      return "workspace";
    case "member":
      return "members";
    case "event":
      return "events";
    case "key":
      return "keys";
    case "license":
      return "licenses";
    default:
      // Inatteignable (assertValidKind a déjà validé), gardé pour exhaustivité.
      throw new TypeError(`folderForKind: kind inattendu (${kind})`);
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Sous-dossier mensuel `AAAA-MM` d'un `createdAt` ISO 8601 UTC (docs/next/04 §2 : `events/2026-08/`). */
export function monthFolder(createdAtIso) {
  if (typeof createdAtIso !== "string" || !ISO_DATE_RE.test(createdAtIso)) {
    throw new TypeError(`monthFolder: createdAt ISO 8601 UTC attendu, reçu (${String(createdAtIso)})`);
  }
  return createdAtIso.slice(0, 7); // "2026-08-30T12:00:00.000Z" -> "2026-08"
}

/** Nom de sous-dossier d'epoch `epoch-XXXX` (docs/next/04 §2 : `keys/epoch-0001/`). */
export function epochFolder(epochNumber) {
  if (!Number.isInteger(epochNumber) || epochNumber < 1) {
    throw new TypeError(`epochFolder: numéro d'epoch entier >= 1 attendu, reçu (${String(epochNumber)})`);
  }
  return `epoch-${String(epochNumber).padStart(4, "0")}`;
}

/** Nom de fichier pour un `(kind,id)` (docs/next/04 §2 — jamais de nom métier). */
export function fileNameForKind(kind, id) {
  assertValidKind(kind);
  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("fileNameForKind: id doit être une chaîne non vide.");
  }
  switch (kind) {
    case "workspace":
      return "manifest.piloteo";
    case "member":
      return `${id}.piloteo`;
    case "event":
      return `${id}.piloteo`;
    case "key":
      return `${id}.key`;
    case "license":
      return "current.license";
    default:
      throw new TypeError(`fileNameForKind: kind inattendu (${kind})`);
  }
}

/**
 * Construit le chemin logique complet (relatif à la racine du workspace Drive)
 * d'un blob `(kind,id)`. Pur, sans E/S — le mapping chemin -> `fileId` Drive
 * réel est construit par le câblage réseau (`_ensureFolder`/
 * `_findFileByNameInFolder`/`_findFileByNameInKindSubtree` ci-dessous) ; ce
 * helper sert à savoir OÙ créer/chercher le fichier.
 *
 * @param {string} kind
 * @param {string} id
 * @param {{createdAt?:string, epoch?:number}} [extra] `createdAt` requis pour kind:"event", `epoch` requis pour kind:"key".
 */
export function buildDrivePath(kind, id, extra = {}) {
  assertValidKind(kind);
  const folder = folderForKind(kind);
  const fileName = fileNameForKind(kind, id);

  if (kind === "event") {
    if (!extra || !extra.createdAt) {
      throw new TypeError("buildDrivePath: kind:'event' requiert extra.createdAt (sous-dossier mensuel).");
    }
    return `${folder}/${monthFolder(extra.createdAt)}/${fileName}`;
  }
  if (kind === "key") {
    if (!extra || extra.epoch === undefined) {
      throw new TypeError("buildDrivePath: kind:'key' requiert extra.epoch (sous-dossier d'epoch).");
    }
    return `${folder}/${epochFolder(extra.epoch)}/${fileName}`;
  }
  return `${folder}/${fileName}`;
}

/**
 * Paramètres de requête Drive distinguant My Drive / Shared Drive
 * (docs/next/04 §8-9). `driveId` absent/null => My Drive (paramètres neutres).
 */
export function driveQueryParams({ driveId = null } = {}) {
  if (driveId) {
    return {
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: "drive",
      driveId,
    };
  }
  return {
    supportsAllDrives: false,
    includeItemsFromAllDrives: false,
    corpora: "user",
  };
}

/** Paramètres Drive pour une opération d'écriture (create/update/delete) — docs/next/04 §9. */
export function driveWriteParams({ driveId = null } = {}) {
  return driveId ? { supportsAllDrives: true } : {};
}

// ---------------------------------------------------------------------------
// Petits utilitaires réseau (module-level, sans état)
// ---------------------------------------------------------------------------

/** Échappe une valeur pour un littéral chaîne du langage de requête Drive (`name = '...'`). */
function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Construit une URL avec query string, en ignorant les valeurs `null`/`undefined`. */
function buildUrl(base, params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    usp.set(key, String(value));
  }
  const qs = usp.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Lit le corps texte d'une réponse sans jamais lever (diagnostics best-effort). */
async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Nom de fichier `(kind:"event", id)` -> `id` (retire le suffixe `.piloteo`). */
function idFromEventFileName(name) {
  return typeof name === "string" && name.endsWith(".piloteo") ? name.slice(0, -".piloteo".length) : name;
}

/**
 * Comparateur total STABLE `(createdTime, id)` — révision §8a/§8b (post-revue adverse) :
 * réutilisé PARTOUT où une réconciliation déterministe est nécessaire (résolution de
 * dossiers dupliqués §8b, résolution de fichiers à nom constant dupliqués §8b, tri ET
 * curseur de `listChanges` §8a). Une seule fonction, une seule notion de « plus ancien ».
 */
function compareByCreatedTimeThenId(a, b) {
  if (a.createdTime !== b.createdTime) return a.createdTime < b.createdTime ? -1 : 1;
  const aId = String(a.id);
  const bId = String(b.id);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/** Trie une liste de `{id,createdTime,...}` du PLUS ANCIEN au plus récent (voir `compareByCreatedTimeThenId`). */
function sortByCreatedTimeThenId(list) {
  return [...list].sort(compareByCreatedTimeThenId);
}

/**
 * 403 Drive — motifs de QUOTA (docs Google : à retenter avec backoff, PAS un problème
 * d'authentification). Distincts de `authError`/`insufficientPermissions` (correction #8d,
 * revue adverse, bug réel #6).
 */
const QUOTA_403_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"]);

/** 403 Drive — motifs d'authentification/permission PERMANENTS (jamais résolus par un retry). */
const AUTH_403_REASONS = new Set(["authError", "insufficientPermissions"]);

/**
 * 403 Drive — valeurs `error.status` (format `google.rpc.Status` moderne, sans tableau
 * `errors[]` — utilisé par de nombreuses API Google récentes/passerelles) signalant un
 * dépassement de quota (correction §9e, revue adverse round 2, bug réel #5).
 */
const QUOTA_403_STATUSES = new Set(["RESOURCE_EXHAUSTED"]);

/**
 * `true` si le corps (texte) d'un 403 Drive porte un motif de QUOTA plutôt qu'un problème
 * d'auth. Reconnaît DEUX formats (§9e) : le format Discovery classique
 * (`error.errors[].reason`) ET le format `google.rpc.Status` moderne (`error.status`, sans
 * `errors[]`). PRIORITÉ à l'auth (§9e, bug réel #6) : si `errors[]` mélange un motif d'auth
 * PERMANENT (`authError`/`insufficientPermissions`) ET un motif de quota, le motif d'auth
 * l'emporte TOUJOURS — un 403 pathologique mêlant les deux ne doit jamais être masqué
 * derrière des retries de quota voués à ne jamais résoudre le vrai problème (le token/les
 * permissions).
 */
function is403QuotaBody(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const error = parsed && parsed.error;
    if (!error) return false;
    const errors = Array.isArray(error.errors) ? error.errors : [];
    if (errors.some((e) => e && AUTH_403_REASONS.has(e.reason))) return false; // l'auth PRIME, toujours.
    if (errors.some((e) => e && QUOTA_403_REASONS.has(e.reason))) return true;
    if (typeof error.status === "string" && QUOTA_403_STATUSES.has(error.status)) return true; // format google.rpc.Status.
    return false;
  } catch {
    // Corps illisible/non-JSON : on ne peut pas prouver que c'est un quota -> traité
    // PRUDEMMENT comme une erreur d'authentification (comportement historique, sûr par défaut).
    return false;
  }
}

/**
 * Sérialisation CANONIQUE (clés d'objet triées récursivement, ordre des tableaux conservé) —
 * correction §9d (revue adverse round 2, bug réel #4) : deux blobs logiquement identiques
 * (mêmes clés, mêmes valeurs) mais dont les clés ont été insérées dans un ORDRE différent
 * (deux implémentations/versions clientes, un retry ayant reconstruit l'objet via un
 * spread/merge…) DOIVENT produire le MÊME texte — sinon la comparaison byte-exacte de
 * `putImmutable` (nécessaire et correcte pour un immuable signé, cf. en-tête) lève un FAUX
 * `IMMUTABLE_CONFLICT` pour un contenu réellement identique. Même algorithme que
 * `stableStringify` de `src/integration/solo-store.js` (ré-implémenté ici, non importé, pour
 * ne pas inverser le sens de dépendance storage -> integration) : `undefined` omis (cohérent
 * avec `JSON.stringify`), tableaux dans leur ordre d'origine (un réordonnancement de tableau
 * EST un changement réel, contrairement à un réordonnancement de clés d'objet).
 *
 * EXIGENCE documentée pour les appelants (bridge/engine, §9d) : cette canonicalisation résout
 * le problème AU NIVEAU TRANSPORT pour TOUT blob passé à `putImmutable` (singletons ET
 * events) — les appelants n'ont PAS besoin de trier eux-mêmes les clés de leurs objets avant
 * de les écrire ; c'est cette fonction, seule responsable de la sérialisation effective, qui
 * garantit « identique logiquement ⇒ octets identiques ».
 */
function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalStringify).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(value[k])).join(",") + "}";
}

// ---------------------------------------------------------------------------
// Adaptateur — câblage REST réel (docs/next/DRIVE_LIVE_CONTRACT.md §1)
// ---------------------------------------------------------------------------

export class GoogleDriveStorageAdapter extends StorageAdapter {
  /**
   * @param {object} opts
   * @param {() => (string|Promise<string>)} opts.oauthTokenProvider fonction INJECTÉE retournant un access token
   *   Google court (scope `drive.file`). Jamais stocké par cette classe — appelée à la demande, à CHAQUE opération
   *   réseau ; sa valeur ne sert qu'à composer un en-tête `Authorization` éphémère.
   * @param {string|null} [opts.rootFolderId] id Drive du dossier racine du workspace (reçu à la création/l'invitation).
   * @param {string|null} [opts.driveId] id du Shared Drive ; `null`/absent => My Drive (docs/next/04 §8-9).
   * @param {Function} [opts.fetchImpl] `fetch` injecté (tests avec un mock ; sinon le `fetch` global).
   * @param {(ms:number)=>Promise<void>} [opts.sleepFn] fonction de délai injectée (tests : sans attente réelle).
   * @param {number} [opts.maxRetries] nombre MAXIMAL d'essais réseau pour 429/5xx (défaut 4, docs/next/DRIVE_LIVE_CONTRACT.md §1).
   */
  constructor({ oauthTokenProvider, rootFolderId = null, driveId = null, fetchImpl, sleepFn, maxRetries } = {}) {
    super();
    if (typeof oauthTokenProvider !== "function") {
      throw new TypeError(
        "GoogleDriveStorageAdapter: 'oauthTokenProvider' (fonction) requis — injecté, jamais stocké en clair par ce module."
      );
    }
    // Référence à la fonction uniquement : le TOKEN qu'elle produira n'est
    // jamais lu/stocké/loggé ici — seul un en-tête HTTP éphémère par requête l'utilise.
    this._oauthTokenProvider = oauthTokenProvider;
    this.rootFolderId = rootFolderId;
    this.driveId = driveId;

    const defaultFetch = typeof fetch === "function" ? fetch : undefined;
    this._fetchImpl = typeof fetchImpl === "function" ? fetchImpl : defaultFetch;
    if (typeof this._fetchImpl !== "function") {
      throw new TypeError(
        "GoogleDriveStorageAdapter: 'fetch' indisponible dans cet environnement — fournir 'fetchImpl' (ex: en test)."
      );
    }
    this._sleepFn = typeof sleepFn === "function" ? sleepFn : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    this._maxRetries = Number.isInteger(maxRetries) && maxRetries > 0 ? maxRetries : 4;

    this._connected = false;
    this._topFolders = null;
    this._folderCache = new Map(); // "<parentId>/<name>" -> folderId
  }

  /** true si ce workspace est stocké sur un Shared Drive plutôt que My Drive (docs/next/04 §8-9). */
  get isSharedDrive() {
    return this.driveId != null;
  }

  /** Paramètres de requête (lecture) cohérents avec la config de cette instance. */
  queryParams() {
    return driveQueryParams({ driveId: this.driveId });
  }

  /** Paramètres de requête (écriture) cohérents avec la config de cette instance. */
  writeParams() {
    return driveWriteParams({ driveId: this.driveId });
  }

  // -- Transport bas niveau : fetch + retry (429/5xx) + mapping 401/403 -----

  _backoffDelayMs(attempt) {
    const base = 200 * Math.pow(2, attempt - 1); // 200, 400, 800, 1600...
    return base + Math.random() * base * 0.5; // + jitter jusqu'à 50%
  }

  /**
   * `fetch` avec : en-tête `Authorization` posé depuis `oauthTokenProvider()` (jamais stocké),
   * 401 -> `DriveAuthError` immédiat (pas de retry — problème de token, pas de réseau),
   * 403 -> INSPECTE le corps (correction #8d, revue adverse, bug réel #6) : un motif de
   * QUOTA (`rateLimitExceeded`/`userRateLimitExceeded`/`dailyLimitExceeded`) est traité
   * EXACTEMENT comme un 429 (retry + backoff) — Google documente ces 403 comme des
   * dépassements de quota, PAS des échecs d'authentification ; seul un motif d'auth
   * (`authError`/`insufficientPermissions`) ou un corps sans motif reconnu lève
   * `DriveAuthError` immédiatement,
   * 429/5xx -> retry avec backoff expo + jitter, `maxRetries` essais au total,
   * erreur réseau (fetch qui rejette) -> retry de la même façon que 5xx.
   */
  async _fetchWithRetry(url, options = {}) {
    const token = await this._oauthTokenProvider();
    if (typeof token !== "string" || token.length === 0) {
      throw new DriveAuthError(401, "oauthTokenProvider n'a renvoyé aucun token.");
    }
    const headers = Object.assign({}, options.headers, { Authorization: `Bearer ${token}` });

    let attempt = 0;
    let lastNetworkErr = null;
    while (attempt < this._maxRetries) {
      attempt += 1;
      let res;
      try {
        res = await this._fetchImpl(url, Object.assign({}, options, { headers }));
      } catch (networkErr) {
        lastNetworkErr = networkErr;
        if (attempt >= this._maxRetries) throw networkErr;
        await this._sleepFn(this._backoffDelayMs(attempt));
        continue;
      }
      if (res.status === 401) {
        throw new DriveAuthError(res.status, await safeText(res));
      }
      if (res.status === 403) {
        const body = await safeText(res);
        if (!is403QuotaBody(body)) {
          throw new DriveAuthError(res.status, body); // authError/insufficientPermissions/motif inconnu -> auth, immédiat.
        }
        // Quota (usageLimits) : traité comme un 429, jamais comme un problème de token.
        if (attempt >= this._maxRetries) {
          throw new Error(`GoogleDriveStorageAdapter: HTTP 403 (quota) persistant après ${attempt} essai(s) — ${body}`);
        }
        await this._sleepFn(this._backoffDelayMs(attempt));
        continue;
      }
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt >= this._maxRetries) {
          const body = await safeText(res);
          throw new Error(
            `GoogleDriveStorageAdapter: HTTP ${res.status} persistant après ${attempt} essai(s) — ${body}`
          );
        }
        await this._sleepFn(this._backoffDelayMs(attempt));
        continue;
      }
      return res;
    }
    // Inatteignable en pratique (la boucle retourne ou lève avant), gardé pour exhaustivité.
    throw lastNetworkErr || new Error("GoogleDriveStorageAdapter: échec réseau Drive inattendu.");
  }

  /**
   * Lève une erreur explicite si la réponse n'est pas OK — TOUJOURS, y compris pour un 404
   * (correction #4, revue vérificateur) : un 404 sur `files.list`/`files.create`/l'upload
   * multipart est une VRAIE erreur (dossier parent disparu, requête malformée, etc.), jamais
   * un cas normal à avaler silencieusement. Le SEUL endroit où un 404 est un cas normal est le
   * téléchargement `alt=media` d'un fichier qui vient de disparaître (course rare) —
   * `_downloadContent` l'intercepte lui-même AVANT d'appeler `_ensureOk` (voir plus bas), donc
   * ce garde-fou ne voit jamais ce cas précis.
   */
  async _ensureOk(res, context) {
    if (res.ok) return res;
    const body = await safeText(res);
    throw new Error(`GoogleDriveStorageAdapter: ${context} — HTTP ${res.status} ${body}`);
  }

  // -- Recherche/listing Drive (pagination COMPLÈTE, jamais un retour partiel) --

  /** `files.list` en suivant `nextPageToken` JUSQU'AU BOUT ; renvoie la liste complète (tous les `files` agrégés). */
  async _listAllFiles(q, fields, { orderBy } = {}) {
    const results = [];
    let pageToken;
    do {
      const params = Object.assign(
        { q, fields: `nextPageToken, ${fields}`, pageSize: 1000 },
        this.queryParams()
      );
      if (orderBy) params.orderBy = orderBy;
      if (pageToken) params.pageToken = pageToken;
      const url = buildUrl(DRIVE_FILES_URL, params);
      const res = await this._fetchWithRetry(url, { method: "GET" });
      await this._ensureOk(res, "files.list");
      const data = await res.json();
      results.push(...(Array.isArray(data.files) ? data.files : []));
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    return results;
  }

  /**
   * Localise TOUS les dossiers `name` sous `parentId`, triés du PLUS ANCIEN au plus récent
   * (`compareByCreatedTimeThenId`). Ne choisit PAS pour l'appelant : `_findFolder` (oldest)
   * et le balayage de réconciliation de `connect()` (§8b) décident chacun quoi en faire.
   */
  async _findAllFolders(name, parentId) {
    const q =
      `mimeType = '${FOLDER_MIME}' and trashed = false and ` +
      `name = '${escapeDriveQueryValue(name)}' and '${parentId}' in parents`;
    const files = await this._listAllFiles(q, "files(id,name,createdTime)");
    return sortByCreatedTimeThenId(files);
  }

  /**
   * Résout un dossier `name` sous `parentId` — RÉCONCILIATION DÉTERMINISTE (§8b, revue
   * adverse, races #1/#2/#3) : `connect()`/l'arbre de dossiers est une ressource MUTABLE
   * PARTAGÉE (check-then-act), pas un journal immuable — deux clients qui initialisent le
   * même workspace en même temps peuvent chacun créer LEUR PROPRE dossier du même nom
   * (split-brain). Si PLUSIEURS dossiers du même nom existent sous ce parent, on choisit
   * TOUJOURS, déterministement, le PLUS ANCIEN par `(createdTime,id)` — tout client qui
   * résout ce nom converge donc sur le MÊME id, sans verrou (voir aussi
   * `docs/next/DRIVE_CONFLITS_LOCKS.md` §2bis). `null` si aucun dossier de ce nom n'existe.
   */
  async _findFolder(name, parentId) {
    const all = await this._findAllFolders(name, parentId);
    return all[0] || null;
  }

  async _listSubfolders(parentId) {
    const q = `mimeType = '${FOLDER_MIME}' and trashed = false and '${parentId}' in parents`;
    return this._listAllFiles(q, "files(id,name)");
  }

  /**
   * Localise TOUS les fichiers `name` SCOPÉS à un dossier parent DIRECT (correction #1,
   * revue vérificateur — BUG bloquant : une recherche par nom SANS contrainte de dossier
   * renvoyait n'importe quel fichier de ce nom sur tout le Drive du compte, y compris dans
   * un AUTRE workspace Pilotéo. `fileNameForKind` renvoie des noms CONSTANTS pour
   * `workspace` (`manifest.piloteo`) et `license` (`current.license`) — un compte membre de
   * 2+ workspaces sur le même Drive aurait pu charger le manifeste/la licence du MAUVAIS
   * workspace. Toute recherche DOIT donc systématiquement contraindre `'<parentId>' in
   * parents`. Trié du plus ancien au plus récent — voir `_reconcileFileCandidates` (§8b)
   * pour la décision (idempotent vs `IMMUTABLE_CONFLICT`) prise par les appelants.
   */
  async _findAllFilesByNameInFolder(parentId, name) {
    const q = `trashed = false and name = '${escapeDriveQueryValue(name)}' and '${parentId}' in parents`;
    const files = await this._listAllFiles(q, "files(id,name,createdTime,size)");
    return sortByCreatedTimeThenId(files);
  }

  /** Le plus ancien candidat `(parentId,name)`, ou `null` — voir `_findAllFilesByNameInFolder`. */
  async _findFileByNameInFolder(parentId, name) {
    const all = await this._findAllFilesByNameInFolder(parentId, name);
    return all[0] || null;
  }

  /**
   * Localise TOUS les fichiers `(kind,name)` en restant TOUJOURS scopé à l'arborescence de
   * CE workspace (jamais une recherche globale sur le Drive du compte — voir
   * `_findAllFilesByNameInFolder` ci-dessus).
   *
   * CORRECTION §10 (revue adverse round 3, PERTE DE DONNÉES PERMANENTE) : unit désormais
   * TOUS les dossiers top-level `kind` (`_allTopFolderIds`), pas seulement le gagnant
   * (« oldest-wins », §9b) — un fichier écrit dans un dossier top-level DUPLIQUÉ « perdant »
   * (orphelin d'une course de création, §8b) reste physiquement présent sur Drive ; s'arrêter
   * au seul gagnant le rendait invisible EN PERMANENCE pour toute lecture (`get`/`exists`/
   * `readMetadata`), y compris pour l'instance qui vient elle-même de l'écrire — violation de
   * §9a et de la garantie `docs/next/DRIVE_CONFLITS_LOCKS.md` §2bis. Coût assumé : une
   * recherche par dossier top-level candidat (normalement UN SEUL en l'absence de course de
   * création — le cas de plusieurs est rare et transitoire) — correction PRIME sur
   * l'efficacité, même arbitrage que §9a/§9b.
   *   - `workspace`/`member`/`license` : recherche DIRECTE dans chaque dossier top-level candidat.
   *   - `event`/`key` : le sous-dossier exact (mois/epoch) n'est pas connu depuis le seul `id`
   *     (l'interface `StorageAdapter.get/exists/readMetadata` ne porte pas `createdAt`/`epoch`) —
   *     on énumère donc TOUS les sous-dossiers de CHAQUE dossier top-level candidat (mois/epoch)
   *     et on agrège les candidats de CHACUN, scopé (jamais hors de l'arborescence de ce
   *     workspace). `putImmutable`, qui CONNAÎT le blob, n'utilise PAS cette méthode : il
   *     résout le sous-dossier EXACT du dossier GAGNANT en premier (`_resolveWriteParentId`,
   *     écriture inchangée — seule la LECTURE unit tous les dossiers) et interroge directement
   *     CE dossier cible.
   * Trié du plus ancien au plus récent (agrégation de plusieurs dossiers -> re-tri nécessaire).
   */
  async _findAllFilesByNameInKindSubtree(kind, name) {
    const topIds = await this._allTopFolderIds(kind); // §10 : UNIT tous les dossiers dupliqués, pas seulement le gagnant.
    const all = [];
    if (kind !== "event" && kind !== "key") {
      for (const topId of topIds) {
        all.push(...(await this._findAllFilesByNameInFolder(topId, name)));
      }
      return sortByCreatedTimeThenId(all);
    }
    for (const topId of topIds) {
      const subfolders = await this._listSubfolders(topId);
      for (const sub of subfolders) {
        all.push(...(await this._findAllFilesByNameInFolder(sub.id, name)));
      }
    }
    return sortByCreatedTimeThenId(all);
  }

  /** Le plus ancien candidat `(kind,name)` dans l'arborescence de ce workspace, ou `null`. */
  async _findFileByNameInKindSubtree(kind, name) {
    const all = await this._findAllFilesByNameInKindSubtree(kind, name);
    return all[0] || null;
  }

  /**
   * Réconciliation déterministe d'un ensemble de candidats physiques `(kind,id)` (§8b,
   * angle 2bis du contrariant) : si PLUSIEURS candidats de contenus DIFFÉRENTS coexistent
   * (course d'écriture sur un fichier à nom constant, ex: deux créateurs de `manifest.piloteo`
   * en même temps), ne choisit JAMAIS l'un au hasard — signale `conflict:true` à l'appelant
   * (qui lève `ImmutableConflictError`). Des candidats de contenu IDENTIQUE (doublon physique
   * inoffensif — retry idempotent, angle 2) ne sont PAS un conflit : on retient le plus ancien.
   *
   * CORRECTION §9c (revue adverse round 2, bug réel #3) : télécharge le GAGNANT (le plus
   * ancien) EN PREMIER, et propage toute erreur sur CE téléchargement (une lecture DOIT
   * échouer si le gagnant lui-même est illisible — rien ne peut légitimement le remplacer).
   * Les AUTRES candidats (utilisés UNIQUEMENT pour détecter une divergence) ne sont
   * téléchargés qu'en BEST-EFFORT : un échec PERSISTANT (5xx/403 après épuisement des
   * retries) sur un candidat NON-gagnant (orphelin surnuméraire, résidu de course §8b) est
   * absorbé — il ne doit JAMAIS faire échouer une lecture qui aurait pu réussir avec le seul
   * gagnant. Un 404 sur un candidat (disparu) était déjà `null`, donc déjà exclu de la
   * comparaison — inchangé. Télécharge le contenu de chaque candidat lisible UNE fois
   * (`contents`, réutilisable par l'appelant — évite un second aller-retour réseau pour `get`).
   */
  async _reconcileFileCandidates(candidates) {
    if (!candidates || candidates.length === 0) return { winner: null, conflict: false, contents: new Map() };
    const sorted = sortByCreatedTimeThenId(candidates);
    const contents = new Map();
    const winner = sorted[0];
    contents.set(winner.id, await this._downloadContent(winner.id)); // propage l'échec : le gagnant DOIT être lisible.
    for (const c of sorted.slice(1)) {
      try {
        contents.set(c.id, await this._downloadContent(c.id));
      } catch {
        // best-effort (§9c) : un candidat SURNUMÉRAIRE illisible ne doit jamais faire
        // échouer la lecture — on ne peut simplement pas prouver s'il diverge, ce qui
        // n'empêche PAS de répondre avec le gagnant.
        contents.set(c.id, undefined); // marqueur "indéterminé", exclu de la comparaison ci-dessous.
      }
    }
    const distinct = new Set([...contents.values()].filter((v) => v !== null && v !== undefined));
    return { winner, conflict: distinct.size > 1, contents };
  }

  async _createFolder(name, parentId) {
    const metadata = { name, mimeType: FOLDER_MIME, parents: [parentId] };
    const params = Object.assign({ fields: "id,name" }, this.writeParams());
    const url = buildUrl(DRIVE_FILES_URL, params);
    const res = await this._fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    });
    await this._ensureOk(res, "files.create (dossier)");
    return res.json();
  }

  /**
   * Trouve-ou-crée un sous-dossier `name` sous `parentId`, mis en cache par instance.
   * RÉCONCILIATION DÉTERMINISTE (§8b) : si `name` est absent, on le crée, PUIS on
   * RE-RÉSOUT (`_findFolder`, oldest-wins) plutôt que de supposer que NOTRE création a
   * gagné la course — si un autre client a créé le MÊME dossier entre-temps, les DEUX
   * convergent sur le même gagnant (le plus ancien), jamais sur leur propre création.
   */
  async _ensureFolder(name, parentId) {
    const cacheKey = `${parentId}/${name}`;
    if (this._folderCache.has(cacheKey)) return this._folderCache.get(cacheKey);
    let winner = await this._findFolder(name, parentId);
    if (!winner) {
      await this._createFolder(name, parentId);
      // Ne JAMAIS supposer que notre `_createFolder` a gagné la course : re-résoudre
      // (oldest-wins) contre TOUT ce qui existe maintenant, y compris un concurrent.
      winner = await this._findFolder(name, parentId);
    }
    this._folderCache.set(cacheKey, winner.id);
    return winner.id;
  }

  async _downloadContent(fileId) {
    const params = Object.assign({ alt: "media" }, this.queryParams());
    const url = buildUrl(`${DRIVE_FILES_URL}/${fileId}`, params);
    const res = await this._fetchWithRetry(url, { method: "GET" });
    if (res.status === 404) return null;
    await this._ensureOk(res, "files.get (alt=media)");
    return res.text();
  }

  async _uploadMultipart(fileName, parentId, content) {
    const boundary = `piloteo-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    const metadata = { name: fileName, parents: [parentId] };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--`;
    const params = Object.assign({ uploadType: "multipart", fields: "id,name" }, this.writeParams());
    const url = buildUrl(DRIVE_UPLOAD_URL, params);
    const res = await this._fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    await this._ensureOk(res, "files.create (upload multipart)");
    return res.json();
  }

  /**
   * §10 (revue adverse round 3, PERTE DE DONNÉES PERMANENTE) — renvoie TOUS les dossiers
   * top-level `kind` sous la racine (pas seulement le gagnant), triés du plus ancien au plus
   * récent. §9b a fait converger les ÉCRITURES vers le plus ancien (oldest-wins), mais un
   * contenu déjà écrit dans un dossier top-level DUPLIQUÉ « perdant » (orphelin d'une course
   * de création, §8b) ne DISPARAÎT PAS du Drive pour autant — une LECTURE qui ne regarde que
   * le sous-arbre du gagnant rend ce contenu invisible EN PERMANENCE, pour TOUTE instance, y
   * compris une instance fraîche connectée bien après stabilisation complète (confirmé par le
   * contrariant round 3, `tests/next/attack-p4r3-drive-orphan-topfolder.test.mjs`) — violation
   * directe de §9a (« jamais un event réel non renvoyé ») et de la garantie de
   * `docs/next/DRIVE_CONFLITS_LOCKS.md` §2bis. Toute LECTURE (`_findAllFilesByNameInKindSubtree`,
   * `listChanges`) doit donc UNIR tous les dossiers de même nom, jamais se limiter au seul
   * gagnant. Effet de bord : maintient `_topFolders[kind]`/`_folderCache` sur le gagnant
   * (même rôle que l'ancien `_liveTopFolder`, §9b), pour que les ÉCRITURES, elles, continuent
   * de converger normalement vers le plus ancien.
   */
  async _allTopFolderIds(kind) {
    const name = folderForKind(kind);
    const all = await this._findAllFolders(name, this.rootFolderId);
    if (all.length > 0) {
      this._topFolders[kind] = all[0].id; // le plus ancien — écritures futures convergentes (§9b).
      this._folderCache.set(`${this.rootFolderId}/${name}`, all[0].id);
      return all.map((f) => f.id);
    }
    return this._topFolders[kind] ? [this._topFolders[kind]] : [];
  }

  /**
   * §9b (revue adverse round 2, bug réel #2) — RE-RÉSOLUTION PARESSEUSE du dossier de
   * premier niveau GAGNANT (le plus ancien) AVANT chaque ÉCRITURE (jamais un simple
   * `this._topFolders[kind]` lu tel quel). `connect()` reste un no-op définitif après son
   * premier succès (efficacité — un `connect()` répété ne coûte AUCUN appel réseau, cf. sa
   * doc), mais cela signifiait qu'une instance déjà vivante restait bloquée pour toujours sur
   * SON choix initial même si un dossier RÉELLEMENT plus ancien devenait visible ensuite —
   * `_allTopFolderIds` (§10) renvoie TOUJOURS le plus ancien de TOUS les candidats actuellement
   * VISIBLES en tête de liste (y compris celui déjà en cache, qui est nécessairement un
   * candidat parmi d'autres) : adopté immédiatement pour les ÉCRITURES futures, sans jamais
   * nécessiter de redémarrage. Utilisée UNIQUEMENT pour résoudre où ÉCRIRE
   * (`_resolveWriteParentId`) — les LECTURES, elles, unissent tous les dossiers via
   * `_allTopFolderIds` directement (§10), jamais seulement ce gagnant.
   */
  async _liveTopFolder(kind) {
    const ids = await this._allTopFolderIds(kind);
    return ids[0] ?? this._topFolders[kind];
  }

  /** Id du dossier où écrire `(kind, id)`, en résolvant/créant le sous-dossier mensuel/d'epoch si besoin. */
  async _resolveWriteParentId(kind, blob) {
    const topId = await this._liveTopFolder(kind); // §9b : re-résolution paresseuse avant usage.
    if (kind === "event") {
      const createdAt = blob && blob.createdAt;
      if (!createdAt) {
        throw new TypeError("GoogleDriveStorageAdapter.putImmutable: un blob kind:'event' doit porter `createdAt`.");
      }
      return this._ensureFolder(monthFolder(createdAt), topId);
    }
    if (kind === "key") {
      const epoch = blob && blob.epoch;
      if (epoch === undefined) {
        throw new TypeError("GoogleDriveStorageAdapter.putImmutable: un blob kind:'key' doit porter `epoch`.");
      }
      return this._ensureFolder(epochFolder(epoch), topId);
    }
    return topId;
  }

  // -- StorageAdapter -------------------------------------------------------

  /**
   * Résout/crée l'arbre de dossiers du workspace (idempotent — no-op si déjà connecté :
   * un 2e `connect()` sur la MÊME instance ne fait AUCUN appel réseau supplémentaire).
   *
   * RÉCONCILIATION DÉTERMINISTE (§8b, revue adverse) en DEUX PHASES :
   *   1. Pour chaque dossier de premier niveau, trouve-ou-crée (`_ensureFolder`, qui
   *      re-résout déjà après une création — voir sa doc).
   *   2. Balayage de réconciliation FINAL : une fois les 5 dossiers traités, ré-interroge
   *      chacun une dernière fois et adopte le PLUS ANCIEN actuellement visible. Utile
   *      quand DEUX clients initialisent le MÊME workspace tout neuf en concurrence : au
   *      moment où CETTE instance termine sa phase 1, l'AUTRE client a très probablement
   *      déjà terminé la sienne (même charge de travail, même nombre d'allers-retours) —
   *      la phase 2 leur permet alors de converger sur le MÊME dossier pour chaque kind,
   *      même si la phase 1, prise isolément, avait chacune créé son propre doublon.
   *      Fenêtre de course RÉSIDUELLE assumée et documentée : voir
   *      `docs/next/DRIVE_CONFLITS_LOCKS.md` §2bis.
   *
   *   Ce balayage ne couvre que l'INSTANT du `connect()` lui-même. §9b (revue adverse round 2,
   *   bug réel #2) a corrigé l'angle mort restant : une instance déjà `connect()`ée qui
   *   continue à vivre (elle ne rappelle jamais `connect()`) restait bloquée pour toujours si
   *   un dossier plus ancien devenait visible APRÈS son balayage — `_liveTopFolder` (utilisée
   *   par `putImmutable`/`get`/`exists`/`readMetadata`/`listChanges`, PAS ici) re-résout
   *   paresseusement le dossier top-level concerné à CHAQUE opération suivante, permettant à
   *   une instance vivante de converger vers le plus-ancien sans jamais redémarrer.
   */
  async connect() {
    if (this._connected) return;
    if (typeof this.rootFolderId !== "string" || this.rootFolderId.length === 0) {
      throw new TypeError("GoogleDriveStorageAdapter.connect: 'rootFolderId' (id Drive du dossier racine) requis.");
    }
    const KINDS = ["workspace", "member", "event", "key", "license"];
    const topFolders = {};
    for (const kind of KINDS) {
      topFolders[kind] = await this._ensureFolder(folderForKind(kind), this.rootFolderId);
    }
    // Phase 2 — balayage de réconciliation final (voir doc ci-dessus).
    for (const kind of KINDS) {
      const reconciled = await this._findFolder(folderForKind(kind), this.rootFolderId);
      if (reconciled) {
        topFolders[kind] = reconciled.id;
        this._folderCache.set(`${this.rootFolderId}/${folderForKind(kind)}`, reconciled.id);
      }
    }
    this._topFolders = topFolders;
    this._connected = true;
  }

  /**
   * Écrit un blob immuable — IDEMPOTENT / WRITE-ONCE, BEST-EFFORT sous course (voir en-tête,
   * §8b). Un `(kind,id)` déjà écrit avec le MÊME contenu renvoie un succès sans créer de
   * doublon ; avec un contenu différent, lève `ImmutableConflictError`. Si le PRÉ-CHECK
   * découvre que PLUSIEURS versions DIFFÉRENTES coexistent déjà (course antérieure, non
   * empêchée — `putImmutable` ne verrouille rien, cf. §8b/§8c), lève aussi
   * `ImmutableConflictError` immédiatement plutôt que d'ajouter une 3e version ou de
   * prétendre un succès. La course résiduelle (deux `putImmutable` strictement CONCURRENTS
   * du même id neuf peuvent chacun voir « absent » et créer chacun un fichier) N'EST PAS
   * empêchée ici (aucun verrou, §4) : elle est rattrapée à la LECTURE — `get`/`readMetadata`
   * détectent une divergence de contenu et lèvent `IMMUTABLE_CONFLICT` ; `listChanges`
   * déduplique par nom physique (§8a) pour qu'un doublon de contenu IDENTIQUE (cas normal
   * de retry) ne produise jamais deux entrées logiques.
   */
  async putImmutable(kind, id, blob) {
    assertValidKind(kind);
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("GoogleDriveStorageAdapter.putImmutable: id doit être une chaîne non vide.");
    }
    await this.connect();
    const fileName = fileNameForKind(kind, id);
    // §9d (revue adverse round 2) : sérialisation CANONIQUE (clés triées), pas un
    // `JSON.stringify` brut — évite un FAUX `IMMUTABLE_CONFLICT` entre deux blobs
    // logiquement identiques dont les clés ont été insérées dans un ordre différent
    // (voir `canonicalStringify`). La comparaison ci-dessous reste byte-exacte.
    const content = canonicalStringify(blob);

    // Résout LE DOSSIER CIBLE (contrat §1) EN PREMIER — depuis le blob (mois/epoch pour
    // event/key, dossier de kind direct sinon) — puis interroge CE dossier précis, jamais une
    // recherche globale (correction #1, revue vérificateur).
    const parentId = await this._resolveWriteParentId(kind, blob);
    const candidates = await this._findAllFilesByNameInFolder(parentId, fileName);
    const { winner, conflict, contents } = await this._reconcileFileCandidates(candidates);
    if (conflict) {
      throw new ImmutableConflictError(kind, id); // divergence déjà présente, indépendamment de MON contenu.
    }
    if (winner) {
      const existingContent = contents.get(winner.id);
      if (existingContent !== null && existingContent === content) {
        return { id }; // idempotent : déjà écrit avec le même contenu, aucun doublon créé.
      }
      if (existingContent !== null) {
        throw new ImmutableConflictError(kind, id);
      }
      // existingContent === null : le fichier trouvé a disparu entre la recherche et le téléchargement
      // (course rare) — on retombe sur le chemin création, comme s'il n'avait jamais existé.
    }

    await this._uploadMultipart(fileName, parentId, content);
    return { id };
  }

  /**
   * Localise par nom, `alt=media`. Absent -> `null` (jamais une exception — déviation
   * documentée en tête). RÉCONCILIATION DÉTERMINISTE À LA LECTURE (§8b) : si plusieurs
   * fichiers physiques `(kind,id)` de contenus DIFFÉRENTS coexistent (course d'écriture non
   * empêchée par `putImmutable`, angle 2bis du contrariant), lève `ImmutableConflictError`
   * plutôt que de renvoyer l'un des deux au hasard — jamais un choix silencieux entre deux
   * versions divergentes d'un immuable.
   */
  async get(kind, id) {
    assertValidKind(kind);
    await this.connect();
    const fileName = fileNameForKind(kind, id);
    const candidates = await this._findAllFilesByNameInKindSubtree(kind, fileName);
    const { winner, conflict, contents } = await this._reconcileFileCandidates(candidates);
    if (conflict) {
      throw new ImmutableConflictError(kind, id);
    }
    if (!winner) return null;
    const text = contents.get(winner.id);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`GoogleDriveStorageAdapter.get: contenu JSON invalide (${kind}, ${id}) — ${(err && err.message) || err}`);
    }
  }

  /**
   * `true` si `(kind,id)` a déjà été écrit (recherche par nom, sans télécharger le contenu).
   * Une éventuelle divergence de contenu entre plusieurs candidats N'EST PAS signalée ici
   * (question booléenne « existe-t-il quelque chose ? », pas « quoi ? ») — `get`/
   * `readMetadata`, qui exposent réellement un contenu/des métadonnées, lèvent
   * `ImmutableConflictError` le cas échéant (§8b).
   */
  async exists(kind, id) {
    assertValidKind(kind);
    await this.connect();
    const fileName = fileNameForKind(kind, id);
    return (await this._findAllFilesByNameInKindSubtree(kind, fileName)).length > 0;
  }

  /**
   * Énumère `events/<AAAA-MM>/` (récursif mensuel), en suivant `nextPageToken` jusqu'au bout
   * à chaque `files.list` (jamais de retour partiel), dédupliqué par nom physique (un doublon
   * physique — ex: course `putImmutable`, §8b — ne produit jamais deux entrées logiques ; en
   * cas de doublon, on retient déterministement le plus ancien par `(createdTime,id)`,
   * cohérent avec `_reconcileFileCandidates`).
   *
   * CORRECTION §9a (revue adverse round 2, bug de FOND #1 — PRIME sur toute considération
   * d'efficacité) : `listChanges` retourne désormais l'ENSEMBLE ORDONNÉ **COMPLET** des events
   * à CHAQUE appel, quel que soit `cursor` — plus AUCUN filtrage par `createdTime` ou par
   * `seenIds` ne peut EXCLURE un event du résultat. Le correctif §8a (round 1, cursor
   * `{createdTime,seenIds}`) réglait la COLLISION de `createdTime` (deux events au MÊME
   * `createdTime` maximal) mais restait dangereux pour un cas DIFFÉRENT et bien plus grave :
   * `createdTime` est assigné par le SERVEUR Drive (pas par le client), N'EST PAS garanti
   * monotone avec l'ordre de création logique, et `files.list` est éventuellement cohérent
   * (un fichier peut mettre un instant à devenir listable, ou deux réplicas backend peuvent
   * assigner des `createdTime` non strictement croissants dans l'ordre réel d'écriture) — un
   * fichier peut donc apparaître avec un `createdTime` STRICTEMENT INFÉRIEUR à un watermark
   * DÉJÀ ÉMIS. Tout filtre de la forme `createdTime < watermark` (y compris celui de §8a)
   * exclut alors cet event pour TOUJOURS, sans aucun rattrapage possible (le watermark ne
   * recule jamais) — violation directe du contrat §0/§1 (« ne jamais sauter un event »).
   *
   * VÉRIFIÉ dans ce dépôt (justifiant de privilégier la correction sur l'efficacité) : la
   * RE-livraison d'un event déjà traité est, elle, SANS DANGER — `SyncEngine` déduplique
   * systématiquement via `_seen: Set<eventId>` AVANT même de re-télécharger le blob
   * (`src/sync/sync-engine.js`, `pull()`), et `EventLog` déduplique par `eventId`
   * (`src/events/event-log.js`, `duplicate:true`). Sauter est une faute grave et irréversible ;
   * redélivrer est un non-événement pour l'appelant. Le curseur retourné (`{createdTime,
   * seenIds}`, forme conservée pour compatibilité et diagnostic — `SyncEngine` le persiste)
   * N'EST PLUS UTILISÉ pour filtrer `changes` : il n'a plus qu'une valeur INFORMATIVE
   * (horodatage/ids maximaux observés lors du DERNIER appel), jamais une garantie
   * d'exhaustivité « en deçà ». Le paramètre `cursor` reçu est donc accepté (pour compatibilité
   * d'appel) mais IGNORÉ pour la sélection de `changes`.
   */
  async listChanges(cursor) {
    await this.connect();
    // §10 (revue adverse round 3, PERTE DE DONNÉES PERMANENTE) : énumère TOUS les dossiers
    // top-level "events" sous la racine (`_allTopFolderIds`), pas seulement le gagnant
    // (oldest-wins, §9b) — un event écrit dans un dossier top-level DUPLIQUÉ « perdant »
    // (orphelin d'une course de création, §8b) reste physiquement présent sur Drive ; ne
    // regarder que le sous-arbre du gagnant le rendait invisible EN PERMANENCE pour TOUTE
    // instance, même fraîche et connectée bien après stabilisation complète (contrariant
    // round 3, `tests/next/attack-p4r3-drive-orphan-topfolder.test.mjs`) — violation directe
    // de §9a (« jamais un event réel non renvoyé »). Coût assumé : normalement UN SEUL dossier
    // top-level "events" (le cas de plusieurs est rare et transitoire) — correction PRIME sur
    // l'efficacité, même arbitrage que §9a/§9b.
    const eventsTopIds = await this._allTopFolderIds("event");

    const allFiles = [];
    for (const eventsTopId of eventsTopIds) {
      const monthFolders = await this._listSubfolders(eventsTopId);
      for (const mf of monthFolders) {
        const files = await this._listAllFiles(
          `'${mf.id}' in parents and trashed = false`,
          "files(id,name,createdTime)"
        );
        allFiles.push(...files);
      }
    }

    const byName = new Map();
    for (const f of allFiles) {
      const prev = byName.get(f.name);
      if (!prev || compareByCreatedTimeThenId(f, prev) < 0) byName.set(f.name, f);
    }
    const uniqueFiles = sortByCreatedTimeThenId([...byName.values()]);

    // §9a : ÉNUMÉRATION COMPLÈTE — aucun filtrage par cursor, jamais d'exclusion possible.
    const changes = uniqueFiles.map((f) => ({ kind: "event", id: idFromEventFileName(f.name) }));

    const last = uniqueFiles[uniqueFiles.length - 1];
    const newCursor = last
      ? { createdTime: last.createdTime, seenIds: uniqueFiles.filter((f) => f.createdTime === last.createdTime).map((f) => String(f.id)) }
      : cursor || null;

    return { changes, cursor: newCursor };
  }

  /**
   * Métadonnées d'un blob (sans son contenu). `null` si absent (cohérent avec `get`).
   * RÉCONCILIATION DÉTERMINISTE À LA LECTURE (§8b) : lève `ImmutableConflictError` si
   * plusieurs candidats physiques de contenus DIFFÉRENTS coexistent (voir `get`).
   */
  async readMetadata(kind, id) {
    assertValidKind(kind);
    await this.connect();
    const fileName = fileNameForKind(kind, id);
    const candidates = await this._findAllFilesByNameInKindSubtree(kind, fileName);
    const { winner, conflict } = await this._reconcileFileCandidates(candidates);
    if (conflict) {
      throw new ImmutableConflictError(kind, id);
    }
    if (!winner) return null;
    return {
      kind,
      id,
      fileId: winner.id,
      writtenAt: winner.createdTime || null,
      size: winner.size !== undefined ? Number(winner.size) : null,
    };
  }

  /** Déclaratif (hors scope de ce lot) : le partage/l'ACL Drive d'un workspace se gère manuellement pour l'instant. */
  async share(_member) {
    return { ok: true, delegated: true, detail: "Partage Drive (ACL) hors scope de ce lot — géré manuellement." };
  }

  /** Déclaratif (hors scope de ce lot) : voir `share`. */
  async revoke(_member) {
    return { ok: true, delegated: true, detail: "Révocation Drive (ACL) hors scope de ce lot — géré manuellement." };
  }

  /** Statut de santé best-effort : ne lève jamais (résout `connect()` en douceur). */
  async health() {
    try {
      await this.connect();
      return { ok: true, detail: "connexion Drive OK (arbre du workspace résolu)." };
    } catch (err) {
      return { ok: false, detail: `Drive inaccessible : ${(err && err.message) || err}` };
    }
  }
}
