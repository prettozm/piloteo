# Pilotéo — Guide de l'administrateur

Ce guide s'adresse à l'**administrateur fonctionnel** de Pilotéo (gestion des
comptes, référentiels, sauvegardes, audit). Le déploiement technique est traité
dans `DEPLOIEMENT.md` ; l'exploitation courante dans `EXPLOITATION.md`.

## 1. Rôle de l'administrateur

Un compte **administrateur** voit l'ensemble du cabinet et peut tout modifier :
consultants, organisations, affaires, missions, facturation, référentiels,
paiement des frais. Il gère aussi les comptes et les sauvegardes depuis la
console **Support & exploitation** (`/support`).

Un compte **utilisateur** ne voit que son périmètre (ses temps, ses frais, les
affaires qui le concernent). Un utilisateur **pilote d'une affaire** peut en plus
modifier cette affaire et ses missions. Ces droits sont **appliqués côté serveur**
— masquer un bouton ne serait pas une sécurité ; toute évolution des droits se
fait d'abord dans `server.py`.

> N'accordez le rôle administrateur qu'aux personnes qui doivent réellement voir
> et modifier l'ensemble du cabinet.

## 2. Écrans d'administration

En plus des écrans utilisateur, l'administrateur dispose de :

| Écran | Usage |
|---|---|
| **Vue rapide** | Vue d'ensemble société (effectifs, CA, temps). |
| **Portefeuille** | Toutes les affaires du cabinet. |
| **Suivi commercial** | Pipeline et performance commerciale société. |
| **Facturation** | Factures, échéances, alertes de facturation. |
| **Clients et Partenaires** | Organisations. |
| **Consultants** | Fiches consultants, TJM, temps partiels. |
| **Frais** | Frais et notes de frais de tout le cabinet, paiement. |
| **Tables & réglages** | Référentiels (méthodes, territoires, domaines, catégories de frais). |

## 3. Créer les comptes (console /support)

1. Connectez-vous comme administrateur.
2. Vérifiez ou créez le **consultant** dans **Consultants** (un compte doit être
   rattaché à un consultant existant).
3. Ouvrez **Tables & réglages → Support & exploitation** (ou l'adresse `/support`).
4. Dans **Créer un compte** : choisissez le consultant, saisissez l'identifiant,
   le nom affiché, le rôle, et un **mot de passe initial (12 caractères min.)**.
5. Communiquez l'identifiant et le mot de passe initial à la personne.

Pilotéo ne force pas le changement du mot de passe initial et ne propose pas de
« mot de passe oublié ». Pour un petit groupe, réinitialisez le mot de passe
depuis `/support` en cas de besoin (voir §4).

## 4. Gérer les comptes

Depuis `/support`, pour chaque compte vous pouvez :

- **activer / désactiver** — un compte désactivé ne peut plus se connecter
  (utilisez-le dès qu'une personne quitte le cabinet) ;
- **changer le rôle** (utilisateur ↔ administrateur) ;
- **réinitialiser le mot de passe** (12 caractères min.) — cela déconnecte les
  autres sessions de la personne.

Garde-fous : vous ne pouvez pas **désactiver votre propre compte** ni **retirer
votre propre rôle administrateur** (pour éviter de vous verrouiller dehors).

### « Voir sa page »

Depuis la liste des consultants, **Voir sa page** affiche Pilotéo tel que le voit
ce consultant — utile pour l'assister. Les actions effectuées restent **auditées
sous votre compte administrateur réel**.

## 5. Référentiels (Tables & réglages)

Tenez à jour les tables de référence : méthodes, types de territoire, domaines
d'intervention, catégories de frais. Ces libellés apparaissent dans les listes
déroulantes de saisie. Gardez `docs/cahier-des-charges.md` et
`docs/modele-de-donnees.md` cohérents en cas d'évolution métier.

## 6. Facturation et frais

- La **facturation** (création de factures, échéancier) est réservée à
  l'administrateur.
- Le **paiement d'une note de frais** et sa **date de paiement** sont réservés à
  l'administrateur : passez une note « note à payer » → « payée » quand le
  remboursement est effectué.

## 7. Sauvegardes

- **Automatique** : une sauvegarde cohérente est créée chaque jour (au premier
  démarrage de la journée, puis entretenue par une tâche de fond horaire), et
  après la première modification du jour. Rétention : 30 sauvegardes par défaut
  (`PILOTEO_BACKUP_RETENTION`).
- **Manuelle** : bouton **Créer une sauvegarde maintenant** dans `/support`.
- **Vérification** mensuelle recommandée et **restauration** : voir
  `EXPLOITATION.md` §5-6. Copiez régulièrement les sauvegardes **hors du serveur**.

## 8. Journal d'audit

`/support` affiche le **journal d'audit** : connexions, échecs de connexion,
créations/modifications de comptes, mises à jour de l'état, sauvegardes. Chaque
entrée porte la date, l'utilisateur, l'action, la cible et l'adresse IP.

> Pour que l'IP enregistrée soit celle du client (et non celle du proxy), le
> reverse proxy doit transmettre `X-Forwarded-For` et son adresse doit figurer
> dans `PILOTEO_TRUSTED_PROXIES` (voir `DEPLOIEMENT.md`).

En cas d'incident de sécurité : désactivez le compte concerné, conservez base et
logs, vérifiez l'audit, réinitialisez les mots de passe si besoin, et suivez la
procédure de `docs/SECURITY.md` §« Incident ».

## 9. Ce que la V1 ne fait pas (volontairement)

Pas de SSO/MFA, pas de récupération autonome de mot de passe, pas de
notifications email, pas de permissions très granulaires. Ces choix sont assumés
pour un cabinet d'environ cinq utilisateurs (voir `docs/ARCHITECTURE_V1.md` et
`docs/SECURITY.md`). Si le SI dispose déjà d'un SSO/MFA, il vaut mieux s'y
intégrer que de reproduire ces fonctions dans Pilotéo.
