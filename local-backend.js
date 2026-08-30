/* local-backend.js — « backend local » Pilotéo pour le mode SOLO (Phase 2).
 *
 * Objectif : faire fonctionner Pilotéo SANS server.py, en gardant le métier
 * (app.js / index.html) STRICTEMENT inchangé. On ne réécrit pas l'application :
 * on remplace uniquement le transport. app.js parle au serveur via
 * `fetch("/api/...")` ; en mode solo, ce script intercepte ces appels et y
 * répond depuis IndexedDB, dans le navigateur, hors ligne.
 *
 * NON DESTRUCTIF / RÉVERSIBLE :
 *  - Script classique (pas de module), chargé AVANT app.js.
 *  - INERTE par défaut : il ne fait rien tant que le mode solo n'est pas activé
 *    (paramètre `?solo=1` une fois, puis mémorisé). Sur une instance servie par
 *    server.py sans ce drapeau, `window.fetch` n'est jamais modifié : le
 *    comportement V1 (connexion serveur) est identique.
 *  - N'implémente AUCUNE règle métier : en solo il y a un seul utilisateur,
 *    administrateur de son propre espace ; l'état est stocké tel quel.
 *
 * Contrat /api couvert (les seuls appels de app.js) :
 *   GET  /api/me      -> utilisateur admin synthétique « solo »
 *   POST /api/login   -> même utilisateur (aucun mot de passe en solo)
 *   POST /api/logout  -> ok (le reload de app.js relance simplement le solo)
 *   GET  /api/state   -> { revision, state } depuis IndexedDB (seed au 1er accès)
 *   PUT  /api/state   -> stocke l'état, incrémente la révision, renvoie l'état
 *
 * Le retrait de server.py (Phase 10) n'est PAS acté : la V1 serveur reste la
 * référence jusqu'à recette. Ceci ajoute une seconde façon de faire tourner la
 * même application, elle ne supprime rien.
 */
(function () {
  "use strict";

  // --- Détection du mode solo (drapeau explicite, mémorisé) ----------------
  var MODE_KEY = "piloteo_mode";
  function readParam() {
    try { return new URLSearchParams(location.search).get("solo"); } catch (e) { return null; }
  }
  function isSolo() {
    var p = readParam();
    if (p === "1" || p === "true") { try { localStorage.setItem(MODE_KEY, "solo"); } catch (e) {} return true; }
    if (p === "0" || p === "false") { try { localStorage.removeItem(MODE_KEY); } catch (e) {} return false; }
    try { return localStorage.getItem(MODE_KEY) === "solo"; } catch (e) { return false; }
  }

  // --- IndexedDB minimal (promisifié), une base propre au solo -------------
  var DB_NAME = "piloteo-solo";
  var DB_VERSION = 1;
  var STORE = "kv";               // { key, value }
  var STATE_KEY = "app_state";    // { revision, state }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readonly");
        var r = tx.objectStore(STORE).get(key);
        r.onsuccess = function () { resolve(r.result ? r.result.value : null); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  function idbPut(key, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put({ key: key, value: value });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // --- État : seed au premier accès depuis /seed.json ----------------------
  var COLLECTIONS = [
    "consultants", "organisations", "affaires", "methodes", "typesTerritoire",
    "domainesIntervention", "categoriesFrais", "missions", "factures",
    "saisies", "bordereauxFrais", "notesFrais"
  ];
  function emptyState() {
    var s = {}; COLLECTIONS.forEach(function (k) { s[k] = []; }); return s;
  }
  var _origFetch = window.fetch ? window.fetch.bind(window) : null;

  function loadSeed() {
    if (!_origFetch) return Promise.resolve(emptyState());
    return _origFetch("/seed.json", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : emptyState(); })
      .then(function (seed) {
        var s = emptyState();
        COLLECTIONS.forEach(function (k) { if (Array.isArray(seed[k])) s[k] = seed[k]; });
        return s;
      })
      .catch(function () { return emptyState(); });
  }

  function getRecord() {
    return idbGet(STATE_KEY).then(function (rec) {
      if (rec && rec.state) return rec;
      return loadSeed().then(function (state) {
        var fresh = { revision: 1, state: state };
        return idbPut(STATE_KEY, fresh).then(function () { return fresh; });
      });
    });
  }

  function soloUser(state) {
    var consultants = (state && state.consultants) || [];
    // Identité locale technique : rattachée au premier consultant existant pour
    // satisfaire le contrôle « compte rattaché à un consultant » de app.js.
    var consultantId = consultants.length ? consultants[0].id : "SOLO";
    return {
      username: "solo",
      name: "Mon espace (mode solo)",
      role: "admin",
      consultant_id: consultantId,
      csrf_token: "solo"
    };
  }

  function json(status, data) {
    return new Response(JSON.stringify(data), {
      status: status,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  // --- Routeur des appels /api en mode solo --------------------------------
  function handle(url, method, body) {
    var path = url.split("?")[0];
    method = (method || "GET").toUpperCase();

    if (path === "/api/me" || (path === "/api/login" && method === "POST")) {
      return getRecord().then(function (rec) { return json(200, { user: soloUser(rec.state) }); });
    }
    if (path === "/api/logout" && method === "POST") {
      return Promise.resolve(json(200, { ok: true }));
    }
    if (path === "/api/state" && method === "GET") {
      return getRecord().then(function (rec) { return json(200, { revision: rec.revision, state: rec.state }); });
    }
    if (path === "/api/state" && method === "PUT") {
      var incoming;
      try { incoming = JSON.parse(body || "{}"); } catch (e) { return Promise.resolve(json(400, { error: "JSON invalide" })); }
      var state = incoming && incoming.state;
      if (!state || typeof state !== "object") return Promise.resolve(json(400, { error: "état manquant" }));
      return getRecord().then(function (rec) {
        var nextRevision = (rec.revision || 0) + 1;
        var saved = { revision: nextRevision, state: state };
        return idbPut(STATE_KEY, saved).then(function () {
          // Un seul client en solo : jamais de conflit, jamais de filtrage.
          return json(200, { ok: true, revision: nextRevision, state: state, changes: {} });
        });
      });
    }
    if (path === "/api/health") {
      return Promise.resolve(json(200, { ok: true, mode: "solo" }));
    }
    // Endpoints non couverts en solo (ex. /api/admin/* du support) : 404 propre.
    return Promise.resolve(json(404, { error: "Indisponible en mode solo" }));
  }

  function install() {
    if (!("indexedDB" in window)) {
      console.warn("[Pilotéo solo] IndexedDB indisponible : mode solo impossible dans ce contexte.");
      return;
    }
    var base = _origFetch;
    window.fetch = function (input, init) {
      init = init || {};
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = init.method || (typeof input === "object" && input.method) || "GET";
      if (url.indexOf("/api/") === 0 || url.indexOf(location.origin + "/api/") === 0) {
        var path = url.replace(location.origin, "");
        var body = init.body;
        // Un Request objet peut porter le body ; app.js passe toujours init.body (string).
        return handle(path, method, typeof body === "string" ? body : null);
      }
      return base ? base(input, init) : Promise.reject(new Error("fetch indisponible"));
    };
    window.PiloteoLocal._installed = true;
    console.info("[Pilotéo] mode solo actif — données locales à cet appareil, aucun serveur.");
  }

  window.PiloteoLocal = {
    isSolo: isSolo,
    install: install,
    _installed: false,
    // Utilitaires exposés pour l'export/import de sauvegarde (Phase 2C).
    _getRecord: getRecord,
    _putState: function (state) { return getRecord().then(function (rec) {
      var next = { revision: (rec.revision || 0) + 1, state: state };
      return idbPut(STATE_KEY, next).then(function () { return next; });
    }); },
    _stateKey: STATE_KEY,
    _collections: COLLECTIONS
  };

  // Auto-installation synchrone AVANT app.js si le mode solo est actif.
  if (isSolo()) install();
})();
