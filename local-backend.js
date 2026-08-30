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
    // Forçage au build (déploiement statique dédié) : window.PILOTEO_FORCE_SOLO.
    if (window.PILOTEO_FORCE_SOLO === true) return true;
    var p = readParam();
    if (p === "1" || p === "true") { try { localStorage.setItem(MODE_KEY, "solo"); } catch (e) {} return true; }
    if (p === "0" || p === "false") { try { localStorage.removeItem(MODE_KEY); } catch (e) {} return false; }
    try { return localStorage.getItem(MODE_KEY) === "solo"; } catch (e) { return false; }
  }

  // Base de déploiement (« / » à la racine, « /piloteo/ » en sous-dossier type
  // GitHub Pages). Dérivée du chemin courant pour rester agnostique à l'URL.
  function basePath() {
    try { return location.pathname.replace(/[^/]*$/, ""); } catch (e) { return "/"; }
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
    return _origFetch(basePath() + "seed.json", { credentials: "same-origin" })
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
    setupBrandingWhenReady();
    setupToolbarWhenReady();
    // Hors ligne après premier chargement (Phase 2B). Nécessite un contexte
    // sécurisé (https ou localhost) ; échec silencieux sinon. Chemins dérivés de
    // la base de déploiement (racine ou sous-dossier).
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      try { navigator.serviceWorker.register(basePath() + "sw-solo.js", { scope: basePath() }).catch(function () {}); } catch (e) {}
    }
  }

  // --- Habillage statique (solo) : remplace le gabarit serveur non substitué --
  // En mode serveur, server.py remplace {{PILOTEO_ORG_NAME}} et sert /brand-logo.
  // En statique (solo), on fait ce remplacement côté client pour un rendu propre,
  // sans toucher index.html (réversible, n'affecte jamais le mode serveur).
  function setupBrandingWhenReady() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", applyBranding, { once: true });
    } else { applyBranding(); }
  }
  function applyBranding() {
    var ORG = "Pilotéo";
    try {
      // Lien manifeste (installation « ajouter à l'écran d'accueil »).
      if (!document.querySelector('link[rel="manifest"]')) {
        var l = document.createElement("link");
        l.rel = "manifest"; l.href = basePath() + "manifest.webmanifest";
        document.head.appendChild(l);
      }
      // Remplacer le gabarit {{PILOTEO_ORG_NAME}} dans les nœuds texte.
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var nodes = [], n;
      while ((n = walker.nextNode())) { if (n.nodeValue && n.nodeValue.indexOf("{{PILOTEO_ORG_NAME}}") !== -1) nodes.push(n); }
      nodes.forEach(function (node) { node.nodeValue = node.nodeValue.split("{{PILOTEO_ORG_NAME}}").join(ORG); });
      if (document.title.indexOf("{{PILOTEO_ORG_NAME}}") !== -1) document.title = document.title.split("{{PILOTEO_ORG_NAME}}").join(ORG);
      // Logo : /brand-logo est servi par server.py ; en statique on retombe sur
      // le logo neutre embarqué.
      var img = document.querySelector("img.sidebar-logo");
      if (img) { img.src = basePath() + "assets/logo-default.svg"; img.onerror = function () { img.style.display = "none"; }; }
    } catch (e) { /* habillage best-effort, jamais bloquant */ }
  }

  // --- Barre solo : export / import d'une sauvegarde (.piloteobackup) -------
  var BACKUP_FORMAT = "piloteo-backup-v1";

  function download(filename, text) {
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  function exportBackup() {
    return getRecord().then(function (rec) {
      var backup = {
        format: BACKUP_FORMAT,
        exportedAt: new Date().toISOString(),
        revision: rec.revision,
        manifest: { collections: COLLECTIONS.reduce(function (m, k) { m[k] = (rec.state[k] || []).length; return m; }, {}) },
        state: rec.state
      };
      var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      download("piloteo-solo-" + stamp + ".piloteobackup", JSON.stringify(backup, null, 2));
      return backup;
    });
  }

  function importBackupText(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("Fichier illisible (JSON invalide)."); }
    if (!data || data.format !== BACKUP_FORMAT || !data.state || typeof data.state !== "object") {
      throw new Error("Ce fichier n'est pas une sauvegarde Pilotéo valide.");
    }
    var state = {};
    COLLECTIONS.forEach(function (k) { state[k] = Array.isArray(data.state[k]) ? data.state[k] : []; });
    return window.PiloteoLocal._putState(state);
  }

  function setupToolbarWhenReady() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", buildToolbar, { once: true });
    } else {
      buildToolbar();
    }
  }

  function buildToolbar() {
    if (document.getElementById("piloteo-solo-bar")) return;
    var bar = document.createElement("div");
    bar.id = "piloteo-solo-bar";
    bar.setAttribute("style",
      "position:fixed;right:14px;bottom:14px;z-index:2147483000;display:flex;gap:8px;align-items:center;" +
      "background:rgba(20,32,40,.92);color:#eaf1f4;border:1px solid rgba(255,255,255,.14);" +
      "border-radius:999px;padding:7px 10px 7px 14px;font:500 13px/1 system-ui,-apple-system,sans-serif;" +
      "box-shadow:0 6px 22px rgba(0,0,0,.28);backdrop-filter:blur(6px);");
    var label = document.createElement("span");
    label.textContent = "Solo";
    label.setAttribute("style", "opacity:.75;letter-spacing:.02em;");
    var btnExport = mkBtn("Exporter", exportBtn);
    var btnImport = mkBtn("Importer", importBtn);
    var file = document.createElement("input");
    file.type = "file"; file.accept = ".piloteobackup,.json,application/json";
    file.setAttribute("style", "display:none;");
    file.addEventListener("change", function () {
      var f = file.files && file.files[0]; if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          Promise.resolve(importBackupText(String(reader.result))).then(function () {
            alert("Sauvegarde importée. L'application va se recharger.");
            location.reload();
          }).catch(function (e) { alert("Import impossible : " + e.message); });
        } catch (e) { alert("Import impossible : " + e.message); }
      };
      reader.readAsText(f);
      file.value = "";
    });
    bar.appendChild(label); bar.appendChild(btnExport); bar.appendChild(btnImport); bar.appendChild(file);
    document.body.appendChild(bar);

    function exportBtn() { exportBackup().catch(function (e) { alert("Export impossible : " + e.message); }); }
    function importBtn() { file.click(); }
  }

  function mkBtn(text, onClick) {
    var b = document.createElement("button");
    b.type = "button"; b.textContent = text;
    b.setAttribute("style",
      "font:600 13px/1 system-ui,sans-serif;color:#eaf1f4;background:rgba(255,255,255,.10);" +
      "border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:7px 12px;cursor:pointer;");
    b.addEventListener("click", onClick);
    b.addEventListener("mouseenter", function () { b.style.background = "rgba(255,255,255,.20)"; });
    b.addEventListener("mouseleave", function () { b.style.background = "rgba(255,255,255,.10)"; });
    return b;
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
