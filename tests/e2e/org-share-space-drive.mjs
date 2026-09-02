// tests/e2e/org-share-space-drive.mjs
//
// Smoke E2E navigateur (Playwright + Chromium), STYLE tests/e2e/org-promotion.mjs
// (Lot 2, mode Dossier) + tests/e2e/org-onboarding-drive.mjs (stubs Drive) :
// prouve, DANS UN VRAI NAVIGATEUR, docs/next/PARCOURS_IDENTITE_CONTRACT.md
// Lot 5 — « Partager cet espace » VERS GOOGLE DRIVE (promotion en place, MÊME
// workspaceId, mobile) — via le VRAI câblage `local-backend.js` (pas
// seulement les ponts).
//
// OAuth (Google Identity Services) et le transport réseau (`fetch` vers
// googleapis.com) sont STUBBÉS (même patron que org-onboarding-drive.mjs) —
// AUCUN appel réseau réel à Google.
//
// Prouve, dans l'ordre :
//   1. le dialogue Réglages « Partager cet espace » PROPOSE Google Drive
//      (radio « Google Drive (recommandé sur mobile) »), en plus du dossier ;
//   2. solo AVEC données -> `_shareSpaceDrive` (le VRAI `activateShareSpaceDrive`
//      de local-backend.js, pas de raccourci) -> promotion sans perte,
//      workspaceId INCHANGÉ, `storageMode==="org-drive"` APRÈS aller-retour
//      vérifié, owner = moi, `piloteo_storage_mode`/`piloteo_drive_root_folder_id`
//      persistés ;
//   3. échec de la vérification finale (Point 5, `__forceNextVerificationFailure`)
//      -> ROLLBACK : jamais de bascule org-drive, `piloteo_storage_mode`/
//      `piloteo_drive_root_folder_id` NETTOYÉS (comme le rollback de
//      `activateCreateOrgDrive`), solo intact, workspaceId solo inchangé ;
//   4. non-régression : `createDriveOrg` (org neuve, flux indépendant de la
//      promotion) fonctionne toujours, avec un workspaceId DISTINCT.
//
// Usage : node tests/e2e/org-share-space-drive.mjs
//   PW_CHROMIUM=<chemin> pour piloter un binaire Chromium précis.

let _pw;
try { _pw = await import("playwright"); }
catch { _pw = await import("/opt/node22/lib/node_modules/playwright/index.js"); }
const chromium = _pw.chromium || _pw.default.chromium;

import { spawn } from "node:child_process";

const ROOT = new URL("../..", import.meta.url).pathname;
const PORT = 8214;
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

// Même simulateur EN MÉMOIRE de l'API Drive v3 + stub Google Identity
// Services que tests/e2e/org-onboarding-drive.mjs (même sous-ensemble de
// comportement) — injecté AVANT tout script de page (addInitScript).
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
  // `_origFetch`). `window.__driveForFetch` est posé PLUS TARD, en page,
  // avant chaque scénario Drive.
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
              setTimeout(() => opts.callback({ access_token: "fake-e2e-share-space-token", expires_in: 3600 }), 0);
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
  const ctx = await browser.newContext();
  await ctx.addInitScript(initScriptSource);
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  await page.goto(`${BASE}/index.html?solo=1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(() => !!(window.PiloteoDrive && window.PiloteoDrive.isAvailable), { timeout: 5000 });
  await page.click("#piloteo-welcome button").catch(() => {}); // « Continuer » (Travailler seul)
  consoleErrors.length = 0; // bruit de chargement de page, sans rapport avec les scénarios.

  // ==========================================================================
  // 1. Dialogue Réglages « Partager cet espace » : propose Google Drive EN
  //    PLUS du dossier (radio révélée par waitForPiloteoDrive).
  // ==========================================================================
  await page.click("#piloteo-gear");
  await page.waitForSelector("#piloteo-reglages", { timeout: 5000 });
  await page.click('#piloteo-reglages button:has-text("Partager cet espace")');
  await page.waitForSelector("#piloteo-share-space", { timeout: 5000 });
  const driveRadioLabel = page.locator('#piloteo-share-space input[type="radio"][value="drive"]').locator("..");
  await driveRadioLabel.waitFor({ state: "visible", timeout: 5000 });
  const dialogText = await page.locator("#piloteo-share-space").innerText();
  ok(/Google Drive \(recommandé sur mobile\)/i.test(dialogText), "dialogue « Partager cet espace » propose Google Drive");
  ok(/Un dossier \(ordinateur\)/i.test(dialogText), "dialogue « Partager cet espace » propose toujours le dossier");
  await page.click('#piloteo-share-space button:has-text("Annuler")');
  await page.waitForFunction(() => !document.getElementById("piloteo-share-space"), { timeout: 3000 }).catch(() => {});
  await page.evaluate(() => document.getElementById("piloteo-reglages")?.remove());

  // ==========================================================================
  // 2. Solo AVEC données -> `_shareSpaceDrive` (VRAIE `activateShareSpaceDrive`,
  //    via le pas UI de migration réel, boutons Continuer/Fermer cliqués DEPUIS
  //    L'EXTÉRIEUR — même technique que tests/e2e/migration.mjs scénarios
  //    10/11) -> org-drive active, MÊME workspaceId, données visibles, owner=moi.
  // ==========================================================================
  const soloWorkspaceIdBefore = await page.evaluate(() => window.PiloteoLocal._getSoloWorkspaceId());
  ok(typeof soloWorkspaceIdBefore === "string" && soloWorkspaceIdBefore.length > 0,
    `workspaceId solo « cet appareil » persisté AVANT promotion (${soloWorkspaceIdBefore})`);

  const seedResult = await page.evaluate(async () => {
    const current = await (await fetch("/api/state")).json();
    const solo = {};
    Object.keys(current.state).forEach((c) => { solo[c] = []; });
    solo.consultants = [
      { id: "c-drive-promo", nom: "Alice Drive", trigramme: "ADR", statut: "en poste", admin: true, tempsPartiel: [] },
    ];
    solo.saisies = [
      { id: "s-drive-promo-1", date: "2026-08-30", consultantId: "c-drive-promo", type: "interne", missionId: null, categorie: "adm", dureeH: 2, pctFact: 0, commentaire: "" },
    ];
    const put = await (await fetch("/api/state", { method: "PUT", body: JSON.stringify({ state: solo }) })).json();
    return { consultantPresent: (put.state.consultants || []).some((c) => c.id === "c-drive-promo") };
  });
  ok(seedResult.consultantPresent, "donnée solo seedée AVANT promotion (consultant c-drive-promo)");

  await page.evaluate(() => {
    window.__driveForFetch = new window.__FakeDriveE2E();
    window.__scenarioSuccessPromise = window.PiloteoLocal
      ._shareSpaceDrive("Cabinet Partagé Drive E2E")
      .then((r) => ({ ok: true, value: r }))
      .catch((e) => ({ ok: false, error: e && e.message }));
  });

  await page.waitForSelector("#piloteo-migration-message", { timeout: 8000 });
  const introSuccess = await page.textContent("#piloteo-migration-message");
  ok(introSuccess.includes("l'espace partagé"), `message initial nomme la cible (espace partagé, Drive) (reçu: "${introSuccess}")`);
  await page.click('#piloteo-migration-actions button:has-text("Continuer")');
  await page.waitForSelector("#piloteo-migration-result:not([hidden])", { timeout: 10000 });
  const resultSuccess = await page.textContent("#piloteo-migration-result");
  ok(resultSuccess.includes("Migration réussie") || /réussi/i.test(resultSuccess), `résultat succès affiché (reçu: "${resultSuccess}")`);
  await page.click('#piloteo-migration-actions button:has-text("Fermer")');

  const outcomeSuccess = await page.evaluate(async () => {
    const o = await window.__scenarioSuccessPromise;
    if (!o.ok) return { ok: false, error: o.error };
    const me = await (await fetch("/api/me")).json();
    const st = await (await fetch("/api/state")).json();
    const members = await o.value.engine.members();
    const myIdentity = await window.PiloteoOrg.getOrCreateIdentity();
    return {
      ok: true,
      manifestWorkspaceId: o.value.manifest.workspaceId,
      storageMode: window.PiloteoLocal._storageMode(),
      orgDriveStorageMode: window.PiloteoLocal._orgDriveStorageMode(),
      meRole: me.user && me.user.role,
      consultantPresent: (st.state?.consultants || []).some((c) => c.id === "c-drive-promo"),
      consultantCount: st.state.consultants.length,
      storedMode: (() => { try { return localStorage.getItem("piloteo_storage_mode"); } catch (e) { return null; } })(),
      storedRootFolderId: (() => { try { return localStorage.getItem("piloteo_drive_root_folder_id"); } catch (e) { return null; } })(),
      rootFolderId: o.value.rootFolderId,
      ownerRole: (members.find((m) => m.memberId === myIdentity.memberId) || {}).role,
      memberCount: members.length,
    };
  });

  ok(outcomeSuccess.ok, `_shareSpaceDrive() (VRAIE, via le pas UI) résout avec succès (erreur éventuelle: ${outcomeSuccess.error})`);
  if (outcomeSuccess.ok) {
    ok(outcomeSuccess.manifestWorkspaceId === soloWorkspaceIdBefore,
      `workspaceId APRÈS promotion Drive == workspaceId solo D'ORIGINE (${outcomeSuccess.manifestWorkspaceId} vs ${soloWorkspaceIdBefore})`);
    ok(outcomeSuccess.storageMode === "org-drive", `local-backend.js bascule en storageMode="org-drive" après promotion vérifiée (reçu ${outcomeSuccess.storageMode})`);
    ok(outcomeSuccess.orgDriveStorageMode, "_orgDriveStorageMode() reflète l'activation");
    ok(outcomeSuccess.meRole === "admin", `/api/me renvoie role=admin pour l'owner promu (reçu ${outcomeSuccess.meRole})`);
    ok(outcomeSuccess.consultantPresent, "les données solo (consultant c-drive-promo) sont VISIBLES après promotion Drive");
    ok(outcomeSuccess.consultantCount === 1, `aucune perte NI duplication de données (reçu ${outcomeSuccess.consultantCount} consultant(s))`);
    ok(outcomeSuccess.storedMode === "org-drive", "piloteo_storage_mode persisté en localStorage après succès");
    ok(outcomeSuccess.storedRootFolderId === outcomeSuccess.rootFolderId, "piloteo_drive_root_folder_id persisté (== rootFolderId de la promotion)");
    ok(outcomeSuccess.memberCount === 1, `exactement 1 membre après promotion Drive (owner seul) — reçu ${outcomeSuccess.memberCount}`);
    ok(outcomeSuccess.ownerRole === "owner", `owner == identité solo, rôle "owner" depuis le manifeste (reçu ${outcomeSuccess.ownerRole})`);
  }
  const unexpectedSuccessErrors = consoleErrors.filter((e) => !/favicon|brand-logo|gsi\/client|ERR_CONNECTION_RESET/i.test(e));
  ok(unexpectedSuccessErrors.length === 0, `aucune erreur console inattendue pendant la promotion Drive (${unexpectedSuccessErrors.length}/${consoleErrors.length})`);
  if (unexpectedSuccessErrors.length) unexpectedSuccessErrors.slice(0, 5).forEach((e) => console.log("    console:", e));

  // ==========================================================================
  // 3. ROLLBACK : échec de la vérification finale (Point 5,
  //    `__forceNextVerificationFailure`) -> jamais de bascule org-drive,
  //    `piloteo_storage_mode`/`piloteo_drive_root_folder_id` NETTOYÉS, solo
  //    intact, workspaceId solo inchangé. Repart de « cet appareil ».
  // ==========================================================================
  await page.evaluate(() => { window.PiloteoLocal._deactivateOrg(); });
  const rollbackSetup = await page.evaluate(async () => {
    const before = await (await fetch("/api/state")).json();
    const solo = {};
    Object.keys(before.state).forEach((c) => { solo[c] = []; });
    solo.consultants = [{ id: "c-drive-rollback", nom: "Rollback Drive", trigramme: "RBD", statut: "en poste", admin: false, tempsPartiel: [] }];
    const put = await (await fetch("/api/state", { method: "PUT", body: JSON.stringify({ state: solo }) })).json();
    return { consultantPresent: (put.state.consultants || []).some((c) => c.id === "c-drive-rollback") };
  });
  ok(rollbackSetup.consultantPresent, "donnée solo (distincte) seedée AVANT le scénario de rollback");
  const soloWorkspaceIdBeforeRollback = await page.evaluate(() => window.PiloteoLocal._getSoloWorkspaceId());

  consoleErrors.length = 0;
  await page.evaluate(() => {
    window.__driveForFetch = new window.__FakeDriveE2E();
    window.PiloteoMigration.__forceNextVerificationFailure();
    window.__scenarioRollbackPromise = window.PiloteoLocal
      ._shareSpaceDrive("Cabinet Rollback Drive E2E")
      .then((r) => ({ ok: true, value: r }))
      .catch((e) => ({ ok: false, error: e && e.message }));
  });

  await page.waitForSelector("#piloteo-migration-message", { timeout: 8000 });
  await page.click('#piloteo-migration-actions button:has-text("Continuer")');
  await page.waitForSelector("#piloteo-migration-result:not([hidden])", { timeout: 10000 });
  const resultRollback = await page.textContent("#piloteo-migration-result");
  ok(!/Migration réussie/i.test(resultRollback), `résultat d'ÉCHEC affiché, jamais "Migration réussie" (reçu: "${resultRollback}")`);
  await page.click('#piloteo-migration-actions button:has-text("Fermer")');

  const outcomeRollback = await page.evaluate(async () => {
    const o = await window.__scenarioRollbackPromise;
    const st = await (await fetch("/api/state")).json();
    return {
      ok: o.ok,
      error: o.error,
      storageMode: window.PiloteoLocal._storageMode(),
      orgDriveStorageMode: window.PiloteoLocal._orgDriveStorageMode(),
      storedMode: (() => { try { return localStorage.getItem("piloteo_storage_mode"); } catch (e) { return null; } })(),
      storedRootFolderId: (() => { try { return localStorage.getItem("piloteo_drive_root_folder_id"); } catch (e) { return null; } })(),
      consultantStillPresent: (st.state?.consultants || []).some((c) => c.id === "c-drive-rollback"),
    };
  });
  const soloWorkspaceIdAfterRollback = await page.evaluate(() => window.PiloteoLocal._getSoloWorkspaceId());

  ok(!outcomeRollback.ok, "_shareSpaceDrive() est REJETÉE après un échec de vérification (ROLLBACK)");
  ok((outcomeRollback.error || "").includes("perdues"), `l'erreur finale confirme l'absence de perte (reçu: "${outcomeRollback.error}")`);
  ok(outcomeRollback.storageMode !== "org-drive" && !outcomeRollback.orgDriveStorageMode,
    "PAS de bascule en mode org-drive après l'échec du pas UI (ROLLBACK)");
  ok(outcomeRollback.storedMode !== "org-drive", "piloteo_storage_mode NETTOYÉ (plus 'org-drive') après le rollback");
  ok(!outcomeRollback.storedRootFolderId, "piloteo_drive_root_folder_id NETTOYÉ après le rollback (comme le rollback de createDriveOrg)");
  ok(outcomeRollback.consultantStillPresent, "les données solo (consultant c-drive-rollback) restent INTACTES après le rollback");
  ok(soloWorkspaceIdAfterRollback === soloWorkspaceIdBeforeRollback, "workspaceId solo INCHANGÉ après le rollback");

  // ==========================================================================
  // 4. Non-régression : createDriveOrg (org neuve, flux indépendant) marche
  //    toujours, avec un workspaceId DISTINCT de celui de la promotion.
  // ==========================================================================
  const freshOrgResult = await page.evaluate(async () => {
    const drive = new window.__FakeDriveE2E();
    const root = drive.addFolder("Pilotéo - Fresh Org Non-Regression", null);
    const { GoogleDriveStorageAdapter } = await import("/src/storage/google-drive-adapter.js");
    const adapter = new GoogleDriveStorageAdapter({
      oauthTokenProvider: async () => "fake-fresh-org-token", rootFolderId: root, fetchImpl: drive.fetch, sleepFn: async () => {},
    });
    const bobIdentity = await window.PiloteoOrg.__identityStore.create();
    const { manifest } = await window.PiloteoDrive.__createOrgOnAdapter({ adapter, name: "Org Fraîche Drive E2E", consultantId: "c-bob-drive", identity: bobIdentity });
    return { workspaceId: manifest.workspaceId };
  });
  ok(!!freshOrgResult.workspaceId, "createDriveOrg/__createOrgOnAdapter (org neuve) fonctionne toujours (non-régression)");
  ok(freshOrgResult.workspaceId !== soloWorkspaceIdBefore, "org neuve Drive génère un workspaceId DISTINCT de celui de la promotion");

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
