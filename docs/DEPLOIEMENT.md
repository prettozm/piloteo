# Pilotéo — Guide de déploiement

Comment mettre Pilotéo en production pour un cabinet d'environ cinq utilisateurs.
Architecture cible : une **instance unique** `server.py` (Python stdlib + SQLite)
en conteneur Docker, derrière le **reverse proxy HTTPS** de l'entreprise.

Voir aussi : `EXPLOITATION.md` (exploitation courante), `GUIDE_ADMINISTRATEUR.md`
(comptes), `SECURITY.md` (obligations de sécurité), `ARCHITECTURE_V1.md`.

## 1. Prérequis

- Un serveur Linux avec **Docker** et **Docker Compose** (plugin `docker compose`).
- Un **reverse proxy HTTPS** : soit celui déjà en place dans le SI, soit Caddy /
  Nginx / Traefik (un exemple Caddy minimal est fourni : `Caddyfile.example`).
- Un **nom DNS** interne ou public pointant vers le proxy.
- De quoi copier les sauvegardes **hors du serveur** (partage, stockage réseau…).

Pilotéo ne charge aucune ressource tierce et n'a **aucune dépendance applicative
externe** (les paquets npm ne servent qu'aux tests de développement).

## 2. Récupérer le code

```bash
git clone <url-du-depot-prive> piloteo
cd piloteo
```

Le dépôt doit rester **privé** : `seed.json` et les documents de projet peuvent
contenir des données non publiques.

## 3. Configurer `.env`

```bash
cp .env.example .env
```

Éditez `.env`. Variables importantes :

| Variable | Rôle | Recommandation prod |
|---|---|---|
| `PILOTEO_ADMIN_USERNAME` | Identifiant du 1ᵉʳ admin (création initiale) | à définir |
| `PILOTEO_ADMIN_PASSWORD` | Mot de passe du 1ᵉʳ admin (**12 car. min.**) | mot de passe fort |
| `PILOTEO_ADMIN_CONSULTANT_ID` | Identifiant du consultant rattaché | ex. `SMR` |
| `PILOTEO_ADMIN_NAME` | Nom affiché de l'admin | libre |
| `PILOTEO_FORCE_HTTPS` | `1` = cookie `Secure` + HSTS | **`1` en production** |
| `PILOTEO_TRUSTED_PROXIES` | Plages IP des proxies de confiance pour `X-Forwarded-For` | voir §6 |
| `PILOTEO_SESSION_HOURS` | Durée de session | `12` (défaut) |
| `PILOTEO_BACKUP_RETENTION` | Nombre de sauvegardes conservées | `30` (défaut) |
| `PILOTEO_PBKDF2_ITERATIONS` | Coût du hachage des mots de passe | `600000` (défaut) |

Les variables `PILOTEO_ADMIN_*` ne servent qu'à **la toute première
initialisation** (création du compte admin quand la base est vide). Aucun mot de
passe par défaut n'existe : sans ces variables, le serveur refuse de démarrer la
première fois.

`.env` contient des secrets : il est exclu de Git et du build Docker. Ne le
committez jamais.

## 4. Préparer les volumes (conteneur non-root)

Le conteneur tourne en utilisateur **non-root (uid 1000)**. Les dossiers de
données montés doivent lui appartenir :

```bash
mkdir -p data backups
sudo chown -R 1000:1000 data backups
```

- `data/` — la base `piloteo.sqlite3` (exclue de Git) ;
- `backups/` — les sauvegardes automatiques et manuelles.

## 5. Démarrer

```bash
docker compose up -d --build
docker compose ps
```

Le compose applique déjà les garde-fous de production : port publié uniquement
sur `127.0.0.1:8080` (jamais exposé directement), système de fichiers en lecture
seule, `no-new-privileges`, limites mémoire/CPU/pids, journalisation bornée,
healthcheck.

Test de santé (depuis l'hôte) :

```bash
curl http://127.0.0.1:8080/api/health   # attendu : {"status":"ok"}
```

Au premier démarrage, le compte administrateur défini dans `.env` est créé et la
base est initialisée à partir de `seed.json`.

## 6. Reverse proxy HTTPS

**Ne publiez jamais le port 8080 directement.** Placez Pilotéo derrière le proxy
HTTPS du SI, ou utilisez l'exemple Caddy :

```caddy
piloteo.example.fr {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

Le proxy doit :

1. terminer le **TLS** (HTTPS) ;
2. transmettre l'**IP réelle du client** dans `X-Forwarded-For` ;
3. ne **pas** exposer `data/`, `backups/`, `seed.json` ni `.env`.

**IP de confiance.** Pilotéo ne croit `X-Forwarded-For` que si le pair TCP direct
(le proxy) appartient à `PILOTEO_TRUSTED_PROXIES` (par défaut `127.0.0.0/8` +
plages privées). Si votre proxy a une IP hors de ces plages, ajoutez-la, sinon le
rate-limiting de connexion et le journal d'audit enregistreront l'IP du proxy au
lieu de celle du client :

```bash
PILOTEO_TRUSTED_PROXIES=127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
```

Puis passez `PILOTEO_FORCE_HTTPS=1` dans `.env` et redémarrez :

```bash
docker compose up -d
```

## 7. Checklist de mise en production

- [ ] `PILOTEO_FORCE_HTTPS=1` et accès en `https://` fonctionnel.
- [ ] Cookie de session marqué `Secure` (vérifier dans les outils navigateur).
- [ ] Port 8080 non joignable depuis l'extérieur (seul le proxy l'atteint).
- [ ] `PILOTEO_TRUSTED_PROXIES` cohérent avec l'IP du proxy ; l'audit enregistre
      la bonne IP client.
- [ ] `data/` et `backups/` appartiennent à l'uid 1000, hors de Git.
- [ ] Sauvegardes copiées automatiquement hors du serveur.
- [ ] Test de connexion avec un **compte utilisateur standard** avant d'ouvrir
      l'accès aux collègues.
- [ ] Dépôt Git **privé**.

## 8. Mises à jour

```bash
# 1. sauvegarde manuelle (bouton /support ou attendre la sauvegarde du jour)
# 2. récupérer le code
git pull
# 3. rejouer les tests (voir EXPLOITATION.md §7)
python -m unittest discover -s tests -v
# 4. reconstruire et redémarrer
docker compose up -d --build
# 5. vérifier /api/health puis une connexion admin et une connexion utilisateur
```

Une mise à jour ne doit **jamais** supprimer `data/`. Le serveur refuse de
démarrer si la base est plus récente que le code (garde-fou de version de schéma).

## 9. Sauvegarde et restauration

- Sauvegardes automatiques quotidiennes + manuelles (voir `GUIDE_ADMINISTRATEUR.md`
  §7 et `EXPLOITATION.md` §5).
- Restauration (service arrêté) :

  ```bash
  docker compose down
  python scripts/restore_backup.py backups/<fichier>.sqlite3
  docker compose up -d
  ```

  Le script vérifie l'intégrité de la sauvegarde, crée une copie `before-restore`
  et **refuse** de restaurer si le service tourne encore (option `--force` en
  dernier recours).

## 10. Dépannage

| Symptôme | Piste |
|---|---|
| Le conteneur ne démarre pas au 1ᵉʳ lancement | Variables `PILOTEO_ADMIN_*` manquantes ou mot de passe < 12 caractères → voir les logs `docker compose logs`. |
| Erreurs de permission sur `data/`/`backups/` | Dossiers non possédés par l'uid 1000 → `sudo chown -R 1000:1000 data backups`. |
| L'audit enregistre l'IP du proxy | Ajuster `PILOTEO_TRUSTED_PROXIES` et le `header_up X-Forwarded-For` du proxy (§6). |
| Cookie non `Secure` | `PILOTEO_FORCE_HTTPS=1` et accès réellement en HTTPS. |
| `unhealthy` en `docker ps` | `curl` interne échoue → consulter `docker compose logs`. |
| Espace disque plein | Purger d'anciennes sauvegardes ; ajuster `PILOTEO_BACKUP_RETENTION`. |

## 11. Déploiement multi-clients sur Fly.io (recommandé)

Pilotéo est **white-label** : une instance = un client, totalement isolée
(application, volume, secrets et URL distincts). SQLite impose **une seule
machine par client** (jamais `count > 1`).

### Provisionner un nouveau client

```bash
# prérequis : flyctl installé et connecté (fly auth login)
scripts/fly-new-client.sh dupont "Cabinet Dupont" ADM cdg
```

Le script crée l'app `piloteo-dupont`, son volume persistant, ses secrets
(nom du cabinet, compte admin + **mot de passe généré affiché une seule fois**),
puis déploie. Il affiche l'URL `https://piloteo-dupont.fly.dev` et les
identifiants à transmettre au client par un canal sûr.

### Personnaliser la marque

- **Nom** : secret `PILOTEO_ORG_NAME` (posé par le script, modifiable via
  `fly secrets set -a piloteo-<client> PILOTEO_ORG_NAME="…"`).
- **Logo** : déposer `logo.svg` (ou `.png`/`.jpg`) dans `/data/branding/` sur le
  volume du client (`fly ssh sftp shell -a piloteo-<client>`), servi ensuite sur
  `/brand-logo`. Sans dépôt, un logo neutre est utilisé.

### Réplication continue hors-site (Litestream)

Fortement recommandée en production. Exporter les identifiants S3 avant de
provisionner (ou les ajouter ensuite avec `fly secrets set`) :

```bash
export LITESTREAM_REPLICA_URL=s3://mon-bucket/piloteo-dupont
export AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...
export AWS_ENDPOINT_URL_S3=https://s3.fr-par.scw.cloud   # S3 non-AWS (UE)
scripts/fly-new-client.sh dupont "Cabinet Dupont" ADM cdg
```

La base est restaurée depuis la réplique si le volume est vierge, puis répliquée
en continu. Les sauvegardes quotidiennes internes (`/data/backups`) restent
actives en complément.

### Mise à jour d'un client

```bash
fly deploy -a piloteo-<client> --ha=false
```

Le garde-fou de version de schéma empêche de démarrer sur une base plus récente
que le code. Déployer d'abord sur l'instance de recette, valider, puis les clients.

## 12. Environnements de dev / recette gratuits

- **Dev local** : `docker compose -f docker-compose.yml -f docker-compose.dev.yml up`
  (base jetable `./data-dev`, identifiants de dev, code monté en volume).
- **Dev / recette cloud gratuits** : ouvrir le dépôt dans **GitHub Codespaces**
  (`.devcontainer/` fourni) ; lancer `python server.py` et rendre le port 8080
  **public** pour une recette partagée. **Données de démo uniquement.**
- **Recette permanente gratuite** : VM **Oracle Cloud Always Free** avec le même
  `docker compose`.

> RGPD : sur tout environnement de dev/recette, **jamais de données réelles** —
> uniquement le `seed.json` de démonstration (entièrement fictif).

## 13. Capacité et limites

Cette architecture convient tant que : quelques utilisateurs, une seule équipe,
une seule instance, temps de réponse satisfaisant, conflits rares, pas
d'intégration SI exigeant une API métier stable. Au-delà (dizaines
d'utilisateurs actifs, plusieurs instances, intégrations, reporting direct sur la
base), envisager PostgreSQL + API normalisée — voir `EXPLOITATION.md` §8 et
`ARCHITECTURE_V1.md`.
