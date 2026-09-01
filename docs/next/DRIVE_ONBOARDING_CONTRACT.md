# Contrat — Créer une organisation sur Google Drive (onboarding, lot A)

> Rend UTILISABLE le mode Organisation **sur l'API Google Drive** (OAuth), sans
> dossier local — pour que l'onboarding marche partout, **y compris sur mobile**
> (l'API File System Access, elle, ne marche pas sur un dossier Drive synchronisé :
> erreur « A requested file or directory could not be found »). RÉUTILISE tout
> l'existant (Point 2 + Point 4) : la logique d'org est déjà agnostique de
> l'adaptateur. `app.js`/`server.py` intacts. Lot A = **créer + inviter + reprise** ;
> le **rejoindre** (Google Picker) est le lot B, hors de ce contrat.

## 0. Ce qui existe (à réutiliser, NE PAS réécrire)
- `piloteo-org-bridge.mjs#createOrg({handle,name,consultantId})` : `buildAdapter` →
  `createOrganization` → `writeManifest` → `writeMemberRecord` → `openOrgEngine`.
  **Toute cette chaîne opère sur l'interface générique `StorageAdapter`.**
- `src/workspace/org-folder-store.js` (writeManifest/writeMemberRecord/loadTrust) :
  générique (putImmutable/get/exists/listChanges), marche sur n'importe quel adapter.
- `src/storage/google-drive-adapter.js` : `GoogleDriveStorageAdapter` implémente
  `connect/putImmutable/get/exists/listChanges/readMetadata` (Point 4, validé).
- `piloteo-drive-bridge.mjs` : `oauthTokenProvider()` (GIS token), `createDriveEngine
  ({rootFolderId})`, `isAvailable`.
- `local-backend.js` : mode org déjà câblé pour un handle dossier (activateCreateOrg,
  ensureOrgReady, /api/state → engine, 409). On ajoute la **variante Drive**.

## 1. Pont Drive — nouvelles fonctions (`piloteo-drive-bridge.mjs`)
- `async createDriveRootFolder(name)` : crée un dossier Drive `Pilotéo - <name>` via
  `files.create` (mimeType `application/vnd.google-apps.folder`, scope `drive.file`
  suffit — l'app gère les fichiers qu'elle crée), en réutilisant le token
  `oauthTokenProvider()`. Renvoie `{ rootFolderId, webViewLink }`. Mêmes appels REST
  que `tools/team-spike` (endpoints/headers déjà prouvés en vrai navigateur).
- `async createDriveOrg({ name, consultantId })` : `oauthTokenProvider()` (déclenche
  le consentement si besoin) → `createDriveRootFolder(name)` →
  `new GoogleDriveStorageAdapter({ oauthTokenProvider, rootFolderId })` → `connect()`
  → RÉUTILISE la MÊME séquence que `org-bridge#createOrg` (createOrganization +
  writeManifest + writeMemberRecord + openOrgEngine) sur l'adapter Drive. Persiste
  `piloteo_storage_mode="org-drive"` + `rootFolderId` (localStorage/IndexedDB) pour la
  reprise. Renvoie `{ engine, adapter, manifest, rootFolderId }`.
- `async openDriveOrg({ rootFolderId, consultantId })` : rouvre une org Drive existante
  (openOrgEngine sur l'adapter Drive). Pour la **reprise au boot** et pour un futur join.
- `async resumeDriveOrg()` : lit le `rootFolderId` mémorisé ; `null` si aucun ; sinon
  tente `oauthTokenProvider()` **query-only** (token en cache) — si aucun token valide
  sans interaction → `{ needsAuth:true }` (comme `needsPermission` du dossier : l'UI
  affiche « Se reconnecter à Google » et ne déclenche `requestAccessToken()` que dans
  un geste). JAMAIS d'appel OAuth interactif hors geste utilisateur.
- `invite`/`revoke`/`listMembers` : identiques au pont org (le code d'invitation ne
  dépend pas du stockage). Réutiliser tel quel (exposer via le même objet ou déléguer).
- `identité` : la MÊME identité de membre Ed25519 persistée (getOrCreateIdentity du
  pont org) — ne pas en fabriquer une seconde. Exposer un accès partagé ou réutiliser
  `window.PiloteoOrg.getOrCreateIdentity` si présent.

## 2. Câblage `local-backend.js` (additif, symétrique du mode dossier)
- Écran d'accueil : la carte « Créer une organisation » propose désormais **deux
  emplacements** quand `window.PiloteoDrive && window.PiloteoDrive.isAvailable` :
  « Un dossier (ordinateur) » (existant) et « Google Drive (recommandé sur mobile) ».
  Choix Drive → `createDriveOrg({name, consultantId})` (dans le geste du bouton :
  l'OAuth exige une activation utilisateur). Sans `PiloteoDrive.isAvailable` → seul le
  dossier est proposé (inchangé).
- `storageMode==="org-drive"` : `withOrgReady`/`stateRecord`/`putStateUnified` routent
  vers le moteur Drive **exactement comme le mode org dossier** (load/commit, 409 sur
  conflit — réutiliser le mapping existant). `/api/me` : rôle depuis le membership,
  `consultant_id` depuis l'état — inchangé.
- **Reprise au boot** : si `piloteo_storage_mode==="org-drive"` → `resumeDriveOrg()` ;
  `{needsAuth}` → bannière VISIBLE « Se reconnecter à Google » avec bouton qui, DANS le
  clic, relance `oauthTokenProvider()` interactif puis `openDriveOrg`. Jamais d'OAuth
  automatique au chargement (symétrique du correctif permission dossier).
- Réglages → section Organisation : identique (nom, rôle, membres, inviter, révoquer),
  qu'on soit en org dossier ou org-drive.
- Garde-fou : `PiloteoDrive` absent → mode Drive indisponible, le reste marche.

## 3. `index.html` (racine + republié sous /app/)
- Charger, DANS L'ORDRE, AVANT les ponts qui les lisent :
  `<script>window.PILOTEO_GOOGLE_CLIENT_ID="<client id public>";</script>` (client id
  OAuth PUBLIC, autorisé au dépôt public — jamais de client_secret), puis
  `<script src="https://accounts.google.com/gsi/client" async defer></script>`
  (Google Identity Services), puis `<script type="module" src="piloteo-drive-bridge.mjs">`.
- Ces trois ajouts sont IDÉMPOTENTS et ne régressent ni le solo ni le dossier (le pont
  Drive est inerte si `isAvailable=false`, GSI ne fait rien tant qu'on n'appelle pas
  `initTokenClient`).

## 4. Tests
`tests/next/drive-onboarding.test.mjs` (node:test) contre le **FakeDrive** existant
(`tests/next/helpers/fake-drive.mjs`) + le hook `__engineFromAdapter` (pas d'OAuth réel) :
1. `createDriveOrg` (adapter Drive factice injecté) → manifeste + fiche owner écrits ;
   `openDriveOrg` sur le même FakeDrive → mêmes manifeste/membership (rôle owner→admin) ;
   `/api/state` fonctionne ; l'identité est réutilisée (pas de 2e identité créée).
2. Une 2e « identité » qui `openDriveOrg` sur le même FakeDrive voit le manifeste et les
   membres (préfigure le join ; sans Picker ici).
3. `resumeDriveOrg` sans token → `{needsAuth:true}` (JAMAIS d'appel interactif).
4. `invite` génère un code non vide ; chaîne de confiance intacte (fiche forgée rejetée
   — réutiliser un cas du lot org).
`npm run test:next` reste vert.

`docs/next/DRIVE_ONBOARDING_MANUAL.md` : checklist navigateur RÉELLE (l'OAuth interactif
n'est pas automatisable ici) — sur `https://prettozm.github.io/piloteo/app/` avec le
compte test : créer une org Drive, vérifier le dossier créé dans My Drive, inviter (code),
recharger → reprise (bannière « Se reconnecter à Google » puis reprise), écrire des données.

## 5. Contraintes
- `app.js`/`server.py` intacts. Client id OAuth PUBLIC uniquement (jamais de secret,
  jamais de client_secret). Token jamais persisté/loggé (déjà garanti par le pont Point 4).
- RÉUTILISER `createOrganization`/`writeManifest`/`writeMemberRecord`/`openOrgEngine`/
  `GoogleDriveStorageAdapter`/`oauthTokenProvider` — ne réécrire aucune logique d'org ni
  de transport. Le mode dossier/solo/org existant ne régresse pas.
- OAuth interactif UNIQUEMENT dans un geste utilisateur (create/reconnect), jamais au boot.
- Lot A = créer + inviter + reprise. Le **rejoindre sur Drive** (Google Picker pour que
  l'invité accède au dossier partagé sous scope `drive.file`) est explicitement le lot B.
