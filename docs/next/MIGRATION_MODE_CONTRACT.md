# Contrat — Point 5 : migration à la bascule de mode

> Quand l'utilisateur passe du mode **solo (IndexedDB, snapshot)** à un mode
> **Dossier / Organisation / Google Drive** ALORS QUE des données solo existent
> déjà, on convertit proprement l'état solo en **journal d'événements** dans la
> cible, SANS perte, de façon vérifiée et idempotente. `app.js`/`server.py`
> intacts ; tout passe par les ponts + `local-backend.js`. Réutilise
> `snapshotToEventsDiff`/`projectionToSnapshot` (solo-store) et les engines
> existants (folder/org/drive). Ne réécrit aucun moteur.

## 0. Principe

L'état solo est un **snapshot** (12 collections). Les modes cibles sont
**event-sourcés**. Migrer = produire, depuis le snapshot solo courant, le **jeu
d'événements initial** (diff depuis l'état vide) et l'écrire comme journal de la
cible, puis basculer le mode — **seulement après vérification** que la projection
de la cible est identique au snapshot solo (round-trip). Les données solo ne sont
JAMAIS supprimées tant que la cible n'est pas vérifiée.

## 1. Module `src/integration/migration.js` (pur, testable node)

```js
// Construit le jeu d'événements initial représentant un snapshot solo.
// Réutilise snapshotToEventsDiff(oldState=∅, newState=snapshot, {workspaceId, actorId, epoch, projection}).
export function snapshotToSeedEvents(snapshot, { workspaceId, actorId, epoch }) -> { events, rejected }

// Vérifie le round-trip : rejoue les events dans un EventLog/reducer neuf,
// projette, reconvertit en snapshot, et COMPARE au snapshot source (égalité
// profonde après normalisation : tombstones/clés réservées exclues, ordre ignoré).
export function verifyRoundTrip(snapshot, events) -> { ok, diff }  // diff = liste des écarts si !ok

// Plan de migration (pur, sans E/S) : décrit ce qui sera fait, détecte les cas.
export function planMigration({ soloSnapshot, targetExisting }) ->
  { kind: "seed" | "target-not-empty" | "nothing-to-migrate", counts }
```
Règles :
- `snapshotToSeedEvents` DÉTERMINISTE (même snapshot → mêmes events à IDs près ;
  les eventId sont des UUID, donc comparer par contenu/entité, pas par id).
- `rejected` non vide (clés réservées, entités malformées) → la migration
  **échoue explicitement** (ne migre pas un état partiel silencieusement).
- `verifyRoundTrip` est la **garde de sûreté** : si `!ok`, on N'ACTIVE PAS la cible.

## 2. Orchestration (`local-backend.js` + ponts, additif)

Au moment où l'utilisateur choisit **Créer une organisation / Utiliser un dossier /
Google Drive** (écran d'accueil OU Réglages), SI l'état solo courant est **non
vide** :
1. **Sauvegarde préalable obligatoire** : déclencher (ou proposer très visiblement)
   un export `.piloteobackup` de l'état solo AVANT toute écriture dans la cible.
   Ne pas continuer sans que la sauvegarde soit faite (au minimum : la proposer et
   tracer que l'utilisateur a vu l'avertissement).
2. **Cible vide attendue** : après avoir ouvert la cible (dossier/org/drive), si
   elle contient DÉJÀ des données (journal non vide) → NE PAS écraser/fusionner
   aveuglément : cas `target-not-empty` → demander à l'utilisateur (garder la
   cible existante et abandonner la migration, OU — hors scope de ce lot —
   fusionner). Par défaut : refuser et expliquer, jamais de perte.
3. **Seed** : `snapshotToSeedEvents(snapshotSolo, {workspaceId, actorId, epoch})`
   → écrire les events dans la cible via l'engine (folder/org/drive). En org, les
   events sont **signés** par l'identité locale (réutilise l'org-engine). Écriture
   **idempotente** : relancer une migration interrompue ne duplique pas (les events
   ont un contenu stable ; dédup par eventId côté store, ré-emploi de putImmutable
   write-once).
4. **Vérification** : recharger la projection de la cible → `verifyRoundTrip`. Si
   `!ok` → **abandon** : ne pas basculer `piloteo_storage_mode`, garder le solo
   actif, message d'erreur clair (les données solo sont intactes).
5. **Bascule** : seulement si `ok` → écrire `piloteo_storage_mode` + mémoriser le
   handle. Le solo IndexedDB reste conservé (backup) — proposer plus tard un
   nettoyage explicite, jamais automatique dans ce lot.
6. **Reprise après interruption** : si la migration est coupée entre 3 et 5,
   au prochain démarrage l'état est cohérent (solo toujours actif car mode non
   basculé ; la cible peut contenir un journal partiel → une nouvelle tentative
   est idempotente et re-vérifie).

## 3. UI

- Écran d'accueil / Réglages : quand des données solo existent et qu'on active un
  mode partagé, afficher un pas de **migration** explicite : « Vos données de cet
  appareil vont être copiées dans <cible> sous forme de journal. Une sauvegarde
  va être créée d'abord. » + barre/état de progression + résultat (succès →
  bascule ; échec → rien n'a changé, données intactes).
- Cas `target-not-empty` : message dédié (le dossier/Drive contient déjà un espace ;
  choisir un dossier vide, ou ouvrir l'existant sans migrer).

## 4. Tests (obligatoires)

`tests/next/migration.test.mjs` (node:test) :
1. `snapshotToSeedEvents` sur un snapshot réaliste (plusieurs collections) →
   `verifyRoundTrip` OK (projection cible == snapshot source).
2. Snapshot avec une entité supprimée (tombstone) → non ré-injectée (round-trip OK).
3. `rejected` non vide (clé réservée injectée) → migration signalée en échec.
4. Idempotence : appliquer deux fois les mêmes seed events dans un store neuf →
   une seule occurrence par entité (dédup eventId), projection identique.
5. `planMigration` : solo vide → `nothing-to-migrate` ; cible non vide →
   `target-not-empty` ; sinon `seed` avec les bons compteurs.
6. En mode org : seed events signés → `verifyRoundTrip` OK et signatures valides
   (réutiliser l'org-engine / la vérification de signature existante).

`tests/e2e/migration.mjs` (Playwright/Chromium, statique, style solo-folder.mjs,
via les hooks) :
7. Solo peuplé → « Créer une organisation » (handle factice) → après migration :
   `/api/state` en mode org renvoie le MÊME état métier que le solo avant bascule ;
   une sauvegarde a été produite ; le mode est bien passé à org.
8. Cible non vide → migration refusée, solo toujours actif, aucune perte.
9. Échec de `verifyRoundTrip` simulé (hook) → pas de bascule, solo intact.

`npm run test:next` reste vert.

## 5. Contraintes

- `app.js`/`server.py` intacts. Aucune suppression des données solo dans ce lot.
- Réutiliser `snapshotToEventsDiff`/`projectionToSnapshot`, les engines
  folder/org/drive, l'export `.piloteobackup` existant. Ne rien réécrire.
- Jamais de bascule de mode sans `verifyRoundTrip` OK. Jamais d'écrasement d'une
  cible non vide.
