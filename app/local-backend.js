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

  // --- Point 3 (docs/next/AUTH_SESSION_CONTRACT.md §1) : référence d'horloge
  // recoupée, capturée ICI, au tout premier instant d'exécution de ce script
  // — donc AVANT qu'un script exécuté plus tard dans la page (console
  // DevTools, extension) ne puisse avoir monkey-patché `Date.now`. Durcissement
  // (défense en profondeur, PAS une barrière — cf. modèle de menace §0) :
  // `monotonicNow()` dérive "maintenant" de `performance.now()` (horloge
  // monotone, non affectée par un `Date.now = ...` ultérieur) recalée sur
  // cette référence murale honnête, pour recouper l'anti-force-brute
  // (`attemptUnlock`) sans dépendre uniquement de l'horloge murale mutable.
  var _clockRefWall = Date.now();
  var _clockRefMono = (typeof performance !== "undefined" && typeof performance.now === "function") ? performance.now() : null;
  function monotonicNow() {
    if (_clockRefMono === null) return Date.now(); // performance.now indisponible : repli sur l'horloge murale
    return _clockRefWall + (performance.now() - _clockRefMono);
  }

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
  // Clé d'identité par collection (durcissement contrariant Point 5,
  // MIGRATION_MODE_CONTRACT.md) : même convention que
  // `src/events/event-schema.js#ENTITY_TYPES` (`bordereauxFrais` s'identifie
  // par `numero`, toutes les autres par `id`). Dupliquée ICI en connaissance
  // de cause : `local-backend.js` est un script classique (aucun import ES) ;
  // ce mapping est un FAIT STABLE du domaine (server.py COLLECTION_KEYS), pas
  // une logique métier susceptible de diverger de `event-schema.js`.
  var COLLECTION_IDENTITY_KEY = {
    consultants: "id", organisations: "id", affaires: "id", methodes: "id",
    typesTerritoire: "id", domainesIntervention: "id", categoriesFrais: "id",
    missions: "id", factures: "id", saisies: "id", bordereauxFrais: "numero",
    notesFrais: "id"
  };
  // Détecte les identités DUPLIQUÉES (après coercion `String()`, comme
  // `snapshotToEventsDiff`) au sein d'une même collection d'un état — repro
  // contrariant : un `.piloteobackup` importé peut porter deux entités
  // DISTINCTES avec la même identité (fichier forgé/corrompu, ou fusion
  // manuelle malheureuse) ; sans ce garde-fou, la collision s'installe
  // silencieusement dans IndexedDB et n'est démasquée QUE plus tard, au
  // premier diff événementiel (activation Dossier/Organisation) — trop tard,
  // une entité a déjà disparu de l'écran sans aucun message. Renvoie la liste
  // des collisions `[{entityType, id, count}]` (vide si aucune).
  function findDuplicateIdentities(state) {
    var dups = [];
    COLLECTIONS.forEach(function (entityType) {
      var key = COLLECTION_IDENTITY_KEY[entityType];
      var seen = {};
      (Array.isArray(state[entityType]) ? state[entityType] : []).forEach(function (item) {
        if (!item || item[key] === undefined || item[key] === null || item[key] === "") return;
        var id = String(item[key]);
        seen[id] = (seen[id] || 0) + 1;
      });
      Object.keys(seen).forEach(function (id) {
        if (seen[id] > 1) dups.push({ entityType: entityType, id: id, count: seen[id] });
      });
    });
    return dups;
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
  // --- Point 3 (docs/next/AUTH_SESSION_CONTRACT.md) : session / verrou d'appareil --
  var SESSION_KEY = "piloteo_session"; // IndexedDB (store "kv", même base piloteo-solo) : {status,pin,failedAttempts,lockedUntil,lockOnOpen}
  var sessionState = null;             // cache en mémoire du record ci-dessus, une fois chargé (ensureSessionReady)
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

  // --- Point 3 (docs/next/AUTH_SESSION_CONTRACT.md) : session / verrou d'appareil --
  //
  // Symétrique aux `waitForPiloteoNext`/`waitForPiloteoOrg` ci-dessus :
  // `piloteo-auth-bridge.mjs` (module ES, différé de fait) pose
  // `window.PiloteoAuth` — `local-backend.js` ne suppose jamais sa présence
  // au chargement, il le teste à l'usage (poll court).
  function waitForPiloteoAuth(timeoutMs) {
    return new Promise(function (resolve) {
      var waited = 0, step = 50;
      (function poll() {
        if (window.PiloteoAuth) { resolve(window.PiloteoAuth); return; }
        waited += step;
        if (waited >= timeoutMs) { resolve(null); return; }
        setTimeout(poll, step);
      })();
    });
  }

  function loadSessionRecord() { return idbGet(SESSION_KEY); }
  function persistSession(rec) { return idbPut(SESSION_KEY, rec); }

  // Portillon /api : `_sessionGate` est une promesse qui ne résout QUE
  // lorsque la session est `active` (contrat §2 : « la promesse ne résout
  // qu'après unlock »). `withSessionActive` la relit à CHAQUE appel (pas de
  // capture figée) pour refléter un verrouillage survenu depuis (déconnexion,
  // verrouillage manuel) — voir `closeGate`/`openGate`.
  var _sessionGate = null;
  var _sessionGateResolve = null;
  function openGate() {
    if (_sessionGateResolve) { _sessionGateResolve(); _sessionGateResolve = null; }
    _sessionGate = Promise.resolve();
  }
  function closeGate() {
    _sessionGate = new Promise(function (resolve) { _sessionGateResolve = resolve; });
  }

  // FAIL-CLOSED (contrat §0/§2, révision post-revue adverse — FAILLE 2 du
  // round de correction) : vrai quand un PIN protège l'accès mais que
  // `PiloteoAuth` n'a PAS pu être vérifié (chargement bloqué/hors ligne sans
  // précache). Tant que c'est vrai, `withSessionActive` NE laisse JAMAIS
  // passer `fn` — jamais un fail-OPEN, même temporaire. Sans PIN défini, rien
  // à protéger : ce drapeau reste toujours faux (voir `ensureSessionReady`).
  var _authUnavailable = false;

  // Reprise/boot de la session (mémoïsée : un seul chargement par page, comme
  // `ensureFolderReady`/`ensureOrgReady`). Calcule l'état par défaut SANS
  // dépendre de `PiloteoAuth` (cas courant, aucun PIN : reste frictionless
  // même si le module tarde) ; n'a besoin du module que pour vérifier un PIN
  // (déverrouillage) ou verrouiller au boot si un PIN impose l'overlay.
  var _sessionReady = null;
  function ensureSessionReady() {
    if (_sessionReady) return _sessionReady;
    _sessionReady = Promise.all([waitForPiloteoAuth(3000), loadSessionRecord()]).then(function (r) {
      var PA = r[0];
      var rec = r[1];
      if (!rec || typeof rec !== "object" || !rec.status) {
        rec = { status: "active", pin: null, failedAttempts: 0, lockedUntil: 0, lockOnOpen: false };
      }
      if (!PA) {
        if (rec.pin) {
          // FAIL-CLOSED : le module d'auth n'a pas chargé alors qu'un PIN
          // protège l'accès -> IMPOSSIBLE de vérifier ce PIN -> on RESTE
          // verrouillé, on N'OUVRE JAMAIS `/api` par défaut. Ouvrir ici serait
          // un contresens de sécurité (repro contrariant : bloquer
          // `piloteo-auth-bridge.mjs` suffisait sinon à élider tout le
          // verrou). `sw-solo.js` précache ce module + `src/auth/session.js`
          // pour que le cas hors-ligne LÉGITIME (utilisateur de bonne foi,
          // déjà venu une fois) ne tombe pas dans cette branche.
          _authUnavailable = true;
          sessionState = Object.assign({}, rec, { status: "locked" });
          closeGate();
          renderAuthUnavailableOverlay();
          return;
        }
        // Sans PIN : rien à protéger, aucune dégradation de sécurité possible
        // — même principe que les modes Dossier/Organisation (fail-open
        // inoffensif quand il n'y a rien à ouvrir).
        _authUnavailable = false;
        sessionState = Object.assign({}, rec, { status: "active" });
        openGate();
        return;
      }
      _authUnavailable = false;
      var mustLock = !!(rec.pin && (rec.lockOnOpen || rec.status !== "active"));
      if (mustLock) {
        sessionState = PA.lock(rec);
        persistSession(sessionState);
        closeGate();
        renderLockOverlay();
      } else {
        sessionState = Object.assign({}, rec, { status: "active" });
        persistSession(sessionState);
        openGate();
      }
    });
    return _sessionReady;
  }

  // Gate `/api/me`, `POST /api/login`, `GET|PUT /api/state` (contrat §3) sur
  // `active` : `fn` n'est appelée qu'une fois la session chargée ET active
  // (déverrouillée). Ne touche jamais au routage Dossier/Organisation
  // existant (`withFolderReady`), qui reste composé PAR-DESSUS.
  // FAIL-CLOSED : si `_authUnavailable` (PIN défini, module de vérification
  // injoignable), `fn` n'est JAMAIS appelée — on répond explicitement 503
  // (jamais de hang silencieux ni de données rendues) plutôt que d'attendre
  // indéfiniment un portillon qui ne peut pas s'ouvrir tout seul.
  function withSessionActive(fn) {
    return ensureSessionReady().then(function () {
      if (_authUnavailable) {
        return json(503, {
          error: "Verrou d'appareil indisponible : impossible de vérifier le code PIN (module non chargé — hors ligne ou connexion interrompue). Rechargez la page.",
        });
      }
      return _sessionGate.then(fn);
    });
  }

  // Tentative de déverrouillage (overlay + hook de test). Sans PIN défini,
  // déverrouillage direct (verrou minimal, non protégé). Avec PIN : anti-
  // force-brute recoupé sur deux horloges (`canAttemptCrossChecked` — §1,
  // durcissement défense en profondeur, PAS une barrière : cf. modèle de
  // menace §0) puis vérification à temps constant (`verifyPin`) — succès/
  // échec persistés via `registerSuccess`/`registerFailure`.
  function attemptUnlock(pin) {
    var PA = window.PiloteoAuth;
    var wallNow = Date.now();
    var monoNow = monotonicNow();
    if (!sessionState || !sessionState.pin) {
      sessionState = Object.assign({}, sessionState || {}, { status: "active", failedAttempts: 0, lockedUntil: 0 });
      persistSession(sessionState);
      openGate();
      return Promise.resolve({ ok: true });
    }
    if (!PA) return Promise.resolve({ ok: false, error: "Module de verrouillage indisponible (rechargez la page)." });
    var gate = PA.canAttemptCrossChecked(sessionState, wallNow, monoNow);
    if (!gate.allowed) return Promise.resolve({ ok: false, waitMs: gate.waitMs });
    // `verifyPin` REJETTE (throw) un enregistrement `iterations<210000` (un
    // `piloteo_session` forgé ne doit pas imposer un hash affaibli) : traité
    // uniformément comme "PIN invalide" (échec enregistré), jamais comme une
    // exception qui remonterait à l'UI ou, pire, comme un succès silencieux.
    return PA.verifyPin(pin, sessionState.pin).catch(function () { return false; }).then(function (valid) {
      if (valid) {
        sessionState = PA.registerSuccess(sessionState);
        persistSession(sessionState);
        openGate();
        return { ok: true };
      }
      // Horodate l'échec sur la lecture d'horloge la plus CONSERVATRICE (la
      // plus petite des deux) : si `Date.now()` a été artificiellement avancé
      // (monkey-patch), c'est l'estimation monotone — honnête — qui sert de
      // base à `lockedUntil`, jamais la murale gonflée (qui produirait un
      // `lockedUntil` sans rapport avec le temps réel écoulé).
      var failureNow = Math.min(wallNow, monoNow);
      sessionState = PA.registerFailure(sessionState, failureNow);
      persistSession(sessionState);
      var g2 = PA.canAttemptCrossChecked(sessionState, Date.now(), monotonicNow());
      return { ok: false, waitMs: g2.allowed ? 0 : g2.waitMs };
    });
  }

  // Verrouillage RÉEL (remplace le lock minimal du §2.4 de l'audit) : ferme le
  // portillon `/api` synchroneement (avant même que la persistance IndexedDB
  // ne soit terminée) et affiche l'overlay. Utilisé par « Verrouiller
  // maintenant » (Réglages), `POST /api/logout`, et « Se déconnecter » (org).
  function enterLocked() {
    var PA = window.PiloteoAuth;
    var base = sessionState || { status: "active", pin: null, failedAttempts: 0, lockedUntil: 0, lockOnOpen: false };
    sessionState = PA ? PA.lock(base) : Object.assign({}, base, { status: "locked" });
    closeGate();
    persistSession(sessionState);
    // Edge case défensif (non atteignable par l'UI normale — l'overlay
    // d'erreur couvre déjà tout l'écran dans ce cas) : si le module d'auth
    // est toujours injoignable, ne PAS afficher l'écran de saisie normal.
    if (_authUnavailable) { renderAuthUnavailableOverlay(); return; }
    renderLockOverlay();
  }

  // Ouvre le sélecteur natif puis crée l'organisation (writeManifest +
  // writeMemberRecord côté pont). `name` : nom d'affichage de l'organisation —
  // le manifeste (racine de confiance, lot 2c-B/2c-C1, non modifié ici) ne le
  // porte pas ; on le mémorise donc localement (best-effort, `ORG_NAME_KEY`)
  // pour l'affichage Réglages sur CET appareil (un membre qui rejoint via
  // `joinOrg` n'a pas ce nom : repli générique "Organisation", cf.
  // buildReglages ci-dessous).
  //
  // Point 5 (docs/next/MIGRATION_MODE_CONTRACT.md) : SI l'état solo de cet
  // appareil est non vide, migre-le vers l'organisation fraîchement créée
  // (sauvegarde -> seed -> vérification, `runGuardedMigration`) AVANT
  // d'activer le mode org (`window.PiloteoOrg.activateOrgStorageMode`,
  // `piloteo_storage_mode`). Un échec (cible improbablement non vide, ou
  // vérification finale en échec) ne bascule RIEN : le mode org reste
  // inactif, cet appareil (solo) reste actif, ses données sont intactes.
  function activateCreateOrg(name) {
    if (!window.PiloteoOrg) return Promise.reject(new Error("Le pont Organisation n'a pas chargé (rechargez la page)."));
    if (!window.PiloteoOrg.hasFileSystemAccess) return Promise.reject(new Error("Navigateur non compatible (Chrome/Edge/Opera sur ordinateur requis)."));
    var pickedHandle = null;
    return window.PiloteoOrg.pickDirectory().then(function (handle) {
      pickedHandle = handle;
      return stateRecord().then(function (rec) {
        var solo = ensureUsable(rec.state);
        var cs = solo.consultants || [];
        var i = adminConsultantIndex(cs);
        var consultantId = i >= 0 ? cs[i].id : null;
        var targetLabel = "l'organisation" + (name ? " « " + name + " »" : " créée");
        return window.PiloteoOrg.createOrg({ handle: handle, name: name, consultantId: consultantId }).then(function (result) {
          // Point 5 §3 : pas UI explicite complet (message+compteur+sauvegarde
          // -> progression -> résultat). Cas `target-not-empty` (défensif :
          // ne devrait jamais arriver pour une org fraîchement créée, la
          // genèse étant write-once) -> message DÉDIÉ (pas de « ouvrir tel
          // quel » pour une organisation, contrairement au Dossier) puis refus.
          return decideAndRunMigration(result.engine, solo, targetLabel).then(function (migration) {
            return { result: result, migration: migration };
          }).catch(function (e) {
            // Jamais de mode org actif si la migration n'a pas été
            // vérifiée (contrat §1/§2 point 4) : l'organisation vient
            // d'être créée (genèse write-once) mais n'est PAS activée sur
            // cet appareil ; les données de cet appareil restent intactes.
            throw new Error(((e && e.message) || "Migration impossible.") +
              " Retour à cet appareil : vos données ne sont pas perdues.");
          });
        });
      });
    }).then(function (r) {
      var result = r.result, migration = r.migration;
      return window.PiloteoOrg.activateOrgStorageMode(pickedHandle).then(function () {
        activeEngine = result.engine;
        activeOrgAdapter = result.adapter || null;
        orgNeedsPermission = false;
        storageMode = "org";
        try { localStorage.setItem(STORAGE_MODE_KEY, "org"); } catch (e) {}
        try { if (name) localStorage.setItem(ORG_NAME_KEY, name); } catch (e) {}
        _orgReady = Promise.resolve();
        _lastMigrationResult = migration;
        return Object.assign({}, result, { migration: migration });
      });
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

  // --- Point 5 (docs/next/MIGRATION_MODE_CONTRACT.md) : migration à la bascule
  // de mode -------------------------------------------------------------------
  //
  // Attend `window.PiloteoMigration` (posé par `piloteo-migration-bridge.mjs`,
  // module ES différé de fait), même garde-fou que les autres ponts : jamais
  // supposé présent au chargement.
  function waitForPiloteoMigration(timeoutMs) {
    return new Promise(function (resolve) {
      var waited = 0, step = 50;
      (function poll() {
        if (window.PiloteoMigration) { resolve(window.PiloteoMigration); return; }
        waited += step;
        if (waited >= timeoutMs) { resolve(null); return; }
        setTimeout(poll, step);
      })();
    });
  }

  // Compteur de sauvegardes déclenchées AVANT une écriture dans une cible
  // (contrat §2 point 1) — hook de TEST (§4 scénario 7 : « une sauvegarde a
  // été produite »), jamais réinitialisé (cumulatif sur la durée de la page).
  var _preMigrationBackupCount = 0;
  // Compteur d'AVERTISSEMENTS d'échec de sauvegarde (contrat §2 point 1 :
  // « tracer que l'utilisateur a vu l'avertissement ») — incrémenté CHAQUE
  // fois que la confirmation « sauvegarde échouée, continuer quand même ? »
  // est réellement affichée à l'utilisateur (que sa réponse soit oui ou non).
  var _backupWarningShownCount = 0;
  // Dernier résultat de migration (§2), pour introspection e2e — jamais lu par
  // la logique métier elle-même (uniquement un hook `window.PiloteoLocal`).
  var _lastMigrationResult = null;

  var TARGET_NOT_EMPTY_MESSAGE = "Cet emplacement contient déjà un espace Pilotéo (données d'une autre " +
    "organisation ou d'un autre dossier). Choisissez un dossier vide, ou ouvrez l'existant sans migrer.";

  // --- Pas UI explicite de migration (contrat §3) : overlay modal minimal,
  // réutilisé pour les TROIS phases (message initial + compteur, progression,
  // résultat) — un seul élément DOM (`#piloteo-migration-step`), construit une
  // fois puis réutilisé/retexté à chaque étape (jamais recréé en cours de
  // route, pour rester une transition fluide côté utilisateur). Déclenché
  // depuis les DEUX chemins d'activation (écran d'accueil ET Réglages), qui
  // appellent tous deux `decideAndRunMigration` ci-dessous — aucune UI dupliquée.
  var _migrationStepEl = null;
  function ensureMigrationStepEl() {
    if (_migrationStepEl && document.body && document.body.contains(_migrationStepEl)) return _migrationStepEl;
    var ov = el("div", "position:fixed;inset:0;z-index:2147483005;background:rgba(8,14,18,.65);" +
      "display:flex;align-items:center;justify-content:center;padding:20px;" +
      "font:400 14px/1.45 system-ui,-apple-system,sans-serif;");
    ov.id = "piloteo-migration-step";
    var card = el("div", "width:min(480px,94vw);background:#fff;color:#14212b;border-radius:14px;" +
      "box-shadow:0 20px 60px rgba(0,0,0,.35);padding:22px;");
    ov.appendChild(card);
    card.appendChild(el("div", "font-size:15px;font-weight:700;margin-bottom:10px;", "Migration de vos données"));
    var msg = el("div", "font-size:13.5px;line-height:1.5;margin-bottom:12px;");
    msg.id = "piloteo-migration-message";
    card.appendChild(msg);
    var progress = el("div", "font-size:13px;color:#5b6b76;margin-bottom:10px;display:flex;align-items:center;gap:8px;");
    progress.id = "piloteo-migration-progress";
    progress.hidden = true;
    progress.setAttribute("role", "status");
    card.appendChild(progress);
    var result = el("div", "font-size:13.5px;line-height:1.5;margin-bottom:14px;font-weight:600;");
    result.id = "piloteo-migration-result";
    result.hidden = true;
    result.setAttribute("role", "status");
    card.appendChild(result);
    var actions = el("div", "display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;");
    actions.id = "piloteo-migration-actions";
    card.appendChild(actions);
    document.body.appendChild(ov);
    _migrationStepEl = ov;
    return ov;
  }
  function migrationStepParts() {
    var ov = ensureMigrationStepEl();
    return {
      msg: ov.querySelector("#piloteo-migration-message"),
      progress: ov.querySelector("#piloteo-migration-progress"),
      result: ov.querySelector("#piloteo-migration-result"),
      actions: ov.querySelector("#piloteo-migration-actions"),
    };
  }
  function closeMigrationStep() {
    if (_migrationStepEl) { _migrationStepEl.remove(); _migrationStepEl = null; }
  }

  // Étape 1 (contrat §3) : message explicite AVANT tout appel à
  // `runGuardedMigration`, avec le compte d'éléments et la cible, ET
  // l'annonce de la sauvegarde préalable. Résout `true` (Continuer) ou
  // `false` (Annuler — la migration n'a alors JAMAIS commencé).
  function showMigrationIntroStep(counts, targetLabel) {
    return new Promise(function (resolve) {
      var p = migrationStepParts();
      var n = (counts && counts.total) || 0;
      p.msg.textContent = "Vos données de cet appareil (" + n + " élément" + (n > 1 ? "s" : "") +
        ") vont être copiées dans " + targetLabel + " sous forme de journal. " +
        "Une sauvegarde de sécurité (.piloteobackup) va d'abord être créée.";
      p.progress.hidden = true;
      p.result.hidden = true;
      p.actions.innerHTML = "";
      p.actions.appendChild(mkBtn("Annuler", function () { resolve(false); }));
      p.actions.appendChild(mkBtn("Continuer", function () { p.actions.innerHTML = ""; resolve(true); }, true));
    });
  }

  // Étape 2 : indicateur de progression textuel (pendant sauvegarde puis
  // seed+vérification) — pas de barre graphique, juste un texte mis à jour,
  // suffisant pour l'exigence du contrat (« barre/état de progression »).
  function updateMigrationProgress(text) {
    var p = migrationStepParts();
    p.progress.hidden = false;
    p.progress.textContent = text;
  }

  // Sauvegarde préalable ÉCHOUÉE réellement (contrat §2 point 1) : jamais
  // silencieux — demande une confirmation EXPLICITE avant de continuer SANS
  // sauvegarde, tracée dans `_backupWarningShownCount` (vue, quelle que soit
  // la réponse). Résout `true` (continuer quand même) ou `false` (annuler).
  function confirmBackupFailure() {
    _backupWarningShownCount += 1;
    return new Promise(function (resolve) {
      var p = migrationStepParts();
      p.progress.hidden = true;
      p.result.hidden = false;
      p.result.style.color = "#8a6d1f";
      p.result.textContent = "La sauvegarde automatique (.piloteobackup) a échoué. Continuer SANS sauvegarde préalable ?";
      p.actions.innerHTML = "";
      p.actions.appendChild(mkBtn("Annuler la migration", function () { resolve(false); }));
      p.actions.appendChild(mkBtn("Continuer sans sauvegarde", function () { p.result.hidden = true; resolve(true); }, true));
    });
  }

  // Étape 3 : résultat dédié — succès (bascule confirmée) ou échec (« rien
  // n'a changé »/raison). Résout une fois l'utilisateur a cliqué « Fermer »
  // (déterministe pour les e2e, jamais un auto-dismiss silencieux qu'un test
  // pourrait manquer).
  function renderMigrationResultAndWait(migration, targetLabel) {
    return new Promise(function (resolve) {
      var p = migrationStepParts();
      p.progress.hidden = true;
      p.result.hidden = false;
      p.actions.innerHTML = "";
      if (migration.failed || migration.blocked) {
        p.result.style.color = "#8a3b2f";
        p.result.textContent = "Rien n'a changé, vos données locales sont intactes. " + (migration.error || "Migration impossible.");
      } else {
        p.result.style.color = "#137a3f";
        p.result.textContent = "Migration réussie : vos données sont maintenant dans " + targetLabel + ".";
      }
      p.actions.appendChild(mkBtn("Fermer", function () { closeMigrationStep(); resolve(); }, true));
    });
  }

  // Seed + vérification (contrat §2 points 1/3/4), AVEC hooks optionnels de
  // progression/confirmation de sauvegarde échouée. `plan` déjà connu (évite
  // un second `engine.load()`/`planMigration` redondant à l'appelant).
  // Sauvegarde préalable OBLIGATOIRE : un échec RÉEL de `exportBackup()` sans
  // confirmation explicite de continuer (`opts.onBackupFailure` absent, ou
  // renvoyant `false`) fait ÉCHOUER la migration (jamais un « best-effort »
  // silencieux — contrat §2 point 1 : « ne pas continuer sans que la
  // sauvegarde soit faite, au minimum la proposer »).
  function performSeedMigration(engine, soloSnapshot, plan, opts) {
    opts = opts || {};
    var onProgress = typeof opts.onProgress === "function" ? opts.onProgress : function () {};
    var onBackupFailure = typeof opts.onBackupFailure === "function" ? opts.onBackupFailure : function () { return Promise.resolve(false); };
    return waitForPiloteoMigration(4000).then(function (PM) {
      onProgress("Sauvegarde de sécurité en cours…");
      return Promise.resolve()
        .then(function () { return exportBackup(); })
        .then(function () { _preMigrationBackupCount += 1; return true; })
        .catch(function () {
          return Promise.resolve(onBackupFailure()).then(function (proceedAnyway) {
            if (!proceedAnyway) {
              var e = new Error("La sauvegarde de sécurité a échoué et la migration a été annulée avant toute écriture (aucune sauvegarde, aucune migration).");
              e._backupAborted = true;
              throw e;
            }
            return false; // l'utilisateur a explicitement choisi de continuer sans sauvegarde.
          });
        })
        .then(function (backedUp) {
          onProgress("Copie de vos données et vérification en cours…");
          return PM.migrateSoloIntoEngine({ soloSnapshot: soloSnapshot, engine: engine }).then(function (result) {
            return {
              failed: !result.ok,
              blocked: false,
              migrated: result.ok,
              kind: result.kind,
              counts: result.counts,
              error: result.error,
              diff: result.diff,
              rejected: result.rejected,
              conflicts: result.conflicts,
              backedUp: backedUp,
            };
          });
        })
        .catch(function (err) {
          if (err && err._backupAborted) {
            return { failed: true, blocked: false, migrated: false, kind: "seed", counts: plan.counts, error: err.message, backedUp: false };
          }
          throw err;
        });
    });
  }

  // Orchestration COMPLÈTE et engine-agnostique (folder/org/drive : n'importe
  // quel `{load, commit}`) d'une migration solo -> cible, contrat §2 points
  // 1-4 — SANS UI (hook de TEST bas niveau, cf. `window.PiloteoLocal._runGuardedMigration`,
  // et utilisée telle quelle par `decideAndRunMigration` pour le cas
  // "nothing-to-migrate"/"target-not-empty"). Renvoie `{failed, blocked,
  // migrated, kind, counts, error?, backedUp}` — ne bascule JAMAIS
  // `piloteo_storage_mode` (responsabilité de l'appelant, UNIQUEMENT si
  // `!failed && !blocked`). Sans confirmation utilisateur possible ici (pas
  // d'UI), un échec de sauvegarde fait échouer la migration par défaut
  // (`performSeedMigration` sans `onBackupFailure` => jamais un
  // best-effort silencieux qui migrerait sans filet de sécurité).
  function runGuardedMigration(engine, soloSnapshot) {
    return waitForPiloteoMigration(4000).then(function (PM) {
      if (!PM) {
        return { failed: true, blocked: false, migrated: false, kind: null,
          error: "Module de migration indisponible (rechargez la page). Aucune écriture n'a eu lieu, vos données de cet appareil sont intactes." };
      }
      return engine.load().then(function (loaded) {
        var plan = PM.planMigration({ soloSnapshot: soloSnapshot, targetExisting: loaded.state });
        if (plan.kind === "nothing-to-migrate") {
          return { failed: false, blocked: false, migrated: false, kind: plan.kind, counts: plan.counts };
        }
        if (plan.kind === "target-not-empty") {
          return { failed: false, blocked: true, migrated: false, kind: plan.kind, counts: plan.counts, error: TARGET_NOT_EMPTY_MESSAGE };
        }
        return performSeedMigration(engine, soloSnapshot, plan);
      });
    });
  }

  // Orchestrateur UI (contrat §3) : point d'entrée UNIQUE pour les DEUX
  // chemins d'activation (écran d'accueil « Créer une organisation »/
  // « Choisir un dossier » ET Réglages) qui migrent l'état solo. Décide
  // (`planMigration`) puis :
  //  - "nothing-to-migrate" : aucune UI, `hooks.onNothingToMigrate` (ou
  //    résout directement) ;
  //  - "target-not-empty" : `hooks.onTargetNotEmpty(blockedResult)` — permet à
  //    chaque appelant sa propre UX (Dossier : confirmer l'ouverture TELLE
  //    QUELLE, comme avant ; Organisation : message dédié + refus, cf.
  //    `renderMigrationResultAndWait`) ;
  //  - "seed" : pas UI explicite complet (intro+compteur+cible+sauvegarde
  //    annoncée -> Continuer/Annuler -> progression -> résultat dédié
  //    Fermer) via `showMigrationIntroStep`/`performSeedMigration`/
  //    `renderMigrationResultAndWait`.
  // Renvoie le `migration` résultant si `!failed`, sinon LÈVE (avec
  // `migration.error`) — l'appelant n'a plus qu'à `.then(activer)`/`.catch(afficher)`.
  function decideAndRunMigration(engine, soloSnapshot, targetLabel, hooks) {
    hooks = hooks || {};
    return waitForPiloteoMigration(4000).then(function (PM) {
      if (!PM) {
        var offlineResult = { failed: true, blocked: false, migrated: false, kind: null,
          error: "Module de migration indisponible (rechargez la page). Aucune écriture n'a eu lieu, vos données de cet appareil sont intactes." };
        throw new Error(offlineResult.error);
      }
      return engine.load().then(function (loaded) {
        var plan = PM.planMigration({ soloSnapshot: soloSnapshot, targetExisting: loaded.state });

        if (plan.kind === "nothing-to-migrate") {
          var nothingResult = { failed: false, blocked: false, migrated: false, kind: plan.kind, counts: plan.counts };
          return nothingResult;
        }

        if (plan.kind === "target-not-empty") {
          var blockedResult = { failed: false, blocked: true, migrated: false, kind: plan.kind, counts: plan.counts, error: TARGET_NOT_EMPTY_MESSAGE };
          if (typeof hooks.onTargetNotEmpty === "function") {
            return hooks.onTargetNotEmpty(blockedResult);
          }
          return renderMigrationResultAndWait(blockedResult, targetLabel).then(function () {
            throw new Error(blockedResult.error);
          });
        }

        // "seed" : pas UI explicite complet.
        return showMigrationIntroStep(plan.counts, targetLabel).then(function (proceed) {
          if (!proceed) {
            closeMigrationStep();
            throw new Error("Migration annulée : vos données de cet appareil restent actives, rien n'a changé.");
          }
          return performSeedMigration(engine, soloSnapshot, plan, {
            onProgress: updateMigrationProgress,
            onBackupFailure: confirmBackupFailure,
          }).then(function (migration) {
            return renderMigrationResultAndWait(migration, targetLabel).then(function () {
              if (migration.failed) throw new Error(migration.error || "Migration impossible.");
              return migration;
            });
          });
        });
      });
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

  // Active le mode Dossier : ouvre le sélecteur natif, puis (Point 5,
  // MIGRATION_MODE_CONTRACT.md, remplace l'ancienne « mini-migration » non
  // vérifiée du point 1b) :
  //  - dossier déjà peuplé -> `runGuardedMigration` détecte `"target-not-empty"` :
  //    on demande confirmation (comme avant) puis on l'affiche TEL QUEL, sans
  //    fusion ni écriture — les données de cet appareil restent sauvegardées
  //    localement, jamais affichées ni fusionnées ;
  //  - dossier vide + solo non vide -> sauvegarde `.piloteobackup` OBLIGATOIRE,
  //    seed vérifié (`verifyRoundTrip` + rechargement réel de la cible) ; la
  //    bascule de `piloteo_storage_mode` n'a lieu QUE si la vérification
  //    réussit — sinon on reste sur cet appareil, données intactes ;
  //  - dossier vide + solo vide -> rien à migrer (`"nothing-to-migrate"`),
  //    activation directe.
  function activateFolder() {
    if (!window.PiloteoNext) return Promise.reject(new Error("Le pont de stockage dossier n'a pas chargé (rechargez la page)."));
    if (!window.PiloteoNext.hasFileSystemAccess) return Promise.reject(new Error("Navigateur non compatible (Chrome/Edge/Opera sur ordinateur requis)."));
    return window.PiloteoNext.activateFolderFromPicker().then(function (engine) {
      return stateRecord().then(function (rec) {
        var solo = ensureUsable(rec.state);
        var targetLabel = "le dossier" + (engine.folderName ? " « " + engine.folderName + " »" : " choisi");
        return decideAndRunMigration(engine, solo, targetLabel, {
          // Correctif revue 1b (#2), conservé TEL QUEL (comportement propre au
          // Dossier, différent de l'Organisation) : dossier déjà peuplé -> on
          // l'affiche TEL QUEL, sans fusion, sur confirmation explicite —
          // jamais le pas UI générique de refus (pas de sauvegarde/seed dans
          // ce cas : rien n'est écrit dans le dossier).
          onTargetNotEmpty: function (blockedResult) {
            var msg = "Ce dossier contient déjà des données Pilotéo.\n\n" +
              "En l'activant, ce sont CES données qui s'affichent. Les données de cet " +
              "appareil restent sauvegardées localement mais ne seront ni affichées ni " +
              "fusionnées.\n\nActiver ce dossier ?";
            if (typeof window.confirm === "function" && !window.confirm(msg)) {
              throw new Error("Activation annulée.");
            }
            return blockedResult; // charger le dossier tel quel
          },
        });
      }).then(function (migration) {
        activeEngine = engine;
        folderNeedsPermission = false;
        storageMode = "folder";
        try { localStorage.setItem(STORAGE_MODE_KEY, "folder"); } catch (e) {}
        _folderReady = Promise.resolve(); // reprise déjà faite : court-circuite un ensureFolderReady() ultérieur
        _lastMigrationResult = migration;
        return { folderName: engine.folderName, migration: migration };
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
      // Point 3 (contrat §3) : gated sur `active` — attend le déverrouillage
      // avant même de considérer le mode Dossier/Organisation.
      return withSessionActive(function () {
      // Correctif revue 1b (a) : en mode Dossier, l'identité (consultant_id) doit
      // provenir du DOSSIER actif, sinon app.js peut refuser le démarrage
      // (« Compte non rattaché ») en reprenant un dossier peuplé sur un autre
      // appareil. `withFolderReady` garantit la reprise avant lecture ; en mode
      // par défaut, `stateRecord()` vaut `getRecord()` — inchangé.
      return withFolderReady(function () {
        return stateRecord().then(function (rec) { return json(200, { user: soloUser(rec.state) }); });
      });
      });
    }
    if (path === "/api/logout" && method === "POST") {
      // Point 3 (contrat §3) : n'est plus un no-op. Verrouille réellement la
      // session (l'identité — org comprise — est CONSERVÉE, reconnexion
      // possible) et affiche l'overlay ; ne ré-entre jamais automatiquement.
      return ensureSessionReady().then(function () {
        enterLocked();
        return json(200, { ok: true });
      });
    }
    if (path === "/api/state" && method === "GET") {
      // Point 3 : gated sur `active`, comme /api/me.
      return withSessionActive(function () {
      // Point 1b : mode par défaut (storageMode !== "folder") -> `withFolderReady`
      // appelle `fn()` immédiatement et `activeEngine` est toujours null ici, donc
      // `stateRecord()` vaut `getRecord()` : chemin STRICTEMENT identique à avant.
      return withFolderReady(function () {
        return stateRecord().then(function (rec) { return json(200, { revision: rec.revision, state: rec.state }); });
      });
      });
    }
    if (path === "/api/state" && method === "PUT") {
      var incoming;
      try { incoming = JSON.parse(body || "{}"); } catch (e) { return Promise.resolve(json(400, { error: "JSON invalide" })); }
      var state = incoming && incoming.state;
      if (!state || typeof state !== "object") return Promise.resolve(json(400, { error: "état manquant" }));
      // Point 3 : gated sur `active`, comme /api/me / GET /api/state.
      return withSessionActive(function () {
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
    // Point 3 : lance la reprise de session tôt (dès l'installation), pour que
    // l'overlay de verrouillage apparaisse au plus vite si un PIN l'exige,
    // plutôt que d'attendre le premier appel /api/me gaté par `withSessionActive`.
    ensureSessionReady();
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

    // Durcissement (contrariant Point 5) : REFUSE explicitement un backup
    // portant des identités dupliquées au sein d'une même collection — sans ce
    // refus, la seconde entité écraserait silencieusement la première dès
    // qu'un diff événementiel serait calculé (Dossier/Organisation, ou une
    // migration ultérieure), une PERTE DE DONNÉES invisible pour l'utilisateur
    // (repro : `snapshotToEventsDiff` "dernier gagne" sur une `Map` par id).
    // Refus plutôt que déduplication silencieuse : aucune règle "qui gagne"
    // n'est fiable sans arbitrage humain (contrat §1 : jamais migrer un état
    // ambigu en silence).
    var dups = findDuplicateIdentities(state);
    if (dups.length > 0) {
      var details = dups.map(function (d) {
        return d.entityType + " (" + COLLECTION_IDENTITY_KEY[d.entityType] + "=" + d.id + ", " + d.count + " entrées)";
      }).join(" ; ");
      throw new Error(
        "Import refusé : ce fichier contient des entités en double (même identité, contenus potentiellement " +
        "différents) — " + details + ". Corrigez le fichier (chaque élément doit avoir une identité unique) " +
        "avant de réimporter : aucune donnée n'a été modifiée."
      );
    }

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

      var driveAvailable = !!(window.PiloteoDrive && window.PiloteoDrive.isAvailable);
      body.appendChild(modeRow(
        "Google Drive",
        driveAvailable ? "Disponible" : "Bientôt",
        driveAvailable ? "#137a3f" : "#8a6d1f",
        driveAvailable
          ? "Client OAuth configuré (GOOGLE_CLIENT_ID, scope drive.file). Écriture vive : événements signés en fichiers immuables, réconciliation déterministe. Sélection du dossier racine Drive au moment de créer/rejoindre."
          : "Adaptateur câblé et testé ; activation par identifiant OAuth public (GOOGLE_CLIENT_ID) dans la config de déploiement."));
      body.appendChild(modeRow("Serveur hébergé", "Disponible séparément", "#5b6b76", "Déploiement Docker (voir docs/deployment). Mode centralisé, hors application solo."));

      // Section 3bis — Organisation (point 2c-C2, ORG_UI_CONTRACT §3).
      body.appendChild(sectionTitle("Organisation"));
      if (storageMode === "org" && activeEngine && activeEngine.manifest && activeEngine.membership) {
        var orgEngineRef = activeEngine;      // capturé : évite un décalage si l'utilisateur revient à cet appareil pendant que ce panneau est ouvert
        var orgAdapterRef = activeOrgAdapter;
        var myRole = orgEngineRef.membership.role || "user";
        var roleLabel = myRole === "owner" ? "Propriétaire" : myRole === "admin" ? "Administrateur" : "Membre";
        // Nom d'affichage : priorité au manifeste (racine write-once, visible par
        // TOUS les membres, y compris ceux qui ont rejoint), repli sur le nom
        // mémorisé localement (créateur) puis un libellé générique.
        var orgDisplayName = (orgEngineRef.manifest && orgEngineRef.manifest.name)
          || (function () { try { return localStorage.getItem(ORG_NAME_KEY); } catch (e) { return null; } })()
          || "Organisation";
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

      // Section 4 — Session / Sécurité (Point 3, AUTH_SESSION_CONTRACT.md §4).
      body.appendChild(sectionTitle("Session / Sécurité"));
      body.appendChild(el("p", "margin:2px 0 4px;font-size:12.5px;color:#5b6b76;",
        "Le code verrouille l'accès sur CET appareil. Il ne chiffre pas les données ; la confidentialité repose sur les permissions du dossier/Drive."));
      // Divulgation honnête complémentaire (round de correction r2, §0) : le
      // libellé ci-dessus (contractuel, §4, ne pas reformuler) suffit pour
      // l'usage courant ; celui-ci précise le modèle de menace pour qui lit
      // attentivement — jamais présenté comme une barrière technique.
      body.appendChild(el("p", "margin:2px 0 10px;font-size:12px;color:#8a8f94;",
        "C'est un verrou best-effort contre un accès occasionnel (un collègue, un écran laissé ouvert) — pas une " +
        "protection technique : un accès aux réglages système de l'appareil, ou aux outils développeur du " +
        "navigateur, permet de le contourner."));

      var hasPin = !!(sessionState && sessionState.pin);
      var MIN_PIN_LENGTH = 6; // contrat §4 (révision post-revue r2) : seule barrière indépendante de l'horloge, cf. avertissement ci-dessous.
      var pinBox = el("div", "display:grid;grid-template-columns:1fr;gap:8px;margin:6px 0;");
      var currentPinIn = hasPin ? fieldInput("Code actuel", "password") : null;
      if (currentPinIn) { currentPinIn.input.id = "piloteo-pin-current"; pinBox.appendChild(currentPinIn.wrap); }
      var newPinIn = fieldInput(hasPin ? "Nouveau code" : "Code (" + MIN_PIN_LENGTH + " caractères minimum)", "password");
      newPinIn.input.id = "piloteo-pin-new";
      var confirmPinIn = fieldInput("Confirmer", "password");
      confirmPinIn.input.id = "piloteo-pin-confirm";
      pinBox.appendChild(newPinIn.wrap); pinBox.appendChild(confirmPinIn.wrap);
      body.appendChild(pinBox);

      var pinMsg = el("div", "font-size:12.5px;color:#5b6b76;min-height:16px;");
      pinMsg.id = "piloteo-pin-msg";
      var pinRow = el("div", "display:flex;gap:8px;flex-wrap:wrap;margin:6px 0;");
      var pinSubmitBtn = mkBtn(hasPin ? "Changer le code" : "Définir un code", function () {
        var PA = window.PiloteoAuth;
        if (!PA) { pinMsg.textContent = "Module de verrouillage indisponible (rechargez la page)."; return; }
        var newVal = newPinIn.input.value;
        var confirmVal = confirmPinIn.input.value;
        if (!newVal || newVal.length < MIN_PIN_LENGTH) {
          // Contrat §4 (révision post-revue r2) : SEULE barrière indépendante
          // de l'horloge système — le coût PBKDF2 par tentative ne protège
          // que si l'espace de PIN est assez grand. Message honnête sur le
          // POURQUOI (pas juste "trop court").
          pinMsg.textContent = "Code trop court (" + MIN_PIN_LENGTH + " caractères minimum) : un code court reste " +
            "devinable même avec le blocage, car le blocage peut être contourné en changeant l'heure de l'appareil.";
          return;
        }
        if (newVal !== confirmVal) { pinMsg.textContent = "Les deux codes ne correspondent pas."; return; }
        var proceed = hasPin
          ? PA.verifyPin(currentPinIn.input.value, sessionState.pin).then(function (ok) {
              if (!ok) throw new Error("Code actuel incorrect.");
            })
          : Promise.resolve();
        pinMsg.textContent = "Enregistrement…";
        proceed
          .then(function () { return PA.hashPin(newVal, PA.newSalt()); })
          .then(function (hashed) {
            sessionState = Object.assign({}, sessionState, { pin: hashed, status: "active", failedAttempts: 0, lockedUntil: 0 });
            return persistSession(sessionState);
          })
          .then(function () {
            pinMsg.textContent = "Code enregistré.";
            setTimeout(function () { close(); openPanel(); }, 400);
          })
          .catch(function (e) { pinMsg.textContent = "Échec : " + ((e && e.message) || e); });
      }, true);
      pinSubmitBtn.id = "piloteo-pin-submit";
      pinRow.appendChild(pinSubmitBtn);
      if (hasPin) {
        var pinRemoveBtn = mkBtn("Retirer le code", function () {
          var PA = window.PiloteoAuth;
          if (!PA) { pinMsg.textContent = "Module de verrouillage indisponible (rechargez la page)."; return; }
          var currentVal = currentPinIn.input.value;
          if (!currentVal) { pinMsg.textContent = "Saisissez le code actuel pour le retirer."; return; }
          pinMsg.textContent = "Vérification…";
          PA.verifyPin(currentVal, sessionState.pin).then(function (ok) {
            if (!ok) { pinMsg.textContent = "Code actuel incorrect."; return; }
            sessionState = Object.assign({}, sessionState, { pin: null, status: "active", failedAttempts: 0, lockedUntil: 0 });
            return persistSession(sessionState).then(function () {
              pinMsg.textContent = "Code retiré.";
              setTimeout(function () { close(); openPanel(); }, 400);
            });
          }).catch(function (e) { pinMsg.textContent = "Échec : " + ((e && e.message) || e); });
        });
        pinRemoveBtn.id = "piloteo-pin-remove";
        pinRow.appendChild(pinRemoveBtn);
      }
      body.appendChild(pinRow);
      body.appendChild(pinMsg);

      var lockOnOpenRow = el("label", "display:flex;align-items:center;gap:8px;font-size:13px;margin:10px 0;cursor:pointer;");
      var lockOnOpenChk = document.createElement("input");
      lockOnOpenChk.type = "checkbox";
      lockOnOpenChk.checked = !!(sessionState && sessionState.lockOnOpen);
      lockOnOpenChk.id = "piloteo-lock-on-open";
      lockOnOpenChk.addEventListener("change", function () {
        sessionState = Object.assign({}, sessionState, { lockOnOpen: lockOnOpenChk.checked });
        persistSession(sessionState);
      });
      lockOnOpenRow.appendChild(lockOnOpenChk);
      lockOnOpenRow.appendChild(document.createTextNode("Verrouiller à chaque ouverture"));
      body.appendChild(lockOnOpenRow);

      var lockRow = el("div", "display:flex;gap:8px;flex-wrap:wrap;margin:6px 0;");
      lockRow.appendChild(mkBtn("Verrouiller maintenant", function () { close(); ensureSessionReady().then(enterLocked); }, true));
      body.appendChild(lockRow);

      // Distinction org (contrat §4) : « Se déconnecter » (verrouille, garde
      // l'identité) vs « Changer d'identité » (oublie la clé — destructif,
      // avertissement explicite), proposée UNIQUEMENT ici, jamais confondue
      // avec « Revenir à cet appareil » ci-dessus (qui, lui, ne touche pas à
      // l'identité : il quitte seulement le stockage org pour l'appareil).
      if (storageMode === "org") {
        body.appendChild(el("div", "height:1px;background:#f1f4f6;margin:12px 0;"));
        var orgSessionRow = el("div", "display:flex;gap:8px;flex-wrap:wrap;margin:6px 0;");
        orgSessionRow.appendChild(mkBtn("Se déconnecter", function () { close(); ensureSessionReady().then(enterLocked); }));
        orgSessionRow.appendChild(mkBtn("Changer d'identité", function () {
          var warn = "Changer d'identité oublie votre clé de membre sur CET appareil (rayon d'explosion nul pour " +
            "les autres membres). Mais VOUS perdrez tout accès à l'organisation tant qu'un administrateur ne vous " +
            "aura pas ré-invité.\n\nContinuer ?";
          if (!window.confirm(warn)) return;
          if (!window.PiloteoOrg || typeof window.PiloteoOrg.forgetIdentity !== "function") {
            alert("Fonctionnalité indisponible (module Organisation non chargé).");
            return;
          }
          window.PiloteoOrg.forgetIdentity().then(function () {
            deactivateOrg();
            alert("Identité oubliée. L'application va se recharger.");
            location.reload();
          }).catch(function (e) { alert("Échec : " + ((e && e.message) || e)); });
        }));
        body.appendChild(orgSessionRow);
        body.appendChild(el("p", "margin:6px 0 2px;font-size:12.5px;color:#5b6b76;",
          "« Se déconnecter » verrouille l'accès sur cet appareil et conserve votre identité (reconnexion " +
          "possible). « Changer d'identité » l'oublie définitivement sur cet appareil."));
      }

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

  // Overlay de verrouillage (Point 3, AUTH_SESSION_CONTRACT.md §2/§4) —
  // ÉTEND l'overlay `lockSpace` déjà présent (même id `piloteo-lock`, même
  // style d'ensemble), jamais un nouvel écran app.js. Deux formes :
  //  - aucun PIN défini : verrou minimal (comme avant), un clic déverrouille ;
  //  - PIN défini : saisie + anti-force-brute recoupé sur deux horloges
  //    (`canAttemptCrossChecked`), compte à rebours affiché et saisie
  //    refusée pendant un blocage.
  //
  // BEST-EFFORT, PAS une barrière (modèle de menace §0, révisé après DEUX
  // revues adverses) : le blocage temporisé est un ralentisseur UX, pas une
  // protection technique. Il repose sur une horloge (murale ou monotone
  // ré-ancrée au chargement de la page) — un adversaire ayant accès aux
  // RÉGLAGES SYSTÈME de l'appareil (avancer la date de l'OS, SANS aucun
  // JavaScript) le contourne intégralement (round 2 : repro
  // tests/e2e/attack-p3-session-round2.mjs via libfaketime). Ce niveau
  // d'accès (appareil déverrouillé, réglages OS) est déjà comparable à celui
  // qui permet de lire IndexedDB en clair : le lockout n'élargit donc pas la
  // surface d'attaque, il ralentit seulement un curieux pressé. Le
  // recoupement `canAttemptCrossChecked` (horloge monotone via
  // `performance.now`) reste utile contre un monkey-patch de `Date.now`
  // DANS la page (round 1) — mais PAS contre un changement d'horloge OS, qui
  // fausse les deux estimations à la source. La SEULE barrière réellement
  // indépendante de l'horloge : le coût PBKDF2 par tentative combiné à une
  // longueur de PIN minimale (§4, `MIN_PIN_LENGTH` ci-dessous) et à un
  // compteur d'échecs qui PERSISTE (jamais remis à zéro par un simple
  // rechargement — voir `ensureSessionReady`/`registerFailure`).
  var _lockCountdownTimer = null;
  function formatWait(ms) {
    var s = Math.max(1, Math.ceil(ms / 1000));
    if (s < 60) return s + " s";
    return Math.ceil(s / 60) + " min";
  }
  function renderLockOverlay() {
    if (document.body) buildLockOverlay();
    else document.addEventListener("DOMContentLoaded", buildLockOverlay, { once: true });
  }
  function buildLockOverlay() {
    var existing = document.getElementById("piloteo-lock");
    if (existing) existing.remove(); // reconstruit (reflète l'état PIN courant, ex. juste retiré)
    var hasPin = !!(sessionState && sessionState.pin);

    var ov = el("div", "position:fixed;inset:0;z-index:2147483002;background:#0d1a22;color:#eaf1f4;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;" +
      "font:400 15px/1.4 system-ui,-apple-system,sans-serif;text-align:center;padding:24px;");
    ov.id = "piloteo-lock";
    ov.appendChild(el("div", "font-size:34px;", "🔒"));
    ov.appendChild(el("div", "font-size:18px;font-weight:600;", "Espace verrouillé"));
    ov.appendChild(el("div", "opacity:.75;max-width:340px;",
      "Vos données restent sur cet appareil. " + (hasPin ? "Saisissez votre code pour reprendre." : "Déverrouillez pour reprendre.")));

    var input = null;
    if (hasPin) {
      input = document.createElement("input");
      input.type = "password"; input.inputMode = "numeric"; input.autocomplete = "off";
      input.id = "piloteo-lock-pin";
      input.placeholder = "Code";
      input.setAttribute("style", "width:200px;box-sizing:border-box;padding:10px 12px;border-radius:8px;" +
        "border:1px solid rgba(255,255,255,.28);background:#152530;color:#eaf1f4;font:16px monospace;" +
        "text-align:center;letter-spacing:.2em;");
      ov.appendChild(input);
    }

    var msg = el("div", "font-size:13px;color:#f6d685;min-height:18px;");
    msg.id = "piloteo-lock-msg";
    var btn = mkBtn("Déverrouiller", function () { submit(); }, true);
    btn.id = "piloteo-lock-submit";
    ov.appendChild(msg);
    ov.appendChild(btn);

    if (input) {
      input.addEventListener("keydown", function (ev) { if (ev.key === "Enter") submit(); });
      setTimeout(function () { input.focus(); }, 0);
    }
    document.body.appendChild(ov);

    function setBusy(disabled) {
      btn.disabled = disabled;
      if (input) input.disabled = disabled;
    }

    function refreshLockoutDisplay() {
      var PA = window.PiloteoAuth;
      if (!PA || !sessionState) return;
      // Recoupement d'horloge (§1, durcissement) : reflète EXACTEMENT la même
      // estimation que `attemptUnlock`, pour ne jamais afficher "vous pouvez
      // réessayer" alors que la vérification réelle refuserait encore.
      var gate = PA.canAttemptCrossChecked(sessionState, Date.now(), monotonicNow());
      if (!gate.allowed) {
        setBusy(true);
        msg.textContent = "Trop de tentatives. Réessayez dans " + formatWait(gate.waitMs) + ".";
        if (!_lockCountdownTimer) {
          _lockCountdownTimer = setInterval(function () {
            if (!document.getElementById("piloteo-lock")) { clearInterval(_lockCountdownTimer); _lockCountdownTimer = null; return; }
            refreshLockoutDisplay();
          }, 1000);
        }
      } else {
        setBusy(false);
        if (_lockCountdownTimer) { clearInterval(_lockCountdownTimer); _lockCountdownTimer = null; }
        if (msg.textContent.indexOf("Trop de tentatives") === 0) msg.textContent = "";
      }
    }
    if (hasPin) refreshLockoutDisplay();

    function submit() {
      if (btn.disabled) return;
      setBusy(true);
      msg.textContent = hasPin ? "Vérification…" : "";
      attemptUnlock(input ? input.value : "").then(function (result) {
        if (result.ok) {
          if (_lockCountdownTimer) { clearInterval(_lockCountdownTimer); _lockCountdownTimer = null; }
          ov.remove();
          return;
        }
        setBusy(false);
        if (input) { input.value = ""; input.focus(); }
        if (result.waitMs) { refreshLockoutDisplay(); }
        else { msg.textContent = result.error || "Code incorrect."; }
      });
    }
  }

  // Overlay d'ERREUR fail-CLOSED (Point 3, AUTH_SESSION_CONTRACT.md §0/§2 —
  // révision post-revue adverse, FAILLE 2 du round de correction) : rendu
  // UNIQUEMENT quand un PIN protège l'accès mais que `PiloteoAuth` n'a pas pu
  // être vérifié. Réutilise le même id `piloteo-lock` (extension de l'overlay
  // existant, jamais un nouvel écran app.js) mais SANS le champ de saisie
  // normal — le contrat l'interdit explicitement dans ce cas précis (rien à
  // vérifier le PIN contre). Deux actions : « Réessayer » (relance
  // `ensureSessionReady()` sans recharger — utile si le réseau revient) et
  // « Recharger la page » (repli classique).
  function renderAuthUnavailableOverlay() {
    if (document.body) buildAuthUnavailableOverlay();
    else document.addEventListener("DOMContentLoaded", buildAuthUnavailableOverlay, { once: true });
  }
  function buildAuthUnavailableOverlay() {
    var existing = document.getElementById("piloteo-lock");
    if (existing) existing.remove();

    var ov = el("div", "position:fixed;inset:0;z-index:2147483002;background:#2a1414;color:#f5e7e7;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;" +
      "font:400 15px/1.4 system-ui,-apple-system,sans-serif;text-align:center;padding:24px;");
    ov.id = "piloteo-lock";
    ov.setAttribute("data-piloteo-lock-state", "auth-unavailable");
    ov.appendChild(el("div", "font-size:34px;", "⚠️"));
    ov.appendChild(el("div", "font-size:18px;font-weight:600;", "Verrou d'appareil indisponible"));
    ov.appendChild(el("div", "opacity:.85;max-width:360px;",
      "Impossible de vérifier le code PIN de cet appareil (module de verrouillage non chargé — hors ligne ou " +
      "connexion interrompue). Par sécurité, l'accès reste VERROUILLÉ tant que la vérification n'est pas possible."));

    var msg = el("div", "font-size:13px;color:#f6c2c2;min-height:18px;");
    msg.id = "piloteo-lock-msg";
    ov.appendChild(msg);

    var row = el("div", "display:flex;gap:8px;flex-wrap:wrap;justify-content:center;");
    row.appendChild(mkBtn("Réessayer", function () {
      msg.textContent = "Nouvelle tentative…";
      // Force une relecture de `window.PiloteoAuth` (ex. réseau revenu entre
      // temps) sans recharger toute la page : si le module est là cette
      // fois, `ensureSessionReady()` retombe sur le chemin normal (overlay de
      // saisie ou session active selon `lockOnOpen`/PIN).
      _sessionReady = null;
      ensureSessionReady().then(function () {
        if (_authUnavailable) msg.textContent = "Toujours indisponible. Réessayez ou rechargez la page.";
      });
    }, false));
    row.appendChild(mkBtn("Recharger la page", function () { location.reload(); }, true));
    ov.appendChild(row);

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
    // Hook de TEST (contrariant Point 5) : accès direct à l'import d'une
    // sauvegarde (texte JSON), sans passer par le `<input type=file>` du
    // panneau Réglages — permet de prouver le refus explicite d'un backup à
    // identités dupliquées.
    _importBackupText: importBackupText,
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
    // --- Point 5 (MIGRATION_MODE_CONTRACT.md) : hooks de TEST ---------------
    // `_createOrg` : symétrique de `_activateFolder`, pour exercer le chemin
    // « Créer une organisation » (migration comprise) sans passer par l'écran
    // d'accueil/Réglages.
    _createOrg: activateCreateOrg,
    // `_runGuardedMigration(engine, soloSnapshot)` : accès DIRECT à
    // l'orchestration de migration (sauvegarde -> plan -> seed -> vérification),
    // sans passer par le sélecteur natif ni par `activateFolder`/`_createOrg`.
    // Permet à un e2e d'injecter un `engine` {load,commit} quelconque (réel ou
    // délibérément cassé, cf. `piloteo-migration-bridge.mjs#__forceNextVerificationFailure`)
    // pour prouver, dans un vrai navigateur, qu'un échec de vérification
    // n'entraîne JAMAIS de bascule (contrat §4 scénario 9).
    _runGuardedMigration: runGuardedMigration,
    // Dernier résultat de migration (activateFolder/activateCreateOrg RÉELS,
    // ou _runGuardedMigration) — pour assertions e2e (contrat §4 scénarios 7-9).
    _lastMigrationResult: function () { return _lastMigrationResult; },
    // Nombre de sauvegardes `.piloteobackup` déclenchées AVANT une écriture de
    // migration (contrat §2 point 1) — preuve qu'« une sauvegarde a été
    // produite » sans dépendre de l'interception du téléchargement lui-même.
    _preMigrationBackupCount: function () { return _preMigrationBackupCount; },
    // Nombre de fois où l'avertissement « sauvegarde échouée, continuer quand
    // même ? » a été RÉELLEMENT affiché (contrat §2 point 1 : « tracer que
    // l'utilisateur a vu l'avertissement »), quelle que soit sa réponse.
    _backupWarningShownCount: function () { return _backupWarningShownCount; },
    // `decideAndRunMigration(engine, soloSnapshot, targetLabel, hooks)` :
    // orchestrateur UI complet (pas explicite §3) — accès direct pour les e2e
    // qui veulent exercer le pas UI sans passer par le sélecteur natif.
    _decideAndRunMigration: decideAndRunMigration,
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
    },
    // --- Point 3 (AUTH_SESSION_CONTRACT.md) : hooks de TEST pour les e2e ----
    // `_authSessionReady` : attend la reprise de session (boot) — utile pour
    // synchroniser un test AVANT de vérifier l'overlay/le gating.
    _authSessionReady: function () { return ensureSessionReady(); },
    // `_authSetPin` : définit un PIN directement (sans passer par le
    // formulaire Réglages), pour préparer un scénario e2e (ex. « recharger →
    // overlay affiché »). `opts.lockOnOpen` force le verrouillage au
    // PROCHAIN boot (contrat §2) sans quoi définir un PIN pendant une session
    // déjà active ne la verrouille pas immédiatement (opt-in frictionless).
    // NB : contourne DÉLIBÉRÉMENT la longueur minimale (§4, 6 caractères) —
    // c'est un hook de test pour poser un état arbitraire rapidement, pas le
    // chemin utilisateur réel (Réglages, seul endroit qui applique la
    // politique). Ne pas s'appuyer dessus pour tester la politique de
    // longueur elle-même (voir la section Réglages / #piloteo-pin-submit).
    _authSetPin: function (pin, opts) {
      opts = opts || {};
      return ensureSessionReady().then(function () {
        var PA = window.PiloteoAuth;
        if (!PA) return Promise.reject(new Error("PiloteoAuth non chargé."));
        return PA.hashPin(pin, PA.newSalt()).then(function (hashed) {
          sessionState = Object.assign({}, sessionState, {
            pin: hashed,
            status: "active",
            failedAttempts: 0,
            lockedUntil: 0,
            lockOnOpen: opts.lockOnOpen != null ? !!opts.lockOnOpen : !!(sessionState && sessionState.lockOnOpen),
          });
          return persistSession(sessionState);
        });
      });
    },
    // `_authClearPin` : retire le PIN (retour à l'état frictionless par défaut).
    _authClearPin: function () {
      return ensureSessionReady().then(function () {
        sessionState = Object.assign({}, sessionState, { pin: null, status: "active", failedAttempts: 0, lockedUntil: 0 });
        return persistSession(sessionState);
      });
    },
    // `_authLockNow` : verrouille immédiatement (équivalent programmatique de
    // « Verrouiller maintenant » / `POST /api/logout`).
    _authLockNow: function () { return ensureSessionReady().then(function () { enterLocked(); }); },
    // `_authState` : lecture de l'état de session pour assertions e2e — ne
    // renvoie JAMAIS le hash/sel du PIN (uniquement `hasPin`, un booléen).
    _authState: function () {
      return sessionState ? {
        status: sessionState.status,
        hasPin: !!sessionState.pin,
        failedAttempts: sessionState.failedAttempts,
        lockedUntil: sessionState.lockedUntil,
        lockOnOpen: !!sessionState.lockOnOpen,
      } : null;
    },
    // `_authGateOpen` : `true` une fois le portillon /api ouvert (session
    // active) — permet à un e2e de vérifier qu'un appel /api/state EST
    // effectivement en attente (jamais résolu) tant que verrouillé.
    _authGateOpen: function () {
      return ensureSessionReady().then(function () {
        return Promise.race([
          _sessionGate.then(function () { return true; }),
          new Promise(function (resolve) { setTimeout(function () { resolve(false); }, 50); }),
        ]);
      });
    }
  };

  // Auto-installation synchrone AVANT app.js si le mode solo est actif.
  if (isSolo()) install();
})();
