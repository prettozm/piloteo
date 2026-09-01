// src/auth/session.js
//
// Module PUR (aucune E/S, aucun DOM, aucune horloge interne) implémentant le
// Point 3 (docs/next/AUTH_SESSION_CONTRACT.md §1) : dérivation de PIN via
// WebCrypto PBKDF2-SHA-256 et machine à états de session locale à l'appareil,
// avec anti-force-brute exponentiel.
//
// ⚠️ Ce module verrouille l'ACCÈS À L'APPAREIL, ce n'est PAS du chiffrement de
// confidentialité (cf. contrat §0) : il ne protège pas les données au repos.
// La revue sécurité humaine du chiffrement (src/crypto/crypto-service.js)
// reste un sujet séparé.
//
// ⚠️ MODÈLE DE MENACE (révisé après DEUX revues adverses, contrat §0) : ces
// protections sont BEST-EFFORT contre un accès OCCASIONNEL (un collègue, un
// écran laissé déverrouillé) — PAS des barrières cryptographiques. Un
// adversaire capable d'exécuter du JavaScript dans la page (console
// DevTools, extension) lit de toute façon les données en clair (IndexedDB,
// modèle « signé, non chiffré ») sans jamais avoir besoin de passer par ce
// module. Le BLOCAGE TEMPORISÉ (`canAttempt`/`registerFailure`) lui-même est
// un RALENTISSEUR UX, pas une barrière : il repose sur une horloge que
// quiconque a accès aux Réglages système de l'appareil peut avancer, SANS
// AUCUN JavaScript (round 2 : tests/e2e/attack-p3-session-round2.mjs). Ce
// niveau d'accès est déjà comparable à celui qui permet de lire IndexedDB en
// clair — le lockout n'élargit donc pas la surface, il ralentit un curieux.
// La SEULE barrière réellement indépendante de l'horloge : le coût PBKDF2
// par tentative (temps CPU non raccourcissable) combiné à une longueur de
// PIN minimale imposée par l'appelant (contrat §4) et à un compteur d'échecs
// PERSISTANT (jamais remis à zéro sauf par `registerSuccess`). Ne jamais
// présenter ces mécanismes comme « incontournables ».
//
// Choix de conception :
// - `hashPin`/`verifyPin` réutilisent `globalThis.crypto.subtle` (PBKDF2)
//   exactement comme `crypto-service.js` réutilise WebCrypto pour Ed25519/
//   AES-GCM/X25519 : aucune primitive maison, aucune dépendance npm.
// - Le sel (16 octets, CSPRNG) et le nombre d'itérations (>=210000) sont
//   stockés À CÔTÉ du hash (jamais le PIN, jamais un dérivé réversible) —
//   seuls `hashB64`/`saltB64`/`iterations` doivent être persistés par
//   l'appelant (local-backend.js).
// - `verifyPin` compare le hash candidat au hash stocké à TEMPS CONSTANT
//   (parcours de la longueur totale, XOR accumulé, jamais de retour anticipé
//   sur un octet différent) pour ne pas fuiter d'information par canal
//   temporel.
// - L'anti-force-brute est un pur calcul sur l'objet `session` : `now` est
//   TOUJOURS fourni par l'appelant (jamais `Date.now()` interne). Ce module
//   ne fait donc confiance à AUCUNE horloge auto-déclarée pour raccourcir un
//   blocage — `registerFailure` ne fait jamais DÉCROÎTRE `lockedUntil` d'un
//   appel au suivant, même si `now` régresse entre deux appels (horloge
//   manipulée par l'appelant) : voir le `Math.max` ci-dessous.

const DEFAULT_ITERATIONS = 210000;
const SALT_BYTES = 16;
const HASH_BITS = 256; // 256 bits = 32 octets, sortie PBKDF2
const MAX_ATTEMPTS = 5; // tentatives libres avant blocage
const MAX_LOCK_MS = 24 * 60 * 60 * 1000; // plafond du blocage exponentiel : 24h

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('session: WebCrypto (globalThis.crypto.subtle) indisponible dans ce runtime.');
  }
  return c.subtle;
}

// ---------------------------------------------------------------------------
// Base64 (standard, pas base64url) — sans dépendance, navigateur + Node 22.
// ---------------------------------------------------------------------------

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(str) {
  if (typeof str !== 'string' || str.length === 0) {
    throw new Error('session: base64 invalide (vide ou non-chaîne).');
  }
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Dérivation / vérification de PIN (PBKDF2-SHA-256)
// ---------------------------------------------------------------------------

/** Sel aléatoire de 16 octets (CSPRNG) pour une dérivation PBKDF2. */
function newSalt() {
  const s = new Uint8Array(SALT_BYTES);
  globalThis.crypto.getRandomValues(s);
  return s;
}

async function derive(pin, saltBytes, iterations) {
  const s = subtle();
  const keyMaterial = await s.importKey(
    'raw',
    new TextEncoder().encode(String(pin ?? '')),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await s.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    keyMaterial,
    HASH_BITS
  );
  return new Uint8Array(bits);
}

/**
 * Dérive un PIN en un hash PBKDF2-SHA-256 (>=210000 itérations par défaut,
 * sortie 256 bits). Ne retourne QUE des valeurs sûres à persister
 * (hash+sel+itérations) — jamais le PIN en clair.
 * @param {string} pin
 * @param {Uint8Array} [saltBytes] sel explicite (sinon `newSalt()`)
 * @param {number} [iterations=210000]
 * @returns {Promise<{hashB64:string, saltB64:string, iterations:number}>}
 */
async function hashPin(pin, saltBytes, iterations = DEFAULT_ITERATIONS) {
  const salt = saltBytes || newSalt();
  if (!(iterations >= DEFAULT_ITERATIONS)) {
    throw new Error(`session.hashPin: iterations doit être >= ${DEFAULT_ITERATIONS}.`);
  }
  const hashBytes = await derive(pin, salt, iterations);
  return { hashB64: bytesToBase64(hashBytes), saltB64: bytesToBase64(salt), iterations };
}

/** Comparaison à TEMPS CONSTANT de deux `Uint8Array` (pas de court-circuit). */
function constantTimeEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length; // longueurs différentes => jamais égal
  for (let i = 0; i < len; i++) {
    const av = i < a.length ? a[i] : 0;
    const bv = i < b.length ? b[i] : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

/**
 * Vérifie un PIN contre un hash stocké (`{hashB64,saltB64,iterations}`).
 * Comparaison à temps constant (toute la longueur est parcourue, jamais de
 * `return` anticipé sur le premier octet différent).
 * @param {string} pin
 * @param {{hashB64:string, saltB64:string, iterations:number}} stored
 * @returns {Promise<boolean>}
 */
async function verifyPin(pin, stored) {
  if (!stored || !stored.hashB64 || !stored.saltB64 || !stored.iterations) {
    throw new Error('session.verifyPin: hash stocké invalide (hashB64/saltB64/iterations requis).');
  }
  // Durcissement anti-downgrade (défense en profondeur, PAS une barrière —
  // cf. modèle de menace en tête de fichier) : un `piloteo_session` FORGÉ
  // (ex. IndexedDB éditée à la main) ne doit pas pouvoir imposer un hash
  // affaibli à itérations réduites pour rendre un brute-force hors-ligne
  // praticable. `verifyPin` refuse tout enregistrement sous le plancher —
  // l'appelant doit traiter ce rejet comme une vérification échouée (jamais
  // comme un succès), typiquement en enregistrant un échec (`registerFailure`).
  if (!(stored.iterations >= DEFAULT_ITERATIONS)) {
    throw new Error(`session.verifyPin: enregistrement refusé — itérations insuffisantes (${stored.iterations} < ${DEFAULT_ITERATIONS}).`);
  }
  const saltBytes = base64ToBytes(stored.saltB64);
  const candidate = await derive(pin, saltBytes, stored.iterations);
  const expected = base64ToBytes(stored.hashB64);
  return constantTimeEqual(candidate, expected);
}

// ---------------------------------------------------------------------------
// Machine à états de session + anti-force-brute (PURE, aucune E/S)
// ---------------------------------------------------------------------------
//
// session = {
//   status: "locked" | "active",
//   pin: {hashB64,saltB64,iterations} | null,
//   failedAttempts: number,
//   lockedUntil: number,      // epoch ms ; 0 = pas de blocage actif
//   lockOnOpen: boolean,      // repris tel quel par l'appelant (§4) ; ce
//                             // module ne le lit ni ne l'écrit lui-même.
// }

/**
 * Session initiale : `locked` si un PIN est fourni, `active` sinon (le PIN
 * est opt-in — sans PIN, l'app démarre directement, cf. contrat §2).
 * @param {{pin?: {hashB64:string,saltB64:string,iterations:number}|null, lockOnOpen?: boolean}} opts
 */
function initialSession(opts = {}) {
  const pin = opts.pin || null;
  return {
    status: pin ? 'locked' : 'active',
    pin,
    failedAttempts: 0,
    lockedUntil: 0,
    lockOnOpen: !!opts.lockOnOpen,
  };
}

/**
 * `now` est TOUJOURS fourni par l'appelant : ce module ne lit jamais une
 * horloge interne. Renvoie si une tentative de déverrouillage est autorisée
 * à cet instant, et le temps d'attente restant sinon.
 * @param {object} session
 * @param {number} now epoch ms
 * @returns {{allowed:boolean, waitMs:number}}
 */
function canAttempt(session, now) {
  const lockedUntil = (session && session.lockedUntil) || 0;
  if (lockedUntil > now) return { allowed: false, waitMs: lockedUntil - now };
  return { allowed: true, waitMs: 0 };
}

/**
 * Enregistre un échec de saisie. À partir de la 5e tentative échouée
 * (`MAX_ATTEMPTS`), pose/étend un blocage exponentiel : `2^(n-5)` secondes,
 * plafonné à 24h. `lockedUntil` ne DÉCROÎT JAMAIS d'un appel au suivant
 * (`Math.max`), même si `now` régresse — un appelant qui reculerait son
 * horloge entre deux échecs ne raccourcit pas le blocage déjà posé.
 * @param {object} session
 * @param {number} now epoch ms
 * @returns {object} nouvelle session (status:"locked")
 */
function registerFailure(session, now) {
  const failedAttempts = ((session && session.failedAttempts) || 0) + 1;
  let lockedUntil = (session && session.lockedUntil) || 0;
  if (failedAttempts >= MAX_ATTEMPTS) {
    const exponent = failedAttempts - MAX_ATTEMPTS;
    const waitMs = Math.min(Math.pow(2, exponent) * 1000, MAX_LOCK_MS);
    lockedUntil = Math.max(lockedUntil, now + waitMs);
  }
  return { ...session, failedAttempts, lockedUntil, status: 'locked' };
}

/**
 * Déverrouillage réussi : remet le compteur d'échecs et le blocage à zéro,
 * session `active`.
 * @param {object} session
 * @returns {object} nouvelle session
 */
function registerSuccess(session) {
  return { ...session, status: 'active', failedAttempts: 0, lockedUntil: 0 };
}

/**
 * Verrouille explicitement la session (bouton « Verrouiller maintenant »,
 * déconnexion…). Ne touche pas au compteur d'échecs / blocage en cours.
 * @param {object} session
 * @returns {object} nouvelle session (status:"locked")
 */
function lock(session) {
  return { ...session, status: 'locked' };
}

// ---------------------------------------------------------------------------
// Durcissement §1 : recoupement d'horloge (défense en profondeur, PAS une
// barrière — cf. modèle de menace en tête de fichier)
// ---------------------------------------------------------------------------
//
// `canAttempt` fait confiance au `now` que l'appelant lui donne. Côté
// navigateur, cet appelant (local-backend.js) lit forcément une horloge —
// `Date.now()` — qu'un script exécuté DANS la page (console DevTools,
// bookmarklet, extension) peut monkey-patcher pour la faire AVANCER
// artificiellement et ainsi neutraliser le blocage exponentiel (contourner
// l'anti-force-brute, pas la confidentialité : cf. modèle de menace §0).
//
// `canAttemptCrossChecked` recoupe DEUX estimations de "maintenant" — une
// horloge murale (`wallNow`, ex. `Date.now()`) et une horloge monotone
// (`monoNow`, dérivée de `performance.now()`, censée être immunisée contre un
// monkey-patch de `Date.now`) — et retient le waitMs le plus CONSERVATEUR
// (le plus grand) : le blocage n'est levé que si LES DEUX s'accordent sur le
// fait que le temps s'est réellement écoulé. Une horloge murale avancée
// artificiellement DANS LA PAGE (monkey-patch `Date.now`), seule, ne peut
// donc plus lever le blocage à elle seule.
//
// ⚠️ Ce que ce recoupement NE couvre PAS (round 2, 2e revue adverse — repro
// tests/e2e/attack-p3-session-round2.mjs) : `monoNow` est en pratique
// `wallRefAuBoot + (performance.now() - monoRefAuBoot)`, où `wallRefAuBoot`
// est LUI-MÊME une lecture de `Date.now()` faite au chargement de la page.
// Un adversaire qui change l'HORLOGE SYSTÈME de l'appareil (Réglages OS —
// AUCUN JavaScript requis) avant un rechargement fait lire cette référence
// déjà mensongère : les deux estimations sont alors corrompues à la même
// source, et le recoupement ne détecte rien. Ce n'est PAS un bug à corriger
// ici — DÉCISION D'ORCHESTRATION (contrat §0 amendé) : ancrer la référence
// ailleurs (IndexedDB, etc.) resterait contournable par un changement
// d'horloge OS entre deux sessions, et ce niveau d'accès (Réglages système
// de l'appareil) permet de toute façon de lire IndexedDB en clair. Le
// recoupement reste donc un obstacle réel à l'attaque la plus simple (un
// `Date.now = () => …` collé dans la console DevTools, round 1) mais N'EST
// PAS présenté comme résistant à un changement d'horloge OS — la vraie
// barrière contre le brute-force est ailleurs : coût PBKDF2 par tentative +
// compteur d'échecs persistant + longueur de PIN minimale (contrat §4).
//
// La lecture des horloges elle-même (Date.now/performance.now) reste hors de
// ce module PUR (aucune E/S/horloge interne) : c'est à l'appelant de fournir
// `wallNow`/`monoNow` (voir `local-backend.js#attemptUnlock`).
/**
 * @param {object} session
 * @param {number} wallNow epoch ms (horloge murale, potentiellement manipulée)
 * @param {number} monoNow epoch ms estimé via une horloge monotone recoupée
 * @returns {{allowed:boolean, waitMs:number}}
 */
function canAttemptCrossChecked(session, wallNow, monoNow) {
  const gWall = canAttempt(session, wallNow);
  const gMono = canAttempt(session, monoNow);
  const waitMs = Math.max(gWall.waitMs, gMono.waitMs);
  return { allowed: waitMs <= 0, waitMs };
}

export {
  hashPin,
  verifyPin,
  newSalt,
  initialSession,
  canAttempt,
  canAttemptCrossChecked,
  registerFailure,
  registerSuccess,
  lock,
};
