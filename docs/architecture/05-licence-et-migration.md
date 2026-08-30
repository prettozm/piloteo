# 5. Licence et migration

Modules concernés : `src/license/license.js`, `tools/license-gen/`,
`src/migration/v1-import.js`. Référence : `src/CONTRACTS.md` §10/§11,
`docs/next/06_LICENCE_ET_ESSAI.md`, `docs/next/03_MIGRATION_V1_VERS_LOCAL_FIRST.md`
Phase 9.

## 5.1 Licence offline signée

Format (`LICENSE_FORMAT = "piloteo-license-v1"`) :

```json
{ "format":"piloteo-license-v1", "licenseId":"uuid", "workspaceId":"uuid",
  "plan":"TEAM", "maxMembers":20, "issuedAt":"...", "notBefore":"...",
  "expiresAt":"... | null", "features":[], "signature":"base64url" }
```

### Vérification (`verifyLicense`)

```js
verifyLicense(license, {publicKeyJwk, workspaceId, now}) -> {valid, reason, plan, expired}
```

Vérifiée **localement**, signée Ed25519 par l'éditeur, attachée au
**workspace**. La PWA n'embarque que la **clé publique** de vérification
(`EDITOR_PUBLIC_KEY_JWK`, réutilise `canonicalize()` d'`event-schema.js` pour
les mêmes garanties déterministes que la signature d'événements).

`valid` et `expired` sont **deux notions séparées** volontairement : une
licence peut être `valid:true, expired:true` (authentique mais échue) —
c'est `licenseStatus`/`enforcement` qui en tirent la politique d'usage, pas
`verifyLicense`. Cas de rejet : forme invalide, `workspaceId` différent,
signature invalide, `notBefore > now` (`reason:"not-yet-valid"`).

> **⚠️ Point à corriger avant toute distribution réelle** :
> `EDITOR_PUBLIC_KEY_JWK` dans `src/license/license.js` est explicitement un
> **placeholder** (`__PLACEHOLDER__: true`, `x:"PLACEHOLDER-A-REMPLACER..."`).
> Toute vérification de licence avec ce placeholder échoue systématiquement
> (comportement voulu tant que la vraie clé n'est pas injectée) — c'est donc
> une pièce manquante connue, pas un bug latent.

### Essai Team 20 jours

```js
trialStatus(workspaceCreatedAt, now, {trialDays=20}) -> {state:"trial"|"expired", daysLeft}
```

Ancré à `workspace.created`. `daysLeft` = jours pleins restants, jamais
négatif ; passe à `"expired"` dès `daysLeft === 0` (J20 pour un essai de 20
jours démarré à J0).

### Statut composé et enforcement

```js
licenseStatus(workspace, license, now, {publicKeyJwk, trialDays}) -> "trial"|"active"|"expired"|"none"
enforcement(status) -> {read, export, backup, viewLicense, create, update, invite, write}
```

- Un workspace `mode:"local"` est **toujours** `"none"` — mode Solo gratuit,
  aucune licence à vérifier.
- Une licence fournie mais **invalide** (signature, workspace, forme) n'est
  **pas** traitée comme une erreur bloquante : elle est ignorée au profit de
  l'état d'essai (pas de « punition » au-delà de ce qui est documenté comme
  limite assumée, §5.4).
- `enforcement("expired")` : lecture, export, sauvegarde, consultation de la
  licence **toujours autorisés** ; création, modification, invitation
  **bloquées**. Aucune donnée n'est jamais rendue inexportable par une
  expiration.

### Membres

```js
canAddMember(activeCount, maxMembers) -> boolean   // maxMembers null/undefined = illimité
```

Compare aux memberships **actifs uniquement** — à la charge de l'appelant de
ne compter que `status:"active"`.

## 5.2 Générateur de licence (`tools/license-gen/`)

CLI **éditeur**, explicitement **hors PWA** — détient la clé privée Ed25519
de signature des licences.

- Clé privée par défaut : `~/.piloteo-license-gen/editor-signing-key.json`
  (hors dépôt, permissions `0600` à la première génération) ; `--keyfile`
  personnalisable, mais le script **refuse** tout chemin à l'intérieur du
  dépôt Pilotéo.
- Usage : `node tools/license-gen/generate-license.mjs --workspaceId <uuid>
  --plan TEAM --maxMembers 20 --expiresAt <iso|never> [--out fichier.json]`.
- Sortie stdout : la clé publique éditeur (JWK, à copier une fois dans
  `EDITOR_PUBLIC_KEY_JWK`) puis le JSON de licence signée.
- Limites de sécurité assumées **sans serveur d'activation** (documentées
  dans le README de l'outil et dans `docs/next/06` §10) : horloge locale
  manipulable, JavaScript de la PWA patchable par un utilisateur expert,
  création d'un nouveau workspace pour un nouvel essai — protège l'usage
  professionnel normal, pas un attaquant qui modifierait le code de la PWA.
  **Ne pas réintroduire un backend Pilotéo** pour fermer ces cas tant qu'ils
  ne représentent pas une fraude commerciale réelle.

## 5.3 Import V1 → Next (`src/migration/v1-import.js`)

```js
importV1(exportObj, {workspaceId, actorId, epoch=1, now, workspaceName, workspaceMode="team", storage})
  -> {workspace, genesisEvent, projection, events}
```

Entrée attendue : export canonique V1
`{format:"piloteo-v1-export", schemaVersion, exportedAt, revision, state:{...12 collections...}}`.

### Genesis — les deux formes retenues

1. Une **série d'événements `create` standards** (un par entité des 12
   collections), produits via `buildEvent`/`reduce` **exactement le même
   pipeline que le trafic normal** — aucune logique de fusion/état
   réimplémentée. `baseVersion:0` pour chacun.
2. Un **marqueur unique `genesisEvent`**, `type:"workspace.imported"` — pas
   un événement d'entité au sens de `ENTITY_TYPES` (son `entityType`
   n'existe pas dans le schéma, il ne peut donc jamais transiter par
   `buildEvent`/`reduce`) : un enregistrement d'**audit** hors reducer,
   destiné à tracer la provenance (`revision`, `exportedAt` de l'export V1
   source, nombre d'entités importées) — pas à être injecté dans le journal
   d'événements métier.

`importV1` **ne modifie jamais** `exportObj` (clonage via `structuredClone`
ou repli JSON). Le `workspace` retourné est construit directement (pas via
`createTeamWorkspace`, qui génère son propre id aléatoire) car l'appelant
impose `workspaceId`. Mode par défaut `"team"`. **Ne crée pas de
memberships** — lier les consultants V1 à de vraies identités (Google ou
locales) est un choix de bootstrap applicatif distinct, hors du contrat exact
demandé. Une entité V1 malformée (identité absente) est **ignorée
silencieusement** plutôt que de faire échouer tout l'import — documenté, pas
une régression silencieuse : `compareCollections` la ferait de toute façon
apparaître comme un écart.

### Comparateur — gate d'équivalence

```js
compareCollections(v1State, projection) -> {ok:boolean, differences:Array}
```

Compare, collection par collection (les 12 `ENTITY_TYPES`), nombre
d'entités, présence de chaque id/`numero`, égalité de champs (`deepEqual`
profond). Ignore les tombstones (`__deleted:true`) côté projection. C'est le
**gate** de la Phase 9 (`docs/next/03` : « comparer automatiquement toutes
les collections avant/après »).

**Ce que ce module ne fait pas** : provisionnement Drive réel (le storage
par défaut est `{provider:"local", rootId:null}`), création de memberships,
appel à un quelconque outil d'export côté V1 (`server.py`/`app.js` ne portent
pas, dans ce lot, l'écran « Administration → Export migration Pilotéo Next »
suggéré par `docs/next/03` §Phase 9 — l'entrée `importV1` attend un export
déjà produit, au format documenté, sans préjuger de comment il a été généré).
