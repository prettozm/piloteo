# Pilotéo — Plan de migration V1 vers local-first

## 1. Stratégie

Ne pas faire un big bang.

La V1 serveur reste exécutable jusqu’à la fin.

La migration se déroule par couches avec des gates.

Chaque phase doit produire quelque chose de testable.

---

# Phase 0 — Geler la référence V1

## Objectif

Disposer d’un oracle fonctionnel.

## Actions

- conserver le zip/source V1 ;
- exécuter tous les tests actuels ;
- ajouter les régressions de validation identifiées lors de l’audit si elles ne sont pas encore présentes ;
- figer un jeu de données de recette ;
- exporter un snapshot V1 de référence ;
- documenter les parcours critiques.

## Gate

Aucune migration tant que la référence n’est pas reproductible.

---

# Phase 1 — Introduire `LocalStore` sans supprimer le serveur

## Objectif

Séparer la persistance de l’UI.

## Actions

Créer une interface locale :

```text
loadWorkspaceState()
saveLocalProjection()
appendLocalEvent()
listLocalEvents()
```

Utiliser IndexedDB.

Dans un premier temps, le serveur reste source de vérité.

Après `/api/state` :

```text
serveur
  ↓
LocalStore
  ↓
UI
```

## Pourquoi

Cette phase oblige à retirer de `app.js` l’hypothèse implicite que l’état vient forcément du serveur, sans toucher au métier.

## Gate

Le comportement utilisateur est identique à V1.

---

# Phase 2 — Mode Solo

## Objectif

Faire fonctionner Pilotéo sans `server.py`.

## Actions

Ajouter :

- écran de sélection/création workspace ;
- workspace local ;
- IndexedDB comme source de vérité ;
- plus aucun appel `/api/*` en mode local ;
- export/import de secours ;
- PWA minimale.

## Gate

Un utilisateur peut :

- fermer/réouvrir ;
- travailler hors ligne ;
- conserver toutes ses données ;
- exporter ;
- réimporter ;
- utiliser les fonctions métier existantes.

Cette phase donne déjà un produit utilisable.

---

# Phase 3 — Journal d’événements

## Objectif

Remplacer la sauvegarde de snapshots par un modèle synchronisable.

## Actions

Pour les écritures, introduire :

```text
UI
 ↓
Command
 ↓
Policy
 ↓
Event
 ↓
Reducer
 ↓
Projection
```

Commencer par une seule entité :

- saisie de temps.

Puis :

- frais ;
- mission ;
- affaire ;
- référentiels ;
- autres collections.

Ne pas convertir toutes les mutations en une fois.

## Gate

Le même état est obtenu :

- par utilisation normale ;
- par destruction de la projection puis replay du journal.

---

# Phase 4 — Conflits locaux simulés

## Objectif

Prouver la logique multi-acteurs avant Drive.

## Actions

Simuler deux clients en mémoire/IndexedDB distincts.

Cas obligatoires :

1. Alice modifie saisie A, Bob saisie B → convergence ;
2. Alice et Bob modifient saisie A sur la même base → conflit ;
3. événement dupliqué → idempotent ;
4. événements reçus dans un ordre différent → résultat déterministe ;
5. événement interdit → rejet.

## Gate

Tests automatiques verts.

---

# Phase 5 — Crypto

## Objectif

Faire en sorte que le stockage distant ne voie pas le métier.

## Actions

Introduire `CryptoService`.

Avant cette phase, aucun Drive réel.

Exigences :

- génération de clé workspace ;
- chiffrement AEAD des payloads ;
- identité/signature membre ;
- enveloppes par epoch ;
- rotation ;
- tests de corruption ;
- aucune clé en logs.

## Gate

Un blob copié depuis le futur stockage distant ne révèle aucune donnée métier.

Une altération d’un blob est détectée.

Revue sécurité requise avant production.

---

# Phase 6 — Google Identity + Drive Adapter

## Objectif

Synchroniser deux utilisateurs sans backend Pilotéo.

## Actions

Introduire :

- Google Identity Services ;
- accès Drive minimal ;
- `GoogleDriveStorageAdapter`;
- dossier racine workspace ;
- publication d’événements immuables ;
- cursor de changements ;
- compatibilité My Drive ;
- compatibilité Shared Drive.

## Gate

Deux navigateurs distincts :

- rejoignent le même workspace ;
- travaillent alternativement ;
- convergent ;
- supportent une coupure réseau ;
- reprennent ensuite.

---

# Phase 7 — Invitations et memberships

## Objectif

Rendre l’onboarding utilisateur utilisable.

## Actions

Parcours :

```text
Créer une organisation
Rejoindre une organisation
Commencer seul
```

Ajouter :

- `owner/admin/user`;
- invitation expirante ;
- association identité Google ↔ membre ;
- distribution sécurisée de clé ;
- révocation ;
- rotation de clé après révocation.

## Gate

Un utilisateur non invité ne peut pas rejoindre.

Un utilisateur révoqué ne peut plus lire les nouveaux événements.

---

# Phase 8 — Licence

## Objectif

Ajouter la mécanique commerciale sans backend.

## Actions

- essai Team 20 jours ;
- licence signée ;
- vérification locale ;
- compteur membres ;
- lecture/export après expiration ;
- blocage écriture après expiration.

## Gate

Aucune licence falsifiée naïvement ne doit être acceptée.

Aucune expiration ne doit rendre les données inexportables.

---

# Phase 9 — Migration V1 réelle

## Objectif

Passer une organisation existante.

## Outil recommandé

Ajouter temporairement à V1 :

```text
Administration
→ Export migration Pilotéo Next
```

Format :

```json
{
  "format": "piloteo-v1-export",
  "schemaVersion": 1,
  "exportedAt": "...",
  "revision": 123,
  "state": { ... }
}
```

Côté Next :

```text
Créer workspace
→ Importer depuis Pilotéo V1
```

L’import crée :

- workspace ;
- membres/consultants nécessaires ;
- événement genesis ;
- projection identique.

## Gate

Comparer automatiquement toutes les collections avant/après.

---

# Phase 10 — Retrait du serveur

Seulement quand les gates précédentes sont validées.

Retirer de la cible :

- `server.py`
- `support.html`
- `support.js`
- Docker
- SQLite serveur
- API auth/sync
- scripts de backup serveur

Les conserver dans une branche/tag historique.

---

## 2. Mapping responsabilités V1 → Next

| V1 | Next |
|---|---|
| `users` | Google Identity + membership |
| mot de passe | supprimé |
| sessions | contexte local + OAuth Google temporaire |
| `app_state` | projection locale |
| `state_history` | event log |
| SQLite serveur | IndexedDB |
| `filter_state()` | projection/permissions locales |
| `can_change()` | PolicyEngine |
| `merge_client_state()` | EventLog + SyncEngine |
| backup SQLite | réplication Drive + export local |
| audit log | journal d’événements + journal admin |
| `/support` | administration du workspace |
| Docker | hébergement statique/PWA |

---

## 3. Règle de code pendant la migration

Interdit :

- réécrire les graphiques ;
- changer les règles métier pour “faire propre” ;
- migrer vers un framework front sans besoin ;
- introduire TypeScript uniquement pour la migration ;
- introduire un serveur temporaire de sync ;
- conserver deux modèles métier en parallèle.

Autorisé :

- extraire des fonctions ;
- ajouter des interfaces/adapters ;
- ajouter des tests ;
- isoler les effets de bord ;
- créer un reducer déterministe ;
- déplacer progressivement les mutations.

---

## 4. Point de non-retour

Il n’y en a pas avant la Phase 10.

Tant que V1 reste intacte et que l’import V1→Next est unidirectionnel, le projet peut revenir à la V1 serveur.
