# Pilotéo — Contrat du « déployeur »

Ce document définit le **contrat** du futur *déployeur* de Pilotéo : l'assistant
d'installation qui choisit un mode d'usage et écrit la configuration runtime. Il
ne décrit **pas** un installeur déjà construit — il spécifie **ce que ce
déployeur devra faire**, et surtout ce qu'il ne devra jamais faire.

Contrat de configuration de référence (source de vérité, ne rien inventer qui en
diverge) : `src/config/runtime-config.js`. Traduction config → adaptateur de
stockage : `src/storage/storage-factory.js`.

---

## 1. Principe : une seule question, quatre réponses

Le déployeur pose **une** question à l'installateur :

> **« Comment souhaitez-vous utiliser Pilotéo ? »**

avec exactement quatre réponses :

1. **Local** — un seul poste, hors ligne, aucune synchronisation.
2. **Dossier partagé** — les données vivent dans un dossier, synchronisé par une
   infrastructure externe (OneDrive, SharePoint via OneDrive, Google Drive
   Desktop, Dropbox, NAS…).
3. **Google Drive** — les données vivent dans Google Drive via l'API Drive.
4. **Hébergement serveur** — un backend hébergé (le serveur V1 `server.py`).

À partir de ce choix, le déployeur ne fait **que** quatre choses :

- **choisir** le mode (la réponse ci-dessus) ;
- **valider** les prérequis de ce mode (voir §4) ;
- **écrire** la configuration runtime normalisée (voir §2) ;
- **lancer éventuellement** le package Hosted, dans le seul cas du mode 4
  (voir `docs/deployment/HOSTED_GENERIC.md`).

Le déployeur **ne réimplémente jamais le métier**. Il ne touche ni au moteur, ni
au format des événements, ni à la crypto, ni à la projection. Il produit un objet
de configuration ; Pilotéo le lit et choisit seul le bon chemin. Toute logique
au-delà de « choisir / valider / écrire / lancer » est **hors périmètre** (§5).

---

## 2. Configuration produite pour chaque mode

Le déployeur écrit une configuration **exactement** dans la forme normalisée de
`runtime-config.js` (fonction `normalizeConfig`). Il existe **quatre modes**
d'usage, portés par **trois valeurs de `mode`** (`local` | `shared` | `hosted`),
car « Dossier partagé » et « Google Drive » sont deux *providers* du même mode
`shared`.

### Local

```js
{ mode: "local", storage: { provider: "indexeddb" } }
```

### Dossier partagé

```js
{ mode: "shared", storage: { provider: "folder" } }
```

### Google Drive

```js
{ mode: "shared", storage: { provider: "google-drive", googleClientId: "..." } }
```

Le `googleClientId` peut être **absent** (`null`) : voir le gating Google (§3).

### Hébergement serveur

```js
{ mode: "hosted", endpoint: "https://..." }
```

`endpoint` doit être une URL `http`/`https` (validée par `normalizeConfig`).

### Variante « variables d'environnement plates »

`runtime-config.js` fournit `configFromEnv(env)` qui construit la config
normalisée à partir de variables **plates** (par exemple `process.env` côté Node,
ou un objet injecté côté navigateur). C'est la forme la plus commode pour un
déployeur non interactif (script, CI, image). Variables lues :

| Variable | Rôle | Défaut / effet |
|---|---|---|
| `PILOTEO_MODE` | `local` \| `shared` \| `hosted` | `local` si absent |
| `PILOTEO_STORAGE` | provider du mode `shared` : `folder` \| `google-drive` | déduit : `google-drive` si `GOOGLE_CLIENT_ID` présent, sinon `folder` |
| `GOOGLE_CLIENT_ID` | identifiant public d'app OAuth (mode Google) | `null` si absent → Google non câblé (§3) |
| `PILOTEO_ENDPOINT` | URL du backend (mode `hosted`) | requis en mode `hosted` |

Exemples :

```sh
PILOTEO_MODE=local                                                            # Local
PILOTEO_MODE=shared PILOTEO_STORAGE=folder                                    # Dossier partagé
PILOTEO_MODE=shared PILOTEO_STORAGE=google-drive GOOGLE_CLIENT_ID=xxx.apps... # Google réel
PILOTEO_MODE=hosted PILOTEO_ENDPOINT=https://piloteo.exemple.fr               # Hosted
```

Interactif ou plat, le résultat est **la même** config normalisée. Le déployeur
peut donc écrire directement l'objet de §2, ou déposer ces variables et laisser
`configFromEnv` les normaliser.

---

## 3. Gating Google (§10)

Le comportement Google est **entièrement décidé par la configuration** et
appliqué par `storage-factory.js` ; le déployeur n'a rien à câbler d'autre que la
présence, ou non, du `googleClientId`.

- **`google-drive` SANS `googleClientId`** → l'usine de stockage retombe sur un
  **adaptateur mémoire/fake** (`InMemoryStorageAdapter`, `effective:
  "in-memory-fake"`). **Aucun appel réseau Google** n'est émis. Le moteur ne
  dépend jamais d'un vrai projet GCP. C'est l'état par défaut tant que le client
  id n'est pas renseigné.
- **`google-drive` AVEC `googleClientId`** → Google **réel**
  (`GoogleDriveStorageAdapter`, `effective: "google-drive"`). Cet état exige, en
  plus du client id dans la config, un **fournisseur de token OAuth** câblé
  **côté application** (`deps.oauthTokenProvider`, renvoyant un access token de
  portée `drive.file`). Ce fournisseur n'est **pas** dans le ressort du
  déployeur : il fait partie de l'app, pas de la configuration.

> **Le `googleClientId` n'est PAS un secret.** C'est l'**identifiant public**
> d'une application OAuth. Il peut figurer en clair dans la configuration écrite
> par le déployeur, dans un dépôt, ou dans le bundle navigateur. Le déployeur ne
> manipule **aucun** secret (aucun *client secret*, aucun token, aucune clé).

---

## 4. Par mode : données, prérequis, validation

### Local

- **Où vivent les données ?** Dans **IndexedDB** du navigateur, directement.
  Aucun `StorageAdapter`, aucune synchronisation (mono-utilisateur, hors ligne).
- **Prérequis :** un navigateur avec IndexedDB (tous les navigateurs modernes).
- **Ce que le déployeur valide :** rien de plus ; c'est le mode par défaut et le
  plus simple. Il écrit la config Local et s'arrête.

### Dossier partagé

- **Où vivent les données ?** Dans un **dossier** choisi par l'utilisateur, sous
  forme de fichiers `.piloteo` **immuables** (un événement = un fichier). La
  **synchronisation du dossier** est à la charge de l'utilisateur/l'organisation
  (OneDrive, SharePoint via OneDrive, Drive Desktop, Dropbox, NAS…), **jamais**
  de Pilotéo. Détails : `docs/modes/FOLDER_STORAGE.md`, cas SharePoint :
  `docs/SHAREPOINT_FOLDER_STORAGE_STUDY.md`.
- **Prérequis :** un **navigateur Chromium desktop** (Chrome, Edge, Opera…) pour
  la File System Access API ; Firefox et Safari sont hors périmètre sans wrapper
  desktop. Un **dossier accessible** en écriture ; s'il est synchronisé, ses
  fichiers doivent rester **disponibles hors ligne** (voir FOLDER_STORAGE §5).
- **Ce que le déployeur valide :** navigateur Chromium desktop, et existence /
  accessibilité du dossier cible. Il écrit la config Dossier. Le choix effectif
  du dossier (picker) et le câblage UI relèvent de l'app, pas du déployeur.

### Google Drive

- **Où vivent les données ?** Dans **Google Drive**, via l'API Drive (portée
  `drive.file`), lorsque Google est réellement câblé (§3). Sans client id, en
  **mémoire** uniquement (fake, aucune donnée envoyée à Google).
- **Prérequis :** un **`googleClientId`** (identifiant public d'app OAuth) et un
  **fournisseur de token OAuth** `drive.file` fourni **par l'app**.
- **Ce que le déployeur valide :** présence et forme du `googleClientId` (chaîne
  non vide, ou absent). Il **n'installe pas** le token provider (rôle de l'app).
  Sans client id, il documente clairement que le mode retombe en fake mémoire.

### Hébergement serveur

- **Où vivent les données ?** Sur le **backend V1** (`server.py` + SQLite
  persistante), à l'URL `endpoint`. Pas de `StorageAdapter` local-first.
- **Prérequis :** un backend accessible en HTTPS. Détails et **package unique
  portable** : `docs/deployment/HOSTED_GENERIC.md` (source de vérité du
  déploiement hébergé — Fly, OVH/VPS n'en sont que des exemples de lancement).
- **Ce que le déployeur valide :** que `endpoint` est une URL `http`/`https`
  valide. C'est le **seul** mode où le déployeur peut **lancer** un package (le
  package Hosted) ; il délègue alors intégralement à HOSTED_GENERIC.

---

## 5. Hors périmètre

- **Ne pas construire un gros installeur universel dans cette passe.** L'objectif
  immédiat est **ce contrat documenté**, pas un binaire d'installation
  multi-plateforme. Le déployeur concret viendra après, et devra se conformer à
  ce contrat.
- **Ne pas réimplémenter le métier.** Le déployeur reste cantonné à
  « choisir / valider / écrire / lancer ». Moteur, format d'événements, crypto,
  projection, synchronisation : **hors de son ressort**.
- **Ne pas manipuler de secret.** Le seul identifiant Google touché est **public**
  (client id). Aucun token, mot de passe ni clé ne transite par le déployeur.
- **Ne pas dupliquer** les guides existants : le mode Dossier renvoie à
  `docs/modes/FOLDER_STORAGE.md`, le mode Hosted à
  `docs/deployment/HOSTED_GENERIC.md`. Ce contrat les **référence**, ne les
  recopie pas.
