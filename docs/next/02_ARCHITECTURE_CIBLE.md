# Pilotéo Next — Architecture cible

## 1. Vue d’ensemble

```text
                Hébergement statique HTTPS
                         │
                         ▼
                    Pilotéo PWA
                         │
          ┌──────────────┴──────────────┐
          │                             │
   Core métier existant          Workspace Runtime
   (majorité de app.js)                │
          │                  ┌──────────┼──────────┐
          │                  │          │          │
          ▼                  ▼          ▼          ▼
     Etat projeté       LocalStore   Crypto    Policy
                            │
                         IndexedDB
                            │
                         EventLog
                            │
                       SyncEngine
                            │
                     StorageAdapter
                            │
                      Google Drive
```

Aucun backend Pilotéo n’est requis pour le métier.

---

## 2. Séparation des responsabilités

### `Core métier`

Responsabilités :

- règles fonctionnelles ;
- calculs ;
- validations métier ;
- visualisations ;
- formulaires ;
- modèle métier existant.

Provenance :

- `app.js`
- `index.html`
- `docs/cahier-des-charges.md`
- `docs/modele-de-donnees.md`

Le maximum de code existant doit être conservé.

### `WorkspaceRuntime`

Responsabilités :

- workspace actif ;
- membre actif ;
- rôle ;
- licence ;
- mode local/team ;
- état de synchronisation.

### `LocalStore`

Responsabilités :

- IndexedDB ;
- événements locaux ;
- projections ;
- cursors de synchronisation ;
- métadonnées locales ;
- clés protégées localement.

### `EventLog`

Responsabilités :

- créer les événements ;
- appliquer un ordre déterministe ;
- rejouer ;
- détecter doublons ;
- reconstruire les projections.

### `PolicyEngine`

Remplace la partie `can_change()` de la V1.

La règle importante :

> toute opération distante est vérifiée comme si elle provenait d’un client hostile.

Le moteur reçoit :

- acteur ;
- membership ;
- état courant ;
- événement ;
- règle métier.

Il retourne :

- `accept`
- `reject`
- `conflict`

### `CryptoService`

Responsabilités :

- génération d’identité cryptographique ;
- chiffrement/déchiffrement ;
- signature/vérification ;
- gestion des epochs de clé ;
- import/export sécurisé des secrets lorsque explicitement prévu.

### `SyncEngine`

Responsabilités :

- publier les événements locaux ;
- récupérer les événements distants ;
- vérifier unicité ;
- vérifier signature ;
- déchiffrer ;
- vérifier droits ;
- appliquer ;
- remonter conflits ;
- avancer le cursor.

### `StorageAdapter`

Aucune règle métier.

Drive est un magasin de blobs et métadonnées.

---

## 3. Structure de modules recommandée

Sans imposer un framework :

```text
src/
  core/
    model.js
    rules.js
    permissions.js
    state.js

  workspace/
    workspace.js
    memberships.js
    invitations.js

  storage/
    local-store.js
    storage-adapter.js
    google-drive-adapter.js

  events/
    event-schema.js
    event-log.js
    reducer.js
    conflict.js

  crypto/
    crypto-service.js
    keyring.js

  identity/
    google-identity.js

  license/
    license.js

  sync/
    sync-engine.js

  pwa/
    service-worker.js
```

Cette réorganisation peut être progressive.

Ne pas commencer par déplacer tout `app.js`.

---

## 4. Données locales

Stores IndexedDB recommandés :

```text
workspaces
memberships
events
projections
sync_cursors
keys
licenses
settings
```

### `workspaces`

```json
{
  "id": "uuid",
  "name": "ACME",
  "mode": "local|team",
  "createdAt": "...",
  "schemaVersion": 1,
  "storage": {
    "provider": "google-drive",
    "rootId": "..."
  }
}
```

### `memberships`

```json
{
  "workspaceId": "uuid",
  "memberId": "uuid",
  "googleSubject": "...",
  "email": "...",
  "consultantId": "...",
  "role": "owner|admin|user",
  "status": "active|revoked"
}
```

### `events`

Doit conserver :

- enveloppe ;
- ciphertext distant ;
- état `pending|published|applied|rejected|conflict`.

---

## 5. Modèle événementiel minimal

Un événement n’est pas une ligne Git ou un snapshot.

Enveloppe minimale :

```json
{
  "version": 1,
  "eventId": "uuid",
  "workspaceId": "uuid",
  "entityType": "mission",
  "entityId": "uuid",
  "operation": "create|update|delete",
  "actorId": "uuid",
  "baseVersion": 3,
  "epoch": 2,
  "createdAt": "...",
  "ciphertext": "...",
  "signature": "..."
}
```

Le contenu métier est dans `ciphertext`.

Les métadonnées laissées en clair doivent être réduites au strict nécessaire.

Si `entityType/entityId` sont considérés comme révélateurs, ils peuvent aussi passer dans le payload chiffré ; le coût est une synchronisation moins indexable.

La V1 doit privilégier la confidentialité.

---

## 6. Projection d’état

Le journal est la vérité historique.

L’état affiché est une projection :

```text
events validés
      ↓ reducer déterministe
collections Pilotéo
      ↓
UI actuelle
```

Une projection peut être supprimée et reconstruite.

Cela remplace l’état canonique JSON unique de `app_state`.

---

## 7. Conflits

Chaque entité possède une version logique.

Exemple :

```text
mission M1 version 7
Alice édite sur base 7
Bob édite sur base 7

Alice event → version 8 accepté
Bob event → base 7 alors courant 8
              ↓
            conflict
```

Pilotéo conserve l’événement de Bob comme conflit local, sans le rejouer silencieusement.

UX minimale :

> Cette donnée a été modifiée par une autre personne.  
> La version partagée a été conservée.  
> Ouvrir votre modification / Refaire la saisie.

---

## 8. Ordre des événements

Ne pas utiliser uniquement l’heure locale des appareils.

L’unicité repose sur `eventId`.

L’application des événements indépendants peut utiliser un ordre stable, par exemple :

1. dépendances explicites ;
2. timestamp informatif ;
3. `eventId` comme tie-breaker.

Les conflits métier sont traités par version d’entité, pas par horloge globale.

---

## 9. Suppression

Une suppression métier est un événement tombstone :

```text
entity.deleted
```

Le fichier d’événement distant n’est pas supprimé.

Cela garantit la reconstruction.

La compaction du journal est hors périmètre V2 initial.

---

## 10. Workspaces

Chaque workspace est un domaine isolé :

- clé de chiffrement propre ;
- membres propres ;
- journal propre ;
- licence propre ;
- stockage propre ;
- curseur propre.

Aucune opération ne peut référencer une entité d’un autre workspace.

---

## 11. Conversion Local → Team

Le passage doit être natif :

1. workspace local existant ;
2. connexion Google ;
3. choix Drive ;
4. génération/configuration crypto Team ;
5. encapsulation de l’état local dans un événement genesis/import ;
6. publication ;
7. activation du mode Team.

Pas d’export CSV obligatoire.

---

## 12. Ce qui disparaît de la V1

À terme :

- table `users` serveur ;
- table `sessions` ;
- cookies de session ;
- CSRF serveur ;
- PBKDF2 mot de passe ;
- `/api/login` ;
- `/api/state` ;
- `state_history` serveur ;
- sauvegardes SQLite serveur ;
- console `/support` liée aux comptes ;
- Docker pour l’usage normal ;
- reverse proxy métier.

Les responsabilités utiles ne disparaissent pas : elles sont replacées.

---

## 13. Ce qui reste de la V1

À conserver :

- modèle métier ;
- calculs ;
- UI ;
- règles de cohérence ;
- exports ;
- permissions métier ;
- principe de conflit explicite ;
- UUID pour créations concurrentes ;
- tests fonctionnels ;
- documentation métier.

---

## 14. Hébergement

La PWA exige HTTPS pour le Service Worker et les fonctions cryptographiques web usuelles.

Cible :

```text
app.piloteo.fr
```

sur hébergement statique.

L’hébergeur ne doit pas recevoir de payload métier.

Le cache PWA permet l’utilisation hors ligne après installation/chargement initial.
