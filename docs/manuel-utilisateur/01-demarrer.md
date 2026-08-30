# 1. Démarrer avec Pilotéo

## Premier lancement

Ouvrez l'adresse de Pilotéo dans votre navigateur. Un écran d'accueil vous
propose trois choix, décrits en détail dans le [README](README.md) :

1. **Mes données restent sur cet appareil** (solo) ;
2. **Créer un espace pour mon entreprise ou mon équipe** (équipe) ;
3. **J'ai reçu une invitation** (rejoindre une équipe).

Ce choix ne vous enferme pas : un espace solo peut être transformé plus tard
en espace d'équipe sans avoir à ressaisir vos données.

### Si vous démarrez seul

1. Choisissez « Mes données restent sur cet appareil ».
2. Rien d'autre à faire : aucun compte n'est demandé. Pilotéo crée
   immédiatement votre espace de travail local.
3. Vous accédez directement à l'application.

### Si vous créez un espace pour votre équipe

1. Choisissez « Créer un espace pour mon entreprise ou mon équipe ».
2. Connectez-vous avec votre compte Google.
3. Donnez un nom à votre organisation (par exemple le nom de votre cabinet).
4. Choisissez où seront rangées les données partagées de l'équipe : votre
   Google Drive personnel, ou un Drive partagé Google Workspace si votre
   organisation en dispose. C'est votre organisation qui choisit et qui reste
   propriétaire de cet espace de stockage — Pilotéo n'y ajoute qu'un « couloir
   de circulation » chiffré pour vos données métier.
5. Vous devenez le premier membre de l'espace, avec le rôle de
   **propriétaire**. Un essai gratuit de 20 jours démarre automatiquement.
6. Vous pouvez ensuite inviter vos collègues (voir
   [03-equipe-et-synchro.md](03-equipe-et-synchro.md)).

### Si vous rejoignez une équipe sur invitation

1. Choisissez « J'ai reçu une invitation ».
2. Connectez-vous avec le compte Google attendu par l'invitation (celui à
   qui elle a été envoyée).
3. Saisissez ou scannez le code ou le lien d'invitation reçu.
4. Pilotéo configure automatiquement l'accès à l'espace de stockage partagé
   et récupère la clé nécessaire pour lire les données de l'équipe.
5. Après une première synchronisation, vous accédez à l'espace selon les
   droits que l'on vous a accordés (consultant, pilote, administrateur…).

> Une invitation est valable un temps limité et ne peut servir qu'une seule
> fois. Si la vôtre a expiré, demandez à votre administrateur de vous en
> envoyer une nouvelle.

## Installer Pilotéo sur votre appareil (PWA)

Pilotéo peut s'installer comme une vraie application, avec une icône sur
votre écran d'accueil ou votre bureau — sans passer par un store
d'applications.

**Sur mobile (Android ou iPhone) :**

1. Ouvrez Pilotéo dans votre navigateur.
2. Ouvrez le menu du navigateur (⋮ ou l'icône de partage).
3. Choisissez **« Ajouter à l'écran d'accueil »** (ou « Installer
   l'application » selon le navigateur).
4. Une icône Pilotéo apparaît désormais sur votre écran d'accueil, comme
   n'importe quelle autre application.

**Sur ordinateur :**

1. Ouvrez Pilotéo dans votre navigateur.
2. Repérez l'icône d'installation dans la barre d'adresse (souvent un écran
   avec une flèche), ou le menu du navigateur.
3. Choisissez **« Installer Pilotéo »**.

Une fois installée, l'application s'ouvre dans sa propre fenêtre, sans les
menus du navigateur, et fonctionne même sans connexion (voir ci-dessous).

## Travailler hors connexion

Pilotéo continue de fonctionner même sans réseau, dès qu'il a été ouvert au
moins une fois sur cet appareil :

- vous pouvez saisir vos temps, vos frais, consulter vos affaires ;
- vos modifications sont enregistrées **immédiatement sur votre appareil** ;
- dès que la connexion revient, Pilotéo synchronise automatiquement ce que
  vous avez fait pendant la coupure, sans action de votre part.

En mode solo, vos données restant uniquement sur l'appareil, il n'y a même
pas de synchronisation à attendre. En mode équipe, un indicateur dans
l'application vous montre l'état de la synchronisation — voir
[03-equipe-et-synchro.md](03-equipe-et-synchro.md).

## Où sont mes données ?

- **En mode solo** : vos données restent uniquement sur l'appareil que vous
  utilisez. Elles ne sont envoyées nulle part. Si vous changez d'appareil,
  pensez à exporter une sauvegarde (voir
  [05-sauvegarde-et-securite.md](05-sauvegarde-et-securite.md)).
- **En mode équipe** : vos données sont d'abord enregistrées sur votre
  appareil, puis synchronisées avec vos collègues via l'espace de stockage
  choisi par votre organisation (par exemple un Google Drive de cabinet).
  Elles quittent votre appareil **chiffrées** : personne d'autre que les
  membres autorisés de votre espace ne peut les lire, y compris le
  fournisseur du stockage.

Dans tous les cas, aucune donnée métier ne transite par un serveur de
l'éditeur de Pilotéo : le site que vous utilisez ne fait que vous livrer
l'application elle-même.

## Plusieurs espaces depuis la même application

Vous pouvez appartenir à plusieurs espaces à la fois — par exemple votre
cabinet en tant que consultant, une autre organisation en tant
qu'administrateur, et un espace personnel en solo. Un sélecteur d'espace
vous permet de passer de l'un à l'autre. Votre rôle est propre à chaque
espace : rien de ce que vous faites dans un espace n'apparaît dans un autre.

Pour la suite du quotidien (saisir vos temps, vos frais, suivre vos
affaires), rendez-vous en [02-au-quotidien.md](02-au-quotidien.md).
