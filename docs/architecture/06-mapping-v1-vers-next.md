# 6. Mapping V1 → Next et avancement

Référence : `docs/next/03_MIGRATION_V1_VERS_LOCAL_FIRST.md` (mapping §2 et
phases), `src/V1_DOMAIN_MAP.md` (référence domaine).

## 6.1 Tableau de correspondance des responsabilités

| V1 (`server.py`/`app.js`) | Next (module livré) |
|---|---|
| `users` (table serveur) | Google Identity (mode Team) + `membership` (`workspace/memberships.js`) |
| mot de passe Pilotéo | supprimé (aucune trace dans Next) |
| sessions serveur | contexte local (`WorkspaceRuntime`) + OAuth Google temporaire (non câblé, §3 Drive) |
| `app_state` (état global serveur) | projection locale (`events/reducer.js#reduce`, reconstruite par `EventLog#replay`) |
| `state_history` (100 dernières révisions) | journal d'événements immuables (`events/event-log.js`) |
| SQLite serveur | IndexedDB (`storage/local-store.js`, 8 object stores) |
| `filter_state()` | `core/permissions.js#filterProjectionForRole` |
| `can_change()` | `core/permissions.js#evaluate` (PolicyEngine) |
| `merge_client_state()` (révision globale + conflit par entité) | `events/conflict.js#classify` + `sync/sync-engine.js` (SyncEngine) |
| backup SQLite serveur | réplication Drive (non câblée) + export local (`LocalStore.exportBackup` → `.piloteobackup`) |
| audit log serveur | journal d'événements (`EventLog`) + `genesisEvent` d'audit d'import |
| `/support` (`support.html`/`support.js`) | administration du workspace (non livrée — reste côté V1 tant que le serveur n'est pas retiré) |
| Docker/`docker-compose.yml`/Fly.io | hébergement statique PWA (non livré — reste l'hébergement actuel) |

## 6.2 Avancement par phase (`docs/next/03` Phases 0-10)

| Phase | Objectif | État dans ce lot |
|---|---|---|
| 0 — Geler la référence V1 | Fixer `app.js`/`server.py` comme référence figée | ✅ implicite (référence lue, non modifiée) |
| 1 — `LocalStore` sans supprimer le serveur | Introduire IndexedDB derrière l'état existant | ✅ **fait et testé** — `src/storage/local-store.js`, `tests/next/local-store.test.mjs` |
| 2 — Mode Solo | Workspace local sans compte Google | ✅ **fait et testé** — `workspace/workspace.js#createLocalWorkspace`, `tests/next/workspace.test.mjs` |
| 3 — Journal d'événements | Enveloppe, reducer, ordre déterministe | ✅ **fait et testé** — `src/events/*`, `tests/next/events.test.mjs` |
| 4 — Conflits locaux simulés | Classification apply/duplicate/conflict | ✅ **fait et testé** — `events/conflict.js`, intégré à `EventLog#replay` |
| 5 — Crypto | Ed25519, AES-256-GCM, X25519 wrap | ✅ **implémenté et testé unitairement** — `src/crypto/*`, `tests/next/crypto.test.mjs` — ⚠️ **gate non levé** : revue sécurité humaine requise avant promesse commerciale (`docs/next/05` §16) |
| 6 — Google Identity + Drive Adapter | Synchroniser 2 navigateurs sans backend | 🟡 **gated** — `GoogleDriveStorageAdapter` est un squelette (`NotWiredError` sur toute méthode réseau) ; le gate « deux navigateurs distincts convergent via Drive » n'est pas atteignable sans le spike OAuth/Drive (§3 `03-synchronisation-stockage.md`) |
| 7 — Invitations et memberships | Onboarding, révocation, rotation de clé | 🟡 **partiel** — `workspace/invitations.js`/`memberships.js` livrés et testés en isolation ; le gate « un utilisateur révoqué ne peut plus lire les nouveaux événements » n'est vérifié qu'en conditions simulées (`InMemoryStorageAdapter`), pas en conditions Drive réelles (dépend de la Phase 6) |
| 8 — Licence | Essai 20j, licence signée, enforcement | ✅ **fait et testé** — `src/license/license.js`, `tools/license-gen/`, `tests/next/license.test.mjs` — ⚠️ `EDITOR_PUBLIC_KEY_JWK` reste un placeholder à remplacer avant distribution |
| 9 — Migration V1 réelle | Import + comparateur avant/après | ✅ **fait et testé** — `src/migration/v1-import.js`, `tests/next/migration.test.mjs` — ⚠️ l'écran V1 "Administration → Export migration" suggéré par la spec n'est pas livré côté `app.js`/`server.py` (l'import consomme un export déjà produit) |
| 10 — Retrait du serveur | Retirer `server.py`, Docker, etc. | ❌ **non fait, gated** — explicitement conditionné (`docs/next/03` §Point de non-retour : "il n'y en a pas avant la Phase 10") à la validation des gates 6 et 7 en conditions réelles ; le serveur V1 est intact dans ce dépôt |

**Synthèse** : les phases 1 à 5, 8 et 9 constituent le **socle métier
local-first**, livrées et couvertes par les 171 tests `node:test` verts. Les
phases 6, 7 (en conditions réelles) et 10 sont **gated** par le spike réseau
Google Drive, non entrepris dans ce lot.

## 6.3 Règle de code respectée pendant la migration

Conformément à `docs/next/03` §3, ce lot n'a :
- **pas** réécrit les règles métier (portage fidèle de `can_change`/`filter_state`,
  avec citations de ligne V1 dans `src/V1_DOMAIN_MAP.md`) ;
- **pas** introduit de framework front, TypeScript, serveur temporaire de
  sync, ni de double modèle métier ;
- **ajouté** des interfaces/adapters (`StorageAdapter`), des tests
  (171, `node --test`), et un reducer déterministe — exactement le périmètre
  autorisé.
