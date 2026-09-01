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

## 4. Contraintes transverses
- Réutiliser les primitives ; ne rien réécrire (crypto, memberships, invitations,
  workspace, permissions, sync). Signaler tout manque plutôt que dupliquer.
- ESM, node ≥20, style et commentaires alignés sur `src/*` (français).
- `npm run test:next` doit rester vert (aucune régression des tests existants).
- Aucune crypto de chiffrement. Aucune modification d'app.js/server.py.
