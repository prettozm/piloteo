# Pilotéo Next — moteur local-first (`src/`)

Cœur applicatif **local-first** de Pilotéo : modules ES sans framework ni
dépendance runtime, compatibles navigateur **et** Node (les tests tournent sous
`node --test`). Ils remplacent progressivement l'infrastructure de `server.py`
(auth, persistance, synchro, droits, sauvegardes) par des composants locaux,
**sans réécrire le métier** porté par `app.js`.

> V1 serveur reste l'oracle et fonctionne pendant toute la migration
> (réversible jusqu'à la Phase 10). Voir `docs/next/` (spec cible) et
> `archives/` (instantané V1 figé).

## Références de conception

- **`CONTRACTS.md`** — interfaces figées entre modules (à lire en premier).
- **`V1_DOMAIN_MAP.md`** — carte autoritaire du domaine V1 (collections, droits
  `can_change`/`filter_state`, seams `app.js`, dette de validation).

## Modules

| Dossier / fichier | Rôle | Tests |
|---|---|---|
| `events/event-schema.js` | Enveloppe d'événement immuable, `canonicalize` déterministe, `ENTITY_TYPES` | `tests/next/events.test.mjs` |
| `events/validation.js` | Validation structurelle stricte (refus NaN/Infinity, types, enums, bornes) — dette V1 corrigée | idem |
| `events/reducer.js` | Projection pure `{entityType:{identité:entité}, __versions}`, delete = tombstone | idem |
| `events/conflict.js` | `classify` apply/duplicate/conflict par version d'entité | idem |
| `events/event-log.js` | Journal, ordre causal déterministe, `replay()` reconstructible | idem |
| `crypto/crypto-service.js` | Ed25519 (signature), AES-256-GCM (AEAD), wrap X25519 ECDH-ES+HKDF | `tests/next/crypto.test.mjs` |
| `crypto/keyring.js` | Epochs de clé + rotation | idem |
| `core/permissions.js` | **PolicyEngine** (port fidèle `can_change`) + `filterProjectionForRole` (`filter_state`) | `tests/next/policy.test.mjs` |
| `workspace/workspace.js` | `WorkspaceRuntime` (mode local/team) | `tests/next/workspace.test.mjs` |
| `workspace/memberships.js` | Memberships (rôle par workspace, multi-workspace) | idem |
| `workspace/invitations.js` | Invitations expirantes/révocables/consommables | idem |
| `storage/local-store.js` | **LocalStore** IndexedDB (8 stores, migration, export/import `.piloteobackup`) | `tests/next/local-store.test.mjs` |
| `storage/storage-adapter.js` | Contrat de transport de blobs (aucune règle métier) | `tests/next/sync.test.mjs` |
| `storage/in-memory-adapter.js` | Adaptateur write-once + simulation offline (tests, mode local) | idem |
| `storage/google-drive-adapter.js` | Squelette Drive (`NOT_WIRED` — spike OAuth requis) | idem |
| `sync/sync-engine.js` | **SyncEngine** : pull/push/sync, pipeline hostile, conflits, résilience | idem |
| `license/license.js` | Licence offline signée Ed25519, essai 20j, enforcement | `tests/next/license.test.mjs` |
| `migration/v1-import.js` | Import export V1 → workspace + genesis + `compareCollections` | `tests/next/migration.test.mjs` |
| `integration/localstore-bridge.js` | Pont Phase 1 (inerte par défaut) + `chooseStartMode` | `tests/next/integration.test.mjs` |

Outils hors PWA : `tools/license-gen/` (générateur de licence éditeur, clé privée
hors dépôt), `tools/v1-export/` (export lecture seule de la base V1).

## Lancer les tests

```bash
npm run test:next          # suite local-first (node:test + fake-indexeddb)
# ou directement :
node --test "tests/next/**/*.test.mjs"
```

La suite V1 serveur reste indépendante : `python3 -m unittest discover -s tests`.

## Chaîne d'un événement (mode Team)

```text
UI/commande → PolicyEngine (accept?) → buildEvent → EventLog(local, pending)
   → SyncEngine.push : encryptPayload + sign → StorageAdapter.putImmutable
   ← SyncEngine.pull : verify envelope → verify signature → decrypt
       → validate → verify membership → policy → classify → reduce → projection
```

## Ce qui reste *gated* (voir `docs/architecture/07-decisions-et-limites.md`)

- Câblage OAuth Google + REST Drive (`google-drive-adapter` est un squelette).
- Intégration UI dans `app.js`/`index.html` et coquille PWA (Phase 2).
- **Revue sécurité humaine de la crypto** avant toute promesse commerciale.
- Retrait du serveur V1 (Phase 10), après recette d'une organisation migrée.
