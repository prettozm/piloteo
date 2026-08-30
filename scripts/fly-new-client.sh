#!/bin/sh
# Provisionne une instance Pilotéo pour un nouveau client sur Fly.io.
#
# Usage :
#   scripts/fly-new-client.sh <client> "<Nom du cabinet>" <trigramme-admin> [region]
# Exemple :
#   scripts/fly-new-client.sh dupont "Cabinet Dupont" ADM cdg
#
# Crée l'app piloteo-<client>, son volume, ses secrets (mot de passe admin
# généré et affiché UNE SEULE FOIS), puis déploie. Chaque client est isolé :
# app, volume, secrets et URL distincts.
#
# Optionnel (réplication continue hors-site via Litestream) : exporter avant
# l'appel LITESTREAM_REPLICA_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
# (et AWS_ENDPOINT_URL_S3 pour un S3 non-AWS, ex. Scaleway/OVH).
set -eu

CLIENT="${1:?usage: fly-new-client.sh <client> \"<Nom du cabinet>\" <trigramme-admin> [region]}"
ORG_NAME="${2:?nom du cabinet requis}"
ADMIN_CID="${3:?trigramme du consultant admin requis (ex. ADM)}"
REGION="${4:-cdg}"
APP="piloteo-$CLIENT"

command -v fly >/dev/null || { echo "flyctl requis: https://fly.io/docs/flyctl/install/"; exit 1; }

ADMIN_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')"

echo "== Création de l'app $APP ($REGION) =="
fly apps create "$APP"

echo "== Volume persistant (base + sauvegardes) =="
fly volumes create piloteo_data --app "$APP" --region "$REGION" --size 1 --yes

echo "== Secrets =="
fly secrets set --app "$APP" --stage \
    PILOTEO_ORG_NAME="$ORG_NAME" \
    PILOTEO_ADMIN_USERNAME="admin" \
    PILOTEO_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    PILOTEO_ADMIN_CONSULTANT_ID="$ADMIN_CID" \
    PILOTEO_ADMIN_NAME="Administrateur $ORG_NAME"

if [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
    echo "== Litestream (réplication hors-site) =="
    fly secrets set --app "$APP" --stage \
        LITESTREAM_REPLICA_URL="$LITESTREAM_REPLICA_URL" \
        AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:?}" \
        AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:?}" \
        ${AWS_ENDPOINT_URL_S3:+AWS_ENDPOINT_URL_S3="$AWS_ENDPOINT_URL_S3"}
fi

echo "== Déploiement =="
fly deploy --app "$APP" --ha=false

echo
echo "======================================================================"
echo "  Client        : $CLIENT"
echo "  URL           : https://$APP.fly.dev"
echo "  Admin         : admin"
echo "  Mot de passe  : $ADMIN_PASSWORD"
echo "  (à transmettre au client par un canal sûr — non ré-affichable)"
echo "  Logo client   : fly ssh sftp shell -a $APP  puis déposer"
echo "                  /data/branding/logo.svg (ou .png/.jpg)"
echo "======================================================================"
