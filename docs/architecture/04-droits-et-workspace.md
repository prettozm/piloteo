# 4. Droits et workspace

Modules concernés : `src/core/permissions.js`, `src/workspace/workspace.js`,
`src/workspace/memberships.js`, `src/workspace/invitations.js`. Référence :
`src/CONTRACTS.md` §7/§8, `src/V1_DOMAIN_MAP.md` §2/§3/§4.

## 4.1 PolicyEngine — port fidèle de `can_change()`

`src/core/permissions.js` porte **fidèlement** `server.py::can_change()` (V1)
et `server.py::filter_state()` / `affair_ids_for_user()`. Signature :

```js
evaluate({ actorMembership, projection, event, payload }) -> "accept" | "reject"
```

Contrairement à la signature générale de `CONTRACTS.md` §7 (qui admet aussi
`"conflict"`), ce module **n'émet jamais `"conflict"`** — la concurrence par
version d'entité est un ressort séparé (`events/conflict.js`), traité en
aval dans le pipeline du `SyncEngine`. C'est un arbitrage explicite documenté
en tête de fichier, pas un oubli.

### Ordre d'évaluation

1. `actorMembership` absent ou `status:"revoked"` → **reject** d'office,
   avant toute règle métier.
2. `isAdmin(membership)` (rôle `admin` **ou** `owner`) → **accept**
   systématique (`owner` = `admin` + gouvernance workspace, aucune règle
   métier supplémentaire créée pour `owner`).
3. Non-admin écrivant une collection de `ADMIN_ONLY` (`consultants`,
   `organisations`, `methodes`, `typesTerritoire`, `domainesIntervention`,
   `categoriesFrais`, `factures`) → **reject**.
4. Règles rôle `user` (`cid = actorMembership.consultantId`), portées
   fidèlement depuis `server.py:377-430` :

| Collection | Règle |
|---|---|
| `saisies` | `delete` toujours rejeté ; `add`/`update` seulement sur les siennes ; si `type === "mission"`, la mission doit lui être affectée (`mission.consultantId === cid`) |
| `notesFrais` | `delete` toujours rejeté ; seulement les siennes ; si `affaireId` renseigné, doit être dans `related(cid)` |
| `bordereauxFrais` | `delete` toujours rejeté ; seulement les siens ; `statut === "payée"` → reject ; toute transition hors `{en saisie→en saisie, en saisie→note à payer, note à payer→note à payer}` → reject ; `datePaiement` renseigné → reject (réservés admin) |
| `affaires` / `missions` | création d'affaire → reject ; update seulement si `affaire.pilote === cid` ; changer le pilote (`affaires`, `new.pilote !== cid`) → reject |
| défaut | reject (filet, `server.py:430`) |

Toutes les comparaisons d'identifiants passent par `String(...)` (`s()`),
à l'identique des `str(...)` de `server.py` — les ids V1 ne sont pas garantis
homogènes en type.

### `affairIdsForUser` — port de `affair_ids_for_user`

```js
affairIdsForUser(projection, consultantId) -> { related: Set, piloted: Set }
```

- `piloted(cid)` : affaires où `cid` est strictement `pilote`.
- `related(cid)` : `piloted` ∪ affaires où `cid` est `piloteCommercial`, crédité
  en `repartitionCommerciale`, ou consultant d'une mission de l'affaire.

## 4.2 `filterProjectionForRole` — port de `filter_state`

Projection de **vue** en lecture, dérivée : ne modifie **jamais** le journal
ni la projection source (clonage via `structuredClone` ou repli JSON).

- `admin`/`owner` : vue intégrale (clone de chaque collection).
- membership absent ou révoqué : vue **vide** — pas de contrat V1 explicite
  pour ce cas en lecture, choix délibérément le plus restrictif.
- `user` (`cid`) :
  - `consultants` : sa fiche complète ; les autres en **forme minimale**
    (sans `tjmBase` réel — forcé à `0` —, sans `tempsPartiel` réel — forcé à
    `[]`) ;
  - `organisations` : seulement celles référencées par une affaire visible ;
  - `affaires` : `id ∈ related` ;
  - `methodes`, `typesTerritoire`, `domainesIntervention`, `categoriesFrais` :
    intégral ;
  - `missions` : `consultantId === cid` **ou** `affaireId ∈ piloted` ;
  - `factures` : `affaireId ∈ piloted` (lecture seule) ;
  - `saisies` : les siennes **ou** rattachées à une mission d'une affaire
    pilotée ;
  - `bordereauxFrais` : les siens ;
  - `notesFrais` : les siens **ou** `affaireId ∈ piloted`.

Ce filtrage de lecture ne fait **jamais** office de sécurité de dernier
recours à lui seul : la même règle de visibilité doit être re-vérifiée côté
`PolicyEngine.evaluate` pour toute écriture, précisément parce qu'une UI (ou
une vue) masquée n'est jamais une sécurité.

## 4.3 Workspace, memberships, rôles (`workspace/`)

### `WorkspaceRuntime` (`workspace.js`)

```js
workspace: { id, name, mode:"local"|"team", createdAt, schemaVersion, storage:{provider, rootId} }
membership: { workspaceId, memberId, googleSubject, email, consultantId, role:"owner"|"admin"|"user", status:"active"|"revoked" }
```

`createLocalWorkspace(name)` produit `storage:{provider:"local", rootId:null}`
— **aucun compte Google requis** en mode Solo. `createTeamWorkspace(name,
storage)` exige un `storage.provider` fourni par l'appelant.

`WorkspaceRuntime` porte l'état runtime (workspace actif + membre actif) :
aucune I/O, aucune dépendance réseau. Le **rôle n'est jamais mémorisé
indépendamment** : `role` est toujours lu depuis le `activeMember` courant
pour LE workspace actif — `loadWorkspace()` invalide d'ailleurs le membre
actif précédent s'il appartenait à un autre workspace. C'est une garantie
structurelle contre une fuite de rôle inter-workspace, pas seulement une
convention documentée.

### `MembershipStore` (`memberships.js`)

Store en mémoire, indexé **d'abord par `workspaceId` puis par `memberId`** —
l'invariant « le rôle n'est jamais global à l'utilisateur » est ainsi garanti
par la structure de données elle-même, pas seulement par convention : une
même personne (même `googleSubject`/`email`) peut avoir des rôles différents
dans des workspaces différents.

`revoke(workspaceId, memberId)` ne **supprime jamais** un membership : il
passe `status` à `"revoked"` (traçabilité). `reactivate()` symétrique existe
(réactivation après révocation — nécessite côté crypto une nouvelle epoch,
hors du ressort de ce module).

`memberId` (identité cryptographique locale) est **distinct** de
`googleSubject` (identifiant du fournisseur d'identité Google, mode Team
uniquement, optionnel en mode Solo).

### Invitations (`invitations.js`)

```js
invitation: { workspaceId, invitationId, expectedGoogleId, role, createdAt,
              expiresAt, nonce, proof, status:"pending"|"consumed"|"revoked" }
```

- Expirante (`DEFAULT_TTL_MS = 7 jours`), révocable avant usage, consommée
  après enrôlement réussi (`consume()` vérifie l'identité Google attendue si
  `expectedGoogleId` est renseigné).
- `createInvitation` accepte un `signer` **optionnel** — une fonction
  produite ailleurs par le vrai `CryptoService.sign`. **Sans `signer`**
  fourni, `proof` retombe sur une **empreinte SHA-256** du contenu canonique
  de l'invitation : ce n'est **pas** une signature d'identité (n'importe qui
  peut recalculer un hash de champs publics), seulement un scellé
  anti-altération minimal — documenté explicitement comme **dette** en
  attendant le branchement du vrai `CryptoService` dans ce module.
- `isValid()` ne vérifie **que** l'expiration et le statut `pending` — la
  vérification cryptographique de `proof` (via `CryptoService.verify`) est
  déléguée à l'appelant, car elle nécessite la clé publique de l'émetteur
  (non modélisée dans ce module).
- Le code visible (lien/QR/texte) n'est jamais `proof` seul ni une clé de
  workspace : c'est `{workspaceId, invitationId, nonce}`, insuffisant pour
  déchiffrer quoi que ce soit sans l'enrôlement complet (validation
  d'identité Google + distribution de clé d'epoch, hors de ce module).
- `consume`/`revoke` sont des transformations **pures** — nouvel objet
  retourné, jamais de mutation de l'original ; la persistance appartient à
  l'appelant.

## 4.4 Multi-workspace

Un membre peut appartenir à plusieurs workspaces avec des rôles différents
(`MembershipStore.listByMember(memberId)` liste tous les memberships d'une
personne, tous workspaces confondus). Le mode d'un workspace (`local`/`team`)
et son rôle actif ne sont jamais partagés entre workspaces — chaque
`WorkspaceRuntime` (ou chaque bascule de workspace actif dans une même
instance) recharge un couple `(workspace, activeMember)` cohérent.
