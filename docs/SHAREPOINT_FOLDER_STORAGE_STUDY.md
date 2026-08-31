# Pilotéo — Étude : SharePoint via synchronisation OneDrive, sans intégration Microsoft Graph

## 0. Objet et périmètre

Cette note est une **étude de faisabilité**, pas une spécification d'implémentation. Elle
évalue une hypothèse précise dans le cadre de la migration de Pilotéo vers une architecture
**local-first** dotée de plusieurs modes de stockage.

Le mode concerné est le **Folder Storage** : Pilotéo écrit ses événements dans un dossier
choisi par l'utilisateur, sous forme de fichiers **immuables** (un fichier par événement,
jamais réécrit). Ce dossier peut être synchronisé par une infrastructure **externe** à
Pilotéo (OneDrive, Google Drive Desktop, Dropbox, NAS, dossier réseau). Pilotéo ne connaît
jamais le fournisseur : il ne voit qu'un dossier local.

Format retenu pour rappel :

- arborescence `events/AAAA-MM/<uuid>.piloteo` ;
- chaque fichier est un blob JSON **immuable** (write-once), jamais modifié après écriture ;
- la causalité entre événements est portée par un champ `parentEventId` (chaque événement
  référence l'événement dont il descend) ;
- la détection de conflit se fait **par entité** ;
- la projection (l'état applicatif) est reconstruite en **rejouant** tous les fichiers
  événements.

### Hypothèse étudiée

> Peut-on utiliser un **SharePoint d'entreprise** comme support de stockage Pilotéo **sans**
> intégrer Microsoft Graph, Entra ID (Azure AD) ni le tenant du client, en passant
> **uniquement** par la synchronisation OneDrive déjà installée chez le client ?

Chaîne visée :

```text
Bibliothèque SharePoint
        │ (bouton « Synchroniser » — client OneDrive)
        ▼
Client OneDrive (Windows)
        │ synchronise vers un dossier local
        ▼
C:\Users\<user>\<Tenant>\<Bibliothèque>\...
        │ (dossier local ordinaire)
        ▼
FolderStorageAdapter de Pilotéo  ──►  ne voit qu'un dossier
```

L'intérêt de l'hypothèse : **aucune** dépendance au tenant du client, **aucune** application
enregistrée dans Entra, **aucun** consentement administrateur, **aucun** appel Graph. Pilotéo
reste une PWA qui lit et écrit dans un dossier local, et c'est l'infrastructure Microsoft déjà
présente sur le poste qui assure la synchronisation vers SharePoint.

---

## 1. Comment un utilisateur Windows synchronise un dossier / une bibliothèque SharePoint via OneDrive

Le client de synchronisation OneDrive (celui installé par défaut sur Windows 10/11, y compris
en contexte Microsoft 365 professionnel) sait synchroniser non seulement le OneDrive personnel
de l'utilisateur, mais aussi des **bibliothèques de documents SharePoint**.

Parcours utilisateur typique :

1. L'utilisateur ouvre, dans son navigateur, la **bibliothèque de documents** du site
   SharePoint concerné (par exemple `https://<tenant>.sharepoint.com/sites/<site>`,
   bibliothèque « Documents » ou une bibliothèque dédiée).
2. Il clique sur le bouton **« Synchroniser »** de la barre de commandes de la bibliothèque.
   Le navigateur déclenche l'ouverture du client OneDrive local.
3. Le client OneDrive ajoute la bibliothèque à son périmètre de synchronisation et crée un
   **dossier local** correspondant.

Emplacement du dossier dans l'Explorateur de fichiers Windows : sous le profil utilisateur,
dans un dossier nommé d'après l'organisation, du type

```text
C:\Users\<user>\<Nom du Tenant / Organisation>\<Nom de la bibliothèque> - <Site>\
```

Ce dossier apparaît également dans le volet de navigation de l'Explorateur, sous l'entrée de
l'organisation (à côté de « OneDrive - <Organisation> »). La variable d'environnement
`%OneDrive%` pointe le OneDrive personnel synchronisé ; les bibliothèques SharePoint
synchronisées apparaissent comme des racines distinctes rattachées au même compte
professionnel.

### Fichiers à la demande (Files On-Demand)

Par défaut, OneDrive active **Fichiers à la demande** (« Files On-Demand »). Concrètement :

- Les fichiers de la bibliothèque sont **listés** localement (nom, taille, dates) mais leur
  contenu n'est pas nécessairement téléchargé.
- Trois états de statut existent, symbolisés par une pastille dans l'Explorateur :
  - **En ligne uniquement** (nuage) : seul un **placeholder** existe localement ; le contenu
    est téléchargé à la première lecture.
  - **Disponible localement** (coche verte sur fond blanc) : le contenu a été téléchargé, il
    occupe de l'espace disque, mais peut être re-libéré automatiquement.
  - **Toujours conserver sur cet appareil** (coche blanche sur fond vert plein) : le contenu
    est **épinglé** et garanti présent hors ligne.
- L'option « Toujours conserver sur cet appareil » se règle par clic droit sur un
  fichier ou un dossier ; elle est **héritée** par les fichiers ajoutés ultérieurement dans un
  dossier épinglé.

Ce dernier point est central pour Pilotéo : c'est le levier qui permet de garantir que les
fichiers événements restent lisibles hors connexion (voir §3, §5 et Conclusion).

---

## 2. Ce que Pilotéo voit réellement côté filesystem

Du point de vue de Pilotéo (et du navigateur via l'API File System Access, voir §6), le dossier
synchronisé est **un simple dossier local**. Pilotéo n'a aucune connaissance de SharePoint, du
tenant, ni du fait que le dossier est synchronisé. Il écrit des fichiers, il en lit, il liste
des entrées de répertoire — exactement comme pour un dossier local ordinaire ou un dossier
Dropbox/Google Drive Desktop.

Nuances importantes liées à Fichiers à la demande :

- Un fichier « En ligne uniquement » est présent dans le listing mais son contenu n'est pas
  hydraté : c'est un **placeholder** (fichier « fantôme »). Sous Windows, ces fichiers portent
  l'attribut de rappel `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (et sont gérés par un
  filtre « cloud files »).
- **Lire** un placeholder déclenche un **téléchargement transparent** : l'accès aux données du
  fichier provoque son hydratation par le client OneDrive, de façon synchrone du point de vue
  de l'appelant.
- Cette hydratation transparente **peut échouer** ou se bloquer si le poste est **hors ligne**,
  si OneDrive n'est pas en cours d'exécution, ou si le fichier n'a pas encore été rapatrié.
  L'opération de lecture peut alors renvoyer une erreur d'entrée/sortie ou rester en attente.

Conséquence pour l'adaptateur Pilotéo : la **reconstruction de la projection** implique de
**lire l'intégralité** des fichiers événements. Si ces fichiers sont « En ligne uniquement »,
la reconstruction déclenche l'hydratation de chacun d'eux — coûteux la première fois, et
**impossible hors ligne** pour les fichiers non encore rapatriés. D'où l'importance d'épingler
le dossier Pilotéo en « Toujours conserver sur cet appareil ».

Autre point : le listing d'un répertoire ne garantit pas que le contenu soit disponible. Il ne
faut donc jamais présumer qu'une entrée listée est immédiatement lisible sans coût réseau.

---

## 3. Limitations imposées par cette chaîne

Cette approche « dossier synchronisé » hérite des contraintes de SharePoint, de OneDrive et de
Windows. Les principales :

- **Latence de propagation.** La synchronisation n'est pas instantanée : un événement écrit sur
  un poste n'apparaît sur un autre poste qu'après remontée vers SharePoint puis redescente vers
  l'autre client OneDrive. Le délai va de quelques secondes à plusieurs minutes selon la charge,
  la taille des fichiers et l'état du réseau. Pilotéo doit être conçu pour une cohérence
  **à terme** (eventual consistency), pas pour du temps réel.

- **Placeholders non hydratés.** Voir §2. Sans épinglage, une partie des fichiers peut n'être
  qu'un placeholder, ce qui pénalise ou empêche la reconstruction hors ligne.

- **Quotas SharePoint.** Chaque bibliothèque vit dans un site dont le stockage est plafonné par
  le quota alloué par l'administrateur du tenant. Des milliers de petits fichiers événements
  consomment surtout du **nombre d'éléments** plus que de l'espace, mais restent soumis au quota
  global du site.

- **Verrouillage / extraction (checkout).** Une bibliothèque SharePoint peut être configurée
  pour exiger l'**extraction** (check-out) avant modification, ou verrouiller un fichier ouvert.
  Le modèle write-once de Pilotéo n'effectue jamais de réécriture, ce qui limite fortement ce
  risque ; il faut néanmoins **éviter** d'activer l'extraction obligatoire sur la bibliothèque
  dédiée à Pilotéo.

- **Longueur de chemin Windows.** La limite historique est de **260 caractères** pour un chemin
  complet (`MAX_PATH`). Le préfixe `C:\Users\<user>\<Organisation>\<Bibliothèque> - <Site>\`
  consomme déjà une part notable de ce budget. L'arborescence Pilotéo
  `events/AAAA-MM/<uuid>.piloteo` reste courte, mais la marge doit être vérifiée sur des noms de
  tenant/bibliothèque longs.

- **Caractères interdits dans les noms.** SharePoint/OneDrive interdisent certains caractères
  dans les noms de fichiers et de dossiers (par exemple `" * : < > ? / \ |`), certains noms
  réservés, les espaces/points en fin de nom, et quelques préfixes. Les noms Pilotéo, fondés sur
  des **UUID** et une date `AAAA-MM`, n'utilisent aucun de ces caractères — contrainte
  naturellement respectée, à condition de ne jamais dériver un nom de fichier d'une saisie
  utilisateur libre.

- **Nombre maximal d'éléments et seuil de vue de liste.** SharePoint applique un **seuil de vue
  de liste** de **5 000 éléments** : les requêtes/vues renvoyant plus de 5 000 éléments d'une
  même liste/bibliothèque sont limitées côté serveur. Ce seuil concerne les vues et requêtes
  serveur, **pas** directement la synchronisation de fichiers, mais il traduit une réalité :
  une bibliothèque à très grand nombre d'éléments dégrade l'expérience et certaines opérations.
  Le partitionnement par mois (`events/AAAA-MM`) aide à répartir les fichiers, mais un cabinet
  actif peut accumuler beaucoup d'événements sur la durée — point à surveiller.

- **Versioning SharePoint.** Les bibliothèques activent souvent le **versioning** : SharePoint
  conserve des versions même pour des fichiers que Pilotéo considère « immuables ». Comme
  Pilotéo ne réécrit jamais un fichier, en régime normal une seule version existe par fichier ;
  mais le versioning **consomme du quota** si des re-synchronisations ou des recréations se
  produisent, et il n'apporte rien au modèle Pilotéo (la causalité est déjà portée par les
  événements). Il peut être laissé actif sans risque fonctionnel, mais mérite d'être connu.

- **Corbeille.** Une suppression de fichier passe par la **corbeille** SharePoint (à deux
  niveaux, site puis collection de sites) avec rétention. Un fichier « supprimé » n'est donc pas
  immédiatement effacé et peut être restauré — ce qui, pour un journal d'événements immuables,
  est plutôt une propriété de sûreté, mais implique que l'espace n'est pas libéré tout de suite.

---

## 4. Comment les conflits de fichiers sont matérialisés

Le comportement de référence du client OneDrive en cas de **conflit d'édition** (deux
modifications concurrentes du **même** fichier) est de **conserver les deux** et de renommer
l'une des copies en y ajoutant le **nom de l'ordinateur** :

```text
NOM.ext           (une version)
NOM-NomOrdinateur.ext   (la version en conflit)
```

Selon la configuration, OneDrive peut aussi proposer de « garder les deux » copies. Le principe
reste : un conflit **ne se produit que sur un fichier réécrit** de manière concurrente.

Or, dans le modèle Pilotéo :

- chaque événement porte un nom **unique** (`<uuid>.piloteo`) ;
- un fichier événement n'est **jamais modifié** après sa première écriture (write-once).

Il n'existe donc, en régime nominal, **aucune situation de réécriture concurrente** du même
fichier. Deux postes ne produisent jamais deux versions du même `<uuid>.piloteo` : ils
produisent des fichiers **distincts**, chacun avec son propre UUID. La synchronisation n'a alors
qu'à transporter des fichiers différents, sans jamais avoir à arbitrer un conflit de contenu.

Le seul cas résiduel où OneDrive pourrait fabriquer une copie « -NomOrdinateur » serait la
présence d'un **fichier partagé réécrit** (un manifeste, un index, un « état courant » stocké
dans un fichier unique mis à jour en place). Ce cas est traité au §5.

---

## 5. Le modèle « un événement = un fichier immuable » évite-t-il suffisamment ces conflits ?

**Oui, pour les écritures d'événements.** L'argumentaire :

- **Noms uniques.** Un UUID par événement supprime toute collision de nom entre postes. Deux
  utilisateurs peuvent écrire simultanément : ils créent deux fichiers différents, jamais le
  même.
- **Write-once.** Un fichier événement n'est jamais réouvert en écriture. Il n'y a donc pas de
  **conflit de contenu** possible : OneDrive n'a rien à fusionner, rien à renommer en
  « -NomOrdinateur ».
- **Rôle de la synchro réduit au transport.** La synchronisation se contente de **véhiculer des
  fichiers distincts** d'un poste à l'autre. C'est un cas d'usage idéal pour n'importe quel
  synchroniseur (OneDrive, Drive, Dropbox), qui excelle à répliquer des fichiers indépendants et
  peine, au contraire, sur les écritures concurrentes d'un même fichier.
- **La causalité et les conflits métier sont gérés par Pilotéo, pas par le filesystem.** Le
  champ `parentEventId` et la détection de conflit **par entité** vivent à l'intérieur des
  événements. Deux événements concurrents descendant du même parent pour une même entité ne
  provoquent **aucun** conflit de fichier : ce sont deux fichiers valides, et c'est la
  **projection** de Pilotéo qui détecte et arbitre la divergence au rejeu. Le stockage n'a pas à
  savoir résoudre les conflits : il doit seulement ne pas en fabriquer.

**Point de contention résiduel à proscrire : tout fichier partagé réécrit en place.** Si
l'adaptateur maintenait un **manifeste**, un **index** ou un **snapshot** de projection dans un
fichier unique constamment mis à jour, ce fichier deviendrait le point exact où OneDrive
produirait des copies « -NomOrdinateur » et où la latence de synchro créerait des écrasements.

Recommandations de conception qui découlent directement de l'étude :

- **N'écrire que des fichiers additifs et immuables.** Pas de mutation en place.
- Si un cache de projection ou un index est nécessaire pour les performances, le garder
  **strictement local** (par exemple IndexedDB côté navigateur), **hors** du dossier synchronisé,
  et le reconstruire par rejeu — jamais en faire une source de vérité partagée.
- Si un « checkpoint » partagé s'avérait indispensable, le matérialiser lui aussi comme un
  **fichier additif** immuable (nommé, par exemple, par un UUID ou un horodatage), et non comme
  un fichier réécrit.

Sous ces conditions, le modèle event-per-file **évite structurellement** les conflits de
fichiers de la chaîne SharePoint/OneDrive.

---

## 6. Navigateurs permettant l'accès au dossier nécessaire

Pour qu'une **PWA** lise et écrive dans un dossier local choisi par l'utilisateur, elle s'appuie
sur la **File System Access API**, en particulier `window.showDirectoryPicker()`, qui rend un
`FileSystemDirectoryHandle` sur le dossier sélectionné.

État du support (au moment de l'étude) :

- **Chromium et dérivés — pris en charge :** Google Chrome, Microsoft **Edge**, Opera, et les
  navigateurs Chromium récents sous **desktop**. C'est le socle attendu en environnement
  d'entreprise Windows.
- **Firefox — non pris en charge :** pas de `showDirectoryPicker()` pour l'accès en écriture à un
  dossier arbitraire (support limité/absent de la partie « accès dossier » de l'API).
- **Safari — non/limité :** support partiel de la File System Access API, sans l'accès complet à
  un dossier arbitraire persistant équivalent à Chromium ; à considérer comme non disponible pour
  ce cas d'usage.

Persistance de l'accès entre sessions :

- Le `FileSystemDirectoryHandle` peut être **stocké dans IndexedDB** pour être réutilisé lors des
  sessions suivantes (le handle est sérialisable/structuré-clonable).
- Mais l'**autorisation** n'est pas garantie de survivre : au retour, le navigateur peut exiger
  une **re-confirmation** de la permission (`queryPermission` / `requestPermission`). Selon la
  configuration et le navigateur, l'utilisateur peut avoir à **re-cliquer** pour ré-accorder
  l'accès, typiquement une fois par session ou après un certain temps.
- **Alternative** pour supprimer cette friction et couvrir les navigateurs non compatibles : un
  **wrapper desktop** (voir §7).

Contrainte transverse : la File System Access API n'est disponible qu'en contexte **sécurisé**
(HTTPS ou `localhost`) et depuis une interaction utilisateur (le picker doit être déclenché par
un geste).

---

## 7. Une PWA seule suffit-elle, ou faut-il un wrapper desktop ?

**Pour l'environnement cible, une PWA suffit.** L'environnement SharePoint/OneDrive typique est
précisément **Windows + Edge/Chrome**, c'est-à-dire exactement là où la File System Access API et
`showDirectoryPicker()` sont pleinement disponibles. Dans ce cadre :

- La PWA Pilotéo peut ouvrir le dossier de la bibliothèque synchronisée, y écrire ses fichiers
  événements et lire l'ensemble pour reconstruire la projection.
- OneDrive assure, de façon totalement externe, la synchronisation vers SharePoint.
- Aucune intégration Graph/Entra/tenant n'est requise.

**Un wrapper desktop (Electron, Tauri) ne devient nécessaire que dans des cas particuliers :**

- Prise en charge de **Firefox** ou **Safari**, qui n'offrent pas l'accès dossier requis.
- Besoin d'un accès dossier **sans re-permission** à chaque session (un wrapper natif peut
  mémoriser durablement un chemin et y accéder directement, sans le modèle de permission du
  navigateur).
- Besoin d'automatisations système que le bac à sable du navigateur n'autorise pas (surveillance
  fine du système de fichiers, démarrage automatique, intégration à l'OS).

En synthèse : **PWA suffisante** sur la cible Windows/Edge/Chrome ; le wrapper desktop est une
**option d'extension** de couverture, pas un prérequis de l'hypothèse étudiée.

---

## 8. Synthèse des risques et de leur traitement

| Risque | Origine | Traitement dans le modèle Pilotéo |
| --- | --- | --- |
| Conflit de contenu de fichier | Réécriture concurrente | Éliminé par write-once + UUID (§4, §5) |
| Fichier illisible hors ligne | Placeholder non hydraté | Épinglage « Toujours conserver sur cet appareil » du dossier Pilotéo (§1, §2) |
| Reconstruction lente à froid | Hydratation de nombreux fichiers | Épinglage + partition par mois ; cache de projection local hors dossier synchronisé (§2, §5) |
| Divergence temporaire entre postes | Latence de propagation | Cohérence à terme assumée ; arbitrage par entité au rejeu (§3, §5) |
| Manifeste/état partagé en conflit | Fichier réécrit partagé | Interdire tout fichier muté en place ; n'écrire que des fichiers additifs (§5) |
| Chemin trop long | `MAX_PATH` 260 caractères | Noms courts (UUID + `AAAA-MM`) ; vérifier la marge selon le préfixe tenant (§3) |
| Nom de fichier rejeté | Caractères interdits SharePoint | Noms dérivés d'UUID uniquement, jamais de saisie libre (§3) |
| Navigateur non compatible | Firefox/Safari | Cible Edge/Chrome ; wrapper desktop en secours (§6, §7) |
| Re-permission à chaque session | Modèle de permission navigateur | Handle persistant en IndexedDB + re-consentement ; wrapper desktop si friction inacceptable (§6, §7) |

---

## Points nécessitant une validation réelle chez un utilisateur

Les éléments suivants reposent sur le comportement **documenté** de Microsoft mais ne peuvent
être **confirmés** que sur un vrai poste SharePoint d'entreprise, dans le tenant du client :

- **Emplacement et nommage exacts** du dossier local créé par le bouton « Synchroniser » selon
  le nom du tenant, du site et de la bibliothèque, et **longueur réelle** du préfixe de chemin
  (vérifier la marge par rapport aux 260 caractères).
- **Comportement de la File System Access API sur un dossier OneDrive/SharePoint synchronisé** :
  confirmer que `showDirectoryPicker()` puis lecture/écriture fonctionnent sans blocage sur ce
  type de dossier (placeholders inclus), et mesurer le comportement en lecture d'un fichier « En
  ligne uniquement ».
- **Efficacité réelle de l'épinglage** « Toujours conserver sur cet appareil » sur le dossier
  Pilotéo, y compris l'héritage sur les fichiers créés **après** l'épinglage, et le comportement
  strictement **hors ligne**.
- **Latence de propagation observée** entre deux postes du cabinet (ordre de grandeur réel :
  secondes, minutes).
- **Politiques de la bibliothèque** telles que configurées par l'administrateur du client :
  extraction obligatoire (check-out), versioning, quotas, rétention de corbeille, restrictions de
  synchronisation éventuelles (certaines organisations bloquent ou restreignent la synchro de
  bibliothèques).
- **Comportement à volume** : test avec plusieurs milliers de fichiers événements accumulés,
  pour mesurer la reconstruction à froid et vérifier l'absence d'effet de bord lié au seuil de
  5 000 éléments côté vues SharePoint.
- **Modèle de permission du navigateur** dans le contexte du poste (GPO, profils gérés Edge) :
  fréquence réelle des re-consentements demandés à l'utilisateur.
- **Absence de conflit « -NomOrdinateur »** en usage multi-postes réel sur une durée
  représentative, pour confirmer empiriquement l'analyse du §4/§5.

---

## Conclusion

**Verdict : GO sous conditions.**

L'hypothèse est **techniquement crédible**. Le modèle « un événement = un fichier immuable »
(UUID, write-once, causalité par `parentEventId`, arbitrage par entité au rejeu) est
**structurellement compatible** avec une chaîne SharePoint → synchro OneDrive → dossier local →
FolderStorageAdapter. Il évite par construction le seul point noir de ce type de synchronisation
(les conflits de réécriture d'un même fichier), et il ne réclame **aucune** intégration Graph,
Entra ou tenant : l'infrastructure Microsoft déjà présente sur le poste fait tout le transport.

Ce GO est assorti des **conditions** suivantes :

1. **Environnement Windows + Edge/Chrome** (Chromium), qui est justement l'environnement
   SharePoint/OneDrive d'entreprise typique et le seul où la File System Access API couvre le
   besoin. Firefox et Safari sont hors périmètre sans wrapper desktop.
2. **Fichiers à la demande configurés pour garder les fichiers Pilotéo disponibles hors ligne**,
   via « Toujours conserver sur cet appareil » sur le dossier Pilotéo, afin que la reconstruction
   de la projection ne dépende pas d'une hydratation en ligne.
3. **Aucune écriture de fichier partagé muté en place** : n'écrire que des fichiers additifs et
   immuables ; tout cache/index de projection reste local (hors dossier synchronisé) et
   reconstructible.
4. **Respect des contraintes SharePoint/Windows** : noms dérivés d'UUID uniquement, chemins
   courts, bibliothèque sans extraction obligatoire, vigilance sur le volume d'éléments dans la
   durée.
5. **Validation sur un poste pilote réel** chez un utilisateur du client, portant sur les points
   listés à la section précédente, avant tout engagement.

Sans ces conditions — en particulier hors de Windows/Edge-Chrome, ou sans épinglage hors ligne,
ou avec un état partagé réécrit — le verdict basculerait vers un **NO-GO** ou imposerait un
wrapper desktop. Dans le périmètre défini, et sous réserve de la validation pilote, l'approche
est retenue en **GO sous conditions**.
