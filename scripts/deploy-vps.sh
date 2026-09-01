#!/bin/sh
# scripts/deploy-vps.sh — « une commande » pour l'hébergement VPS/OVH (Point 6,
# docs/next/DEPLOYER_ASSISTANT_CONTRACT.md §2). Enchaîne idempotemment ce que
# docs/deployment/OVH_VPS.md décrit à la main : vérifie Docker, crée
# data/+backups/, prépare .env depuis .env.example (placeholders, JAMAIS de
# mot de passe généré), docker compose up -d --build, healthcheck.
#
# Usage :
#   scripts/deploy-vps.sh
#
# Sûr à relancer : ne recrée jamais data/backups s'ils existent déjà, ne
# réécrit jamais .env s'il existe déjà (vos réglages sont préservés),
# `docker compose up -d --build` met seulement à jour l'image/le conteneur —
# les volumes (donc les données) ne sont jamais détruits.
set -eu

cd "$(dirname "$0")/.."

echo "== 1/5 Docker =="
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker introuvable. Installez-le : curl -fsSL https://get.docker.com | sh" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Le plugin 'docker compose' est requis (fourni par le script get.docker.com)." >&2
  exit 1
fi

echo "== 2/5 Volumes persistants (data/, backups/) =="
mkdir -p data backups

echo "== 3/5 Configuration (.env) =="
if [ ! -f .env ]; then
  if [ ! -f .env.example ]; then
    echo ".env.example introuvable — impossible de préparer .env." >&2
    exit 1
  fi
  cp .env.example .env
  echo "-> .env créé depuis .env.example (placeholders, aucun secret généré)."
fi

# Garde-fou générique : refuse de démarrer tant qu'un placeholder littéral
# "REMPLACER-PAR-" subsiste QUELQUE PART dans .env (couvre toute variable
# future marquée de la même façon, pas seulement le mot de passe admin).
if grep -q "REMPLACER-PAR-" .env; then
  echo "ERREUR : .env contient encore un placeholder non édité (grep REMPLACER-PAR-)." >&2
  echo "Éditez .env puis relancez ce script." >&2
  exit 1
fi

# Garde-fou DÉDIÉ à PILOTEO_ADMIN_PASSWORD : le contrôle ci-dessus ne vérifie
# que la disparition du placeholder LITTÉRAL, pas la longueur — un mot de
# passe d'un seul caractère (ex. PILOTEO_ADMIN_PASSWORD=1) passerait le grep
# tout en violant l'exigence annoncée (.env.example, README_DEPLOY.md,
# docs/deployment/HOSTED_GENERIC.md §3 : « 12 caractères minimum »). On
# extrait donc la valeur RÉELLE et on impose la longueur minimale réelle.
#
# `docker compose` (env_file) retire un éventuel COUPLE de guillemets (simples
# OU doubles) entourant toute la valeur avant de fixer la variable d'env
# réelle du conteneur — ex. PILOTEO_ADMIN_PASSWORD="1234567890" (10 caractères
# réels) devient bien 10 caractères pour server.py, PAS 12. Sans retirer ces
# guillemets ici aussi, la garde mesurerait 12 (10 + les 2 guillemets) et
# laisserait passer un mot de passe réellement trop court — server.py finirait
# par le rejeter au démarrage, mais avec un message « timeout healthcheck »
# trompeur au lieu du vrai diagnostic. On reproduit donc le même dépouillement
# AVANT de mesurer : au plus UNE paire de guillemets identiques en tête/queue.
admin_pass="$(sed -n 's/^PILOTEO_ADMIN_PASSWORD=//p' .env | head -1)"
# Retire AU PLUS une paire de guillemets (les deux mêmes) en tête/queue — pure
# expansion de paramètre POSIX (pas de sed à backreferences, plus simple à
# auditer). N'affecte pas les guillemets internes, ni un guillemet seul.
case "$admin_pass" in
  '"'*'"') admin_pass="${admin_pass#\"}"; admin_pass="${admin_pass%\"}" ;;
  "'"*"'") admin_pass="${admin_pass#\'}"; admin_pass="${admin_pass%\'}" ;;
esac
# NB : ce garde-fou ne décode PAS les échappements dotenv à l'intérieur de
# guillemets doubles (ex. "\n\n…" que docker compose interprète en vrais sauts de
# ligne). Dans ce cas rare, la longueur mesurée ici peut différer de la valeur
# réelle du conteneur, et le diagnostic peut donc être imprécis. Le VRAI rempart
# reste server.py, qui refuse tout mot de passe < 12 caractères et empêche le
# démarrage : aucun mot de passe faible ne devient jamais actif. Conseil : ne pas
# écrire PILOTEO_ADMIN_PASSWORD entre guillemets doubles avec des « \ ».
if printf '%s' "$admin_pass" | grep -q "REMPLACER-PAR-" || [ "${#admin_pass}" -lt 12 ]; then
  echo "ERREUR : PILOTEO_ADMIN_PASSWORD absent, placeholder, ou trop court (12 caractères minimum)." >&2
  echo "Éditez .env (PILOTEO_ADMIN_PASSWORD, 12 caractères minimum, guillemets non comptés) puis relancez ce script." >&2
  exit 1
fi

echo "== 4/5 Démarrage (docker compose up -d --build) =="
docker compose up -d --build

echo "== 5/5 Vérification de santé (GET /api/health) =="
ok=""
i=0
while [ "$i" -lt 10 ]; do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    ok=1
    break
  fi
  i=$((i + 1))
  sleep 2
done
if [ -z "$ok" ]; then
  echo "AVERTISSEMENT : /api/health ne répond pas encore après ~20s — vérifiez : docker compose logs" >&2
  exit 1
fi

echo
echo "======================================================================"
echo "  Pilotéo répond sur http://127.0.0.1:8080/api/health"
echo "  À placer derrière un reverse proxy HTTPS (voir docs/deployment/"
echo "  OVH_VPS.md et Caddyfile.example) — ne jamais exposer 8080 directement."
echo "======================================================================"
