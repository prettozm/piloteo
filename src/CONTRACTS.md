# Pilotéo Next — Contrats d'interface internes

> Ce document **fige les interfaces** entre les modules local-first. Il est la
> référence d'intégration : chaque module l'implémente à la lettre pour pouvoir
> être développé et testé indépendamment. Toute modification d'un contrat est
> une décision d'architecture, pas un détail d'implémentation.
>
> Aligné sur `docs/next/02_ARCHITECTURE_CIBLE.md` et `docs/next/05_SECURITE_CRYPTO_IDENTITE.md`.

## 0. Conventions générales

- **Modules ES** (`export`/`import`), sans framework, sans dépendance runtime.
- Compatibles **navigateur et Node** (les tests tournent sous `node --test`).
- Aucune primitive crypto maison : uniquement **WebCrypto** (`globalThis.crypto.subtle`).
- Les identifiants sont des **UUID v4** (`crypto.randomUUID()`).
- Le temps est en **ISO 8601 UTC** ; l'horloge n'arbitre jamais un conflit métier.
- Aucune clé ni donnée métier en clair dans les logs.

---

## 1. Enveloppe d'événement (`events/event-schema.js`)

Source de vérité partagée = **journal d'événements immuables**. Un événement :

```json
{
  "version": 1,
  "eventId": "uuid",
  "workspaceId": "uuid",
  "entityType": "saisie",
  "entityId": "uuid",
  "operation": "create | update | delete",
  "actorId": "uuid",
  "baseVersion": 3,
  "epoch": 1,
  "createdAt": "2026-08-30T12:00:00.000Z",
  "ciphertext": "base64url",
  "signature": "base64url"
}
```

- `ciphertext` : payload métier chiffré (AEAD). En **mode local non chiffré**,
  le payload peut être porté en clair par le champ `payload` (objet) à la place
  de `ciphertext` — un même reducer traite les deux après déchiffrement.
- `signature` : signature Ed25519 de l'enveloppe canonique (voir §4).
- Les métadonnées en clair sont **réduites au strict nécessaire**. `entityType`
  et `entityId` peuvent, si jugés révélateurs, passer dans le payload chiffré ;
  la V1 privilégie la confidentialité (option documentée, pas imposée).

**État local d'un événement** (`events` store) :
`pending → published → applied` ; ou `rejected` ; ou `conflict`.

Fonctions exportées :

```
buildEvent({workspaceId, entityType, entityId, operation, actorId, baseVersion, epoch, payload}) -> event (sans signature/ciphertext)
canonicalize(event) -> Uint8Array          // bytes déterministes pour signature/vérif
isWellFormedEnvelope(event) -> boolean
```

---

## 2. Validation structurelle (`events/validation.js`)

Appliquée **avant** toute application d'un événement (dette V1 à ne pas propager).

```
validateEnvelope(event) -> {ok:true} | {ok:false, reason}
validatePayload(entityType, operation, payload, {refs}) -> {ok:true} | {ok:false, reason}
```

Refus obligatoires : `NaN`, `Infinity`, `-Infinity`, nombre là où un type strict
est attendu, `string` au lieu de `number`, objet au lieu de date, enum inconnu,
date invalide, id absent/mal formé, payload au-delà d'une borne de taille
(`MAX_PAYLOAD_BYTES`), référence vers un `workspaceId` étranger. Aucune valeur
invalide ne doit contaminer la projection.

---

## 3. Reducer, conflits, event-log (`events/reducer.js`, `events/conflict.js`, `events/event-log.js`)

### Reducer déterministe

```
reduce(projection, event, payload) -> nextProjection   // pur, sans effet de bord
initialProjection() -> {}
```

Invariant : **même journal valide (mêmes événements) ⇒ même projection**, quel
que soit l'ordre de réception. Ordre d'application des événements indépendants :
dépendances explicites, puis `createdAt` informatif, puis `eventId` en
tie-breaker. Unicité par `eventId` (idempotence).

### Conflits (par version d'entité)

Chaque entité porte une **version logique**. Un événement dont `baseVersion` ≠
version courante de l'entité (et qui n'est pas idempotent) est un **conflit** :
il est conservé (`conflict`), jamais rejoué en silence, jamais écrasant.

```
classify(currentEntityVersion, event) -> "apply" | "duplicate" | "conflict"
```

- Entités différentes ⇒ convergence (fusion).
- Même entité, même base, deux acteurs ⇒ un `apply`, un `conflict`.

### Event-log

```
class EventLog {
  append(event)                       // ajoute (idempotent sur eventId)
  list({fromCursor})                  // événements ordonnés
  replay() -> projection              // reconstruit depuis zéro
  rebuildInto(store)                  // projection reconstruisible
}
```

---

## 4. CryptoService (`crypto/crypto-service.js`, `crypto/keyring.js`)

> ⚠️ **Revue sécurité humaine obligatoire** avant toute promesse commerciale de
> chiffrement (gate de `docs/next/05` §16). Le code implémente des primitives
> standard ; il n'est pas « audité » tant que cette revue n'a pas eu lieu.

Primitives : **AES-256-GCM** (AEAD, chiffrement des payloads) et **Ed25519**
(identité/signature des membres). Clés de workspace par **epoch**.

```
// Identité membre
generateMemberIdentity() -> {publicKeyJwk, privateKeyRef}   // privée non exportable si l'API le permet
sign(privateKeyRef, bytes) -> signature(base64url)
verify(publicKeyJwk, bytes, signature) -> boolean

// Chiffrement de workspace (par epoch)
generateWorkspaceKey() -> keyMaterial                       // AES-256
encryptPayload(epochKey, plaintextObj) -> ciphertext(base64url)   // nonce unique interne
decryptPayload(epochKey, ciphertext) -> plaintextObj              // rejette tag/nonce invalide
wrapKeyForMember(epochKey, memberPublicKeyJwk) -> wrappedKey      // distribution de clé
unwrapKeyForMember(wrappedKey, memberPrivateKeyRef) -> epochKey

// Keyring / epochs
class Keyring { addEpoch(n, key); current(); get(n); rotate() -> newEpoch }
```

Exigences : nonce unique par chiffrement, authentification d'enveloppe, refus de
tout événement corrompu (mauvais tag/nonce/clé/signature ⇒ rejet), versionnement
du format, jamais de clé dans `localStorage` ni dans un export standard, jamais
de secret éditeur embarqué.

---

## 5. StorageAdapter (`storage/storage-adapter.js` + adaptateurs)

Transport de blobs immuables. **Aucune règle métier.** Le contrat :

```
connect() -> Promise<void>
putImmutable(kind, id, blob) -> Promise<{id}>   // write-once ; ne jamais réécrire
get(kind, id) -> Promise<blob>
listChanges(cursor) -> Promise<{changes:[{kind,id}], cursor}>
readMetadata(kind, id) -> Promise<meta>
share(member) -> Promise<void>
revoke(member) -> Promise<void>
health() -> Promise<{ok:boolean, detail}>
```

`kind` ∈ { `workspace`, `member`, `event`, `key`, `license` } (cf. arborescence
Drive de `docs/next/04` §2). Adaptateurs :

- `InMemoryStorageAdapter` — pour tests et mode local (write-once en mémoire).
- `GoogleDriveStorageAdapter` — **squelette** : structure de dossiers, mapping
  My Drive / Shared Drive (`supportsAllDrives`), scope `drive.file`. L'OAuth
  Google **n'est pas branché en live** dans ce lot (spike + credentials requis,
  cf. `docs/next/04` §5-6). Un `oauthTokenProvider` est injecté, jamais stocké.

---

## 6. SyncEngine (`sync/sync-engine.js`)

Cycle (cf. `docs/next/04` §4), **sans backend Pilotéo** :

```
class SyncEngine {
  constructor({adapter, eventLog, crypto, policy, keyring, localStore})
  async pull()      // listChanges -> get -> verifyEnvelope -> verifySignature -> decrypt -> validate -> policy -> apply|reject|conflict -> saveCursor
  async push()      // publie les événements pending ; published seulement après confirmation adapter
  async sync()      // pull, push, court second passage
}
```

Résilience : un événement local reste `pending` tant que l'adaptateur n'a pas
confirmé ; un événement distant déjà vu est ignoré sans erreur (idempotence).

---

## 7. PolicyEngine (`core/permissions.js`)

Porte la logique de `server.py::can_change()`. **Toute opération distante est
vérifiée comme si elle venait d'un client hostile** ; une UI masquée n'est jamais
une sécurité.

```
evaluate({actorMembership, projection, event, payload}) -> "accept" | "reject" | "conflict"
```

Ordre de traitement d'un événement distant (cf. `docs/next/05` §9) :
`parse envelope → verify signature → decrypt → validate schema → verify membership
→ verify policy → verify concurrency → apply`. Un membre `revoked` est rejeté.
La table de droits (rôle × collection × condition) est **remplie depuis la carte
du domaine V1** — voir §12.

---

## 8. WorkspaceRuntime & memberships (`workspace/`)

```
workspace: { id, name, mode:"local|team", createdAt, schemaVersion, storage:{provider, rootId} }
membership: { workspaceId, memberId, googleSubject, email, consultantId, role:"owner|admin|user", status:"active|revoked" }
```

Rôles : `owner` (gouvernance workspace : membres, stockage, licence), `admin`
(référentiels/société), `user` (son périmètre). Le rôle est **par workspace**,
jamais global à l'utilisateur (multi-workspace). Mode solo : identité locale
technique, aucun compte Google.

**Invitations** (`workspace/invitations.js`) : `{ workspaceId, invitationId,
expectedGoogleId, role, createdAt, expiresAt, nonce, proof }`. Expirante,
révocable avant usage, consommée après enrôlement. Le code visible n'est jamais
une clé maître en clair.

---

## 9. LocalStore (`storage/local-store.js`)

Persistance navigateur-native (**IndexedDB**), abstraite pour pouvoir changer
sans toucher au métier. **Jamais de donnée métier dans `localStorage`.**

Stores IndexedDB : `workspaces`, `memberships`, `events`, `projections`,
`sync_cursors`, `keys`, `licenses`, `settings`.

```
class LocalStore {
  static async open(dbName, {schemaVersion}) -> LocalStore   // gère l'upgrade/migration
  // API haut niveau (Phase 1)
  loadWorkspaceState(workspaceId) -> projection
  saveLocalProjection(workspaceId, projection)
  appendLocalEvent(event)
  listLocalEvents(workspaceId, {fromCursor})
  // CRUD générique par store
  put(store, value); get(store, key); getAll(store, query); delete(store, key)
  // Sauvegarde
  exportBackup(workspaceId) -> blob (.piloteobackup : manifest + événements + méta ; jamais de clé privée d'autrui)
  importBackup(blob) -> {workspaceId}
}
```

Migration de schéma via le mécanisme `onupgradeneeded` (numéro `schemaVersion`).
Isolation stricte entre workspaces. Résistance à un store corrompu (erreur claire,
pas de crash silencieux).

---

## 10. Licence (`license/license.js`)

Vérifiée **localement**, attachée au **workspace**, signée par l'éditeur (Ed25519).
La PWA n'embarque que la **clé publique** de vérification.

```json
{ "format":"piloteo-license-v1", "licenseId":"uuid", "workspaceId":"uuid",
  "plan":"TEAM", "maxMembers":20, "issuedAt":"...", "notBefore":"...",
  "expiresAt":"... | null", "features":[], "signature":"base64url" }
```

```
verifyLicense(license, {publicKeyJwk, workspaceId, now}) -> {valid, reason, plan, expired}
licenseStatus(workspace, now) -> "trial" | "active" | "expired" | "none"
```

Essai Team 20 jours (ancré à `workspace.created`). À expiration : lecture, export,
sauvegarde, accès licence **autorisés** ; création/modification/invitation
**bloquées** ; aucune donnée supprimée. Le **générateur** de licence
(`tools/license-gen/`) est un CLI **éditeur**, hors PWA, avec la clé privée.

---

## 11. Import V1 → Next (`migration/v1-import.js`)

Entrée : export canonique V1 `{format:"piloteo-v1-export", schemaVersion, exportedAt,
revision, state:{...}}`. L'import crée le workspace, les memberships/consultants
nécessaires, un événement **genesis** `workspace.imported`, puis une **projection
identique fonctionnellement**. Ne modifie **jamais** la base V1. Un comparateur
vérifie collection par collection (nombre d'entités, ids, relations, champs,
sommes de contrôle).

---

## 12. Domaine V1 — entityTypes & droits

> Section autoritaire pour le reducer (§3) et le PolicyEngine (§7). Détail complet
> dans **`src/V1_DOMAIN_MAP.md`** (à lire avec ce document).

**`entityType` = les 12 collections V1** (`ENTITY_TYPES`), avec leur clé d'identité :

```
consultants(id) organisations(id) affaires(id) methodes(id) typesTerritoire(id)
domainesIntervention(id) categoriesFrais(id) missions(id) factures(id)
saisies(id) bordereauxFrais(numero) notesFrais(id)
```

⚠️ `bordereauxFrais` s'identifie par **`numero`**, pas `id`. ⚠️ `notesFrais` =
entité métier « Frais » ; `bordereauxFrais` = « Bordereau ». Le reducer indexe
chaque entité par sa clé d'identité propre.

**Rôles** : `owner`, `admin`, `user` ; plus le rôle **dérivé** `pilote`
(`affaire.pilote == membre.consultantId`) — non stocké, calculé.

**PolicyEngine — table de droits** (porte `can_change`, cf. `V1_DOMAIN_MAP.md` §3) :

- `admin` et `owner` ⇒ `accept` sur tout (owner = admin + gouvernance workspace).
- Non-admin écrivant une collection de `ADMIN_ONLY`
  = { consultants, organisations, methodes, typesTerritoire, domainesIntervention,
  categoriesFrais, factures } ⇒ `reject`.
- Rôle `user` (`cid`), résumé (détail exact et messages dans `V1_DOMAIN_MAP.md`) :
  - `saisies` : delete ⇒ reject ; add/update seulement sur les siennes ; si
    `type=mission`, la mission doit lui être affectée.
  - `notesFrais` : delete ⇒ reject ; seulement les siennes ; si `affaireId`, il
    doit être dans `related(cid)`.
  - `bordereauxFrais` : delete ⇒ reject ; seulement les siens ; `statut="payée"`,
    `datePaiement`, et toute transition hors { en saisie→en saisie, en saisie→note
    à payer, note à payer→note à payer } ⇒ reject (réservé admin).
  - `affaires`/`missions` : création d'affaire ⇒ reject ; update seulement si
    `affaire.pilote == cid` ; changer le pilote ⇒ reject.
  - défaut ⇒ reject.
- La **concurrence** (accept vs `conflict`) est décidée par la version d'entité
  (§3), séparément des droits.

**Projection & lecture** : le reducer produit l'état complet ; le filtrage de
lecture par rôle (`filter_state`, `V1_DOMAIN_MAP.md` §4) est une **projection de
vue** dérivée, il ne modifie jamais le journal.

**Validation** : la V1 ne validait rien et acceptait NaN/Infinity — le local-first
**ajoute** la validation structurelle (§2) ; ce n'est pas une régression mais une
correction de dette explicitement demandée.
