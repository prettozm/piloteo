# Déploiement Pilotéo — package « Hosted »

Pilotéo se déploie comme **une seule instance conteneurisée** : le serveur
historique `server.py` (Python standard, sans dépendance applicative externe) et
sa base **SQLite** persistante, empaquetés en image Docker. C'est le **même
package unique** partout : Fly.io, un VPS OVH, ou toute autre cible ne sont que
des façons différentes de lancer cette image. Il n'existe pas de « backend Fly »
ni de « backend OVH » spécifique.

Cette page est le démarrage rapide. Le **contrat de déploiement de référence**
(variables, volumes, sauvegarde/restauration, mise à jour) est
[`docs/deployment/HOSTED_GENERIC.md`](docs/deployment/HOSTED_GENERIC.md).

## Démarrage en 4 étapes

```bash
# 1. Récupérer le code
git clone <url-du-depot-prive> piloteo && cd piloteo

# 2. Configurer les secrets (jamais commités)
cp .env.example .env
#    éditer .env : au minimum PILOTEO_ADMIN_PASSWORD (12 car. min.),
#    PILOTEO_ADMIN_CONSULTANT_ID, et PILOTEO_FORCE_HTTPS=1 en production.

# 3. Préparer les volumes persistants
mkdir -p data backups

# 4. Lancer
docker compose up -d --build
```

Le service écoute par défaut sur `127.0.0.1:8080` (voir `docker-compose.yml`).
Vérifier la santé : `curl -fsS http://127.0.0.1:8080/api/health`.

## Ce que fournit le package

- **Backend** : `server.py` (image Docker, utilisateur non-root, arrêt propre sur
  SIGTERM).
- **Persistance** : base SQLite dans le volume `data/` ; sauvegardes dans le
  volume `backups/`.
- **Healthcheck** : `GET /api/health` (défini dans l'image et dans
  `docker-compose.yml`).
- **Secrets hors image** : uniquement via variables d'environnement / fichier
  `.env` non commité.
- **Port configurable** : `8080` par défaut.

## HTTPS

Le TLS **n'est pas** assuré par Pilotéo : il est fourni par l'hébergeur ou par un
**reverse proxy HTTPS** (Caddy, Nginx, Traefik, ou le proxy Fly). Ne publiez pas
le port `8080` directement ; placez-le derrière le proxy et passez
`PILOTEO_FORCE_HTTPS=1`. Exemple minimal : `Caddyfile.example`.

## Exemples de cibles (même package)

- Fly.io : [`docs/deployment/FLY.md`](docs/deployment/FLY.md)
- VPS OVH / Linux : [`docs/deployment/OVH_VPS.md`](docs/deployment/OVH_VPS.md)

## Sauvegarde / restauration

Sauvegardes automatiques quotidiennes + manuelles depuis `/support`, conservées
dans `backups/`. Restauration, service arrêté :

```bash
python scripts/restore_backup.py backups/piloteo-YYYYMMDD-HHMMSS-manual.sqlite3
```

Détails complets dans [`docs/deployment/HOSTED_GENERIC.md`](docs/deployment/HOSTED_GENERIC.md).
