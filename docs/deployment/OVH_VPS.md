# Pilotéo sur un VPS OVH (ou tout VPS Linux)

Un VPS OVH est **un exemple** de déploiement du package Pilotéo « Hosted » —
strictement le **même package** que sur Fly ou ailleurs. La procédure ci-dessous
vaut pour tout VPS Linux générique. Tout le fond (variables, volumes, sauvegarde,
mise à jour, healthcheck) est dans [`HOSTED_GENERIC.md`](HOSTED_GENERIC.md) ;
cette page ne couvre que la mise en place sur la machine.

## 1. Installer Docker

```bash
curl -fsSL https://get.docker.com | sh
```

(`docker compose` est inclus via le plugin.)

## 2. Récupérer, configurer, lancer

```bash
git clone <url-du-depot-prive> piloteo && cd piloteo
cp .env.example .env      # éditer : PILOTEO_ADMIN_PASSWORD, ..., PILOTEO_FORCE_HTTPS=1
mkdir -p data backups
docker compose up -d --build
```

Le service n'écoute que sur `127.0.0.1:8080` (voir `docker-compose.yml`) : il
n'est **pas** exposé directement sur Internet.

## 3. Reverse proxy HTTPS (Caddy)

Le TLS est fourni par un reverse proxy que vous exploitez. Caddy obtient et
renouvelle le certificat automatiquement. `/etc/caddy/Caddyfile` minimal :

```caddyfile
piloteo.exemple.fr {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

Puis `systemctl reload caddy`. Voir aussi
[`../../Caddyfile.example`](../../Caddyfile.example). Nginx ou Traefik
conviennent tout autant, du moment qu'ils transmettent `X-Forwarded-For` ; si
l'IP du proxy sort des plages privées, ajoutez-la à `PILOTEO_TRUSTED_PROXIES`.

## 4. Exploitation

- **Sauvegardes** : copiez régulièrement `backups/` **hors du VPS** (une copie
  locale ne protège pas d'une panne disque). Restauration : §8 de
  [`HOSTED_GENERIC.md`](HOSTED_GENERIC.md), service arrêté.
- **Mise à jour** : `git pull && docker compose up -d --build` (les volumes
  survivent).
- **Santé** : `curl -fsS http://127.0.0.1:8080/api/health`.
