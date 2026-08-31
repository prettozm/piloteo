# Pilotéo — Moteur Next canonique et état transitoire

> Décision d'architecture prise lors de la passe « consolidation + déploiements
> multiples » (P1). Statut : **en vigueur**. Ne supprime rien — encadre la
> coexistence de deux implémentations pendant la migration.

## 1. Décision

**`src/*` est le moteur Next canonique.** C'est l'unique implémentation de
référence du modèle événementiel (événements signés, causalité, conflit,
politique, projection, adaptateurs de stockage). Elle est couverte par la suite
de tests `tests/next/**` (moteur, crypto, policy, workspace, licence, migration,
adaptateurs) exécutée en CI.

Le **chemin historique/solo** — `piloteo-events.js`, `local-backend.js`,
`sw-solo.js` — reste en place **à titre transitoire**, comme **adaptateur de
compatibilité** avec `app.js` (l'UI et le métier V1, inchangés). Il ne doit plus
gagner de fonctionnalités propres : il doit, progressivement, **appeler** le
moteur canonique au lieu de maintenir sa propre copie.

## 2. Les deux implémentations, mises en correspondance

| Rôle | Canonique (`src/*`, ES modules, testé) | Transitoire (bundle classique, `window.*`) |
|---|---|---|
| Enveloppe + canonicalisation + validation | `src/events/event-schema.js`, `src/events/validation.js` | `piloteo-events.js` (copie fidèle) |
| Reducer pur | `src/events/reducer.js` | `piloteo-events.js#reduce` |
| Conflit par entité | `src/events/conflict.js` (**+ causalité `parentEventId`, P0.1**) | `piloteo-events.js#classify` (**baseVersion seul**) |
| Journal rejouable | `src/events/event-log.js` | `piloteo-events.js#rebuildState` |
| Stockage | `src/storage/local-store.js` (IndexedDB), `*-adapter.js` | IndexedDB inline dans `local-backend.js` |
| Synchronisation multi-acteurs | `src/sync/sync-engine.js` (pipeline hostile) | *(aucune — solo mono-utilisateur)* |

## 3. Pourquoi la duplication n'est pas supprimée d'un bloc

Le bundle classique est un **script non-module** (`window.PiloteoEvents`), chargé
avant `app.js` sans étape de build. Il **ne peut pas `import`** les modules ES de
`src/*` tel quel. Une déduplication complète suppose donc un **bundler** (rollup/
esbuild) pour émettre, depuis `src/*`, un artefact UMD consommable par `app.js`.
C'est un chantier à part entière : il est **délibérément différé** (règle « pas de
big bang », voir Dette). Le tenter maintenant risquerait une régression du mode
solo déjà livré et testé au navigateur.

Ce qui **peut** être réduit sans risque (et l'est / le sera au fil de l'eau) :
la source de vérité du **format** (clés d'identité des 12 collections, noms de
champs, arborescence de fichiers) est déjà partagée conceptuellement ; les tests
d'export V1 garantissent qu'elle ne diverge pas.

## 4. Sécurité de la coexistence : qui a droit à quel moteur

La correction P0.1 (causalité `parentEventId`) vit dans `src/events/conflict.js`.
Le bundle classique conserve un `classify` fondé sur `baseVersion` seul. **Ce
n'est pas une régression**, pour une raison précise :

- Le bundle classique n'est utilisé que par **`local-backend.js`**, c.-à-d. le
  **mode solo mono-utilisateur** : un seul acteur, historique **linéaire**, aucune
  synchronisation concurrente. Le défaut corrigé par P0.1 (un descendant d'une
  branche perdante promu état officiel) **ne peut pas survenir** sans deux acteurs
  concurrents sur la même entité.
- **Règle de consolidation** : tout chemin **multi-utilisateur** (Folder partagé,
  Google Drive, équipe) **doit** passer par `src/sync/sync-engine.js` et
  `src/events/conflict.js` — jamais par le `classify` du bundle classique. Le
  mode solo peut rester sur le bundle jusqu'à sa bascule sur le moteur canonique.

## 5. État transitoire « Event-first » (à documenter comme tel — §6 de la passe)

**Cible** :

```
Command → Validation → Policy → Event → Journal → Reducer → Projection
```

**Mode transitoire actuel du chemin solo** : `app.js` produit un **snapshot**
(les 12 collections), et le journal d'événements est alimenté en **best-effort**
par différence de snapshots (`piloteo-events.js#diffToEvents`), puis le snapshot
est reconstructible par rejeu (`rebuildState`). C'est **explicitement
transitoire** :

- il inverse l'ordre cible (snapshot d'abord, événement ensuite) ;
- il est toléré **pendant** la migration car il préserve l'UI V1 sans réécriture ;
- **invariant maintenu** : la projection finale **doit rester reconstructible
  depuis le journal**. Le test Phase 3 (`rebuildState` : « même état par usage
  normal ou par rejeu du journal ») verrouille cet invariant, ce qui permettra de
  basculer vers l'ordre cible sans changer le format des données.

Le moteur canonique `src/*`, lui, est déjà **event-first** par construction
(l'événement signé est la source ; la projection est un `replay()` pur).

## 6. Trajectoire de convergence (non réalisée dans cette passe)

1. Introduire une étape de build émettant un artefact UMD depuis `src/events/*`.
2. Remplacer le cœur de `piloteo-events.js` par cet artefact (le pont snapshot↔
   journal `diffToEvents`/`projectionToState` restant, lui, spécifique à `app.js`).
3. Faire consommer par `local-backend.js` le `LocalStore` canonique.
4. Basculer le mode solo en event-first strict quand l'UI le permettra.

Chaque étape est indépendante et réversible ; aucune n'est un prérequis de cette
passe. Elles sont inscrites en **dette « utile prochainement »**.
