# Pilotéo — Guide de l'utilisateur

Ce guide s'adresse aux **consultants**. Il couvre la connexion, la saisie des
temps et des frais, le suivi de vos affaires si vous en pilotez, et la
compréhension de l'indicateur de synchronisation. L'administration (comptes,
sauvegardes, référentiels) est traitée dans le *Guide de l'administrateur*.

## 1. Se connecter

1. Ouvrez l'adresse de Pilotéo fournie par votre administrateur (en `https://`).
2. Saisissez votre **identifiant** et votre **mot de passe** (12 caractères
   minimum, communiqué par l'administrateur à la création du compte).
3. En cas d'erreur répétée, l'accès est temporairement bloqué après 10 tentatives
   sur 15 minutes — patientez, puis réessayez.

Votre session reste ouverte 12 heures par défaut. Passé ce délai, ou si votre
compte est modifié, Pilotéo vous ramène à l'écran de connexion en vous prévenant
que vos dernières modifications ne sont **pas encore enregistrées** : reconnectez-vous
avant de fermer la page.

> Pilotéo ne propose pas encore de « mot de passe oublié ». Contactez votre
> administrateur pour une réinitialisation.

## 2. Vos écrans

Selon votre rôle, le menu de gauche affiche :

| Écran | À quoi il sert |
|---|---|
| **Ma page** | Votre tableau de bord personnel : rappels, temps et frais récents. |
| **Mon Pilotage** | Les affaires que vous **pilotez** : alertes de facturation, qualité du pilotage, missions. |
| **Mon commercial** | Votre activité commerciale (offres où vous êtes crédité). |
| **Mes temps** | Saisie et suivi de vos temps. |
| **Mes frais** | Saisie et suivi de vos frais et notes de frais. |

Vous ne voyez que **votre périmètre** : vos temps, vos frais, et les affaires qui
vous concernent (celles que vous pilotez, où vous êtes pilote commercial,
contributeur commercial, ou consultant d'une mission). Les données des autres
consultants (TJM, temps, frais) ne sont pas envoyées à votre navigateur.

## 3. Saisir un temps

1. Allez dans **Mes temps** → **Saisir un temps**.
2. Choisissez le **type** :
   - **Mission** — temps affecté à une mission qui vous est attribuée ;
   - **Interne** — activité interne (avant-vente, formation, etc.) ;
   - **Absence** — congés, maladie, etc.
3. Renseignez la **date**, la **durée en jours** (ex. 0,5 pour une demi-journée)
   et, si utile, un **commentaire**.
4. **Enregistrer**.

> Si aucune mission ne vous est affectée, le type « Mission » n'est pas
> disponible : sélectionnez « Interne » ou « Absence », ou demandez au pilote de
> l'affaire de vous affecter à une mission.

Vous ne pouvez modifier que **vos propres** saisies. La suppression d'une saisie
n'est pas possible en V1 : corrigez la valeur si nécessaire.

## 4. Saisir un frais et une note de frais

1. Allez dans **Mes frais** → **Saisir un frais**.
2. Indiquez la **date**, la **cible** (une affaire de votre périmètre, ou un
   temps interne), la **catégorie**, le **montant HT**, la **TVA** et, le cas
   échéant, si le frais est **refacturable** au client.
3. **Enregistrer**. Le frais rejoint une **note de frais** (bordereau).
4. Quand votre note est prête, passez-la de « en saisie » à « note à payer ».

Le **paiement** d'une note de frais et sa **date de paiement** sont réservés à
l'administrateur. Vous ne pouvez rattacher un frais qu'à une affaire de votre
périmètre.

## 5. Piloter une affaire (si vous êtes pilote)

Depuis **Mon Pilotage**, ouvrez une affaire que vous pilotez pour :

- suivre l'avancement, le budget consommé et le **reste à faire** ;
- gérer ses **missions** (création, échéances, affectation des consultants) ;
- surveiller les **alertes de facturation** et la **cohérence budgétaire**.

Vous pouvez modifier **l'affaire et ses missions** dont vous êtes pilote. La
création d'une affaire, le changement de pilote, la facturation et les
référentiels restent réservés à l'administrateur.

## 6. L'indicateur de synchronisation

Pilotéo enregistre automatiquement votre travail sur le serveur et se synchronise
entre navigateurs. La barre latérale affiche l'état :

| Indicateur | Signification |
|---|---|
| **Synchronisé** | Vos données sont enregistrées sur le serveur. |
| **Synchronisation…** | Enregistrement en cours, patientez. |
| **Non synchronisé** | Problème réseau ou serveur : **ne fermez pas la page** tant que ce n'est pas revenu à « Synchronisé ». |
| **Modification refusée** | Vous n'avez pas le droit de modifier cette donnée. |
| **Conflit** | La même donnée a été modifiée ailleurs : la version du serveur a été rechargée, une bannière vous indique quoi refaire. |

En cas de **conflit**, votre modification locale n'est pas appliquée : une
bannière persistante vous indique l'élément concerné. Refaites la modification
sur la version rechargée.

Si vous fermez la page alors qu'une modification n'est pas synchronisée, le
navigateur vous avertit — attendez « Synchronisé » avant de quitter.

## 7. Exporter en CSV

La plupart des tableaux proposent un bouton **Exporter CSV** (temps, frais,
affaires…). Le fichier s'ouvre dans un tableur (Excel, LibreOffice) avec le
séparateur point-virgule.

## 8. Se déconnecter

Utilisez le bouton de déconnexion (barre latérale). Sur un poste partagé,
déconnectez-vous toujours en fin d'utilisation.

## 9. Problèmes courants

- **« Je ne vois pas une affaire »** : vous n'êtes ni pilote, ni pilote
  commercial, ni contributeur commercial, ni consultant d'une mission de cette
  affaire. Demandez au pilote de vous rattacher, ou à l'administrateur.
- **« Le bouton Enregistrer ne fait rien »** : vérifiez les champs obligatoires ;
  pour un temps de type mission, vérifiez qu'une mission vous est affectée.
- **« Ma saisie n'est pas enregistrée »** : regardez l'indicateur de
  synchronisation (§6). S'il indique « Non synchronisé », c'est un problème
  réseau : ne fermez pas la page.
- **Session expirée** : reconnectez-vous ; ressaisissez la dernière modification
  si elle n'était pas synchronisée.
