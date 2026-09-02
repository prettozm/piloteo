// src/workspace/invitations.js
//
// Invitations — CONTRACTS §8, docs/next/01_CDC_LOCAL_FIRST.md §8,
// docs/next/05_SECURITE_CRYPTO_IDENTITE.md §7.
//
// invitation: { workspaceId, invitationId, expectedGoogleId, role, createdAt,
//               expiresAt, nonce, proof, status:"pending|consumed|revoked" }
//
// Décisions / hypothèses :
// 1. Aucun appel réseau ici (consigne explicite) et aucune dépendance vers
//    `crypto/crypto-service.js` (non livré dans ce lot) : `createInvitation`
//    accepte un `signer` **optionnel** — une fonction
//    `(bytes: Uint8Array) => Promise<string>` produite ailleurs par la vraie
//    identité cryptographique du membre émetteur (ex: `CryptoService.sign`).
//    Si aucun `signer` n'est fourni, `proof` retombe sur une empreinte SHA-256
//    (WebCrypto, `globalThis.crypto.subtle`) du contenu canonique de
//    l'invitation : ce n'est PAS une signature d'identité (n'importe qui peut
//    recalculer un hash de champs publics), mais ce n'est pas non plus une clé
//    réutilisable — c'est un scellé anti-altération minimal en attendant le
//    branchement du vrai CryptoService. Documenté comme dette explicite.
// 2. Le "code visible" (ce qui circule en lien/QR/texte) n'est jamais `proof`
//    seul seul ni une clé de workspace : c'est l'ensemble
//    `{workspaceId, invitationId, nonce}` (ou son encodage), insuffisant pour
//    déchiffrer quoi que ce soit sans l'enrôlement complet (validation de
//    l'identité Google attendue + distribution de clé d'epoch, hors de ce
//    module). `proof` sert à vérifier que l'invitation n'a pas été forgée /
//    altérée, jamais à déchiffrer le workspace.
// 3. `isValid` ne vérifie QUE l'expiration + le statut (`pending`) — c'est la
//    portée demandée. La vérification cryptographique de `proof` (via
//    `CryptoService.verify`) est déléguée à l'appelant / à un futur module,
//    car elle nécessite la clé publique de l'émetteur (non modélisée ici).
// 4. `consume` et `revoke` sont des transformations **pures** : elles renvoient
//    une nouvelle invitation (nouvel objet), ne mutent jamais l'original — la
//    persistance (marquer consommée/révoquée dans le store d'invitations)
//    appartient à l'appelant.

function uuid() {
  return globalThis.crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function toMs(dateLike) {
  const t = new Date(dateLike).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function randomNonce(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 =
    typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// EXPORTÉE (déviation additive, docs/next/ORG_CONTRACT.md §5.2) : org-runtime.js
// doit recomposer EXACTEMENT les mêmes octets canoniques pour vérifier
// `proof` via `crypto-service.verify` (elle n'a pas accès à la clé privée de
// l'émetteur, seulement à sa clé publique + l'invitation reçue) — plutôt que
// de dupliquer cette sérialisation (source de bug si les deux divergent un
// jour), on l'exporte telle quelle. Signalé au contrat comme acceptable.
export function canonicalPayload({ workspaceId, invitationId, expectedGoogleId, role, createdAt, expiresAt, nonce, issuerId, consultantId, scope }) {
  // Sérialisation déterministe (ordre de clés fixe) — pas de JSON.stringify
  // direct sur un objet dont l'ordre des clés serait accidentel.
  // docs/next/ORG_REVOCATION_CONTRACT.md §3 : `issuerId` est ajouté EN FIN de
  // tableau, et SEULEMENT s'il est fourni (!== undefined) — pour ne changer
  // NI les octets ni les tests existants quand issuerId est absent (défaut
  // rétro-compatible). Le binding émetteur↔proof devient ainsi structurel
  // (dans les octets signés) dès que l'appelant fournit issuerId.
  //
  // docs/next/ORG_TRUST_HARDENING_CONTRACT.md (round contrariant 4) : `consultantId`
  // est ajouté selon EXACTEMENT le même principe (append conditionnel,
  // `!== undefined`), APRÈS `issuerId` — sans lui, `consultantId` restait un
  // paramètre LIBRE de l'accepteur d'invitation (jamais couvert par une
  // signature), permettant à tout membre légitimement invité de déclarer le
  // `consultantId` d'un AUTRE consultant existant et de se faire traiter par
  // `core/permissions.js` comme lui (lecture ET écriture usurpées). Le signer
  // (l'émetteur, owner/admin) décide désormais explicitement à quel
  // consultant l'invitation est destinée ; `org-runtime.js#acceptInvitation`
  // n'utilise plus jamais un `consultantId` fourni librement par l'accepteur.
  //
  // docs/next/PARCOURS_IDENTITE_CONTRACT.md (Lot 3) : `scope` (marqueur
  // "utilisateur global") est ajouté selon EXACTEMENT le même principe (append
  // conditionnel, `!== undefined`), APRÈS `consultantId` — c'est le SEUL moyen
  // pour un `role:"user"` d'obtenir l'accès métier complet (sans restriction
  // de `consultantId`) : sans être couvert par la signature, n'importe quel
  // accepteur pourrait déclarer `scope:"global"` sur SA PROPRE fiche membre et
  // s'auto-promouvoir (classe de faille identique à celle fermée pour
  // `consultantId` au round 4). Le signer (l'émetteur, owner/admin) décide
  // désormais explicitement si CE futur membre est "global" ou non.
  const fields = [workspaceId, invitationId, expectedGoogleId, role, createdAt, expiresAt, nonce];
  if (issuerId !== undefined) fields.push(issuerId);
  if (consultantId !== undefined) fields.push(consultantId);
  if (scope !== undefined) fields.push(scope);
  return JSON.stringify(fields);
}

async function defaultProof(canonical) {
  const data = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return toBase64Url(new Uint8Array(digest));
}

const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000; // 7 jours

/**
 * Crée une invitation. `signer`, si fourni, est appelé avec les octets
 * canoniques de l'invitation et doit renvoyer une preuve d'émission
 * (typiquement une signature Ed25519 base64url via CryptoService.sign) ;
 * à défaut, une empreinte SHA-256 non-secrète sert de scellé anti-altération.
 */
export async function createInvitation({
  workspaceId,
  expectedGoogleId = null,
  role = "user",
  ttlMs = DEFAULT_TTL_MS,
  now = new Date(),
  signer = null,
  issuerId,
  consultantId,
  scope,
} = {}) {
  if (!workspaceId) throw new Error("createInvitation: 'workspaceId' requis");
  if (!["owner", "admin", "user"].includes(role)) {
    throw new Error(`createInvitation: rôle invalide '${role}'`);
  }
  // Lot 3 (PARCOURS_IDENTITE_CONTRACT.md) : la seule valeur de `scope`
  // reconnue est "global" (le marqueur "utilisateur global") — tout autre
  // paramètre serait une valeur non modélisée, jamais interprétée nulle part.
  if (scope !== undefined && scope !== "global") {
    throw new Error(`createInvitation: scope invalide '${scope}' (seule 'global' est supportée)`);
  }

  const invitationId = uuid();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(toMs(now) + ttlMs).toISOString();
  const nonce = randomNonce();

  const canonical = canonicalPayload({
    workspaceId,
    invitationId,
    expectedGoogleId,
    role,
    createdAt,
    expiresAt,
    nonce,
    issuerId,
    consultantId,
    scope,
  });

  const proof = signer
    ? await signer(new TextEncoder().encode(canonical))
    : await defaultProof(canonical);

  return {
    workspaceId,
    invitationId,
    expectedGoogleId,
    role,
    createdAt,
    expiresAt,
    nonce,
    proof,
    status: "pending",
    ...(issuerId !== undefined ? { issuerId } : {}),
    ...(consultantId !== undefined ? { consultantId } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

/** Vérifie uniquement l'expiration et l'état "pending" (portée de ce module). */
export function isValid(invitation, now = new Date()) {
  if (!invitation) return false;
  if (invitation.status !== "pending") return false;
  const expiresMs = toMs(invitation.expiresAt);
  if (!Number.isFinite(expiresMs)) return false;
  return toMs(now) < expiresMs;
}

/**
 * Consomme une invitation après enrôlement réussi. Vérifie l'identité Google
 * attendue quand `expectedGoogleId` est renseigné. Renvoie une NOUVELLE
 * invitation marquée "consumed" (ne mute jamais l'original).
 */
export function consume(invitation, { googleId = null, now = new Date() } = {}) {
  if (!isValid(invitation, now)) {
    throw new Error("consume: invitation invalide, expirée, révoquée ou déjà consommée");
  }
  if (invitation.expectedGoogleId && invitation.expectedGoogleId !== googleId) {
    throw new Error("consume: identité Google ne correspond pas à celle attendue par l'invitation");
  }
  return { ...invitation, status: "consumed", consumedAt: new Date(now).toISOString() };
}

/** Révoque une invitation non consommée. Renvoie une NOUVELLE invitation. */
export function revoke(invitation) {
  if (!invitation) throw new Error("revoke: invitation requise");
  if (invitation.status === "consumed") {
    throw new Error("revoke: une invitation déjà consommée ne peut pas être révoquée");
  }
  return { ...invitation, status: "revoked" };
}
