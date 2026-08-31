# Pilotéo — Audit : comptes, session, réglages et modes (mode solo)

> Audit demandé avant le câblage UI du mode Dossier. Constat de l'écart entre ce
> que l'application solo offre aujourd'hui et ce qu'exige un usage multi-mode
> (Dossier, Google, Serveur) avec identité et session. Sépare le **strict
> nécessaire** (implémenté dans cette passe) du **reste** (proposé).

## 1. État actuel (constaté dans le code)

### Identité / compte
- En mode solo, `local-backend.js` fabrique un **utilisateur admin synthétique**
  (`soloUser`) : toujours `role:"admin"`, `consultant_id` = premier consultant de
  l'état (sur le déploiement neutre : `MOI` / « Moi »). **Aucun compte réel**,
  aucun mot de passe.
- `GET /api/me` et `POST /api/login` renvoient **le même** utilisateur : il n'y a
  ni écran de connexion (jamais de 401), ni notion de « qui suis-je » modifiable.

### Session (connexion / déconnexion)
- Le bouton « Se déconnecter » (`#switch-user`) appelle `POST /api/logout` puis
  `location.reload()`. En solo, `/api/logout` renvoie `ok` et le rechargement
  **re-entre immédiatement** dans le solo. → **La déconnexion est un no-op** : on
  ne peut ni verrouiller, ni changer d'identité, ni se reconnecter.

### Réglages
- Il n'existe **pas** de panneau de réglages applicatifs. « Tables & réglages »
  (V1) concerne les **données de référence** (méthodes, territoires…), pas les
  réglages du compte / du stockage.
- Les seules commandes solo sont une **pastille flottante** Exporter / Importer
  (sauvegarde `.piloteobackup`).

### Stockage / modes
- Le stockage solo est **figé sur IndexedDB** (`piloteo-solo`), au format
  **snapshot** (`/api/state` lit/écrit l'état complet des 12 collections), avec un
  journal d'événements **best-effort** en parallèle.
- **Aucun** sélecteur de mode. Le nouveau `FolderStorageAdapter` (+ port navigateur
  File System Access) et l'adaptateur Google existent et sont **testés**, mais **ne
  sont pas reliés à l'application vivante**.

### Écart structurel majeur (à connaître)
- L'application vivante (`index.html` + `app.js` + `local-backend.js` +
  `piloteo-events.js`) est faite de **scripts classiques** ; le déploiement Pages
  n'embarque **pas** `src/*`. Le moteur canonique `src/*` (event-per-file, adaptateurs
  Dossier/Google, causalité P0.1) **ne peut donc pas être appelé** par l'app solo
  sans, au choix : (a) embarquer `src/*` en ES modules + un pont, ou (b) une étape
  de build. C'est exactement la **convergence** signalée transitoire en P1.
- Conséquence : « brancher le mode Dossier en écriture vive » n'est **pas** une
  simple tâche d'UI — c'est la convergence moteur. Le snapshot unique réécrit ne
  conviendrait pas à un dossier synchronisé multi-appareils (conflits de fichiers,
  ce que l'event-per-file évite justement).

## 2. Strict nécessaire — implémenté dans cette passe

Tout est **injecté côté solo uniquement** (aucun impact sur le mode serveur V1),
dans un panneau **Réglages** (icône engrenage, en bas à droite, qui remplace la
pastille) :

1. **Mon espace (identité)** : nom et trigramme de l'administrateur solo
   **éditables** (persistés dans la fiche consultant admin de l'état). C'est le
   « compte admin » minimal, sans mot de passe factice.
2. **Sauvegarde** : Exporter / Importer déplacés de la pastille vers Réglages
   (« tout en adéquation »).
3. **Stockage & synchronisation** : tableau d'état **honnête** des modes —
   *Cet appareil (IndexedDB)* actif ; *Dossier*, *Google Drive*, *Serveur*
   avec leur statut réel (« moteur prêt et testé, câblage applicatif proposé »).
   Détection de capacité navigateur (File System Access) et de contexte.
4. **Session** : **Verrouiller** l'espace (overlay de reprise) — donne une vraie
   expérience de verrouillage/reprise sans sécurité factice ; la vraie
   authentification est proposée (voir §3).

## 3. Le reste — proposé (non implémenté)

Par ordre de valeur / dépendance :

1. **Store Dossier en écriture vive (convergence moteur)** — faire consommer par
   le chemin solo le moteur `src/*` (LocalStore + EventLog + FolderStorageAdapter)
   via un pont ES modules embarqué avec l'app. Débloque : travailler *depuis* un
   dossier (OneDrive/SharePoint), event-per-file, multi-appareils sans conflit.
   C'est le plus gros élément et le prérequis d'un vrai mode Dossier/équipe.
2. **Vrais comptes multi-utilisateur & rôles** — identité de membre (clé), rôles
   `owner`/`admin`/`user`, plusieurs personnes sur un même espace partagé. Requis
   dès qu'un dossier ou un Drive est **partagé**.
3. **Authentification & session réelles** — connexion/déconnexion/reconnexion avec
   une vraie identité (et, en mode Serveur, le login V1 existant). Remplace le
   verrouillage minimal du §2.4.
4. **Google Drive en écriture vive** — câblage REST réel (après le pont moteur du
   point 1), activable par `GOOGLE_CLIENT_ID`.
5. **Migration à la bascule de mode** — convertir l'état solo IndexedDB en journal
   d'événements dans le dossier/Drive choisi, proprement, à l'activation.
6. **Assistant de choix de mode** (le « déployeur », déjà spécifié dans
   `docs/DEPLOYER_CONTRACT.md`) — poser la question des 4 modes et écrire la config.

## 4. Recommandation de séquence

Point 1 (convergence moteur / store Dossier live) **avant** 2–5 : c'est lui qui
rend le mode Dossier réellement utilisable et sur lequel reposent comptes,
partage et Google. Les points 2–3 (comptes/auth) viennent avec le partage. La
crypto reste **expérimentale** (revue de sécurité dédiée) — cf.
`docs/architecture/CRYPTO_TRUSTED_VS_ENCRYPTED.md`.
