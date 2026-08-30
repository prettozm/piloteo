# 2. Sécurité, cryptographie, identité

Modules concernés : `src/crypto/crypto-service.js`, `src/crypto/keyring.js`,
`src/sync/sync-engine.js` (pipeline de traitement hostile), `src/core/permissions.js`
(vérification de membership). Référence : `src/CONTRACTS.md` §4/§6/§7,
`docs/next/05_SECURITE_CRYPTO_IDENTITE.md`.

> ## ⚠️ Gate — revue sécurité humaine obligatoire
>
> `src/crypto/crypto-service.js` porte, dès son en-tête, l'avertissement
> suivant : **le code implémente des primitives standard (WebCrypto), il
> n'est PAS « audité »** tant qu'une revue de sécurité humaine n'a pas eu
> lieu. `docs/next/05_SECURITE_CRYPTO_IDENTITE.md` §16 formalise ce gate :
> avant toute promesse commerciale de « chiffrement de bout en bout, l'éditeur
> ne peut pas lire les données », il faut faire relire par un humain compétent
> en sécurité : le format crypto, la distribution des clés, l'invitation, la
> rotation, la CSP, le stockage local des clés, et la procédure de recovery.
> **Ce lot ne satisfait pas ce gate** — il fournit l'implémentation et les
> tests unitaires, pas l'audit.

## 2.1 Primitives réelles retenues

| Usage | Primitive | Où |
|---|---|---|
| Identité de membre / signature d'événement | **Ed25519** (`crypto.subtle.generateKey({name:'Ed25519'})`) | `generateMemberIdentity`, `sign`, `verify` |
| Chiffrement des payloads (AEAD) | **AES-256-GCM**, IV 12 octets aléatoire à chaque appel, AAD = tag de version de format | `encryptPayload`, `decryptPayload` |
| Distribution de clé de workspace (wrap/unwrap) | **X25519 (ECDH-ES)** + **HKDF-SHA256** + AES-256-GCM à usage unique | `generateMemberWrapKeypair`, `wrapKeyForMember`, `unwrapKeyForMember` |

Ces trois primitives sont vérifiées disponibles dans Node 22 et les
navigateurs récents (Chrome/Edge, Safari 17+, Firefox 130+) — c'est un choix
de compatibilité documenté dans l'en-tête du module, pas une primitive
« maison » : **aucune dépendance npm crypto, uniquement
`globalThis.crypto.subtle`**.

Point de conception notable : Ed25519 ne peut pas chiffrer, donc **chaque
membre possède deux paires de clés distinctes** — une paire Ed25519
(signature, `generateMemberIdentity`) et une paire X25519 (wrap de clé,
`generateMemberWrapKeypair`). Le schéma de wrap est un scellement ECDH-ES
classique (proche de JOSE ECDH-ES / NaCl "box") : une paire éphémère X25519
est générée à **chaque appel** de `wrapKeyForMember`, jamais réutilisée ; le
secret partagé ECDH passe par HKDF-SHA256 (sel = clé publique éphémère) pour
dériver une clé AES-256-GCM à usage unique qui chiffre la clé de workspace.
Repli documenté mais **non implémenté** : RSA-OAEP si X25519 devait un jour
manquer sur un runtime cible.

Format des ciphertexts (`encryptPayload`) : `[1 octet version][12 octets IV][ciphertext+tag]`,
encodé en base64url. `decryptPayload` rejette explicitement (message clair,
sans détail exploitable) toute enveloppe trop courte, version de format
inconnue, ou déchiffrement AES-GCM en échec (mauvais tag/nonce/clé) — jamais
d'exception WebCrypto brute qui fuiterait un détail cryptographique.

## 2.2 Epochs et rotation (`keyring.js`)

```js
class Keyring {
  addEpoch(n, key)             // enregistre une clé (AES-256-GCM) pour l'epoch n
  current() / currentEpochNumber()
  get(n)                        // clé d'une epoch connue localement, ou null
  rotate(generateKey) -> {epoch, key}   // epoch courante + 1, ne supprime jamais les anciennes
  knownEpochs()
}
```

Une rotation (typiquement après révocation d'un membre) crée une **nouvelle**
epoch sans supprimer les précédentes : les anciens événements restent
déchiffrables tant que leur epoch d'origine est conservée. C'est à
l'appelant (politique de rétention, hors périmètre de ce lot) de décider s'il
faut un jour purger une epoch ancienne. `Keyring` n'exécute aucune primitive
crypto lui-même : il indexe des clés déjà produites par `crypto-service.js`.

## 2.3 Modèle de menace et ordre de traitement hostile (`SyncEngine`)

`docs/next/05` §1 pose le modèle de menace : **toute donnée reçue via le
transport (Google Drive) doit être traitée comme potentiellement hostile** —
un membre révoqué, un blob altéré, une signature forgée, un événement rejoué.
Une UI masquée n'est jamais une sécurité (`docs/next/08_AI_HANDOFF.md`
invariant 6) : les vérifications doivent avoir lieu côté traitement de
l'événement, pas seulement côté affichage.

`SyncEngine#_processIncoming(blob)` implémente ce pipeline dans **cet ordre
exact**, sans court-circuit qui sauterait une étape, et **ne lève jamais** —
chaque étape retourne un rejet journalisé (`getRejections()`) avec l'étape et
la raison, pour qu'un blob hostile ne bloque jamais le traitement des autres
événements du lot :

```
1. parse envelope      isWellFormedEnvelope + validateEnvelope
                        + rejet si workspaceId étranger
2. verify signature     memberRegistry.getPublicKey(actorId) puis
                        crypto.verify(publicKeyJwk, canonicalize(blob), signature)
                        → acteur inconnu du registre = rejet (client hostile)
3. decrypt              keyring.get(epoch) puis crypto.decryptPayload
                        → epoch inconnue localement = rejet explicite
4. validate schema      validatePayload(entityType, operation, payload, {refs})
5. verify membership    membershipStore.get(workspaceId, actorId)
                        → membre inconnu OU status:"revoked" = rejet
6. verify policy        policy.evaluate({actorMembership, projection, event, payload})
                        → tout sauf "accept" = rejet
7. verify concurrency
   + apply              délégué à EventLog#append puis EventLog#replay()
                        (classify() décide apply/duplicate/conflict — jamais
                        d'écrasement silencieux)
```

Cet ordre correspond exactement à `docs/next/05` §9 et `src/CONTRACTS.md` §7
(« parse envelope → verify signature → decrypt → validate schema → verify
membership → verify policy → verify concurrency → apply »). **Un membre
`revoked` est rejeté avant même l'évaluation de la politique métier.**

Autres garanties du `SyncEngine` :
- un événement local créé par ce client (`recordLocalEvent`) reste `pending`
  tant que `adapter.putImmutable` n'a pas confirmé (`push()`) — en cas
  d'échec réseau, il reste `pending`, jamais de perte ;
- un événement distant déjà vu (`_seen: Set<eventId>`) est ignoré **avant**
  même son re-téléchargement — idempotence sans re-déchiffrement inutile ;
- `sync()` enchaîne `pull()` → `push()` → un second `pull()` court, pour
  absorber les événements arrivés entre-temps.

## 2.4 Vérification de politique et de membership

`PolicyEngine.evaluate` (`src/core/permissions.js`, voir
`04-droits-et-workspace.md`) est appelé avec la **projection courante** (pas
une vue filtrée) et rejette d'office tout membership `status:"revoked"` ou
absent, avant toute règle métier — cf. `isRevoked()`. Aucune décision de
sécurité ne repose sur ce que l'UI montre ou cache.

## 2.5 Stockage des clés

- **Jamais de clé (privée ou wrappée) dans `localStorage`** — invariant
  répété dans `CONTRACTS.md` §0/§4/§9 et `docs/next/05` §6.
- `LocalStore.exportBackup()` (`src/storage/local-store.js`) ne lit **jamais**
  le store IndexedDB `keys` : une sauvegarde `.piloteobackup` ne contient donc
  aucune clé, ni celle de l'exportateur ni celle d'un autre membre.
- Les clés privées Ed25519/X25519 générées par `crypto-service.js` sont
  demandées `extractable:false` quand l'API WebCrypto le permet — elles ne
  quittent donc jamais le contexte `CryptoKey` opaque du navigateur.
- La clé de workspace (AES-256-GCM, `generateWorkspaceKey`) est, elle,
  `extractable:true` par nécessité (elle doit pouvoir être exportée en octets
  bruts pour être « wrappée » pour chaque membre) — jamais persistée en clair
  dans ce lot (le stockage applicatif réel du `keys` store IndexedDB est hors
  périmètre des modules livrés ici).
- Le générateur de licence (`tools/license-gen/`) est un CLI **éditeur**, hors
  PWA, qui détient la clé privée Ed25519 de signature des licences ; seule la
  clé publique va dans `src/license/license.js` (voir
  `05-licence-et-migration.md`).

## 2.6 XSS / CSP

`docs/next/05` §11 fixe l'exigence pour la couche applicative (PWA) : une CSP
stricte doit interdire l'exécution de script inline non signé, pour qu'un XSS
ne puisse pas exfiltrer une `CryptoKey` en mémoire via un appel réseau
arbitraire. **Ce point relève de l'intégration PWA (`index.html`,
`app.js`), non livrée dans ce lot** — les modules `src/` eux-mêmes ne
manipulent aucun DOM et n'exécutent aucun script tiers.
