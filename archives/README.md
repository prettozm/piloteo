# Archives Pilotéo

Ce dossier conserve des **instantanés figés** de Pilotéo, pris à un moment
précis pour servir de **référence** (oracle de non-régression) et permettre un
**retour en arrière** si une évolution majeure devait être abandonnée.

Une archive n'est **jamais** modifiée après création. On n'y touche pas : elle
photographie un état passé, pas l'état courant du dépôt.

---

## Contenu

| Fichier | Version | Date | Commit | Description |
|---|---|---|---|---|
| `piloteo-v1.1.0-20260830-96728f9.zip` | 1.1.0 | 2026-08-30 | `96728f9` | Pilotéo V1 serveur complet (Python + SQLite), juste avant le début de la migration local-first. |

---

## À quoi correspond `piloteo-v1.1.0-20260830-96728f9.zip`

C'est **Pilotéo V1 dans son état de production**, tel qu'il tournait au moment
où l'on a décidé de démarrer la migration vers l'architecture **local-first**
décrite dans [`docs/next/`](../docs/next/).

Cette version est l'**architecture serveur** :

- `server.py` — authentification, sessions, droits côté serveur, persistance
  SQLite, synchronisation, audit, sauvegardes ;
- `index.html` + `app.js` — interface et **règles métier** (temps, frais,
  affaires, missions, facturation, pilotage) ;
- Docker / `docker-compose.yml` / `Caddyfile.example` / `fly.toml` —
  déploiement ;
- `docs/` — documentation fonctionnelle et d'exploitation V1 ;
- `tests/` — suite de tests Python (52 tests) + e2e Playwright.

Au moment de l'archivage, la suite de tests V1 était **entièrement verte**
(`python3 -m unittest discover -s tests` → 52 tests OK).

### Pourquoi cette archive existe

La migration local-first est **progressive et réversible** (voir
`docs/next/03_MIGRATION_V1_VERS_LOCAL_FIRST.md`). Pendant toute la migration,
la V1 serveur reste la **base fonctionnelle de référence** : c'est elle qui
définit le comportement métier attendu. Cette archive garantit qu'on peut, à
tout moment, revenir exactement à cet état, indépendamment de l'historique Git.

Le point de non-retour (retrait de `server.py`, Docker, SQLite serveur) n'est
prévu qu'en **Phase 10**, après validation complète de la recette.

---

## Comment repartir de cette archive

L'archive est un instantané du code source suivi par Git (elle **n'inclut pas**
`.git/`, ni les données locales `data/`, `backups/`, ni `node_modules/`).

Extraction :

```bash
mkdir -p /tmp/piloteo-v1.1.0
unzip archives/piloteo-v1.1.0-20260830-96728f9.zip -d /tmp/piloteo-v1.1.0
```

Reconstituer l'environnement d'exécution (voir aussi le `README.md` contenu
dans l'archive) :

```bash
cd /tmp/piloteo-v1.1.0
cp .env.example .env      # renseigner l'admin et le consultant associé
mkdir -p data backups
docker compose up --build # puis http://127.0.0.1:8080
```

Rejouer les tests de référence :

```bash
python3 -m unittest discover -s tests -v
```

### Retour en arrière au niveau Git

Le même état est aussi récupérable directement via Git, l'archive n'étant qu'une
sécurité indépendante du dépôt :

```bash
git checkout 96728f9        # état exact V1 1.1.0
# ou, pour repartir proprement d'une branche :
git switch -c retour-v1 96728f9
```

---

## Convention

- Une archive = un `.zip` **immuable** + une ligne dans le tableau ci-dessus.
- Nommage : `piloteo-v<version>-<AAAAMMJJ>-<commit-court>.zip`.
- On ajoute une archive avant chaque **bascule structurelle** (fin d'une phase
  majeure, changement d'architecture, retrait d'un composant).
