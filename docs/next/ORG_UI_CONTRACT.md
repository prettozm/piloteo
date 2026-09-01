# Contrat — Point 2c-C2 : onboarding UI + câblage mode Organisation

> Rend les organisations UTILISABLES dans le navigateur : écran de premier
> lancement (compte indépendant / créer une organisation / rejoindre) + section
> « Organisation » dans Réglages, et câblage du mode ORG dans `local-backend.js`
> via un pont ES modules, EN RÉUTILISANT le pont org-engine (2c-C1). `app.js`
> reste inchangé. Additif : le mode solo/dossier existant n'est pas régressé.

## 1. Pont ES (`piloteo-org-bridge.mjs`, racine, `type=module`)

Expose `window.PiloteoOrg` :
```js
{
  hasFileSystemAccess,                 // bool
  async getOrCreateIdentity(),         // identité membre Ed25519 PERSISTÉE (IndexedDB) : {memberId, publicKeyJwk, privateKeyRef}
  async createOrg({ handle, name, consultantId }),   // pick déjà fait -> writeManifest+writeMemberRecord ; renvoie {engine, manifest}
  async joinOrg({ handle, invitation, consultantId }),// acceptInvitation + writeMemberRecord ; renvoie {engine, manifest}
  async openOrg({ handle, consultantId }),           // openOrgEngine sur un dossier déjà organisation ; renvoie {engine, manifest, membership}
  async invite({ engine, adapter, role, ttlDays }),  // owner/admin -> {invitation, code}  (code = JSON base64url à transmettre)
  async revoke({ engine, adapter, memberId }),        // écrit une fiche de révocation
  async listMembers(engine),           // [{memberId, consultantId, role, status}]
  __identityStore, __openOrgEngineFromHandle  // hooks de test
}
```
- L'IDENTITÉ (memberId + clés) est générée une fois via
  `cryptoService.generateMemberIdentity()` et PERSISTÉE en IndexedDB (le
  `privateKeyRef` est un `CryptoKey` non-extractible, structured-cloneable ->
  stockable). Une même personne/appareil garde son identité entre sessions.
- `createOrg`/`joinOrg`/`openOrg` construisent un `FolderStorageAdapter` sur le
  `FileSystemDirectoryHandle` (`createFsAccessPort`) et un « org engine »
  (openOrgEngine, 2c-C1). Le handle est mémorisé (fsaccess-handle-store) + le
  mode (`localStorage piloteo_storage_mode="org"`).
- `invite` : `inviteMember` (signé par l'identité locale, autorité vérifiée) ->
  écrit l'invitation ? NON : l'invitation est un CODE transmis hors bande
  (copier-coller/lien), pas un fichier du dossier. Renvoie le code encodé.

## 2. `local-backend.js` (additif — comme le mode Dossier de 1b)

- Nouveau `storageMode==="org"` : `withFolderReady`/`stateRecord`/`putStateUnified`
  routent vers l'`org engine` (load/commit) quand il est actif, exactement comme
  le mode `folder`. Conflit/échec (commit.ok=false, `conflicts`) -> `PUT /api/state`
  renvoie **409** avec l'état rechargé + libellés (réutilise le mapping de 1b).
- `/api/me` en mode org : `consultant_id` vient de l'état du dossier org (via
  `stateRecord`) ; le rôle (`role`) = celui du membership de l'identité locale
  (owner/admin -> "admin" ; user -> "user") pour qu'app.js applique ses permissions
  d'affichage. (app.js lit `user.role`.)
- Reprise au boot : si `piloteo_storage_mode==="org"`, reprendre le dossier org
  mémorisé (permission éventuelle à redemander -> bannière visible, comme 1b).
- Garde-fou : si `window.PiloteoOrg` absent (module non chargé) -> mode org
  indisponible, le classique fonctionne.

## 3. Onboarding UI (injecté par local-backend.js, solo uniquement)

- **Écran de premier lancement** : au tout premier démarrage (aucune donnée ET
  aucun mode mémorisé), afficher un écran d'accueil avec 3 cartes :
  1. « Utiliser seul (cet appareil) » -> mode classique actuel.
  2. « Créer une organisation » -> choisir un dossier + nom -> createOrg -> reload.
  3. « Rejoindre une organisation » -> choisir le dossier partagé + coller le code
     d'invitation -> joinOrg -> reload.
  Sur navigateur sans File System Access, les options 2/3 sont désactivées avec
  une explication (Chrome/Edge/Opera ordinateur).
- **Section « Organisation » dans le panneau Réglages** (existant) : quand un mode
  org est actif, afficher le nom de l'org, le rôle, la liste des membres, et pour
  un owner/admin : « Inviter » (génère un code à copier) et « Révoquer » (avec
  AVERTISSEMENTS : révoquer un owner/l'owner racine a un rayon d'explosion total ;
  révoquer un admin retire les membres qu'il a invités — cf. ORG_REVOCATION §6).
  Quand aucun mode org : un bouton « Créer / rejoindre une organisation » qui
  ouvre le même flux que l'écran d'accueil.

## 4. Tests
- Smoke Playwright `tests/e2e/org-onboarding.mjs` (statique + Chromium, comme
  solo-folder.mjs) : via les hooks `__openOrgEngineFromHandle` + un
  `FileSystemDirectoryHandle` factice en mémoire injecté :
  1. l'écran d'accueil s'affiche au premier lancement ; le mode classique démarre
     toujours (non-régression) ;
  2. « Créer une organisation » (handle factice) -> identité générée+persistée,
     manifeste écrit, `/api/me` renvoie un role admin, `/api/state` fonctionne ;
  3. `invite` génère un code non vide ;
  4. une 2e identité `joinOrg` sur le même handle (avec le code) -> devient membre,
     voit les données ;
  5. `PUT /api/state` d'un user sur une entité admin-only -> 409 (pas 200).
- `npm run test:next` reste vert (le pont/bridge n'ajoute pas de tests node
  obligatoires, mais ne casse rien).

## 5. Contraintes
- app.js/server.py intacts. Chemin classique (solo/dossier) inchangé.
- Réutiliser org-engine, org-runtime, org-folder-store, fsaccess-port,
  fsaccess-handle-store, crypto-service. Ne rien réécrire.
- pages.yml embarque `piloteo-org-bridge.mjs` (src/ déjà embarqué en 1b).
