// events/event-log.js
//
// Décisions/hypothèses (CONTRACTS.md §3) :
// - `EventLog` est un journal en mémoire (pas d'IndexedDB ici : c'est le rôle
//   de `storage/local-store.js`, un autre module). Il indexe les événements
//   par `eventId` dans une `Map` -> `append` est naturellement idempotent.
// - `list({fromCursor})` retourne les événements dans un ORDRE DÉTERMINISTE
//   indépendant de l'ordre d'insertion. La « dépendance explicite » du contrat
//   (§3/§8) est, pour ce module, la chaîne `baseVersion` PAR ENTITÉ
//   (`entityType`+`entityId`) : un événement de `baseVersion` N ne peut être
//   classifié par `conflict.js` que si l'événement produisant la version N a
//   déjà été traité — sans quoi un simple update séquentiel (create v0 puis
//   update baseVersion=1) pourrait, par malchance de tri sur un `createdAt`
//   identique à la milliseconde, se retrouver ordonné AVANT sa création et
//   être classifié à tort en conflit. Le tri est donc, par événement :
//   `(entityType, entityId, baseVersion)` croissant — ce qui respecte
//   TOUJOURS la chaîne causale d'une même entité, quel que soit l'ordre
//   d'insertion — puis, à `baseVersion` égale (véritable concurrence entre
//   deux acteurs), `createdAt` informatif puis `eventId` en tie-breaker final
//   pour départager de façon stable et déterministe qui est "apply" et qui
//   est "conflict". Un éventuel `event.dependsOn` (tableau d'eventId,
//   dépendance explicite inter-entités) est en plus respecté via un tri
//   topologique construit sur ce même comparateur. Le regroupement par entité
//   ne biaise jamais le résultat final : deux entités distinctes sont
//   indépendantes dans la projection (§7 « entités différentes ⇒
//   convergence »), donc leur ordre RELATIF n'affecte pas l'état obtenu.
//   `fromCursor` = eventId après lequel reprendre (curseur exclusif).
// - `replay()` reconstruit une projection FROM SCRATCH en rejouant `list()`
//   dans l'ordre ci-dessus, en utilisant `conflict.js#classify` à chaque étape
//   pour décider si l'événement doit être appliqué (`reducer.js#reduce`),
//   ignoré silencieusement (`duplicate` — idempotence), ou conservé de côté
//   sans jamais écraser l'entité (`conflict`, accumulé dans
//   `projection.__conflicts`). Comme l'ordre de `list()` ne dépend que de
//   l'ensemble des événements (pas de leur ordre de réception/insertion),
//   deux logs contenant les MÊMES événements produisent toujours la MÊME
//   projection, quel que soit l'ordre de `append()` — c'est l'invariant
//   central du contrat.
// - `rebuildInto(store)` est volontairement tolérant sur la forme de `store`
//   (aucun store concret n'est imposé par ce module) : il appelle
//   `store.replaceProjection(projection)` si disponible, sinon assigne
//   directement `store.projection = projection`. Une intégration avec
//   `storage/local-store.js` (`saveLocalProjection(workspaceId, projection)`)
//   se fait par un petit adaptateur côté appelant, hors périmètre ici.

import { initialProjection, reduce } from "./reducer.js";
import { classify } from "./conflict.js";

/**
 * Comparateur total déterministe : chaîne causale par entité (entityType,
 * entityId, baseVersion croissant) d'abord, puis createdAt informatif, puis
 * eventId en tie-breaker final. Voir décision en tête de fichier.
 */
function tieBreak(a, b) {
  if (a.entityType !== b.entityType) return a.entityType < b.entityType ? -1 : 1;
  if (a.entityId !== b.entityId) return a.entityId < b.entityId ? -1 : 1;
  if (a.baseVersion !== b.baseVersion) return a.baseVersion - b.baseVersion;

  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const validA = Number.isFinite(ta);
  const validB = Number.isFinite(tb);
  if (validA && validB && ta !== tb) return ta - tb;
  if (a.eventId < b.eventId) return -1;
  if (a.eventId > b.eventId) return 1;
  return 0;
}

/** Tri topologique déterministe : dépendances explicites, puis chaîne d'entité/baseVersion/createdAt/eventId. */
function topoSort(events) {
  const byId = new Map(events.map((e) => [e.eventId, e]));
  const indegree = new Map();
  const dependents = new Map(); // eventId -> eventIds qui en dépendent

  for (const e of events) {
    const deps = Array.isArray(e.dependsOn) ? e.dependsOn.filter((id) => byId.has(id)) : [];
    indegree.set(e.eventId, deps.length);
    for (const d of deps) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(e.eventId);
    }
  }

  const available = events.filter((e) => indegree.get(e.eventId) === 0);
  const output = [];
  const done = new Set();

  while (available.length > 0) {
    available.sort(tieBreak);
    const next = available.shift();
    output.push(next);
    done.add(next.eventId);
    for (const depId of dependents.get(next.eventId) || []) {
      const remaining = indegree.get(depId) - 1;
      indegree.set(depId, remaining);
      if (remaining === 0) available.push(byId.get(depId));
    }
  }

  if (output.length !== events.length) {
    // Cycle ou dépendance manquante : on complète de façon déterministe plutôt
    // que de perdre silencieusement des événements.
    const remaining = events.filter((e) => !done.has(e.eventId)).sort(tieBreak);
    output.push(...remaining);
  }

  return output;
}

export class EventLog {
  constructor(initialEvents = []) {
    this._byId = new Map();
    for (const event of initialEvents) this.append(event);
  }

  /** Ajoute un événement ; idempotent sur `eventId`. Retourne un statut, jamais ne throw sur doublon. */
  append(event) {
    if (!event || typeof event.eventId !== "string" || event.eventId.length === 0) {
      throw new TypeError("EventLog.append: event.eventId (string) requis");
    }
    if (this._byId.has(event.eventId)) {
      return { appended: false, duplicate: true };
    }
    this._byId.set(event.eventId, event);
    return { appended: true, duplicate: false };
  }

  /** Nombre d'événements distincts stockés. */
  size() {
    return this._byId.size;
  }

  /** Événements ordonnés de façon déterministe ; `fromCursor` = eventId après lequel reprendre. */
  list({ fromCursor } = {}) {
    const ordered = topoSort(Array.from(this._byId.values()));
    if (!fromCursor) return ordered;
    const idx = ordered.findIndex((e) => e.eventId === fromCursor);
    return idx === -1 ? ordered : ordered.slice(idx + 1);
  }

  /** Reconstruit la projection depuis zéro en rejouant tous les événements dans l'ordre déterministe. */
  replay() {
    let projection = initialProjection();
    const conflicts = [];

    for (const event of this.list()) {
      const versions = projection.__versions || {};
      const entityVersions = versions[event.entityType] || {};
      const current = entityVersions[event.entityId];
      const decision = classify(current, event);

      if (decision === "apply") {
        projection = reduce(projection, event, event.payload);
      } else if (decision === "conflict") {
        conflicts.push({
          eventId: event.eventId,
          entityType: event.entityType,
          entityId: event.entityId,
          baseVersion: event.baseVersion,
        });
      }
      // "duplicate" : ignoré silencieusement (idempotence), aucune mutation.
    }

    if (conflicts.length > 0) {
      projection = { ...projection, __conflicts: conflicts };
    }
    return projection;
  }

  /** Reconstruit et pousse la projection dans `store` (tolérant sur sa forme, cf. en-tête). */
  rebuildInto(store) {
    const projection = this.replay();
    if (store && typeof store.replaceProjection === "function") {
      store.replaceProjection(projection);
    } else if (store && typeof store === "object") {
      store.projection = projection;
    }
    return projection;
  }
}
