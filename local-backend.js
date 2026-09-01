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
  // --- Point 1b (docs/next/CONVERGENCE_CONTRACT.md §6bis) : indirection ----
  // ADDITIF, réversible : tant que `activeEngine` n'est pas posé, `/api/state`
  // suit EXACTEMENT le chemin KV ci-dessus (getRecord/idbPut) — inchangé bit à
  // bit. `activeEngine` (posé par `activateFolder()` ci-dessous, ou repris au
  // boot) bascule `/api/state` sur le store event-first du dossier choisi
  // (`window.PiloteoNext`, voir piloteo-solo-bridge.mjs) : un « engine »
  // `{load, commit}` qui rend directement la forme attendue par `handle()`.
  var STORAGE_MODE_KEY = "piloteo_storage_mode"; // localStorage : "folder" | "org" | absent (= cet appareil)
  var ORG_NAME_KEY = "piloteo_org_name";          // localStorage : nom d'affichage de l'org (best-effort, cf. §Organisation)
  var activeEngine = null;           // engine {load,commit,...} du dossier/org actif, ou null (mode classique)
  var folderNeedsPermission = false; // dossier mémorisé mais permission à ré-accorder (geste utilisateur requis)
  var orgNeedsPermission = false;    // organisation mémorisée mais permission à ré-accorder (idem, mode org)
  var activeOrgAdapter = null;       // StorageAdapter de l'organisation active (requis par invite/revoke)
  var storageMode = null;
  try { storageMode = localStorage.getItem(STORAGE_MODE_KEY); } catch (e) { storageMode = null; }

  // Attend `window.PiloteoNext` (posé par le module `piloteo-solo-bridge.mjs`,
  // chargé en `<script type="module">` donc différé de fait) jusqu'à
  // `timeoutMs` ; résout à `null` passé ce délai — garde-fou du contrat : le
  // module absent/pas encore chargé rend simplement le mode Dossier indisponible.
  function waitForPiloteoNext(timeoutMs) {
    return new Promise(function (resolve) {
      var waited = 0, step = 50;
      (function poll() {
        if (window.PiloteoNext) { resolve(window.PiloteoNext); return; }
        waited += step;
        if (waited >= timeoutMs) { resolve(null); return; }
        setTimeout(poll, step);
      })();
    });
  }

  // Reprise au boot (mémoïsée : un seul essai par chargement de page). Si le
  // mode mémorisé est "folder", tente `resumeFolder()` et pose `activeEngine`,
  // ou consigne le besoin de re-permission. N'est appelée que par
  // `withFolderReady` ci-dessous, jamais pour le mode par défaut.
  var _folderReady = null;
  function ensureFolderReady() {
    if (_folderReady) return _folderReady;
    _folderReady = waitForPiloteoNext(4000).then(function (PN) {
      if (!PN) {
        // Correctif revue 1b (#5/#6) : le pont ne s'est pas chargé (hors ligne,
        // cache incomplet…) alors que le mode Dossier était mémorisé -> on retombe
        // sur cet appareil, mais avec un AVERTISSEMENT VISIBLE (pas un simple
        // console.warn), car l'utilisateur verrait sinon les données de l'appareil
        // en croyant travailler dans son dossier.
        showFolderBanner("Mode Dossier indisponible (hors ligne ou chargement incomplet). " +
          "Les données affichées sont celles de cet appareil, pas de votre dossier. Rechargez une fois en ligne.");
        return;
      }
      return PN.resumeFolder().then(function (result) {
        if (result && result.engine) {
          activeEngine = result.engine;
          folderNeedsPermission = false;
          console.info("[Pilotéo] mode Dossier repris" + (result.engine.folderName ? " (" + result.engine.folderName + ")" : "") + ".");
        } else if (result && result.needsPermission) {
          folderNeedsPermission = true;
          showFolderBanner("Votre dossier nécessite de renouveler l'autorisation d'accès.",
            "Redonner l'accès", function () {
              retryFolderPermission().then(function () { location.reload(); })
                .catch(function (e) { alert("Accès au dossier refusé : " + ((e && e.message) || e)); });
            });
        }
        // `result === null` : jamais activé malgré le drapeau (improbable) — on reste sur cet appareil.
      }).catch(function (e) {
        showFolderBanner("Reprise du dossier impossible : " + ((e && e.message) || e) +
          " Les données affichées sont celles de cet appareil.");
      });
    });
    return _folderReady;
  }

  // --- Point 2c-C2 (docs/next/ORG_UI_CONTRACT.md) : mode Organisation ------
  // SYMÉTRIQUE au mode Dossier ci-dessus : `storageMode==="org"` bascule
  // `/api/state` sur un org engine (`window.PiloteoOrg`, voir
  // piloteo-org-bridge.mjs) au lieu du dossier event-first solo. Même
  // garde-fou (module non chargé -> mode indisponible, bannière visible),
  // même logique de reprise au boot (permission à renouveler -> geste
  // utilisateur requis).
  function waitForPiloteoOrg(timeoutMs) {
    return new Promise(function (resolve) {
      var waited = 0, step = 50;
      (function poll() {
        if (window.PiloteoOrg) { resolve(window.PiloteoOrg); return; }
        waited += step;
        if (waited >= timeoutMs) { resolve(null); return; }
        setTimeout(poll, step);
      })();
    });
  }

  var _orgReady = null;
  function ensureOrgReady() {
    if (_orgReady) return _orgReady;
    _orgReady = waitForPiloteoOrg(4000).then(function (PO) {
      if (!PO) {
        showFolderBanner("Mode Organisation indisponible (hors ligne ou chargement incomplet). " +
          "Les données affichées sont celles de cet appareil, pas de votre organisation. Rechargez une fois en ligne.");
        return;
      }
      return PO.resumeOrg().then(function (result) {
        if (result && result.engine) {
          activeEngine = result.engine;
          activeOrgAdapter = result.adapter || null;
          orgNeedsPermission = false;
          console.info("[Pilotéo] mode Organisation repris" + (result.engine.folderName ? " (" + result.engine.folderName + ")" : "") + ".");
        } else if (result && result.needsPermission) {
          orgNeedsPermission = true;
          showFolderBanner("Votre organisation nécessite de renouveler l'autorisation d'accès au dossier partagé.",
            "Redonner l'accès", function () {
              retryOrgPermission().then(function () { location.reload(); })
                .catch(function (e) { alert("Accès au dossier refusé : " + ((e && e.message) || e)); });
            });
        }
        // `result === null` : jamais activé malgré le drapeau (improbable) — on reste sur cet appareil.
      }).catch(function (e) {
        showFolderBanner("Reprise de l'organisation impossible : " + ((e && e.message) || e) +
          " Les données affichées sont celles de cet appareil.");
      });
    });
    return _orgReady;
  }

  // Ouvre le sélecteur natif puis crée l'organisation (writeManifest +
  // writeMemberRecord côté pont) et active le mode org. `name` : nom
  // d'affichage de l'organisation — le manifeste (racine de confiance, lot
  // 2c-B/2c-C1, non modifié ici) ne le porte pas ; on le mémorise donc
  // localement (best-effort, `ORG_NAME_KEY`) pour l'affichage Réglages sur
  // CET appareil (un membre qui rejoint via `joinOrg` n'a pas ce nom : repli
  // générique "Organisation", cf. buildReglages ci-dessous).
  function activateCreateOrg(name) {
    if (!window.PiloteoOrg) return Promise.reject(new Error("Le pont Organisation n'a pas chargé (rechargez la page)."));
    if (!window.PiloteoOrg.hasFileSystemAccess) return Promise.reject(new Error("Navigateur non compatible (Chrome/Edge/Opera sur ordinateur requis)."));
    return window.PiloteoOrg.pickDirectory().then(function (handle) {
      return stateRecord().then(function (rec) {
        var cs = (rec.state && rec.state.consultants) || [];
        var i = adminConsultantIndex(cs);
        var consultantId = i >= 0 ? cs[i].id : null;
        return window.PiloteoOrg.createOrg({ handle: handle, name: name, consultantId: consultantId });
      });
    }).then(function (result) {
      activeEngine = result.engine;
      activeOrgAdapter = result.adapter || null;
      orgNeedsPermission = false;
      storageMode = "org";
      try { localStorage.setItem(STORAGE_MODE_KEY, "org"); } catch (e) {}
      try { if (name) localStorage.setItem(ORG_NAME_KEY, name); } catch (e) {}
      _orgReady = Promise.resolve();
      return result;
    });
  }

  // Ouvre le sélecteur natif (dossier partagé de l'organisation à rejoindre)
  // puis rejoint via le code d'invitation collé (`codeText`) et active le
  // mode org.
  function activateJoinOrg(codeText) {
    if (!window.PiloteoOrg) return Promise.reject(new Error("Le pont Organisation n'a pas chargé (rechargez la page)."));
    if (!window.PiloteoOrg.hasFileSystemAccess) return Promise.reject(new Error("Navigateur non compatible (Chrome/Edge/Opera sur ordinateur requis)."));
    return window.PiloteoOrg.pickDirectory().then(function (handle) {
      return stateRecord().then(function (rec) {
        var cs = (rec.state && rec.state.consultants) || [];
        var i = adminConsultantIndex(cs);
        var consultantId = i >= 0 ? cs[i].id : null;
        return window.PiloteoOrg.joinOrg({ handle: handle, invitation: codeText, consultantId: consultantId });
      });
    }).then(function (result) {
      activeEngine = result.engine;
      activeOrgAdapter = result.adapter || null;
      orgNeedsPermission = false;
      storageMode = "org";
      try { localStorage.setItem(STORAGE_MODE_KEY, "org"); } catch (e) {}
      _orgReady = Promise.resolve();
      return result;
    });
  }

  // Revient au stockage « cet appareil » : les données DE L'ORGANISATION
  // restent intactes sur le dossier partagé (rien n'est supprimé) ;
  // `/api/state` repasse sur IndexedDB.
  function deactivateOrg() {
    activeEngine = null;
    activeOrgAdapter = null;
    orgNeedsPermission = false;
    storageMode = null;
    try { localStorage.removeItem(STORAGE_MODE_KEY); } catch (e) {}
    _orgReady = Promise.resolve();
  }

  // Re-demande la permission sur le dossier de l'organisation mémorisée.
  // À appeler depuis un VRAI geste utilisateur (clic), comme
  // `retryFolderPermission`.
  function retryOrgPermission() {
    if (!window.PiloteoOrg) return Promise.reject(new Error("Le pont Organisation n'a pas chargé (rechargez la page)."));
    return window.PiloteoOrg.resumeOrg().then(function (result) {
      if (result && result.engine) {
        activeEngine = result.engine;
        activeOrgAdapter = result.adapter || null;
        orgNeedsPermission = false;
        storageMode = "org";
        try { localStorage.setItem(STORAGE_MODE_KEY, "org"); } catch (e) {}
        _orgReady = Promise.resolve();
        return result;
      }
      if (result && result.needsPermission) { orgNeedsPermission = true; throw new Error("Autorisation refusée pour ce dossier."); }
      throw new Error("Aucune organisation mémorisée.");
    });
  }

  // Bannière VISIBLE (haut de page) pour les incidents du mode Dossier (au boot :
  // pont non chargé, permission à renouveler…). Contrairement à un console.warn,
  // l'utilisateur la voit. Optionnellement un bouton d'action. Idempotente.
  function showFolderBanner(message, actionLabel, actionFn) {
    function build() {
      var existing = document.getElementById("piloteo-folder-banner");
      if (existing) existing.remove();
      var bar = document.createElement("div");
      bar.id = "piloteo-folder-banner";
      bar.setAttribute("role", "alert");
      bar.setAttribute("style", "position:fixed;left:0;right:0;top:0;z-index:2147483003;" +
        "background:#8a6d1f;color:#fff;font:500 13px/1.4 system-ui,-apple-system,sans-serif;" +
        "padding:10px 14px;display:flex;gap:12px;align-items:center;box-shadow:0 2px 10px rgba(0,0,0,.25);");
      var txt = document.createElement("span");
      txt.style.flex = "1"; txt.textContent = message;
      bar.appendChild(txt);
      if (actionLabel && typeof actionFn === "function") {
        var act = document.createElement("button");
        act.type = "button"; act.textContent = actionLabel;
        act.setAttribute("style", "background:#fff;color:#14212b;border:none;border-radius:6px;" +
          "padding:6px 12px;font-weight:600;cursor:pointer;");
        act.addEventListener("click", actionFn);
        bar.appendChild(act);
      }
      var close = document.createElement("button");
      close.type = "button"; close.textContent = "✕"; close.setAttribute("aria-label", "Fermer");
      close.setAttribute("style", "background:none;border:none;color:#fff;font-size:16px;cursor:pointer;");
      close.addEventListener("click", function () { bar.remove(); });
      bar.appendChild(close);
      document.body.appendChild(bar);
    }
    if (document.body) build();
    else document.addEventListener("DOMContentLoaded", build, { once: true });
  }

  // --- Écran de premier lancement (point 2c-C2, ORG_UI_CONTRACT §3) --------
  // Overlay plein écran (comme `lockSpace` plus bas), affiché UNE SEULE FOIS
  // (idempotent via `_firstLaunchShown`) au tout premier démarrage constaté
  // par `getRecord()` (voir ci-dessus). N'empêche jamais app.js de démarrer
  // en dessous (mode classique inchangé) : c'est un choix, pas un blocage —
  // fermer l'écran (« Continuer ») équivaut à ne rien faire (le mode
  // classique était déjà actif).
  var _firstLaunchShown = false;
  function maybeShowFirstLaunch() {
    if (_firstLaunchShown) return;
    _firstLaunchShown = true;
    if (document.body) renderWelcomeScreen();
    else document.addEventListener("DOMContentLoaded", renderWelcomeScreen, { once: true });
  }

  function renderWelcomeScreen() {
    if (document.getElementById("piloteo-welcome")) return;
    var ov = el("div", "position:fixed;inset:0;z-index:2147483004;background:#0d1a22;color:#eaf1f4;" +
      "display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto;" +
      "font:400 15px/1.45 system-ui,-apple-system,sans-serif;");
    ov.id = "piloteo-welcome";

    var wrap = el("div", "width:100%;max-width:920px;");
    wrap.appendChild(el("div", "font-size:1.6rem;font-weight:700;margin-bottom:6px;text-align:center;", "Bienvenue sur Pilotéo"));
    wrap.appendChild(el("div", "opacity:.72;text-align:center;margin-bottom:26px;", "Comment voulez-vous commencer ?"));
    var grid = el("div", "display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;");
    wrap.appendChild(grid);
    ov.appendChild(wrap);
    document.body.appendChild(ov);

    function card(title, desc) {
      var c = el("div", "background:#152530;border:1px solid rgba(255,255,255,.14);border-radius:14px;" +
        "padding:20px;display:flex;flex-direction:column;gap:10px;");
      c.appendChild(el("div", "font-size:1.02rem;font-weight:700;", title));
      c.appendChild(el("div", "font-size:.85rem;opacity:.75;", desc));
      return c;
    }
    function darkInput(input) {
      input.setAttribute("style", input.getAttribute("style") + "background:#0d1a22;color:#eaf1f4;border-color:rgba(255,255,255,.22);");
      return input;
    }

    // Carte 1 — compte indépendant (mode classique actuel).
    var c1 = card("Utiliser seul (cet appareil)", "Vos données restent dans ce navigateur, hors ligne. Vous pourrez créer ou rejoindre une organisation plus tard, depuis Réglages.");
    c1.appendChild(mkBtn("Continuer", function () { ov.remove(); }, true));
    grid.appendChild(c1);

    // Carte 2 — créer une organisation.
    var c2 = card("Créer une organisation", "Choisissez un dossier (local, OneDrive, SharePoint, Drive…) qui deviendra le dossier partagé de votre organisation.");
    var nameIn = fieldInput("Nom de l'organisation", "text");
    darkInput(nameIn.input);
    c2.appendChild(nameIn.wrap);
    var msg2 = el("div", "font-size:12.5px;color:#f6d685;min-height:16px;");
    var b2 = mkBtn("Choisir un dossier et créer", function () {
      var name = nameIn.input.value.trim();
      if (!name) { msg2.textContent = "Indiquez un nom d'organisation."; return; }
      msg2.textContent = "Sélection du dossier…";
      activateCreateOrg(name).then(function () {
        alert("Organisation créée. L'application va se recharger.");
        location.reload();
      }).catch(function (e) { msg2.textContent = "Échec : " + ((e && e.message) || e); });
    }, true);
    c2.appendChild(b2); c2.appendChild(msg2);
    grid.appendChild(c2);

    // Carte 3 — rejoindre une organisation.
    var c3 = card("Rejoindre une organisation", "Choisissez le dossier partagé de l'organisation, puis collez le code d'invitation reçu.");
    var codeIn = document.createElement("textarea");
    codeIn.placeholder = "Coller le code d'invitation ici";
    codeIn.setAttribute("style", "width:100%;box-sizing:border-box;min-height:64px;padding:8px 10px;border-radius:8px;" +
      "border:1px solid rgba(255,255,255,.22);background:#0d1a22;color:#eaf1f4;font:inherit;font-size:12px;resize:vertical;");
    c3.appendChild(codeIn);
    var msg3 = el("div", "font-size:12.5px;color:#f6d685;min-height:16px;");
    var b3 = mkBtn("Choisir le dossier et rejoindre", function () {
      var code = codeIn.value.trim();
      if (!code) { msg3.textContent = "Collez le code d'invitation reçu."; return; }
      msg3.textContent = "Sélection du dossier…";
      activateJoinOrg(code).then(function () {
        alert("Vous avez rejoint l'organisation. L'application va se recharger.");
        location.reload();
      }).catch(function (e) { msg3.textContent = "Échec : " + ((e && e.message) || e); });
    }, true);
    c3.appendChild(b3); c3.appendChild(msg3);
    grid.appendChild(c3);

    // Sur navigateur sans File System Access, options 2/3 désactivées + explication
    // (contrat §3). `window.PiloteoOrg` peut ne pas être chargé ENCORE (module
    // différé) : on attend un court instant avant de trancher, jamais un blocage
    // définitif de l'écran (garde-fou déjà appliqué ailleurs, cf. ensureOrgReady).
    waitForPiloteoOrg(4000).then(function (PO) {
      var available = !!(PO && PO.hasFileSystemAccess);
      if (!available) {
        [b2, b3].forEach(function (b) { b.disabled = true; b.style.opacity = ".45"; b.style.cursor = "not-allowed"; });
        var note = "Nécessite Chrome/Edge/Opera sur ordinateur (File System Access).";
        c2.appendChild(el("div", "font-size:12px;color:#f6d685;", note));
        c3.appendChild(el("div", "font-size:12px;color:#f6d685;", note));
      }
    });
  }

  // Exécute `fn` (qui produit la réponse `/api/state`) après une éventuelle
  // reprise du dossier OU de l'organisation. Mode par défaut
  // (`storageMode` ni "folder" ni "org") : appelle `fn()` immédiatement, sans
  // détour — comportement STRICTEMENT inchangé pour le chemin classique.
  // Point 2c-C2 : généralisée pour router aussi vers `ensureOrgReady()` —
  // c'est CETTE fonction que le contrat désigne comme routant `/api/me`,
  // `/api/state` GET/PUT et `putStateUnified` vers l'org engine "exactement
  // comme le mode folder" ; aucun des points d'appel existants n'a besoin
  // d'être touché.
  function withFolderReady(fn) {
    if (storageMode === "folder") return ensureFolderReady().then(fn);
    if (storageMode === "org") return ensureOrgReady().then(fn);
    return fn();
  }

  // `{revision, state}` courant, depuis le dossier actif si posé, sinon IndexedDB.
  function stateRecord() {
    return activeEngine ? activeEngine.load() : getRecord();
  }

  // Écriture d'état UNIFIÉE : route vers le dossier actif (commit event-first) ou
  // vers IndexedDB (chemin classique). Utilisée par TOUT ce qui persiste l'état
  // hors `/api/state` — édition d'identité, import de sauvegarde — pour que ces
  // opérations agissent sur le stockage RÉELLEMENT actif (correctifs revue 1b :
  // en mode Dossier, l'identité/l'import doivent viser le dossier, pas un snapshot
  // IndexedDB figé). En mode par défaut, comportement identique à l'ancien `_putState`.
  function putStateUnified(state) {
    return withFolderReady(function () {
      if (activeEngine) {
        return activeEngine.commit(state).then(function (r) { return { revision: r.revision, state: r.state }; });
      }
      return getRecord().then(function (rec) {
        var next = { revision: (rec.revision || 0) + 1, state: state };
        return idbPut(STATE_KEY, next).then(function () { return next; });
      });
    });
  }

  // Active le mode Dossier : ouvre le sélecteur natif, puis :
  //  - dossier VIDE (aucun event) -> y recopie l'état courant de l'appareil (un
  //    commit) pour la continuité (mini-migration ; le point 5 la raffinera) ;
  //  - dossier déjà peuplé -> on charge simplement ce qu'il contient, sans y
  //    toucher.
  function activateFolder() {
    if (!window.PiloteoNext) return Promise.reject(new Error("Le pont de stockage dossier n'a pas chargé (rechargez la page)."));
    if (!window.PiloteoNext.hasFileSystemAccess) return Promise.reject(new Error("Navigateur non compatible (Chrome/Edge/Opera sur ordinateur requis)."));
    return window.PiloteoNext.activateFolderFromPicker().then(function (engine) {
      return engine.load().then(function (loaded) {
        var isEmpty = COLLECTIONS.every(function (c) { return !((loaded.state && loaded.state[c]) || []).length; });
        if (!isEmpty) {
          // Correctif revue 1b (#2) : dossier déjà peuplé -> on l'affiche TEL QUEL,
          // sans fusion. Avertir explicitement que les données de cet appareil ne
          // seront pas affichées ni fusionnées (elles restent sauvegardées en local).
          var msg = "Ce dossier contient déjà des données Pilotéo.\n\n" +
            "En l'activant, ce sont CES données qui s'affichent. Les données de cet " +
            "appareil restent sauvegardées localement mais ne seront ni affichées ni " +
            "fusionnées.\n\nActiver ce dossier ?";
          if (typeof window.confirm === "function" && !window.confirm(msg)) {
            throw new Error("Activation annulée.");
          }
          return null; // charger le dossier tel quel
        }
        // Correctif revue 1b (#3/#4) : recopier le stockage ACTIF (stateRecord) en
        // garantissant >=1 consultant (ensureUsable) pour qu'app.js démarre.
        return stateRecord().then(function (rec) { return engine.commit(ensureUsable(rec.state)); });
      }).then(function () {
        activeEngine = engine;
        folderNeedsPermission = false;
        storageMode = "folder";
        try { localStorage.setItem(STORAGE_MODE_KEY, "folder"); } catch (e) {}
        _folderReady = Promise.resolve(); // reprise déjà faite : court-circuite un ensureFolderReady() ultérieur
        return { folderName: engine.folderName };
      });
    });
  }

  // Revient au stockage « cet appareil » : l'engine dossier est abandonné (les
  // données DU DOSSIER restent intactes, non supprimées) ; `/api/state` repasse
  // sur IndexedDB (son dernier snapshot, celui d'avant activation ou d'une
  // précédente utilisation classique).
  function deactivateFolder() {
    activeEngine = null;
    folderNeedsPermission = false;
    storageMode = null;
    try { localStorage.removeItem(STORAGE_MODE_KEY); } catch (e) {}
    _folderReady = Promise.resolve();
  }

  // Re-demande la permission sur le dossier mémorisé. À appeler depuis un VRAI
  // geste utilisateur (clic) : la File System Access API refuse `requestPermission`
  // hors interaction, ce que le boot silencieux ne peut pas fournir.
  function retryFolderPermission() {
    if (!window.PiloteoNext) return Promise.reject(new Error("Le pont de stockage dossier n'a pas chargé (rechargez la page)."));
    return window.PiloteoNext.resumeFolder().then(function (result) {
      if (result && result.engine) {
        activeEngine = result.engine;
        folderNeedsPermission = false;
        storageMode = "folder";
        try { localStorage.setItem(STORAGE_MODE_KEY, "folder"); } catch (e) {}
        _folderReady = Promise.resolve();
        return { folderName: result.engine.folderName };
      }
      if (result && result.needsPermission) { folderNeedsPermission = true; throw new Error("Autorisation refusée pour ce dossier."); }
      throw new Error("Aucun dossier mémorisé.");
    });
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
      // Point 2c-C2 (ORG_UI_CONTRACT §3) : « aucune donnée » se détecte
      // EXACTEMENT ici — le seul moment où l'on constate qu'aucun état n'a
      // encore été créé pour cet appareil. En mode par défaut (aucun mode de
      // stockage mémorisé), c'est le tout premier démarrage : afficher
      // l'écran d'accueil (best-effort, jamais bloquant pour la suite —
      // l'état seedé ci-dessous est rendu à app.js dans tous les cas, l'écran
      // n'est qu'un overlay visuel).
      if (!storageMode) maybeShowFirstLaunch();
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
    var role = "admin";
    var name = "Mon espace (mode solo)";
    // Point 2c-C2 (ORG_UI_CONTRACT §2) : en mode org, `consultant_id` vient de
    // l'état du dossier org (déjà lu via `stateRecord()` par l'appelant — ce
    // `state` EST celui du dossier org quand `storageMode==="org"`, cf.
    // `stateRecord()`) et `role` du membership de l'identité locale
    // (owner/admin -> "admin", pour qu'app.js applique ses permissions
    // d'affichage ; user -> "user").
    if (storageMode === "org" && activeEngine && activeEngine.membership) {
      var m = activeEngine.membership;
      role = (m.role === "owner" || m.role === "admin") ? "admin" : "user";
      if (m.consultantId && consultants.some(function (c) { return c && c.id === m.consultantId; })) {
        consultantId = m.consultantId;
      }
      name = "Organisation" + (function () {
        try { var n = localStorage.getItem(ORG_NAME_KEY); return n ? " — " + n : ""; } catch (e) { return ""; }
      })();
    }
    return {
      username: "solo",
      name: name,
      role: role,
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
      // Correctif revue 1b (a) : en mode Dossier, l'identité (consultant_id) doit
      // provenir du DOSSIER actif, sinon app.js peut refuser le démarrage
      // (« Compte non rattaché ») en reprenant un dossier peuplé sur un autre
      // appareil. `withFolderReady` garantit la reprise avant lecture ; en mode
      // par défaut, `stateRecord()` vaut `getRecord()` — inchangé.
      return withFolderReady(function () {
        return stateRecord().then(function (rec) { return json(200, { user: soloUser(rec.state) }); });
      });
    }
    if (path === "/api/logout" && method === "POST") {
      return Promise.resolve(json(200, { ok: true }));
    }
    if (path === "/api/state" && method === "GET") {
      // Point 1b : mode par défaut (storageMode !== "folder") -> `withFolderReady`
      // appelle `fn()` immédiatement et `activeEngine` est toujours null ici, donc
      // `stateRecord()` vaut `getRecord()` : chemin STRICTEMENT identique à avant.
      return withFolderReady(function () {
        return stateRecord().then(function (rec) { return json(200, { revision: rec.revision, state: rec.state }); });
      });
    }
    if (path === "/api/state" && method === "PUT") {
      var incoming;
      try { incoming = JSON.parse(body || "{}"); } catch (e) { return Promise.resolve(json(400, { error: "JSON invalide" })); }
      var state = incoming && incoming.state;
      if (!state || typeof state !== "object") return Promise.resolve(json(400, { error: "état manquant" }));
      return withFolderReady(function () {
        if (activeEngine) {
          // Mode Dossier : le store event-first (piloteo-solo-bridge.mjs) rend
          // déjà la forme attendue par app.js ({ok,revision,state,changes,conflicts?}).
          return activeEngine.commit(state).then(function (result) {
            // Correctif revue 1b (#1/#7) : un conflit RÉEL (dossier synchronisé
            // modifié ailleurs) ne doit PAS passer pour un succès à 200 — sinon
            // app.js recharge l'état gagnant sans le dire et la modification locale
            // est perdue en silence. On renvoie 409 avec l'état gagnant rechargé et
            // des libellés de conflit LISIBLES (chaînes, car app.js fait join(", ")),
            // ce qui déclenche la bannière « Une donnée a aussi été modifiée ailleurs ».
            if (result.conflicts && result.conflicts.length) {
              return json(409, {
                revision: result.revision,
                state: result.state,
                conflicts: result.conflicts.map(function (c) {
                  return (c.entityType || "élément") + (c.entityId ? " " + c.entityId : "");
                }),
              });
            }
            return json(200, result);
          }).catch(function (e) { return json(500, { error: "Écriture dans le dossier impossible : " + ((e && e.message) || e) }); });
        }
        // Chemin KV classique ACTUEL, inchangé (mode par défaut, ou dossier indisponible).
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
    // Correctif revue 1b (c) : exporter le stockage ACTIF (dossier si actif),
    // pas un snapshot IndexedDB figé — sinon la sauvegarde serait obsolète/fausse.
    return stateRecord().then(function (rec) {
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
    // Correctif revue 1b (#4) : garantir >=1 consultant, sinon app.js refuse de
    // démarrer (« Compte non rattaché ») et affiche un écran de connexion trompeur.
    state = ensureUsable(state);
    return putStateUnified(state); // vise le stockage actif (dossier si actif)
  }

  // --- Identité de l'administrateur solo (fiche consultant admin de l'état) ---
  function adminConsultantIndex(consultants) {
    var i = consultants.findIndex(function (c) { return c && c.admin; });
    if (i < 0 && consultants.length) i = 0;
    return i;
  }
  function getIdentity() {
    // Correctif revue 1b (b) : lire l'identité depuis le stockage ACTIF.
    return stateRecord().then(function (rec) {
      var cs = (rec.state && rec.state.consultants) || [];
      var i = adminConsultantIndex(cs);
      return i >= 0 ? cs[i] : null;
    });
  }
  function saveIdentity(nom, trigramme) {
    // Correctif revue 1b (b) : éditer l'identité DANS le stockage actif (dossier
    // si actif), pas un snapshot IndexedDB invisible de l'app.
    return stateRecord().then(function (rec) {
      var state = rec.state; var cs = (state.consultants || []).slice();
      var i = adminConsultantIndex(cs);
      if (i < 0) return null;
      var tri = String(trigramme || cs[i].trigramme || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
      cs[i] = Object.assign({}, cs[i], { nom: (nom || cs[i].nom || "Moi"), trigramme: tri || cs[i].trigramme });
      state.consultants = cs;
      return putStateUnified(state);
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
      var hasFsa = window.PiloteoNext ? !!window.PiloteoNext.hasFileSystemAccess : (typeof window.showDirectoryPicker === "function");
      var folderActive = !!activeEngine;

      body.appendChild(modeRow("Cet appareil (navigateur)",
        folderActive ? "Disponible" : "Actif",
        folderActive ? "#5b6b76" : "#137a3f",
        "Vos données sont enregistrées dans ce navigateur (IndexedDB), hors ligne."));

      // Ligne « Un dossier » : actionnable (point 1b). Choisir un dossier /
      // dossier actif affiché / revenir à cet appareil / re-permission.
      var folderBadge, folderColor, folderDesc;
      if (folderActive) {
        folderBadge = "Actif"; folderColor = "#137a3f";
        folderDesc = "Vos données sont enregistrées dans le dossier" +
          (activeEngine.folderName ? " « " + activeEngine.folderName + " »" : " choisi") +
          " — accessible depuis vos autres appareils s'il est synchronisé (OneDrive, SharePoint, Drive…).";
      } else if (folderNeedsPermission) {
        folderBadge = "Accès à renouveler"; folderColor = "#8a6d1f";
        folderDesc = "Un dossier a été choisi précédemment ; ré-autorisez-le pour reprendre où vous en étiez.";
      } else if (hasFsa) {
        folderBadge = "Disponible"; folderColor = "#8a6d1f";
        folderDesc = "Enregistre vos données dans un dossier de votre choix (local, OneDrive, SharePoint, Drive Desktop…) au lieu de ce navigateur.";
      } else {
        folderBadge = "Navigateur non compatible"; folderColor = "#8a3b2f";
        folderDesc = "Nécessite Chrome/Edge/Opera sur ordinateur (File System Access).";
      }
      var folderRow = modeRow("Un dossier (OneDrive, SharePoint, Drive…)", folderBadge, folderColor, folderDesc);
      var folderMsg = el("div", "font-size:12.5px;color:#5b6b76;min-height:16px;margin-top:6px;");
      var folderActions = el("div", "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;");
      if (folderActive) {
        folderActions.appendChild(mkBtn("Revenir à cet appareil", function () {
          deactivateFolder();
          alert("Retour à cet appareil. L'application va se recharger.");
          location.reload();
        }));
      } else if (folderNeedsPermission) {
        folderActions.appendChild(mkBtn("Redonner l'accès", function () {
          folderMsg.textContent = "Demande d'autorisation…";
          retryFolderPermission().then(function () {
            alert("Accès restauré. L'application va se recharger.");
            location.reload();
          }).catch(function (e) { folderMsg.textContent = "Échec : " + ((e && e.message) || e); });
        }, true));
      } else if (hasFsa) {
        folderActions.appendChild(mkBtn("Choisir un dossier", function () {
          folderMsg.textContent = "Sélection du dossier…";
          activateFolder().then(function () {
            alert("Dossier activé. L'application va se recharger.");
            location.reload();
          }).catch(function (e) { folderMsg.textContent = "Échec : " + ((e && e.message) || e); });
        }, true));
      }
      if (folderActions.childNodes.length) folderRow.appendChild(folderActions);
      folderRow.appendChild(folderMsg);
      body.appendChild(folderRow);

      body.appendChild(modeRow("Google Drive", "Bientôt", "#8a6d1f", "Adaptateur prêt ; activation par identifiant OAuth (GOOGLE_CLIENT_ID), après le câblage dossier."));
      body.appendChild(modeRow("Serveur hébergé", "Disponible séparément", "#5b6b76", "Déploiement Docker (voir docs/deployment). Mode centralisé, hors application solo."));

      // Section 3bis — Organisation (point 2c-C2, ORG_UI_CONTRACT §3).
      body.appendChild(sectionTitle("Organisation"));
      if (storageMode === "org" && activeEngine && activeEngine.manifest && activeEngine.membership) {
        var orgEngineRef = activeEngine;      // capturé : évite un décalage si l'utilisateur revient à cet appareil pendant que ce panneau est ouvert
        var orgAdapterRef = activeOrgAdapter;
        var myRole = orgEngineRef.membership.role || "user";
        var roleLabel = myRole === "owner" ? "Propriétaire" : myRole === "admin" ? "Administrateur" : "Membre";
        var orgDisplayName = (function () { try { return localStorage.getItem(ORG_NAME_KEY); } catch (e) { return null; } })() || "Organisation";
        body.appendChild(el("p", "margin:2px 0 10px;font-size:.9rem;",
          "« " + orgDisplayName + " » — vous êtes " + roleLabel + "."));

        var membersBox = el("div", "margin-bottom:10px;");
        body.appendChild(membersBox);
        membersBox.appendChild(el("div", "font-size:12.5px;color:#5b6b76;", "Chargement des membres…"));

        function renderMembers(myMemberId) {
          orgEngineRef.members().then(function (members) {
            membersBox.innerHTML = "";
            members.forEach(function (m) {
              var row = el("div", "display:flex;align-items:center;gap:8px;font-size:.85rem;padding:7px 9px;" +
                "border:1px solid #eef1f3;border-radius:8px;margin-bottom:6px;flex-wrap:wrap;");
              row.appendChild(el("span", "flex:1;min-width:120px;", (m.consultantId || m.memberId) + (m.memberId === myMemberId ? " (vous)" : "")));
              row.appendChild(el("span", "font-size:.72rem;color:#5b6b76;text-transform:uppercase;letter-spacing:.03em;",
                m.role === "owner" ? "Propriétaire" : m.role === "admin" ? "Administrateur" : "Membre"));
              row.appendChild(el("span", "font-size:.7rem;font-weight:700;color:" + (m.status === "revoked" ? "#8a3b2f" : "#137a3f") + ";",
                m.status === "revoked" ? "Révoqué" : "Actif"));
              var canRevoke = (myRole === "owner" || myRole === "admin") && m.status === "active" && m.memberId !== myMemberId;
              if (canRevoke) {
                row.appendChild(mkBtn("Révoquer", function () {
                  var warn = "Révoquer ce membre lui retire immédiatement tout accès à l'organisation.";
                  if (m.role === "owner") {
                    warn = "⚠️ ATTENTION : révoquer un PROPRIÉTAIRE (surtout le propriétaire d'origine) a un " +
                      "RAYON D'EXPLOSION TOTAL sur l'organisation — toute la chaîne de confiance en dépend, " +
                      "cette action peut détruire la confiance de tout l'arbre de membres.";
                  } else if (m.role === "admin") {
                    warn = "⚠️ Révoquer un ADMINISTRATEUR retire aussi l'accès à tous les membres qu'il a " +
                      "invités (ils perdent leur ancre de confiance et devront être ré-invités par une autorité encore valide).";
                  }
                  if (!window.confirm(warn + "\n\nConfirmer la révocation de " + (m.consultantId || m.memberId) + " ?")) return;
                  window.PiloteoOrg.revoke({ engine: orgEngineRef, adapter: orgAdapterRef, memberId: m.memberId }).then(function () {
                    alert("Membre révoqué.");
                    renderMembers(myMemberId);
                  }).catch(function (e) { alert("Révocation impossible : " + ((e && e.message) || e)); });
                }));
              }
              membersBox.appendChild(row);
            });
          }).catch(function (e) { membersBox.innerHTML = ""; membersBox.appendChild(el("div", "font-size:12.5px;color:#8a3b2f;", "Membres indisponibles : " + ((e && e.message) || e))); });
        }
        if (window.PiloteoOrg) {
          window.PiloteoOrg.getOrCreateIdentity().then(function (id) { renderMembers(id.memberId); });
        }

        if (myRole === "owner" || myRole === "admin") {
          var inviteRow = el("div", "display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0;");
          var roleSel = document.createElement("select");
          roleSel.setAttribute("style", "padding:8px 10px;border:1px solid #d5dde2;border-radius:8px;font:inherit;background:#fff;color:#14212b;");
          [["user", "Membre"], ["admin", "Administrateur"]].forEach(function (pair) {
            var o = document.createElement("option"); o.value = pair[0]; o.textContent = pair[1]; roleSel.appendChild(o);
          });
          inviteRow.appendChild(roleSel);
          var inviteMsg = el("div", "font-size:12.5px;color:#5b6b76;flex-basis:100%;min-height:16px;");
          inviteRow.appendChild(mkBtn("Inviter", function () {
            inviteMsg.textContent = "Génération du code…";
            window.PiloteoOrg.invite({ engine: orgEngineRef, adapter: orgAdapterRef, role: roleSel.value, ttlDays: 14 }).then(function (r) {
              inviteMsg.textContent = "Code généré (valable 14 jours) — à transmettre au futur membre :";
              var ta = document.createElement("textarea");
              ta.readOnly = true; ta.value = r.code;
              ta.setAttribute("style", "width:100%;box-sizing:border-box;min-height:70px;margin-top:6px;font-family:ui-monospace,monospace;" +
                "font-size:11px;padding:8px;border:1px solid #d5dde2;border-radius:8px;");
              inviteRow.appendChild(ta);
              ta.addEventListener("click", function () { ta.select(); });
            }).catch(function (e) { inviteMsg.textContent = "Échec : " + ((e && e.message) || e); });
          }, true));
          body.appendChild(inviteRow);
        }

        body.appendChild(mkBtn("Revenir à cet appareil", function () {
          deactivateOrg();
          alert("Retour à cet appareil. L'application va se recharger.");
          location.reload();
        }));
      } else {
        body.appendChild(el("p", "margin:2px 0 8px;font-size:.86rem;color:#5b6b76;",
          "Travaillez à plusieurs sur les mêmes données, dans un dossier partagé (OneDrive, SharePoint, Drive…)."));
        body.appendChild(mkBtn("Créer / rejoindre une organisation", function () { close(); renderWelcomeScreen(); }));
      }

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
    // Route vers le stockage ACTIF (dossier si actif), cf. correctifs revue 1b.
    _putState: putStateUnified,
    _stateKey: STATE_KEY,
    _collections: COLLECTIONS,
    // Point 1b : introspection/actions du mode Dossier, exposées pour les tests
    // et un usage avancé éventuel (le panneau Réglages les utilise déjà en interne).
    _storageMode: function () { return storageMode; },
    _hasActiveFolderEngine: function () { return !!activeEngine; },
    _activateFolder: activateFolder,
    _deactivateFolder: deactivateFolder,
    _retryFolderPermission: retryFolderPermission,
    // Hook de TEST : pose un engine (ex: construit via PiloteoNext.__engineFromHandle
    // sur un faux dossier) comme moteur actif, SANS passer par le sélecteur natif
    // (non automatisable). Permet aux e2e de prouver que /api/me, la sauvegarde et
    // l'identité visent bien le dossier actif (correctifs revue 1b a/b/c).
    _useEngineForTest: function (engine) {
      activeEngine = engine; storageMode = "folder"; _folderReady = Promise.resolve();
    },
    // Point 2c-C2 : hook de TEST symétrique pour le mode Organisation — pose
    // un org engine RÉEL (construit via `window.PiloteoOrg.__openOrgEngineFromHandle`
    // sur un faux dossier) comme moteur actif, avec son `adapter` (requis par
    // `invite`/`revoke`), SANS passer par le sélecteur natif. Permet aux e2e
    // de prouver que `/api/me` (role admin/user selon membership) et
    // `/api/state` (409 sur commit refusé par la policy) ciblent bien
    // l'organisation active.
    _useOrgEngineForTest: function (engine, adapter) {
      activeEngine = engine; activeOrgAdapter = adapter || null; storageMode = "org"; _orgReady = Promise.resolve();
    },
    _deactivateOrg: deactivateOrg,
    _orgStorageMode: function () { return storageMode === "org"; },
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
