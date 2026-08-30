# 3. Synchronisation et stockage

Modules concernés : `src/storage/storage-adapter.js`,
`src/storage/in-memory-adapter.js`, `src/storage/google-drive-adapter.js`,
`src/sync/sync-engine.js`, `src/storage/local-store.js`. Référence :
`src/CONTRACTS.md` §5/§6/§9, `docs/next/04_SYNC_ET_STOCKAGE_DRIVE.md`.

## 3.1 Contrat `StorageAdapter`

Transport de **blobs immuables**, sans aucune règle métier — un
`StorageAdapter` conforme pourrait transporter des octets sans rapport avec
Pilotéo :

```js
connect() -> Promise<void>
putImmutable(kind, id, blob) -> Promise<{id}>   // write-once ; ne jamais réécrire
get(kind, id) -> Promise<blob>
listChanges(cursor) -> Promise<{changes:[{kind,id}], cursor}>
readMetadata(kind, id) -> Promise<meta>
share(member) -> Promise<void>
revoke(member) -> Promise<void>
health() -> Promise<{ok:boolean, detail}>
```

`kind ∈ {"workspace", "member", "event", "key", "license"}` — liste
autoritaire `STORAGE_KINDS`, vérifiée par `assertValidKind()`. La classe de
base `StorageAdapter` est une interface abstraite « à la JS » : chaque
méthode non implémentée lève `Error("...doit être implémentée par la
sous-classe.")` plutôt que de se comporter en no-op silencieux.

`putImmutable` **doit** refuser d'écraser un `(kind, id)` déjà écrit
(write-once) — c'est une obligation de chaque implémentation concrète, pas de
la classe de base.

## 3.2 `InMemoryStorageAdapter` — tests et mode local

Implémentation complète, utilisée par les tests et par le mode Solo
(aucun backend, aucune dépendance réseau) :

- stockage `Map<"kind:id", {blob, writtenAt, seq}>`, **write-once strict**
  (`putImmutable` lève si `(kind,id)` existe déjà) ;
- curseur = **entier ordinal monotone** (nombre de blobs écrits au moment de
  l'appel) ; `listChanges(cursor)` renvoie tout depuis ce curseur (exclusif),
  dans l'ordre d'écriture, et le nouveau curseur ;
- **panne simulée** : `setOffline(true)` fait échouer
  `connect/putImmutable/get/listChanges` avec une erreur explicite (sert à
  tester la résilience du `SyncEngine`) ; `readMetadata/share/revoke/health`
  restent utilisables hors ligne — `health()` répond `{ok:false}` sans lever,
  jamais un blocage silencieux ;
- `share(member)`/`revoke(member)` sont de simples registres en mémoire, pas
  une ACL réelle.

C'est **le seul adaptateur exercé par les 171 tests** du dépôt
(`tests/next/sync.test.mjs`) — le `SyncEngine` est donc validé de bout en
bout contre ce transport, jamais contre un vrai Google Drive.

## 3.3 `GoogleDriveStorageAdapter` — squelette, réseau non câblé

> Le module s'ouvre sur un avertissement explicite : **aucun appel réseau
> réel n'est effectué**. Toutes les méthodes de transport
> (`connect, putImmutable, get, listChanges, readMetadata, share, revoke,
> health`) lèvent `NotWiredError` (code `NOT_WIRED`).

### Ce qui est câblé (testable sans réseau ni credentials)

- la structure de dossiers cible et les helpers **purs** de construction de
  chemins : `folderForKind(kind)` (mapping `kind` → dossier de premier
  niveau : `workspace`, `members`, `events`, `keys`, `licenses`),
  `monthFolder(createdAtIso)` (sous-dossier mensuel `AAAA-MM` pour les
  événements), `epochFolder(n)` (sous-dossier `epoch-XXXX`),
  `fileNameForKind(kind, id)` (jamais de nom métier — uniquement des
  identifiants opaques), `buildDrivePath(kind, id, extra)` ;
- les paramètres de requête distinguant **My Drive / Shared Drive**
  (`driveQueryParams`, `driveWriteParams` : `supportsAllDrives`, `driveId`,
  `includeItemsFromAllDrives`) ;
- le contrat d'injection de `oauthTokenProvider` — une fonction fournie par
  l'appelant, **jamais stockée en clair** ni loggée par ce module, appelée à
  la demande (pas encore, puisqu'aucun appel réseau n'existe) ; et le scope
  cible `DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"` (jamais
  le scope `drive` complet) ;
- `appDataFolder` est délibérément **non utilisé** (privé à l'app/utilisateur,
  ne peut pas être partagé — inadapté à un workspace d'équipe).

### Ce qui reste à câbler (spike requis, hors de ce lot)

1. OAuth Google réel côté navigateur (Google Identity Services), obtention
   d'un access token `drive.file` par interaction utilisateur — nécessite des
   credentials OAuth (client ID) absents de ce dépôt.
2. Le **spike technique** explicitement demandé (`docs/next/04` §6) : UX
   exacte d'un membre invité avec le scope minimal `drive.file` — accès au
   dossier partagé reçu par invitation, découverte à partir d'un
   file/folder id, besoin éventuel d'un passage **Picker**.
3. Les appels REST Drive proprement dits (`files.create`, `files.get`,
   `files.list`/`changes.list`, pagination, « change token » d'un Shared
   Drive) — nécessitent le token OAuth du point 1.
4. Gestion réelle du refresh/expiration de token, des erreurs HTTP
   (403/404/429/5xx), des retries, et de la déduplication d'upload en cas de
   retry après timeout.
5. La matrice de tests Drive (`docs/next/07` §9 : My Drive Gmail, My Drive
   Workspace, Shared Drive Workspace, compte sans accès, accès retiré, token
   expiré, offline) — impossible sans les points 1-4 et un vrai compte
   Google de test.

**Conséquence directe** : la Phase 6 de la roadmap (« Google Identity +
Drive Adapter », gate = deux navigateurs distincts convergent via Drive) et
la Phase 7 (invitations/memberships en conditions réelles Drive) ne sont
**pas atteintes** par ce lot — voir `06-mapping-v1-vers-next.md`.

## 3.4 Cycle de synchronisation (`SyncEngine`)

```js
class SyncEngine {
  constructor({adapter, eventLog, crypto, keyring, policy, memberRegistry, membershipStore, actor, localStore?})
  async connect()   // adapter.connect() puis tente de charger le curseur sauvegardé (best effort)
  async pull()      // listChanges -> get -> pipeline hostile (§2.3) -> append -> sauvegarde curseur
  async push()      // chiffre+signe chaque événement local `pending`, putImmutable, marque `published`
  async sync()      // pull, push, court second pull
}
```

- `push()` : pour chaque événement local `pending`, récupère la clé de
  l'epoch via le `Keyring`, chiffre le payload (`crypto.encryptPayload`),
  construit le blob `{...envelope sans payload, ciphertext}`, le signe
  (`crypto.sign` sur `canonicalize(blob)`), puis `adapter.putImmutable`. Le
  statut ne passe à `published` **qu'après confirmation** de l'adaptateur —
  en cas d'échec (réseau, epoch inconnue), l'événement reste `pending`,
  jamais de perte.
- `pull()` : ignore silencieusement tout changement dont `kind !== "event"`
  (distribution de `member`/`key`/`license` hors périmètre de ce lot) ;
  ignore un `eventId` déjà vu sans même le re-télécharger ; traite chaque
  blob via le pipeline hostile complet (§2.3) ; sauvegarde le curseur en best
  effort via `localStore` s'il est fourni.
- Résilience : un événement local reste `pending` tant que l'adaptateur n'a
  pas confirmé ; un événement distant déjà vu est ignoré sans erreur.

## 3.5 `LocalStore` — persistance navigateur-native (IndexedDB)

`src/storage/local-store.js` est la persistance **locale** (distincte du
transport `StorageAdapter`) : 8 object stores fixes — `workspaces`(keyPath
`id`), `memberships`(keyPath composite `[workspaceId, memberId]`),
`events`(keyPath `eventId`, index `by_workspaceId` + `by_state`),
`projections`(keyPath `workspaceId`), `sync_cursors`(keyPath `workspaceId`),
`keys`(keyPath `id`), `licenses`(keyPath `workspaceId`), `settings`(keyPath
`key`, préférences d'app locales uniquement — **jamais de donnée métier**).

- **Migration de schéma** : `SCHEMA_MIGRATIONS` liste ordonnée par version
  IndexedDB, rejouée dans `onupgradeneeded` pour toute étape
  `oldVersion < step.version <= newVersion` (un saut direct 0→2 rejoue 1 puis
  2 ; une mise à niveau 1→2 ne rejoue que 2). Chaque étape est elle-même
  idempotente (`ensureStore`/`ensureIndex` vérifient l'existence avant de
  créer). `CURRENT_SCHEMA_VERSION = 2` (v1 = 7 premiers stores + index
  `by_workspaceId` ; v2 = ajout `settings` + index `by_state`), démontrant une
  vraie migration additive sans perte.
- **Isolation stricte entre workspaces** : toute API haut niveau prenant un
  `workspaceId` ne lit/écrit que ses enregistrements (clé primaire ou index),
  jamais un scan global implicite.
- **Résistance à un store corrompu/absent** : `#assertStore` vérifie
  l'existence du store avant transaction ; toute erreur IndexedDB est
  enveloppée dans une `Error` explicite (`message` + `cause`), jamais une
  `DOMException` brute ou un crash silencieux.
- `appendLocalEvent(event, {state})` est idempotent sur `eventId` (préserve
  le `state` local d'un événement déjà présent — ne fait jamais régresser un
  `applied` en `pending`). L'état local d'un événement suit
  `pending → published → applied`, ou `rejected`, ou `conflict`.
- **`exportBackup(workspaceId)` ne lit jamais le store `keys`** : aucune clé
  (privée ou wrappée) ne quitte donc un export `.piloteobackup`
  (`{format:"piloteo-backup-v1", workspaceId, exportedAt, manifest, events,
  projection, meta}`). `importBackup` est idempotent (ré-importer le même
  backup produit le même résultat) et écrase volontairement via `put` direct
  car il restaure un état de référence faisant autorité.

## 3.6 Confidentialité côté transport

Le contrat StorageAdapter transporte des blobs opaques — `kind`/`id` sont des
identifiants techniques (`eventId`, `memberId`, numéro d'epoch), jamais un
nom de client/consultant/affaire/facture. Côté `GoogleDriveStorageAdapter`,
`fileNameForKind` ne dérive jamais un nom de fichier depuis un contenu
métier. Une fois le réseau câblé, aucune donnée métier ne doit circuler en
clair sur Drive : c'est le rôle du `CryptoService` (chiffrement AES-256-GCM
du payload avant `putImmutable`, voir `02-securite-crypto-identite.md`) —
`StorageAdapter` lui-même ne fait aucune hypothèse sur le contenu du blob
qu'il transporte.
