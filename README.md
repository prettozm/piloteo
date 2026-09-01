# Pilotéo

Pilotéo est un outil de pilotage de cabinet de conseil : affaires, commercial,
temps, frais et facturation. C'est une **PWA local-first** — il n'y a pas de
base de données Pilotéo côté éditeur, et **Pilotéo n'héberge aucune donnée**.
Les données vivent sur l'appareil de l'utilisateur ou dans l'infrastructure que
son organisation choisit.

## Les trois modes

| Mode | Où vivent les données | Prérequis |
|---|---|---|
| **Solo** | IndexedDB, sur cet appareil uniquement | n'importe quel navigateur moderne |
| **Dossier** | Fichiers d'événements dans un dossier choisi (local, ou synchronisé par OneDrive, SharePoint via OneDrive, Google Drive Desktop…) | navigateur Chromium desktop (File System Access) |
| **Organisation** | Dossier partagé entre membres, événements **signés Ed25519** (dossier de confiance, non chiffré) ; ou Google Drive du client via OAuth (`drive.file`) | dossier partagé accessible à tous les membres, ou compte Google |

Aucun de ces modes ne fait transiter de donnée par un serveur Pilotéo. La
confidentialité repose sur les permissions du support choisi (dossier, compte
Drive), pas sur Pilotéo. Voir
[`docs/DONNEES_ET_CONFIDENTIALITE.md`](docs/DONNEES_ET_CONFIDENTIALITE.md).

**Le code PIN est un verrou d'appareil, pas un chiffrement** : il évite un
usage accidentel depuis l'écran de l'appareil, il ne protège pas les données en
cas d'accès direct au dossier ou au compte qui les porte.

## Auto-hébergement serveur (option)

Pour une organisation qui préfère un backend classique plutôt que du
local-first, le serveur historique (`server.py` + SQLite, comptes nominatifs,
sauvegardes) reste disponible et peut être **auto-hébergé** par le client
(Docker, Fly.io, VPS OVH ou équivalent) :

- [`docs/deployment/HOSTED_GENERIC.md`](docs/deployment/HOSTED_GENERIC.md) — référence du package hébergé (Docker, variables, sauvegardes, healthcheck) ;
- [`docs/deployment/FLY.md`](docs/deployment/FLY.md), [`docs/deployment/OVH_VPS.md`](docs/deployment/OVH_VPS.md) — deux cibles d'exemple, même package ;
- [`docs/DEPLOIEMENT.md`](docs/DEPLOIEMENT.md) — mise en production pas à pas.

C'est une **option de déploiement**, pas le mode par défaut : Pilotéo ne fait
aucune promesse de serveur, de localisation géographique ou de comptes
nominatifs par défaut. Le mode se choisit à l'installation — voir
[`docs/DEPLOYER_CONTRACT.md`](docs/DEPLOYER_CONTRACT.md) et
[`docs/deployment/DEPLOYER.md`](docs/deployment/DEPLOYER.md).

## Tests

```bash
npm run test:next          # tests unitaires (node:test + fake-indexeddb)
node tests/e2e/smoke.mjs   # e2e Playwright/Chromium (voir tests/e2e/*.mjs pour les autres scénarios)
```

## Documentation

**Pour commencer :**

- [`docs/manuel-utilisateur/README.md`](docs/manuel-utilisateur/README.md) — manuel utilisateur (démarrer, au quotidien, équipe, licence, sauvegarde, FAQ) ;
- [`docs/exploitation/README.md`](docs/exploitation/README.md) — installation et exploitation local-first ;
- [`docs/modes/FOLDER_STORAGE.md`](docs/modes/FOLDER_STORAGE.md) — détail du mode Dossier.

**Sécurité et données :**

- [`docs/SECURITY.md`](docs/SECURITY.md) — hypothèses et niveau de sécurité ;
- [`docs/DONNEES_ET_CONFIDENTIALITE.md`](docs/DONNEES_ET_CONFIDENTIALITE.md) — quelles données, où, PIN vs chiffrement, export/suppression, responsabilités ;
- [`docs/architecture/CRYPTO_TRUSTED_VS_ENCRYPTED.md`](docs/architecture/CRYPTO_TRUSTED_VS_ENCRYPTED.md) — modèle de confiance retenu pour le mode Organisation.

**Architecture et conception (dev / IA) :**

- [`CLAUDE.md`](CLAUDE.md) — invariants du projet et protocole de développement ;
- [`docs/architecture/README.md`](docs/architecture/README.md) — architecture moteur canonique (événements, crypto, sync/stockage, droits, licence) ;
- [`docs/next/`](docs/next/) — contrats de lot (oracle de chaque évolution) ; le lot en cours documente son contrat et son manuel dans ce dossier ;
- [`docs/archive/`](docs/archive/) — audits, rapports de passe et cahier des charges initial, conservés pour l'historique.

Le principe de maintenance reste celui d'origine : **ne pas refaire le métier
ailleurs**. `app.js` porte les règles fonctionnelles, `server.py` reste intact ;
toute la logique local-first passe par des ponts (`local-backend.js`,
`piloteo-*-bridge.mjs`) sans jamais modifier ces deux fichiers.
