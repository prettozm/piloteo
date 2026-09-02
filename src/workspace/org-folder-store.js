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
    // Ne réemballer en « manifeste existe déjà » QUE si c'est vraiment une
    // violation de write-once (FolderStorageAdapter signale cela explicitement) ;
    // toute autre panne (disque plein, permission, réseau) doit remonter TELLE
    // QUELLE pour ne pas masquer un incident d'E/S en « organisation déjà créée ».
    const msg = String((err && err.message) || err);
    if (/write-once/i.test(msg) || (err && err.code === "EEXIST")) {
      throw new Error(`writeManifest: un manifeste existe déjà (première écriture gagne) — ${msg}`);
    }
    throw err;
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

// ---------------------------------------------------------------------------
// CORRECTIF SÉCURITÉ (contrariant, round 2 — « empoisonnement du slot
// write-once de l'owner par un tiers », repro `attack2-poisoned-owner-slot.mjs`,
// docs/next/ORG_TRUST_HARDENING_CONTRACT.md §3) — PARCOURS_IDENTITE_CONTRACT.md
// Lot 2, « Partager cet espace » : le round 1 (« promotion interrompue »)
// répare une fiche owner MANQUANTE en la republiant (`piloteo-org-bridge.mjs
// #promoteToOrg`, cas `"complete-owner"`) ; mais `writeManifest` publie
// `ownerMemberId`/`ownerPublicKeyJwk` en CLAIR (le modèle « dossier de
// confiance » ne chiffre rien, CLAUDE.md §4) : n'IMPORTE QUEL AUTRE écrivain
// du dossier peut les lire SANS aucune clé privée et déposer, AVANT le retry
// légitime, une fiche `kind:"member"` sous CE MÊME `memberId` mais avec SA
// PROPRE clé — occupant le slot write-once irréversiblement. Sans ce
// correctif, `writeMemberRecord` de la réparation collisionne, l'erreur était
// AVALÉE sans vérifier le contenu déjà présent, et le dossier restait bloqué
// à vie (même symptôme que le round 1, « n'est pas membre »), pour un tiers
// n'ayant besoin d'AUCUNE signature.
//
// Principe (même esprit que §1 du contrat, round 1 : jamais une décision de
// sécurité sur `createdTime`/l'ordre — ici sur la simple PRÉSENCE d'un
// fichier) : une collision write-once sur `(kind:"member", memberId)`
// n'est un no-op sûr QUE si le contenu déjà présent est EXACTEMENT celui
// qu'on voulait publier (même clé, même contenu canonique — la fiche owner
// est déterministe, `promoteSoloToOrg` est pure). Un contenu DIVERGENT est
// un slot CONTESTÉ (tiers/hostile) : jamais avalé silencieusement, jamais
// laissé à `openOrgEngine` comme arbitre final (dont le message « n'est pas
// membre » redeviendrait indiscernable d'une simple panne réseau non
// réparée) — signalé par une erreur EXPLICITE et actionnable (§3 du contrat :
// un DoS d'écrivain hostile doit rester détectable et récupérable, jamais un
// blocage silencieux ; la récupération elle-même — retirer la fiche hostile —
// reste hors du périmètre logiciel, elle relève des permissions du dossier
// partagé, CLAUDE.md §4).
// ---------------------------------------------------------------------------

/** Sérialisation canonique (clés d'objet triées récursivement, ordre des
 *  tableaux conservé) — même algorithme que `org-runtime.js#canonicalJsonStringify`/
 *  `google-drive-adapter.js#canonicalStringify`, réimplémentée ICI plutôt
 *  qu'importée (aucune des deux n'est exportée, et ce module dépend déjà de
 *  `org-runtime.js` dans l'autre sens — `buildTrustedMembership` ci-dessous —
 *  jamais l'inverse). Utile pour comparer deux fiches SANS faux "divergent"
 *  dû à un simple réordonnancement de clés survenu en transit (Drive). */
function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalStringify).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(value[k])).join(",") + "}";
}

/**
 * Lit TOUS les candidats physiques déjà publiés au slot `(kind:"member", id)`
 * — réutilise EXACTEMENT la même stratégie que `listGovernance` ci-dessous
 * (round 1 du durcissement, DRIVE_ONBOARDING_CONTRACT.md) : `getAllCandidates`
 * quand l'adapter l'expose (Drive, collisions physiques possibles SANS
 * signature ni rôle requis — un tiers avec accès Éditeur brut peut y déposer
 * un second fichier homonyme), repli sur `get()` best-effort sinon
 * (`FolderStorageAdapter` : write-once garanti par le filesystem, UN SEUL
 * candidat physiquement possible — mais un slot illisible/corrompu ne doit
 * jamais faire lever cette fonction, jamais plus qu'ailleurs dans ce module).
 * Ne lève JAMAIS : `[]` si le slot est vide/illisible/l'adapter en échec.
 * @param {import("../storage/storage-adapter.js").StorageAdapter} adapter
 * @param {string} memberId
 * @returns {Promise<Array<object>>}
 */
export async function getMemberCandidates(adapter, memberId) {
  if (typeof adapter.getAllCandidates === "function") {
    try {
      return await adapter.getAllCandidates("member", memberId);
    } catch {
      return [];
    }
  }
  try {
    const blob = await adapter.get("member", memberId);
    return blob ? [blob] : [];
  } catch {
    return [];
  }
}

/**
 * Vrai si `candidate` (la fiche membre qu'on VOULAIT publier — typiquement
 * `org.memberRecord` recalculé par `promoteSoloToOrg`, déterministe) est
 * DÉJÀ présente, à l'identique (contenu canonique, `kind:"member"` inclus,
 * exactement ce que `writeMemberRecord` aurait écrit), parmi les candidats
 * réellement publiés au même slot. `false` si le slot est vide (rien à
 * comparer — pas le cas d'usage visé ici, une collision suppose un candidat)
 * OU si tout candidat présent DIVERGE (clé publique et/ou contenu différents
 * — signature d'un tiers/hostile, cf. en-tête ci-dessus).
 * @param {import("../storage/storage-adapter.js").StorageAdapter} adapter
 * @param {object} candidate fiche membre attendue (mêmes champs qu'un `memberRecord` d'`org-runtime.js`)
 * @returns {Promise<boolean>}
 */
export async function memberRecordAlreadyPublished(adapter, candidate) {
  if (!candidate || !candidate.memberId) return false;
  const candidates = await getMemberCandidates(adapter, candidate.memberId);
  const expected = canonicalStringify({ ...candidate, kind: "member" });
  return candidates.some((blob) => canonicalStringify(blob) === expected);
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
 *
 * CORRECTIF SÉCURITÉ (« DoS gouvernance Drive », round contrariant,
 * docs/next/DRIVE_ONBOARDING_CONTRACT.md) — décision 4 RÉVISÉE : sur un
 * adapter où DEUX fichiers physiques peuvent porter le même nom (Drive : un
 * tiers avec accès Éditeur brut au dossier, jamais un membre Pilotéo, jamais
 * une signature, peut y déposer un fichier `<memberId>.piloteo` hostile
 * divergent SANS passer par `putImmutable`), un ancien comportement
 * "candidat divergent -> `ImmutableConflictError` -> `continue`" ABANDONNAIT
 * la fiche VISÉE tout entière — y compris sa version LÉGITIME SIGNÉE, qui
 * disparaissait alors de `memberRecords` et n'était plus jamais admise par
 * `buildTrustedMembership` (jusqu'à exclure le OWNER, clé pinnée depuis le
 * manifeste, de sa PROPRE organisation — DoS total et silencieux, un seul
 * fichier hostile, aucune signature/rôle requis).
 *
 * Principe correct : l'AUTHENTICITÉ d'une fiche de gouvernance est décidée
 * par sa SIGNATURE Ed25519 (`buildTrustedMembership`, déjà correct, NON
 * MODIFIÉ ici — il rejette déjà toute fiche mal signée/mal formée/non
 * rattachée à la genèse), jamais par l'unicité physique d'un fichier. Sur un
 * adapter qui expose `getAllCandidates(kind,id)` (renvoie TOUS les blobs
 * candidats, y compris divergents, sans jamais lever — `GoogleDriveStorageAdapter`),
 * `listGovernance` fournit donc TOUS les candidats de chaque `(kind:"member",id)`
 * à `buildTrustedMembership`, qui admet le candidat validement signé et
 * rejette le(s) candidat(s) hostile(s) — la fiche légitime N'EST JAMAIS
 * perdue à cause d'un fichier hostile. Sur un adapter SANS collision physique
 * possible (`FolderStorageAdapter` : `putImmutable` write-once garantit UN
 * SEUL fichier par nom) — donc SANS `getAllCandidates` — comportement
 * STRICTEMENT INCHANGÉ (repli sur `get()`, un seul candidat, non-régression).
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
    let blobs;
    if (typeof adapter.getAllCandidates === "function") {
      // Adapter à collisions physiques possibles (Drive) : TOUS les candidats,
      // jamais un seul abandonné sur divergence — voir le correctif ci-dessus.
      try {
        blobs = await adapter.getAllCandidates("member", change.id);
      } catch {
        blobs = []; // best-effort global si même `getAllCandidates` échoue (ex: panne réseau) — inchangé pour ce cas rare.
      }
    } else {
      // Adapter sans collision physique possible (ex: FolderStorageAdapter,
      // write-once) : comportement HISTORIQUE inchangé (décision 4 d'origine).
      try {
        const blob = await adapter.get("member", change.id);
        blobs = blob ? [blob] : [];
      } catch {
        // Blob illisible/corrompu (ex: écriture partielle par un synchroniseur
        // externe) : ignoré plutôt que de faire échouer toute la lecture de
        // gouvernance (décision 4 d'origine — s'applique ici à un adapter où
        // un `ImmutableConflictError` ne peut légitimement signaler qu'une
        // vraie panne d'E/S, jamais une collision de fichiers physiques).
        blobs = [];
      }
    }
    for (const blob of blobs) {
      if (blob && blob.kind === "member") {
        memberRecords.push(blob);
      } else if (blob && blob.kind === "revocation") {
        revocations.push(blob);
      }
      // Tout autre contenu (kind absent/inattendu, ex: le fichier hostile du
      // correctif ci-dessus) est ignoré silencieusement ici : ni une fiche
      // membre, ni une révocation, il n'a rien à faire dans la gouvernance —
      // mais son EXISTENCE n'empêche plus la fiche légitime homonyme d'être
      // lue (décision 4, best-effort).
    }
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
