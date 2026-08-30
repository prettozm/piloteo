# 1. Modèle événementiel

Modules concernés : `src/events/event-schema.js`, `src/events/validation.js`,
`src/events/reducer.js`, `src/events/conflict.js`, `src/events/event-log.js`.
Référence normative : `src/CONTRACTS.md` §1-3, `src/V1_DOMAIN_MAP.md` §7.

## 1.1 Enveloppe d'événement (`event-schema.js`)

La source de vérité est un **journal d'événements immuables**. Chaque
événement porte :

```json
{
  "version": 1,
  "eventId": "uuid",
  "workspaceId": "uuid",
  "entityType": "saisies",
  "entityId": "S-...",
  "operation": "create | update | delete",
  "actorId": "uuid",
  "baseVersion": 3,
  "epoch": 1,
  "createdAt": "2026-08-30T12:00:00.000Z",
  "payload": { "...": "..." }
}
```

En transit (après chiffrement par le `CryptoService`), le champ `payload`
clair est remplacé par `ciphertext` (base64url) et l'enveloppe porte en plus
`signature` (Ed25519, base64url). Un même reducer traite les deux formes une
fois le payload déchiffré — `event-schema.js` lui-même ne connaît pas la
crypto.

`ENTITY_TYPES` liste les 12 collections V1 avec leur **clé d'identité
propre** :

```js
consultants: "id", organisations: "id", affaires: "id", methodes: "id",
typesTerritoire: "id", domainesIntervention: "id", categoriesFrais: "id",
missions: "id", factures: "id", saisies: "id",
bordereauxFrais: "numero",   // ⚠️ pas "id"
notesFrais: "id",
```

`identityKey(entityType)` / `identityValue(entityType, payload)` centralisent
cette exception. `event.entityId` porte toujours la **valeur** de cette clé
(donc un `numero` de bordereau pour `bordereauxFrais`), jamais un champ nommé
`id` en dur.

Fonctions exportées : `buildEvent(...)` (construit l'enveloppe sans
`signature`/`ciphertext`, valide chaque champ avec `TypeError` explicite),
`canonicalize(event)` (bytes déterministes pour signature/vérification),
`isWellFormedEnvelope(event)` (forme uniquement, pas les règles métier).

### Canonicalisation déterministe

`canonicalize()` sérialise toutes les clés de l'enveloppe **sauf**
`signature`, avec un tri récursif des clés d'objet (`canonicalValue`) :
- nombres non finis (`NaN`/`±Infinity`) → `TypeError` (jamais silencieusement
  sérialisés en `null` par `JSON.stringify`) ;
- `undefined` → `TypeError` ;
- types non sérialisables (`function`, `symbol`, `bigint`) → `TypeError`.

Le résultat est indépendant de l'ordre d'insertion des clés, condition
nécessaire pour qu'une signature Ed25519 calculée par l'émetteur soit
vérifiable à l'identique par le destinataire.

## 1.2 Validation structurelle (`validation.js`) — dette V1 corrigée

> **La V1 ne validait rien côté serveur** (`server.py`, JSON Python sans
> `allow_nan=False`) : `NaN`/`Infinity`/`-Infinity` étaient acceptés sans
> broncher. C'est une dette explicitement identifiée (`V1_DOMAIN_MAP.md` §7,
> `docs/next/08_AI_HANDOFF.md` « Dette V1 à ne pas propager ») que le
> local-first **corrige**, sans que ce soit une régression fonctionnelle.

`validateEnvelope(event)` vérifie la forme de l'enveloppe (mêmes règles que
`isWellFormedEnvelope`, avec un message de rejet précis par champ).

`validatePayload(entityType, operation, payload, {refs})` :
- **recherche récursive de nombres non finis** (`findNonFinite`) dans tout le
  payload, tableaux et objets imbriqués compris — refus systématique ;
- **borne de taille** : `MAX_PAYLOAD_BYTES = 256 Ko` (JSON sérialisé) ;
- **références croisées optionnelles** : si l'appelant fournit des `Set`
  d'identifiants connus (`refs.consultants`, `.affaires`, `.missions`,
  `.organisations`, `.categoriesFrais`, `.bordereaux`), toute référence du
  payload (`consultantId`, `affaireId`, `missionId`, `organisationId`,
  `categorieFraisId`, `numeroBordereau`) doit y figurer, sinon rejet
  « référence inexistante ». Un ensemble non fourni = vérification sautée
  (usage partiel possible, par ex. dans `SyncEngine` qui ne vérifie que
  `refs.workspaceId`) ;
- **référence à un workspace étranger** : si le payload porte lui-même un
  champ `workspaceId` différent de celui attendu → rejet ;
- **validateurs dédiés** par entité pour `saisies`, `notesFrais`, `missions`,
  `affaires`, `bordereauxFrais` (champs, énumérations, exclusions mutuelles —
  ex. `affaireId`/`categorieTempsInterne` exclusifs sur `notesFrais`, cycle de
  vie `en saisie → note à payer → payée` sur `bordereauxFrais`) ; validation
  générique stricte (payload objet + clé d'identité bien formée) pour les
  7 autres entityTypes.
- `operation === "delete"` : payload minimal accepté (`null` ou objet ne
  portant que la clé d'identité).

Aucune valeur invalide ne peut donc contaminer la projection : la validation
est appliquée **avant** toute application d'un événement, dans le pipeline du
`SyncEngine` (voir `02-securite-crypto-identite.md` §pipeline).

## 1.3 Reducer (`reducer.js`) — pur, déterministe, reconstructible

```js
initialProjection() -> {}
reduce(projection, event, payload) -> nextProjection   // pur, sans effet de bord
```

Forme de la projection :

```js
{
  [entityType]: { [identity]: entity },
  __versions: { [entityType]: { [identity]: { version, lastEventId } } },
}
```

Points clés :
- **`reduce` est pur** : seules les branches modifiées (`projection[entityType]`,
  `projection.__versions[entityType]`) sont clonées ; le reste est partagé par
  référence (sûr car immuable une fois produit).
- **`reduce` NE VÉRIFIE PAS les conflits** : c'est la responsabilité de
  `conflict.js#classify`, appelée par l'orchestrateur (`EventLog#replay` /
  `SyncEngine`) **avant** de décider d'appliquer l'événement. Cette séparation
  est volontaire (contrat §3).
- **`delete` = tombstone** : l'entité reçoit `__deleted:true` et
  `__deletedAt`, les champs métier précédents sont conservés (audit), la
  version est tout de même incrémentée.
- `__versions[...]` porte `{version, lastEventId}` (pas un simple entier) :
  `lastEventId` est nécessaire à `conflict.js#classify` pour distinguer un
  vrai doublon (même `eventId` rejoué) d'un vrai conflit (deux événements
  distincts avec le même `baseVersion`).

**Invariant central** : même journal valide (mêmes événements) ⇒ même
projection, quel que soit l'ordre de réception.

## 1.4 Conflits par version d'entité (`conflict.js`)

```js
classify(currentEntityVersion, event) -> "apply" | "duplicate" | "conflict"
```

Règles, dans cet ordre :
1. `event.eventId === currentEntityVersion.lastEventId` → **`"duplicate"`**
   (rejouer l'événement qui a produit l'état courant est un no-op idempotent).
2. `event.baseVersion !== version courante` → **`"conflict"`** — jamais
   écrasé, jamais rejoué silencieusement.
3. sinon → **`"apply"`**. Une création initiale (entité inconnue, version
   courante = 0) satisfait cette règle dès que `baseVersion === 0`, sans cas
   particulier.

Ce module est pur (aucune E/S), et ignore volontairement le reducer et
l'event-log : il est testable isolément.

- **Entités différentes ⇒ convergence** (fusion sans conflit).
- **Même entité, deux acteurs concurrents ⇒ un `apply`, un `conflict`** : le
  perdant n'écrase jamais, il est conservé dans `projection.__conflicts` pour
  traitement ultérieur (UI de résolution, hors périmètre de ce lot).

## 1.5 Event-log, ordre déterministe (`event-log.js`)

```js
class EventLog {
  append(event)          // idempotent sur eventId (Map interne)
  list({fromCursor})      // ordre déterministe, indépendant de l'insertion
  replay() -> projection  // reconstruit depuis zéro
  rebuildInto(store)      // pousse la projection reconstruite dans un store
}
```

**Ordre de tri (`tieBreak`)** : `(entityType, entityId, baseVersion)`
croissant en premier — ce qui respecte **toujours** la chaîne causale d'une
même entité quel que soit l'ordre d'insertion (un `update` de `baseVersion=1`
ne peut jamais se retrouver ordonné avant sa `create` de `baseVersion=0`,
même en cas d'égalité de `createdAt` à la milliseconde) — puis, à
`baseVersion` égale (vraie concurrence entre deux acteurs), `createdAt`
informatif, puis `eventId` en tie-breaker final. Un `event.dependsOn`
explicite (tableau d'`eventId`) est en plus respecté via un **tri
topologique** (`topoSort`) construit sur ce même comparateur ; un cycle ou
une dépendance manquante ne perd jamais silencieusement d'événements (les
événements restants sont complétés de façon déterministe en fin de liste).

`replay()` reconstruit la projection intégralement en rejouant `list()` :
`classify()` décide, événement par événement, s'il faut appliquer (`reduce`),
ignorer silencieusement (`"duplicate"`, idempotence), ou accumuler dans
`projection.__conflicts` (`"conflict"`, jamais d'écrasement). Comme l'ordre de
`list()` ne dépend que de l'**ensemble** des événements (pas de l'ordre
d'`append`), deux journaux contenant les mêmes événements produisent toujours
la même projection — c'est l'invariant central du contrat, vérifié par les
tests (`tests/next/events.test.mjs`).

## 1.6 Idempotence — où elle est garantie

| Niveau | Mécanisme |
|---|---|
| `EventLog.append` | `Map` indexée par `eventId` — un doublon d'insertion est un no-op signalé (`{appended:false, duplicate:true}`) |
| `conflict.js#classify` | rejouer le même `eventId` sur une entité renvoie `"duplicate"`, jamais `"conflict"` |
| `SyncEngine.pull` | `_seen: Set<eventId>` ignore un événement distant déjà vu **avant même** de le re-télécharger |
| `LocalStore.appendLocalEvent` | idempotent sur `eventId` ; un événement déjà présent n'est jamais réécrit (préserve son `state` local) |
