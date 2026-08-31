# Pilotéo — Mode « Dossier » (Folder Storage)

Guide d'usage du mode de stockage **Dossier**. Pilotéo écrit ses données dans un
dossier choisi par l'utilisateur ; ce dossier peut être local ou synchronisé par
une infrastructure **externe** à Pilotéo (OneDrive, SharePoint via OneDrive,
Google Drive Desktop, Dropbox, NAS, clé USB). Ce document décrit le principe, la
répartition des responsabilités, les fournisseurs de synchronisation compatibles,
la sélection du dossier dans le navigateur, les bonnes pratiques, les deux options
de confiance/chiffrement encore ouvertes, et les limites de l'implémentation
actuelle.

Adaptateur documenté : `src/storage/folder-storage-adapter.js`. Cas particulier
du dossier synchronisé SharePoint traité en détail dans
`docs/SHAREPOINT_FOLDER_STORAGE_STUDY.md` (non répété ici).

---

## 1. Principe : un dossier, des fichiers immuables

En mode Dossier, Pilotéo ne stocke pas son état dans une base de données unique
mais dans une **arborescence de fichiers immuables**. Chaque événement métier est
écrit **une seule fois**, dans son propre fichier `.piloteo`, et n'est **jamais
réécrit** (write-once). Un fichier événement porte un nom unique (UUID) et vit
dans un sous-dossier mensuel :

```text
<racine>/
  workspace/manifest.piloteo          espace de travail (singleton)
  members/<memberId>.piloteo          membres
  events/AAAA-MM/<eventId>.piloteo     un événement = un fichier immuable
  keys/epoch-XXXX/<memberId>.key       clés par epoch
  licenses/current.license             licence courante (singleton)
```

Les cinq catégories de blobs (`STORAGE_KINDS`) sont : `workspace`, `member`,
`event`, `key`, `license`.

Il n'existe **aucun** fichier « état courant » unique réécrit par tout le monde
(un `state.json` partagé serait une source de conflits pour les synchroniseurs
externes). À la place, l'**état affiché** — la *projection* — est reconstruit en
mémoire en **rejouant** l'ensemble des fichiers événements présents dans le
dossier. Ajouter de l'information = ajouter un fichier ; jamais modifier un
fichier existant.

Deux appareils qui créent chacun un événement produisent donc **deux fichiers
distincts** (deux UUID différents). L'outil de synchronisation externe n'a qu'à
**transporter** ces fichiers indépendants d'un poste à l'autre — il n'a jamais à
fusionner de contenu, donc il ne peut pas fabriquer de conflit de fichier.

---

## 2. Ce que Pilotéo gère — et ce qu'il ne gère pas

Cette séparation est le cœur du mode Dossier.

**Pilotéo gère (à la relecture des fichiers) :**

- la **validation** de chaque événement rejoué ;
- la **causalité** entre événements, portée par le champ `parentEventId` (chaque
  événement référence celui dont il descend) ;
- la **détection de conflit métier par entité** : deux événements concurrents
  descendant du même parent pour une même entité sont deux fichiers valides, et
  c'est la projection qui détecte et arbitre la divergence au rejeu ;
- la **projection** : la reconstruction de l'état applicatif affiché.

**Pilotéo ne gère PAS :**

- la **synchronisation du dossier** entre appareils ou entre personnes. Faire
  remonter, redescendre et répliquer les fichiers d'un poste à l'autre est la
  responsabilité de l'**utilisateur** ou de son **organisation**, via le
  fournisseur de synchronisation de son choix.

L'adaptateur ne voit qu'un dossier local. Il ne connaît jamais le fournisseur, ne
gère aucune ACL, et ses opérations `share`/`revoke` sont des **NO-OP** documentés :
le partage d'un dossier relève du fournisseur de synchronisation ou des
permissions du système de fichiers, pas de Pilotéo.

---

## 3. Fournisseurs de synchronisation compatibles

Le point commun à tous : **Pilotéo ne voit qu'un dossier local**. Il ignore le
fournisseur, le fait que le dossier soit synchronisé, et la façon dont la
réplication est faite. N'importe quel outil capable de répliquer un dossier de
fichiers indépendants convient.

### OneDrive personnel

Le dossier OneDrive de l'utilisateur (`%OneDrive%`) est un dossier local ordinaire
synchronisé vers le cloud Microsoft. Pilotéo y écrit ses fichiers, OneDrive les
réplique. Attention aux **Fichiers à la demande** (voir §5).

### Dossier SharePoint synchronisé via OneDrive

Une bibliothèque SharePoint d'entreprise peut être synchronisée localement par le
client OneDrive (bouton « Synchroniser »), sans aucune intégration Microsoft Graph
ni Entra. Pilotéo ne voit là encore qu'un dossier local. Ce cas — le plus riche en
contraintes (placeholders, quotas, seuil de 5 000 éléments, `MAX_PATH`, conflits
`-NomOrdinateur`) — fait l'objet d'une étude dédiée :
voir `docs/SHAREPOINT_FOLDER_STORAGE_STUDY.md`.

### Google Drive pour ordinateur (Drive Desktop)

Le client Drive pour ordinateur expose un dossier local synchronisé vers Google
Drive. Pilotéo y écrit comme dans n'importe quel dossier ; Drive réplique.
Comme OneDrive, Drive peut ne pas conserver le contenu localement (fichiers à la
demande) — garder les fichiers Pilotéo disponibles hors ligne (voir §5).

### Dropbox

Le dossier Dropbox est un dossier local synchronisé vers Dropbox. Fonctionnement
identique. La fonction « Smart Sync / Dropbox intelligent » peut, elle aussi,
laisser des fichiers en ligne uniquement : préférer un contenu conservé localement
pour le dossier Pilotéo.

### Dossier réseau / NAS

Un partage réseau (SMB/NFS) ou un dossier de NAS monté localement peut servir de
racine. La réplication est ici assurée par le réseau/serveur de fichiers. À
surveiller : disponibilité du montage (hors ligne = dossier inaccessible) et
verrous éventuels du serveur de fichiers.

### Clé USB / dossier purement local

Aucune synchronisation : le dossier vit sur un disque local ou une clé USB. C'est
le mode le plus simple (mono-poste). La « synchronisation » se réduit alors à
transporter ou sauvegarder le dossier soi-même (voir §5).

---

## 4. Comment choisir le dossier

### Dans un navigateur compatible

Une PWA sélectionne le dossier via la **File System Access API**, en appelant
`window.showDirectoryPicker()`, qui renvoie un `FileSystemDirectoryHandle` sur le
dossier choisi. L'API n'est disponible qu'en **contexte sécurisé** (HTTPS ou
`localhost`) et le picker doit être déclenché par une **interaction utilisateur**
(un geste : clic sur un bouton).

Navigateurs :

- **Chromium et dérivés — pris en charge :** Chrome, Microsoft **Edge**, Opera et
  les navigateurs Chromium récents sous desktop. C'est le socle attendu en
  environnement d'entreprise Windows.
- **Firefox — non pris en charge :** pas d'accès en écriture à un dossier
  arbitraire via `showDirectoryPicker()`.
- **Safari — non/limité :** support partiel, sans l'accès persistant complet à un
  dossier arbitraire ; à considérer comme non disponible pour ce cas d'usage.

En clair : sur **Firefox et Safari**, le mode Dossier est **indisponible** sans un
wrapper desktop (Electron/Tauri) qui fournirait l'accès au système de fichiers.

### Persistance de l'autorisation entre sessions

Le `FileSystemDirectoryHandle` est sérialisable et peut être **stocké dans
IndexedDB** pour être réutilisé aux sessions suivantes. En revanche, l'**autorisation
d'accès n'est pas garantie de survivre** : au retour, le navigateur peut exiger une
**re-confirmation** de la permission (`queryPermission` / `requestPermission`).
Selon la configuration et le navigateur, l'utilisateur peut avoir à **re-cliquer**
pour ré-accorder l'accès, typiquement une fois par session. Un wrapper desktop
supprime cette friction (accès durable à un chemin sans le modèle de permission du
navigateur).

---

## 5. Bonnes pratiques et pièges

- **Garder les fichiers Pilotéo « toujours disponibles hors ligne ».** Quand le
  dossier est synchronisé par un client à *fichiers à la demande* (OneDrive,
  Drive, Dropbox intelligent), certains fichiers ne sont qu'un **placeholder** (en
  ligne uniquement). Or reconstruire la projection implique de **lire tous** les
  fichiers événements. Lire un placeholder déclenche une hydratation en ligne qui
  **peut échouer hors connexion**. Épingler le dossier Pilotéo (« Toujours
  conserver sur cet appareil » sous OneDrive, équivalent chez les autres) pour
  garantir la lisibilité hors ligne. Détails : `docs/SHAREPOINT_FOLDER_STORAGE_STUDY.md` §2.

- **Ne jamais éditer, renommer ou supprimer manuellement un fichier `.piloteo`.**
  Les fichiers sont **immuables** : Pilotéo les écrit en mode exclusif (write-once)
  et ne réécrit jamais. Modifier un fichier à la main corrompt la reconstruction ;
  le renommer casse la résolution par UUID ; le supprimer perd de l'information du
  journal. Le dossier n'est pas un espace de fichiers à ranger.

- **Sauvegarde = copier le dossier.** Puisque tout est fichier immuable, une
  sauvegarde se réduit à une **copie du dossier** (à froid, ou via l'historique du
  fournisseur cloud). Aucun export applicatif spécifique n'est requis pour préserver
  l'état.

- **Un même dossier partagé entre plusieurs personnes = mode « équipe » sur dossier
  synchronisé.** Pointer plusieurs postes vers le même dossier synchronisé (partage
  OneDrive/SharePoint, dossier partagé Drive, etc.) fait travailler une équipe sur
  le même journal. Chacun ajoute ses propres fichiers événements ; la synchro les
  transporte ; chaque poste rejoue l'ensemble. Il faut alors assumer une cohérence
  **à terme** (latence de propagation) : arbitrage des divergences par entité au
  rejeu, pas de temps réel.

- **Ne jamais introduire de fichier partagé réécrit en place.** Tout cache ou index
  de projection destiné aux performances doit rester **strictement local** (par
  exemple IndexedDB), **hors** du dossier synchronisé, et être reconstructible par
  rejeu — jamais une source de vérité partagée réécrite (voir l'étude SharePoint,
  §5).

---

## 6. Confiance et chiffrement — deux options, décision non tranchée

Deux postures sont possibles pour le contenu des fichiers dans le dossier. **Aucune
n'est tranchée à ce stade** : le choix relève d'une **revue de sécurité dédiée** et
d'une **évaluation coût/bénéfice ultérieure**. Les deux sont présentées sans
préférence.

### Option « Folder Trusted »

Les données sont écrites **en clair** (JSON lisible) dans le stockage du client. La
justification : le dossier est **déjà sous la responsabilité du SI du client** (son
OneDrive/SharePoint d'entreprise, son NAS, son poste) ; ajouter un chiffrement
applicatif par-dessus une infrastructure déjà maîtrisée et chiffrée au repos
**apporte peu**, au prix d'une complexité de gestion de clés. Simplicité maximale,
inspection et sauvegarde directes.

### Option « Folder Encrypted »

Les événements sont **chiffrés côté client** avant écriture. La justification :
**défense en profondeur** — le contenu reste protégé même si le dossier fuit hors
du périmètre du SI (mauvais partage, poste perdu, sauvegarde égarée). Le coût : il
faut **assumer la gestion des clés** (dérivation, rotation par epoch — cf. le kind
`key` et les sous-dossiers `keys/epoch-XXXX/`, distribution, récupération), ce qui
n'est pas neutre.

**Décision :** renvoyée à une évaluation **coût/bénéfice** ultérieure, adossée à
une revue de sécurité dédiée. Ce document ne recommande ni l'une ni l'autre.

---

## 7. Limites actuelles / ce qui n'est pas encore câblé

Le mode Dossier est **partiellement** implémenté à ce jour :

- **Le port navigateur (File System Access) n'existe pas encore.** L'adaptateur
  `FolderStorageAdapter` ne fait aucune E/S lui-même : il délègue à un **port
  filesystem** minimal injecté (`ensureDir`, `writeExclusive`, `readText`, `exists`,
  `listFiles`, `stat`). Seul le port **Node** (`src/storage/node-fs-port.js`)
  existe : il sert aux **tests** et à un **éventuel wrapper desktop** (Electron/Tauri)
  disposant d'un accès `fs` direct. Le port navigateur équivalent, bâti sur
  `showDirectoryPicker()` → `FileSystemDirectoryHandle`, **reste à écrire**.

- **L'intégration UI du choix de dossier reste à faire.** Le déclenchement du
  picker, la persistance du handle en IndexedDB, la gestion de la re-permission et
  le raccordement au `SyncEngine` ne sont pas encore câblés dans l'interface.

- **Périmètre navigateur confirmé Chromium desktop.** Firefox et Safari restent
  hors périmètre sans wrapper desktop (voir §4).

L'adaptateur et son format sur disque sont, eux, en place et couverts par les tests
via le port Node ; il manque le transport navigateur et le câblage UI pour rendre
le mode Dossier utilisable de bout en bout dans la PWA.
