# Pilotéo V1 — Reprise par une autre IA ou un nouveau développeur

## Mission du système

Pilotéo était un Artifact Claude constitué d'un unique `index.html`. La V1 ne cherche pas à le réécrire : elle rend ce prototype utilisable par environ cinq collègues avec authentification, droits, stockage partagé, synchronisation, sauvegardes et support.

**Principe de reprise : répondre au besoin strict et nécessaire.** Ne pas transformer spontanément Pilotéo en SaaS, microservices, framework front, PostgreSQL, IAM complexe ou pipeline cloud.

## Lire avant de modifier

1. `README.md`
2. `docs/ARCHITECTURE_V1.md`
3. `docs/SECURITY.md`
4. `docs/cahier-des-charges.md`
5. `docs/modele-de-donnees.md`
6. ensuite seulement `index.html` et `server.py`

`docs/journal-des-retours.md` sert à comprendre l'historique d'une règle fonctionnelle si nécessaire ; ce n'est pas le document à lire en premier.

## Fichiers clés

| Fichier | Responsabilité |
|---|---|
| `index.html` | UI et logique métier existantes ; charge l'état autorisé depuis `/api/state` |
| `server.py` | auth, droits, SQLite, synchro, audit, sauvegarde, fichiers statiques |
| `support.html` | petite console admin : comptes, sauvegarde, audit |
| `seed.json` | état initial du prototype, utilisé uniquement lors de la création d'une base |
| `docker-compose.yml` | exécution reproductible d'une instance |
| `.env.example` | configuration attendue |
| `tests/test_server.py` | tests minimaux de sécurité et de filtrage |
| `scripts/restore_backup.py` | restauration contrôlée |

## Invariants à ne pas casser

1. **Les droits sont appliqués côté serveur.** Cacher un bouton n'est jamais une mesure de sécurité suffisante.
2. Un utilisateur standard ne reçoit pas l'état complet du cabinet.
3. Le navigateur ne persiste pas les données métier en `localStorage`.
4. Aucune dépendance web tierce n'est chargée par l'application.
5. Un échec réseau ne doit pas faire croire à l'utilisateur que la donnée est synchronisée.
6. Une écriture concurrente sur la même entité doit produire un conflit visible, pas un écrasement silencieux.
7. La base et les sauvegardes ne doivent pas entrer dans Git.
8. Une action support faite en « Voir sa page » reste auditée sous le compte administrateur réel.
9. Ne pas normaliser toute la base ou changer de framework sans besoin concret démontré.
10. Garder `cahier-des-charges.md` et `modele-de-donnees.md` cohérents avec les évolutions métier.
11. **`seed.json` ne contient que des données fictives** (produit white-label). Regénérer via `scripts/make_demo_seed.py` ; jamais de données client réelles dans le dépôt.
12. **Tout le JS reste servi depuis des fichiers** (`app.js`, `support.js`) — aucun script ni gestionnaire d'événement en ligne, pour conserver la CSP `script-src 'self'`.
13. **Toute donnée affichée est échappée** (`esc()`), y compris via un helper/variable — vérifié par `tests/e2e/smoke.mjs`.

## Nature du produit : white-label, multi-clients

Pilotéo se déploie en **une instance isolée par client** (Fly.io : app, volume,
secrets et URL distincts — `scripts/fly-new-client.sh`). La marque est
paramétrable : `PILOTEO_ORG_NAME` (injecté côté serveur) et un logo déposé sur le
volume (`/data/branding`, route `/brand-logo`). Contrainte : **une seule machine
par client** (SQLite mono-instance). Voir `docs/DEPLOIEMENT.md`.

## Modèle de droits actuel

- compte `admin` : tout l'état et toutes les écritures ;
- compte `user` : ses temps, ses frais, demande de remboursement ;
- un `user` qui est pilote d'une affaire : lecture du nécessaire sur cette affaire et modification de l'affaire/missions ;
- facturation, paiement des frais, organisations, consultants, référentiels : admin.

Toute évolution des droits doit être modifiée **dans `server.py` d'abord**, puis reflétée dans l'interface.

## Synchronisation : piège principal

Le client envoie un snapshot de son état visible et sa `base_revision`. Le serveur reconstruit les changements par comparaison avec `state_history` puis les applique sur l'état canonique.

Ne pas remplacer cette logique par « le dernier navigateur qui sauvegarde écrase tout l'état » : cela réintroduirait exactement le risque que la V1 supprime.

Les identifiants nouvellement créés utilisent `newEntityId()`/UUID pour éviter les collisions entre utilisateurs. Les anciens identifiants (`A1`, `M1`...) restent supportés.

## Validation minimale après une modification

```bash
python -m py_compile server.py
python -m unittest discover -s tests -v
```

Puis en navigateur :

1. admin se connecte ;
2. utilisateur se connecte dans un autre profil ;
3. utilisateur ne voit pas les pages société ;
4. `/api/state` de l'utilisateur ne contient pas une affaire sans lien avec lui ;
5. utilisateur saisit un temps : indicateur revient à `Synchronisé` ;
6. admin voit cette saisie sans rechargement manuel après le polling ;
7. tentative de modification admin-only via API avec le compte user → HTTP 403 ;
8. sauvegarde manuelle → fichier créé et audit visible.

## Quand proposer une V1.1

Seulement sur friction réelle. Exemples probables :

- changement de mot de passe par l'utilisateur ;
- mot de passe oublié ;
- archivage plus fin d'un compte ;
- permissions supplémentaires entre `user` et `admin` ;
- notification explicite d'un conflit avec écran de comparaison ;
- import des données initiales depuis CSV/Excel ;
- SSO si le SI le demande.

Ne pas les implémenter par anticipation.
