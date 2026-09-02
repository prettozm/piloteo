// piloteo-org-bridge.mjs — pont navigateur du mode Organisation (point 2c-C2,
// docs/next/ORG_UI_CONTRACT.md §1), symétrique à piloteo-solo-bridge.mjs
// (mode Dossier, point 1b) mais au-dessus du moteur multi-membre (2c-C1).
//
// Décisions/hypothèses :
// - AUCUNE primitive canonique n'est réécrite : ce module importe uniquement
//   `src/workspace/org-engine.js` (openOrgEngine), `src/workspace/org-runtime.js`
//   (identité, création d'organisation, invitation, révocation),
//   `src/workspace/org-folder-store.js` (écriture manifeste/fiches/révocations),
//   `src/storage/fsaccess-port.js`/`fsaccess-handle-store.js` (port navigateur
//   File System Access + persistance du handle) et `src/storage/
//   folder-storage-adapter.js` (StorageAdapter au-dessus du port). Rien n'est
//   dupliqué.
// - `local-backend.js` est un script CLASSIQUE (pas de modules) : le seul
//   point de contact entre les deux mondes est `window.PiloteoOrg`, posé ici.
//   Ce module est chargé en `<script type="module">` (différé de fait) :
//   `local-backend.js` NE DOIT PAS supposer `window.PiloteoOrg` présent à son
//   propre chargement — il le teste à l'usage (comme pour `window.PiloteoNext`,
//   cf. piloteo-solo-bridge.mjs).
// - Le handle de dossier ET le drapeau de mode (`piloteo_storage_mode`) sont
//   mémorisés dans le MÊME store que le mode Dossier
//   (`src/storage/fsaccess-handle-store.js`, une IndexedDB à un seul handle
//   « courant ») : les deux modes sont mutuellement exclusifs (un seul
//   `piloteo_storage_mode` actif à la fois), donc un seul « dossier courant »
//   à mémoriser a du sens, exactement comme le mode Dossier le fait déjà.
// - IDENTITÉ DE MEMBRE : générée une seule fois via
//   `org-runtime.js#newMemberIdentity()` (qui appelle
//   `crypto-service.js#generateMemberIdentity()`) puis PERSISTÉE dans sa
//   propre IndexedDB (`piloteo-org-identity`). `privateKeyRef` est
//   `{keyType:'ed25519', cryptoKey}` où `cryptoKey` est un `CryptoKey` Ed25519
//   NON EXTRACTIBLE — structured-cloneable, donc stockable tel quel (même
//   principe que `fsaccess-handle-store.js` pour les `FileSystemDirectoryHandle`).
//   Une même personne/appareil garde ainsi son identité entre sessions, dans
//   CE navigateur (elle n'est jamais synchronisée : c'est la clé PUBLIQUE,
//   publiée dans les fiches membres du dossier, qui permet aux autres membres
//   de la reconnaître).
// - `createOrg`/`joinOrg`/`openOrg` acceptent tous un `identity` optionnel
//   (déviation additive au contrat, documentée ici) qui, si fourni, est
//   utilisé À LA PLACE de l'identité persistée par défaut
//   (`getOrCreateIdentity()`). Ceci n'a AUCUN effet sur l'usage normal (l'UI
//   de `local-backend.js` ne le passe jamais) ; c'est un point d'injection
//   pour les tests e2e qui doivent simuler PLUSIEURS membres (donc plusieurs
//   identités) dans le MÊME onglet/navigateur, où il n'existe par construction
//   qu'une seule identité "courante" persistée — cf. `__identityStore.create()`
//   ci-dessous, qui fabrique une identité fraîche SANS la persister comme
//   identité courante.
// - `invite` ne publie RIEN sur le dossier (docs/next/ORG_UI_CONTRACT.md §1 :
//   "l'invitation est un CODE transmis hors bande... pas un fichier du
//   dossier") : le `code` retourné est le JSON de l'invitation signée, encodé
//   en base64url (symétrique de `decodeInvitationCode` côté `joinOrg`). Le
//   paramètre `adapter` de `invite`/`revoke` suit la forme du contrat (les
//   deux opérations de gouvernance prennent `{engine, adapter, ...}|`) même si
//   `invite` elle-même n'en a pas besoin (elle ne fait aucune E/S) — gardé
//   pour la symétrie d'appel avec `revoke` (qui, elle, publie une fiche de
//   révocation via `org-folder-store.js#writeRevocation`).
// - `pickDirectory` (fsaccess-port.js) est RÉ-EXPORTÉ tel quel sur
//   `window.PiloteoOrg` (déviation additive, non listée par le contrat mais
//   nécessaire) : l'onboarding UI de `local-backend.js` doit ouvrir le
//   sélecteur natif de dossier (geste utilisateur requis) AVANT d'appeler
//   `createOrg`/`joinOrg` (qui prennent un `handle` déjà choisi, comme le
//   contrat le précise : "pick déjà fait"). Il n'existe aucune autre primitive
//   déjà committée pour cela dans ce module ; la dupliquer aurait été pire que
//   de ré-exporter celle de `fsaccess-port.js`.
// - `resumeOrg()` (reprise au boot, symétrique de
//   `piloteo-solo-bridge.mjs#resumeFolder`) : mêmes trois issues —
//   `null` (aucun dossier mémorisé), `{needsPermission:true}` (permission à
//   ré-accorder par un geste utilisateur), `{engine, adapter, manifest,
//   membership, folderName}` sinon. `consultantId` n'est pas requis pour
//   rouvrir un engine sur un membership déjà publié (org-sync.js décision 1 :
//   il ne sert qu'à la construction, pas à la vérification).
// - `engine.folderName` (comme pour le mode Dossier) est ajouté en PLUS de la
//   forme retournée par `openOrgEngine` (qui ne le porte pas) — champ EXTRA
//   pour l'affichage dans Réglages, jamais lu par `org-engine.js` lui-même.
// - `adapter` est retourné EN PLUS de `{engine, manifest}` par
//   `createOrg`/`joinOrg`/`openOrg`/`resumeOrg` (déviation additive) :
//   `invite`/`revoke` en ont besoin (revoke écrit sur le dossier) et il
//   n'existe aucun autre moyen pour l'appelant (`local-backend.js`) de le
//   récupérer sans le reconstruire lui-même depuis le handle — ce que ce
//   module ferait de toute façon en interne, donc autant le renvoyer.

import { createFsAccessPort, pickDirectory, ensureHandlePermission } from "./src/storage/fsaccess-port.js";
import { saveDirectoryHandle, loadDirectoryHandle } from "./src/storage/fsaccess-handle-store.js";
import { FolderStorageAdapter } from "./src/storage/folder-storage-adapter.js";
import { openOrgEngine } from "./src/workspace/org-engine.js";
import {
  newMemberIdentity,
  createOrganization,
  promoteSoloToOrg,
  planPromotion,
  inviteMember,
  acceptInvitation,
  createRevocation,
} from "./src/workspace/org-runtime.js";
import {
  writeManifest,
  writeMemberRecord,
  writeRevocation,
  readManifest,
  loadTrust,
  memberRecordAlreadyPublished,
  isWriteOnceCollision,
} from "./src/workspace/org-folder-store.js";
import * as cryptoService from "./src/crypto/crypto-service.js";

// ---------------------------------------------------------------------------
// Identité de membre — persistée en IndexedDB (une base dédiée, séparée de
// `fsaccess-handle-store.js` : deux objets distincts, même principe).
// ---------------------------------------------------------------------------

const IDB_NAME = "piloteo-org-identity";
const IDB_VERSION = 1;
const STORE = "identity";
const CURRENT_KEY = "current";

function idbFactory() {
  const f = globalThis.indexedDB;
  if (!f) throw new Error("piloteo-org-bridge: IndexedDB indisponible dans cet environnement.");
  return f;
}
function openIdentityDb() {
  return new Promise((resolve, reject) => {
    const req = idbFactory().open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbTx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; }).catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Restaure l'identité de membre persistée, ou `null` s'il n'y en a pas. */
async function loadIdentity() {
  const db = await openIdentityDb();
  try {
    const value = await idbTx(db, "readonly", (store) => reqToPromise(store.get(CURRENT_KEY)));
    return value ?? null;
  } finally {
    db.close();
  }
}
/** Enregistre l'identité de membre courante (écrase la précédente). */
async function saveIdentity(identity) {
  const db = await openIdentityDb();
  try {
    await idbTx(db, "readwrite", (store) => reqToPromise(store.put(identity, CURRENT_KEY)));
  } finally {
    db.close();
  }
}

// Point 3 (docs/next/AUTH_SESSION_CONTRACT.md §4) : « Changer d'identité »
// (Réglages, distinct de « Se déconnecter ») oublie DÉFINITIVEMENT la clé de
// membre de CET appareil — l'ancien memberId/sa clé publique restent dans les
// fiches déjà publiées du dossier (rien n'est réécrit là-bas, rayon
// d'explosion nul pour les autres membres), mais cet appareil ne pourra plus
// authentifier les actions de cette identité tant qu'un administrateur ne
// l'aura pas ré-invité sous une IDENTITÉ FRAÎCHE. Efface aussi le mémoïsé
// `_identityPromise` pour qu'un prochain `getOrCreateIdentity()` en génère une
// nouvelle plutôt que de resservir l'ancienne depuis le cache mémoire.
async function forgetIdentity() {
  const db = await openIdentityDb();
  try {
    await idbTx(db, "readwrite", (store) => reqToPromise(store.delete(CURRENT_KEY)));
  } finally {
    db.close();
  }
  _identityPromise = null;
}

// Mémoïsé : un seul appel de création par chargement de page (comme
// `ensureFolderReady` côté piloteo-solo-bridge.mjs) — évite deux identités
// générées en parallèle par deux appels concurrents.
let _identityPromise = null;
/**
 * Identité de membre PERSISTÉE (IndexedDB) de cet appareil/navigateur : la
 * restaure si elle existe déjà, sinon en génère une nouvelle et la persiste.
 * @returns {Promise<{memberId:string, publicKeyJwk:object, privateKeyRef:object}>}
 */
async function getOrCreateIdentity() {
  if (!_identityPromise) {
    _identityPromise = (async () => {
      const existing = await loadIdentity();
      if (existing && existing.memberId && existing.publicKeyJwk && existing.privateKeyRef) return existing;
      const created = await newMemberIdentity();
      await saveIdentity(created);
      return created;
    })();
  }
  return _identityPromise;
}

function makeSigner(identity) {
  return (bytes) => cryptoService.sign(identity.privateKeyRef, bytes);
}

// ---------------------------------------------------------------------------
// Encodage du code d'invitation (base64url d'un JSON) — hors bande, jamais un
// fichier du dossier (voir en-tête).
// ---------------------------------------------------------------------------

function encodeBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeBase64Url(str) {
  let b64 = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";
  else if (pad !== 0) throw new Error("code d'invitation invalide (longueur incorrecte)");
  let bin;
  try { bin = atob(b64); } catch { throw new Error("code d'invitation invalide (décodage échoué)"); }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function encodeInvitationCode(invitation) {
  return encodeBase64Url(JSON.stringify(invitation));
}
function decodeInvitationCode(code) {
  let json;
  try { json = decodeBase64Url(code); } catch (e) { throw new Error("Code d'invitation illisible : " + e.message); }
  try { return JSON.parse(json); } catch { throw new Error("Code d'invitation illisible (JSON invalide)."); }
}

// ---------------------------------------------------------------------------
// Construction de l'adapter au-dessus d'un FileSystemDirectoryHandle.
// ---------------------------------------------------------------------------

function buildAdapter(handle) {
  const fsPort = createFsAccessPort(handle);
  return new FolderStorageAdapter({ fsPort, label: "org" });
}

const STORAGE_MODE_KEY = "piloteo_storage_mode"; // partagé avec piloteo-solo-bridge.mjs (mutuellement exclusif)

async function persistOrgMode(handle) {
  await saveDirectoryHandle(handle);
  try { localStorage.setItem(STORAGE_MODE_KEY, "org"); } catch (e) { /* localStorage indisponible : dégradé, pas bloquant */ }
}

function withFolderName(engine, handle) {
  engine.folderName = (handle && handle.name) || null;
  return engine;
}

// ---------------------------------------------------------------------------
// API publique
// ---------------------------------------------------------------------------

/**
 * Crée une organisation sur `handle` (dossier déjà choisi par l'utilisateur) :
 * publie le manifeste de genèse + la fiche membre du créateur (OWNER).
 * Renvoie `{engine, adapter, manifest}`.
 *
 * Point 5 (docs/next/MIGRATION_MODE_CONTRACT.md) : NE bascule PLUS
 * `piloteo_storage_mode` elle-même (déviation par rapport au comportement
 * antérieur au lot 2c-C2, documentée ici) — cette activation est différée à
 * `activateOrgStorageMode()` ci-dessous, appelée par `local-backend.js`
 * UNIQUEMENT après avoir migré (si nécessaire) l'état solo existant vers
 * cette organisation fraîchement créée ET vérifié le round-trip
 * (`verifyRoundTrip`). Sans ce report, un rechargement de page survenant
 * entre CETTE fonction et la vérification de la migration verrait déjà
 * `piloteo_storage_mode==="org"` en localStorage au prochain démarrage, alors
 * que rien n'aurait encore été garanti — violation directe de l'invariant
 * « jamais de bascule de mode sans verifyRoundTrip OK » (contrat §1/§2).
 * `joinOrg` ci-dessous n'est PAS concernée (rejoindre ne migre jamais de
 * données solo, l'activation immédiate y reste correcte).
 */
async function createOrg({ handle, name, consultantId, identity } = {}) {
  if (!handle) throw new Error("createOrg: 'handle' requis (sélecteur de dossier déjà effectué).");
  const adapter = buildAdapter(handle);
  await adapter.connect();
  const id = identity || (await getOrCreateIdentity());
  const org = createOrganization({ name, identity: id, consultantId });
  await writeManifest(adapter, org.manifest);
  await writeMemberRecord(adapter, org.memberRecord);
  const engine = await openOrgEngine({ adapter, identity: id, consultantId });
  return { engine: withFolderName(engine, handle), adapter, manifest: engine.manifest };
}

/**
 * Active RÉELLEMENT le mode org pour ce navigateur (persiste le handle +
 * `piloteo_storage_mode="org"`). À appeler par `local-backend.js` UNIQUEMENT
 * après vérification (Point 5) — jamais automatiquement par `createOrg()`
 * (voir sa décision ci-dessus).
 */
async function activateOrgStorageMode(handle) {
  await persistOrgMode(handle);
}

/**
 * CORRECTIF SÉCURITÉ (contrariant, « promotion interrompue qui brique le
 * dossier à vie », repro `attack1-interrupted-promotion.mjs`) — vérifie que
 * l'owner (`identity`) visé par `manifest` est RÉELLEMENT admis dans
 * `membershipStore` (rôle `owner`, statut `active`), via la chaîne de
 * confiance COMPLÈTE (`org-folder-store.js#loadTrust`, qui compose
 * `listGovernance` + `buildTrustedMembership` — aucune logique de confiance
 * dupliquée ici). PAS une simple présence de fichier : `buildTrustedMembership`
 * doit avoir effectivement admis la fiche genèse (elle peut être absente,
 * ou publiée mais invalide — `genesisMismatchReason`). Ne lève jamais :
 * `false` sur toute erreur (dossier illisible, pas encore de gouvernance),
 * ce qui est le choix SÛR ici (pousse vers `"complete-owner"`/republication,
 * jamais vers un faux `"already-promoted"`).
 * @returns {Promise<boolean>}
 */
async function isOwnerAdmitted(adapter, workspaceId, identity) {
  try {
    const trust = await loadTrust(adapter);
    if (trust.manifest.workspaceId !== workspaceId) return false;
    const membership = trust.membershipStore.get(workspaceId, identity.memberId);
    return !!(membership && membership.role === "owner" && membership.status === "active");
  } catch {
    return false;
  }
}

/**
 * PARCOURS_IDENTITE_CONTRACT.md, Lot 2 — « Partager cet espace » : promeut EN
 * PLACE un workspace SOLO existant (`workspaceId` fourni par l'appelant —
 * `local-backend.js`, identité solo FIXE de cet appareil) sur `handle`
 * (dossier déjà choisi). Symétrique de `createOrg` ci-dessus, avec DEUX
 * différences volontaires :
 * 1. `workspace(Id)` N'EST JAMAIS généré ici : c'est CELUI fourni
 *    (`promoteSoloToOrg`, org-runtime.js) — « W-001 Local -> W-001 Shared »,
 *    jamais un nouveau workspace/export déguisé.
 * 2. Un manifeste PEUT déjà exister sur ce dossier (reprise après un premier
 *    appel réussi, une promotion INTERROMPUE en cours de route, ou après une
 *    bascule retournée en solo) : `planPromotion` (org-runtime.js, pur)
 *    décide AVANT toute écriture, à partir du manifeste ET de l'admission
 *    RÉELLE de l'owner (`isOwnerAdmitted` ci-dessus, jamais une simple
 *    présence de fichier — CORRECTIF ci-dessus) :
 *    - `{kind:"promote"}` : aucun manifeste -> publie manifeste + fiche owner.
 *    - `{kind:"complete-owner"}` : manifeste présent (même workspace/owner)
 *      mais owner PAS ADMIS (ex: `writeMemberRecord` avait échoué lors d'un
 *      appel précédent, APRÈS que `writeManifest`, lui, avait réussi —
 *      write-once, irréversible) -> republie UNIQUEMENT la fiche owner
 *      (JAMAIS un second manifeste) : la fiche est déterministe
 *      (`promoteSoloToOrg` est pure, mêmes entrées -> même sortie), la
 *      republier répare le dossier sans jamais le corrompre. CORRECTIF round
 *      2 (repro `attack2-poisoned-owner-slot.mjs`) : une collision write-once
 *      sur CETTE republication n'est avalée QUE si le contenu déjà présent
 *      au slot est EXACTEMENT `org.memberRecord` (`memberRecordAlreadyPublished`,
 *      org-folder-store.js — ma propre fiche, publiée par une tentative
 *      antérieure dont seule la confirmation avait été perdue). Un contenu
 *      DIVERGENT (un TIERS a occupé le slot `(member, ownerMemberId)` AVANT
 *      ce retry — `ownerMemberId`/`ownerPublicKeyJwk` sont PUBLICS dans le
 *      manifeste dès `writeManifest`, AUCUNE clé privée requise pour ça) fait
 *      lever une erreur EXPLICITE et DISTINCTE (« owner contesté »), jamais
 *      avalée ni laissée à `openOrgEngine` comme arbitre final silencieux —
 *      sinon le dossier resterait bloqué à vie de façon indiscernable d'une
 *      simple panne réseau non réparée, alors que CE cas EST récupérable
 *      (retirer la fiche hostile via les permissions du dossier, puis
 *      réessayer — ORG_TRUST_HARDENING_CONTRACT.md §3 : un DoS d'écrivain
 *      hostile doit rester détectable et récupérable, jamais un blocage
 *      silencieux).
 *    - `{kind:"already-promoted"}` : manifeste présent, MÊME owner, ET déjà
 *      RÉELLEMENT admis -> NO-OP sûr (rien n'est publié).
 *    - `{kind:"conflict"}` : dossier étranger ou owner différent -> lève
 *      AVANT toute écriture (inchangé, anti-usurpation non affectée par ce
 *      correctif : `ownerAdmitted` n'intervient QUE quand workspace/owner
 *      correspondent déjà).
 * Ordre D'ÉCRITURE robuste et volontairement figé : `writeManifest` est
 * TOUJOURS la toute première écriture d'une genèse (jamais l'inverse — une
 * fiche membre sans manifeste n'a aucun sens, `writeMemberRecord` exige une
 * genèse déjà ancrée) ; une réparation ne fait donc QUE rejouer la SECONDE
 * moitié (`writeMemberRecord`), jamais retoucher au manifeste déjà publié.
 * Après (re)publication RÉELLEMENT ACCEPTÉE (round 2 : jamais après une
 * collision hostile, qui lève AVANT d'atteindre ce point), `openOrgEngine`
 * (qui échoue explicitement si l'owner n'est toujours pas membre) sert de
 * VÉRIFICATION FINALE avant de considérer la promotion réussie — jamais un
 * succès annoncé sans un engine réellement ouvrable.
 * Ne bascule PAS `piloteo_storage_mode` (même report qu'`createOrg`, voir sa
 * décision : `local-backend.js` doit d'abord republier les événements solo
 * existants — Point 5, `piloteo-migration-bridge.mjs` — et vérifier le
 * round-trip AVANT `activateOrgStorageMode()`).
 * @param {{handle:*, workspaceId:string, name:string, consultantId?:string, identity?:object}} params
 * @returns {Promise<{engine:object, adapter:object, manifest:object, alreadyPromoted:boolean, completedOwnerRecord:boolean}>}
 */
async function promoteToOrg({ handle, workspaceId, name, consultantId, identity } = {}) {
  if (!handle) throw new Error("promoteToOrg: 'handle' requis (sélecteur de dossier déjà effectué).");
  if (!workspaceId) throw new Error("promoteToOrg: 'workspaceId' requis (identité solo d'origine à conserver).");
  const adapter = buildAdapter(handle);
  await adapter.connect();
  const id = identity || (await getOrCreateIdentity());

  const existingManifest = await readManifest(adapter);
  // `isOwnerAdmitted` n'a de sens (et n'a besoin d'être calculé) QUE si un
  // manifeste existe déjà — sur un dossier vierge, `ownerAdmitted` reste à
  // son défaut sûr (`false`, ignoré de toute façon par `planPromotion` quand
  // `existingManifest` est `null`).
  const ownerAdmitted = existingManifest ? await isOwnerAdmitted(adapter, workspaceId, id) : false;
  const plan = planPromotion({ existingManifest, workspaceId, identity: id, ownerAdmitted });
  if (plan.kind === "conflict") {
    throw new Error(`promoteToOrg: ${plan.reason}`);
  }
  if (plan.kind === "promote" || plan.kind === "complete-owner") {
    const org = promoteSoloToOrg({ workspaceId, name, identity: id, consultantId });
    if (plan.kind === "promote") {
      // CORRECTIF défensif (contrariant round 3) : `readManifest` traite TOUT
      // échec de lecture — y compris un slot manifeste CONTESTÉ sur Drive
      // (plusieurs candidats divergents/illisibles, `ImmutableConflictError`)
      // — comme « aucun manifeste » (décision 3, org-folder-store.js,
      // délibérément conservée telle quelle : la modifier risquerait de
      // régresser tout appelant qui dépend de « pas de manifeste -> null »,
      // ex. `loadTrust`). `plan.kind==="promote"` pourrait donc, à tort,
      // tenter une écriture sur un slot en réalité déjà occupé : PLUTÔT que
      // de laisser `writeManifest` échouer avec un message confus (une
      // collision sur un manifeste qu'on croyait absent), on vérifie
      // EXPLICITEMENT ici, sur un adapter qui expose `getAllCandidates`
      // (Drive — seul transport où cette contestation physique est possible ;
      // `FolderStorageAdapter`/write-once garantit qu'aucun candidat ne peut
      // exister sans que `readManifest` l'ait vu). Un slot occupé fait lever
      // AVANT toute tentative d'écriture, avec un message qui NOMME le
      // problème réel — jamais une écriture confuse vouée à l'échec.
      if (typeof adapter.getAllCandidates === "function") {
        let contestedManifestCandidates = [];
        try {
          contestedManifestCandidates = await adapter.getAllCandidates("workspace", "manifest");
        } catch {
          contestedManifestCandidates = [];
        }
        if (contestedManifestCandidates.length > 0) {
          throw new Error(
            "promoteToOrg: le slot manifeste de ce dossier est occupé (candidats illisibles ou " +
            "divergents) alors qu'aucun manifeste exploitable n'a pu être lu — vérifiez le dossier " +
            "partagé (permissions/contenu) avant de réessayer de partager cet espace."
          );
        }
      }
      await writeManifest(adapter, org.manifest);
    }
    try {
      await writeMemberRecord(adapter, org.memberRecord);
    } catch (err) {
      // "complete-owner" seulement : une collision write-once ICI est
      // ATTENDUE (c'est précisément le cas que ce correctif répare) — mais
      // elle a DEUX causes possibles, jamais confondues (CORRECTIF round 2,
      // repro `attack2-poisoned-owner-slot.mjs`, ORG_TRUST_HARDENING_CONTRACT.md
      // §3) :
      //  (a) légitime : ma PROPRE fiche a déjà été publiée par une tentative
      //      précédente dont seule la CONFIRMATION réseau avait été perdue —
      //      contenu canonique IDENTIQUE à `org.memberRecord` (déterministe,
      //      `promoteSoloToOrg` est pure) -> avaler, continuer (idempotent).
      //  (b) hostile : un TIERS (aucune clé privée requise — `ownerMemberId`/
      //      `ownerPublicKeyJwk` sont PUBLICS dans le manifeste dès
      //      `writeManifest`) a occupé le slot AVANT ce retry, avec un
      //      contenu DIVERGENT -> ne JAMAIS avaler silencieusement : lever
      //      une erreur EXPLICITE et DISTINCTE, actionnable (retirer la
      //      fiche hostile via les permissions du dossier), plutôt que de
      //      laisser `openOrgEngine` ci-dessous devenir l'arbitre final —
      //      son « n'est pas membre » redeviendrait indiscernable d'une
      //      simple panne réseau non réparée, alors que CE cas EST réparable
      //      (dès que la fiche hostile est retirée). Pour "promote" (fiche
      //      fraîche sur un manifeste tout juste écrit PAR CET APPEL), une
      //      collision reste TOUJOURS anormale : jamais avalée (voir le
      //      `throw` inconditionnel ci-dessous pour ce cas).
      if (plan.kind !== "complete-owner") throw err;
      // Ne tenter la distinction (a)/(b) ci-dessus QUE pour une VRAIE
      // collision write-once — `isWriteOnceCollision` (org-folder-store.js,
      // CORRECTIF round 3) reconnaît les DEUX signaux réels : le message
      // `write-once` (`FolderStorageAdapter`/`InMemoryStorageAdapter`) ET le
      // NOM `ImmutableConflictError` (`GoogleDriveStorageAdapter` — dont le
      // message dit `IMMUTABLE_CONFLICT`, jamais « write-once » : sans ce
      // correctif, une collision RÉELLE sur Drive n'aurait jamais déclenché
      // cette distinction). Toute AUTRE erreur (panne réseau/FS persistante,
      // permission refusée, etc. — rien n'a été écrit, aucun tiers en cause)
      // reste une erreur ORDINAIRE, remontée TELLE QUELLE, jamais reformulée
      // en un faux « owner contesté » qui égarerait l'utilisateur.
      if (!isWriteOnceCollision(err)) throw err;
      const mine = await memberRecordAlreadyPublished(adapter, org.memberRecord);
      if (!mine) {
        throw new Error(
          "promoteToOrg: le slot owner de ce dossier est occupé par une fiche tierce/hostile " +
          "(memberId owner contesté). Retirez cette fiche du dossier partagé (permissions du " +
          "dossier) avant de réessayer de partager cet espace."
        );
      }
      // (a) : collision légitime, déjà publiée — no-op, on continue vers la
      // vérification finale (`openOrgEngine`).
    }
  }
  // plan.kind === "already-promoted" : rien à publier (write-once déjà en
  // place, owner déjà admis) — on rouvre simplement l'organisation existante.
  const engine = await openOrgEngine({ adapter, identity: id, consultantId });
  return {
    engine: withFolderName(engine, handle),
    adapter,
    manifest: engine.manifest,
    alreadyPromoted: plan.kind === "already-promoted",
    completedOwnerRecord: plan.kind === "complete-owner",
  };
}

/**
 * Rejoint une organisation sur `handle` via un code d'invitation (produit par
 * `invite`) : consomme l'invitation, publie la fiche membre du nouvel
 * arrivant, active le mode org pour ce navigateur. Renvoie
 * `{engine, adapter, manifest}`. Lève si le code/l'invitation est
 * invalide/expirée/révoquée/déjà consommée.
 */
async function joinOrg({ handle, invitation, consultantId, identity } = {}) {
  if (!handle) throw new Error("joinOrg: 'handle' requis (sélecteur de dossier déjà effectué).");
  const adapter = buildAdapter(handle);
  await adapter.connect();
  const id = identity || (await getOrCreateIdentity());
  const decoded = typeof invitation === "string" ? decodeInvitationCode(invitation) : invitation;
  const { memberRecord } = await acceptInvitation({ invitation: decoded, identity: id, consultantId });
  await writeMemberRecord(adapter, memberRecord);
  await persistOrgMode(handle);
  const engine = await openOrgEngine({ adapter, identity: id, consultantId });
  return { engine: withFolderName(engine, handle), adapter, manifest: engine.manifest };
}

/**
 * Ouvre (sans rien publier) une organisation déjà existante sur `handle`,
 * pour un membre déjà connu de ce dossier. Renvoie
 * `{engine, adapter, manifest, membership}`. Lève si l'identité locale n'est
 * pas (ou plus) membre.
 */
async function openOrg({ handle, consultantId, identity } = {}) {
  if (!handle) throw new Error("openOrg: 'handle' requis (sélecteur de dossier déjà effectué).");
  const adapter = buildAdapter(handle);
  await adapter.connect();
  const id = identity || (await getOrCreateIdentity());
  const engine = await openOrgEngine({ adapter, identity: id, consultantId });
  return { engine: withFolderName(engine, handle), adapter, manifest: engine.manifest, membership: engine.membership };
}

/**
 * Reprise au boot (symétrique de `piloteo-solo-bridge.mjs#resumeFolder`) :
 * restaure le dossier mémorisé et rouvre l'organisation pour l'identité
 * locale persistée. `null` si aucun dossier mémorisé ;
 * `{needsPermission:true}` si la permission doit être ré-accordée par un
 * geste utilisateur ; `{engine, adapter, manifest, membership, folderName}`
 * sinon.
 */
async function resumeOrg(opts) {
  const handle = await loadDirectoryHandle();
  if (!handle) return null;
  // `interactive:true` UNIQUEMENT depuis un geste utilisateur (bouton « Redonner
  // l'accès ») ; au boot on ne fait que QUERY — `requestPermission` hors geste
  // lève « User activation is required » (corrigé : plus d'exception au boot).
  const interactive = !!(opts && opts.interactive);
  const granted = await ensureHandlePermission(handle, "readwrite", interactive);
  if (!granted) return { needsPermission: true };
  const identity = await getOrCreateIdentity();
  const adapter = buildAdapter(handle);
  await adapter.connect();
  const engine = await openOrgEngine({ adapter, identity });
  return {
    engine: withFolderName(engine, handle),
    adapter,
    manifest: engine.manifest,
    membership: engine.membership,
    folderName: (handle && handle.name) || null,
  };
}

/**
 * Invite un futur membre (owner/admin uniquement — `inviteMember` lève sinon).
 * Ne publie RIEN sur le dossier (voir en-tête) : renvoie `{invitation, code}`,
 * `code` étant le JSON base64url à transmettre hors bande (copier-coller/lien).
 */
async function invite({ engine, adapter, role, ttlDays, identity } = {}) {
  if (!engine || !engine.manifest || !engine.membership) {
    throw new Error("invite: 'engine' invalide (openOrgEngine attendu).");
  }
  const id = identity || (await getOrCreateIdentity());
  const invitation = await inviteMember({
    workspaceId: engine.manifest.workspaceId,
    role: role || "user",
    issuer: { memberId: id.memberId },
    issuerMembership: engine.membership,
    signer: makeSigner(id),
    ttlMs: ttlDays ? ttlDays * 24 * 60 * 60 * 1000 : undefined,
  });
  return { invitation, code: encodeInvitationCode(invitation) };
}

/**
 * Révoque un membre (`memberId`) — écrit une fiche de révocation signée sur
 * le dossier (`org-folder-store.js#writeRevocation`). L'autorité de révocation
 * (owner révoque owner/admin/user ; admin révoque user seulement) est vérifiée
 * par `org-runtime.js#createRevocation`, qui lève si insuffisante — AUCUNE
 * fiche n'est publiée dans ce cas.
 */
async function revoke({ engine, adapter, memberId, identity } = {}) {
  if (!engine || !engine.manifest || !engine.membership) {
    throw new Error("revoke: 'engine' invalide (openOrgEngine attendu).");
  }
  if (!adapter) throw new Error("revoke: 'adapter' requis (pour publier la fiche de révocation).");
  const id = identity || (await getOrCreateIdentity());
  const members = await engine.members();
  const target = members.find((m) => m.memberId === memberId);
  if (!target) throw new Error(`revoke: membre '${memberId}' introuvable.`);
  const revocation = await createRevocation({
    workspaceId: engine.manifest.workspaceId,
    revokedMemberId: memberId,
    issuer: { memberId: id.memberId },
    issuerMembership: engine.membership,
    revokedRole: target.role,
    signer: makeSigner(id),
  });
  await writeRevocation(adapter, revocation);
  return revocation;
}

/** Liste les membres d'une organisation ouverte (`engine.members()`). */
async function listMembers(engine) {
  if (!engine || typeof engine.members !== "function") {
    throw new Error("listMembers: 'engine' invalide (openOrgEngine attendu).");
  }
  return engine.members();
}

// ---------------------------------------------------------------------------
// Hooks de TEST (docs/next/ORG_UI_CONTRACT.md §1) : permettent à un smoke e2e
// d'injecter un `FileSystemDirectoryHandle` factice en mémoire (comme
// `__engineFromHandle` de piloteo-solo-bridge.mjs) et de simuler plusieurs
// identités de membre dans le MÊME onglet, sans passer par le sélecteur natif
// (indisponible en pilotage automatisé) ni par l'identité persistée unique.
// ---------------------------------------------------------------------------

/** Ouvre directement un org engine sur `handle` (sans publier de fiche),
 *  comme `openOrg`, mais nommé explicitement comme hook de test pour matcher
 *  le contrat. `identity`/`consultantId` optionnels (défaut : identité
 *  persistée de ce navigateur). */
async function __openOrgEngineFromHandle(handle, { identity, consultantId } = {}) {
  const adapter = buildAdapter(handle);
  await adapter.connect();
  const id = identity || (await getOrCreateIdentity());
  const engine = await openOrgEngine({ adapter, identity: id, consultantId });
  return { engine: withFolderName(engine, handle), adapter, identity: id, manifest: engine.manifest, membership: engine.membership };
}

const __identityStore = {
  load: loadIdentity,
  save: saveIdentity,
  // Fabrique une identité FRAÎCHE sans la persister comme identité "courante"
  // de ce navigateur — pour simuler un second membre dans le même onglet
  // (chaque appel produit une identité distincte, cf. newMemberIdentity).
  create: newMemberIdentity,
};

window.PiloteoOrg = {
  hasFileSystemAccess: typeof globalThis.showDirectoryPicker === "function",
  pickDirectory,
  getOrCreateIdentity,
  createOrg,
  promoteToOrg,
  activateOrgStorageMode,
  joinOrg,
  openOrg,
  resumeOrg,
  invite,
  revoke,
  listMembers,
  forgetIdentity,
  __identityStore,
  __openOrgEngineFromHandle,
};
