# Binaire Litestream (réplication SQLite hors-site, activée seulement si
# LITESTREAM_REPLICA_URL est défini au run) — copié depuis l'image officielle
# épinglée, pas de téléchargement à vérifier.
FROM litestream/litestream:0.3.13 AS litestream

FROM python:3.14-slim

# setpriv (util-linux) : abandon des privilèges en préservant la transmission
# des signaux (arrêt propre SIGTERM). ca-certificates : TLS pour Litestream → S3.
RUN apt-get update && apt-get install -y --no-install-recommends util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Utilisateur applicatif non-root : l'entrypoint démarre en root uniquement
# pour préparer les volumes, puis abandonne les privilèges (setpriv).
RUN useradd --system --uid 1000 --create-home --home-dir /home/piloteo piloteo

WORKDIR /app
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY server.py index.html app.js support.html support.js seed.json VERSION entrypoint.sh ./
COPY assets/ ./assets/
RUN chmod +x /app/entrypoint.sh

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PILOTEO_DATA_DIR=/data \
    PILOTEO_BACKUP_DIR=/backups \
    PILOTEO_HOST=0.0.0.0 \
    PILOTEO_PORT=8080

RUN mkdir -p /data /backups && chown -R piloteo:piloteo /data /backups

EXPOSE 8080

# Healthcheck aussi dans l'image pour rester portable hors docker-compose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3).read()" || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
