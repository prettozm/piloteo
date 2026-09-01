# Contrat — Point 6 : assistant de mode (déployeur) + déploiement simplifié

> Implémente l'ASSISTANT que `docs/DEPLOYER_CONTRACT.md` a spécifié (jusqu'ici non
> construit) : une seule question, 4 réponses → valider → écrire la config runtime.
> Rend le déploiement **hébergé** (Fly / VPS OVH) réellement « une commande » (les
> artefacts Docker/Fly/compose existent déjà — NE PAS les réécrire, les
> ORCHESTRER). Ferme aussi le raccord config→site statique pour `GOOGLE_CLIENT_ID`.
> `app.js`/`server.py` intacts. Réutilise `runtime-config.js`/`storage-factory.js` —
> ne réimplémente aucun métier.

## 0. Ce qui existe déjà (à réutiliser, NE PAS dupliquer)

`Dockerfile`, `fly.toml`, `scripts/fly-new-client.sh`, `scripts/docker-compose.yml`
(via `docker-compose.yml` racine), `entrypoint.sh`, `docs/deployment/{FLY,OVH_VPS,
HOSTED_GENERIC}.md`, `Caddyfile.example`, `docs/DEPLOYER_CONTRACT.md` (la SPEC),
`src/config/runtime-config.js` (`normalizeConfig`, `configFromEnv`),
`src/storage/storage-factory.js`.

## 1. Le déployeur CLI — `tools/deploy/piloteo-deploy.mjs` (Node stdlib, zéro dépendance)

Fait EXACTEMENT les 4 choses de `docs/DEPLOYER_CONTRACT.md` §1 (choisir / valider /
écrire / lancer éventuellement) — rien de plus.

- **Interactif** : pose « Comment souhaitez-vous utiliser Pilotéo ? » avec les 4
  réponses (Local / Dossier partagé / Google Drive / Hébergement serveur). En
  Dossier/Drive, demande les sous-paramètres minimaux (Drive : `GOOGLE_CLIENT_ID`
  public ; Dossier : rien de plus). Hébergement : demande la cible (Fly / VPS).
- **Non-interactif** (CI / répétable) : mêmes réponses via flags/env
  (`--mode`, `--provider`, `--google-client-id`, `--target`, `--yes`), sans prompt.
- **Valider** les prérequis du mode (DEPLOYER_CONTRACT §4) : Drive → `GOOGLE_CLIENT_ID`
  présent et de forme plausible sinon refuser ; Dossier → rappeler le prérequis
  File System Access (navigateur) ; Hébergement → Docker/fly CLI présents.
- **Écrire** la config **exactement** au format `normalizeConfig` (source de vérité) :
  - un artefact JSON `deploy/piloteo.runtime.json` (config normalisée) ;
  - pour le **site statique/PWA** : un fichier `deploy/piloteo.config.js` qui pose
    `window.PILOTEO_MODE`, et si Drive `window.PILOTEO_GOOGLE_CLIENT_ID` — le SEUL
    canal par lequel le pont Drive lit le client id (cf. `piloteo-drive-bridge.mjs`).
    JAMAIS de secret ; le client id OAuth est public. Idempotent (réécriture stable).
  - pour le mode **hébergé** : un `.env` (à partir de `.env.example`) — sans jamais
    inventer/écrire un mot de passe en clair par défaut (laisser des placeholders).
- **Lancer éventuellement** (mode Hébergement uniquement, et seulement si `--deploy`)
  la commande adéquate : Fly → `scripts/fly-new-client.sh <nom>` ; VPS →
  `scripts/deploy-vps.sh` (voir §2). Par défaut, n'exécute RIEN : il IMPRIME la
  commande exacte à lancer (dry-run par défaut, exécution sur `--deploy`).
- Le déployeur ne touche NI au moteur, NI aux événements, NI à la crypto, NI à la
  projection. Toute logique au-delà de choisir/valider/écrire/lancer est hors scope.

## 2. « Une commande » pour l'hébergé

- **Fly** : `scripts/fly-new-client.sh` existe → le déployeur l'appelle (ne pas le
  réécrire ; le compléter seulement si un prérequis manque, en le documentant).
- **VPS/OVH** : ajouter `scripts/deploy-vps.sh` — wrapper idempotent qui enchaîne
  ce que `docs/deployment/OVH_VPS.md` décrit à la main : vérifie Docker, crée
  `data/`+`backups/`, copie `.env.example`→`.env` s'il manque (placeholders,
  s'arrête en demandant de l'éditer si des placeholders obligatoires subsistent),
  puis `docker compose up -d --build`, puis `curl` du healthcheck. Ne contient
  aucun secret. Sûr à relancer (met à jour, ne détruit pas les volumes).
- GitHub Pages (PWA statique) reste le 4e chemin, inchangé (`pages.yml`).

## 3. Raccord config → site statique (ferme le gap Drive)

- Le pont `piloteo-drive-bridge.mjs` lit `window.PILOTEO_GOOGLE_CLIENT_ID` (déjà
  le cas). Le déployeur produit `deploy/piloteo.config.js` qui le pose. **NOTE**:
  le chargement de ce `config.js` + du pont Drive dans `index.html` est câblé
  SÉPARÉMENT (hors de ce lot, par l'orchestrateur) pour éviter un conflit d'édition
  sur `index.html`. Ce lot fournit le fichier de config et documente le `<script>`
  exact à insérer (ordre : `piloteo.config.js` AVANT les ponts).

## 4. Tests (obligatoires) — `tests/next/deployer.test.mjs` (node:test)

Sur la logique PURE du déployeur (extraire la logique dans des fonctions
importables ; le prompt interactif n'est pas testé, le chemin non-interactif l'est) :
1. mode Local → config `{mode:"local",storage:{provider:"indexeddb"}}` (via
   `normalizeConfig`, égalité exacte).
2. Dossier → `{mode:"shared",storage:{provider:"folder"}}`.
3. Drive avec `GOOGLE_CLIENT_ID` → `{mode:"shared",storage:{provider:"google-drive",
   googleClientId:"..."}}` ; SANS client id → **échec de validation** explicite.
4. Hébergé → `{mode:"hosted",...}` conforme au contrat.
5. `deploy/piloteo.config.js` généré pour Drive contient `window.PILOTEO_GOOGLE_CLIENT_ID`
   = la valeur, et `window.PILOTEO_MODE` ; ne contient AUCUN secret ; idempotent
   (deux générations → contenu identique).
6. Config invalide (mode inconnu, provider incohérent) → rejet via `normalizeConfig`,
   message clair, aucun fichier écrit.
`npm run test:next` reste vert.

## 5. Contraintes

- `app.js`/`server.py` intacts. NE touche PAS `index.html` ni `local-backend.js`
  (raccord fait par l'orchestrateur). NE réécris pas les artefacts Docker/Fly/compose
  existants (orchestrer/compléter seulement).
- Config au format `normalizeConfig` uniquement (source de vérité). Aucun secret
  écrit (client id OAuth public OK ; jamais de mot de passe/clé). Scripts idempotents.
- Node stdlib uniquement (pas de dépendance npm nouvelle).
