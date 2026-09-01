// src/workspace/org-folder-store.js
//
// Persistance de la GOUVERNANCE d'une organisation sur un `adapter`
// (typiquement `FolderStorageAdapter`) — docs/next/ORG_FOLDER_CONTRACT.md §1/§2.
//
// Décisions/hypothèses :
//
// 1. AUCUN nouveau `kind` de stockage n'est introduit (contrainte §5 du
//    contrat) : le manifeste de genèse va sous `kind:"workspace"` (id fixe
//    "manifest", déjà singleton côté FolderStorageAdapter), les fiches membres
//    ET les fiches de révocation vont TOUTES DEUX sous `kind:"member"` — un
//    id distinct (`"revocation-"+revocationId`) et un champ `blob.kind`
//    (`"member"` vs `"revocation"`) permettent de les distinguer à la
//    relecture (`listGovernance`). C'est le tri demandé par le contrat §1.
//
// 2. `writeManifest` applique explicitement la règle "premier gagne" (§5.1
//    ORG_CONTRACT) avec un message d'erreur stable ("un manifeste existe
//    déjà"), même si `FolderStorageAdapter.putImmutable` refuse déjà toute
//    réécriture (write-once générique) — on ne se contente pas de laisser
//    remonter ce message générique tel quel : on distingue explicitement le
//    cas "manifeste déjà présent" (racine de confiance figée) de toute autre
//    erreur d'E/S, pour que l'appelant (org-sync.js, tests) puisse matcher un
//    message métier stable plutôt qu'un message d'implémentation.
//
// 3. `readManifest` retourne `null` (jamais une exception) quand aucun
//    manifeste n'a encore été publié sur ce dossier — un dossier vide est un
//    état légitime (avant la genèse), pas une erreur.
//
// 4. `listGovernance` fait une UNIQUE énumération (`adapter.listChanges()`)
//    puis lit chaque blob annoncé sous `kind==="member"` — elle NE FILTRE PAS
//    par nom de fichier (ex: préfixe "revocation-") mais par le contenu du
//    blob (`blob.kind`), comme demandé par le contrat §1 ("le tri se fait à
//    la lecture"). Une fiche member/revocation illisible/corrompue est
//    ignorée plutôt que de faire échouer toute la lecture de gouvernance (un
//    dossier synchronisé de l'extérieur peut contenir des fichiers partiels
//    en cours d'écriture par l'outil de synchro) — mais ce best-effort est
//    silencieux UNIQUEMENT pour un blob illisible, jamais pour une fiche bien
//    formée mais invalide en confiance (ça, c'est le rôle de
//    `buildTrustedMembership`, appelé ensuite par `loadTrust`).
//
// 5. `loadTrust` compose `listGovernance` + `buildTrustedMembership`
//    (org-runtime.js) — aucune logique de confiance n'est dupliquée ici. Un
//    dossier sans manifeste ("dossier sans organisation") lève explicitement,
//    plutôt que de laisser `buildTrustedMembership` échouer avec un message
//    moins clair sur un `manifest` `null`.

import { buildTrustedMembership } from "./org-runtime.js";

const REVOCATION_PREFIX = "revocation-";

/**
 * Publie le manifeste de genèse. Write-once : lève explicitement si un
 * manifeste existe déjà sur ce dossier (le premier créateur gagne — racine de
 * confiance immuable, docs/next/ORG_CONTRACT.md §5.1).
 * @param {import("../storage/storage-adapter.js").StorageAdapter} adapter
 * @param {object} manifest
 * @returns {Promise<object>} le manifeste publié
 */
export async function writeManifest(adapter, manifest) {
  if (!manifest || !manifest.workspaceId || !manifest.ownerMemberId || !manifest.ownerPublicKeyJwk) {
    throw new Error("writeManifest: 'manifest' invalide (workspaceId/ownerMemberId/ownerPublicKeyJwk requis)");
  }
  try {
    await adapter.putImmutable("workspace", "manifest", manifest);
  } catch (err) {
    // write-once violé (déjà présent) OU toute autre panne d'E/S : on ne peut
    // distinguer les deux qu'en relisant — mais dans les deux cas, la règle
    // métier est la même : un manifeste existe déjà, le premier gagne.
    throw new Error(`writeManifest: un manifeste existe déjà (première écriture gagne) — ${(err && err.message) || err}`);
  }
  return manifest;
}

/**
 * Lit le manifeste de genèse publié sur ce dossier, ou `null` si aucun (état
 * légitime avant la genèse).
 * @param {import("../storage/storage-adapter.js").StorageAdapter} adapter
 * @returns {Promise<object|null>}
 */
export async function readManifest(adapter) {
  try {
    const exists = await adapter.exists("workspace", "manifest");
    if (!exists) return null;
  } catch {
    return null;
  }
  try {
    return await adapter.get("workspace", "manifest");
  } catch {
    return null;
  }
}

/**
 * Publie une fiche membre (`kind:"member"`, une par membre, immuable) sous
 * `kind:"member"` avec `id = record.memberId`.
 * @param {import("../storage/storage-adapter.js").StorageAdapter} adapter
 * @param {object} record fiche membre (org-runtime.js `memberRecord`)
 * @returns {Promise<object>} la fiche publiée (forme normalisée `kind:"member"`)
 */
export async function writeMemberRecord(adapter, record) {
  if (!record || !record.memberId) {
    throw new Error("writeMemberRecord: 'record.memberId' requis");
  }
  const blob = { ...record, kind: "member" };
  await adapter.putImmutable("member", record.memberId, blob);
  return blob;
}

/**
 * Publie une fiche de révocation SOUS LE MÊME kind de stockage `"member"`
 * (aucun nouveau kind — §1 du contrat), avec un id distinct
 * `"revocation-"+revocationId` et un champ `kind:"revocation"` dans le blob
 * pour la distinguer à la lecture (`listGovernance`).
 * @param {import("../storage/storage-adapter.js").StorageAdapter} adapter
 * @param {object} revocation fiche de révocation (org-runtime.js `createRevocation`, avec `revocationId`)
 * @returns {Promise<object>} la fiche publiée
 */
export async function writeRevocation(adapter, revocation) {
  if (!revocation || revocation.kind !== "revocation") {
    throw new Error("writeRevocation: 'revocation.kind' doit être 'revocation'");
  }
  if (!revocation.revocationId) {
    throw new Error("writeRevocation: 'revocation.revocationId' requis (voir org-runtime.js#createRevocation)");
  }
  const blob = { ...revocation };
  await adapter.putImmutable("member", REVOCATION_PREFIX + revocation.revocationId, blob);
  return blob;
}

/**
 * Lit TOUTE la gouvernance publiée sur ce dossier : le manifeste de genèse,
 * les fiches membres et les fiches de révocation — en dispatchant les blobs
 * `kind:"member"` du storage par leur CONTENU (`blob.kind`), pas par leur nom
 * de fichier (§1/§4 du contrat).
 * @param {import("../storage/storage-adapter.js").StorageAdapter} adapter
 * @returns {Promise<{manifest:object|null, memberRecords:Array<object>, revocations:Array<object>}>}
 */
export async function listGovernance(adapter) {
  const manifest = await readManifest(adapter);

  const { changes } = await adapter.listChanges();
  const memberRecords = [];
  const revocations = [];

  for (const change of changes) {
    if (!change || change.kind !== "member") continue; // seul le kind de stockage "member" porte membres+révocations.
    let blob;
    try {
      blob = await adapter.get("member", change.id);
    } catch {
      // Blob illisible/corrompu (ex: écriture partielle par un synchroniseur
      // externe) : ignoré plutôt que de faire échouer toute la lecture de
      // gouvernance (décision 4).
      continue;
    }
    if (blob && blob.kind === "member") {
      memberRecords.push(blob);
    } else if (blob && blob.kind === "revocation") {
      revocations.push(blob);
    }
    // Tout autre contenu (kind absent/inattendu) est ignoré silencieusement :
    // ni une fiche membre, ni une révocation, il n'a rien à faire dans la
    // gouvernance (best-effort, décision 4).
  }

  return { manifest, memberRecords, revocations };
}

/**
 * Reconstruit la chaîne de confiance COMPLÈTE de ce dossier : lit toute la
 * gouvernance publiée (`listGovernance`) puis la fait vérifier par
 * `buildTrustedMembership` (org-runtime.js §5.4) — aucune fiche brute n'est
 * jamais exposée à l'appelant sans passer par cette vérification.
 * @param {import("../storage/storage-adapter.js").StorageAdapter} adapter
 * @returns {Promise<{manifest:object, registry:object, membershipStore:object, trusted:Array<object>, revoked:Array<object>, rejected:Array<object>}>}
 */
export async function loadTrust(adapter) {
  const { manifest, memberRecords, revocations } = await listGovernance(adapter);
  if (!manifest) {
    throw new Error("loadTrust: dossier sans organisation (aucun manifeste de genèse publié)");
  }
  const { registry, membershipStore, trusted, revoked, rejected } = await buildTrustedMembership({
    manifest,
    memberRecords,
    revocations,
  });
  return { manifest, registry, membershipStore, trusted, revoked, rejected };
}
