// tests/e2e/org-onboarding-drive.mjs
//
// Smoke E2E navigateur (Playwright + Chromium) de l'onboarding Google Drive
// (docs/next/DRIVE_ONBOARDING_CONTRACT.md, lot A), STYLE tests/e2e/org-onboarding.mjs
// (mode Organisation dossier) : prouve, DANS UN VRAI NAVIGATEUR, que le VRAI
// câblage `local-backend.js` (pas seulement le pont) fonctionne pour
// `storageMode==="org-drive"`, via les hooks de test déjà exposés
// (`window.PiloteoLocal._useDriveOrgEngineForTest`/`_createOrgDrive`/
// `_retryDriveOrgAuth`/`_orgDriveStorageMode`) au-dessus d'un
// `GoogleDriveStorageAdapter` dont le TRANSPORT RÉSEAU (`fetch` vers
// `googleapis.com`) est routé vers un FakeDrive EN MÉMOIRE (même simulateur
// que `tests/next/helpers/fake-drive.mjs`, inlinée ici) — AUCUN OAuth réel,
// AUCUN appel réseau réel à Google (impossible à automatiser ici, cf.
// docs/next/DRIVE_ONBOARDING_MANUAL.md).
//
// Pour que `resumeDriveOrg({interactive:true})` (déclenchée par
// `_retryDriveOrgAuth`, exactement le chemin du clic « Se reconnecter à
// Google ») s'exécute de bout en bout SANS réseau réel :
//   - Google Identity Services (`window.google.accounts.oauth2`) est
//     REMPLACÉ par un stub qui répond immédiatement avec un faux token —
//     `piloteo-drive-bridge.mjs` ne fait alors AUCUNE différence entre ce
//     stub et le vrai GIS (il ne regarde que `initTokenClient`/
//     `requestAccessToken`/le `callback`).
//   - `window.fetch` est monkey-patché (AVANT tout script de page, via
//     `addInitScript`) pour rediriger toute requête `googleapis.com` vers un
//     FakeDrive en mémoire (`window.__driveForFetch`) — `local-backend.js`
//     capture ce fetch patché comme SA PROPRE base (`_origFetch`), donc les
//     DEUX interceptions (mienne pour Drive, la sienne pour `/api/*`) se
//     chaînent proprement, sans conflit.
//
// Prouve, dans l'ordre :
//   1. créer une organisation Drive (adapter FakeDrive injecté via le hook
//      `__createOrgOnAdapter`, sans OAuth réel) + `_useDriveOrgEngineForTest` :
//      `/api/me` renvoie role=admin, `/api/state` fonctionne (GET puis PUT) ;
//   2. reprise via `_retryDriveOrgAuth` (chemin RÉEL du bouton « Se
//      reconnecter à Google », OAuth simulé par le stub GIS ci-dessus) :
//      retrouve la MÊME organisation (même manifeste), `storageMode` bascule
//      bien en "org-drive", `/api/me`/`/api/state` fonctionnent toujours ;
//   3. échec de migration (Point 5, `__forceNextVerificationFailure`) lors
//      d'une création d'org-drive : jamais de mode org-drive actif, retour à
//      « cet appareil », données solo intactes.
//
// docs/next/PARCOURS_IDENTITE_CONTRACT.md, Lot 1 : l'ancien scénario 1
// (« écran d'accueil : deux emplacements dossier/Drive pour Créer une
// organisation ») a été RETIRÉ ici — cette UI n'existe plus (l'accueil n'a
// plus que 2 cartes, « Travailler seul »/« Rejoindre », couvert par
// tests/e2e/org-onboarding.mjs ; « Créer une organisation » devient
// « Partager cet espace », Lot 2, folder-only pour l'instant — voir le
// rapport du maker Lot 1/2 pour la justification de cet écart Drive). Les
// scénarios 1-3 ci-dessous, EUX, n'ont JAMAIS dépendu de cette UI (ils
// appellent `window.PiloteoDrive`/`window.PiloteoLocal` directement via
// `page.evaluate`) : intégralement conservés, non-régression complète du
// câblage Drive.
//
// Usage : node tests/e2e/org-onboarding-drive.mjs
//   PW_CHROMIUM=<chemin> pour piloter un binaire Chromium précis.

let _pw;
try { _pw = await import("playwright"); }
catch { _pw = await import("/opt/node22/lib/node_modules/playwright/index.js"); }
const chromium = _pw.chromium || _pw.default.chromium;

import { spawn } from "node:child_process";

const ROOT = new URL("../..", import.meta.url).pathname;
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;

const failures = [];
const ok = (cond, msg) => { if (cond) { console.log("  ✓", msg); } else { failures.push(msg); console.log("  ✗", msg); } };

const srv = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
});
srv.stderr.on("data", () => {});

async function waitServer() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/index.html`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("serveur statique jamais up");
}

// Injecté dans la page (AVANT tout script de page, via addInitScript) :
//   - un FakeDrive minimal EN MÉMOIRE, même sous-ensemble de comportement que
//     tests/next/helpers/fake-drive.mjs (files.list/files.create/upload
//     multipart/alt=media) — assez pour createOrganization+writeManifest+
//     writeMemberRecord+openOrgEngine, jamais plus.
//   - un monkey-patch de `window.fetch` (capture le fetch NATIF AVANT tout
//     autre script) qui route `googleapis.com` vers `window.__driveForFetch`
//     (posé PLUS TARD, en page, une fois le FakeDrive instancié) et laisse
//     tout le reste passer au fetch natif — `local-backend.js` capturera CE
//     fetch patché comme sa propre base (`_origFetch`), chaînage propre.
//   - un stub Google Identity Services (`window.google.accounts.oauth2`) qui
//     répond IMMÉDIATEMENT avec un faux token, sans jamais contacter
//     accounts.google.com — `piloteo-drive-bridge.mjs#waitForGis` le voit
//     comme un GIS parfaitement valide.
function initScriptSource() {
  const FOLDER_MIME = "application/vnd.google-apps.folder";

  function fakeResponse(status, body) {
    const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
    return { status, ok: status >= 200 && status < 300, text: async () => text, json: async () => JSON.parse(text) };
  }
  function parseDriveQuery(q) {
    const folderOnly = q.includes(FOLDER_MIME);
    const nameMatch = q.match(/name = '((?:[^'\\]|\\.)*)'/);
    const name = nameMatch ? nameMatch[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\") : null;
    const parentMatch = q.match(/'((?:[^'\\]|\\.)*)' in parents/);
    const parentId = parentMatch ? parentMatch[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\") : null;
    return { folderOnly, name, parentId };
  }

  class FakeDrive {
    constructor() {
      this._autoId = 1;
      this._clock = 1700000000000;
      this.nodes = new Map();
    }
    newId() { return "id-" + this._autoId++; }
    nowIso() { this._clock += 1000; return new Date(this._clock).toISOString(); }
    addFolder(name, parentId) {
      const id = this.newId();
      this.nodes.set(id, { id, name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : [], createdTime: this.nowIso() });
      return id;
    }
    fetch = async (url, options = {}) => {
      const method = (options && options.method) || "GET";
      const u = new URL(url);
      if (u.pathname === "/drive/v3/files" && method === "GET") return this._handleList(u);
      if (u.pathname === "/drive/v3/files" && method === "POST") return this._handleCreateFolder(options);
      if (u.pathname === "/upload/drive/v3/files" && method === "POST") return this._handleUpload(options);
      const dl = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
      if (dl && method === "GET" && u.searchParams.get("alt") === "media") return this._handleDownload(dl[1]);
      throw new Error("FakeDrive(e2e): requête non simulée : " + method + " " + url);
    };
    _handleList(u) {
      const q = u.searchParams.get("q") || "";
      const { folderOnly, name, parentId } = parseDriveQuery(q);
      let matched = [...this.nodes.values()].filter((n) => {
        if (folderOnly && n.mimeType !== FOLDER_MIME) return false;
        if (name !== null && n.name !== name) return false;
        if (parentId !== null && !(n.parents || []).includes(parentId)) return false;
        return true;
      });
      matched.sort((a, b) => (a.createdTime < b.createdTime ? -1 : a.createdTime > b.createdTime ? 1 : 0));
      const files = matched.map((n) => ({ id: n.id, name: n.name, createdTime: n.createdTime, size: n.size }));
      return fakeResponse(200, { files });
    }
    _handleCreateFolder(options) {
      const metadata = JSON.parse(options.body);
      const id = this.newId();
      this.nodes.set(id, { id, name: metadata.name, mimeType: metadata.mimeType, parents: metadata.parents || [], createdTime: this.nowIso() });
      return fakeResponse(200, { id, name: metadata.name, webViewLink: "https://drive.google.com/drive/folders/" + id });
    }
    _handleUpload(options) {
      const contentType = options.headers["Content-Type"];
      const boundary = contentType.match(/boundary=(.+)$/)[1];
      const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(
        "--" + escaped + "\\r\\nContent-Type: application/json; charset=UTF-8\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--" + escaped +
          "\\r\\nContent-Type: application/octet-stream\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--" + escaped + "--"
      );
      const m = options.body.match(re);
      const metadata = JSON.parse(m[1]);
      const content = m[2];
      const id = this.newId();
      this.nodes.set(id, { id, name: metadata.name, mimeType: "application/octet-stream", parents: metadata.parents || [], createdTime: this.nowIso(), content, size: content.length });
      return fakeResponse(200, { id, name: metadata.name });
    }
    _handleDownload(fileId) {
      const node = this.nodes.get(fileId);
      if (!node) return fakeResponse(404, "Not Found");
      return fakeResponse(200, node.content ?? "");
    }
  }
  window.__FakeDriveE2E = FakeDrive;

  // Monkey-patch de `window.fetch` — capture le fetch NATIF avant tout autre
  // script (y compris local-backend.js, qui liera CE fetch patché comme
  // `_origFetch`). `window.__driveForFetch` est posé PLUS TARD, en page.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("https://www.googleapis.com/") === 0 && window.__driveForFetch) {
      return window.__driveForFetch.fetch(url, init || {});
    }
    return nativeFetch(input, init);
  };

  // Stub Google Identity Services — jamais de réseau réel vers accounts.google.com.
  window.google = {
    accounts: {
      oauth2: {
        initTokenClient(opts) {
          return {
            requestAccessToken() {
              setTimeout(() => opts.callback({ access_token: "fake-e2e-token", expires_in: 3600 }), 0);
            },
          };
        },
      },
    },
  };
}

let browser;
try {
  await waitServer();
  const exe = process.env.PW_CHROMIUM || chromium.executablePath();
  browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });

  // ==========================================================================
  // 1. Créer une organisation Drive (adapter FakeDrive injecté via le hook
  //    __createOrgOnAdapter, AUCUN OAuth réel à cette étape) + _useDriveOrgEngineForTest :
  //    /api/me renvoie role=admin, /api/state fonctionne (GET puis PUT).
  // ==========================================================================
  const ctx = await browser.newContext();
  await ctx.addInitScript(initScriptSource);
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  await page.goto(`${BASE}/index.html?solo=1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(() => !!(window.PiloteoDrive && window.PiloteoDrive.isAvailable), { timeout: 5000 });
  // Ferme l'écran d'accueil (n'affecte pas le reste — mode classique déjà actif en dessous).
  await page.click("#piloteo-welcome button").catch(() => {});
  // Erreurs de chargement bénignes (branding/manifest, cf. tests/e2e/migration.mjs)
  // avant nos scénarios : ne comptent pas dans les assertions "aucune erreur console".
  consoleErrors.length = 0;

  const createResult = await page.evaluate(async () => {
    const drive = new window.__FakeDriveE2E();
    window.__driveForFetch = drive; // routé par le monkey-patch fetch (initScript) — réutilisé par la reprise (étape 3).
    const root = drive.addFolder("Pilotéo - E2E Drive", null);
    window.__driveRoot = root;

    const { GoogleDriveStorageAdapter } = await import("/src/storage/google-drive-adapter.js");
    const adapter = new GoogleDriveStorageAdapter({
      oauthTokenProvider: async () => "fake-create-token", // court-circuite GIS pour CETTE étape (comme drive-onboarding.test.mjs)
      rootFolderId: root,
      fetchImpl: drive.fetch,
      sleepFn: async () => {},
    });

    const identityBefore = await window.PiloteoOrg.getOrCreateIdentity();
    const { engine, manifest } = await window.PiloteoDrive.__createOrgOnAdapter({
      adapter, name: "Cabinet Drive E2E", consultantId: "c-alice-drive",
    });
    const identityAfter = await window.PiloteoOrg.getOrCreateIdentity();

    // Publie un consultant (comme le ferait l'app via /api/state).
    const load0 = await engine.load();
    const next = { ...load0.state, consultants: [...load0.state.consultants, { id: "c-alice-drive", nom: "Alice Drive E2E", admin: true }] };
    const commit0 = await engine.commit(next);

    // Comme createDriveOrg() le ferait réellement (contrat §1) : mémoriser le
    // rootFolderId + le mode pour que la reprise (étape 3) le retrouve.
    try { localStorage.setItem("piloteo_storage_mode", "org-drive"); } catch (e) {}
    try { localStorage.setItem("piloteo_drive_root_folder_id", root); } catch (e) {}

    // Plug dans local-backend.js (hook symétrique de _useOrgEngineForTest).
    window.PiloteoLocal._useDriveOrgEngineForTest(engine, adapter);
    const me = await (await fetch("/api/me")).json();
    const st = await (await fetch("/api/state")).json();
    const put = await (await fetch("/api/state", { method: "PUT", body: JSON.stringify({ state: st.state }) })).json();

    return {
      manifestWorkspaceId: manifest.workspaceId,
      sameIdentity: identityBefore.memberId === identityAfter.memberId,
      commitOk: commit0.ok === true,
      meRole: me.user && me.user.role,
      aliceConsultantPresent: (st.state?.consultants || []).some((c) => c.id === "c-alice-drive"),
      putOk: put.ok === true,
      orgDriveStorageMode: window.PiloteoLocal._orgDriveStorageMode(),
    };
  });

  ok(!!createResult.manifestWorkspaceId, "createOrgOnAdapter (Drive) publie un manifeste (workspaceId présent)");
  ok(createResult.sameIdentity, "identité de membre PARTAGÉE (même memberId — jamais une 2e identité créée par le pont Drive)");
  ok(createResult.commitOk, "commit() sur l'org-drive fraîchement créée renvoie ok:true");
  ok(createResult.orgDriveStorageMode, "local-backend.js bascule en storageMode=\"org-drive\" (_useDriveOrgEngineForTest)");
  ok(createResult.meRole === "admin", `/api/me renvoie role=admin pour le créateur/owner (reçu ${createResult.meRole})`);
  ok(createResult.aliceConsultantPresent, "/api/state GET (mode org-drive) renvoie l'état publié sur l'adapter Drive");
  ok(createResult.putOk, "/api/state PUT (mode org-drive) fonctionne (aller-retour complet)");
  ok(consoleErrors.length === 0, `aucune erreur console pendant la création (${consoleErrors.length})`);
  if (consoleErrors.length) consoleErrors.slice(0, 5).forEach((e) => console.log("    console:", e));

  // ==========================================================================
  // 2. Reprise via _retryDriveOrgAuth — chemin RÉEL du clic « Se reconnecter à
  //    Google » (resumeDriveOrg({interactive:true}) -> oauthTokenProvider() ->
  //    GIS stubé -> openDriveOrg -> GoogleDriveStorageAdapter via `fetch`
  //    global, routé vers le MÊME FakeDrive). Simule un rechargement de page
  //    (nouvelle "session" d'engine, sans jamais avoir appelé oauthTokenProvider
  //    auparavant sur CETTE page) en repartant du storageMode/rootFolderId
  //    mémorisés en localStorage à l'étape 2.
  // ==========================================================================
  consoleErrors.length = 0;
  const resumeResult = await page.evaluate(async () => {
    // Simule une reprise "à froid" : plus d'engine actif localement, mais
    // storageMode/rootFolderId toujours en localStorage (posés à l'étape 2).
    window.PiloteoLocal._deactivateOrg();
    const before = { storageMode: window.PiloteoLocal._storageMode(), orgDrive: window.PiloteoLocal._orgDriveStorageMode() };

    const r = await window.PiloteoLocal._retryDriveOrgAuth();

    const me = await (await fetch("/api/me")).json();
    const st = await (await fetch("/api/state")).json();
    return {
      before,
      manifestWorkspaceId: r.manifest && r.manifest.workspaceId,
      orgDriveStorageMode: window.PiloteoLocal._orgDriveStorageMode(),
      meRole: me.user && me.user.role,
      aliceConsultantStillPresent: (st.state?.consultants || []).some((c) => c.id === "c-alice-drive"),
    };
  });

  ok(!resumeResult.before.orgDrive, "avant reprise : storageMode réinitialisé (_deactivateOrg), plus d'org-drive active");
  ok(!!resumeResult.manifestWorkspaceId, "_retryDriveOrgAuth() (OAuth interactif simulé via GIS stub) retrouve un manifeste");
  ok(resumeResult.orgDriveStorageMode, "après _retryDriveOrgAuth(), storageMode==='org-drive' à nouveau");
  ok(resumeResult.meRole === "admin", `/api/me après reprise renvoie toujours role=admin (reçu ${resumeResult.meRole})`);
  ok(resumeResult.aliceConsultantStillPresent, "/api/state après reprise retrouve les données publiées avant le \"rechargement\"");
  ok(consoleErrors.length === 0, `aucune erreur console pendant la reprise (${consoleErrors.length})`);
  if (consoleErrors.length) consoleErrors.slice(0, 5).forEach((e) => console.log("    console:", e));

  // ==========================================================================
  // 3. Échec de migration (Point 5, `__forceNextVerificationFailure`) SUR UN
  //    ENGINE DRIVE, via le hook BAS NIVEAU engine-agnostique
  //    `_runGuardedMigration` (même technique, même hook, que
  //    tests/e2e/migration.mjs scénario 9 pour le mode dossier — ce hook est
  //    explicitement documenté "folder/org/drive" dans local-backend.js) :
  //    jamais de bascule de storageMode, données solo INTACTES, même si
  //    l'écriture du manifeste/de la fiche membre a réussi côté Drive.
  // ==========================================================================
  await page.evaluate(() => { window.PiloteoLocal._deactivateOrg(); });
  const migrationFailure = await page.evaluate(async () => {
    // Remplace le solo par un état CONTRÔLÉ, schéma valide (comme
    // tests/e2e/migration.mjs scénario 7/9) — PAS le seed.json de démo réel :
    // ses "saisies"/"notesFrais" à ids hérités du format V1 sont rejetées par
    // la validation de schéma (`snapshotToEventsDiff`), ce qui ferait échouer
    // la migration AVANT même d'atteindre la vérification finale ciblée ici.
    const before = await (await fetch("/api/state")).json();
    const solo = {};
    Object.keys(before.state).forEach((c) => { solo[c] = []; });
    solo.consultants = [{ id: "c-mig-drive", nom: "Migrée Drive", trigramme: "MGD", statut: "en poste", admin: false, tempsPartiel: [] }];
    const putRes = await fetch("/api/state", { method: "PUT", body: JSON.stringify({ state: solo }) });
    const soloBefore = (await putRes.json()).state;
    const storageModeBefore = window.PiloteoLocal._storageMode();

    const drive2 = new window.__FakeDriveE2E();
    const root2 = drive2.addFolder("Pilotéo - Échec Migration", null);
    const { GoogleDriveStorageAdapter } = await import("/src/storage/google-drive-adapter.js");
    const adapter2 = new GoogleDriveStorageAdapter({
      oauthTokenProvider: async () => "fake-token-2",
      rootFolderId: root2,
      fetchImpl: drive2.fetch,
      sleepFn: async () => {},
    });
    const { engine } = await window.PiloteoDrive.__createOrgOnAdapter({ adapter: adapter2, name: "Échec Migration Drive", consultantId: "c-echec" });

    window.PiloteoMigration.__forceNextVerificationFailure();
    const migration = await window.PiloteoLocal._runGuardedMigration(engine, soloBefore);

    const soloAfter = (await (await fetch("/api/state")).json()).state;

    return {
      migrationFailed: migration.failed,
      migrationBlocked: migration.blocked,
      hasDiff: Array.isArray(migration.diff) && migration.diff.length > 0,
      hasError: typeof migration.error === "string" && migration.error.length > 0,
      storageModeUnchanged: window.PiloteoLocal._storageMode() === storageModeBefore,
      orgDriveStorageMode: window.PiloteoLocal._orgDriveStorageMode(),
      soloUntouched: JSON.stringify(soloBefore.consultants) === JSON.stringify(soloAfter.consultants),
    };
  });
  ok(migrationFailure.migrationFailed, `échec de vérification (engine Drive) -> migration.failed=true`);
  ok(!migrationFailure.migrationBlocked, "un échec de vérification n'est pas un \"blocked\" (cible Drive vide au départ)");
  ok(migrationFailure.hasDiff, "l'écart de la vérification finale (round-trip) est rapporté (diff non vide)");
  ok(migrationFailure.hasError, "un message d'erreur explicite est renvoyé");
  ok(migrationFailure.storageModeUnchanged, "storageMode INCHANGÉ malgré l'écriture réussie côté Drive (manifeste/fiche membre déjà publiés)");
  ok(!migrationFailure.orgDriveStorageMode, "storageMode n'est PAS \"org-drive\" après un échec de vérification");
  ok(migrationFailure.soloUntouched, "les données solo sont INTACTES (aucune perte, aucune bascule)");

  await ctx.close();
} catch (e) {
  failures.push("exception: " + (e && e.message || e));
  console.error(e);
} finally {
  if (browser) await browser.close();
  srv.kill("SIGTERM");
}

if (failures.length) {
  console.log(`\nFAIL (${failures.length}) :`);
  failures.forEach((f) => console.log(" -", f));
  process.exit(1);
}
console.log("\nOK");
process.exit(0);
