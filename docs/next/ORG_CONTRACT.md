# Contrat de conception — Point 2 : comptes & organisations (Folder Trusted, signé)

> Modèle de confiance retenu par le porteur : **« Dossier de confiance » —
> événements SIGNÉS (Ed25519) mais NON chiffrés** (payload lisible dans le
> dossier/Drive du client ; la confidentialité repose sur les permissions du SI
> du client). On s'appuie donc sur les primitives de **signature** existantes,
> PAS sur la crypto de chiffrement (qui reste derrière son gate de revue).
>
> Ce contrat couvre le LOT MOTEUR (testable en node, sans UI). L'onboarding UI et
> le câblage multi-membre sur dossier sont un lot séparé (2c).

## 1. Périmètre du lot moteur

DANS le périmètre (fichiers NOUVEAUX, + une option additive à SyncEngine) :
1. **SyncEngine — mode `trusted`** : signer sans chiffrer, vérifier la signature
   sur le payload en clair, sauter le déchiffrement. Le reste du pipeline hostile
   (workspace attendu, signature, schéma, membership, policy, concurrence) est
   INCHANGÉ.
2. **`src/workspace/org-runtime.js`** (nouveau) : fonctions pures composant les
   primitives existantes (`crypto-service`, `memberships`, `invitations`,
   `workspace`) pour : créer une identité de membre, créer une organisation,
   inviter, rejoindre, et construire le `memberRegistry`/`MembershipStore` que
   SyncEngine attend, à partir des « fiches membres » publiées.
3. Tests node (`tests/next/org-runtime.test.mjs`, `tests/next/sync-trusted.test.mjs`).

HORS périmètre (lot 2c) : onboarding UI (compte indépendant / créer / rejoindre),
distribution réelle des fiches membres via le dossier, exécution multi-membre live.
Aucune crypto de CHIFFREMENT (gate). Ne pas modifier app.js/server.py.

## 2. SyncEngine — mode `trusted` (signé, non chiffré)

Ajouter une option `trusted` (défaut `false`) au constructeur `SyncEngine`.
Comportement quand `trusted: true` :
- **push()** : NE PAS appeler `encryptPayload`. Le blob publié = l'enveloppe AVEC
  son `payload` en clair (jamais de `ciphertext`), signé via
  `crypto.sign(privateKeyRef, canonicalize(blob))`. `canonicalize` inclut déjà le
  `payload` (event-schema.js), donc la signature couvre le payload clair.
- **_processIncoming()** : SAUTER l'étape de déchiffrement. `payload = blob.payload`
  (déjà en clair). NE PAS exiger `keyring.get(epoch)`. Toutes les AUTRES étapes,
  DANS LE MÊME ORDRE, restent : envelope, workspace attendu, **verify signature**,
  validate schema, **verify membership** (inconnu/révoqué => rejet), **verify
  policy** (PolicyEngine), concurrence (EventLog.replay).
- **createLocalEvent()** : en `trusted`, `epoch = 1` constant (buildEvent exige
  `epoch>=1`) sans dépendre d'un `keyring` non vide. Le `keyring` devient OPTIONNEL
  en mode trusted.
- Contrainte : le mode par défaut (`trusted:false`) reste STRICTEMENT identique
  (aucune régression des 9 tests sync existants).
- Sécurité : un événement non signé, mal signé, d'un membre inconnu/révoqué, ou
  refusé par la policy DOIT être rejeté exactement comme aujourd'hui — le mode
  trusted enlève la confidentialité, JAMAIS l'authenticité ni le contrôle de rôle.

Tests `sync-trusted.test.mjs` : deux membres (Alice owner, Bob user) sur un
`InMemoryStorageAdapter` partagé, `trusted:true`, SANS clé de workspace :
- convergence : événements en CLAIR dans le blob (assert `blob.payload` présent,
  `blob.ciphertext` absent, `blob.signature` présent), les deux convergent.
- hostile : signature invalide => rejet ; membre révoqué => rejet ; non-membre => rejet.
- policy : un `user` modifiant la saisie d'autrui => rejet (réutilise la policy).

## 3. `org-runtime.js` — API (fonctions pures, réutilise l'existant)

```js
// Identité d'un membre (une personne sur un appareil). Réutilise
// crypto-service.generateMemberIdentity() + un memberId UUID.
export async function newMemberIdentity()
//   -> { memberId, publicKeyJwk, privateKeyRef }

// Crée une organisation : le créateur en est le OWNER.
export function createOrganization({ name, identity, consultantId })
//   -> { workspace: {workspaceId, name, schemaVersion}, ownerMembership, memberRecord }
//   - workspace via workspace.createTeamWorkspace / un id UUID ;
//   - ownerMembership via memberships.createMembership({... role:"owner"}) ;
//   - memberRecord = { memberId, publicKeyJwk, membership } = la « fiche membre »
//     PUBLIABLE (kind:"member") qui permettra aux autres de vérifier signatures + rôle.

// Invitation d'un futur membre (réutilise invitations.createInvitation, signée).
export async function inviteMember({ workspaceId, role, expectedGoogleId, signer, ttlMs })
//   -> invitation  (role ∈ owner|admin|user ; défaut user)

// Rejoindre via une invitation : valide (isValid), consomme (consume, avec
// vérif de l'identité Google attendue le cas échéant), et fabrique la fiche
// membre du nouvel arrivant avec le RÔLE porté par l'invitation.
export async function acceptInvitation({ invitation, identity, consultantId, googleId })
//   -> { membership, memberRecord }  (ou lève si invitation invalide/expirée/révoquée/mauvaise identité)

// Reconstruit les deux collaborateurs attendus par SyncEngine à partir d'une
// liste de fiches membres publiées (kind:"member").
export function buildMemberRegistry(memberRecords)   // -> { getPublicKey(memberId) }
export function buildMembershipStore(memberRecords)  // -> MembershipStore peuplé
```

Décisions :
- Les rôles sont ceux des primitives : `owner`, `admin`, `user`. `owner` =
  gouvernance workspace (membres, invitations) ; en pratique traité comme `admin`
  côté PolicyEngine métier (le PolicyEngine actuel ne connaît que admin/user —
  mapper `owner`→droits admin métier, sans nouveau pouvoir métier).
- `org-runtime` ne fait AUCUNE E/S ni réseau : il produit des objets (workspace,
  membership, memberRecord, invitation) que le lot 2c publiera via le dossier.
- Un « compte indépendant » (solo) = une identité de membre SANS organisation :
  `newMemberIdentity()` seule, pas de workspace partagé.

Tests `org-runtime.test.mjs` :
- createOrganization : le créateur a `role:"owner"`, la fiche membre porte sa clé
  publique et son membership.
- inviteMember + acceptInvitation : le nouvel arrivant reçoit le rôle de
  l'invitation ; une invitation expirée/révoquée/déjà consommée => rejet ; une
  mauvaise identité Google attendue => rejet.
- buildMemberRegistry/Store : à partir de 3 fiches, `getPublicKey` renvoie la
  bonne clé, `MembershipStore.get` le bon rôle/statut ; un membre révoqué est vu révoqué.
- Intégration légère : org-runtime + SyncEngine trusted — Alice (owner) crée l'org,
  invite Bob (user), Bob rejoint ; les fiches membres alimentent registry+store ;
  Alice et Bob échangent des événements signés en clair et convergent ; une
  usurpation (Bob signe un event au nom d'Alice) est rejetée.

## 5. Corrections sécurité — CHAÎNE DE CONFIANCE (bloquant, suite revue red team)

La revue a confirmé que le pipeline d'événements (SyncEngine) est sûr, mais que
les **fiches membres** et **invitations** n'ont AUCUNE racine de confiance :
quiconque écrit dans le dossier peut s'auto-déclarer `admin`. Le modèle « signé »
n'a de sens que si l'AUTORITÉ des rôles est, elle aussi, vérifiée
cryptographiquement. Corrections OBLIGATOIRES :

### 5.1 Racine de confiance = manifeste de genèse (owner)
- `createOrganization` produit, en plus, un **manifeste** immuable :
  `{ workspaceId, ownerMemberId, ownerPublicKeyJwk, createdAt }`, et la fiche
  membre owner porte `authorization: { genesis: true }`.
- Le manifeste est la RACINE : dans le dossier (lot 2c) il est write-once
  (immuable), donc le premier créateur est l'owner incontestable. `buildTrusted*`
  reçoit ce manifeste en ancre de confiance.

### 5.2 Invitations signées et vérifiables, autorité de l'émetteur
- `inviteMember({ workspaceId, role, issuer, issuerMembership, signer, expectedGoogleId, ttlMs })` :
  - EXIGE un `signer` réel (Ed25519 de l'émetteur) — jamais le hash par défaut.
  - VÉRIFIE l'autorité : `issuerMembership.role ∈ {owner, admin}` et actif ;
    `role:"owner"` réservé à un émetteur `owner`. Sinon throw (aucune invitation
    produite).
  - Retourne `{ ...invitation, issuerId }` (issuerId = memberId de l'émetteur,
    porté à côté du proof pour retrouver sa clé de vérification).
- `verifyInvitation(invitation, { registry })` (nouveau) : retrouve la clé
  publique de `invitation.issuerId` via le `registry` DÉJÀ VÉRIFIÉ, vérifie
  `crypto.verify(issuerPubKey, canonicalBytes(invitation), invitation.proof)`,
  et que l'émetteur a l'autorité pour ce rôle. Rejet explicite sinon (émetteur
  inconnu/non autorisé, proof invalide).

### 5.3 Fiche membre adossée à une invitation + preuve du porteur
- `acceptInvitation(...)` produit une fiche membre :
  `{ memberId, publicKeyJwk, membership, authorization: { invitation, joinProof } }`
  où `joinProof = sign(identity.privateKeyRef, canonicalBytes(invitationId, memberId, publicKeyJwk))`
  prouve que le détenteur de `publicKeyJwk` a bien consommé CETTE invitation avec
  CETTE clé (anti-substitution de clé).

### 5.4 Construction VÉRIFIÉE du registre/store (remplace buildMemberRegistry/Store naïfs)
`buildTrustedMembership({ manifest, memberRecords })` -> `{ registry, membershipStore, trusted:[...], rejected:[{record, reason}] }` :
1. Amorcer l'ensemble de confiance avec la GENÈSE (owner du manifeste :
   ownerMemberId -> {publicKey: ownerPublicKeyJwk, role:"owner"}).
2. Point fixe (BFS) : admettre une fiche non-genèse SEULEMENT si TOUTES ces
   vérifs passent :
   - `joinProof` valide (crypto.verify avec la clé de la fiche) ;
   - `invitation` valide via `verifyInvitation` (proof signé par un émetteur
     DÉJÀ dans l'ensemble de confiance ET autorisé pour ce rôle) ;
   - `membership.role === invitation.role` ; `invitation.workspaceId === manifest.workspaceId` ;
   - unicité : le `memberId` n'est pas déjà dans l'ensemble (pas de redéfinition),
     et l'`invitationId` n'a pas déjà servi (anti-rejeu #5a).
   Sinon la fiche est REFUSÉE et JOURNALISÉE dans `rejected` (jamais ignorée en silence).
3. `registry.getPublicKey` / `membershipStore` ne contiennent QUE l'ensemble de confiance.
- Les anciennes `buildMemberRegistry`/`buildMembershipStore` naïves sont
  SUPPRIMÉES (ou deviennent des internes non exportés) : plus aucune API ne doit
  construire un registre à partir de fiches non vérifiées.

### 5.5 Durcissement SyncEngine (défense en profondeur, #2/#6)
- Dans `_processIncoming`, AVANT decrypt/skip, refuser explicitement un blob dont
  le mode ne correspond pas à `this.trusted` : en `trusted:true` un blob AVEC
  `ciphertext` -> rejet `stage:"mode"` ; en `trusted:false` un blob SANS
  `ciphertext` (donc payload clair) -> rejet `stage:"mode"`. Message dédié.

### 5.6 Tests exigés (ajouts à sync-trusted / org-runtime)
- Une fiche membre forgée (rôle admin, aucune invitation valide) est REJETÉE par
  `buildTrustedMembership` (dans `rejected`), et un event signé par ce faux admin
  sur une collection ADMIN_ONLY est refusé (il n'est pas dans le registre/store).
- Une invitation `owner` forgée par un non-owner (ou proof bidon) est rejetée.
- Un `user` invité ne peut pas être promu admin via une fiche forgée.
- joinProof invalide (clé substituée) -> fiche rejetée.
- Rejeu d'une même invitation -> une seule fiche admise, la 2e dans `rejected`.
- Collision de rôle sur un même memberId -> pas de « dernier gagne » : la 2e refusée.
- Blob de mode incohérent -> rejet `stage:"mode"` (les deux sens).
- NON-régression : le scénario légitime (owner crée, invite admin/user signés,
  ils rejoignent, convergent) passe toujours.

## 5bis. Exigences de sécurité REPORTÉES au lot 2c (issues de la re-revue)

Le lot moteur est validé pour ce qu'il couvre (admission de fiches vérifiée,
anti-rejeu, anti-collision, contrôle de mode, 16 vecteurs d'attaque clos). Deux
garanties NE PEUVENT être fournies que par le lot 2c (distribution sur dossier) et
sont **bloquantes avant toute livraison d'organisations réelles** :

1. **Immuabilité du manifeste de genèse.** `buildTrustedMembership` fait confiance
   au `manifest` qu'on lui passe : sa sécurité repose entièrement sur le fait que
   le dossier ne contient qu'UN manifeste, écrit **write-once** et jamais réécrit.
   2c DOIT : écrire le manifeste via `putImmutable("workspace", ...)` (déjà
   write-once), le charger comme racine unique, et refuser/alerter si un second
   manifeste concurrent apparaît. Limite assumée du modèle « Dossier de confiance »
   : quiconque a le droit de SUPPRIMER le fichier manifeste dans le dossier
   partagé contrôle la racine — c'est la responsabilité du SI du client
   (permissions OneDrive/SharePoint), à documenter pour l'utilisateur.
2. **Protocole de révocation signé.** Aujourd'hui, un membre révoqué est bien
   empêché de PUBLIER des événements (SyncEngine lit le `membershipStore` vivant),
   mais l'arbre de confiance des invitations n'a pas de notion de révocation. 2c
   DOIT concevoir une **fiche de révocation signée** par une autorité de rang
   suffisant (owner pour révoquer un admin/owner ; owner/admin pour un user),
   consommée dans le même point fixe BFS que les fiches membres, invalidant les
   invitations émises par le membre révoqué après la date de révocation.
3. **(Durcissement)** Lier `issuerId` dans les octets canoniques signés de
   l'invitation (aujourd'hui la protection tient à l'infalsifiabilité d'Ed25519
   mais `issuerId` voyage hors du proof) — à intégrer quand 2c retouche le format
   d'invitation pour la révocation.

## 4. Contraintes transverses
- Réutiliser les primitives ; ne rien réécrire (crypto, memberships, invitations,
  workspace, permissions, sync). Signaler tout manque plutôt que dupliquer.
- ESM, node ≥20, style et commentaires alignés sur `src/*` (français).
- `npm run test:next` doit rester vert (aucune régression des tests existants).
- Aucune crypto de chiffrement. Aucune modification d'app.js/server.py.
