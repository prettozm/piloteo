// src/workspace/org-runtime.js
//
// Runtime « comptes & organisations » — docs/next/ORG_CONTRACT.md §3 (lot
// moteur, point 2). Fonctions PURES qui composent les primitives déjà
// committées (`crypto/crypto-service.js`, `workspace/memberships.js`,
// `workspace/invitations.js`, `workspace/workspace.js`) pour : créer une
// identité de membre, créer une organisation, inviter, rejoindre, et
// reconstruire le `memberRegistry`/`MembershipStore` que `sync/sync-engine.js`
// attend, à partir des « fiches membres » publiées.
//
// Décisions / hypothèses (à documenter, la mission demandant de signaler tout
// manque plutôt que de dupliquer une logique déjà committée ailleurs) :
//
// 1. AUCUNE E/S ni réseau ici : ce module ne fait que produire des objets
//    (workspace, membership, memberRecord, invitation) — leur distribution
//    réelle via le dossier/Drive du client est le lot 2c (hors périmètre).
//
// 2. `createOrganization` crée un workspace TEAM via
//    `workspace.js#createTeamWorkspace`, qui exige un `storage:{provider,...}`
//    non modélisé par ce lot (aucun connecteur réel n'est câblé ici). On lui
//    passe donc un storage PLACEHOLDER neutre (`{provider:"pending",
//    rootId:null}`) : le lot 2c le remplacera par le storage effectif au
//    moment de publier le workspace sur le dossier choisi par le client. Ce
//    placeholder ne fuit jamais hors de ce module de façon significative : le
//    champ `workspace` retourné par `createOrganization` n'expose QUE
//    `{workspaceId, name, schemaVersion}` (forme demandée par le contrat §3),
//    pas `storage`.
//
// 3. `memberRecord` = la « fiche membre » PUBLIABLE (kind:"member") qui
//    permettra aux AUTRES membres de vérifier signature (`publicKeyJwk`) et
//    rôle (`membership`) de ce membre, une fois distribuée sur le dossier
//    (lot 2c). Forme : `{ kind:"member", memberId, publicKeyJwk, membership }`.
//    C'est cette même forme que consomment `buildMemberRegistry` et
//    `buildMembershipStore` ci-dessous.
//
// 4. Rôles : ceux des primitives existantes — `owner`, `admin`, `user`
//    (`memberships.js#VALID_ROLES`). `owner` = gouvernance workspace (membres,
//    invitations) ; le `PolicyEngine` actuel (`core/permissions.js`) ne
//    connaît que `admin`/`user` pour les DROITS métier — `isAdmin()` y traite
//    déjà `owner` comme équivalent `admin` (voir permissions.js décision 5 /
//    ligne `isAdmin`). Ce module ne réimplémente donc RIEN de ce mapping, il
//    se contente de produire des memberships avec `role:"owner"` pour le
//    créateur, sans inventer de nouveau pouvoir métier.
//
// 5. Un « compte indépendant » (solo) = une identité de membre SANS
//    organisation : `newMemberIdentity()` seule, sans appeler
//    `createOrganization`. Ce module ne force donc jamais la création d'un
//    workspace.
//
// 6. `acceptInvitation` réutilise `invitations.js#isValid` PUIS `#consume`
//    (qui revérifie `isValid` en interne et vérifie en plus l'identité Google
//    attendue) : une invitation invalide, expirée, révoquée, déjà consommée,
//    ou dont l'identité Google ne correspond pas fait lever `consume` — cette
//    fonction ne capture jamais l'erreur, elle se propage telle quelle à
//    l'appelant (contrat §3 : "ou lève si invitation invalide/expirée/
//    révoquée/mauvaise identité"). `consume` est PURE (ne mute jamais
//    l'original, cf. invitations.js décision 4) : ce module n'a NI E/S ni
//    store d'invitations, donc il ne peut pas lui-même empêcher qu'une même
//    invitation en mémoire soit réutilisée sans l'aide de l'appelant. Par
//    conséquent, EN PLUS de `{membership, memberRecord}` (forme minimale du
//    contrat §3), `acceptInvitation` retourne aussi `invitation` (la version
//    "consumed") : c'est à l'appelant (store d'invitations du lot 2c) de la
//    persister pour qu'un second appel avec l'ancien objet "pending" soit
//    rejeté par `isValid`/`consume` en amont — déviation additive documentée,
//    qui n'entre pas en conflit avec la forme minimale attendue.
//
// 7. `buildMemberRegistry`/`buildMembershipStore` tolèrent une liste de fiches
//    membres contenant potentiellement d'autres `kind` que `"member"` (ex:
//    futurs kinds "key"/"license" distribués sur le même flux) : seules les
//    entrées reconnaissables comme fiche membre (`memberId` + `publicKeyJwk`
//    + `membership`) sont prises en compte, les autres sont silencieusement
//    ignorées plutôt que de faire planter la reconstruction du registre.

import * as cryptoService from "../crypto/crypto-service.js";
import { createMembership, MembershipStore } from "./memberships.js";
import { createInvitation, isValid, consume } from "./invitations.js";
import { createTeamWorkspace } from "./workspace.js";

// ---------------------------------------------------------------------------
// Identité de membre
// ---------------------------------------------------------------------------

/**
 * Crée une identité de membre (une personne sur un appareil) : un `memberId`
 * local (UUID) + une paire Ed25519 de signature (`crypto-service.js`).
 * @returns {Promise<{memberId:string, publicKeyJwk:object, privateKeyRef:object}>}
 */
export async function newMemberIdentity() {
  const memberId = globalThis.crypto.randomUUID();
  const { publicKeyJwk, privateKeyRef } = await cryptoService.generateMemberIdentity();
  return { memberId, publicKeyJwk, privateKeyRef };
}

// ---------------------------------------------------------------------------
// Organisation (workspace Team) — création
// ---------------------------------------------------------------------------

/** Storage placeholder neutre (décision 2) — le lot 2c le remplace au câblage réel. */
function pendingStorage() {
  return { provider: "pending", rootId: null };
}

/**
 * Crée une organisation : le créateur (`identity`) en est le OWNER.
 * @param {{name:string, identity:{memberId:string, publicKeyJwk:object}, consultantId:string}} params
 * @returns {{workspace:{workspaceId:string,name:string,schemaVersion:number}, ownerMembership:object, memberRecord:object}}
 */
export function createOrganization({ name, identity, consultantId } = {}) {
  if (!identity || !identity.memberId || !identity.publicKeyJwk) {
    throw new Error("createOrganization: 'identity' invalide (newMemberIdentity() attendu)");
  }
  const ws = createTeamWorkspace(name, pendingStorage());

  const ownerMembership = createMembership({
    workspaceId: ws.id,
    memberId: identity.memberId,
    consultantId,
    role: "owner",
  });

  const memberRecord = {
    kind: "member",
    memberId: identity.memberId,
    publicKeyJwk: identity.publicKeyJwk,
    membership: ownerMembership,
  };

  return {
    workspace: { workspaceId: ws.id, name: ws.name, schemaVersion: ws.schemaVersion },
    ownerMembership,
    memberRecord,
  };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/**
 * Invite un futur membre (réutilise `invitations.js#createInvitation`, signée
 * si `signer` est fourni — typiquement `(bytes) => crypto.sign(privateKeyRef, bytes)`
 * de l'émetteur).
 * @param {{workspaceId:string, role?:"owner"|"admin"|"user", expectedGoogleId?:string|null, signer?:Function|null, ttlMs?:number}} params
 * @returns {Promise<object>} invitation
 */
export async function inviteMember({
  workspaceId,
  role = "user",
  expectedGoogleId = null,
  signer = null,
  ttlMs,
} = {}) {
  return createInvitation({ workspaceId, expectedGoogleId, role, ttlMs, signer });
}

/**
 * Rejoint une organisation via une invitation : valide (`isValid`), consomme
 * (`consume`, avec vérification de l'identité Google attendue le cas
 * échéant), et fabrique la fiche membre du nouvel arrivant avec le RÔLE porté
 * par l'invitation. Lève si l'invitation est invalide/expirée/révoquée/déjà
 * consommée, ou si l'identité Google ne correspond pas.
 * @param {{invitation:object, identity:{memberId:string, publicKeyJwk:object}, consultantId:string, googleId?:string|null}} params
 * @returns {Promise<{membership:object, memberRecord:object, invitation:object}>}
 */
export async function acceptInvitation({ invitation, identity, consultantId, googleId = null } = {}) {
  if (!identity || !identity.memberId || !identity.publicKeyJwk) {
    throw new Error("acceptInvitation: 'identity' invalide (newMemberIdentity() attendu)");
  }
  if (!isValid(invitation)) {
    throw new Error("acceptInvitation: invitation invalide, expirée, révoquée ou déjà consommée");
  }
  // `consume` revérifie isValid et, en plus, l'identité Google attendue ;
  // elle lève si l'une de ces conditions échoue (décision 6).
  const consumedInvitation = consume(invitation, { googleId });

  const membership = createMembership({
    workspaceId: invitation.workspaceId,
    memberId: identity.memberId,
    consultantId,
    role: invitation.role,
    googleSubject: googleId,
  });

  const memberRecord = {
    kind: "member",
    memberId: identity.memberId,
    publicKeyJwk: identity.publicKeyJwk,
    membership,
  };

  return { membership, memberRecord, invitation: consumedInvitation };
}

// ---------------------------------------------------------------------------
// Reconstruction registry/store à partir des fiches membres publiées
// ---------------------------------------------------------------------------

function isMemberRecord(rec) {
  return !!rec && rec.memberId && rec.publicKeyJwk && rec.membership;
}

/**
 * Reconstruit le `memberRegistry` attendu par `SyncEngine` (décision 1 de
 * `sync-engine.js`) à partir d'une liste de fiches membres publiées.
 * @param {Array<object>} memberRecords
 * @returns {{getPublicKey:(memberId:string)=>object|null}}
 */
export function buildMemberRegistry(memberRecords = []) {
  const byId = new Map();
  for (const rec of memberRecords) {
    if (isMemberRecord(rec)) byId.set(rec.memberId, rec.publicKeyJwk);
  }
  return {
    getPublicKey(memberId) {
      return byId.get(memberId) ?? null;
    },
  };
}

/**
 * Reconstruit un `MembershipStore` (peuplé) attendu par `SyncEngine`, à
 * partir de la même liste de fiches membres publiées.
 * @param {Array<object>} memberRecords
 * @returns {import("./memberships.js").MembershipStore}
 */
export function buildMembershipStore(memberRecords = []) {
  const store = new MembershipStore();
  for (const rec of memberRecords) {
    if (isMemberRecord(rec)) store.add(rec.membership);
  }
  return store;
}
