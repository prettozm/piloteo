# 5. Sauvegarde et sécurité

## Pourquoi faire une sauvegarde

Même si Pilotéo synchronise automatiquement vos données (en mode équipe) ou
les garde sur votre appareil (en mode solo), il reste utile de faire de
temps en temps une sauvegarde de secours — par exemple avant de changer
d'ordinateur, ou simplement pour dormir tranquille.

## Exporter une sauvegarde

1. Allez dans **Administration → Sauvegarde** (ou, en mode solo, dans les
   réglages de l'application).
2. Cliquez sur **« Exporter une sauvegarde »**.
3. Un fichier est généré et enregistré à l'endroit que vous choisissez sur
   votre appareil (par exemple votre dossier Téléchargements).

Rangez ce fichier dans un endroit sûr — un dossier partagé du cabinet, une
clé USB, votre propre espace de stockage personnel — comme vous le feriez
pour n'importe quel document important.

## Restaurer sur un nouvel appareil

Si vous changez d'ordinateur ou de tablette, ou si vous réinstallez
Pilotéo :

1. Lancez Pilotéo sur le nouvel appareil et démarrez le parcours habituel
   (mode solo, ou connexion à votre espace d'équipe).
2. Selon votre situation :
   - **en mode équipe**, il n'y a le plus souvent rien à restaurer :
     reconnectez-vous simplement à votre espace, la synchronisation ramène
     automatiquement toutes les données de l'équipe sur le nouvel appareil ;
   - **en mode solo**, ou si vous voulez repartir d'une sauvegarde précise,
     utilisez **« Importer une sauvegarde »** et sélectionnez le fichier
     exporté précédemment.

## Bonnes pratiques

- Faites une sauvegarde avant tout changement important d'appareil.
- Ne partagez jamais un fichier de sauvegarde par un canal non sécurisé
  (il contient vos données métier) : traitez-le comme un document
  confidentiel du cabinet.
- En mode équipe, gardez à jour la liste des membres de votre espace
  (Administration → Membres) et retirez sans tarder toute personne qui
  quitte le cabinet — voir
  [03-equipe-et-synchro.md](03-equipe-et-synchro.md).
- Déconnectez-vous toujours sur un poste partagé ou public.

## Ce qui protège vos données

- **En mode solo**, vos données ne quittent jamais votre appareil : elles ne
  transitent par aucun serveur.
- **En mode équipe**, les données partagées de votre organisation sont
  **chiffrées avant d'être envoyées vers l'espace de stockage choisi** (par
  exemple Google Drive) : elles y restent illisibles pour toute personne
  qui n'est pas un membre autorisé de votre espace — y compris pour le
  fournisseur du stockage lui-même.
- Aucune donnée métier de votre cabinet ne transite jamais par un serveur
  de l'éditeur de Pilotéo : le site que vous ouvrez ne fait que vous
  livrer l'application ; vos données, elles, circulent uniquement entre
  votre appareil et l'espace de stockage de votre organisation.

Le chiffrement mis en œuvre s'appuie sur des méthodes reconnues plutôt que
sur une solution maison. Il n'a cependant pas encore fait l'objet d'un audit
de sécurité indépendant à ce stade : nous restons prudents dans ce que nous
en affirmons, et une revue spécifique est prévue avant toute promesse
commerciale de « chiffrement fort ».

## En cas de souci

- **Vous ne retrouvez pas vos données après une réinstallation** :
  vérifiez d'abord que vous êtes connecté avec le bon compte et le bon
  espace (voir le sélecteur d'espace) avant de conclure à une perte.
- **Vous avez supprimé Pilotéo sans avoir exporté de sauvegarde en mode
  solo** : sans sauvegarde, les données propres à cet appareil ne peuvent
  malheureusement pas être récupérées — c'est pourquoi la sauvegarde
  régulière est recommandée, en particulier en mode solo.
- **Vous pensez qu'un ancien collègue a encore accès à l'espace** : rendez-
  vous dans Administration → Membres et vérifiez qu'il est bien révoqué
  (voir [03-equipe-et-synchro.md](03-equipe-et-synchro.md)).
- **Tout autre problème** : contactez votre administrateur de cabinet, ou
  votre éditeur Pilotéo si vous êtes vous-même administrateur.
