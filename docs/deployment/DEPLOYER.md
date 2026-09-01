# Le déployeur — `tools/deploy/piloteo-deploy.mjs`

Cette page documente l'**outil** qui applique
[`docs/DEPLOYER_CONTRACT.md`](../DEPLOYER_CONTRACT.md) : une question, quatre
réponses → valider → écrire la configuration runtime → lancer éventuellement
(mode Hébergement uniquement). Elle ne redéfinit rien du fond déjà documenté
ailleurs — voir [`HOSTED_GENERIC.md`](HOSTED_GENERIC.md) (le package hébergé),
[`FLY.md`](FLY.md) / [`OVH_VPS.md`](OVH_VPS.md) (les deux cibles), et
[`../modes/FOLDER_STORAGE.md`](../modes/FOLDER_STORAGE.md) (mode Dossier).

Node stdlib uniquement (zéro dépendance npm). La configuration produite passe
toujours par `normalizeConfig` (`src/config/runtime-config.js`, seule source de
vérité du format) : le déployeur ne réimplémente aucun métier.

## Interactif

```bash
node tools/deploy/piloteo-deploy.mjs
```

Pose la question unique du contrat (Local / Dossier partagé / Google Drive /
Hébergement serveur), demande les sous-paramètres minimaux du mode choisi, puis
écrit la configuration.

## Non interactif (CI, répétable)

```bash
node tools/deploy/piloteo-deploy.mjs --mode local --yes
node tools/deploy/piloteo-deploy.mjs --mode shared --provider folder --yes
node tools/deploy/piloteo-deploy.mjs --mode shared --provider google-drive \
  --google-client-id 123456789-abc123.apps.googleusercontent.com --yes
node tools/deploy/piloteo-deploy.mjs --mode hosted --endpoint https://piloteo.example.fr \
  --target vps --yes            # dry-run : imprime la commande, n'exécute rien
node tools/deploy/piloteo-deploy.mjs --mode hosted --endpoint https://piloteo.example.fr \
  --target vps --yes --deploy   # exécute réellement scripts/deploy-vps.sh
```

Les mêmes réponses peuvent venir de variables d'environnement plates
(`PILOTEO_MODE`, `PILOTEO_STORAGE`, `GOOGLE_CLIENT_ID`, `PILOTEO_ENDPOINT` —
mêmes noms que `configFromEnv`, docs/DEPLOYER_CONTRACT.md §2) ; un flag
explicite prime toujours sur la variable correspondante. `--help` liste toutes
les options.

`--google-client-id` n'est **jamais un secret** : c'est l'identifiant public
d'une application OAuth Google (CLAUDE.md §2.5). Le déployeur ne manipule
aucun autre secret (aucun mot de passe, aucun token, aucune clé). Sa forme est
validée strictement (`<numéro-de-projet>-<identifiant>.apps.googleusercontent.com`,
le format réel émis par Google) — un id contenant des métacaractères
(`</script>`, guillemets…) est rejeté avant même d'atteindre le fichier généré.

> **AVERTISSEMENT (`--deploy --target fly`)** — `scripts/fly-new-client.sh`
> affiche le mot de passe admin généré **une seule fois** sur sa sortie. Ce
> déployeur **rédige** (masque) cette ligne avant de la ré-émettre — mais si
> le terminal qui exécute `piloteo-deploy.mjs` a lui-même sa sortie persistée
> **sans rédaction en amont** (capture d'écran, wrapper qui logue avant
> d'appeler l'outil…), le secret pourrait quand même être exposé ailleurs
> dans la chaîne. Ne lancez `--deploy --target fly` que depuis un contexte
> dont vous maîtrisez la journalisation ; récupérez ensuite le mot de passe
> via `fly secrets`/le tableau de bord Fly plutôt que de compter sur la
> sortie affichée. La cible VPS (`scripts/deploy-vps.sh`) ne génère ni
> n'affiche jamais de secret : sa sortie reste en direct, sans rédaction.

## Ce que le déployeur écrit

| Fichier | Quand | Contenu |
|---|---|---|
| `deploy/piloteo.runtime.json` | toujours | la configuration normalisée (`normalizeConfig`), telle quelle. |
| `deploy/piloteo.config.js` | toujours | `window.PILOTEO_MODE`, et `window.PILOTEO_GOOGLE_CLIENT_ID` en mode Drive — le seul canal lu par `piloteo-drive-bridge.mjs`. Idempotent (réécriture stable). |
| `.env` (racine) | mode Hébergement, seulement s'il n'existe pas déjà | copie de `.env.example` (placeholders inchangés) — jamais de mot de passe inventé, jamais écrasé si déjà présent. |

## Raccord dans `index.html` (câblé par l'orchestrateur, pas par cet outil)

Cet outil ne modifie **pas** `index.html` (voir docs/next/DEPLOYER_ASSISTANT_CONTRACT.md
§3). Pour activer réellement la configuration écrite, `deploy/piloteo.config.js`
doit être chargé **avant** les ponts, dans cet ordre :

```html
<script src="deploy/piloteo.config.js"></script>
<!-- mode Google Drive uniquement, avant piloteo-drive-bridge.mjs : -->
<script src="https://accounts.google.com/gsi/client" async defer></script>
<script type="module" src="piloteo-drive-bridge.mjs"></script>
```

`piloteo.config.js` doit précéder tout pont qui lit `window.PILOTEO_*`
(actuellement `piloteo-drive-bridge.mjs`, seul lecteur de
`window.PILOTEO_GOOGLE_CLIENT_ID`) — voir `docs/next/DRIVE_LIVE_MANUAL.md` §2
pour le même ordre appliqué manuellement le temps que ce câblage soit fait.

## Lancement « une commande » (mode Hébergement)

Le déployeur **imprime** la commande de lancement par défaut (dry-run) et ne
l'exécute que sur `--deploy` explicite. Il n'écrit ni ne réécrit les artefacts
Docker/Fly/compose existants — il les **orchestre** :

- **Fly** : `scripts/fly-new-client.sh <client> "<Nom du cabinet>" <trigramme-admin> [region]`
  (flags `--client`/`--org-name`/`--admin-id`/`--region`).
- **VPS/OVH** : [`scripts/deploy-vps.sh`](../../scripts/deploy-vps.sh) — wrapper
  idempotent (vérifie Docker, prépare `data/`+`backups/`+`.env`, `docker compose
  up -d --build`, healthcheck `GET /api/health`). Sûr à relancer : ne détruit
  jamais les volumes, ne réécrase jamais un `.env` déjà édité, refuse de démarrer
  tant qu'un placeholder obligatoire subsiste, et vérifie spécifiquement que
  `PILOTEO_ADMIN_PASSWORD` fait **réellement au moins 12 caractères** (pas
  seulement que le placeholder littéral a disparu).
- **GitHub Pages** (PWA statique) reste un chemin séparé, inchangé (`pages.yml`) —
  hors du ressort de cet outil (pas de mode « Hébergement »).

## Tests

`tests/next/deployer.test.mjs` (`npm run test:next`) couvre la logique PURE
(choisir/valider → config, génération du contenu des fichiers, idempotence,
rejets) — le prompt interactif n'est pas testé unitairement (contrat).
