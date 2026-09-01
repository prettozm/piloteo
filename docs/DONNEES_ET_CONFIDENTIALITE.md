# Pilotéo — Données et confidentialité

Ce document répond en clair à trois questions : quelles données Pilotéo traite,
où elles vivent selon le mode choisi, et qui en est responsable. Il complète
[`SECURITY.md`](SECURITY.md) (hypothèses de sécurité techniques) sans le
remplacer.

## 1. Quelles données

Pilotéo traite les données de pilotage d'un cabinet de conseil : identités des
consultants, affaires, missions, temps saisis, notes de frais, facturation,
suivi commercial. Ce sont des données professionnelles ; certaines (nom,
identifiant de connexion) sont des données personnelles au sens RGPD.

## 2. Où elles vivent, selon le mode

Pilotéo est **local-first** : il n'y a pas de base de données Pilotéo côté
éditeur. Les données vivent chez l'utilisateur ou l'organisation, selon le mode
choisi au déploiement :

| Mode | Stockage réel | Qui héberge |
|---|---|---|
| **Solo** | IndexedDB du navigateur, sur cet appareil | l'utilisateur, localement |
| **Dossier** | Fichiers d'événements dans un dossier choisi (disque local, ou dossier synchronisé par OneDrive/SharePoint/Drive Desktop…) | l'utilisateur ou son entreprise, via l'infrastructure de synchronisation qu'ils choisissent |
| **Organisation (dossier partagé)** | Même dossier, événements signés (Ed25519) partagés entre membres | l'organisation, via son propre dossier partagé |
| **Organisation (Google Drive)** | Google Drive de l'utilisateur/organisation, via OAuth et le scope `drive.file` | Google, sous le compte du client |
| **Auto-hébergement serveur** (option) | Une base SQLite sur le serveur que le client déploie lui-même (Docker, Fly.io, VPS…) | le client, sur son infrastructure |

**Dans tous les cas, Pilotéo (l'éditeur) ne reçoit et n'héberge aucune copie
des données.** Aucun serveur Pilotéo central ne collecte quoi que ce soit ; il
n'y a pas de télémétrie applicative. Le stockage, sa localisation géographique
et sa durée de vie dépendent entièrement du mode choisi et, pour les modes
Dossier/Drive/serveur, de l'infrastructure que l'utilisateur ou l'organisation
exploite ou souscrit par ailleurs (OneDrive, Google, hébergeur du serveur).

## 3. Le code PIN n'est pas un chiffrement

Le code PIN disponible en mode Solo/Dossier est un **verrou d'appareil** : il
empêche un usage accidentel ou l'accès direct depuis l'écran de l'appareil. Ce
n'est **pas un chiffrement** des données stockées. Un accès direct au support
de stockage (disque, dossier synchronisé, compte Drive) permet de lire les
événements. La confidentialité repose sur les permissions d'accès à ce support
(qui a accès au dossier, au compte, au disque), pas sur le PIN.

En mode Organisation, les événements sont **signés** (Ed25519, chaîne de
confiance cryptographique) mais **non chiffrés** : voir
[`architecture/CRYPTO_TRUSTED_VS_ENCRYPTED.md`](architecture/CRYPTO_TRUSTED_VS_ENCRYPTED.md)
pour l'arbitrage retenu et ses limites.

## 4. Export et suppression

- **Export** : chaque mode permet d'exporter les données (export local en mode
  Solo/Dossier ; les fichiers du dossier partagé/Drive sont directement
  consultables par leur propriétaire).
- **Suppression** : supprimer les données revient à supprimer le support qui
  les porte — la base IndexedDB de l'appareil (mode Solo), le dossier
  local/synchronisé (mode Dossier/Organisation), ou les fichiers dans Google
  Drive (mode Google Drive), ou la base du serveur auto-hébergé. Pilotéo ne
  conservant aucune copie centrale, il n'y a rien d'autre à effacer côté
  éditeur.

## 5. Qui est responsable

L'organisation qui déploie Pilotéo (le cabinet de conseil) reste **responsable
du traitement** au sens RGPD pour les données de ses consultants et de ses
clients : c'est elle qui choisit le mode de stockage, l'infrastructure de
synchronisation ou d'hébergement associée, et donc les durées de conservation,
les sauvegardes et les droits d'accès. Pilotéo fournit l'outil et les garanties
techniques décrites ici et dans `SECURITY.md` ; il ne se substitue pas à
l'analyse de conformité propre à chaque organisation.
