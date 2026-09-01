# Contrat — Point 2c-B : distribution des organisations sur dossier + sync multi-membre

> Câble le moteur d'organisation (org-runtime, chaîne de confiance, révocation) et
> le `SyncEngine` mode `trusted` sur un DOSSIER partagé (`FolderStorageAdapter`),
> pour que PLUSIEURS membres convergent avec rôles appliqués. Lot testable en
> node (NodeFsPort sur dossier temporaire). Pas d'UI (lot 2c-C). Pas de crypto de
> chiffrement (Folder Trusted, signé).

## 1. Disposition sur le dossier (réutilise les `kind` existants — AUCUN changement du contrat de stockage)

- **Manifeste de genèse** : `putImmutable("workspace", "manifest", manifest)` —
  write-once (le premier créateur gagne, immuable ; racine de confiance).
- **Fiches membres** : `putImmutable("member", memberId, memberRecord)` — une par
  membre, immuable.
- **Fiches de révocation** : stockées AUSSI sous le kind `"member"`, avec un id
  distinct préfixé `"revocation-" + revocationId` et un champ `kind:"revocation"`
  dans le blob. Ainsi AUCUN nouveau `kind` de stockage n'est ajouté (pas de
  modification de storage-adapter.js / google-drive-adapter.js / in-memory).
- **Événements métier** : `events/AAAA-MM/<eventId>.piloteo` (déjà géré par
  FolderStorageAdapter + le SyncEngine).

Le tri se fait à la lecture : un blob du kind `member` est une fiche membre si
`blob.kind==="member"`, une révocation si `blob.kind==="revocation"`.

## 2. `src/workspace/org-folder-store.js` (nouveau)

Persistance de la GOUVERNANCE sur un `adapter` (FolderStorageAdapter) :
```js
export async function writeManifest(adapter, manifest)
//   putImmutable("workspace","manifest",manifest) ; si déjà présent -> throw
//   "un manifeste existe déjà" (première écriture gagne, cf. sécurité §5.1 ORG_CONTRACT).
export async function readManifest(adapter)         // -> manifest | null
export async function writeMemberRecord(adapter, record)   // putImmutable("member", record.memberId, {...record, kind:"member"})
export async function writeRevocation(adapter, revocation) // putImmutable("member", "revocation-"+revocation.revocationId, {...revocation})
export async function listGovernance(adapter)
//   -> { manifest, memberRecords:[...], revocations:[...] }  (lit tous les blobs kind:member, dispatche par blob.kind)
export async function loadTrust(adapter)
//   -> { manifest, registry, membershipStore, trusted, revoked, rejected }
//   = listGovernance -> buildTrustedMembership({manifest, memberRecords, revocations}).
//   Si aucun manifeste -> throw "dossier sans organisation".
```
Ajout : `revocationId` (UUID) sur les fiches de révocation produites par
`createRevocation` (org-runtime) si absent — pour l'adressage fichier. (Si
org-runtime ne le fournit pas, l'ajouter côté org-runtime OU générer ici, en le
signalant ; NE PAS changer les octets signés — le revocationId n'a pas à être
dans le proof, l'adressage fichier est hors chaîne de confiance.)

## 3. `src/workspace/org-sync.js` (nouveau) — SyncEngine trusted prêt à l'emploi

```js
export async function openOrgSync({ adapter, identity, consultantId })
//   1. loadTrust(adapter) -> registry, membershipStore, manifest.
//   2. VÉRIFIE que `identity.memberId` est dans `membershipStore` du workspace
//      manifest.workspaceId et non révoqué -> sinon throw "non membre / révoqué".
//   3. construit et retourne un SyncEngine `trusted:true` :
//        new SyncEngine({ adapter, eventLog:new EventLog(), crypto, keyring:null,
//          policy, memberRegistry:registry, membershipStore,
//          actor:{ workspaceId: manifest.workspaceId, memberId: identity.memberId,
//                  privateKeyRef: identity.privateKeyRef }, trusted:true })
//   -> { engine, manifest, membership }.
```
Le `memberRegistry` fourni au SyncEngine est celui de `loadTrust` (getPublicKey
vérifié). Le `membershipStore` idem (rôles vérifiés + statuts révoqués). Ainsi le
pipeline hostile du SyncEngine (signature/membership/policy) s'appuie sur la
chaîne de confiance, pas sur des fiches brutes.

## 4. Tests exigés (`tests/next/org-folder.test.mjs`, NodeFsPort sur mkdtemp)

Scénario multi-membre bout-en-bout sur UN dossier partagé :
1. Alice `createOrganization` -> `writeManifest` + `writeMemberRecord(owner)`.
   Un 2e `writeManifest` (attaquant) -> throw (write-once, premier gagne).
2. Alice `inviteMember(Bob, "user")` (signée) ; Bob `acceptInvitation` ->
   `writeMemberRecord(bob)`. `loadTrust` -> Alice owner, Bob user, 0 rejected.
3. `openOrgSync` pour Alice et Bob (chacun son EventLog, même dossier).
   Alice crée un event `saisies` -> push. Bob pull -> converge (voit la saisie).
4. **Rôle appliqué** : Bob (user) tente un event sur `consultants` (ADMIN_ONLY)
   -> push par Bob, pull par Alice -> rejeté (`stage:"policy"`), jamais appliqué.
5. **Signature vérifiée** : un event forgé signé par une identité hors registre
   -> rejeté (`stage:"signature"`).
6. **Révocation** : Alice `createRevocation(Bob)` -> `writeRevocation`. `loadTrust`
   -> Bob `status:"revoked"`. `openOrgSync(Bob)` -> le SyncEngine d'Alice rejette
   désormais les nouveaux events de Bob (`stage:"membership"`).
7. **Non-membre** : `openOrgSync` avec une identité inconnue -> throw.

Toute la suite `npm run test:next` reste verte.

## 5. Contraintes
- Réutiliser org-runtime, FolderStorageAdapter, SyncEngine, crypto-service,
  permissions ; ne rien réécrire. Ne pas ajouter de `kind` de stockage.
- ESM, node ≥20, style `src/*`. app.js/server.py intacts. Mode chiffré inchangé.
- Ne PAS toucher l'UI (2c-C). Ne PAS câbler dans local-backend.js (2c-C).
