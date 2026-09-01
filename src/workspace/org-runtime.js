// src/workspace/org-runtime.js
//
// Runtime « comptes & organisations » — docs/next/ORG_CONTRACT.md §3 (lot
// moteur, point 2) ET §5 (correctifs sécurité « chaîne de confiance », suite
// revue red team). Fonctions PURES qui composent les primitives déjà
// committées (`crypto/crypto-service.js`, `workspace/memberships.js`,
// `workspace/invitations.js`, `workspace/workspace.js`) pour : créer une
// identité de membre, créer une organisation (avec son manifeste de genèse),
// inviter (signé, avec vérification d'autorité), rejoindre (avec preuve de
// détention de clé), et reconstruire un `memberRegistry`/`MembershipStore`
// DE CONFIANCE (jamais naïf) à partir des « fiches membres » publiées.
//
// Décisions / hypothèses (à documenter, la mission demandant de signaler tout
// manque plutôt que de dupliquer une logique déjà committée ailleurs) :
//
// 1. AUCUNE E/S ni réseau ici : ce module ne fait que produire des objets
//    (workspace, manifest, membership, memberRecord, invitation) — leur
//    distribution réelle via le dossier/Drive du client est le lot 2c (hors
//    périmètre).
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
//    (lot 2c). Forme : `{ kind:"member", memberId, publicKeyJwk, membership,
//    authorization }`. `authorization` est soit `{genesis:true}` (le créateur
//    de l'organisation), soit `{invitation, joinProof}` (un membre qui a
//    rejoint via une invitation) — c'est la RACINE DE CONFIANCE ajoutée par
//    §5 : sans `authorization` vérifiable, une fiche n'est plus qu'une
//    auto-déclaration et `buildTrustedMembership` la rejette.
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
//    rejeté par `isValid`/`consume` en amont. Cette protection reste locale
//    (mémoire du process) — la protection AUTORITATIVE contre le rejeu d'une
//    invitation à travers plusieurs fiches publiées est celle de §5.4
//    (`buildTrustedMembership`, unicité de `invitationId`).
//
// 7. §5.2 — `canonicalPayload` (sérialisation déterministe des champs d'une
//    invitation) est déjà définie et utilisée par `invitations.js` pour
//    produire `proof` côté émetteur. `verifyInvitation` a besoin de
//    RECOMPOSER EXACTEMENT les mêmes octets côté vérificateur (elle n'a que la
//    clé PUBLIQUE de l'émetteur + l'invitation reçue). Plutôt que de dupliquer
//    cette sérialisation ici (risque de divergence silencieuse entre les deux
//    si l'une évolue sans l'autre), `canonicalPayload` a été EXPORTÉE depuis
//    `invitations.js` (déviation additive au contrat §3, signalée explicitement
//    comme demandé par la mission) et réimportée telle quelle ci-dessous.
//
// 8. §5.3 — le "joinProof" prouve que le détenteur de `publicKeyJwk` a bien
//    consommé CETTE invitation avec CETTE clé (anti-substitution de clé après
//    coup). Ses octets canoniques (`invitationId, memberId, publicKeyJwk`)
//    sont une sérialisation déterministe LOCALE à ce module (aucune primitive
//    existante ne la fournissait) — `joinCanonicalPayload` ci-dessous,
//    utilisée à l'identique en signature (`acceptInvitation`) et en
//    vérification (`buildTrustedMembership`).

import * as cryptoService from "../crypto/crypto-service.js";
import { createMembership, MembershipStore } from "./memberships.js";
import { createInvitation, isValid, consume, canonicalPayload as invitationCanonicalPayload } from "./invitations.js";
import { createTeamWorkspace } from "./workspace.js";

function nowIso() {
  return new Date().toISOString();
}

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
 * Crée une organisation : le créateur (`identity`) en est le OWNER. Produit
 * AUSSI le `manifest` de genèse (§5.1) — racine de confiance immuable
 * (write-once côté dossier, lot 2c) qui ancre TOUTE vérification ultérieure
 * (`verifyInvitation`, `buildTrustedMembership`) sur la clé publique réelle du
 * créateur, indépendamment de ce que prétendrait une fiche membre forgée.
 * @param {{name:string, identity:{memberId:string, publicKeyJwk:object}, consultantId:string}} params
 * @returns {{workspace:{workspaceId:string,name:string,schemaVersion:number}, manifest:object, ownerMembership:object, memberRecord:object}}
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

  const manifest = {
    workspaceId: ws.id,
    ownerMemberId: identity.memberId,
    ownerPublicKeyJwk: identity.publicKeyJwk,
    createdAt: nowIso(),
  };

  const memberRecord = {
    kind: "member",
    memberId: identity.memberId,
    publicKeyJwk: identity.publicKeyJwk,
    membership: ownerMembership,
    authorization: { genesis: true },
  };

  return {
    workspace: { workspaceId: ws.id, name: ws.name, schemaVersion: ws.schemaVersion },
    manifest,
    ownerMembership,
    memberRecord,
  };
}

// ---------------------------------------------------------------------------
// Invitations — §5.2 : signées, autorité de l'émetteur vérifiée à l'émission
// ---------------------------------------------------------------------------

/**
 * Invite un futur membre (réutilise `invitations.js#createInvitation`).
 * §5.2 : EXIGE un `signer` réel (jamais le repli "empreinte SHA-256" par
 * défaut d'`invitations.js`, qui n'authentifie personne) et VÉRIFIE que
 * l'émetteur a l'autorité d'inviter avant de produire quoi que ce soit :
 * `issuerMembership.role` doit être `owner` ou `admin` et `status:"active"` ;
 * `role:"owner"` est réservé à un émetteur `owner`. Toute violation lève
 * AVANT tout appel à `createInvitation` (aucune invitation n'est produite).
 * @param {{workspaceId:string, role?:"owner"|"admin"|"user", expectedGoogleId?:string|null,
 *          issuer:{memberId:string}, issuerMembership:object, signer:Function, ttlMs?:number}} params
 * @returns {Promise<object>} invitation, avec `issuerId` en plus (§5.2)
 */
export async function inviteMember({
  workspaceId,
  role = "user",
  expectedGoogleId = null,
  issuer,
  issuerMembership,
  signer,
  ttlMs,
} = {}) {
  if (!workspaceId) throw new Error("inviteMember: 'workspaceId' requis");
  if (typeof signer !== "function") {
    throw new Error(
      "inviteMember: 'signer' réel requis (Ed25519 de l'émetteur) — le repli non-authentifiant d'invitations.js est interdit ici (§5.2)"
    );
  }
  if (!issuer || !issuer.memberId) {
    throw new Error("inviteMember: 'issuer' invalide ('memberId' requis)");
  }
  if (!issuerMembership || issuerMembership.memberId !== issuer.memberId) {
    throw new Error("inviteMember: 'issuerMembership' invalide ou ne correspond pas à 'issuer'");
  }
  if (issuerMembership.workspaceId !== workspaceId) {
    throw new Error("inviteMember: 'issuerMembership' n'appartient pas à ce workspace");
  }
  if (issuerMembership.status !== "active") {
    throw new Error("inviteMember: émetteur non actif (révoqué) — aucune autorité pour inviter");
  }
  if (issuerMembership.role !== "owner" && issuerMembership.role !== "admin") {
    throw new Error("inviteMember: émetteur sans autorité (rôle 'owner' ou 'admin' actif requis)");
  }
  if (role === "owner" && issuerMembership.role !== "owner") {
    throw new Error("inviteMember: le rôle 'owner' ne peut être délégué que par un émetteur 'owner'");
  }

  // ORG_REVOCATION_CONTRACT.md §3 : `issuerId` est désormais passé à
  // `createInvitation` pour qu'il fasse PARTIE des octets signés (le binding
  // émetteur↔proof est structurel, pas seulement une conséquence de la
  // logique de `verifyInvitation`) — toute modification d'`issuerId` après
  // signature invalide donc le proof.
  const invitation = await createInvitation({ workspaceId, expectedGoogleId, role, ttlMs, signer, issuerId: issuer.memberId });
  return invitation;
}

/**
 * §5.2 — Vérifie qu'une invitation a réellement été émise, avec autorité, par
 * `invitation.issuerId` : retrouve sa clé publique + son rôle/statut via le
 * `registry` DÉJÀ VÉRIFIÉ (jamais une fiche brute non vérifiée), vérifie
 * `crypto.verify(issuerPubKey, canonicalBytes(invitation), invitation.proof)`
 * ET que l'émetteur a (encore, au moment de la vérification) l'autorité pour
 * le rôle porté par l'invitation. Ne lève jamais : renvoie `{ok:false, reason}`.
 * @param {object} invitation
 * @param {{registry:{getPublicKey:Function, getMembership?:Function}}} params
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function verifyInvitation(invitation, { registry } = {}) {
  if (!invitation || !invitation.issuerId || !invitation.proof) {
    return { ok: false, reason: "invitation incomplète (issuerId/proof manquant)" };
  }
  if (!registry || typeof registry.getPublicKey !== "function") {
    return { ok: false, reason: "registry invalide (getPublicKey requis)" };
  }
  const issuerPublicKey = registry.getPublicKey(invitation.issuerId);
  if (!issuerPublicKey) {
    return { ok: false, reason: `émetteur inconnu de l'ensemble de confiance (${invitation.issuerId})` };
  }
  const issuerMembership =
    typeof registry.getMembership === "function" ? registry.getMembership(invitation.issuerId) : null;
  if (!issuerMembership || issuerMembership.status !== "active") {
    return { ok: false, reason: "émetteur non actif (révoqué ou inconnu) — aucune autorité" };
  }
  if (issuerMembership.role !== "owner" && issuerMembership.role !== "admin") {
    return { ok: false, reason: "émetteur sans autorité (rôle 'owner' ou 'admin' requis)" };
  }
  if (invitation.role === "owner" && issuerMembership.role !== "owner") {
    return { ok: false, reason: "rôle 'owner' réservé à un émetteur 'owner'" };
  }

  const canonical = invitationCanonicalPayload({
    workspaceId: invitation.workspaceId,
    invitationId: invitation.invitationId,
    expectedGoogleId: invitation.expectedGoogleId,
    role: invitation.role,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    nonce: invitation.nonce,
    // §3 : recompose EXACTEMENT les mêmes octets côté vérificateur, avec
    // l'issuerId ANNONCÉ par l'invitation — si celui-ci a été modifié après
    // signature (ex: pour usurper un autre émetteur), les octets recomposés
    // divergent de ceux signés et la vérification échoue plus bas.
    issuerId: invitation.issuerId,
  });
  const bytes = new TextEncoder().encode(canonical);
  let sigOk = false;
  try {
    sigOk = await cryptoService.verify(issuerPublicKey, bytes, invitation.proof);
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return { ok: false, reason: "proof invalide (signature de l'émetteur incorrecte)" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Rejoindre — §5.3 : fiche membre adossée à l'invitation + preuve du porteur
// ---------------------------------------------------------------------------

/** §5.3/8 — octets canoniques du joinProof : sérialisation déterministe LOCALE (voir décision 8). */
function joinCanonicalPayload(invitationId, memberId, publicKeyJwk) {
  return JSON.stringify([invitationId, memberId, publicKeyJwk]);
}

/**
 * Rejoint une organisation via une invitation : valide (`isValid`), consomme
 * (`consume`, avec vérification de l'identité Google attendue le cas
 * échéant), et fabrique la fiche membre du nouvel arrivant avec le RÔLE porté
 * par l'invitation. §5.3 : la fiche porte `authorization:{invitation,
 * joinProof}` où `joinProof` prouve que LE DÉTENTEUR de `identity.privateKeyRef`
 * (donc de `identity.publicKeyJwk`) a bien consommé CETTE invitation — sans
 * cela, un attaquant pourrait rejouer une invitation valide avec SA PROPRE clé
 * publique pour usurper le rôle qu'elle porte.
 * Lève si l'invitation est invalide/expirée/révoquée/déjà consommée, ou si
 * l'identité Google ne correspond pas.
 * @param {{invitation:object, identity:{memberId:string, publicKeyJwk:object, privateKeyRef:object}, consultantId:string, googleId?:string|null}} params
 * @returns {Promise<{membership:object, memberRecord:object, invitation:object}>}
 */
export async function acceptInvitation({ invitation, identity, consultantId, googleId = null } = {}) {
  if (!identity || !identity.memberId || !identity.publicKeyJwk || !identity.privateKeyRef) {
    throw new Error("acceptInvitation: 'identity' invalide (newMemberIdentity() attendu, avec privateKeyRef)");
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

  const joinBytes = new TextEncoder().encode(
    joinCanonicalPayload(consumedInvitation.invitationId, identity.memberId, identity.publicKeyJwk)
  );
  const joinProof = await cryptoService.sign(identity.privateKeyRef, joinBytes);

  const memberRecord = {
    kind: "member",
    memberId: identity.memberId,
    publicKeyJwk: identity.publicKeyJwk,
    membership,
    authorization: { invitation: consumedInvitation, joinProof },
  };

  return { membership, memberRecord, invitation: consumedInvitation };
}

// ---------------------------------------------------------------------------
// Révocation signée — docs/next/ORG_REVOCATION_CONTRACT.md §1
//
// Une fiche `{kind:"revocation", workspaceId, revokedMemberId, revokedAt,
// issuerId, proof}` publiable, dont `proof` couvre exactement les mêmes
// champs (sérialisation déterministe `revocationCanonicalPayload`), signée
// par l'émetteur. Autorité de révocation (contrat §1/vigilance) : `owner`
// peut révoquer `owner`/`admin`/`user` ; `admin` peut révoquer un `user`
// SEULEMENT (jamais un `owner` ni un autre `admin`) ; `user` ne révoque
// personne. Cette règle est centralisée ici (`canRevokeRole`) et réutilisée
// identiquement à l'émission (`createRevocation`) et à la vérification
// (`verifyRevocation`) pour éviter toute divergence entre les deux.
// ---------------------------------------------------------------------------

/** Rang d'autorité de révocation : `issuerRole` doit être suffisant pour
 *  révoquer un membre de rôle `revokedRole`. */
function canRevokeRole(issuerRole, revokedRole) {
  if (issuerRole === "owner") return revokedRole === "owner" || revokedRole === "admin" || revokedRole === "user";
  if (issuerRole === "admin") return revokedRole === "user";
  return false; // 'user' (ou rôle inconnu) : aucune autorité de révocation.
}

/** §1 — octets canoniques d'une fiche de révocation (même style que
 *  `invitations.js#canonicalPayload`) : sérialisation déterministe, ordre de
 *  champs fixe. */
export function revocationCanonicalPayload({ workspaceId, revokedMemberId, revokedAt, issuerId }) {
  return JSON.stringify([workspaceId, revokedMemberId, revokedAt, issuerId]);
}

/**
 * Crée une fiche de révocation signée. EXIGE un `signer` réel + une autorité
 * suffisante de `issuerMembership.role` sur `revokedRole` (voir
 * `canRevokeRole`) — sinon lève AVANT toute production de fiche (aucune
 * révocation n'est émise pour une autorité insuffisante).
 * @param {{workspaceId:string, revokedMemberId:string, issuer:{memberId:string},
 *          issuerMembership:object, revokedRole:"owner"|"admin"|"user",
 *          signer:Function, now?:Date}} params
 * @returns {Promise<object>} fiche de révocation `{kind:"revocation", workspaceId, revokedMemberId, revokedAt, issuerId, proof}`
 */
export async function createRevocation({
  workspaceId,
  revokedMemberId,
  issuer,
  issuerMembership,
  revokedRole,
  signer,
  now = new Date(),
} = {}) {
  if (!workspaceId) throw new Error("createRevocation: 'workspaceId' requis");
  if (!revokedMemberId) throw new Error("createRevocation: 'revokedMemberId' requis");
  if (typeof signer !== "function") {
    throw new Error("createRevocation: 'signer' réel requis (Ed25519 de l'émetteur)");
  }
  if (!issuer || !issuer.memberId) {
    throw new Error("createRevocation: 'issuer' invalide ('memberId' requis)");
  }
  if (!issuerMembership || issuerMembership.memberId !== issuer.memberId) {
    throw new Error("createRevocation: 'issuerMembership' invalide ou ne correspond pas à 'issuer'");
  }
  if (issuerMembership.workspaceId !== workspaceId) {
    throw new Error("createRevocation: 'issuerMembership' n'appartient pas à ce workspace");
  }
  if (issuerMembership.status !== "active") {
    throw new Error("createRevocation: émetteur non actif (révoqué) — aucune autorité pour révoquer");
  }
  if (!["owner", "admin", "user"].includes(revokedRole)) {
    throw new Error(`createRevocation: 'revokedRole' invalide '${revokedRole}'`);
  }
  if (!canRevokeRole(issuerMembership.role, revokedRole)) {
    throw new Error(
      "createRevocation: émetteur sans autorité suffisante (owner révoque owner/admin/user ; admin révoque user seulement)"
    );
  }

  const revokedAt = new Date(now).toISOString();
  const canonical = revocationCanonicalPayload({
    workspaceId,
    revokedMemberId,
    revokedAt,
    issuerId: issuer.memberId,
  });
  const proof = await signer(new TextEncoder().encode(canonical));

  // DÉVIATION (lot 2c-B, docs/next/ORG_FOLDER_CONTRACT.md §2) : `revocationId`
  // (UUID) est ajouté ICI, APRÈS le calcul de `proof` — donc explicitement HORS
  // des octets signés (`revocationCanonicalPayload` ne le contient pas et n'est
  // pas modifiée). Il ne sert qu'à l'ADRESSAGE FICHIER côté dossier
  // (`org-folder-store.js#writeRevocation` : id de blob
  // `"revocation-"+revocationId`) — jamais à la vérification de confiance
  // (`verifyRevocation`/`buildTrustedMembership` ne le lisent jamais). Comme il
  // n'entre pas dans le proof, l'ajouter ne change ni la valeur de `proof`, ni
  // aucun test existant sur la révocation (§1/§2bis).
  return {
    kind: "revocation",
    revocationId: globalThis.crypto.randomUUID(),
    workspaceId,
    revokedMemberId,
    revokedAt,
    issuerId: issuer.memberId,
    proof,
  };
}

/**
 * Vérifie une fiche de révocation : `crypto.verify` de `proof` avec la clé
 * publique de `revocation.issuerId` retrouvée via `registry` (DÉJÀ vérifié —
 * jamais une fiche brute), ET que l'émetteur a le rang d'autorité suffisant
 * pour révoquer le rôle (dans ce `registry`) du membre visé. Ne lève jamais :
 * renvoie `{ok:false, reason}`.
 *
 * ORG_REVOCATION_CONTRACT.md §2bis : cette fonction ne vérifie PLUS
 * `issuerMembership.status === "active"` — sur le registre CANDIDAT passé
 * par `buildTrustedMembership` (passe 2), ce statut est figé AVANT
 * application des révocations et lire "active" ici ne prouve rien (c'était
 * la faille 5c : code mort qui laissait un émetteur déjà révoqué émettre de
 * nouvelles révocations). Le contrôle "émetteur non révoqué" est désormais
 * assuré STRUCTURELLEMENT par `buildTrustedMembership` (passe 2, via son
 * `revokedSet` qui grandit de façon monotone et est reconsulté à CHAQUE
 * révocation évaluée) — jamais par un champ de statut figé lu ici.
 * @param {object} revocation
 * @param {{registry:{getPublicKey:Function, getMembership:Function}}} params
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function verifyRevocation(revocation, { registry } = {}) {
  if (!revocation || revocation.kind !== "revocation") {
    return { ok: false, reason: "fiche de révocation invalide (kind manquant)" };
  }
  if (!revocation.workspaceId || !revocation.revokedMemberId || !revocation.revokedAt || !revocation.issuerId || !revocation.proof) {
    return { ok: false, reason: "fiche de révocation incomplète" };
  }
  if (!registry || typeof registry.getPublicKey !== "function" || typeof registry.getMembership !== "function") {
    return { ok: false, reason: "registry invalide (getPublicKey/getMembership requis)" };
  }
  const issuerPublicKey = registry.getPublicKey(revocation.issuerId);
  if (!issuerPublicKey) {
    return { ok: false, reason: `émetteur inconnu de l'ensemble de confiance (${revocation.issuerId})` };
  }
  const issuerMembership = registry.getMembership(revocation.issuerId);
  if (!issuerMembership) {
    return { ok: false, reason: "émetteur inconnu de l'ensemble de confiance — aucune autorité" };
  }
  const revokedMembership = registry.getMembership(revocation.revokedMemberId);
  if (!revokedMembership) {
    return { ok: false, reason: `membre à révoquer inconnu de l'ensemble de confiance (${revocation.revokedMemberId})` };
  }
  if (!canRevokeRole(issuerMembership.role, revokedMembership.role)) {
    return {
      ok: false,
      reason: "émetteur sans autorité suffisante (owner révoque owner/admin/user ; admin révoque user seulement)",
    };
  }

  const canonical = revocationCanonicalPayload({
    workspaceId: revocation.workspaceId,
    revokedMemberId: revocation.revokedMemberId,
    revokedAt: revocation.revokedAt,
    issuerId: revocation.issuerId,
  });
  const bytes = new TextEncoder().encode(canonical);
  let sigOk = false;
  try {
    sigOk = await cryptoService.verify(issuerPublicKey, bytes, revocation.proof);
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return { ok: false, reason: "proof invalide (signature de l'émetteur incorrecte)" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// §5.4 — Construction VÉRIFIÉE du registre/store (remplace les anciens
// `buildMemberRegistry`/`buildMembershipStore` naïfs, SUPPRIMÉS : plus aucune
// API publique de ce module ne construit de registre à partir de fiches non
// vérifiées).
// ---------------------------------------------------------------------------

function deepEqualJson(a, b) {
  // Comparaison suffisante ici : publicKeyJwk est un objet JSON "plat" issu
  // d'un seul export WebCrypto (pas de fonctions/cycles/Map/Set à comparer).
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Registre de confiance interne — expose l'interface `getPublicKey` attendue
 *  par `SyncEngine` (décision 1 de sync-engine.js) EN PLUS de `getMembership`,
 *  utile à `verifyInvitation` pour vérifier l'autorité d'un émetteur DÉJÀ
 *  admis dans l'ensemble de confiance. Un consommateur qui n'utilise que
 *  `getPublicKey` (SyncEngine) n'est pas gêné par cette méthode additionnelle. */
function createTrustRegistry() {
  const byId = new Map(); // memberId -> {publicKeyJwk, role, status}
  return {
    _add(memberId, publicKeyJwk, role, status) {
      byId.set(memberId, { publicKeyJwk, role, status });
    },
    getPublicKey(memberId) {
      const entry = byId.get(memberId);
      return entry ? entry.publicKeyJwk : null;
    },
    getMembership(memberId) {
      const entry = byId.get(memberId);
      return entry ? { role: entry.role, status: entry.status } : null;
    },
  };
}

/** §5.1 — une fiche prétendant à la genèse n'est admise QUE si elle correspond
 *  EXACTEMENT au manifeste (clé publique, rôle, workspace, memberId) : sa
 *  simple présence dans le flux ne fait jamais foi à elle seule. */
function genesisMismatchReason(record, manifest) {
  if (!record.authorization || record.authorization.genesis !== true) {
    return "fiche prétendant à la genèse sans authorization.genesis:true";
  }
  if (!deepEqualJson(record.publicKeyJwk, manifest.ownerPublicKeyJwk)) {
    return "clé publique ne correspond pas à celle du manifeste (genèse forgée)";
  }
  if (!record.membership || record.membership.role !== "owner") {
    return "le membership de la fiche genèse doit porter le rôle 'owner'";
  }
  if (record.membership.workspaceId !== manifest.workspaceId) {
    return "workspace de la fiche genèse ne correspond pas au manifeste";
  }
  if (record.membership.memberId !== manifest.ownerMemberId) {
    return "memberId du membership ne correspond pas au manifeste";
  }
  return null;
}

function isCandidateShape(record) {
  return !!(
    record &&
    record.memberId &&
    record.publicKeyJwk &&
    record.membership &&
    record.authorization &&
    record.authorization.invitation &&
    record.authorization.joinProof
  );
}

/**
 * §5.4 — Reconstruit le `memberRegistry`/`MembershipStore` attendus par
 * `SyncEngine`, en ne faisant JAMAIS confiance à une fiche membre pour
 * elle-même : amorce l'ensemble de confiance avec la GENÈSE du `manifest`
 * (racine incontestable), puis admet chaque fiche restante par point fixe
 * (BFS) SEULEMENT si : `joinProof` valide, `invitation` valide via
 * `verifyInvitation` (émetteur DÉJÀ dans l'ensemble de confiance ET autorisé
 * pour ce rôle), rôle du membership == rôle de l'invitation, workspace ==
 * `manifest.workspaceId`, `memberId` pas déjà admis (pas de redéfinition), et
 * `invitationId` pas déjà utilisé (anti-rejeu). Toute fiche refusée est
 * JOURNALISÉE dans `rejected` (jamais ignorée en silence).
 *
 * ORG_REVOCATION_CONTRACT.md §2bis (CORRECTIF SÉCURITÉ, remplace tout le §2
 * horodaté) — un membre révoqué a une autorité NULLE, immédiatement : AUCUNE
 * fiche (invitation OU révocation) dont il est l'émetteur n'est admise,
 * quelle que soit la date qu'il déclare. `createdAt`/`revokedAt` ne sont
 * JAMAIS comparés entre eux (un membre révoqué contrôle et signe ces deux
 * champs — les comparer serait forgeable par la personne même que la
 * comparaison est censée contraindre : c'était la faille 1, backdating
 * d'invitation). Étendu en 3 passes :
 *
 * (1) l'algorithme ci-dessus (INCHANGÉ) établit un ensemble de confiance
 *     CANDIDAT (clés/rôles/lignée), sans tenir compte des révocations — sert
 *     uniquement à connaître les clés/rôles candidats pour la passe 2.
 *
 * (2) point fixe des révocations : `revokedSet` (memberId -> {revokedBy,
 *     revokedAt}) croît de façon MONOTONE (jamais retiré). Une révocation
 *     n'est appliquée QUE si, au moment où elle est tranchée : son proof est
 *     valide, son émetteur est dans l'ensemble candidat avec un rang
 *     suffisant (`verifyRevocation`, qui ne consulte plus aucun statut figé
 *     — faille 5c), ET son émetteur n'est PAS (encore) dans `revokedSet` à
 *     cet instant. Pour ne jamais dépendre de l'ordre d'arrivée du tableau
 *     `revocations` (une révocation légitime émise par quelqu'un lui-même
 *     révoqué par ailleurs ne doit JAMAIS s'appliquer, même si sa propre
 *     révocation n'est évaluée qu'ensuite dans le tableau), l'évaluation se
 *     fait par VAGUES : à chaque vague, une révocation dont l'émetteur est
 *     encore la cible d'une AUTRE révocation pas encore tranchée est
 *     REPORTÉE (son sort en dépend) ; seules les révocations dont l'émetteur
 *     est déjà stable (confirmé révoqué, ou plus visé par aucune révocation
 *     en attente) sont tranchées. Ce mécanisme résout tout enchaînement
 *     acyclique (A révoque B qui avait révoqué C) de façon déterministe
 *     QUELLE QUE SOIT l'ordre d'entrée. S'il reste des révocations non
 *     tranchées une fois le point fixe atteint (un vrai CYCLE — ex.
 *     révocation mutuelle A<->B), elles sont tranchées par un ordre total
 *     déterministe et reproductible (tri `[revokedMemberId, issuerId]`
 *     croissant) : la cible dont le `memberId` est lexicographiquement le
 *     plus PETIT est révoquée en premier (avec un `revokedSet` encore vide à
 *     cet instant), ce qui invalide ensuite la révocation adverse (son
 *     émetteur vient d'être ajouté à `revokedSet`) — choix arbitraire mais
 *     STABLE, documenté ici (aucune horloge de confiance ne permet de
 *     trancher "qui a réellement agi en premier"). Une révocation jamais
 *     applicable (émetteur non autorisé/inconnu/lui-même révoqué, proof
 *     invalide) va dans `rejected`.
 *
 * (3) ensemble de confiance FINAL : re-parcourt `candidateTrusted` depuis la
 *     genèse (son ordre garantit que l'émetteur de chaque fiche y apparaît
 *     AVANT elle) ; un membre n'est admis QUE si son émetteur d'invitation
 *     est dans l'ensemble de confiance final ET n'est PAS dans `revokedSet`
 *     — récursivement, via `chainValid` : la chaîne ENTIÈRE jusqu'à la
 *     genèse ne doit traverser AUCUN émetteur révoqué. AUCUNE comparaison de
 *     date. Le membre révoqué lui-même reste dans `membershipStore`/
 *     `registry` avec `status:"revoked"` (pour que `SyncEngine` bloque ses
 *     événements) mais n'est plus jamais un émetteur valide pour quiconque
 *     il aurait invité (conséquence assumée par le contrat : les invités
 *     d'un membre révoqué perdent leur ancre de confiance et doivent être
 *     ré-invités par une autorité encore valide).
 * @param {{manifest:object, memberRecords?:Array<object>, revocations?:Array<object>}} params
 * @returns {Promise<{registry:object, membershipStore:import("./memberships.js").MembershipStore, trusted:Array<object>, revoked:Array<{memberId:string, revokedAt:string, revokedBy:string}>, rejected:Array<{record:object, reason:string}>}>}
 */
export async function buildTrustedMembership({ manifest, memberRecords = [], revocations = [] } = {}) {
  if (!manifest || !manifest.workspaceId || !manifest.ownerMemberId || !manifest.ownerPublicKeyJwk) {
    throw new Error("buildTrustedMembership: 'manifest' invalide (genèse {workspaceId, ownerMemberId, ownerPublicKeyJwk} requise)");
  }

  // ===========================================================================
  // PASSE 1 — arbre de confiance des fiches (BFS existant, INCHANGÉ). Produit
  // un registre CANDIDAT (`candidateRegistry`) et l'ordre d'admission
  // (`candidateTrusted`, genèse en tête, puis chaque fiche après son
  // émetteur — invariant utilisé tel quel par la passe 3 plus bas). Les
  // révocations ne sont PAS encore prises en compte ici.
  // ===========================================================================

  const candidateRegistry = createTrustRegistry();
  const candidateTrusted = [];
  const rejected = [];
  const admittedMemberIds = new Set();
  const usedInvitationIds = new Set();

  // 1. Racine de confiance : la clé/le rôle de l'owner sont pinnés directement
  //    depuis le MANIFESTE (write-once, lot 2c) — jamais depuis une fiche
  //    publiée, qui pourrait être absente, dupliquée ou forgée.
  candidateRegistry._add(manifest.ownerMemberId, manifest.ownerPublicKeyJwk, "owner", "active");
  admittedMemberIds.add(manifest.ownerMemberId);

  // 2. Fiche membre genèse (si publiée) : admise seulement si elle correspond
  //    EXACTEMENT au manifeste. Toute autre fiche portant le même memberId
  //    (genèse dupliquée/forgée) est rejetée pour collision, comme n'importe
  //    quelle collision de memberId (cf. boucle 3).
  let genesisAdmitted = false;
  for (const record of memberRecords) {
    if (!record || record.memberId !== manifest.ownerMemberId) continue;
    if (genesisAdmitted) {
      rejected.push({ record, reason: "memberId déjà admis (genèse dupliquée, pas de redéfinition)" });
      continue;
    }
    const reason = genesisMismatchReason(record, manifest);
    if (reason) {
      rejected.push({ record, reason });
      continue;
    }
    candidateTrusted.push(record);
    genesisAdmitted = true;
  }

  // 3. Point fixe (BFS) sur les fiches restantes, adossées à une invitation.
  //    Une fiche dont l'émetteur n'est pas ENCORE dans l'ensemble de confiance
  //    est réessayée au prochain passage (l'émetteur peut être admis entre
  //    temps) ; toute autre raison de rejet est définitive.
  let pending = memberRecords.filter((r) => r && r.memberId !== manifest.ownerMemberId);
  const lastReason = new Map();

  async function evaluate(record) {
    if (!isCandidateShape(record)) {
      return { verdict: "reject", reason: "fiche membre mal formée (memberId/publicKeyJwk/membership/authorization.invitation+joinProof requis)" };
    }
    if (admittedMemberIds.has(record.memberId)) {
      return { verdict: "reject", reason: "memberId déjà admis (pas de redéfinition — collision de rôle refusée)" };
    }
    const { invitation, joinProof } = record.authorization;
    if (invitation.workspaceId !== manifest.workspaceId) {
      return { verdict: "reject", reason: "invitation référence un autre workspace que le manifeste" };
    }
    if (record.membership.role !== invitation.role) {
      return { verdict: "reject", reason: "le rôle du membership ne correspond pas au rôle porté par l'invitation" };
    }
    if (record.membership.workspaceId !== manifest.workspaceId) {
      return { verdict: "reject", reason: "membership référence un autre workspace que le manifeste" };
    }
    if (usedInvitationIds.has(invitation.invitationId)) {
      return { verdict: "reject", reason: "invitation déjà utilisée par une autre fiche (rejeu refusé)" };
    }
    const joinBytes = new TextEncoder().encode(
      joinCanonicalPayload(invitation.invitationId, record.memberId, record.publicKeyJwk)
    );
    let joinOk = false;
    try {
      joinOk = await cryptoService.verify(record.publicKeyJwk, joinBytes, joinProof);
    } catch {
      joinOk = false;
    }
    if (!joinOk) {
      return { verdict: "reject", reason: "joinProof invalide (clé substituée ou preuve falsifiée)" };
    }
    if (!candidateRegistry.getPublicKey(invitation.issuerId)) {
      return { verdict: "retry", reason: `émetteur (${invitation.issuerId}) pas encore dans l'ensemble de confiance` };
    }
    const invCheck = await verifyInvitation(invitation, { registry: candidateRegistry });
    if (!invCheck.ok) {
      return { verdict: "reject", reason: `invitation invalide : ${invCheck.reason}` };
    }
    return { verdict: "admit" };
  }

  let progressed = true;
  while (progressed && pending.length > 0) {
    progressed = false;
    const stillPending = [];
    for (const record of pending) {
      const outcome = await evaluate(record);
      if (outcome.verdict === "admit") {
        const { invitation } = record.authorization;
        candidateTrusted.push(record);
        candidateRegistry._add(record.memberId, record.publicKeyJwk, record.membership.role, record.membership.status);
        admittedMemberIds.add(record.memberId);
        usedInvitationIds.add(invitation.invitationId);
        progressed = true;
      } else if (outcome.verdict === "reject") {
        rejected.push({ record, reason: outcome.reason });
        progressed = true;
      } else {
        // retry : conservé pour le prochain passage.
        lastReason.set(record, outcome.reason);
        stillPending.push(record);
      }
    }
    pending = stillPending;
  }
  // Point fixe atteint : ce qui reste n'a jamais trouvé son émetteur dans
  // l'ensemble de confiance (chaîne rompue, émetteur inconnu ou lui-même
  // jamais admis) — rejeté, jamais ignoré en silence.
  for (const record of pending) {
    rejected.push({ record, reason: lastReason.get(record) || "émetteur jamais admis dans l'ensemble de confiance" });
  }

  // ===========================================================================
  // PASSE 2 — ORG_REVOCATION_CONTRACT.md §2bis : point fixe des révocations.
  // `revokedSet` (memberId -> {revokedBy, revokedAt}) croît de façon
  // MONOTONE. AUCUNE comparaison de date nulle part ici (faille 1 : un
  // membre révoqué contrôle et signe `createdAt`/`revokedAt`, comparer ces
  // champs serait forgeable par la personne même que ça devrait contraindre).
  //
  // Une révocation n'est appliquée QUE si, au moment où elle est TRANCHÉE :
  // proof valide + émetteur dans l'ensemble candidat + rang suffisant
  // (`verifyRevocation`, qui ne lit plus aucun statut figé — faille 5c), ET
  // émetteur PAS (encore) dans `revokedSet` à cet instant précis.
  //
  // Pour ne jamais dépendre de l'ordre d'arrivée du tableau `revocations`
  // (une révocation légitime émise par quelqu'un qui sera révoqué par
  // ailleurs ne doit JAMAIS s'appliquer, même si CETTE révocation-ci figure
  // avant celle qui le révoque dans le tableau d'entrée), l'évaluation se
  // fait par VAGUES : à chaque vague, une révocation dont l'émetteur est
  // encore la cible d'une AUTRE révocation pas encore tranchée est REPORTÉE
  // (son sort en dépend) ; seules les révocations dont l'émetteur est déjà
  // stable (confirmé révoqué, ou plus visé par aucune révocation en attente)
  // sont tranchées. Répété jusqu'à stabilité (plus aucune vague ne tranche
  // quoi que ce soit) : résout tout enchaînement ACYCLIQUE de façon
  // déterministe quel que soit l'ordre d'entrée.
  //
  // S'il reste des révocations non tranchées une fois le point fixe atteint
  // — un vrai CYCLE, ex. révocation mutuelle A<->B —, elles sont tranchées
  // dans un ordre total déterministe et REPRODUCTIBLE : tri par
  // `[revokedMemberId, issuerId]` croissant, puis un dernier passage dans CET
  // ordre. La cible dont le `memberId` est lexicographiquement le plus PETIT
  // est ainsi traitée en premier (avec un `revokedSet` encore vide pour elle
  // à cet instant) et gagne : elle est ajoutée à `revokedSet`, et son
  // émetteur (l'autre partie du duel) s'y retrouve donc déjà quand vient le
  // tour de la révocation adverse — qui échoue puisque son propre émetteur
  // est désormais révoqué. Choix arbitraire mais STABLE et documenté :
  // aucune horloge de confiance ne permet de trancher "qui a réellement agi
  // en premier" dans ce dossier.
  // ===========================================================================

  function revocationSortKey(r) {
    const target = (r && r.revokedMemberId) || "";
    const issuer = (r && r.issuerId) || "";
    return `${target} ${issuer}`;
  }
  const sortedRevocations = [...revocations].sort((a, b) => {
    const ka = revocationSortKey(a);
    const kb = revocationSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const revokedSet = new Map(); // memberId -> {revokedBy, revokedAt}
  const decided = new Set(); // indices de sortedRevocations déjà tranchés (appliqués OU rejetés)

  async function decide(revocation) {
    if (revokedSet.has(revocation && revocation.issuerId)) {
      rejected.push({
        record: revocation,
        reason: `révocation invalide : émetteur déjà révoqué (${revocation.issuerId}) — aucune autorité, quelle que soit la date déclarée`,
      });
      return;
    }
    const result = await verifyRevocation(revocation, { registry: candidateRegistry });
    if (!result.ok) {
      rejected.push({ record: revocation, reason: `révocation invalide : ${result.reason}` });
      return;
    }
    revokedSet.set(revocation.revokedMemberId, { revokedBy: revocation.issuerId, revokedAt: revocation.revokedAt });
  }

  // Vagues : tant qu'une vague complète tranche au moins une révocation, on
  // recommence (les révocations reportées peuvent devenir tranchables une
  // fois leur émetteur devenu stable).
  let progressedRevocations = true;
  while (progressedRevocations) {
    progressedRevocations = false;
    const pendingTargets = new Set(
      sortedRevocations.filter((_, i) => !decided.has(i)).map((r) => r && r.revokedMemberId)
    );
    for (let i = 0; i < sortedRevocations.length; i++) {
      if (decided.has(i)) continue;
      const revocation = sortedRevocations[i];
      const issuerId = revocation && revocation.issuerId;
      if (!revokedSet.has(issuerId) && pendingTargets.has(issuerId)) {
        // L'émetteur est lui-même visé par une révocation pas encore
        // tranchée : son sort n'est pas encore connu, on reporte.
        continue;
      }
      await decide(revocation);
      decided.add(i);
      progressedRevocations = true;
    }
  }
  // Point fixe atteint : ce qui reste est un vrai CYCLE (ex. révocation
  // mutuelle) — tranché dans l'ordre déterministe fixé par le tri ci-dessus.
  for (let i = 0; i < sortedRevocations.length; i++) {
    if (decided.has(i)) continue;
    await decide(sortedRevocations[i]);
    decided.add(i);
  }

  // ===========================================================================
  // PASSE 3 — ORG_REVOCATION_CONTRACT.md §2bis : ensemble de confiance FINAL.
  // `candidateTrusted` est déjà dans un ordre où l'émetteur de chaque fiche
  // apparaît AVANT elle (invariant de la BFS de la passe 1) — un seul
  // passage linéaire suffit donc pour propager la cascade. Un membre n'est
  // admis QUE si son émetteur d'invitation est dans l'ensemble de confiance
  // final ET n'est PAS dans `revokedSet` — récursivement, via `chainValid` :
  // AUCUNE comparaison de date nulle part.
  // ===========================================================================

  const registry = createTrustRegistry();
  const membershipStore = new MembershipStore();
  const trusted = [];
  const chainValid = new Map(); // memberId -> boolean (maillon intact jusqu'à la genèse)

  // Racine de confiance (comportement PRÉEXISTANT conservé) : le registre
  // FINAL expose TOUJOURS la clé/le rôle de l'owner via le seul manifeste,
  // que sa fiche "genèse" ait été publiée ou non (le manifeste suffit à
  // ancrer la vérification de signature) — seule sa présence dans
  // `trusted`/`membershipStore` dépend d'une fiche genèse effectivement
  // publiée et admise (boucle ci-dessous, qui réécrit alors ces mêmes
  // valeurs sans effet). La révocation de l'owner reste possible même sans
  // fiche genèse publiée : le manifeste seul suffit à l'identifier comme
  // cible/émetteur. La genèse elle-même n'est JAMAIS exclue de l'ensemble de
  // confiance final par sa propre révocation (sa fiche reste légitime, seul
  // son statut change) — seuls SES invités perdent leur ancre si elle est
  // révoquée (`chainValid`/`revokedSet` plus bas s'appliquent à eux).
  const ownerRevoked = revokedSet.has(manifest.ownerMemberId);
  registry._add(manifest.ownerMemberId, manifest.ownerPublicKeyJwk, "owner", ownerRevoked ? "revoked" : "active");
  chainValid.set(manifest.ownerMemberId, true);

  for (const record of candidateTrusted) {
    const isGenesis = record.memberId === manifest.ownerMemberId;
    let ok = true;
    let breakReason = null;

    if (!isGenesis) {
      const { invitation } = record.authorization;
      const issuerId = invitation.issuerId;
      if (!chainValid.get(issuerId)) {
        // L'émetteur lui-même a déjà été retiré de l'ensemble de confiance
        // final (son propre maillon était cassé) : cascade.
        ok = false;
        breakReason = `chaîne cassée (cascade) : l'émetteur (${issuerId}) est lui-même exclu de l'ensemble de confiance final`;
      } else if (revokedSet.has(issuerId)) {
        // §2bis : l'émetteur est révoqué -> autorité NULLE, quelle que soit
        // la date déclarée par l'invitation. Aucune exception "avant/après".
        ok = false;
        breakReason = `chaîne cassée : l'émetteur (${issuerId}) est révoqué — son autorité est nulle, quelle que soit la date déclarée par l'invitation`;
      }
    }

    chainValid.set(record.memberId, ok);
    if (!ok) {
      rejected.push({ record, reason: breakReason });
      continue;
    }

    trusted.push(record);
    // Le membre lui-même reste dans le store même s'il est révoqué : c'est
    // SA fiche qui reste légitime (chaîne intacte JUSQU'À lui), seul son
    // statut change — pour que `SyncEngine` bloque ses événements FUTURS
    // (docs/next/05 §9) sans jamais le faire disparaître silencieusement.
    const status = revokedSet.has(record.memberId) ? "revoked" : record.membership.status;
    registry._add(record.memberId, record.publicKeyJwk, record.membership.role, status);
    membershipStore.add({ ...record.membership, status });
  }

  // `revoked` : uniquement les révocations valides dont la CIBLE fait partie
  // de l'ensemble de confiance final (sa propre chaîne, jusqu'à ELLE, est
  // intacte) — une révocation valide visant un membre dont la fiche est par
  // ailleurs rejetée pour une autre raison n'a rien à révoquer. `revokedAt`
  // est conservé à titre INFORMATIF/traçabilité seulement — il n'entre plus
  // dans AUCUNE décision.
  const revoked = Array.from(revokedSet.entries())
    .filter(([memberId]) => chainValid.get(memberId) === true)
    .map(([memberId, info]) => ({ memberId, revokedAt: info.revokedAt, revokedBy: info.revokedBy }));

  return { registry, membershipStore, trusted, revoked, rejected };
}
