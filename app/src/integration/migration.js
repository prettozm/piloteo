// src/integration/migration.js
//
// Module PUR (aucune E/S) du Point 5 (docs/next/MIGRATION_MODE_CONTRACT.md) :
// migration de l'état SOLO (snapshot IndexedDB, 12 collections) vers le jeu
// d'événements initial d'une cible event-sourcée (Dossier / Organisation /
// Google Drive), avec une vérification de round-trip AVANT toute bascule de
// mode. Ce module NE RÉÉCRIT AUCUN moteur : il réutilise
// `snapshotToEventsDiff`/`projectionToSnapshot` (solo-store.js), `EventLog`/
// `reduce` (events/event-log.js, events/reducer.js) et `ENTITY_TYPES`/
// `identityKey` (events/event-schema.js). Aucune écriture réelle (dossier/
// IndexedDB/Drive) n'a lieu ici — l'orchestration (§2/§3 du contrat) vit dans
// `local-backend.js` + les ponts (`piloteo-*-bridge.mjs`), qui appellent ces
// fonctions PUIS écrivent via l'engine cible déjà existant (folder/org/drive).
//
// Décisions/hypothèses :
//
// 1. `snapshotToSeedEvents(snapshot, {workspaceId, actorId, epoch})` ne fait
//    QUE déléguer à `snapshotToEventsDiff(∅, snapshot, {...})` — le « jeu
//    d'événements initial » du contrat §0 est très exactement le diff entre
//    l'état vide et le snapshot solo courant. Comme `oldState` est vide,
//    TOUTE entité valide du snapshot devient un `create` (aucune identité
//    n'a de lineage antérieur) : c'est `snapshotToEventsDiff` lui-même qui
//    porte cette logique (elle n'est pas dupliquée ici). Déterministe au
//    contenu près (les `eventId` sont des UUID générés par `buildEvent`,
//    jamais comparés par id — cf. contrat §1).
//
// 2. `diffSnapshots(expected, actual)` est un helper de comparaison PUR
//    exporté EN PLUS des 3 fonctions listées par le contrat (déviation
//    additive, documentée) : c'est le cœur de `verifyRoundTrip` (comparaison
//    par ENSEMBLE d'entités, ordre ignoré, clés réservées exclues — même
//    esprit que `solo-store.js#stableStringify`, ré-implémenté ici car non
//    exporté par ce module) — mais il est utile TEL QUEL à l'orchestration
//    (§2 point 4 : « recharger la projection de la cible → verifyRoundTrip ») :
//    une fois la cible réellement écrite (via son propre engine `{load,commit}`,
//    jamais reconstruit ici), l'orchestrateur récupère `state` = la projection
//    RÉELLE de la cible (déjà un snapshot, cf. `engine.load()`) et peut la
//    comparer au snapshot solo source avec EXACTEMENT la même normalisation
//    que `verifyRoundTrip`, sans avoir besoin d'extraire les événements bruts
//    de trois ponts différents (folder/org/drive) pour les remettre dans un
//    `EventLog` — double travail inutile, l'engine ayant déjà rejoué son
//    propre journal pour produire `state`. `verifyRoundTrip` reste la version
//    « pure » exigée par le contrat (rejoue elle-même dans un `EventLog` neuf),
//    utilisée telle quelle par les tests 1-6 et par l'orchestration comme
//    garde PRÉALABLE (sur les seed events calculés, avant toute écriture).
//
// 3. `planMigration` est pur et sans E/S : `targetExisting` est soit `null`/
//    `undefined` (cible pas encore interrogée / vide par construction — ex.
//    dossier tout juste choisi et jamais initialisé), soit un snapshot (même
//    forme 12 collections) déjà chargé par l'appelant (`engine.load().state`).
//    Aucune notion de "revision"/compteur brut n'est acceptée : l'appelant a
//    toujours la FORME snapshot disponible (`load()` renvoie `{revision,
//    state}` pour les trois engines folder/org/drive), donc lui demander de
//    la fournir telle quelle est plus simple qu'une seconde convention
//    (nombre d'événements) qui devrait de toute façon être re-testée pour
//    "vide".
//
// 4. `counts` (§4 test 5, « bons compteurs ») : `{ total, byEntityType }` —
//    nombre d'entités par collection dans le snapshot solo à migrer, plus le
//    total. Forme minimale mais suffisante pour afficher une barre de
//    progression/un résumé (§3 UI : « vos données ... vont être copiées »).
//    Non spécifiée plus précisément par le contrat ; documentée ici comme le
//    contrat de fait de ce module.

import { ENTITY_TYPES, identityKey } from "../events/event-schema.js";
import { EventLog } from "../events/event-log.js";
import { snapshotToEventsDiff, projectionToSnapshot } from "./solo-store.js";

const COLLECTIONS = Object.keys(ENTITY_TYPES);

// Clés de méta-données jamais portées par une entité métier valide (cf.
// solo-store.js) — exclues défensivement de la comparaison, même si
// `projectionToSnapshot` les a déjà filtrées en amont.
const RESERVED_KEYS = ["__deleted", "__deletedAt", "__versions", "__conflicts"];

function emptySnapshot() {
  const s = {};
  for (const c of COLLECTIONS) s[c] = [];
  return s;
}

/** Snapshot normalisé : les 12 collections connues, toujours des tableaux. */
function normalizeSnapshot(snapshot) {
  const src = snapshot && typeof snapshot === "object" ? snapshot : {};
  const out = {};
  for (const c of COLLECTIONS) out[c] = Array.isArray(src[c]) ? src[c] : [];
  return out;
}

function isSnapshotEmpty(snapshot) {
  const s = normalizeSnapshot(snapshot);
  return COLLECTIONS.every((c) => s[c].length === 0);
}

function countEntities(snapshot) {
  const s = normalizeSnapshot(snapshot);
  const byEntityType = {};
  let total = 0;
  for (const c of COLLECTIONS) {
    byEntityType[c] = s[c].length;
    total += s[c].length;
  }
  return { total, byEntityType };
}

/** Sérialisation stable (clés triées, clés réservées exclues) pour comparer deux entités par contenu. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined && !RESERVED_KEYS.includes(k))
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

// --- Durcissement (contrariant Point 5, MIGRATION_MODE_CONTRACT.md) --------
// Une indexation naïve par `Map.set(String(id), item)` collapse SILENCIEUSEMENT
// deux entités DISTINCTES d'un même tableau source qui partagent la même
// identité (même id, ou même coercion `String()` — ex. id numérique `1` vs
// chaîne `"1"`) : la comparaison "réussit" ensuite en confrontant deux
// ensembles déjà amputés du même doublon (repro : `verifyRoundTrip`/
// `diffSnapshots` répondaient tous deux `ok:true`/`[]` alors qu'une entité
// entière avait disparu). `countIdentityOccurrences`/`hasIdentityCollision`
// rendent cette collision VISIBLE, indépendamment du contenu des entités.

/** Occurrences de chaque identité (après coercion `String()`) dans une liste d'entités ; ignore les entités sans identité (déjà signalées ailleurs). */
function countIdentityOccurrences(list, key) {
  const counts = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const id = item ? item[key] : undefined;
    if (id === undefined || id === null) continue;
    const k = String(id);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

/** Vrai si `list` porte au moins une identité partagée par ≥2 entités DISTINCTES (collision invisible pour une simple Map "dernier gagne"). */
function hasIdentityCollision(list, key) {
  for (const n of countIdentityOccurrences(list, key).values()) {
    if (n > 1) return true;
  }
  return false;
}

/**
 * Construit le jeu d'événements initial représentant un snapshot solo :
 * diff depuis l'état vide (`snapshotToEventsDiff(∅, snapshot, {...})`,
 * solo-store.js — non dupliqué). `rejected` non vide signale une entité
 * malformée (identité absente/vide, clé réservée) : l'appelant DOIT alors
 * échouer explicitement la migration (contrat §1), jamais migrer un état
 * partiel en silence.
 *
 * @param {object} snapshot état solo courant (12 collections)
 * @param {{workspaceId:string, actorId:string, epoch:number}} identity identité à poser sur chaque événement
 * @returns {{events:object[], rejected:Array<{eventId:null,entityType:string,entityId:string|null,reason:string}>}}
 */
export function snapshotToSeedEvents(snapshot, { workspaceId, actorId, epoch } = {}) {
  const normalized = normalizeSnapshot(snapshot);
  return snapshotToEventsDiff(emptySnapshot(), normalized, {
    workspaceId,
    actorId,
    epoch,
    projection: {},
  });
}

/**
 * Écarts entre deux snapshots, comparés comme des ENSEMBLES d'entités par
 * collection (ordre ignoré, clés réservées exclues) — la même normalisation
 * que `verifyRoundTrip`. Utile aussi hors de ce module pour comparer un
 * snapshot solo à l'état RÉELLEMENT rechargé d'une cible déjà écrite (§2
 * point 4 du contrat), sans repasser par un `EventLog` (l'engine cible a
 * déjà rejoué son propre journal pour produire ce `state`).
 *
 * @returns {Array<{entityType:string, entityId:string, reason:string}>} vide si identiques
 */
export function diffSnapshots(expected, actual) {
  const exp = normalizeSnapshot(expected);
  const act = normalizeSnapshot(actual);
  const diffs = [];

  for (const entityType of COLLECTIONS) {
    const key = identityKey(entityType);

    // Collision d'identité (durcissement, voir en-tête) : au moins deux
    // entités DISTINCTES du tableau SOURCE (attendu OU réel) partagent la
    // même identité -> un écart RÉEL en soi, jamais invisible, INDÉPENDAMMENT
    // de ce que la Map ci-dessous en retient ("dernier gagne" côté affichage
    // seulement — la collision, elle, est signalée avant toute comparaison
    // par contenu, qui serait de toute façon faussée par l'amputation).
    for (const [id, n] of countIdentityOccurrences(exp[entityType], key)) {
      if (n > 1) diffs.push({ entityType, entityId: id, reason: `identité dupliquée côté attendu (${n} entités partagent ${key}=${id})` });
    }
    for (const [id, n] of countIdentityOccurrences(act[entityType], key)) {
      if (n > 1) diffs.push({ entityType, entityId: id, reason: `identité dupliquée côté cible (${n} entités partagent ${key}=${id})` });
    }

    const expMap = new Map();
    for (const item of exp[entityType]) {
      const id = item ? item[key] : undefined;
      if (id !== undefined && id !== null) expMap.set(String(id), item);
    }
    const actMap = new Map();
    for (const item of act[entityType]) {
      const id = item ? item[key] : undefined;
      if (id !== undefined && id !== null) actMap.set(String(id), item);
    }

    for (const [id, item] of expMap) {
      if (!actMap.has(id)) {
        diffs.push({ entityType, entityId: id, reason: "absente de la cible" });
        continue;
      }
      if (stableStringify(item) !== stableStringify(actMap.get(id))) {
        diffs.push({ entityType, entityId: id, reason: "valeur différente" });
      }
    }
    for (const [id] of actMap) {
      if (!expMap.has(id)) {
        diffs.push({ entityType, entityId: id, reason: "présente en trop dans la cible" });
      }
    }
  }
  return diffs;
}

/**
 * Vérifie le round-trip (contrat §1, garde de sûreté) : rejoue `events` dans
 * un `EventLog`/reducer NEUF (aucun état partagé avec l'appelant), projette,
 * reconvertit en snapshot (`projectionToSnapshot`, solo-store.js — non
 * dupliqué), et compare au `snapshot` source via `diffSnapshots` (égalité
 * profonde après normalisation : tombstones/clés réservées exclus, ordre
 * ignoré). `!ok` => la cible ne doit PAS être activée (contrat §1/§2 point 4).
 *
 * @param {object} snapshot snapshot source (solo)
 * @param {object[]} events événements à rejouer (ex: `snapshotToSeedEvents(...).events`)
 * @returns {{ok:boolean, diff:Array<{entityType:string, entityId:string, reason:string}>}}
 */
export function verifyRoundTrip(snapshot, events) {
  const log = new EventLog(Array.isArray(events) ? events : []);
  const projection = log.replay();
  const rebuilt = projectionToSnapshot(projection);
  const diff = diffSnapshots(snapshot, rebuilt);
  return { ok: diff.length === 0, diff };
}

/**
 * Une cible non vide est-elle un SOUS-ENSEMBLE cohérent du snapshot solo (donc
 * probablement le résultat d'une migration précédente COUPÉE en cours de
 * route, contrat §2 point 6 : « la cible peut contenir un journal partiel »),
 * plutôt que des données ÉTRANGÈRES (une autre organisation/un autre dossier,
 * contrat §2 point 2) ? Vrai seulement si TOUTE entité déjà présente dans la
 * cible est identique (même contenu) à celle du snapshot solo pour la même
 * identité — la moindre entité étrangère (absente du solo, ou de contenu
 * différent) fait basculer en "target-not-empty" (jamais un mélange
 * silencieux entre deux jeux de données distincts).
 */
function isResumablePartialSeed(soloSnapshot, targetExisting) {
  const solo = normalizeSnapshot(soloSnapshot);
  const target = normalizeSnapshot(targetExisting);
  for (const entityType of COLLECTIONS) {
    const key = identityKey(entityType);
    // Collision d'identité (durcissement, voir en-tête) côté solo OU côté
    // cible : la comparaison "dernier gagne" ne serait plus fiable pour juger
    // d'une reprise cohérente -> JAMAIS une reprise silencieuse d'un état
    // ambigu, retombe en "target-not-empty" (refus explicite) plutôt qu'un
    // faux "seed" qui masquerait la collision.
    if (hasIdentityCollision(solo[entityType], key) || hasIdentityCollision(target[entityType], key)) {
      return false;
    }
    const soloMap = new Map();
    for (const item of solo[entityType]) {
      const id = item ? item[key] : undefined;
      if (id !== undefined && id !== null) soloMap.set(String(id), item);
    }
    for (const item of target[entityType]) {
      const id = item ? item[key] : undefined;
      if (id === undefined || id === null) return false;
      const key2 = String(id);
      if (!soloMap.has(key2)) return false; // entité étrangère : jamais vue dans le solo
      if (stableStringify(soloMap.get(key2)) !== stableStringify(item)) return false; // contenu divergent
    }
  }
  return true;
}

/**
 * Plan de migration (pur, sans E/S) : décrit ce qui sera fait avant toute
 * écriture réelle.
 * - `soloSnapshot` vide (aucune entité dans les 12 collections) =>
 *   `"nothing-to-migrate"` (rien à copier, la cible peut être activée telle
 *   quelle).
 * - `targetExisting` non vide :
 *   - si c'est un SOUS-ENSEMBLE cohérent du snapshot solo (reprise d'une
 *     migration précédente coupée, contrat §2 point 6) => `"seed"` quand même
 *     (`engine.commit()` est idempotent : les entités déjà présentes ne sont
 *     pas ré-écrites, celles manquantes le sont, puis re-vérifié) ;
 *   - sinon (données ÉTRANGÈRES) => `"target-not-empty"` : ne JAMAIS écraser/
 *     fusionner à l'aveugle (contrat §2 point 2) — l'appelant doit refuser et
 *     expliquer.
 * - Sinon (cible vide) => `"seed"` : migration à effectuer, `counts` décrit
 *   son ampleur.
 *
 * @param {{soloSnapshot:object, targetExisting?:object|null}} params
 * @returns {{kind:"seed"|"target-not-empty"|"nothing-to-migrate", counts:{total:number, byEntityType:Object<string,number>}}}
 */
export function planMigration({ soloSnapshot, targetExisting } = {}) {
  if (isSnapshotEmpty(soloSnapshot)) {
    return { kind: "nothing-to-migrate", counts: countEntities(emptySnapshot()) };
  }
  if (targetExisting != null && !isSnapshotEmpty(targetExisting)) {
    if (isResumablePartialSeed(soloSnapshot, targetExisting)) {
      return { kind: "seed", counts: countEntities(soloSnapshot) };
    }
    return { kind: "target-not-empty", counts: countEntities(soloSnapshot) };
  }
  return { kind: "seed", counts: countEntities(soloSnapshot) };
}

// Exports internes utiles aux appelants (local-backend.js/ponts) pour
// détecter un snapshot vide sans redupliquer la logique de normalisation.
export { isSnapshotEmpty, normalizeSnapshot };
