# Contrat — Point 2c-C1 : pont org-engine (snapshot ⇄ sync multi-membre)

> Enveloppe `openOrgSync` (2c-B) dans un « engine » `{load, commit}` compatible
> avec le contrat `/api/state` de l'app (comme le fait `solo-store` pour le
> dossier solo), pour que `local-backend.js` (lot 2c-C2) puisse brancher le mode
> ORGANISATION sur l'app inchangée. Lot testable en node. Réutilise
> `snapshotToEventsDiff`/`projectionToSnapshot` (solo-store) et le SyncEngine
> trusted (via openOrgSync). Aucune UI, aucun câblage local-backend ici.

## 1. `src/workspace/org-engine.js` (nouveau)

```js
export async function openOrgEngine({ adapter, identity, consultantId })
//   1. { engine, manifest, membership } = await openOrgSync({adapter, identity, consultantId})  (2c-B)
//   2. await adapter.connect() si dispo ; await engine.pull() (état initial)
//   3. retourne un objet :
//      { manifest, membership,
//        async load(),                 // pull + projection -> { revision, state, conflicts }
//        async commit(nextState),      // diff -> createLocalEvent(*) -> push -> pull -> { ok, revision, state, changes:{}, conflicts }
//        async members() }             // liste des membres de confiance {memberId, consultantId, role, status}
```

Détails :
- **load()** : `await engine.pull()` (récupère les events des autres membres),
  puis `state = projectionToSnapshot(engine.getProjection())`,
  `revision = engine.eventLog.size()` (monotone), `conflicts = engine.getConflicts()`.
- **commit(nextState)** :
  1. `await engine.pull()` (base fraîche).
  2. `cur = projectionToSnapshot(engine.getProjection())`.
  3. Calcule les OPÉRATIONS (create/update/delete + payload) via
     `snapshotToEventsDiff(cur, nextState, {workspaceId: manifest.workspaceId,
     actorId: identity.memberId, epoch:1, projection: engine.getProjection()})`,
     puis pour CHAQUE event du diff, appelle
     `engine.createLocalEvent({entityType, entityId, operation, payload})`
     (le SyncEngine re-construit l'événement signé avec SA lignée/`parentEventId`
     et le signera au push — on n'utilise PAS l'enveloppe brute du diff, seulement
     ses champs d'opération). Les entités rejetées par le diff (identité absente/
     vide, clé réservée) vont dans `applied.rejected`.
  4. `await engine.push()` (signe + publie dans le dossier).
  5. `await engine.pull()` (récupère d'éventuels events concurrents).
  6. retourne `{ ok:true, revision, state: projectionToSnapshot(engine.getProjection()),
     changes:{}, conflicts: engine.getConflicts() }`.
- **PERMISSION** : si un `createLocalEvent`/push est refusé par la policy (ex. un
  `user` modifie une entité ADMIN_ONLY), l'événement est publié mais REJETÉ au
  replay des autres (et de soi-même au pull). `commit` DOIT détecter ce cas :
  si un événement qu'il a créé finit en `conflicts` OU si la policy locale le
  refuse, le remonter (dans `conflicts` ou un `rejected`), pour que 2c-C2 renvoie
  un 409/403 à l'app plutôt qu'un faux succès (cf. leçon du point 1b).
  → Concrètement : après le push+pull final, comparer les eventId créés localement
  à ceux réellement appliqués ; tout écart => le signaler.

## 2. Réutilisation (ne rien réécrire)
- `snapshotToEventsDiff`, `projectionToSnapshot` : `src/integration/solo-store.js`.
- `openOrgSync` : `src/workspace/org-sync.js`. SyncEngine : `src/sync/sync-engine.js`.
- Rôle owner→admin métier : déjà géré par `core/permissions.js`.

## 3. Tests (`tests/next/org-engine.test.mjs`, NodeFsPort sur mkdtemp)
Deux membres (Alice owner, Bob user) sur un dossier partagé (via org-folder-store) :
1. Alice `openOrgEngine` -> `commit` d'un état (1 consultant + 1 saisie) ->
   `load` -> snapshot identique (aller-retour).
2. Bob `openOrgEngine` -> `load` voit les données d'Alice (convergence via dossier).
3. Bob `commit` d'une saisie qui lui appartient (consultantId = celui de Bob) ->
   Alice `load` la voit.
4. **Rôle** : Bob (user) `commit` une modif d'un `consultant` (ADMIN_ONLY) ->
   `commit` renvoie un signal d'échec (conflicts/rejected non vide), et Alice ne
   voit jamais cette modif.
5. **Révocation** : Alice révoque Bob (via org-folder-store) ; un nouveau
   `openOrgEngine`/`commit` de Bob est sans effet côté Alice (events rejetés).
6. Idempotence : `commit` d'un état identique -> 0 event créé.

`npm run test:next` reste vert.

## 4. Contraintes
- ESM, node ≥20, style `src/*`. app.js/server.py intacts. Pas d'UI, pas de
  local-backend. Mode chiffré SyncEngine inchangé.
