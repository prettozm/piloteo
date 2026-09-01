// src/crypto/crypto-service.js
//
// ⚠️ REVUE SÉCURITÉ HUMAINE REQUISE avant toute promesse commerciale de
// chiffrement (gate docs/next/05 §16). Ce module implémente des primitives
// standard (WebCrypto) ; il n'est pas « audité » tant que cette revue n'a pas
// eu lieu. Ne jamais présenter ce code comme du chiffrement de bout en bout
// vérifié sans cette relecture par un humain compétent en sécurité.
//
// Choix de primitives retenus (spike de compatibilité Node 22 / navigateur) :
//
// - Identité de membre / signature : **Ed25519** (`crypto.subtle.generateKey
//   ({name:'Ed25519'}, ...)`), disponible nativement dans Node 22 et dans les
//   navigateurs récents (Chrome/Edge, Safari 17+, Firefox 130+). Signature
//   déterministe, rapide, clé privée générée non exportable quand possible.
//
// - Chiffrement des payloads : **AES-256-GCM** (AEAD), nonce/IV de 12 octets
//   généré aléatoirement à CHAQUE appel (jamais réutilisé), AAD = octet de
//   version de format. Conforme à CONTRACTS §4 et docs/next/05 §5.
//
// - Distribution de clé de workspace (wrap/unwrap) : **X25519 (ECDH)** +
//   **HKDF-SHA256** + **AES-256-GCM**. Vérifié disponible dans Node 22 via
//   `crypto.subtle.generateKey({name:'X25519'}, ...)` et
//   `deriveBits({name:'X25519', public}, ...)` (voir spike ci-dessous). Comme
//   Ed25519 ne peut pas chiffrer, on NE réutilise PAS la paire de signature
//   pour le wrap : chaque membre possède donc DEUX paires de clés distinctes
//   — une paire Ed25519 (signature, `generateMemberIdentity`) et une paire
//   X25519 (wrap de clé, `generateMemberWrapKeypair`). C'est documenté et
//   acceptable (cf. mission : "peuvent être deux paires distinctes par
//   membre"). Le schéma de wrap est un scellement ECDH-ES classique (proche
//   de JOSE ECDH-ES / NaCl "box") : une paire éphémère X25519 est générée à
//   chaque appel de `wrapKeyForMember`, le secret partagé ECDH est passé dans
//   HKDF-SHA256 (sel = clé publique éphémère, info = constante de contexte)
//   pour dériver une clé de wrap AES-256-GCM à usage unique, qui chiffre les
//   octets bruts de la clé de workspace. L'enveloppe scellée transporte la
//   clé publique éphémère + IV + ciphertext ; le destinataire refait le même
//   calcul ECDH avec sa clé privée X25519 pour retrouver la clé de wrap.
//
//   Repli documenté : si X25519 n'était pas disponible dans un runtime cible,
//   RSA-OAEP (SHA-256) serait la voie de repli standard WebCrypton (vérifié
//   disponible aussi dans ce spike Node 22) — non utilisé ici car X25519 a
//   fonctionné dans le spike de compatibilité.
//
// Aucune primitive crypto maison. Aucune dépendance npm. Uniquement
// `globalThis.crypto.subtle`. Jamais de clé en clair dans un log.

const FORMAT_VERSION = 1;
const FORMAT_TAG = `piloteo-crypto-v${FORMAT_VERSION}`;
const WRAP_INFO = `piloteo-key-wrap-v${FORMAT_VERSION}`;
const IV_BYTES = 12; // 96 bits, taille recommandée pour AES-GCM

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('CryptoService: WebCrypto (globalThis.crypto.subtle) indisponible dans ce runtime.');
  }
  return c.subtle;
}

// ---------------------------------------------------------------------------
// Base64url (sans dépendance), utilisable navigateur + Node.
// ---------------------------------------------------------------------------

function bytesToBase64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(str) {
  if (typeof str !== 'string' || str.length === 0) {
    throw new Error('CryptoService: base64url invalide (vide ou non-chaîne).');
  }
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  else if (pad !== 0) {
    throw new Error('CryptoService: base64url invalide (longueur incorrecte).');
  }
  let binary;
  try {
    binary = atob(b64);
  } catch {
    throw new Error('CryptoService: base64url invalide (décodage échoué).');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function concatBytes(...chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identité de membre (signature Ed25519)
// ---------------------------------------------------------------------------

/**
 * Génère une identité de membre (paire Ed25519) pour la signature des
 * événements. La clé privée est demandée non-exportable (`extractable:false`)
 * — l'API WebCrypto le permet pour Ed25519.
 * @returns {Promise<{publicKeyJwk: object, privateKeyRef: object}>}
 */
async function generateMemberIdentity() {
  const s = subtle();
  const keyPair = await s.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const publicKeyJwk = await s.exportKey('jwk', keyPair.publicKey);
  return {
    publicKeyJwk,
    privateKeyRef: { keyType: 'ed25519', cryptoKey: keyPair.privateKey },
  };
}

/**
 * Signe des octets avec la clé privée Ed25519 référencée par privateKeyRef.
 * @param {{keyType:'ed25519', cryptoKey: CryptoKey}} privateKeyRef
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} signature base64url
 */
async function sign(privateKeyRef, bytes) {
  if (!privateKeyRef || privateKeyRef.keyType !== 'ed25519' || !privateKeyRef.cryptoKey) {
    throw new Error('CryptoService.sign: privateKeyRef invalide (identité Ed25519 attendue).');
  }
  const s = subtle();
  const sig = await s.sign({ name: 'Ed25519' }, privateKeyRef.cryptoKey, bytes);
  return bytesToBase64url(new Uint8Array(sig));
}

/**
 * Vérifie une signature Ed25519 sur des octets. Ne lève jamais : renvoie
 * `false` pour toute signature invalide, corrompue ou mal formée.
 * @param {object} publicKeyJwk
 * @param {Uint8Array} bytes
 * @param {string} signature base64url
 * @returns {Promise<boolean>}
 */
async function verify(publicKeyJwk, bytes, signature) {
  try {
    const s = subtle();
    const publicKey = await s.importKey(
      'jwk',
      publicKeyJwk,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const sigBytes = base64urlToBytes(signature);
    return await s.verify({ name: 'Ed25519' }, publicKey, sigBytes, bytes);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Chiffrement de workspace (AES-256-GCM par epoch)
// ---------------------------------------------------------------------------

/**
 * Génère une nouvelle clé de workspace (AES-256-GCM). Extractable=true car
 * elle doit pouvoir être exportée pour être "wrappée" pour chaque membre
 * (wrapKeyForMember) — elle n'est jamais persistée en clair (localStorage
 * interdit ; stockage applicatif hors périmètre de ce module).
 * @returns {Promise<CryptoKey>} keyMaterial
 */
async function generateWorkspaceKey() {
  const s = subtle();
  return s.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/**
 * Chiffre un objet JS en JSON avec AES-256-GCM. Nonce/IV de 12 octets tiré
 * aléatoirement à chaque appel (CSPRNG), jamais réutilisé. L'AAD est la
 * version de format (protège contre le rejeu d'un format différent). Le
 * ciphertext retourné encode : [1 octet version][12 octets IV][ciphertext+tag].
 * @param {CryptoKey} epochKey
 * @param {object} plaintextObj
 * @returns {Promise<string>} base64url
 */
async function encryptPayload(epochKey, plaintextObj) {
  if (!epochKey) {
    throw new Error('CryptoService.encryptPayload: epochKey manquante.');
  }
  const s = subtle();
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const aad = new TextEncoder().encode(FORMAT_TAG);
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(plaintextObj));
  const cipherBuf = await s.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    epochKey,
    plaintextBytes
  );
  const envelope = concatBytes(
    new Uint8Array([FORMAT_VERSION]),
    iv,
    new Uint8Array(cipherBuf)
  );
  return bytesToBase64url(envelope);
}

/**
 * Déchiffre un ciphertext produit par encryptPayload. Rejette (lève une
 * erreur claire, sans détail cryptographique sensible) tout blob corrompu :
 * version de format inconnue, IV/tag/clé invalides, ciphertext tronqué.
 * @param {CryptoKey} epochKey
 * @param {string} ciphertext base64url
 * @returns {Promise<object>} plaintextObj
 */
async function decryptPayload(epochKey, ciphertext) {
  if (!epochKey) {
    throw new Error('CryptoService.decryptPayload: epochKey manquante.');
  }
  let envelope;
  try {
    envelope = base64urlToBytes(ciphertext);
  } catch {
    throw new Error('CryptoService.decryptPayload: enveloppe illisible (base64url invalide).');
  }
  if (envelope.length < 1 + IV_BYTES + 16) {
    throw new Error('CryptoService.decryptPayload: enveloppe trop courte / corrompue.');
  }
  const version = envelope[0];
  if (version !== FORMAT_VERSION) {
    throw new Error(`CryptoService.decryptPayload: version de format inconnue (${version}).`);
  }
  const iv = envelope.slice(1, 1 + IV_BYTES);
  const cipherBytes = envelope.slice(1 + IV_BYTES);
  const aad = new TextEncoder().encode(FORMAT_TAG);
  const s = subtle();
  let plainBuf;
  try {
    plainBuf = await s.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      epochKey,
      cipherBytes
    );
  } catch {
    // Mauvais tag, mauvais nonce ou mauvaise clé -> WebCrypto lève une
    // OperationError générique ; on la traduit en erreur métier claire sans
    // fuiter de détail exploitable.
    throw new Error('CryptoService.decryptPayload: déchiffrement refusé (tag/nonce/clé invalide ou donnée corrompue).');
  }
  const text = new TextDecoder().decode(plainBuf);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('CryptoService.decryptPayload: contenu déchiffré non-JSON (corruption).');
  }
}

// ---------------------------------------------------------------------------
// Distribution de clé (wrap/unwrap) — X25519 ECDH + HKDF-SHA256 + AES-256-GCM
// ---------------------------------------------------------------------------

/**
 * Génère la paire de clés de WRAP d'un membre (X25519), distincte de son
 * identité de signature Ed25519 (voir en-tête). Clé privée non-exportable
 * quand l'API le permet.
 * @returns {Promise<{publicKeyJwk: object, privateKeyRef: object}>}
 */
async function generateMemberWrapKeypair() {
  const s = subtle();
  const keyPair = await s.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  const publicKeyJwk = await s.exportKey('jwk', keyPair.publicKey);
  return {
    publicKeyJwk,
    privateKeyRef: { keyType: 'x25519', cryptoKey: keyPair.privateKey },
  };
}

async function deriveWrappingKey(subtleApi, ecdhPrivateKey, ecdhPublicKey, saltBytes, usages) {
  const sharedBits = await subtleApi.deriveBits(
    { name: 'X25519', public: ecdhPublicKey },
    ecdhPrivateKey,
    256
  );
  const hkdfKey = await subtleApi.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return subtleApi.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes,
      info: new TextEncoder().encode(WRAP_INFO),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

/**
 * "Wrappe" (chiffre) une clé de workspace pour un membre destinataire, à
 * partir de sa clé publique de wrap X25519. Scellement ECDH-ES à usage
 * unique : une paire éphémère est générée à chaque appel, jamais réutilisée.
 * @param {CryptoKey} epochKey clé de workspace (AES-256-GCM, extractable)
 * @param {object} memberPublicKeyJwk clé publique X25519 (JWK) du membre
 * @returns {Promise<string>} wrappedKey (base64url, enveloppe JSON auto-portée)
 */
async function wrapKeyForMember(epochKey, memberPublicKeyJwk) {
  if (!epochKey) {
    throw new Error('CryptoService.wrapKeyForMember: epochKey manquante.');
  }
  const s = subtle();
  const memberPublicKey = await s.importKey(
    'jwk',
    memberPublicKeyJwk,
    { name: 'X25519' },
    true,
    []
  );
  const ephemeral = await s.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const ephemeralPublicJwk = await s.exportKey('jwk', ephemeral.publicKey);
  const ephemeralPublicRaw = base64urlToBytes(ephemeralPublicJwk.x);

  const wrappingKey = await deriveWrappingKey(
    s,
    ephemeral.privateKey,
    memberPublicKey,
    ephemeralPublicRaw,
    ['encrypt']
  );

  const rawKeyBytes = new Uint8Array(await s.exportKey('raw', epochKey));
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const cipherBuf = await s.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    wrappingKey,
    rawKeyBytes
  );

  const envelope = {
    v: FORMAT_VERSION,
    epk: ephemeralPublicJwk,
    iv: bytesToBase64url(iv),
    ct: bytesToBase64url(new Uint8Array(cipherBuf)),
  };
  return bytesToBase64url(new TextEncoder().encode(JSON.stringify(envelope)));
}

/**
 * "Unwrap" (déchiffre) une clé de workspace précédemment scellée pour le
 * membre, à partir de sa clé privée de wrap X25519. Rejette toute enveloppe
 * corrompue ou toute clé privée incorrecte.
 * @param {string} wrappedKey base64url produit par wrapKeyForMember
 * @param {{keyType:'x25519', cryptoKey: CryptoKey}} memberPrivateKeyRef
 * @returns {Promise<CryptoKey>} epochKey (AES-256-GCM, extractable)
 */
async function unwrapKeyForMember(wrappedKey, memberPrivateKeyRef) {
  if (!memberPrivateKeyRef || memberPrivateKeyRef.keyType !== 'x25519' || !memberPrivateKeyRef.cryptoKey) {
    throw new Error('CryptoService.unwrapKeyForMember: memberPrivateKeyRef invalide (identité X25519 attendue).');
  }
  let envelope;
  try {
    const json = new TextDecoder().decode(base64urlToBytes(wrappedKey));
    envelope = JSON.parse(json);
  } catch {
    throw new Error('CryptoService.unwrapKeyForMember: enveloppe illisible (corrompue).');
  }
  if (!envelope || envelope.v !== FORMAT_VERSION || !envelope.epk || !envelope.iv || !envelope.ct) {
    throw new Error('CryptoService.unwrapKeyForMember: enveloppe mal formée ou version inconnue.');
  }

  const s = subtle();
  let ephemeralPublicKey;
  try {
    ephemeralPublicKey = await s.importKey('jwk', envelope.epk, { name: 'X25519' }, true, []);
  } catch {
    throw new Error('CryptoService.unwrapKeyForMember: clé publique éphémère invalide.');
  }
  const ephemeralPublicRaw = base64urlToBytes(envelope.epk.x);

  const wrappingKey = await deriveWrappingKey(
    s,
    memberPrivateKeyRef.cryptoKey,
    ephemeralPublicKey,
    ephemeralPublicRaw,
    ['decrypt']
  );

  let iv;
  let cipherBytes;
  try {
    iv = base64urlToBytes(envelope.iv);
    cipherBytes = base64urlToBytes(envelope.ct);
  } catch {
    throw new Error('CryptoService.unwrapKeyForMember: IV/ciphertext invalides.');
  }

  let rawKeyBuf;
  try {
    rawKeyBuf = await s.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, wrappingKey, cipherBytes);
  } catch {
    throw new Error('CryptoService.unwrapKeyForMember: déchiffrement refusé (clé/tag/nonce invalide).');
  }

  return s.importKey('raw', rawKeyBuf, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export {
  FORMAT_VERSION,
  generateMemberIdentity,
  sign,
  verify,
  generateWorkspaceKey,
  encryptPayload,
  decryptPayload,
  generateMemberWrapKeypair,
  wrapKeyForMember,
  unwrapKeyForMember,
};
