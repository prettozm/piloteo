# Google Drive — conflits & « lock files » (Point 4, réponse argumentée)

> Complète `docs/next/DRIVE_LIVE_CONTRACT.md` §3/§4 et §8 (révision post-revue
> adverse — l'oracle du lot). Ce document répond à deux questions distinctes :
> **comment les conflits sont-ils gérés** sur Drive (§1), et **pourquoi n'y
> a-t-il PAS de fichiers de verrou** (§2), avec les quatre points de
> justification demandés par le contrat.
>
> **Révision §8c (correction d'un over-claim)** : une version antérieure de ce
> document affirmait que l'échafaudage de dossiers et les fichiers à nom
> constant n'avaient « rien à protéger », par analogie directe avec le journal
> d'événements. C'était FAUX pour ces deux éléments précis — voir §0 et §2.2
> corrigés, et le §2bis (fenêtre de course résiduelle et convergence).
> Le contrariant (`tests/next/attack-p4-drive-races.test.mjs`, angles 1/2/2bis/3/3bis/7)
> a produit des repros exécutables confirmant cet over-claim ; les corrections
> apportées (`src/storage/google-drive-adapter.js` §8a/§8b) sont détaillées ici.
>
> **Révision §9b (correction d'un second over-claim, round 2)** : le §2bis
> affirmait ensuite que la convergence était « garantie à la prochaine
> résolution » — vrai pour un `connect()` neuf, FAUX pour une instance déjà
> vivante (`connect()` ne se rappelle jamais lui-même). Le contrariant round 2
> (`tests/next/attack-p4r2-drive-connect-sweep.test.mjs`) l'a confirmé ; §9b
> ajoute la re-résolution paresseuse (`_liveTopFolder`) qui rend cette
> affirmation enfin vraie — voir §2bis, paragraphe de tête.
>
> **Révision §10 (correction d'une PERTE DE DONNÉES PERMANENTE, round 3)** :
> le §2bis affirmait ensuite qu'un dossier orphelin était « inoffensif » et
> que son contenu « reste lisible directement par `get()` » — FAUX : `get`/
> `readMetadata`/`exists`/`listChanges` ne regardaient QUE le sous-arbre du
> dossier top-level GAGNANT (oldest-wins, §9b), rendant tout contenu écrit
> dans un dossier top-level dupliqué « perdant » invisible EN PERMANENCE,
> pour TOUTE instance — y compris l'auteure de l'écriture elle-même. Le
> contrariant round 3
> (`tests/next/attack-p4r3-drive-orphan-topfolder.test.mjs`) l'a prouvé ; §10
> sépare l'écriture (converge vers le plus ancien, inchangé) de la lecture
> (unit désormais TOUS les dossiers de même nom, `_allTopFolderIds`) — voir
> §2bis, corrigé en détail.

## 0. Rappel du modèle — DEUX régimes distincts, pas un seul

Pilotéo sur Drive combine en réalité **deux régimes très différents**, qu'il
ne faut PLUS confondre (c'était l'erreur du document précédent) :

1. **Le journal d'événements** (`kind:"event"`, fichiers `<eventId>.piloteo`) :
   chaque événement est un fichier **unique**, nommé par un `eventId`
   (`crypto.randomUUID()` — **jamais adressé par contenu**, jamais réutilisé
   intentionnellement entre deux écritures logiquement distinctes). Deux
   membres qui écrivent des événements **différents** en même temps produisent
   **deux fichiers différents** — il n'y a JAMAIS d'écrasement concurrent d'un
   même fichier d'événement, et rien n'a besoin d'être protégé ici : c'est
   **réellement** lock-free par construction (§2.2 ci-dessous, corrigé).
2. **L'échafaudage de dossiers ET les fichiers à NOM CONSTANT**
   (`workspace/`, `members/`, `events/`, `keys/`, `licenses/`, leurs
   sous-dossiers mensuels/d'epoch, et les singletons `manifest.piloteo` /
   `current.license`) : CE SONT, eux, une **ressource mutable PARTAGÉE** au
   sens classique — un check-then-act (« le dossier/singleton `X` existe-t-il
   déjà ? sinon je le crée ») sur lequel **deux clients peuvent réellement se
   marcher dessus**. Ce n'est PAS protégé par un verrou (§2), mais par une
   **réconciliation déterministe** (§8b) : ce n'est PAS « rien à protéger »,
   c'est « protégé autrement qu'un verrou ».

La convergence du régime 1 se fait à la **projection** (réducteur +
`classify`, `src/events/conflict.js`, déjà construits et identiques aux modes
Dossier/Organisation). La convergence du régime 2 se fait à la **résolution**
(oldest-wins par `(createdTime,id)`) et, pour les singletons, à la **lecture**
(`IMMUTABLE_CONFLICT` si divergence). Les deux mécanismes sont documentés
séparément ci-dessous — ne plus les traiter comme un seul et même argument.

## 1. Conflits — réponse explicite, cas par cas

### 1.1. Événements (`kind:"event"`)

**Aucun conflit d'écriture n'est possible** au niveau du transport : chaque
événement est un fichier distinct (`<eventId>.piloteo`), jamais réécrit, nommé
par un UUID aléatoire jamais réutilisé entre deux événements logiquement
distincts. `GoogleDriveStorageAdapter.putImmutable` vérifie l'existence par NOM
avant `files.create` — deux membres qui créent des événements *différents* au
même instant créent simplement deux fichiers distincts dans
`events/<AAAA-MM>/`, sans jamais se gêner. (Le SEUL cas où le MÊME `eventId`
est réécrit est un *retry* légitime du MÊME appelant après un timeout réseau —
voir §2.3/§2bis pour la course résiduelle que cela peut ouvrir, et sa
neutralisation.)

Le **conflit métier** — deux modifications logiques de la MÊME entité
(ex : deux modifications concurrentes de la même saisie) — existe bien, mais il
se résout **à la projection**, jamais au transport :
`EventLog#replay()` trie les événements par entité et par lignée causale
(`baseVersion`/`parentEventId`), applique le premier arrivé causalement et
classe le second en `conflict` dans `projection.__conflicts`, sans jamais
écraser l'entité. `PUT /api/state` (mapping déjà en place côté 1b/Dossier,
réutilisé tel quel par l'engine Drive de `piloteo-drive-bridge.mjs`) renvoie
alors **409** avec l'état rechargé — **jamais un 200 silencieux** qui ferait
croire à un commit accepté alors qu'il a été reclassé en conflit.

`listChanges` (§8a, revue adverse) trie et fait avancer son curseur avec la
MÊME clé composite totale `(createdTime, fileId)` de bout en bout, et
déduplique par nom physique en sortie : un doublon physique de fichier d'event
(§2bis) ne produit jamais deux entrées logiques, et une collision de
`createdTime` entre deux events distincts ne saute ni ne redélivre jamais rien
(curseur `{createdTime, seenIds}`, pas un simple id-watermark).

### 1.2. Manifeste / genèse (`kind:"workspace"`, fichier `manifest.piloteo`)

**Nom CONSTANT** (jamais un identifiant opaque unique, contrairement aux
events) — c'est exactement le point que le contrariant a exploité (angle
2bis) : deux « appareils » qui initialisent le MÊME dossier Drive vierge en
même temps peuvent chacun voir « absent » avant que l'autre n'ait fini
d'écrire, et chacun ÉCRIT son propre manifeste (deux identités de workspace
différentes). `putImmutable` reste **best-effort** ici : il NE garantit PAS
d'empêcher cette course à l'écriture (aucun verrou, §2). Ce qui est garanti :

- Si le pré-check de `putImmutable` voit DÉJÀ un manifeste (identique ou non),
  il agit en conséquence (succès idempotent si identique, `IMMUTABLE_CONFLICT`
  immédiat si différent) — c'est le cas SÉQUENTIEL (le second arrive après que
  le premier ait fini), qui fonctionne déjà sans course.
- Sous course PURE (les deux pré-checks voient « absent » en même temps), les
  DEUX écritures peuvent réussir sans qu'aucune ne lève `IMMUTABLE_CONFLICT` à
  ce moment précis — résidu explicitement accepté (§2bis). La **prochaine
  lecture** (`get`/`readMetadata`, par N'IMPORTE lequel des deux appareils)
  détecte la divergence de contenu entre les candidats physiques et lève
  `IMMUTABLE_CONFLICT` **au lieu de** choisir l'un des deux au hasard — voir
  `createDriveEventBackend` dans `piloteo-drive-bridge.mjs`, qui relit le
  manifeste existant sur ce code d'erreur plutôt que d'échouer bêtement.

### 1.3. Rotation d'epoch / clés (`kind:"key"`) et licence (`kind:"license"`)

Même principe que §1.2 pour la **licence** (`current.license`, nom constant).
Pour les clés d'epoch (`keys/epoch-XXXX/<memberId>.key`), le nom porte
`memberId` (pas totalement constant, mais réutilisable si un même membre
rejoue une rotation) : le perdant d'une course de rotation détecte le fichier
de clé existant via le même mécanisme de réconciliation à la lecture et **se
réconcilie sur la clé publiée**, plutôt que d'écraser celle de l'autre.

### 1.4. Arbre de dossiers (`connect()`/`_ensureFolder`)

Régime 2 également (§0) : `workspace/`, `members/`, `events/`, `keys/`,
`licenses/` et leurs sous-dossiers mensuels/d'epoch sont des dossiers dont le
NOM est fixe (`folderForKind`) ou dérivé d'une donnée non unique (`AAAA-MM`,
`epoch-XXXX`) — PAS un identifiant opaque par instance. Deux clients qui
initialisent le même workspace en même temps peuvent chacun créer LEUR PROPRE
dossier du même nom (angle 1/7 du contrariant, confirmé). Résolution :
**réconciliation déterministe** — voir §2bis.

## 2. « Lock files » — décision : **PAS de fichiers de verrou**

### 2.1. Drive/OneDrive/SharePoint n'offrent aucune primitive de verrou atomique inter-clients

Un « lock file » n'est, du point de vue de l'API, qu'un fichier ordinaire.
Créer un fichier n'est PAS une opération atomique de type
« test-and-set » côté Drive : deux clients peuvent tous deux constater
l'absence du verrou puis le créer « en même temps » (course), obtenant chacun
un fichier — exactement le problème qu'un verrou est censé prévenir. Pire, un
lock file **reste bloqué (stale)** si le client qui l'a posé crash, perd sa
connexion, ou ferme simplement son onglet avant de le libérer : il n'existe
aucun mécanisme de bail/expiration automatique côté Drive pour un fichier
ordinaire — le résultat est un **interblocage sans propriétaire identifiable**,
que seule une intervention manuelle (supprimer le fichier de verrou) peut
lever. Un mécanisme censé apporter de la sûreté introduirait donc une nouvelle
classe de panne pire que celle qu'il prétend résoudre. **Ce point s'applique
également à l'échafaudage de dossiers et aux singletons (régime 2, §0)** : un
« dossier de verrou » ou un « fichier de verrou » pour protéger leur création
souffrirait EXACTEMENT de la même course et du même risque de blocage stale —
il ne résoudrait rien que la réconciliation déterministe (§2bis) ne résout
déjà, en pire (un verrou stale bloque tout ; une résolution divergente,
détectée, ne bloque rien — elle est corrigée à la prochaine lecture).

### 2.2. Le journal d'événements N'A RIEN À PROTÉGER (mais ce n'est PAS vrai de tout le reste — correction §8c)

Un verrou protège une **section critique de modification d'un état partagé
mutable**. Le **journal d'événements** (régime 1, §0) n'a, dans son format de
transport, **aucun fichier mutable partagé** : chaque événement est écrit une
seule fois sous un nom UNIQUE (UUID), jamais modifié ni supprimé. Il n'y a
donc **rien à protéger en exclusion mutuelle** pour LUI — la question « qui a
le droit d'écrire en ce moment ? » ne se pose jamais pour un event, parce
qu'écrire un event ne modifie jamais ce qu'un autre a déjà écrit.

**Ceci ne s'étend PAS à l'échafaudage de dossiers ni aux singletons à nom
constant (régime 2, §0)** — l'affirmer était l'over-claim corrigé par §8c. Ces
deux éléments SONT une ressource mutable partagée au sens classique (un nom
fixe, deux écrivains potentiels, un « check-then-act ») : la bonne affirmation
n'est pas « rien à protéger », c'est « protégée par une **réconciliation
déterministe** (oldest-wins), pas par un verrou » — voir §2bis.

### 2.3. Là où une exclusion est réellement utile : write-once + réconciliation, pas un verrou

Les points du système où une notion de « premier arrivé, premier servi » a un
sens (manifeste de genèse §1.2, licence, clé d'epoch §1.3, arbre de dossiers
§1.4) sont couverts — **sans verrou** — par la **création write-once**
(create-if-absent) **plus une réconciliation déterministe** (§2bis),
implémentées dans `_ensureFolder`/`putImmutable`/`get`/`readMetadata`
(`src/storage/google-drive-adapter.js`) et exploitées par
`piloteo-drive-bridge.mjs`.

Pour le **journal d'événements** spécifiquement (événements de contenu
IDENTIQUE sous le même `eventId`, cas du retry légitime — jamais deux
événements logiquement distincts, puisque l'`eventId` est un UUID aléatoire
non réutilisé intentionnellement) : la fenêtre de course résiduelle (deux
`files.create` simultanés du même nom) est rattrapée par la déduplication de
`listChanges` (§8a) — le doublon physique ne produit jamais deux entrées
logiques.

### 2.bis. Fenêtre de course résiduelle et convergence (§8b/§8c/§9b/§10 — obligatoire, ne pas ré-affirmer « rien à protéger »)

**Révision §10 (correction d'une PERTE DE DONNÉES PERMANENTE — troisième over-claim)** :
la version précédente de ce paragraphe affirmait que les écritures faites par
une instance AVANT sa propre convergence « restent lisibles directement par
`get()` » — c'était FAUX. Le contrariant round 3
(`tests/next/attack-p4r3-drive-orphan-topfolder.test.mjs`) a prouvé que
`get()`/`readMetadata()`/`exists()`, comme `listChanges`, ne regardaient QUE
le sous-arbre du dossier top-level GAGNANT (le plus ancien, §9b) — un contenu
écrit dans un dossier top-level DUPLIQUÉ « perdant » était donc INVISIBLE EN
PERMANENCE pour TOUTE lecture, pas seulement pour `listChanges`, et pas
seulement transitoirement : même une instance fraîche connectée bien après
que tout le monde a convergé ne le retrouvait JAMAIS ; même l'auteure de
l'écriture ne se retrouvait plus elle-même (`get()` lui renvoyait `null` sur
son propre manifeste, pourtant physiquement présent). Ce n'était donc pas un
« résidu inoffensif » comme l'affirmait la version précédente — c'était une
disparition silencieuse d'un immuable réel.
La correction, §10, sépare clairement deux responsabilités qui étaient
confondues : **l'ÉCRITURE converge vers le plus ancien** (oldest-wins, §9b,
inchangé — un seul dossier « fait foi » pour les nouvelles écritures) ; **la
LECTURE, elle, UNIT tous les dossiers de même nom** (`_allTopFolderIds`,
`src/storage/google-drive-adapter.js`, utilisée par `listChanges` et par
`_findAllFilesByNameInKindSubtree`, donc par `get`/`exists`/`readMetadata`) —
avant de conclure à une absence ou d'énumérer les events, TOUS les dossiers
top-level candidats (et, pour `event`/`key`, tous leurs sous-dossiers
mensuels/d'epoch) sont interrogés, pas seulement le gagnant. Un contenu réel
n'est donc plus JAMAIS invisible, quel que soit le dossier physique où il vit
— la réconciliation détermine seulement OÙ ÉCRIRE ensuite, jamais QUOI LIRE.
Coût assumé : une requête par dossier top-level candidat au lieu d'une seule
(normalement UN SEUL dossier existe par nom, sauf pendant une course de
création rare et transitoire — le surcoût normal est donc nul) — correction
PRIME sur l'efficacité, même arbitrage que §9a/§9b.

**Révision §9b (correction d'un second over-claim)** : la version précédente
de ce paragraphe affirmait que la convergence était « garantie dès la
PROCHAINE résolution complète (au plus tard) ». C'était INCOMPLET/FAUX pour
une instance DÉJÀ VIVANTE : `connect()` (round 1, §8b) ne fait son balayage de
réconciliation qu'UNE FOIS, à l'initialisation ; une instance qui a déjà
terminé son `connect()` ne rappelle JAMAIS `connect()` de sa propre initiative
— il n'existait donc AUCUNE « prochaine résolution » pour elle tant qu'elle
restait en vie, et elle pouvait rester bloquée indéfiniment sur son propre
choix même si un dossier réellement plus ancien devenait visible ensuite
(confirmé par le contrariant round 2,
`tests/next/attack-p4r2-drive-connect-sweep.test.mjs`). §9b corrige ceci en
ajoutant une **re-résolution PARESSEUSE** (`_liveTopFolder`,
`src/storage/google-drive-adapter.js`) : CHAQUE opération suivante
(`putImmutable`/`get`/`exists`/`readMetadata`/`listChanges`) — pas seulement un
`connect()` répété, qui reste un no-op définitif pour l'efficacité — re-résout
le dossier top-level qu'elle s'apprête à utiliser et adopte tout candidat
PROUVÉ plus ancien. La « prochaine résolution » promise ci-dessous est donc
maintenant réellement : la PROCHAINE opération de CETTE instance, pas
seulement un hypothétique redémarrage.

**Ce que la réconciliation déterministe GARANTIT** : à la résolution d'un
dossier/singleton par nom sous un parent donné, si PLUSIEURS candidats
existent, TOUT client choisit TOUJOURS le **plus ancien** par
`(createdTime, id)` (`compareByCreatedTimeThenId`,
`src/storage/google-drive-adapter.js`) — jamais un choix arbitraire dépendant
de l'ordre de réponse de l'API. `connect()` fait, en plus, un balayage de
réconciliation FINAL après avoir traité les 5 dossiers de premier niveau : si
un autre client a créé un doublon PENDANT ce traitement, ce balayage permet
aux deux instances de converger sur le MÊME gagnant, généralement **dans la
MÊME session** de `connect()` (vérifié empiriquement,
`tests/next/attack-p4-drive-races.test.mjs` angle 1/7). Et pour une instance
DÉJÀ vivante qui n'a pas eu cette chance (le dossier plus ancien n'était pas
encore visible à ce moment-là), `_liveTopFolder` (§9b) garantit qu'elle
l'adoptera à sa PROCHAINE opération, SANS jamais redémarrer (vérifié
empiriquement, `tests/next/attack-p4r2-drive-connect-sweep.test.mjs`).

**Ce qu'elle NE garantit PAS** : une convergence **instantanée**, à la
microseconde près, en toutes circonstances — ni la récupération RÉTROACTIVE
des écritures faites AVANT la convergence d'une instance (voir le point
« Dossiers » ci-dessous). Si deux clients résolvent le MÊME nom à un instant où
AUCUN des deux ne peut encore voir la création de l'autre (latence réseau
réelle, contrairement au simulateur de test), chacun peut transitoirement
adopter un dossier/singleton DIFFÉRENT. Ce résidu est **assumé et documenté**,
pas nié :

- **Dossiers** (arbre de premier niveau, sous-dossiers mensuels/d'epoch) : un
  doublon PHYSIQUE peut subsister (un dossier orphelin, pour les ÉCRITURES
  futures — plus aucune instance n'y écrit après convergence de son
  `_liveTopFolder`, §9b). Ceci est désormais RÉELLEMENT inoffensif (§10) :
  contrairement à l'affirmation précédente (corrigée ci-dessus), le contenu
  déjà écrit dans ce dossier N'EST PLUS invisible — TOUTE lecture
  (`get`/`readMetadata`/`exists`/`listChanges`) unit tous les dossiers de même
  nom (`_allTopFolderIds`), y compris cet orphelin. La CONVERGENCE DES
  ÉCRITURES (toute instance qui résout CE nom, dorénavant, écrit sous le MÊME
  id) est garantie dès la PROCHAINE opération de chaque instance (§9b) ; la
  VISIBILITÉ EN LECTURE de tout ce qui a déjà été écrit, elle, est garantie
  IMMÉDIATEMENT et INCONDITIONNELLEMENT (§10), sans attendre aucune
  convergence — les deux garanties sont désormais indépendantes et toutes
  deux tenues, alors qu'avant §10 seule la première existait.
- **Singletons à nom constant** (`manifest.piloteo`, `current.license`) : deux
  contenus DIFFÉRENTS peuvent transitoirement coexister — y compris dans DEUX
  dossiers top-level DIFFÉRENTS (pas seulement dans le même dossier, cf.
  §10) : `get`/`readMetadata` unissent désormais tous les dossiers top-level
  candidats (§10) avant de comparer les contenus, donc une divergence entre
  deux dossiers distincts est détectée EXACTEMENT comme une divergence à
  l'intérieur d'un même dossier. Contrairement aux dossiers seuls (où
  « n'importe lequel des deux » convient tant que tout le monde s'accorde), le
  CONTENU de deux manifestes divergents n'est PAS interchangeable (deux
  identités de workspace différentes). La réconciliation ne choisit donc PAS
  silencieusement l'un des deux : `get`/`readMetadata` **détectent** la
  divergence et lèvent `ImmutableConflictError` (`code:"IMMUTABLE_CONFLICT"`)
  à la PROCHAINE lecture, laissant l'appelant (`piloteo-drive-bridge.mjs`)
  décider (aujourd'hui : adopter le manifeste déjà publié plutôt que le sien,
  cf. §1.2) — jamais un choix arbitraire invisible, et surtout (§10) jamais un
  `null` masquant un contenu réel quand le SEUL candidat existant vit dans un
  dossier top-level devenu orphelin.
- **Events** (retry du même `eventId`, contenu identique) : voir §2.3 —
  neutralisé par la déduplication de `listChanges`, pas un souci de contenu
  divergent (le contrat garantit toujours `IMMUTABLE_CONFLICT` si jamais deux
  contenus différents apparaissaient sous le même `eventId`, cf. §8b, mais ce
  cas ne devrait jamais se produire en pratique puisque l'`eventId` est un
  UUID généré une fois par son créateur).

### 2.4. Comparaison honnête : quand un lock aurait-il aidé ?

Un verrou apporte une vraie garantie **d'exclusion immédiate** dans un modèle
« single mutable file » réécrit en place — par exemple un `state.json` unique
réécrit par tous les clients à chaque commit. C'est précisément le modèle que
Pilotéo a **délibérément évité pour le journal** (voir
`folder-storage-adapter.js`, en-tête : « on n'utilise PAS un state.json unique
réécrit par tous — source de conflits pour les synchros externes »). Un lock
aurait pu, dans CE modèle alternatif, réduire (sans l'éliminer — cf. §2.1) le
risque d'écrasement croisé lors de la réécriture du fichier unique.

Pour l'échafaudage de dossiers et les singletons (régime 2), un lock
apporterait, EN THÉORIE, une exclusion plus stricte que la réconciliation
déterministe — mais au prix du risque de blocage stale (§2.1), pour un gain
marginal : la réconciliation garantit déjà la convergence (tous les clients
s'accordent) et, pour les singletons, la détection explicite de toute
divergence de contenu (jamais un choix silencieux). Le lock résoudrait donc un
problème (la fenêtre de course transitoire) déjà neutralisé par ailleurs, en
introduisant un problème pire (l'interblocage sans propriétaire).

**Conclusion : Pilotéo sur Google Drive est *lock-free* par construction pour
le journal d'événements (rien à y protéger), et *lock-free par réconciliation
déterministe* pour l'échafaudage de dossiers et les singletons à nom constant
(quelque chose à y protéger, mais protégé autrement qu'un verrou). C'est un
choix architectural assumé, avec une fenêtre de course résiduelle documentée
et neutralisée — pas l'absence de tout risque, et pas une fonctionnalité
manquante.**
