# Pilotéo Next — Handoff IA / développeur

## Mission

Faire évoluer Pilotéo V1 serveur vers Pilotéo Next local-first.

Ne pas reconstruire Pilotéo.

Le métier existant est la référence.

---

## Lire avant de coder

Référence V1 :

1. `README.md`
2. `docs/ARCHITECTURE_V1.md`
3. `docs/cahier-des-charges.md`
4. `docs/modele-de-donnees.md`
5. `app.js`
6. `server.py`

Puis dossier Next :

1. `01_CDC_LOCAL_FIRST.md`
2. `02_ARCHITECTURE_CIBLE.md`
3. `03_MIGRATION_V1_VERS_LOCAL_FIRST.md`
4. `04_SYNC_ET_STOCKAGE_DRIVE.md`
5. `05_SECURITE_CRYPTO_IDENTITE.md`
6. `06_LICENCE_ET_ESSAI.md`
7. `07_TESTS_ET_RECETTE.md`

---

## Principe

> Remplacer l’infrastructure, préserver le métier.

La V1 a déjà la séparation utile :

- `app.js` : métier/UI ;
- `server.py` : infrastructure/sécurité/sync.

La cible déplace les responsabilités du serveur vers des composants locaux.

---

## Invariants absolus

1. Pas de backend métier Pilotéo.
2. Pas de donnée métier en clair sur Drive.
3. Pas de mot de passe Pilotéo Team.
4. Mode solo sans Google.
5. Les droits sont vérifiés sur chaque événement.
6. Une UI masquée n’est jamais une sécurité.
7. Conflit même entité = explicite.
8. Entités différentes = convergence.
9. Event log rejouable.
10. Projection reconstruisible.
11. Export toujours possible.
12. Licence par workspace.
13. Pas de secret éditeur dans le client.
14. Ne pas élargir le scope Drive sans preuve de nécessité.
15. Ne pas introduire CRDT, framework ou backend “pour faire propre”.

---

## Première tâche recommandée

Ne pas commencer par Google ni la crypto.

Commencer par Phase 1 :

> introduire `LocalStore`/IndexedDB derrière l’état existant, sans changer l’UX et tout en conservant le serveur V1.

Livrable :

- interface de persistance ;
- tests ;
- aucun changement fonctionnel visible.

Puis mode Solo.

---

## Décisions à ne pas rouvrir sans preuve

- PWA statique comme cible ;
- IndexedDB pour V2 initiale ;
- journal d’événements immuables ;
- Google Drive comme premier `StorageAdapter`;
- pas de gros SQLite chiffré partagé ;
- pas de CRDT complet ;
- licence offline signée ;
- essai Team 20 jours ;
- lecture/export après expiration.

---

## Points nécessitant spike avant engagement

1. comportement exact de `drive.file` pour un utilisateur invité ;
2. UX Picker nécessaire ou non ;
3. stockage pratique de clés CryptoKey dans IndexedDB selon navigateurs cibles ;
4. primitives crypto retenues et compatibilité ;
5. limites/performance du modèle un-fichier-par-événement sur Drive ;
6. PWA iOS/Android si cible store ultérieure.

Un spike n’autorise pas à élargir l’architecture.

---

## Dette V1 à ne pas propager

Valider structurellement toutes les données.

Refuser :

- NaN ;
- Infinity ;
- types incohérents ;
- payloads non bornés.

La V1 serveur acceptait trop facilement certaines valeurs JSON Python non standards ; Next ne doit pas reprendre cette faiblesse.

---

## Critère de bon changement

Chaque changement doit répondre à une question :

> Est-il nécessaire pour atteindre la phase en cours ?

Si non : ne pas le faire.
