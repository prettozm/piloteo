# Architecture Pilotéo Next — local-first

> Documentation d'architecture **fidèle au code livré**, pas seulement à la
> cible. Public : développeur ou IA reprenant le projet. Référence de
> conception normative : `src/CONTRACTS.md` et `src/V1_DOMAIN_MAP.md`. Spec
> cible : `docs/next/*`. Domaine métier V1 : `README.md`, `docs/ARCHITECTURE_V1.md`.

## Sommaire

| Fichier | Contenu |
|---|---|
| [`01-modele-evenementiel.md`](01-modele-evenementiel.md) | Enveloppe d'événement, validation structurelle, reducer/projection, conflits, ordre déterministe, idempotence |
| [`02-securite-crypto-identite.md`](02-securite-crypto-identite.md) | Primitives crypto réelles, epochs, modèle de menace, pipeline hostile du SyncEngine, stockage des clés, gate de revue sécurité |
| [`03-synchronisation-stockage.md`](03-synchronisation-stockage.md) | StorageAdapter, InMemoryAdapter, GoogleDriveStorageAdapter (squelette), cycle sync, résilience |
| [`04-droits-et-workspace.md`](04-droits-et-workspace.md) | PolicyEngine, filterProjectionForRole, memberships/rôles, invitations, multi-workspace |
| [`05-licence-et-migration.md`](05-licence-et-migration.md) | Licence offline signée, essai 20 jours, générateur éditeur, import V1→Next |
| [`06-mapping-v1-vers-next.md`](06-mapping-v1-vers-next.md) | Tableau V1→Next et avancement par phase |
| [`07-decisions-et-limites.md`](07-decisions-et-limites.md) | Décisions d'architecture, invariants, limites assumées |

## Vue d'ensemble

Pilotéo Next remplace l'infrastructure serveur de la V1 (`server.py`) par des
composants **locaux au navigateur**. Le métier existant (`app.js`) reste la
référence fonctionnelle ; rien n'est reconstruit, tout est **porté**.

```text
                    Hébergement statique HTTPS (PWA)
                                │
                                ▼
                         Pilotéo PWA
                                │
              ┌─────────────────┴─────────────────┐
              │                                   │
      Core métier existant                 WorkspaceRuntime
      (majorité de app.js,                        │
       hors périmètre de ce lot)      ┌────────────┼────────────┐
              │                       │            │            │
              ▼                       ▼            ▼            ▼
         État projeté            LocalStore   CryptoService  PolicyEngine
        (reducer.js)                  │        (Ed25519,      (permissions.js,
              │                    IndexedDB    AES-256-GCM,   can_change +
              │                       │          X25519 wrap)  filter_state)
              │                    EventLog
              │                  (event-log.js)
              │                       │
              │                   SyncEngine
              │                  (sync-engine.js)
              │                       │
              │                  StorageAdapter
              │           (InMemory / GoogleDrive[squelette])
              │                       │
              └───────────────► Google Drive (transport de blobs immuables)
```

**Aucun backend métier Pilotéo n'est requis** pour faire fonctionner le
mode Solo ni le mode Team : la seule dépendance réseau du chemin cible est
Google Drive comme transport de blobs, et elle n'est pas câblée dans ce lot
(voir `03-synchronisation-stockage.md`).

## État d'avancement en un coup d'œil

- **Fait et testé** : modèle événementiel, validation structurelle, reducer,
  conflits, event-log, CryptoService (WebCrypto), Keyring, PolicyEngine,
  WorkspaceRuntime, memberships, invitations, LocalStore (IndexedDB),
  SyncEngine (pipeline hostile complet, contre `InMemoryStorageAdapter`),
  licence offline + essai, générateur de licence CLI, import V1→Next +
  comparateur. **171 tests `node:test` verts** (`tests/next/*.test.mjs`,
  vérifié le 2026-08-30 via `node --test tests/next/*.mjs`).
- **Gated / non fait dans ce lot** : câblage réseau OAuth Google + appels
  REST Drive (`GoogleDriveStorageAdapter` est un squelette qui lève
  `NotWiredError` sur toute méthode réseau), intégration UI/PWA de ces
  modules dans `app.js`/`index.html`, retrait du serveur V1 (Phase 10),
  revue sécurité humaine de la crypto avant toute promesse commerciale de
  chiffrement.

Voir `06-mapping-v1-vers-next.md` pour le détail phase par phase et
`07-decisions-et-limites.md` pour les limites assumées.
