/* piloteo-events.js — Journal d'événements pour le mode solo (Phase 3).
 *
 * Bundle CLASSIQUE (pas de module ES) du moteur événementiel, repris fidèlement
 * des modules testés `src/events/*` : enveloppe + canonicalisation déterministe,
 * validation structurelle (refus NaN/Infinity), reducer pur, classify par
 * version d'entité, journal rejouable. Ajoute le pont snapshot <-> journal :
 *  - diffToEvents() : transforme la différence entre deux états (12 collections
 *    tableaux, façon app.js) en événements create/update/delete ;
 *  - projectionToState() : reconvertit une projection (map par identité) en
 *    l'état à 12 tableaux attendu par app.js (tombstones et __versions exclus) ;
 *  - rebuildState() : rejoue un journal complet en un état — c'est ce qui prouve
 *    l'invariant Phase 3 « même état par usage normal ou par replay du journal ».
 *
 * Exposé en global `window.PiloteoEvents` (navigateur) et `module.exports`
 * (tests Node via un shim). Aucune dépendance.
 */
(function (root) {
  "use strict";

  var ENTITY_KEYS = {
    consultants: "id", organisations: "id", affaires: "id", methodes: "id",
    typesTerritoire: "id", domainesIntervention: "id", categoriesFrais: "id",
    missions: "id", factures: "id", saisies: "id", bordereauxFrais: "numero",
    notesFrais: "id"
  };
  var COLLECTIONS = Object.keys(ENTITY_KEYS);

  function identityKey(entityType) { return ENTITY_KEYS[entityType]; }

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function buildEvent(o) {
    return {
      version: 1, eventId: uuid(),
      entityType: o.entityType, entityId: String(o.entityId),
      operation: o.operation, actorId: o.actorId || "solo",
      baseVersion: o.baseVersion || 0, epoch: o.epoch || 1,
      createdAt: new Date().toISOString(), payload: o.payload || null
    };
  }

  function findNonFinite(v) {
    if (typeof v === "number") return !isFinite(v);
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) if (findNonFinite(v[i])) return true; return false; }
    if (v && typeof v === "object") { for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k) && findNonFinite(v[k])) return true; }
    return false;
  }
  // Validation structurelle minimale mais réelle (dette V1) : refus des non-finis
  // et présence de la clé d'identité. Les validateurs métier fins vivent dans
  // src/events/validation.js (moteur complet) ; ici on garantit l'essentiel.
  function validate(entityType, operation, payload) {
    if (operation === "delete") return { ok: true };
    if (!payload || typeof payload !== "object") return { ok: false, reason: "payload invalide" };
    if (findNonFinite(payload)) return { ok: false, reason: "valeur non finie (NaN/Infinity)" };
    var key = identityKey(entityType);
    if (payload[key] === undefined || payload[key] === null || payload[key] === "") return { ok: false, reason: key + " manquant" };
    return { ok: true };
  }

  function cloneBucket(b) { var o = {}; if (b) for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k]; return o; }
  function initialProjection() { return {}; }
  function reduce(projection, event, payload) {
    var src = projection && typeof projection === "object" ? projection : {};
    var next = {}; for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = src[k];
    var bucket = cloneBucket(src[event.entityType]);
    var vr = cloneBucket(src.__versions);
    var vb = cloneBucket(vr[event.entityType]);
    if (event.operation === "delete") {
      var prev = bucket[event.entityId];
      bucket[event.entityId] = { __deleted: true, __prev: prev || null };
    } else {
      bucket[event.entityId] = payload === undefined ? null : payload;
    }
    vb[event.entityId] = { version: (event.baseVersion || 0) + 1, lastEventId: event.eventId };
    vr[event.entityType] = vb;
    next[event.entityType] = bucket;
    next.__versions = vr;
    return next;
  }

  function classify(cur, event) {
    var version = cur && typeof cur.version === "number" ? cur.version : 0;
    var lastEventId = cur && cur.lastEventId ? cur.lastEventId : null;
    if (lastEventId && lastEventId === event.eventId) return "duplicate";
    if (event.baseVersion !== version) return "conflict";
    return "apply";
  }

  function tieBreak(a, b) {
    if (a.entityType !== b.entityType) return a.entityType < b.entityType ? -1 : 1;
    if (a.entityId !== b.entityId) return a.entityId < b.entityId ? -1 : 1;
    if (a.baseVersion !== b.baseVersion) return a.baseVersion - b.baseVersion;
    var ta = Date.parse(a.createdAt), tb = Date.parse(b.createdAt);
    if (isFinite(ta) && isFinite(tb) && ta !== tb) return ta - tb;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  }

  // Replay déterministe d'un journal -> projection (map par identité + __versions).
  function replay(events) {
    var ordered = events.slice().sort(tieBreak);
    var projection = initialProjection();
    var conflicts = [];
    for (var i = 0; i < ordered.length; i++) {
      var e = ordered[i];
      var versions = projection.__versions || {};
      var cur = (versions[e.entityType] || {})[e.entityId];
      var d = classify(cur, e);
      if (d === "apply") projection = reduce(projection, e, e.payload);
      else if (d === "conflict") conflicts.push({ eventId: e.eventId, entityType: e.entityType, entityId: e.entityId });
    }
    if (conflicts.length) projection.__conflicts = conflicts;
    return projection;
  }

  // Projection (map) -> état à 12 tableaux (façon app.js), tombstones et
  // métadonnées exclus, ordre d'insertion conservé.
  function projectionToState(projection) {
    var state = {};
    for (var c = 0; c < COLLECTIONS.length; c++) {
      var coll = COLLECTIONS[c];
      var bucket = (projection && projection[coll]) || {};
      var arr = [];
      for (var id in bucket) {
        if (!Object.prototype.hasOwnProperty.call(bucket, id)) continue;
        var ent = bucket[id];
        if (ent && ent.__deleted) continue;
        arr.push(ent);
      }
      state[coll] = arr;
    }
    return state;
  }

  function rebuildState(events) { return projectionToState(replay(events)); }

  function mapByKey(list, key) {
    var m = {}; (list || []).forEach(function (x) { if (x && x[key] !== undefined) m[String(x[key])] = x; }); return m;
  }

  // Diff de deux états (12 tableaux) -> événements create/update/delete.
  // `versions` = projection.__versions courant (pour poser baseVersion juste).
  function diffToEvents(oldState, newState, opts) {
    opts = opts || {};
    var actorId = opts.actorId || "solo", epoch = opts.epoch || 1, versions = opts.versions || {};
    var events = [];
    function ver(coll, id) { var v = (versions[coll] || {})[String(id)]; return v && typeof v.version === "number" ? v.version : 0; }
    for (var c = 0; c < COLLECTIONS.length; c++) {
      var coll = COLLECTIONS[c], key = ENTITY_KEYS[coll];
      var oldMap = mapByKey(oldState && oldState[coll], key);
      var newMap = mapByKey(newState && newState[coll], key);
      var id;
      for (id in newMap) {
        if (!Object.prototype.hasOwnProperty.call(newMap, id)) continue;
        if (!Object.prototype.hasOwnProperty.call(oldMap, id)) {
          events.push(buildEvent({ entityType: coll, entityId: id, operation: "create", actorId: actorId, baseVersion: 0, epoch: epoch, payload: newMap[id] }));
        } else if (JSON.stringify(oldMap[id]) !== JSON.stringify(newMap[id])) {
          events.push(buildEvent({ entityType: coll, entityId: id, operation: "update", actorId: actorId, baseVersion: ver(coll, id), epoch: epoch, payload: newMap[id] }));
        }
      }
      for (id in oldMap) {
        if (!Object.prototype.hasOwnProperty.call(oldMap, id)) continue;
        if (!Object.prototype.hasOwnProperty.call(newMap, id)) {
          events.push(buildEvent({ entityType: coll, entityId: id, operation: "delete", actorId: actorId, baseVersion: ver(coll, id), epoch: epoch, payload: null }));
        }
      }
    }
    return events;
  }

  var API = {
    ENTITY_KEYS: ENTITY_KEYS, COLLECTIONS: COLLECTIONS, identityKey: identityKey,
    buildEvent: buildEvent, validate: validate, reduce: reduce, classify: classify,
    replay: replay, projectionToState: projectionToState, rebuildState: rebuildState,
    diffToEvents: diffToEvents
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.PiloteoEvents = API;
})(typeof window !== "undefined" ? window : globalThis);
