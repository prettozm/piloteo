// tests/e2e/reglages-reset-share-dialog.mjs
//
// Couvre deux correctifs UX signalés en test grandeur nature :
//   1. « Partager cet espace » (le VRAI dialogue Réglages, pas le hook
//      `_shareSpace`) ne doit PAS rester bloqué sur « Sélection du dossier… » :
//      l'étape de migration (« Continuer », plein écran) doit s'afficher AU-
//      DESSUS et le dialogue doit se fermer (bug de z-index : le dialogue
//      2147483006 masquait l'étape de migration 2147483005).
//   2. Réglages › « Réinitialiser cet appareil » (hook `_resetLocalData`)
//      efface les clés localStorage Pilotéo de CE navigateur.
//
// Usage : node tests/e2e/reglages-reset-share-dialog.mjs
//   PW_CHROMIUM=<chemin> pour un binaire Chromium précis.

let _pw;
try { _pw = await import("playwright"); }
catch { _pw = await import("/opt/node22/lib/node_modules/playwright/index.js"); }
const chromium = _pw.chromium || _pw.default.chromium;

import { spawn } from "node:child_process";

const ROOT = new URL("../..", import.meta.url).pathname;
const PORT = 8207;
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

function fakeDirHandleFactorySource() {
  function notFound() { const e = new Error("not found"); e.name = "NotFoundError"; return e; }
  class FakeFileHandle {
    constructor(name) { this.kind = "file"; this.name = name; this._content = ""; this._lastModified = 1000; }
    async getFile() { const c = this._content; return { size: new TextEncoder().encode(c).length, lastModified: this._lastModified, text: async () => c }; }
    async createWritable() { const self = this; let buf = ""; return { async write(chunk) { buf += chunk; }, async close() { self._content = buf; self._lastModified += 1; } }; }
  }
  class FakeDirHandle {
    constructor(name = "root", perm = "granted") { this.kind = "directory"; this.name = name; this._children = new Map(); this._perm = perm; }
    async getDirectoryHandle(name, { create } = {}) { let h = this._children.get(name); if (h) { if (h.kind !== "directory") throw notFound(); return h; } if (!create) throw notFound(); h = new FakeDirHandle(name); this._children.set(name, h); return h; }
    async getFileHandle(name, { create } = {}) { let h = this._children.get(name); if (h) { if (h.kind !== "file") throw notFound(); return h; } if (!create) throw notFound(); h = new FakeFileHandle(name); this._children.set(name, h); return h; }
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
  page.on("dialog", (d) => d.accept()); // window.confirm / alert -> accepter

  await page.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(() => !!window.PiloteoOrg && !!window.PiloteoLocal, { timeout: 5000 });
  // Fermer l'accueil (Travailler seul).
  await page.click("#piloteo-welcome button").catch(() => {});
  await page.waitForFunction(() => !document.getElementById("piloteo-welcome"), { timeout: 3000 }).catch(() => {});

  // Handle factice + stub du sélecteur natif (indisponible en headless).
  await page.evaluate(fakeDirHandleFactorySource);
  await page.evaluate(() => {
    const h = new window.__FakeDirHandle("PiloteoShareDialogE2E");
    window.PiloteoOrg.pickDirectory = async () => h;
  });

  // ==========================================================================
  // 1. Dialogue « Partager cet espace » : ne reste PAS bloqué, l'étape de
  //    migration s'affiche au-dessus, le dialogue se ferme.
  // ==========================================================================
  await page.click("#piloteo-gear");
  await page.waitForSelector("#piloteo-reglages", { timeout: 5000 });
  await page.locator("#piloteo-reglages button", { hasText: /^Partager cet espace$/ }).click();
  await page.waitForSelector("#piloteo-share-space", { timeout: 5000 });
  ok(true, "dialogue « Partager cet espace » ouvert");

  // Remplir le nom (seul champ texte du dialogue) + cliquer le bouton « Partager »
  // (texte EXACT — ne pas confondre avec le titre « Partager cet espace »).
  await page.fill("#piloteo-share-space input[type=text]", "Toti");
  await page.locator("#piloteo-share-space button", { hasText: /^Partager$/ }).click();

  // Le dialogue doit se fermer ET l'étape de migration apparaître AU-DESSUS.
  await page.waitForFunction(() => !document.getElementById("piloteo-share-space"), { timeout: 8000 }).catch(() => {});
  const dialogGone = await page.evaluate(() => !document.getElementById("piloteo-share-space"));
  ok(dialogGone, "le dialogue « Partager » se ferme quand l'action démarre (plus de blocage sur « Sélection du dossier… »)");

  await page.waitForSelector("#piloteo-migration-step", { timeout: 8000 });
  const continueReachable = await page.evaluate(() => {
    const ov = document.getElementById("piloteo-migration-step");
    if (!ov) return false;
    const z = parseInt(getComputedStyle(ov).zIndex || "0", 10);
    const btn = Array.from(ov.querySelectorAll("button")).find((b) => /continuer/i.test(b.textContent || ""));
    return !!btn && btn.offsetParent !== null && z > 2147483006;
  });
  ok(continueReachable, "l'étape de migration (« Continuer ») est visible et cliquable AU-DESSUS du dialogue (z-index corrigé)");

  // Le flux complet de promotion (jusqu'à org active) est déjà couvert par
  // org-promotion.mjs (chemin hook). Ici on valide seulement que l'étape de
  // migration est INTERACTIVE (le bug était qu'elle restait masquée) : on
  // l'annule proprement -> retour à cet appareil (solo), aucune donnée perdue.
  await page.locator("#piloteo-migration-step button", { hasText: /^Annuler$/ }).click();
  await page.waitForFunction(() => !document.getElementById("piloteo-migration-step"), { timeout: 8000 }).catch(() => {});
  const backToSolo = await page.evaluate(() => window.PiloteoLocal._storageMode() == null);
  ok(backToSolo, "« Annuler » sur la migration -> retour à cet appareil (solo), données intactes");

  // ==========================================================================
  // 2. Réinitialiser cet appareil : efface les clés localStorage Pilotéo.
  // ==========================================================================
  await page.evaluate(() => {
    try { localStorage.setItem("piloteo_test_marker", "1"); } catch (e) {}
    try { localStorage.setItem("piloteo_storage_mode", "org"); } catch (e) {}
  });
  const beforeKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => /piloteo/i.test(k)).length);
  ok(beforeKeys > 0, `des clés localStorage Pilotéo existent avant reset (${beforeKeys})`);

  await page.evaluate(() => window.PiloteoLocal._resetLocalData());
  const afterKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => /piloteo/i.test(k)).length);
  ok(afterKeys === 0, `après _resetLocalData(), plus aucune clé localStorage Pilotéo (${afterKeys})`);

  await browser.close();
  srv.kill();
  if (failures.length) { console.log("\nÉCHECS :", failures.length); process.exit(1); }
  console.log("\nOK");
  process.exit(0);
} catch (e) {
  console.error("ERREUR :", e && e.stack || e);
  try { if (browser) await browser.close(); } catch {}
  srv.kill();
  process.exit(1);
}
