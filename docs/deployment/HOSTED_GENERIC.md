# Pilotéo « Hosted » — contrat de déploiement générique

Ce document est **la référence** du déploiement de Pilotéo en mode hébergé. Il
décrit le **package unique et portable** — l'image Docker du serveur historique
`server.py` avec sa base SQLite persistante — indépendamment de la cible.

> **Un seul package, plusieurs cibles.** Fly.io et OVH/VPS ne sont que des
> **exemples** de lancement de ce même package. Il n'existe **pas** de « backend
> Fly » ni de « backend OVH » : le binaire, les variables, les volumes et le
> contrat de santé sont identiques partout. Les guides
> [`FLY.md`](FLY.md) et [`OVH_VPS.md`](OVH_VPS.md) ne font que renvoyer ici pour
> le fond.

## 1. Prérequis

- Un hôte Linux avec **Docker** et le plugin **`docker compose`**.
- Un **reverse proxy HTTPS** fournissant le TLS : soit celui de l'hébergeur (proxy
  Fly, etc.), soit un proxy que vous exploitez (**Caddy**, **Nginx** ou
  **Traefik**). Pilotéo **ne termine pas** le TLS lui-même. Un exemple Caddy
  minimal est fourni : [`../../Caddyfile.example`](../../Caddyfile.example).
- Un **nom DNS** pointant vers le proxy.
- Un emplacement pour copier les sauvegardes **hors de l'hôte**.

Pilotéo ne charge aucune ressource tierce et n'a **aucune dépendance applicative
externe** (les paquets npm ne servent qu'aux tests de développement).

## 2. Le package

| Fichier | Rôle |
|---|---|
| `Dockerfile` | Construit l'image (Python 3, utilisateur non-root, healthcheck, arrêt propre). |
| `docker-compose.yml` | Lancement de production : volumes, limites de ressources, healthcheck, port. |
| `.env.example` | Modèle de configuration à copier en `.env` (jamais commité). |
| `entrypoint.sh` | Prépare les volumes, abandonne les privilèges, démarre `server.py` (option Litestream). |
| `README_DEPLOY.md` | Démarrage rapide (racine du dépôt). |

Le serveur écoute par défaut sur le port **8080** ; en production `docker-compose.yml`
ne l'expose que sur `127.0.0.1:8080`, à mettre derrière le proxy HTTPS.

## 3. Variables d'environnement

Source : `.env.example` et `server.py`. Les secrets ne vivent **que** dans le
fichier `.env` (non commité, exclu du build Docker) ou dans le gestionnaire de
secrets de l'hébergeur.

### Initialisation du premier administrateur (première mise en route uniquement)

Ces variables ne sont lues qu'au **tout premier démarrage**, quand la base est
vide. Aucun mot de passe par défaut n'existe : sans elles, le serveur **refuse de
démarrer** la première fois.

| Variable | Description |
|---|---|
| `PILOTEO_ADMIN_USERNAME` | Identifiant du 1ᵉʳ administrateur. |
| `PILOTEO_ADMIN_PASSWORD` | Mot de passe du 1ᵉʳ administrateur — **12 caractères minimum**. |
| `PILOTEO_ADMIN_CONSULTANT_ID` | Identifiant du consultant rattaché (existant dans `seed.json` ou nouveau). |
| `PILOTEO_ADMIN_NAME` | Nom affiché de l'administrateur (défaut : `Administrateur Pilotéo`). |

### Configuration de service

| Variable | Défaut | Description |
|---|---|---|
| `PILOTEO_ORG_NAME` | `Pilotéo` | Marque affichée (white-label). |
| `PILOTEO_FORCE_HTTPS` | `0` | `1` en production : cookies `Secure` + HSTS. Suppose un accès HTTPS. |
| `PILOTEO_SESSION_HOURS` | `12` | Durée de validité d'une session. |
| `PILOTEO_BACKUP_RETENTION` | `30` | Nombre de sauvegardes conservées. |
| `PILOTEO_DATA_DIR` | `/data` | Répertoire de la base SQLite (volume persistant). |
| `PILOTEO_BACKUP_DIR` | `/backups` | Répertoire des sauvegardes (volume persistant). |
| `PILOTEO_HOST` | `0.0.0.0` | Interface d'écoute interne du conteneur. |
| `PILOTEO_PORT` | `8080` | Port d'écoute interne du conteneur. |
| `PILOTEO_TRUSTED_PROXIES` | boucle locale + plages privées | Plages IP dont `X-Forwarded-For` est cru. À compléter si le proxy a une IP hors plage privée. |
| `PILOTEO_PBKDF2_ITERATIONS` | `600000` | Coût du hachage des mots de passe (avancé). |
| `PILOTEO_HISTORY_LIMIT` | `100` | Taille de l'historique conservé par entité (avancé). |

### Réplication hors-site (optionnelle, Litestream)

Ne s'active que si `LITESTREAM_REPLICA_URL` est défini. Réplique la base en
continu vers un stockage objet S3 et la restaure au premier démarrage sur volume
vierge.

| Variable | Description |
|---|---|
| `LITESTREAM_REPLICA_URL` | URL de la réplique, ex. `s3://mon-bucket/piloteo`. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Identifiants du stockage objet. |
| `AWS_ENDPOINT_URL_S3` | Endpoint pour un S3 non-AWS (Scaleway, OVH…). |

## 4. Volumes et persistance

Deux volumes persistants, montés par `docker-compose.yml` :

- **`data/` → `/data`** : la base `piloteo.sqlite3` (journal WAL). C'est la donnée
  réelle ; elle est exclue de Git.
- **`backups/` → `/backups`** : les sauvegardes SQLite.

Sur une cible qui ne monte **qu'un seul volume par machine** (Fly.io), placez les
sauvegardes sur ce même volume (`PILOTEO_BACKUP_DIR=/data/backups`).

**Copiez régulièrement le contenu de `backups/` hors de l'hôte** (stockage réseau,
coffre, S3…). Une copie sur le même disque ne protège pas d'une panne disque. La
réplication Litestream (§3) répond à ce besoin de façon continue.

## 5. Lancement

```bash
cp .env.example .env      # puis éditer .env
mkdir -p data backups
docker compose up -d --build
```

En développement local, une surcouche jetable existe :
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up`.

## 6. Healthcheck

Le contrat de santé est **`GET /api/health`**. Il est défini à la fois dans
l'image (`HEALTHCHECK` du `Dockerfile`) et dans `docker-compose.yml`, et sert
aussi de sonde côté hébergeur (proxy Fly, etc.).

```bash
curl -fsS http://127.0.0.1:8080/api/health
```

Le conteneur s'arrête **proprement sur SIGTERM** (moins de 10 s), ce qui permet un
`docker compose down` ou une bascule de machine sans corruption.

## 7. HTTPS (fourni par l'hébergeur / le reverse proxy)

Pilotéo suppose que **le TLS est terminé en amont**. Ne publiez jamais le port
`8080` directement sur Internet.

- Placez Pilotéo derrière le reverse proxy HTTPS (Caddy/Nginx/Traefik) ou le proxy
  de l'hébergeur.
- Passez `PILOTEO_FORCE_HTTPS=1`.
- Le proxy doit transmettre l'IP d'origine via `X-Forwarded-For` (voir
  `Caddyfile.example`) ; ajoutez son IP à `PILOTEO_TRUSTED_PROXIES` si elle sort
  des plages privées.

## 8. Sauvegarde et restauration

- Une sauvegarde SQLite cohérente est créée **automatiquement au plus une fois par
  jour** ; des sauvegardes manuelles sont disponibles depuis `/support`.
- Rétention par défaut : `PILOTEO_BACKUP_RETENTION` (30).

**Restauration** (script `scripts/restore_backup.py`) — le service doit être
**arrêté** ; le script vérifie l'intégrité de la sauvegarde et conserve une copie
de sécurité de la base remplacée :

```bash
docker compose down
python scripts/restore_backup.py backups/piloteo-YYYYMMDD-HHMMSS-manual.sqlite3
docker compose up -d
```

Le script refuse de restaurer sur une base en cours d'utilisation (garde-fou
`-wal`/`-shm` et verrou), sauf `--force`.

## 9. Mise à jour

Image reconstruite depuis le dépôt :

```bash
git pull
docker compose up -d --build
```

La base et les sauvegardes vivent dans les volumes : elles **survivent** au
rebuild. Faites une sauvegarde manuelle avant une mise à jour importante, et
vérifiez `GET /api/health` après le redémarrage.

## 10. Voir aussi

- [`FLY.md`](FLY.md) — le même package sur Fly.io.
- [`OVH_VPS.md`](OVH_VPS.md) — le même package sur un VPS OVH / Linux.
- [`../DEPLOIEMENT.md`](../DEPLOIEMENT.md) — mise en production pas à pas et checklist.
- [`../EXPLOITATION.md`](../EXPLOITATION.md) — exploitation courante, incidents.
