// tests/e2e/invite-ui.mjs
//
// Smoke E2E navigateur (Playwright + Chromium) du Lot 4 (invite UI enrichie,
// docs/next/PARCOURS_IDENTITE_CONTRACT.md) : Réglages > Membres > Inviter
// (nom, sélecteur de rôle Administrateur/Utilisateur, sélecteur
// consultant/global) exercée à travers le VRAI DOM (`local-backend.js`), au
// dessus d'un `FileSystemDirectoryHandle` EN MÉMOIRE — même harnais que
// tests/e2e/org-onboarding.mjs.
//
// Prouve, dans l'ordre :
//   1. l'UI d'invite affiche Nom + Rôle (Administrateur/Utilisateur) + le
//      sélecteur consultant/global QUAND rôle="Utilisateur" (masqué pour
//      "Administrateur") ;
//   2. owner invite un "user rattaché à c-x" (nom saisi) -> le membre qui
//      consomme le code est admis avec consultantId=c-x (vue restreinte) ;
//   3. owner invite un "user global" (nom saisi) -> admis avec scope=global,
//      /api/me lui présente role:"admin" (vue métier complète, mapping ARRÊTÉ
//      Lot 3) MAIS le rôle org RÉEL reste "user" (pas de gouvernance) ;
//   4. owner invite un "admin" (nom saisi) -> admis avec role=admin, VOIT
//      Inviter/Révoquer (gouvernance), contrairement au "user global" ;
//   5. les 3 noms saisis apparaissent dans la liste des membres (Réglages),
//      avec la distinction Administrateur / Utilisateur (consultant X) /
//      Utilisateur (accès global).
//
// Usage : node tests/e2e/invite-ui.mjs
//   PW_CHROMIUM=<chemin> pour piloter un binaire Chromium précis (sinon la
//   résolution Playwright par défaut).

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

// Identique à tests/e2e/org-onboarding.mjs (même sous-ensemble d'API que
// tests/e2e/solo-folder.mjs / tests/next/fsaccess-port.test.mjs).
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

  await page.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(() => !!window.PiloteoOrg, { timeout: 5000 }).catch(() => {});

  // Ferme l'écran d'accueil (non testé ici, cf. org-onboarding.mjs Lot 1).
  await page.click("#piloteo-welcome button").catch(() => {});
  await page.waitForFunction(() => !document.getElementById("piloteo-welcome"), { timeout: 3000 }).catch(() => {});

  await page.evaluate(fakeDirHandleFactorySource);
  // Boot terminé (chargement page, enregistrement SW best-effort…) : on
  // repart d'un compteur propre pour juger UNIQUEMENT le scénario Lot 4
  // ci-dessous (même pratique que tests/e2e/org-onboarding.mjs).
  consoleErrors.length = 0;

  // ==========================================================================
  // Setup : Alice crée l'organisation, publie 2 consultants (X, Y) —
  // nécessaires au sélecteur "Rattaché à un consultant".
  // ==========================================================================
  const setup = await page.evaluate(async () => {
    const handle = new window.__FakeDirHandle("PiloteoInviteUiE2E");
    window.__orgHandle = handle;
    const { engine, adapter } = await window.PiloteoOrg.createOrg({ handle, name: "Cabinet Invite UI", consultantId: "c-owner" });
    window.__aliceEngine = engine;
    window.__aliceAdapter = adapter;
    const load0 = await engine.load();
    const next = {
      ...load0.state,
      consultants: [...load0.state.consultants, { id: "c-x", nom: "X" }, { id: "c-y", nom: "Y" }],
    };
    const commit0 = await engine.commit(next);
    window.PiloteoLocal._useOrgEngineForTest(engine, adapter);
    return { commitOk: commit0.ok === true };
  });
  ok(setup.commitOk, "Alice crée l'organisation et publie 2 consultants (X, Y)");

  // Ouvre Réglages (Alice, owner, active).
  async function openReglages() {
    await page.evaluate(() => { const p = document.getElementById("piloteo-reglages"); if (p) p.remove(); });
    await page.click("#piloteo-gear");
    await page.waitForSelector("#piloteo-reglages", { timeout: 5000 });
  }
  async function closeReglages() {
    await page.evaluate(() => { const p = document.getElementById("piloteo-reglages"); if (p) p.remove(); });
  }

  await openReglages();

  // ==========================================================================
  // 1. Structure de l'UI d'invite : Nom + Rôle (Administrateur/Utilisateur) +
  //    sélecteur consultant/global visible pour "Utilisateur", masqué pour
  //    "Administrateur".
  // ==========================================================================
  const hasNameField = await page.locator("#piloteo-invite-name").count() === 1;
  ok(hasNameField, "champ Nom présent dans l'invite UI");
  const roleOptions = await page.locator("#piloteo-invite-role option").allTextContents();
  ok(roleOptions.length === 2 && roleOptions.includes("Administrateur") && roleOptions.includes("Utilisateur"),
    `sélecteur Rôle = Administrateur/Utilisateur (reçu ${JSON.stringify(roleOptions)})`);

  // Le sélecteur consultant/global se peuple de façon async (projection) :
  // attend au moins 3 options (2 consultants + "Accès global").
  await page.waitForFunction(() => {
    const sel = document.getElementById("piloteo-invite-target");
    return sel && sel.options.length >= 3;
  }, { timeout: 5000 });
  const targetOptionsUser = await page.locator("#piloteo-invite-target option").allTextContents();
  ok(targetOptionsUser.includes("X") && targetOptionsUser.includes("Y") && targetOptionsUser.includes("Accès global"),
    `sélecteur consultant/global peuplé (consultants + « Accès global ») — reçu ${JSON.stringify(targetOptionsUser)}`);
  const targetVisibleForUser = await page.locator("#piloteo-invite-target").isVisible();
  ok(targetVisibleForUser, "sélecteur consultant/global VISIBLE quand rôle = Utilisateur");

  await page.selectOption("#piloteo-invite-role", "admin");
  const targetVisibleForAdmin = await page.locator("#piloteo-invite-target").isVisible();
  ok(!targetVisibleForAdmin, "sélecteur consultant/global MASQUÉ quand rôle = Administrateur");
  await page.selectOption("#piloteo-invite-role", "user"); // remet "Utilisateur" pour la suite.

  // ==========================================================================
  // 2. Owner invite un "user rattaché à c-x", nommé "Consultant X User".
  // ==========================================================================
  await page.fill("#piloteo-invite-name", "Consultant X User");
  await page.selectOption("#piloteo-invite-target", "c-x");
  await page.click("#piloteo-invite-btn");
  await page.waitForSelector("#piloteo-invite-code", { timeout: 5000 });
  const codeRattache = await page.locator("#piloteo-invite-code").inputValue();
  ok(codeRattache.length > 0, "code généré pour l'invitation « user rattaché »");
  await closeReglages();

  const bobResult = await page.evaluate(async (code) => {
    const bobIdentity = await window.PiloteoOrg.__identityStore.create();
    const { engine, adapter, manifest } = await window.PiloteoOrg.joinOrg({ handle: window.__orgHandle, invitation: code, identity: bobIdentity });
    window.__bobEngine = engine; window.__bobAdapter = adapter; window.__bobIdentity = bobIdentity;
    window.PiloteoLocal._useOrgEngineForTest(engine, adapter);
    const me = await (await fetch("/api/me")).json();
    return {
      sameWorkspace: manifest.workspaceId === window.__aliceEngine.manifest.workspaceId,
      membershipRole: engine.membership.role,
      membershipConsultantId: engine.membership.consultantId,
      membershipScope: engine.membership.scope,
      meRole: me.user && me.user.role,
      meConsultantId: me.user && me.user.consultant_id,
    };
  }, codeRattache);
  ok(bobResult.sameWorkspace, "Bob (user rattaché) rejoint le même workspace qu'Alice");
  ok(bobResult.membershipRole === "user", `Bob a le rôle org réel "user" (reçu ${bobResult.membershipRole})`);
  ok(bobResult.membershipConsultantId === "c-x", `Bob est rattaché à c-x (reçu ${bobResult.membershipConsultantId})`);
  ok(bobResult.membershipScope === null, `Bob n'a PAS scope="global" (reçu ${bobResult.membershipScope})`);
  ok(bobResult.meRole === "user", `/api/me : role="user" pour Bob (vue restreinte, reçu ${bobResult.meRole})`);
  ok(bobResult.meConsultantId === "c-x", `/api/me : consultant_id="c-x" pour Bob (vue restreinte à X, reçu ${bobResult.meConsultantId})`);

  // ==========================================================================
  // 3. Owner invite un "user global", nommé "Utilisateur Global".
  // ==========================================================================
  await page.evaluate(() => { window.PiloteoLocal._useOrgEngineForTest(window.__aliceEngine, window.__aliceAdapter); });
  await openReglages();
  await page.fill("#piloteo-invite-name", "Utilisateur Global");
  await page.selectOption("#piloteo-invite-role", "user");
  await page.waitForFunction(() => document.getElementById("piloteo-invite-target").options.length >= 3, { timeout: 5000 });
  await page.selectOption("#piloteo-invite-target", "__global__");
  await page.click("#piloteo-invite-btn");
  await page.waitForSelector("#piloteo-invite-code", { timeout: 5000 });
  const codeGlobal = await page.locator("#piloteo-invite-code").inputValue();
  ok(codeGlobal.length > 0, "code généré pour l'invitation « user global »");
  await closeReglages();

  const carolResult = await page.evaluate(async (code) => {
    const carolIdentity = await window.PiloteoOrg.__identityStore.create();
    const { engine, adapter } = await window.PiloteoOrg.joinOrg({ handle: window.__orgHandle, invitation: code, identity: carolIdentity });
    window.__carolEngine = engine; window.__carolAdapter = adapter; window.__carolIdentity = carolIdentity;
    window.PiloteoLocal._useOrgEngineForTest(engine, adapter);
    const me = await (await fetch("/api/me")).json();
    return {
      membershipRole: engine.membership.role,
      membershipConsultantId: engine.membership.consultantId,
      membershipScope: engine.membership.scope,
      meRole: me.user && me.user.role,
    };
  }, codeGlobal);
  ok(carolResult.membershipRole === "user", `Carol a le rôle org réel "user" (pas admin) — reçu ${carolResult.membershipRole}`);
  ok(carolResult.membershipConsultantId === null, `Carol n'est rattachée à AUCUN consultant (reçu ${carolResult.membershipConsultantId})`);
  ok(carolResult.membershipScope === "global", `Carol a scope="global" (reçu ${carolResult.membershipScope})`);
  ok(carolResult.meRole === "admin", `/api/me : role="admin" pour Carol (vue métier complète, mapping ARRÊTÉ Lot 3 — reçu ${carolResult.meRole})`);

  // Carol (user global, rôle org réel "user") NE VOIT NI Inviter NI Révoquer
  // (gouvernance lue sur le VRAI rôle org, pas sur /api/me qui ment pour app.js).
  await openReglages();
  const carolSeesInvite = await page.locator("#piloteo-invite-btn").count() > 0;
  ok(!carolSeesInvite, "Carol (user global) NE VOIT PAS le bouton « Inviter » (pas de gouvernance)");
  await closeReglages();

  // ==========================================================================
  // 4. Owner invite un "admin", nommé "Admin Two".
  // ==========================================================================
  await page.evaluate(() => { window.PiloteoLocal._useOrgEngineForTest(window.__aliceEngine, window.__aliceAdapter); });
  await openReglages();
  await page.fill("#piloteo-invite-name", "Admin Two");
  await page.selectOption("#piloteo-invite-role", "admin");
  await page.click("#piloteo-invite-btn");
  await page.waitForSelector("#piloteo-invite-code", { timeout: 5000 });
  const codeAdmin = await page.locator("#piloteo-invite-code").inputValue();
  ok(codeAdmin.length > 0, "code généré pour l'invitation « admin »");
  await closeReglages();

  const daveResult = await page.evaluate(async (code) => {
    const daveIdentity = await window.PiloteoOrg.__identityStore.create();
    const { engine, adapter } = await window.PiloteoOrg.joinOrg({ handle: window.__orgHandle, invitation: code, identity: daveIdentity });
    window.__daveEngine = engine; window.__daveAdapter = adapter; window.__daveIdentity = daveIdentity;
    window.PiloteoLocal._useOrgEngineForTest(engine, adapter);
    const me = await (await fetch("/api/me")).json();
    return { membershipRole: engine.membership.role, meRole: me.user && me.user.role };
  }, codeAdmin);
  ok(daveResult.membershipRole === "admin", `Dave a le rôle org réel "admin" (reçu ${daveResult.membershipRole})`);
  ok(daveResult.meRole === "admin", `/api/me : role="admin" pour Dave (reçu ${daveResult.meRole})`);

  await openReglages();
  const daveSeesInvite = await page.locator("#piloteo-invite-btn").count() > 0;
  ok(daveSeesInvite, "Dave (admin réel) VOIT le bouton « Inviter » (gouvernance)");
  await closeReglages();

  // ==========================================================================
  // 5. Les noms saisis apparaissent dans la liste des membres (Réglages),
  //    avec la distinction rôle/portée. `members()` reflète l'état de la
  //    gouvernance AU MOMENT DE `openOrgEngine` (org-engine.js, décision 5) :
  //    l'engine d'Alice, ouvert AVANT que Bob/Carol/Dave rejoignent, ne les
  //    verrait pas — on rouvre donc une session fraîche (même identité,
  //    `openOrg`) pour voir la gouvernance à jour, exactement comme le
  //    ferait un membre qui revient plus tard.
  // ==========================================================================
  const reopened = await page.evaluate(async () => {
    const { engine, adapter } = await window.PiloteoOrg.openOrg({ handle: window.__orgHandle });
    window.PiloteoLocal._useOrgEngineForTest(engine, adapter);
    const members = await engine.members();
    return { memberCount: members.length };
  });
  ok(reopened.memberCount === 4, `session ré-ouverte voit les 4 membres (Alice/Bob/Carol/Dave) — reçu ${reopened.memberCount}`);
  await openReglages();
  // Attend que renderMembers ait fini (4 membres : Alice/Bob/Carol/Dave).
  await page.waitForFunction(() => {
    const box = document.getElementById("piloteo-reglages");
    return box && /Consultant X User/.test(box.textContent) && /Utilisateur Global/.test(box.textContent) && /Admin Two/.test(box.textContent);
  }, { timeout: 5000 });
  // Le libellé rôle/portée porte `text-transform:uppercase` en CSS —
  // `innerText` (Playwright) restitue le texte TEL QU'AFFICHÉ (donc en
  // majuscules) : comparaison insensible à la casse.
  const membersText = await page.locator("#piloteo-reglages").innerText();
  ok(membersText.includes("Consultant X User"), "le nom « Consultant X User » (user rattaché) apparaît dans la liste des membres");
  ok(membersText.includes("Utilisateur Global"), "le nom « Utilisateur Global » apparaît dans la liste des membres");
  ok(membersText.includes("Admin Two"), "le nom « Admin Two » apparaît dans la liste des membres");
  ok(/utilisateur \(consultant x\)/i.test(membersText), "libellé « Utilisateur (consultant X) » pour le membre rattaché");
  ok(/utilisateur \(accès global\)/i.test(membersText), "libellé « Utilisateur (accès global) » pour le membre global");
  ok(/administrateur/i.test(membersText), "libellé « Administrateur » présent pour Dave");
  await closeReglages();

  ok(consoleErrors.length === 0, `aucune erreur console pendant le scénario (${consoleErrors.length})`);
  if (consoleErrors.length) consoleErrors.slice(0, 5).forEach((e) => console.log("    console:", e));
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
