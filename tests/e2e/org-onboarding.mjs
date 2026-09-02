// tests/e2e/org-onboarding.mjs
//
// Smoke E2E navigateur (Playwright + Chromium) du point 2c-C2
// (docs/next/ORG_UI_CONTRACT.md) : prouve, DANS UN VRAI NAVIGATEUR, que
// l'onboarding UI + le câblage du mode Organisation fonctionnent, via le pont
// `piloteo-org-bridge.mjs` (`window.PiloteoOrg`) et ses hooks de test
// (`__openOrgEngineFromHandle`, `__identityStore`), au-dessus d'un
// `FileSystemDirectoryHandle` EN MÉMOIRE (même sous-ensemble d'API que
// tests/e2e/solo-folder.mjs), sans dépendre du sélecteur natif.
//
// Prouve, dans l'ordre :
//   1. l'écran d'accueil (2 cartes — docs/next/PARCOURS_IDENTITE_CONTRACT.md,
//      Lot 1 : « Travailler seul »/« Rejoindre une organisation », « Créer une
//      organisation » n'est plus une carte d'accueil) s'affiche au tout
//      premier lancement, ET le mode classique démarre quand même en dessous
//      (non-régression) ;
//   2. « créer une organisation » : identité générée + persistée, manifeste
//      écrit, /api/me renvoie un role admin, /api/state fonctionne ;
//   3. inviter génère un code non vide ;
//   4. une 2e identité rejoint via ce code et voit les données publiées par
//      la première (convergence) ;
//   5. PUT /api/state d'un membre "user" sur une entité ADMIN_ONLY
//      (consultants) -> 409 (jamais un 200 silencieux).
//
// Usage : node tests/e2e/org-onboarding.mjs
//   PW_CHROMIUM=<chemin> pour piloter un binaire Chromium précis (sinon la
//   résolution Playwright par défaut).

let _pw;
try { _pw = await import("playwright"); }
catch { _pw = await import("/opt/node22/lib/node_modules/playwright/index.js"); }
const chromium = _pw.chromium || _pw.default.chromium;

import { spawn } from "node:child_process";

const ROOT = new URL("../..", import.meta.url).pathname;
const PORT = 8198;
const BASE = `http://127.0.0.1:${PORT}`;

const failures = [];
const ok = (cond, msg) => { if (cond) { console.log("  ✓", msg); } else { failures.push(msg); console.log("  ✗", msg); } };

// Sert le dépôt en statique (aucun serveur métier : exactement ce que sert
// GitHub Pages une fois `_site` assemblé — voir .github/workflows/pages.yml).
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

// Injecté dans la page : fabrique un FAUX FileSystemDirectoryHandle en
// mémoire (même sous-ensemble d'API que tests/e2e/solo-folder.mjs /
// tests/next/fsaccess-port.test.mjs) : getDirectoryHandle/getFileHandle/
// values/createWritable/getFile/queryPermission/requestPermission.
function fakeDirHandleFactorySource() {
  function notFound() { const e = new Error("not found"); e.name = "NotFoundError"; return e; }
  class FakeFileHandle {
    constructor(name) { this.kind = "file"; this.name = name; this._content = ""; this._lastModified = 1000; }
    async getFile() {
      const c = this._content;
      return { size: new TextEncoder().encode(c).length, lastModified: this._lastModified, text: async () => c };
    }
    async createWritable() {
      const self = this; let buf = "";
      return { async write(chunk) { buf += chunk; }, async close() { self._content = buf; self._lastModified += 1; } };
    }
  }
  class FakeDirHandle {
    constructor(name = "root", perm = "granted") { this.kind = "directory"; this.name = name; this._children = new Map(); this._perm = perm; }
    async getDirectoryHandle(name, { create } = {}) {
      let h = this._children.get(name);
      if (h) { if (h.kind !== "directory") throw notFound(); return h; }
      if (!create) throw notFound();
      h = new FakeDirHandle(name); this._children.set(name, h); return h;
    }
    async getFileHandle(name, { create } = {}) {
      let h = this._children.get(name);
      if (h) { if (h.kind !== "file") throw notFound(); return h; }
      if (!create) throw notFound();
      h = new FakeFileHandle(name); this._children.set(name, h); return h;
    }
    async *values() { for (const h of this._children.values()) yield h; }
    async queryPermission() { return this._perm; }
    async requestPermission() { this._perm = "granted"; return "granted"; }
  }
  window.__FakeDirHandle = FakeDirHandle;
}

let browser;
try {
  await waitServer();
  const exe = process.env.PW_CHROMIUM || chromium.executablePath();
  browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  // ==========================================================================
  // 1. Premier lancement : écran d'accueil affiché + mode classique toujours
  //    actif en dessous (non-régression).
  // ==========================================================================
  await page.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  ok(true, "mode classique (par défaut) démarre toujours (non-régression)");

  const welcomeVisible = await page.locator("#piloteo-welcome").isVisible().catch(() => false);
  ok(welcomeVisible, "écran de premier lancement (2 cartes) affiché");
  const cardCount = await page.locator("#piloteo-welcome button").count();
  ok(cardCount === 2, `exactement 2 actions dans l'écran d'accueil, Lot 1 (trouvé ${cardCount})`);
  const createCardAbsent = await page.evaluate(() =>
    !/Créer une organisation/i.test(document.getElementById("piloteo-welcome")?.textContent || ""));
  ok(createCardAbsent, "« Créer une organisation » absente de l'écran d'accueil (Lot 1)");

  // Le pont org a bien chargé.
  await page.waitForFunction(() => !!window.PiloteoOrg, { timeout: 5000 }).catch(() => {});
  const hasOrgBridge = await page.evaluate(() => !!window.PiloteoOrg);
  ok(hasOrgBridge, "window.PiloteoOrg chargé (piloteo-org-bridge.mjs)");
  const hasHooks = await page.evaluate(() =>
    typeof window.PiloteoOrg?.__openOrgEngineFromHandle === "function" &&
    typeof window.PiloteoOrg?.__identityStore?.create === "function");
  ok(hasHooks, "hooks de test exposés (__openOrgEngineFromHandle, __identityStore.create)");

  // Ferme l'écran d'accueil (« Continuer ») : mode classique reste actif, non bloquant.
  await page.click("#piloteo-welcome button");
  await page.waitForFunction(() => !document.getElementById("piloteo-welcome"), { timeout: 3000 }).catch(() => {});
  ok(!(await page.locator("#piloteo-welcome").isVisible().catch(() => false)), "écran d'accueil se ferme (« Continuer »)");

  // Panneau Réglages toujours fonctionnel (non-régression).
  await page.click("#piloteo-gear");
  const panelVisible = await page.locator("#piloteo-reglages").isVisible().catch(() => false);
  ok(panelVisible, "panneau Réglages s'ouvre (non-régression)");
  await page.evaluate(() => document.getElementById("piloteo-reglages")?.remove());

  // ==========================================================================
  // 2. Créer une organisation (handle factice) : identité générée + persistée,
  //    manifeste écrit, /api/me role=admin, /api/state fonctionne.
  // ==========================================================================
  consoleErrors.length = 0;
  // CSP (script-src sans 'unsafe-inline') bloque addScriptTag inline : on passe
  // par page.evaluate (CDP Runtime.evaluate, non soumis à la CSP de la page).
  await page.evaluate(fakeDirHandleFactorySource);

  const createResult = await page.evaluate(async () => {
    const handle = new window.__FakeDirHandle("PiloteoOrgE2E");
    window.__orgHandle = handle; // réutilisé par Bob (scénario 4) — même dossier partagé

    const identityBefore = await window.PiloteoOrg.getOrCreateIdentity();
    const { engine, adapter, manifest } = await window.PiloteoOrg.createOrg({
      handle, name: "Cabinet E2E", consultantId: "c-alice",
    });
    window.__aliceEngine = engine;
    window.__aliceAdapter = adapter;

    // Identité persistée : un second appel renvoie LA MÊME identité (même memberId).
    const identityAfter = await window.PiloteoOrg.getOrCreateIdentity();

    // Publie un consultant + une saisie (comme le ferait l'app via /api/state).
    const load0 = await engine.load();
    const next = {
      ...load0.state,
      consultants: [...load0.state.consultants, { id: "c-alice", nom: "Alice E2E", admin: true }],
    };
    const commit0 = await engine.commit(next);

    // Plug dans local-backend.js (comme _useEngineForTest pour le mode Dossier).
    window.PiloteoLocal._useOrgEngineForTest(engine, adapter);
    const me = await (await fetch("/api/me")).json();
    const st = await (await fetch("/api/state")).json();

    return {
      manifestWorkspaceId: manifest.workspaceId,
      sameIdentity: identityBefore.memberId === identityAfter.memberId,
      commitOk: commit0.ok === true,
      meRole: me.user && me.user.role,
      aliceConsultantPresent: (st.state?.consultants || []).some((c) => c.id === "c-alice"),
      orgStorageMode: window.PiloteoLocal._orgStorageMode(),
    };
  });

  ok(!!createResult.manifestWorkspaceId, "createOrg publie un manifeste (workspaceId présent)");
  ok(createResult.sameIdentity, "identité de membre PERSISTÉE (même memberId entre deux appels)");
  ok(createResult.commitOk, "commit() sur l'org fraîchement créée renvoie ok:true");
  ok(createResult.orgStorageMode, "local-backend.js bascule en storageMode=\"org\"");
  ok(createResult.meRole === "admin", `/api/me renvoie role=admin pour le créateur/owner (reçu ${createResult.meRole})`);
  ok(createResult.aliceConsultantPresent, "/api/state (mode org) renvoie l'état publié sur le dossier");
  ok(consoleErrors.length === 0, `aucune erreur console pendant la création d'organisation (${consoleErrors.length})`);
  if (consoleErrors.length) consoleErrors.slice(0, 5).forEach((e) => console.log("    console:", e));

  // ==========================================================================
  // 3. Inviter -> code non vide.
  // ==========================================================================
  const inviteResult = await page.evaluate(async () => {
    const r = await window.PiloteoOrg.invite({
      engine: window.__aliceEngine, adapter: window.__aliceAdapter, role: "user", ttlDays: 7,
    });
    window.__inviteCode = r.code;
    return { codeLength: (r.code || "").length, hasInvitation: !!r.invitation && !!r.invitation.proof };
  });
  ok(inviteResult.codeLength > 0, `invite() génère un code non vide (longueur ${inviteResult.codeLength})`);
  ok(inviteResult.hasInvitation, "invite() renvoie une invitation signée (proof présent)");

  // ==========================================================================
  // 4. Une 2e identité (Bob) rejoint via ce code, sur le MÊME dossier -> voit
  //    les données publiées par Alice (convergence).
  // ==========================================================================
  const joinResult = await page.evaluate(async () => {
    const bobIdentity = await window.PiloteoOrg.__identityStore.create();
    const { engine, adapter, manifest } = await window.PiloteoOrg.joinOrg({
      handle: window.__orgHandle, invitation: window.__inviteCode, consultantId: "c-bob", identity: bobIdentity,
    });
    window.__bobEngine = engine;
    window.__bobAdapter = adapter;
    window.__bobIdentity = bobIdentity;

    const load = await engine.load();
    const members = await engine.members();
    const aliceIdentity = await window.PiloteoOrg.getOrCreateIdentity();
    return {
      sameWorkspace: manifest.workspaceId === window.__aliceEngine.manifest.workspaceId,
      bobSeesAlice: (load.state.consultants || []).some((c) => c.id === "c-alice"),
      memberCount: members.length,
      bobRole: (members.find((m) => m.memberId === bobIdentity.memberId) || {}).role,
      distinctFromAlice: bobIdentity.memberId !== aliceIdentity.memberId,
    };
  });
  ok(joinResult.sameWorkspace, "Bob rejoint le MÊME workspace qu'Alice");
  ok(joinResult.bobSeesAlice, "Bob (après joinOrg) voit le consultant publié par Alice (convergence)");
  ok(joinResult.memberCount === 2, `members() liste bien 2 membres (Alice + Bob) — reçu ${joinResult.memberCount}`);
  ok(joinResult.bobRole === "user", `Bob a le rôle "user" porté par l'invitation (reçu ${joinResult.bobRole})`);
  ok(joinResult.distinctFromAlice, "l'identité de Bob est distincte de celle d'Alice (2 membres, 2 identités)");

  // ==========================================================================
  // 5. PUT /api/state d'un "user" (Bob) sur une entité ADMIN_ONLY (consultants)
  //    -> 409, jamais 200.
  // ==========================================================================
  const conflict = await page.evaluate(async () => {
    // Plug Bob (role "user") comme moteur actif de local-backend.js.
    window.PiloteoLocal._useOrgEngineForTest(window.__bobEngine, window.__bobAdapter);
    const me = await (await fetch("/api/me")).json();

    const current = await (await fetch("/api/state")).json();
    const nextState = {
      ...current.state,
      // "consultants" est ADMIN_ONLY (src/core/permissions.js) : un "user" ne
      // peut pas y écrire -> la policy du SyncEngine doit rejeter l'événement.
      consultants: [...(current.state.consultants || []), { id: "c-bob-illegal", nom: "Intrus", admin: true }],
    };
    const res = await fetch("/api/state", { method: "PUT", body: JSON.stringify({ state: nextState }) });
    let data = null;
    try { data = await res.json(); } catch {}
    return { meRole: me.user && me.user.role, status: res.status, hasConflicts: Array.isArray(data && data.conflicts) };
  });
  ok(conflict.meRole === "user", `/api/me renvoie role=user pour Bob (reçu ${conflict.meRole})`);
  ok(conflict.status === 409, `PUT /api/state d'un "user" sur une entité admin-only -> 409 (reçu ${conflict.status})`);
  ok(conflict.hasConflicts, "la réponse 409 porte un tableau 'conflicts'");
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
