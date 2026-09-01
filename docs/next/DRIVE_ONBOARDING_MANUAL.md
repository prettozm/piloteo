# Créer une organisation sur Google Drive — checklist navigateur RÉELLE (onboarding, lot A)

> L'OAuth Google Identity Services (GIS) exige une interaction utilisateur
> réelle (fenêtre de consentement) dans un VRAI navigateur : il ne peut PAS
> être automatisé dans cet environnement d'exécution. Ce document est donc une
> **checklist manuelle**, à dérouler par une personne, avec son propre compte
> Google.
>
> Tout ce qui est câblé et vérifiable SANS navigateur (chaîne d'org
> créer/inviter/reprendre sur un adaptateur Drive déjà construit, réutilisation
> de l'identité partagée, chaîne de confiance, gating `GOOGLE_CLIENT_ID`,
> `resumeDriveOrg` sans token) est couvert par
> `tests/next/drive-onboarding.test.mjs` (FakeDrive + hooks de test, aucun
> OAuth réel, `npm run test:next`) — **ne pas re-dérouler ces cas ici**. Cette
> checklist ne couvre QUE ce qui ne peut être vérifié qu'en conditions
> réelles : l'obtention interactive d'un token, la création RÉELLE d'un
> dossier sur le Drive d'un compte, et le parcours UI complet dans
> `local-backend.js`.

## 0. Client ID OAuth utilisé pour ces tests

```
940162140944-llbfni295begfk20egmvnuqd9sc37cj8.apps.googleusercontent.com
```

Même Client ID public que `tools/team-spike/index.html` et
`docs/next/DRIVE_LIVE_MANUAL.md` (scope `drive.file`, SPA, sans
`client_secret`) — désormais baké directement dans `index.html` (§3 du
contrat), aucune manipulation manuelle requise pour l'activer. Il doit être
déclaré, côté console Google Cloud, avec les **origines JavaScript
autorisées** correspondant à l'URL réellement servie (ex :
`https://prettozm.github.io`).

## 1. Prérequis

- Navigateur Chromium desktop (Chrome/Edge/Opera) OU mobile (le mode Drive
  est justement celui qui doit fonctionner sur mobile, contrairement au mode
  Dossier/File System Access) — vérifier les deux si possible.
- Un compte Google de test « utilisateur de test » sur l'écran de consentement
  OAuth du projet GCP associé au Client ID ci-dessus.
- Un second compte Google (pour vérifier qu'une invitation générée est bien
  un simple code hors-bande, sans dépendre de ce second compte pour CE lot —
  le rejoindre effectif sur Drive, via Google Picker, est le lot B).
- Pilotéo servi en HTTPS depuis une origine déclarée (`https://prettozm.github.io/piloteo/app/`
  pour la recette, ou tout serveur statique HTTPS/`localhost` déclaré).

## 2. Créer une organisation sur Google Drive

- [ ] Ouvrir Pilotéo sur un appareil/compte SANS organisation ni dossier actif
      (premier lancement, ou après « Revenir à cet appareil » en Réglages) —
      l'écran d'accueil (« Bienvenue sur Pilotéo ») s'affiche.
- [ ] Sur la carte « Créer une organisation », vérifier que DEUX emplacements
      sont proposés : « Un dossier (ordinateur) » et « Google Drive
      (recommandé sur mobile) » (ce second choix n'apparaît que si
      `window.PiloteoDrive.isAvailable === true`, à vérifier dans la console).
- [ ] Saisir un nom d'organisation, choisir « Google Drive », cliquer sur
      « Créer l'organisation » : la fenêtre de consentement Google s'ouvre
      **immédiatement** (dans le même geste que le clic, jamais un délai
      perceptible qui ferait échouer l'activation utilisateur).
- [ ] Choisir le compte de test A, accorder l'accès (scope `drive.file`
      uniquement — vérifier que l'écran de consentement NE demande PAS un
      accès à tout le Drive).
- [ ] Une fois créée, l'app annonce « Organisation créée » puis recharge.
      Après rechargement, vérifier dans **My Drive** du compte A qu'un dossier
      `Pilotéo - <nom saisi>` existe, avec son arborescence `workspace/`,
      `members/`, `events/`, `keys/`, `licenses/` (noms opaques à l'intérieur,
      jamais de nom de client/consultant en clair).
- [ ] Réglages → section Organisation : le nom, le rôle (« Propriétaire ») et
      la liste des membres (vous-même) s'affichent — IDENTIQUE à ce que montre
      le mode Organisation dossier.
- [ ] Saisir une donnée (ex : une saisie de temps) ; vérifier qu'un fichier
      `<eventId>.piloteo` apparaît dans `events/<AAAA-MM>/` sur Drive.

## 3. Inviter

- [ ] Depuis Réglages → Organisation, choisir un rôle et cliquer
      « Inviter » : un code non vide s'affiche (zone de texte, à copier).
- [ ] Vérifier qu'**aucun fichier** n'est déposé sur Drive au moment de
      l'invitation (le code est transmis hors bande — comme pour le mode
      dossier).
- [ ] (Best-effort, lot B non requis ici) : décoder le code manuellement
      (base64url d'un JSON) et vérifier visuellement qu'il porte bien
      `role`, `workspaceId`, `proof` — confirme que le format est le MÊME que
      pour une invitation dossier.

## 4. Reprise (reconnexion Google)

- [ ] Recharger la page (F5) juste après avoir créé l'organisation : une
      bannière visible « Se reconnecter à Google » apparaît **immédiatement**
      au chargement (le token n'est jamais persisté d'un rechargement à
      l'autre) — **vérifier qu'AUCUNE fenêtre Google ne s'ouvre toute seule**
      avant le clic (DevTools → Network : aucune requête vers
      `accounts.google.com`/`googleapis.com` avant l'action de l'utilisateur).
- [ ] Cliquer sur le bouton de la bannière : la fenêtre Google s'ouvre (ou un
      rafraîchissement silencieux si la session Google est encore active côté
      navigateur) ; une fois autorisé, l'app recharge et retrouve les données
      de l'organisation (la saisie créée au §2 est toujours là).
- [ ] Couper le réseau (DevTools → Offline) puis recharger : la bannière de
      reprise doit s'afficher proprement (pas de blocage indéfini), avec un
      message clair si la reconnexion échoue hors ligne.

## 5. Garde-fous à vérifier explicitement

- [ ] Sur un navigateur/contexte où `PILOTEO_GOOGLE_CLIENT_ID` est absent (ou
      la page chargée sans script GSI), la carte « Créer une organisation »
      ne propose QUE « Un dossier (ordinateur) » — comportement du mode
      dossier/solo strictement inchangé.
- [ ] Le mode Dossier (File System Access) et le mode Solo restent
      utilisables normalement après ces changements (aucune régression) :
      créer/rejoindre une organisation SUR DOSSIER fonctionne comme avant.
- [ ] Dans les DevTools → Network, sur TOUT le parcours ci-dessus, le token
      d'accès n'apparaît QUE dans l'en-tête `Authorization` des requêtes
      `googleapis.com` — jamais dans une URL, jamais loggé en console, jamais
      visible dans `localStorage`/IndexedDB (seuls `piloteo_storage_mode` et
      l'id du dossier racine y sont persistés, jamais le token).

## 6. Ce que cette checklist NE re-teste PAS (déjà couvert automatiquement)

`tests/next/drive-onboarding.test.mjs` couvre déjà, sans navigateur ni OAuth
réel (FakeDrive + hooks `__createOrgOnAdapter`/`__openOrgOnAdapter`) : la
chaîne `createOrganization`+`writeManifest`+`writeMemberRecord`+`openOrgEngine`
sur un adaptateur Drive, la reprise (`openDriveOrg`) retrouvant le même
manifeste/membership, `engine.load()`/`commit()` (le contrat `/api/state`),
la réutilisation de l'identité partagée (`window.PiloteoOrg.getOrCreateIdentity`,
jamais une seconde identité), une invitation/acceptation complète (préfigurant
le join, sans Picker), le rejet d'une fiche forgée (chaîne de confiance
intacte), la révocation, et `resumeDriveOrg()` sans token en cache renvoyant
`{needsAuth:true}` sans jamais déclencher d'appel OAuth interactif. Ne pas
re-dérouler ces cas manuellement — cette checklist est réservée à ce que SEUL
un navigateur réel avec un vrai compte Google peut prouver (consentement
interactif, création réelle sur Drive, parcours UI complet).

Le **rejoindre sur Drive** (sélection du dossier partagé via Google Picker,
pour qu'un invité y accède sous scope `drive.file`) est explicitement le
**lot B**, hors de ce document.
