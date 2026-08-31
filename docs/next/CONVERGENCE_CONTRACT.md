# Contrat de conception — Point 1 : convergence moteur (store event-first solo)

> Contrat **autoritaire** pour ce lot. Le fabricant implémente EXACTEMENT ce
> contrat ; le vérificateur et le contrariant s'y réfèrent. Objectif : donner au
> mode solo un **store event-first** qui réutilise le moteur canonique `src/*`
> (event-per-file, causalité `parentEventId`), avec deux backends (IndexedDB et
> Dossier), **sans modifier `app.js`** (qui parle toujours `GET/PUT /api/state`
> en snapshot).

## 1. Périmètre de CE lot (et hors périmètre)

DANS le périmètre :
- Un module ES **`src/integration/solo-store.js`** : le store event-first solo.
- Deux backends d'événements : **IndexedDB** et **Dossier** (via
  `FolderStorageAdapter` + un port fs injecté).
- La conversion **snapshot ⇄ journal** canonique (avec `parentEventId`).
- Des **tests node** exhaustifs (`tests/next/solo-store.test.mjs`).

HORS périmètre de CE lot (feront l'objet des points suivants) :
- Le pont navigateur `<script type="module">` et le câblage dans
  `local-backend.js` / `index.html` / `pages.yml` (point 1b, lot séparé).
- La migration des données existantes (point 5), les comptes (point 2), l'auth
  (point 3), Drive réel (point 4).
- **Aucune crypto/signature/membership** : le solo est mono-utilisateur, « Folder
  Trusted » — les événements portent leur `payload` **en clair**. On n'utilise
  PAS `SyncEngine` ni `crypto-service`.

## 2. Primitives canoniques à réutiliser (NE PAS réécrire)

Importer depuis `src/*`, ne rien dupliquer :
- `src/events/event-schema.js` : `buildEvent` (avec `parentEventId`),
  `ENTITY_TYPES`, `identityKey`, `identityValue`.
- `src/events/event-log.js` : `EventLog` (`append`, `replay`, `list`, `size`).
- `src/events/reducer.js` : `reduce`, `initialProjection` (via EventLog.replay).
- `src/events/validation.js` : `validatePayload`.
- `src/storage/folder-storage-adapter.js` : `FolderStorageAdapter`.
- `src/storage/node-fs-port.js` (tests) / `src/storage/fsaccess-port.js` (navigateur).

La conversion snapshot↔événements N'EXISTE PAS encore dans `src/*` : c'est le seul
code métier nouveau. L'algorithme de référence est `piloteo-events.js`
(`diffToEvents`, `projectionToState`) — le RÉ-IMPLÉMENTER en canonique, en
**ajoutant `parentEventId`**.

## 3. Constantes solo

- 12 collections + clé d'identité = `ENTITY_TYPES` de event-schema (source unique).
- Identité solo : un `workspaceId` (UUID) et un `actorId` (UUID) FIXES, **persistés
  une fois** par le backend (voir §5), pour que `buildEvent` (qui exige des UUID)
  reste satisfait. `epoch = 1` constant.

## 4. API de `solo-store.js`

```js
export function snapshotToEventsDiff(oldState, newState, { actorId, epoch, projection })
//   -> [event, ...]  (create/update/delete), avec pour chaque événement :
//      baseVersion   = projection.__versions[coll][id]?.version ?? 0
//      parentEventId = projection.__versions[coll][id]?.lastEventId ?? null
//   Règles : parcourir les 12 collections ; identité via identityKey(coll).
//     - present dans new, absent de old            -> "create" (baseVersion 0, parent null)
//     - present des deux, JSON différent           -> "update" (baseVersion/parent courants)
//     - present dans old, absent de new            -> "delete" (baseVersion/parent courants, payload null)
//   Déterministe ; n'émet aucun événement si new == old.

export function projectionToSnapshot(projection)
//   -> { [coll]: [entités...] } pour les 12 collections, tombstones (__deleted)
//      EXCLUS, métadonnées (__versions/__conflicts) exclues, ordre d'insertion conservé.

export function createSoloStore({ backend })
//   backend : voir §5. Retourne un store :
//     async load()            -> { revision, state, conflicts }
//         reconstruit la projection depuis backend.listEvents() via EventLog.replay(),
//         state = projectionToSnapshot(projection),
//         revision = backend.revision() (monotone),
//         conflicts = projection.__conflicts || [].
//     async commit(nextState) -> { revision, state, applied }
//         charge le journal courant -> projection,
//         events = snapshotToEventsDiff(currentSnapshot, nextState, {actorId,epoch,projection}),
//         filtre par validatePayload (rejette un event invalide, jamais throw : le
//           consigner dans `applied.rejected`),
//         pour chaque event valide : backend.appendEvent(event) (immuable),
//         renvoie { revision (incrémentée du nb d'events écrits), state: projectionToSnapshot(nouvelle projection), applied:{count, rejected} }.
//     async currentSnapshot() -> state (sans revision), utilitaire.
```

Contraintes de correction :
- `commit` puis `load` doit rendre un snapshot **ensemblistement identique** au
  `nextState` commité (mêmes entités par identité, mêmes contenus), tombstones exclus.
- La causalité doit être respectée : après `create` puis `update` de la même
  entité, l'`update` porte `parentEventId = eventId(create)` et
  `baseVersion = 1`. Un rejeu dans le désordre donne la même projection.
- Idempotence : ré-appliquer un même event (même `eventId`) ne double pas l'état.
- `delete` = tombstone au niveau projection ; l'entité disparaît du snapshot.

## 5. Contrat `backend` (injecté)

```js
// Un backend persiste des événements IMMUABLES et un compteur de révision.
{
  async init()                     // prépare le stockage + garantit workspaceId/actorId solo persistés
  identity() -> { workspaceId, actorId, epoch:1 }   // UUID fixes persistés
  async listEvents() -> [event...] // TOUS les événements (payload en clair)
  async appendEvent(event) -> void // écrit un event immuable (write-once ; ignorer un doublon d'eventId sans throw)
  revision() -> number             // monotone (ex: nombre d'events)  [peut être async]
}
```

Deux implémentations dans `src/integration/solo-store.js` (ou fichiers voisins) :

1. **`createIndexedDbEventBackend({ indexedDB, dbName })`**
   - Store d'événements clé=`eventId` + un enregistrement `__meta` {workspaceId, actorId}.
   - `appendEvent` : `put` idempotent (si eventId existe, no-op).
   - Testable avec `fake-indexeddb`.

2. **`createFolderEventBackend({ fsPort })`**
   - Utilise `FolderStorageAdapter` : `putImmutable("event", eventId, event)` /
     `listChanges()` + `get("event", id)`.
   - `identity()` : lit/écrit un blob `workspace/manifest.piloteo`
     (`putImmutable("workspace", "manifest", {workspaceId, actorId})`) — créé au 1er `init()`.
   - Événements en clair (Folder Trusted). `listEvents` = listChanges(kind:event) -> get chacun.

## 6. Tests exigés (`tests/next/solo-store.test.mjs`, node:test)

Avec un backend mémoire ou `fake-indexeddb`, ET le backend Dossier via `NodeFsPort`
sur un `mkdtemp` :
1. commit d'un snapshot (create de N entités) -> load -> snapshot identique.
2. update d'une entité -> load -> nouvelle valeur ; lineage : l'event update a
   `parentEventId === eventId(create)` et `baseVersion === 1`.
3. delete -> l'entité disparaît du snapshot ; un tombstone existe dans la projection.
4. restart : nouveau store sur le MÊME backend -> même snapshot (persistance réelle).
5. déterminisme : rejouer les mêmes événements dans un ordre différent -> même snapshot.
6. no-op : commit d'un snapshot identique -> 0 event écrit.
7. backend Dossier : plusieurs commits -> fichiers `events/AAAA-MM/*.piloteo`
   créés ; reload d'un nouveau store -> même snapshot.
8. validation : un payload invalide (ex: NaN) est rejeté (`applied.rejected`), pas
   de throw, les autres events du même commit passent.

Toute la suite `npm run test:next` doit rester **verte** (aucune régression).

## 7. Contraintes transverses

- Aucune dépendance nouvelle. Node >= 20, ESM. Pas de `require`.
- Ne PAS modifier `app.js`, `server.py`, ni les modules `src/*` existants (sauf
  ajout de fichiers). Si un besoin d'API manquante apparaît dans `src/*`, le
  SIGNALER au lieu de modifier en douce.
- Style et niveau de commentaire alignés sur `src/*` (en-tête « Décisions/
  hypothèses », commentaires en français).
- Le code doit être lisible et minimal : pas d'abstraction spéculative.
```
