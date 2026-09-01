# Contrat — Point 3 : Authentification & session réelles

> Donne une VRAIE session (verrouillage / déverrouillage / déconnexion /
> reconnexion) à l'app local-first, SANS mot de passe factice et SANS serveur
> métier. `app.js` et `server.py` restent intacts ; tout passe par
> `local-backend.js` + un module pur testable. Le mode Serveur V1 n'est jamais
> intercepté (son login V1 continue de fonctionner tel quel).

## 0. Principe (backend-less)

Il n'y a pas de serveur pour vérifier un mot de passe. L'« identité » est :
- **solo** : le consultant admin de l'état local ;
- **org** : l'identité de membre Ed25519 déjà persistée en IndexedDB (Point 2).

La « session » est donc une **machine à états locale à l'appareil** :
`locked` → (déverrouillage) → `active` → (déconnexion / verrouillage) → `locked`.
Le **code PIN** (optionnel) est un **verrou d'appareil honnête**, PAS de la
confidentialité : il ne chiffre pas les données (le chiffrement reste derrière la
revue sécu). Cohérent avec le modèle « signé, non chiffré ». L'UI doit le dire.

## 1. Module pur `src/auth/session.js` (testable node, sans DOM)

Exporte :
```js
// Dérivation lente d'un PIN via WebCrypto PBKDF2-SHA-256 (crypto.subtle).
async function hashPin(pin, saltBytes, iterations=210000) -> { hashB64, saltB64, iterations }
async function verifyPin(pin, { hashB64, saltB64, iterations }) -> bool   // comparaison à temps constant
function newSalt() -> Uint8Array(16)                                       // crypto.getRandomValues

// Machine à états + anti-force-brute (PURE, pas d'E/S) :
// session = { status, pin?:{hashB64,saltB64,iterations}, failedAttempts, lockedUntil }
function initialSession(opts) -> session                 // {status:"locked"} si PIN, sinon {status:"active"}
function canAttempt(session, now) -> { allowed, waitMs }  // lockout exponentiel après 5 échecs
function registerFailure(session, now) -> session         // incrémente, pose lockedUntil (2^(n-5) s, plafonné)
function registerSuccess(session) -> session              // status:"active", failedAttempts:0, lockedUntil:0
function lock(session) -> session                         // status:"locked"
```
Règles :
- PBKDF2 ≥ 210 000 itérations, sel 16 octets aléatoire, sortie 256 bits.
- `verifyPin` compare à **temps constant** (pas de court-circuit `===` sur les octets).
- Anti-force-brute : ≤ 5 tentatives, puis fenêtre de blocage **exponentielle**
  (`lockedUntil`), horodatée par `now` **passé en paramètre** (jamais `Date.now()`
  interne — pour être testable et non contournable en changeant l'horloge : le
  code appelant fournit `now`, le module ne fait pas confiance à une horloge
  auto-déclarée pour raccourcir un blocage).
- **Aucun secret en clair** : ni le PIN, ni un dérivé réversible ne sont stockés
  ni loggés. Seuls `hashB64`/`saltB64`/`iterations` persistent.

## 2. Persistance de session (`local-backend.js`, côté navigateur)

- Enregistrement `piloteo_session` (IndexedDB `piloteo-solo` ou localStorage) :
  `{ status, pin?, failedAttempts, lockedUntil, lockOnOpen:bool }`. Survit au reload.
- **Boot** :
  - si un PIN est défini ET (`lockOnOpen` OU `status!=="active"`) → afficher
    l'overlay de verrouillage ; **bloquer** `/api/me` et `/api/state` (GET/PUT)
    tant que non déverrouillé (la promesse ne résout qu'après unlock) ;
  - sinon → session `active` directement (UX solo frictionless préservée : le PIN
    est **opt-in**, l'app sans PIN démarre exactement comme aujourd'hui).
- **Déverrouillage** : saisie du PIN dans l'overlay → `canAttempt` → `verifyPin` →
  `registerSuccess`/`registerFailure` persistés. Pendant un blocage, l'overlay
  affiche le temps restant et refuse la saisie. Aucun chemin ne contourne le blocage.

## 3. Routes interceptées

- `POST /api/logout` (déclenché par `#switch-user` de app.js) : **n'est plus un
  no-op**. Passe la session à `locked`, affiche l'overlay, et **ne ré-entre pas**
  automatiquement. En **org**, l'identité de membre (clé) est **conservée**
  (reconnexion possible) ; « Changer d'identité » (destructif : oublie la clé)
  n'est proposé qu'explicitement dans Réglages, avec avertissement.
- `GET /api/me`, `POST /api/login`, `GET|PUT /api/state` : gated sur `active`
  (attendent le déverrouillage). Comportement inchangé une fois `active`.
- Le mode **Serveur V1** n'est pas intercepté par local-backend → login V1 intact.

## 4. Réglages (section « Session / Sécurité »)

- Définir / changer / retirer un **code PIN** (avec confirmation ; retirer exige
  le PIN courant).
- **Verrouiller maintenant** (remplace le lock minimal du §2.4 de l'audit).
- Case « Verrouiller à chaque ouverture » (`lockOnOpen`).
- Libellé honnête : « Le code verrouille l'accès sur CET appareil. Il ne chiffre
  pas les données ; la confidentialité repose sur les permissions du dossier/Drive. »
- En org : bouton « Se déconnecter » (verrouille, garde l'identité) distinct de
  « Changer d'identité » (oublie la clé — avertissement rayon d'explosion nul mais
  perte d'accès à re-inviter).

## 5. Tests (obligatoires, doivent passer)

`tests/next/auth-session.test.mjs` (node:test) :
1. `hashPin`/`verifyPin` : bon PIN accepté, mauvais rejeté, sel différent →
   hash différent, itérations respectées.
2. `verifyPin` à temps constant (au moins : ne court-circuite pas — vérifier via
   inspection que toute la longueur est comparée ; test fonctionnel suffisant).
3. Anti-force-brute : 5 échecs → `canAttempt.allowed===false`, `waitMs>0` ;
   avancer `now` au-delà de `lockedUntil` → de nouveau autorisé ; **reculer**
   `now` ne raccourcit pas le blocage (l'appelant fournit `now`, mais le module
   compare à `lockedUntil` stocké — prouver qu'un `now` passé < `lockedUntil`
   reste bloqué).
4. `registerSuccess` remet le compteur/lockout à zéro.
5. `initialSession` : PIN présent → `locked` ; absent → `active`.

`tests/e2e/auth-session.mjs` (Playwright/Chromium, statique, style solo-folder.mjs) :
6. Sans PIN : boot direct `active`, `/api/me` OK (non-régression).
7. Définir un PIN via l'API de test → recharger → overlay affiché, `/api/state`
   bloqué → déverrouiller → `active`, `/api/state` OK.
8. `POST /api/logout` → overlay affiché, `/api/me` bloqué jusqu'au re-unlock.

`npm run test:next` reste vert.

## 6. Contraintes

- `app.js`/`server.py` intacts ; mode Serveur non intercepté.
- Réutiliser `crypto-service`/WebCrypto (pas de dépendance nouvelle).
- Aucun PIN/secret en clair dans le stockage ou les logs.
- Overlay = celui déjà présent (`lockSpace`) étendu, pas un écran app.js.
