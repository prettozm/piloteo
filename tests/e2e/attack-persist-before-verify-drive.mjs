// tests/e2e/attack-persist-before-verify-drive.mjs
//
// Repro CONTRARIANT (Lot 5, axe 4 — « persist-avant-vérif ») :
// `piloteo-drive-bridge.mjs#promoteDriveOrg` persistait `piloteo_storage_mode`
// = "org-drive" + `piloteo_drive_root_folder_id` DÈS que la genèse (manifeste
// + fiche owner) était écrite sur Drive — AVANT que
// `local-backend.js#activateShareSpaceDrive` n'ait republié les événements
// solo via `decideAndRunMigration` (Point 5). Or `decideAndRunMigration`
// affiche `showMigrationIntroStep`, qui ATTEND un clic utilisateur
// (« Continuer ») avant de republier le moindre event. Si l'utilisateur
// recharge/ferme l'onglet PENDANT cette attente, le `.catch` de rollback ne
// s'exécute JAMAIS (la navigation tue le JS avant qu'il ne s'exécute) : au
// reboot, le mode était déjà "org-drive", `resumeDriveOrg` réussissait (owner
// légitimement admis, PAS d'usurpation) MAIS l'org était VIDE (events jamais
// republiés) -> `app.js` refusait le démarrage avec « Compte non rattaché à
// un consultant », un message SANS RAPPORT avec la cause réelle.
//
// CORRECTIF : `promoteDriveOrg` n'active plus rien lui-même (il écrit
// seulement la genèse sur Drive et renvoie `rootFolderId`) ;
// `activateShareSpaceDrive` persiste `piloteo_storage_mode`/
// `piloteo_drive_root_folder_id` UNIQUEMENT dans son `.then` FINAL, APRÈS que
// `decideAndRunMigration` a réussi (round-trip vérifié) — EXACTEMENT comme
// `activateShareSpace` (mode Dossier, Lot 2) le fait déjà.
//
// Ce fichier prouve, DANS UN VRAI NAVIGATEUR (rechargement RÉEL de la page,
// pas un stub) :
//   1. AXE 4 (CASSÉ->TENU) : lancer « Partager cet espace » vers Drive,
//      laisser la genèse s'écrire, puis RECHARGER LA PAGE pendant l'attente
//      du clic « Continuer » (jamais cliqué) -> au reboot, le mode reste
//      solo (PAS "org-drive"), `piloteo_storage_mode`/
//      `piloteo_drive_root_folder_id` restent absents, les données solo
//      sont INTACTES, le workspaceId solo est inchangé, `app.js` démarre
//      normalement (pas de "Compte non rattaché").
//   2. Contraste (nominal) : un « Partager » COMPLET (Continuer cliqué,
//      migration vérifiée) bascule bien en "org-drive", données présentes,
//      owner = moi — la correction ne casse pas le chemin heureux.
//
// OAuth (Google Identity Services) et le transport réseau (`fetch` vers
// googleapis.com) sont STUBBÉS (même patron que
// tests/e2e/org-onboarding-drive.mjs / tests/e2e/org-share-space-drive.mjs).
//
// Usage : node tests/e2e/attack-persist-before-verify-drive.mjs
//   PW_CHROMIUM=<chemin> pour piloter un binaire Chromium précis.

let _pw;
try { _pw = await import("playwright"); }
catch { _pw = await import("/opt/node22/lib/node_modules/playwright/index.js"); }
const chromium = _pw.chromium || _pw.default.chromium;

import { spawn } from "node:child_process";

const ROOT = new URL("../..", import.meta.url).pathname;
const PORT = 8215;
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
// Services que tests/e2e/org-onboarding-drive.mjs / org-share-space-drive.mjs
// — injecté AVANT tout script de page (addInitScript, donc rejoué à CHAQUE
// rechargement de page, y compris le rechargement du repro lui-même).
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

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("https://www.googleapis.com/") === 0 && window.__driveForFetch) {
      return window.__driveForFetch.fetch(url, init || {});
    }
    return nativeFetch(input, init);
  };

  window.google = {
    accounts: {
      oauth2: {
        initTokenClient(opts) {
          return {
            requestAccessToken() {
              setTimeout(() => opts.callback({ access_token: "fake-e2e-attack-token", expires_in: 3600 }), 0);
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
  consoleErrors.length = 0;

  // ==========================================================================
  // Préparation : données solo seedées AVANT le repro, workspaceId solo noté.
  // ==========================================================================
  const soloWorkspaceIdBefore = await page.evaluate(() => window.PiloteoLocal._getSoloWorkspaceId());
  ok(typeof soloWorkspaceIdBefore === "string" && soloWorkspaceIdBefore.length > 0,
    `workspaceId solo persisté AVANT le repro (${soloWorkspaceIdBefore})`);

  const seedResult = await page.evaluate(async () => {
    const current = await (await fetch("/api/state")).json();
    const solo = {};
    Object.keys(current.state).forEach((c) => { solo[c] = []; });
    // Champs complets (comme defaultConsultant() côté local-backend.js) —
    // évite un crash de rendu du tableau de bord (app.js, `.toLocaleString()`
    // sur `tjmBase` undefined) SANS RAPPORT avec le repro axe 4 lui-même :
    // ce fichier RECHARGE réellement la page (contrairement aux autres e2e
    // Drive de ce lot, qui n'inspectent l'état QUE via /api/*), donc app.js
    // rend vraiment le tableau de bord au boot.
    solo.consultants = [{ id: "c-axe4", nom: "Axe4 Repro", trigramme: "AX4", statut: "en poste",
      dateEmbauche: "2026-01-01", dateDepart: null, tjmBase: 500, admin: true, tempsPartiel: [] }];
    const put = await (await fetch("/api/state", { method: "PUT", body: JSON.stringify({ state: solo }) })).json();
    return { consultantPresent: (put.state.consultants || []).some((c) => c.id === "c-axe4") };
  });
  ok(seedResult.consultantPresent, "donnée solo (c-axe4) seedée AVANT le repro");

  // ==========================================================================
  // 1. AXE 4 (CASSÉ->TENU) : lance `_shareSpaceDrive` (VRAIE
  //    `activateShareSpaceDrive`), SANS attendre sa résolution — la genèse
  //    Drive s'écrit (OAuth stubbé + fetch routé vers FakeDrive), puis
  //    `decideAndRunMigration` affiche l'overlay et ATTEND le clic
  //    « Continuer ». On ne clique JAMAIS : on RECHARGE LA PAGE pendant cette
  //    attente (kill du JS en plein vol, exactement le repro contrariant).
  // ==========================================================================
  await page.evaluate(() => {
    window.__driveForFetch = new window.__FakeDriveE2E();
    // Fire-and-forget : la promesse n'est JAMAIS attendue/renvoyée par cet
    // evaluate() — c'est précisément ce qui doit survivre (ou pas) au reload.
    window.__axe4Promise = window.PiloteoLocal._shareSpaceDrive("Cabinet Axe4 Repro").catch(() => {});
  });

  await page.waitForSelector("#piloteo-migration-message", { timeout: 8000 });
  ok(true, "l'overlay de migration apparaît (genèse Drive déjà écrite, en attente du clic « Continuer »)");

  // Sanity AVANT reload (ce que le contrariant a trouvé cassé) : à ce stade,
  // AVANT le correctif, le mode aurait déjà été "org-drive" en localStorage.
  const beforeReload = await page.evaluate(() => ({
    storedMode: (() => { try { return localStorage.getItem("piloteo_storage_mode"); } catch (e) { return null; } })(),
    storedRootFolderId: (() => { try { return localStorage.getItem("piloteo_drive_root_folder_id"); } catch (e) { return null; } })(),
    storageMode: window.PiloteoLocal._storageMode(),
  }));
  ok(beforeReload.storedMode !== "org-drive",
    `CORRECTIF (avant même le reload) : piloteo_storage_mode PAS encore "org-drive" pendant l'attente du clic (reçu ${beforeReload.storedMode})`);
  ok(!beforeReload.storedRootFolderId,
    `CORRECTIF (avant même le reload) : piloteo_drive_root_folder_id PAS encore persisté pendant l'attente du clic (reçu ${beforeReload.storedRootFolderId})`);

  // Le rechargement RÉEL — kill le JS en plein vol, JAMAIS de clic Continuer,
  // JAMAIS d'exécution du .catch de rollback.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });

  const afterReload = await page.evaluate(async () => {
    const st = await (await fetch("/api/state")).json();
    const me = await (await fetch("/api/me")).json();
    return {
      storageMode: window.PiloteoLocal._storageMode(),
      orgDriveStorageMode: window.PiloteoLocal._orgDriveStorageMode(),
      storedMode: (() => { try { return localStorage.getItem("piloteo_storage_mode"); } catch (e) { return null; } })(),
      storedRootFolderId: (() => { try { return localStorage.getItem("piloteo_drive_root_folder_id"); } catch (e) { return null; } })(),
      consultantPresent: (st.state?.consultants || []).some((c) => c.id === "c-axe4"),
      consultantCount: (st.state?.consultants || []).length,
      meOk: me && me.user && !me.error,
      soloWorkspaceIdAfter: window.PiloteoLocal._getSoloWorkspaceId ? await window.PiloteoLocal._getSoloWorkspaceId() : null,
    };
  });

  ok(afterReload.storageMode !== "org-drive", `AXE 4 TENU : au reboot après reload, le mode N'EST PAS "org-drive" (reçu ${afterReload.storageMode})`);
  ok(!afterReload.orgDriveStorageMode, "AXE 4 TENU : _orgDriveStorageMode() est faux après le reboot");
  ok(afterReload.storedMode !== "org-drive", `AXE 4 TENU : piloteo_storage_mode reste PAS "org-drive" en localStorage après le reboot (reçu ${afterReload.storedMode})`);
  ok(!afterReload.storedRootFolderId, `AXE 4 TENU : piloteo_drive_root_folder_id reste ABSENT après le reboot (reçu ${afterReload.storedRootFolderId})`);
  ok(afterReload.consultantPresent, "AXE 4 TENU : la donnée solo (c-axe4) est INTACTE après le reboot (jamais perdue dans un org-drive vide inaccessible)");
  ok(afterReload.consultantCount === 1, `AXE 4 TENU : aucune donnée fantôme/dupliquée après le reboot (reçu ${afterReload.consultantCount} consultant(s))`);
  ok(afterReload.meOk, "AXE 4 TENU : /api/me répond normalement après le reboot (jamais le crash « Compte non rattaché à un consultant » d'un org-drive vide)");
  ok(afterReload.soloWorkspaceIdAfter === soloWorkspaceIdBefore, "AXE 4 TENU : workspaceId solo INCHANGÉ après le reboot (la genèse Drive orpheline, write-once, est inoffensive)");

  // `page.reload()` (repro axe 4 ci-dessus) redéclenche un 404 réseau bénin
  // déjà connu (`/brand-logo`, absent en statique) à chaque chargement ;
  // Chromium le logue en console sans exposer l'URL (message générique
  // "Failed to load resource…") — même filtre que tests/e2e/auth-session.mjs
  // (seul fichier de la suite, avec celui-ci, à recharger réellement la page).
  const unexpectedAxe4Errors = consoleErrors.filter((e) => e.indexOf("Failed to load resource") === -1);
  ok(unexpectedAxe4Errors.length === 0, `aucune erreur console inattendue pendant le repro axe 4 (${unexpectedAxe4Errors.length}/${consoleErrors.length})`);
  if (unexpectedAxe4Errors.length) unexpectedAxe4Errors.slice(0, 5).forEach((e) => console.log("    console:", e));

  // ==========================================================================
  // 2. CONTRASTE (nominal) : un « Partager » COMPLET (Continuer cliqué,
  //    migration vérifiée) bascule bien en "org-drive" — la correction ne
  //    casse pas le chemin heureux. (Dismiss l'écran d'accueil réapparu au
  //    reboot solo — comportement normal du mode solo, sans rapport avec le
  //    repro.)
  // ==========================================================================
  await page.click("#piloteo-welcome button").catch(() => {});
  consoleErrors.length = 0;
  await page.evaluate(() => {
    window.__driveForFetch = new window.__FakeDriveE2E();
    window.__nominalPromise = window.PiloteoLocal
      ._shareSpaceDrive("Cabinet Axe4 Nominal")
      .then((r) => ({ ok: true, value: r }))
      .catch((e) => ({ ok: false, error: e && e.message }));
  });
  await page.waitForSelector("#piloteo-migration-message", { timeout: 8000 });
  await page.click('#piloteo-migration-actions button:has-text("Continuer")');
  await page.waitForSelector("#piloteo-migration-result:not([hidden])", { timeout: 10000 });
  const resultNominal = await page.textContent("#piloteo-migration-result");
  ok(/réussi/i.test(resultNominal), `résultat succès affiché (reçu: "${resultNominal}")`);
  await page.click('#piloteo-migration-actions button:has-text("Fermer")');

  const nominalOutcome = await page.evaluate(async () => {
    const o = await window.__nominalPromise;
    if (!o.ok) return { ok: false, error: o.error };
    const me = await (await fetch("/api/me")).json();
    const members = await o.value.engine.members();
    const myIdentity = await window.PiloteoOrg.getOrCreateIdentity();
    return {
      ok: true,
      storageMode: window.PiloteoLocal._storageMode(),
      storedMode: (() => { try { return localStorage.getItem("piloteo_storage_mode"); } catch (e) { return null; } })(),
      storedRootFolderId: (() => { try { return localStorage.getItem("piloteo_drive_root_folder_id"); } catch (e) { return null; } })(),
      rootFolderId: o.value.rootFolderId,
      meRole: me.user && me.user.role,
      ownerRole: (members.find((m) => m.memberId === myIdentity.memberId) || {}).role,
    };
  });
  ok(nominalOutcome.ok, `nominal complet résout avec succès (erreur éventuelle: ${nominalOutcome.error})`);
  if (nominalOutcome.ok) {
    ok(nominalOutcome.storageMode === "org-drive", `bascule bien en storageMode="org-drive" après migration COMPLÈTE (reçu ${nominalOutcome.storageMode})`);
    ok(nominalOutcome.storedMode === "org-drive", "piloteo_storage_mode persisté après le SEUL .then final (chemin heureux non cassé)");
    ok(nominalOutcome.storedRootFolderId === nominalOutcome.rootFolderId, "piloteo_drive_root_folder_id persisté (== rootFolderId de la promotion)");
    ok(nominalOutcome.meRole === "admin", `/api/me renvoie role=admin (reçu ${nominalOutcome.meRole})`);
    ok(nominalOutcome.ownerRole === "owner", `owner == identité solo (reçu ${nominalOutcome.ownerRole})`);
  }

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
