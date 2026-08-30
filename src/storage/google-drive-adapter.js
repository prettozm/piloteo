// src/storage/google-drive-adapter.js
//
// GoogleDriveStorageAdapter — SQUELETTE conforme au contrat StorageAdapter
// (CONTRACTS.md §5) et à docs/next/04_SYNC_ET_STOCKAGE_DRIVE.md §2, §5, §6, §9.
//
// ⚠️ CE QUI N'EST PAS CÂBLÉ DANS CE LOT, ET POURQUOI ⚠️
// ---------------------------------------------------------------------------
// AUCUN appel réseau réel n'est effectué par ce module. Toutes les méthodes de
// transport (`connect, putImmutable, get, listChanges, readMetadata, share,
// revoke, health`) lèvent `NotWiredError` (code `NOT_WIRED`). Restent donc à
// câbler, dans un lot ultérieur dédié :
//
//   1. OAuth Google réel côté navigateur (Google Identity Services), obtention
//      d'un access token `drive.file` par interaction utilisateur — nécessite
//      des credentials OAuth (client ID) qui n'existent pas dans ce dépôt.
//      Cf. docs/next/04 §5 : "après expiration du token, une nouvelle action
//      utilisateur peut être nécessaire".
//   2. Le SPIKE technique explicitement demandé par docs/next/04 §6 avant tout
//      câblage : vérifier l'UX exacte d'un membre invité avec le scope minimal
//      `drive.file` — accès au dossier partagé reçu par invitation, découverte
//      à partir d'un file/folder id, et le besoin éventuel d'un passage
//      **Picker** pour accorder explicitement l'accès (si `drive.file` l'exige,
//      le Picker fait alors partie du parcours d'invitation).
//   3. Les appels REST Drive proprement dits (`files.create`, `files.get`,
//      `files.list`/`changes.list`, gestion de la pagination et du "change
//      token" spécifique à un Shared Drive) — nécessitent le token OAuth (1).
//   4. La gestion réelle du refresh/expiration de token, des erreurs HTTP
//      (403/404/429/5xx), des retries, et de la déduplication d'upload en cas
//      de retry après timeout (docs/next/07 §9 : "retry", "duplication
//      upload").
//   5. Les tests de la matrice Drive (docs/next/07 §9 : My Drive Gmail, My
//      Drive Workspace, Shared Drive Workspace, compte sans accès, accès
//      retiré, token expiré, offline) : impossibles sans (1)-(4) et un vrai
//      compte Google de test.
//
// Ce que CE module fournit néanmoins, testable sans réseau ni credentials :
//   - la structure de dossiers cible et les helpers PURS de construction de
//     chemins/noms de fichiers (`buildDrivePath`, `folderForKind`, etc.) ;
//   - le mapping kind -> dossier Drive (docs/next/04 §2) ;
//   - les paramètres de requête distinguant My Drive / Shared Drive
//     (`driveQueryParams` : `supportsAllDrives`, `driveId`,
//     `includeItemsFromAllDrives`, docs/next/04 §9) ;
//   - le contrat d'injection de `oauthTokenProvider` (jamais stocké : voir
//     ci-dessous) et le scope cible `drive.file` (`DRIVE_SCOPE`).
//
// Décisions/hypothèses :
// - `oauthTokenProvider` est une fonction (souvent asynchrone) fournie par
//   l'appelant, qui retourne un access token Google court. Elle est appelée à
//   la demande ; SA VALEUR DE RETOUR N'EST JAMAIS PERSISTÉE ni loggée par ce
//   module (CONTRACTS §0 : "aucune clé ni donnée métier en clair dans les
//   logs" — un token OAuth est traité avec la même prudence). Le token n'est
//   PAS un secret éditeur ni une clé de chiffrement Pilotéo : c'est un jeton
//   d'accès Drive, propre à l'utilisateur, à courte durée de vie.
// - `driveId` (optionnel) distingue Shared Drive (fourni) de My Drive (absent/
//   null) — cf. docs/next/04 §8-9. Quand fourni, tous les paramètres Drive
//   `supportsAllDrives`/`includeItemsFromAllDrives`/`driveId` sont activés.
// - Noms de fichiers : jamais de nom de client/consultant/affaire/facture
//   (docs/next/04 §2) — uniquement des identifiants opaques (`eventId`,
//   `memberId`, numéro d'epoch). Ce module ne construit QUE des chemins à
//   partir d'identifiants déjà opaques fournis par l'appelant ; il ne dérive
//   jamais un nom depuis un contenu métier.
// - `appDataFolder` n'est délibérément pas utilisé (docs/next/04 §11 : privé
//   à l'app/l'utilisateur, ne peut pas être partagé — inadapté au workspace
//   d'équipe).
// - Aucune règle métier ici (comme pour tout StorageAdapter, CONTRACTS §5).

import { StorageAdapter, assertValidKind } from "./storage-adapter.js";

/** Scope OAuth cible (docs/next/04 §6) — éviter le scope `drive` complet. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** Nom du dossier racine du workspace (informatif — l'id réel est `rootFolderId`, pas ce nom). */
export const WORKSPACE_ROOT_LABEL_HINT = "Pilotéo - <organisation>";

/** Erreur levée par toute méthode réseau non câblée dans ce lot. Voir en-tête du fichier. */
export class NotWiredError extends Error {
  constructor(methodName) {
    super(
      `GoogleDriveStorageAdapter.${methodName}: NOT_WIRED — OAuth/réseau Google non câblés dans ce lot ` +
        `(spike + credentials requis, cf. docs/next/04_SYNC_ET_STOCKAGE_DRIVE.md §5-6 et ` +
        `docs/next/07_TESTS_ET_RECETTE.md §9). Voir la liste précise en tête de google-drive-adapter.js.`
    );
    this.name = "NotWiredError";
    this.code = "NOT_WIRED";
    this.method = methodName;
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
 * réel est une correspondance à construire lors du câblage réseau (non fait
 * ici : Drive adresse par `fileId`, pas par chemin ; ce helper sert à savoir
 * OÙ créer/chercher le fichier lors de ce câblage futur).
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
// Adaptateur — squelette conforme au contrat, réseau NON câblé
// ---------------------------------------------------------------------------

export class GoogleDriveStorageAdapter extends StorageAdapter {
  /**
   * @param {object} opts
   * @param {() => (string|Promise<string>)} opts.oauthTokenProvider fonction INJECTÉE retournant un access token
   *   Google court (scope `drive.file`). Jamais stocké par cette classe — appelé à la demande uniquement,
   *   au moment de chaque futur appel réseau (non câblé dans ce lot, voir en-tête).
   * @param {string|null} [opts.rootFolderId] id Drive du dossier racine du workspace (reçu à la création/l'invitation).
   * @param {string|null} [opts.driveId] id du Shared Drive ; `null`/absent => My Drive (docs/next/04 §8-9).
   */
  constructor({ oauthTokenProvider, rootFolderId = null, driveId = null } = {}) {
    super();
    if (typeof oauthTokenProvider !== "function") {
      throw new TypeError(
        "GoogleDriveStorageAdapter: 'oauthTokenProvider' (fonction) requis — injecté, jamais stocké en clair par ce module."
      );
    }
    // Référence à la fonction uniquement : le TOKEN qu'elle produira n'est
    // jamais lu/stocké/loggé ici tant que le câblage réseau n'existe pas.
    this._oauthTokenProvider = oauthTokenProvider;
    this.rootFolderId = rootFolderId;
    this.driveId = driveId;
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

  async connect() {
    throw new NotWiredError("connect");
  }

  async putImmutable(kind, id, blob) {
    throw new NotWiredError("putImmutable");
  }

  async get(kind, id) {
    throw new NotWiredError("get");
  }

  async listChanges(cursor) {
    throw new NotWiredError("listChanges");
  }

  async readMetadata(kind, id) {
    throw new NotWiredError("readMetadata");
  }

  async share(member) {
    throw new NotWiredError("share");
  }

  async revoke(member) {
    throw new NotWiredError("revoke");
  }

  async health() {
    throw new NotWiredError("health");
  }
}
