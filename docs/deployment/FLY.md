# Pilotéo sur Fly.io

Fly.io est **un exemple** de déploiement du package Pilotéo « Hosted ». Ce n'est
pas un backend spécifique : c'est la **même image Docker** que partout ailleurs,
lancée sur l'infrastructure Fly. Tout le fond (variables, volumes, sauvegarde,
mise à jour, healthcheck) est dans
[`HOSTED_GENERIC.md`](HOSTED_GENERIC.md) — cette page ne couvre que les
spécificités Fly.

## Ce que Fly fournit

- **HTTPS terminé par le proxy Fly** (`force_https = true`) — vous n'exploitez pas
  de reverse proxy vous-même. `PILOTEO_FORCE_HTTPS=1` est déjà posé.
- **Sonde de santé** sur `GET /api/health`.
- **Volume persistant** pour la base SQLite.

Le modèle est fourni : [`../../fly.toml`](../../fly.toml). Contrainte
d'architecture : **une seule machine** (SQLite mono-instance) — ne jamais passer
`count > 1`.

## Déploiement manuel

```bash
fly launch --no-deploy            # ou réutiliser fly.toml existant
fly volumes create piloteo_data --region cdg --size 1

# Secrets (jamais dans l'image) :
fly secrets set \
  PILOTEO_ADMIN_USERNAME=admin \
  PILOTEO_ADMIN_PASSWORD='<mot-de-passe-12-car-min>' \
  PILOTEO_ADMIN_CONSULTANT_ID=ADM \
  PILOTEO_ADMIN_NAME='Administrateur' \
  PILOTEO_ORG_NAME='Cabinet Exemple'

fly deploy --ha=false
```

Fly ne monte qu'un volume par machine : `fly.toml` place donc les sauvegardes sur
le même volume que la base (`PILOTEO_BACKUP_DIR = "/data/backups"`).

## Provisionnement automatisé (un client)

Le script [`../../scripts/fly-new-client.sh`](../../scripts/fly-new-client.sh)
crée l'app, le volume, les secrets (mot de passe généré, affiché une seule fois)
et déploie :

```bash
scripts/fly-new-client.sh dupont "Cabinet Dupont" ADM cdg
```

## Points d'attention

- Une **app Fly par client** (isolation : volume, secrets et URL distincts).
- Réplication hors-site optionnelle via Litestream : voir §3 et §4 de
  [`HOSTED_GENERIC.md`](HOSTED_GENERIC.md).
- Sauvegarde/restauration : identiques au générique (§8). Restaurer service
  arrêté.
