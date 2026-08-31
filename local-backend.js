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
  var STATE_KEY = "app_state";    // { revision, state }  (snapshot rendu à l'app)
  var JOURNAL_KEY = "event_log";  // [event, ...]  (journal Phase 3, rejouable)

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
  // Utilisateur générique par défaut : aucune donnée personnelle. Sert d'identité
  // du membre solo quand le seed ne fournit aucun consultant (démarrage vierge).
  function defaultConsultant() {
    return { id: "MOI", nom: "Moi", trigramme: "MOI", statut: "en poste",
      dateEmbauche: "2026-01-01", dateDepart: null, tjmBase: 0, admin: true, tempsPartiel: [] };
  }
  // Garantit un état exploitable : ne conserve que les 12 collections connues et
  // s'assure qu'au moins un consultant existe (sinon app.js refuse le démarrage).
  function ensureUsable(seed) {
    var src = seed && typeof seed === "object" ? seed : {};
    var s = emptyState();
    COLLECTIONS.forEach(function (k) { if (Array.isArray(src[k])) s[k] = src[k]; });
    if (!s.consultants.length) s.consultants = [defaultConsultant()];
    return s;
  }
  var _origFetch = window.fetch ? window.fetch.bind(window) : null;

  function loadSeed() {
    if (!_origFetch) return Promise.resolve(ensureUsable(null));
    return _origFetch(basePath() + "seed.json", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (seed) { return ensureUsable(seed); })
      .catch(function () { return ensureUsable(null); });
  }

  function getRecord() {
    return idbGet(STATE_KEY).then(function (rec) {
      if (rec && rec.state) return rec;
      return loadSeed().then(function (state) {
        var fresh = { revision: 1, state: state };
        return idbPut(STATE_KEY, fresh).then(function () {
          // Phase 3 : journal genesis (un événement create par entité du seed).
          var PE = window.PiloteoEvents;
          if (PE) {
            try { return idbPut(JOURNAL_KEY, PE.diffToEvents({}, state, { actorId: "solo" })).then(function () { return fresh; }); }
            catch (e) { return fresh; }
          }
          return fresh;
        });
      });
    });
  }

  // Phase 3 : à chaque écriture, transformer la différence snapshot->nouvel état
  // en événements et les ajouter au journal (à côté du snapshot). Best-effort :
  // n'altère jamais la réponse rendue à l'application.
  function appendJournal(prevState, nextState) {
    var PE = window.PiloteoEvents;
    if (!PE) return Promise.resolve();
    return idbGet(JOURNAL_KEY).then(function (journal) {
      journal = Array.isArray(journal) ? journal : [];
      var proj = PE.replay(journal);
      var events = PE.diffToEvents(prevState || {}, nextState || {}, { actorId: "solo", versions: proj.__versions });
      var valid = events.filter(function (e) { return PE.validate(e.entityType, e.operation, e.payload).ok; });
      if (!valid.length) return;
      return idbPut(JOURNAL_KEY, journal.concat(valid));
    }).catch(function () { /* journal best-effort */ });
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
        var prevState = rec.state;
        // Journal Phase 3 (additif) puis snapshot (source rendue à l'app : ordre
        // intact, aucun réordonnancement côté UI).
        return appendJournal(prevState, state).then(function () {
          return idbPut(STATE_KEY, { revision: nextRevision, state: state }).then(function () {
            // Un seul client en solo : jamais de conflit, jamais de filtrage.
            return json(200, { ok: true, revision: nextRevision, state: state, changes: {} });
          });
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
    setupReglagesWhenReady();
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

  // --- Identité de l'administrateur solo (fiche consultant admin de l'état) ---
  function adminConsultantIndex(consultants) {
    var i = consultants.findIndex(function (c) { return c && c.admin; });
    if (i < 0 && consultants.length) i = 0;
    return i;
  }
  function getIdentity() {
    return getRecord().then(function (rec) {
      var cs = (rec.state && rec.state.consultants) || [];
      var i = adminConsultantIndex(cs);
      return i >= 0 ? cs[i] : null;
    });
  }
  function saveIdentity(nom, trigramme) {
    return getRecord().then(function (rec) {
      var state = rec.state; var cs = (state.consultants || []).slice();
      var i = adminConsultantIndex(cs);
      if (i < 0) return null;
      var tri = String(trigramme || cs[i].trigramme || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
      cs[i] = Object.assign({}, cs[i], { nom: (nom || cs[i].nom || "Moi"), trigramme: tri || cs[i].trigramme });
      state.consultants = cs;
      return window.PiloteoLocal._putState(state);
    });
  }

  // --- Réglages (panneau) : remplace la pastille flottante -------------------
  function setupReglagesWhenReady() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", buildReglages, { once: true });
    } else { buildReglages(); }
  }

  function el(tag, style, text) {
    var e = document.createElement(tag);
    if (style) e.setAttribute("style", style);
    if (text != null) e.textContent = text;
    return e;
  }

  function buildReglages() {
    if (document.getElementById("piloteo-gear")) return;

    // Bouton engrenage (bas-droite).
    var gear = el("button", "position:fixed;right:16px;bottom:16px;z-index:2147483000;width:44px;height:44px;" +
      "border-radius:50%;border:1px solid rgba(255,255,255,.16);background:rgba(20,32,40,.92);color:#eaf1f4;" +
      "font-size:20px;cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.28);backdrop-filter:blur(6px);", "⚙");
    gear.id = "piloteo-gear";
    gear.title = "Réglages Pilotéo";
    gear.setAttribute("aria-label", "Réglages");
    gear.addEventListener("click", openPanel);
    document.body.appendChild(gear);

    // Fichier d'import (caché, réutilisé).
    var file = el("input", "display:none;");
    file.type = "file"; file.accept = ".piloteobackup,.json,application/json";
    file.addEventListener("change", function () {
      var f = file.files && file.files[0]; if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        Promise.resolve(importBackupText(String(reader.result))).then(function () {
          alert("Sauvegarde importée. L'application va se recharger.");
          location.reload();
        }).catch(function (e) { alert("Import impossible : " + e.message); });
      };
      reader.readAsText(f); file.value = "";
    });
    document.body.appendChild(file);

    function openPanel() {
      if (document.getElementById("piloteo-reglages")) return;
      var back = el("div", "position:fixed;inset:0;z-index:2147483001;background:rgba(8,14,18,.55);" +
        "display:flex;align-items:center;justify-content:center;padding:16px;");
      back.id = "piloteo-reglages";
      back.addEventListener("click", function (ev) { if (ev.target === back) close(); });

      var card = el("div", "width:min(560px,96vw);max-height:90vh;overflow:auto;background:#fff;color:#14212b;" +
        "border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.35);font:400 14px/1.45 system-ui,-apple-system,sans-serif;");
      var head = el("div", "display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #eef1f3;");
      head.appendChild(el("strong", "font-size:16px;", "Réglages"));
      var x = el("button", "background:none;border:none;font-size:20px;cursor:pointer;color:#5b6b76;line-height:1;", "✕");
      x.setAttribute("aria-label", "Fermer"); x.addEventListener("click", close);
      head.appendChild(x);
      card.appendChild(head);

      var body = el("div", "padding:6px 18px 18px;");
      card.appendChild(body);
      back.appendChild(card);
      document.body.appendChild(back);

      // Section 1 — Mon espace (identité)
      body.appendChild(sectionTitle("Mon espace"));
      var idBox = el("div", "display:grid;grid-template-columns:1fr;gap:10px;margin:8px 0 4px;");
      var nomIn = fieldInput("Nom affiché", "text");
      var triIn = fieldInput("Trigramme (3 lettres)", "text");
      triIn.input.maxLength = 3; triIn.input.style.textTransform = "uppercase";
      var idMsg = el("div", "font-size:12.5px;color:#5b6b76;min-height:16px;");
      var save = mkBtn("Enregistrer", function () {
        idMsg.textContent = "Enregistrement…";
        saveIdentity(nomIn.input.value.trim(), triIn.input.value.trim()).then(function () {
          idMsg.textContent = "Enregistré. Rechargement…";
          setTimeout(function () { location.reload(); }, 500);
        }).catch(function (e) { idMsg.textContent = "Échec : " + (e && e.message || e); });
      }, true);
      idBox.appendChild(nomIn.wrap); idBox.appendChild(triIn.wrap);
      body.appendChild(idBox);
      var idRow = el("div", "display:flex;align-items:center;gap:12px;margin-bottom:6px;");
      idRow.appendChild(save); idRow.appendChild(idMsg);
      body.appendChild(idRow);
      body.appendChild(el("p", "margin:2px 0 4px;font-size:12.5px;color:#5b6b76;",
        "Rôle : Administrateur de cet espace. L'authentification par compte (mot de passe, plusieurs personnes) arrive avec les modes partagés."));
      getIdentity().then(function (id) {
        if (id) { nomIn.input.value = id.nom || ""; triIn.input.value = id.trigramme || ""; }
      });

      // Section 2 — Sauvegarde
      body.appendChild(sectionTitle("Sauvegarde"));
      var bkRow = el("div", "display:flex;gap:8px;flex-wrap:wrap;margin:6px 0;");
      bkRow.appendChild(mkBtn("Exporter une sauvegarde", function () {
        exportBackup().catch(function (e) { alert("Export impossible : " + e.message); });
      }));
      bkRow.appendChild(mkBtn("Importer une sauvegarde", function () { file.click(); }));
      body.appendChild(bkRow);
      body.appendChild(el("p", "margin:2px 0 4px;font-size:12.5px;color:#5b6b76;",
        "Un fichier .piloteobackup contient toutes vos données de cet appareil."));

      // Section 3 — Stockage & synchronisation
      body.appendChild(sectionTitle("Stockage & synchronisation"));
      var hasFsa = (typeof window.showDirectoryPicker === "function");
      var modes = [
        ["Cet appareil (navigateur)", "Actif", "#137a3f", "Vos données sont enregistrées dans ce navigateur (IndexedDB), hors ligne."],
        ["Un dossier (OneDrive, SharePoint, Drive…)", hasFsa ? "Bientôt" : "Navigateur non compatible", hasFsa ? "#8a6d1f" : "#8a3b2f",
          hasFsa ? "Moteur prêt et testé ; le câblage en écriture vive dans l'app est la prochaine étape proposée."
                 : "Nécessite Chrome/Edge/Opera sur ordinateur (File System Access)."],
        ["Google Drive", "Bientôt", "#8a6d1f", "Adaptateur prêt ; activation par identifiant OAuth (GOOGLE_CLIENT_ID), après le câblage dossier."],
        ["Serveur hébergé", "Disponible séparément", "#5b6b76", "Déploiement Docker (voir docs/deployment). Mode centralisé, hors application solo."]
      ];
      modes.forEach(function (m) { body.appendChild(modeRow(m[0], m[1], m[2], m[3])); });

      // Section 4 — Session
      body.appendChild(sectionTitle("Session"));
      var lockRow = el("div", "display:flex;gap:8px;flex-wrap:wrap;margin:6px 0;");
      lockRow.appendChild(mkBtn("Verrouiller l'espace", function () { close(); lockSpace(); }));
      body.appendChild(lockRow);
      body.appendChild(el("p", "margin:2px 0 2px;font-size:12.5px;color:#5b6b76;",
        "Verrouille l'affichage sur cet appareil. La déconnexion/reconnexion par compte réel arrive avec l'authentification (modes partagés)."));

      function close() { var p = document.getElementById("piloteo-reglages"); if (p) p.remove(); }
    }
  }

  function sectionTitle(t) {
    return el("h3", "margin:18px 0 2px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#7a8a94;", t);
  }
  function fieldInput(label, type) {
    var wrap = el("label", "display:block;font-size:12.5px;color:#5b6b76;");
    wrap.appendChild(el("span", "display:block;margin-bottom:3px;", label));
    var input = el("input", "width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d5dde2;border-radius:8px;font:inherit;");
    input.type = type || "text";
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }
  function modeRow(name, badge, color, desc) {
    var row = el("div", "padding:8px 0;border-bottom:1px solid #f1f4f6;");
    var top = el("div", "display:flex;align-items:center;gap:8px;");
    top.appendChild(el("span", "font-weight:600;", name));
    top.appendChild(el("span", "margin-left:auto;font-size:11.5px;font-weight:700;color:#fff;background:" + color +
      ";padding:2px 8px;border-radius:999px;", badge));
    row.appendChild(top);
    row.appendChild(el("div", "font-size:12.5px;color:#5b6b76;margin-top:2px;", desc));
    return row;
  }

  // Verrouillage d'écran (sans mot de passe — vrai lock, pas de sécurité factice).
  function lockSpace() {
    if (document.getElementById("piloteo-lock")) return;
    var ov = el("div", "position:fixed;inset:0;z-index:2147483002;background:#0d1a22;color:#eaf1f4;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;" +
      "font:400 15px/1.4 system-ui,-apple-system,sans-serif;text-align:center;padding:24px;");
    ov.id = "piloteo-lock";
    ov.appendChild(el("div", "font-size:34px;", "🔒"));
    ov.appendChild(el("div", "font-size:18px;font-weight:600;", "Espace verrouillé"));
    ov.appendChild(el("div", "opacity:.75;max-width:320px;", "Vos données restent sur cet appareil. Déverrouillez pour reprendre."));
    var btn = mkBtn("Déverrouiller", function () { ov.remove(); }, true);
    ov.appendChild(btn);
    document.body.appendChild(ov);
  }

  function mkBtn(text, onClick, primary) {
    var b = document.createElement("button");
    b.type = "button"; b.textContent = text;
    var base = primary
      ? "color:#fff;background:#137a3f;border:1px solid #0f6835;"
      : "color:#14212b;background:#f2f5f7;border:1px solid #d5dde2;";
    b.setAttribute("style", "font:600 13px/1 system-ui,sans-serif;border-radius:8px;padding:9px 14px;cursor:pointer;" + base);
    b.addEventListener("click", onClick);
    b.addEventListener("mouseenter", function () { b.style.filter = "brightness(0.96)"; });
    b.addEventListener("mouseleave", function () { b.style.filter = "none"; });
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
    _collections: COLLECTIONS,
    _getJournal: function () { return idbGet(JOURNAL_KEY).then(function (j) { return Array.isArray(j) ? j : []; }); },
    // Invariant Phase 3 : l'état reconstruit en rejouant le journal doit être
    // identique (ensembliste) au snapshot courant.
    _verifyReplay: function () {
      var PE = window.PiloteoEvents;
      return Promise.all([idbGet(STATE_KEY), idbGet(JOURNAL_KEY)]).then(function (r) {
        var snap = r[0] && r[0].state; var journal = Array.isArray(r[1]) ? r[1] : [];
        if (!PE || !snap) return { ok: false, reason: "PiloteoEvents ou snapshot indisponible" };
        var rebuilt = PE.rebuildState(journal);
        var ok = COLLECTIONS.every(function (c) {
          var key = PE.ENTITY_KEYS[c], a = {}, b = {};
          (snap[c] || []).forEach(function (x) { a[String(x[key])] = JSON.stringify(x); });
          (rebuilt[c] || []).forEach(function (x) { b[String(x[key])] = JSON.stringify(x); });
          var ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
          return JSON.stringify(ka) === JSON.stringify(kb) && ka.every(function (id) { return a[id] === b[id]; });
        });
        return { ok: ok, journalLength: journal.length };
      });
    }
  };

  // Auto-installation synchrone AVANT app.js si le mode solo est actif.
  if (isSolo()) install();
})();
