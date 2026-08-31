# Spike Google Drive (Phase 6)

Page de test **autonome** qui valide, avec un vrai compte Google, la chaîne
d'équipe : connexion Google Identity Services → création d'un espace sur le Drive
du créateur → publication d'un **événement chiffré** (AES-256-GCM) → relecture et
déchiffrement → preuve que le fichier stocké sur Drive est **illisible** sans la
clé. Aucun backend : le navigateur parle directement à l'API Drive REST.

## Prérequis (déjà fait)
- Projet Google Cloud avec **API Drive activée**.
- Écran de consentement OAuth (External, en Testing) avec le compte testeur ajouté
  en **test user**, scope **`drive.file`**.
- ID client OAuth **Web** dont les **origines JavaScript autorisées** incluent
  l'origine où cette page est servie (ex. `https://prettozm.github.io`).

Le Client ID est renseigné en dur dans `index.html` (constante `CLIENT_ID`) — il
est **public**, aucun secret n'est nécessaire.

## Lancer le test
La page **doit** être servie depuis une **origine autorisée** dans l'ID client
(pas en `file://`, pas depuis un autre domaine) :

- **Sur GitHub Pages** : place ce dossier dans le dépôt qui sert Pages, puis ouvre
  `https://<compte>.github.io/piloteo/tools/team-spike/`.
- **En local** : `python3 -m http.server 8080` puis `http://localhost:8080/tools/team-spike/`
  (l'origine `http://localhost:8080` doit être ajoutée aux origines autorisées).

Puis clique les étapes 1→4. À la fin, un verdict vert confirme que tout marche.

## Ce que ça prouve / ne prouve pas
- ✅ OAuth navigateur (token model), scope `drive.file`, création de dossiers,
  upload/list/download REST, round-trip de chiffrement, confidentialité sur Drive.
- ❓ **Reste à éprouver** (Phase 7) : l'accès d'un **membre invité** à un dossier
  qu'il n'a pas créé sous `drive.file` (nécessite peut-être un passage par le
  Google Picker à l'enrôlement) — c'est le spike suivant, à faire à deux comptes.

## Après le spike
Une fois ce test vert, la même logique (identité Google + adaptateur Drive REST)
est portée dans le vrai module `src/storage/google-drive-adapter.js` et branchée
dans les parcours « Créer un espace » / « Rejoindre ». Le chiffrement multi-membres
reste soumis à une **revue sécurité humaine** avant toute promesse commerciale.
