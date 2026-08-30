# 3. Équipe et synchronisation

Ce chapitre concerne les espaces d'équipe. Si vous travaillez seul en mode
solo, vous pouvez le passer.

## Comment marche la synchronisation

Vous n'avez rien à faire pour synchroniser vos données : Pilotéo s'en
occupe automatiquement.

1. Dès que vous saisissez un temps, un frais, ou que vous modifiez une
   affaire, la modification est enregistrée **immédiatement sur votre
   appareil**.
2. Si vous êtes connecté, Pilotéo l'envoie ensuite, chiffrée, vers l'espace
   de stockage de votre organisation, pour que vos collègues la reçoivent à
   leur tour.
3. Si vous n'êtes pas connecté, rien n'est perdu : vos modifications
   attendent sur votre appareil. Dès que la connexion revient, elles partent
   automatiquement, et vous recevez en retour ce que vos collègues ont fait
   entre-temps.

Un indicateur dans l'application vous montre l'état :

| Indicateur | Signification |
|---|---|
| **Synchronisé** | Tout est à jour et partagé avec l'équipe. |
| **En attente / hors connexion** | Vos modifications sont enregistrées sur votre appareil et partiront dès le retour du réseau. Vous pouvez continuer à travailler normalement. |
| **Synchronisation…** | L'envoi ou la réception est en cours. |
| **Conflit** | La même donnée a été modifiée par quelqu'un d'autre en même temps que vous — voir ci-dessous. |

## Les conflits : ce que c'est et quoi faire

Un conflit survient quand **deux personnes modifient la même donnée** en
même temps — par exemple, vous et le pilote d'une affaire modifiez la même
mission au même moment. Dans ce cas :

- votre modification locale **n'est pas appliquée** ;
- Pilotéo recharge la version enregistrée par l'autre personne ;
- une bannière vous indique l'élément concerné.

**Ce que vous devez faire** : ouvrir à nouveau l'élément signalé, vérifier
la version désormais affichée, et refaire votre modification si elle est
toujours nécessaire.

Rassurez-vous : des modifications sur des données **différentes** (par
exemple, vous saisissez un temps pendant qu'un collègue saisit un frais) ne
créent jamais de conflit — elles se combinent automatiquement. Un conflit ne
peut jamais effacer silencieusement le travail de quelqu'un : soit votre
modification est acceptée, soit elle vous est clairement signalée pour que
vous la refassiez.

## Inviter un collègue

Si vous êtes propriétaire ou administrateur de l'espace :

1. Allez dans **Administration → Membres → Inviter**.
2. Indiquez l'adresse Google de la personne à inviter et le rôle que vous
   souhaitez lui donner (consultant, administrateur…).
3. Pilotéo génère un code ou un lien d'invitation, à transmettre à votre
   collègue (par message, e-mail, ou QR code selon le format proposé).

Une invitation :

- n'est valable qu'un temps limité ;
- ne peut être utilisée qu'**une seule fois** ;
- peut être **annulée avant utilisation** si vous vous êtes trompé de
  destinataire ou de rôle.

Le code d'invitation ne donne pas, à lui seul, un accès direct à toutes les
données de l'espace : la personne doit se connecter avec le compte Google
attendu pour que l'invitation soit acceptée.

## Rejoindre une équipe

Voir la procédure complète en [01-demarrer.md](01-demarrer.md) —
« Si vous rejoignez une équipe sur invitation ». En résumé : vous choisissez
« J'ai reçu une invitation », vous vous connectez avec le bon compte Google,
et vous saisissez le code reçu.

## Quitter un espace ou retirer un membre

**Pour quitter un espace vous-même** : rendez-vous dans le sélecteur
d'espace, puis « Quitter cet espace ». Vos données locales déjà
synchronisées restent lisibles sur votre appareil jusqu'à ce que vous les
supprimiez vous-même ; vous ne recevrez simplement plus les nouvelles
modifications de l'équipe.

**Pour retirer un membre** (propriétaire ou administrateur) : allez dans
**Administration → Membres**, puis choisissez « Révoquer » sur la ligne du
membre concerné.

Ce qui se passe alors :

- l'accès de la personne à l'espace de stockage partagé est immédiatement
  retiré ;
- les **nouvelles** données de l'équipe ne lui sont plus accessibles ;
- la personne conserve ce qu'elle avait légitimement pu consulter avant sa
  révocation — Pilotéo ne peut techniquement pas effacer à distance des
  données déjà vues.

Révoquer un membre ne supprime aucune de ses saisies passées (ses temps, ses
frais restent dans l'historique de l'affaire) : seul son accès futur est
coupé.

## Plusieurs espaces à la fois

Vous pouvez appartenir à plusieurs espaces (par exemple deux cabinets, ou un
espace d'équipe et un espace personnel solo). Un sélecteur vous permet de
passer de l'un à l'autre à tout moment ; votre rôle et vos données restent
propres à chaque espace.

Pour la question de l'essai gratuit et de la licence, voir
[04-licence-et-essai.md](04-licence-et-essai.md).
