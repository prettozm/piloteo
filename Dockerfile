FROM python:3.13-slim

# Utilisateur applicatif non-root (défense en profondeur : un RCE dans le
# process Python n'a pas l'uid 0 dans le conteneur).
RUN useradd --system --uid 1000 --create-home --home-dir /home/piloteo piloteo

WORKDIR /app
COPY server.py index.html app.js support.html support.js seed.json ./

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PILOTEO_DATA_DIR=/data \
    PILOTEO_BACKUP_DIR=/backups \
    PILOTEO_HOST=0.0.0.0 \
    PILOTEO_PORT=8080

# Les volumes data/ et backups/ sont montés au run ; ils doivent appartenir à
# l'uid 1000. Point de montage préparé et possédé par piloteo.
RUN mkdir -p /data /backups && chown -R piloteo:piloteo /data /backups

USER piloteo
EXPOSE 8080

# Healthcheck aussi dans l'image pour rester portable hors docker-compose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3).read()" || exit 1

CMD ["python", "server.py"]
