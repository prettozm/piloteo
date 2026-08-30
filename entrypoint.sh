#!/bin/sh
# Point d'entrée du conteneur Pilotéo.
#
# 1. Démarre en root pour préparer les volumes (Fly.io et Docker montent les
#    volumes appartenant à root), puis ABANDONNE les privilèges : l'application
#    tourne toujours sous l'utilisateur non-root `piloteo` (uid 1000).
# 2. Si LITESTREAM_REPLICA_URL est défini (ex. s3://bucket/piloteo), la base est
#    restaurée depuis la réplique au premier démarrage sur volume vierge, puis
#    répliquée en continu hors-site pendant toute la vie du process.
set -eu

DATA_DIR="${PILOTEO_DATA_DIR:-/data}"
BACKUP_DIR="${PILOTEO_BACKUP_DIR:-$DATA_DIR/backups}"
DB_PATH="$DATA_DIR/piloteo.sqlite3"

mkdir -p "$DATA_DIR" "$BACKUP_DIR"

if [ "$(id -u)" = "0" ]; then
    chown -R piloteo:piloteo "$DATA_DIR" "$BACKUP_DIR"
    DROP="setpriv --reuid=piloteo --regid=piloteo --clear-groups"
else
    DROP=""
fi

if [ -n "${LITESTREAM_REPLICA_URL:-}" ] && command -v litestream >/dev/null 2>&1; then
    echo "litestream: réplication continue vers ${LITESTREAM_REPLICA_URL}"
    $DROP litestream restore -if-db-not-exists -if-replica-exists \
        -o "$DB_PATH" "$LITESTREAM_REPLICA_URL"
    exec $DROP litestream replicate -exec "python server.py" \
        "$DB_PATH" "$LITESTREAM_REPLICA_URL"
fi

exec $DROP python server.py
