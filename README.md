# Pilotéo V1

Pilotéo est l'outil de suivi des affaires, du commercial, des temps, des frais et de la facturation de Novalia Censis.

Cette V1 transforme le prototype HTML autonome en **petite application professionnelle multi-utilisateur** sans réécrire son métier : l'interface et les règles fonctionnelles restent dans `index.html`, tandis que `server.py` apporte l'authentification, les droits côté serveur, la persistance SQLite, la synchronisation, l'audit et les sauvegardes.

## Ce que la V1 garantit

- comptes nominatifs avec mot de passe ;
- session serveur en cookie `HttpOnly`, protection CSRF et limitation des tentatives de connexion ;
- **les données non autorisées ne sont pas envoyées au navigateur** ;
- un administrateur voit et maintient le cabinet entier ;
- un utilisateur voit son périmètre personnel et les affaires qui le concernent ; un pilote voit les données nécessaires au pilotage de ses affaires ;
- écritures persistées dans SQLite, journal WAL ;
- synchronisation automatique entre navigateurs, détection des conflits sur une même donnée ;
- journal d'audit des connexions, comptes et modifications ;
- sauvegardes automatiques quotidiennes + sauvegarde manuelle ;
- console support administrateur à `/support` ;
- aucune ressource web tierce chargée par l'application.

Ce n'est volontairement **pas** une architecture d'entreprise complexe : pas de microservices, pas de Kubernetes, pas de SSO, pas de Redis. Pour cinq utilisateurs légèrement extensibles, cela ne répondrait à aucun besoin actuel.

## Démarrage local

```bash
cp .env.example .env
# éditer .env, surtout le mot de passe administrateur et le consultant associé
mkdir -p data backups

docker compose up --build
```

Puis ouvrir `http://127.0.0.1:8080` depuis la machine hôte.

Au premier démarrage, aucun mot de passe par défaut n'est accepté. Le serveur exige :

- `PILOTEO_ADMIN_USERNAME` ;
- `PILOTEO_ADMIN_PASSWORD` (12 caractères minimum) ;
- `PILOTEO_ADMIN_CONSULTANT_ID` ;
- `PILOTEO_ADMIN_NAME`.

Le fichier `seed.json` reprend le jeu de données de démonstration du prototype et initialise la base uniquement à sa création. Les données réelles vivent ensuite dans `data/piloteo.sqlite3`, qui est exclu de Git.

## Mise à disposition des collègues

**En production, ne pas publier directement le port HTTP 8080.** Placer Pilotéo derrière le reverse proxy HTTPS déjà utilisé par l'entreprise et passer `PILOTEO_FORCE_HTTPS=1`. `Caddyfile.example` montre le cas minimal si aucun proxy n'existe déjà.

Le proxy doit conserver l'adresse d'origine (`X-Forwarded-For`) et ne doit pas exposer `data/`, `backups/` ou `seed.json`. Le serveur Pilotéo lui-même ne sert que `index.html`, `support.html` et les API prévues.

## Administration courante

Un administrateur ouvre **Administration → Support & exploitation** ou directement `/support` pour :

- créer un compte rattaché à un consultant existant ;
- réinitialiser un mot de passe ;
- désactiver/réactiver un compte ;
- accorder/retirer le rôle administrateur ;
- créer une sauvegarde immédiate ;
- consulter les 200 dernières traces d'audit.

La fonction existante « Voir sa page » reste disponible pour le support. Une action effectuée dans ce mode reste auditée comme une action de l'administrateur connecté.

## Sauvegarde

- une sauvegarde SQLite cohérente est créée automatiquement au maximum une fois par jour ;
- les sauvegardes manuelles sont disponibles depuis `/support` ;
- conservation par défaut : 30 fichiers ;
- **le dossier `backups/` doit lui-même être copié vers un stockage différent du serveur** (NAS protégé, sauvegarde SI, coffre, etc.). Une copie sur le même disque ne protège pas d'une panne du disque.

Restauration : arrêter Pilotéo, puis :

```bash
python scripts/restore_backup.py backups/piloteo-YYYYMMDD-HHMMSS-manual.sqlite3
```

Le script vérifie l'intégrité de la sauvegarde et garde une copie de sécurité de la base remplacée.

## Tests

```bash
python -m unittest discover -s tests -v
python -m py_compile server.py
```

Un test réel recommandé avant mise en production : ouvrir deux navigateurs avec deux utilisateurs distincts, saisir un temps de chaque côté, vérifier la synchronisation, puis vérifier qu'un utilisateur ne peut ni ouvrir les vues société ni obtenir leurs données via `/api/state`.

## Documentation de reprise

Lire dans cet ordre :

1. [`docs/AI_HANDOFF.md`](docs/AI_HANDOFF.md) — point d'entrée pour une autre IA ou un nouveau développeur ;
2. [`docs/ARCHITECTURE_V1.md`](docs/ARCHITECTURE_V1.md) — composants, données, synchro et droits ;
3. [`docs/SECURITY.md`](docs/SECURITY.md) — hypothèses de sécurité et niveau attendu ;
4. [`docs/EXPLOITATION.md`](docs/EXPLOITATION.md) — installation, support, sauvegarde, restauration et incidents ;
5. [`docs/cahier-des-charges.md`](docs/cahier-des-charges.md) — référence fonctionnelle ;
6. [`docs/modele-de-donnees.md`](docs/modele-de-donnees.md) — modèle métier historique.

Le principe de maintenance est simple : **ne pas refaire le métier dans le serveur**. Le serveur protège, persiste et synchronise ; `index.html` continue de porter les règles métier tant qu'une vraie séparation front/API n'est pas justifiée par la taille ou l'usage.
