// tests/e2e/solo-folder.mjs
//
// Smoke E2E navigateur (Playwright + Chromium) du point 1b
// (docs/next/CONVERGENCE_CONTRACT.md §6bis) : prouve, DANS UN VRAI NAVIGATEUR,
// que le pont `piloteo-solo-bridge.mjs` (`window.PiloteoNext`) fait tourner un
// aller-retour commit -> load du mode Dossier au-dessus d'un
// FileSystemDirectoryHandle EN MÉMOIRE (même sous-ensemble d'API que
// tests/next/fsaccess-port.test.mjs), sans dépendre du sélecteur natif — via
// le hook de test `__engineFromHandle`. Vérifie aussi la non-régression : le
// mode classique (par défaut, sans dossier) démarre toujours et le panneau
// Réglages s'ouvre.
//
// Usage : node tests/e2e/solo-folder.mjs
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

// Construit un état complet (12 collections) avec UN consultant, comme l'exige
// app.js (au moins un consultant rattaché) et comme le prescrit le contrat.
function buildState() {
  const state = {
    consultants: [{
      id: "c-e2e", nom: "E2E Testeur", trigramme: "E2E", statut: "en poste",
      dateEmbauche: "2026-01-01", dateDepart: null, tjmBase: 500, admin: true, tempsPartiel: [],
    }],
    organisations: [], affaires: [], methodes: [], typesTerritoire: [],
    domainesIntervention: [], categoriesFrais: [], missions: [], factures: [],
    saisies: [], bordereauxFrais: [], notesFrais: [],
  };
  return state;
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

  // --- démarrage en mode solo classique (par défaut, aucun dossier) ---------
  await page.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  ok(true, "mode classique (par défaut) démarre toujours");

  // --- le pont module a bien chargé -----------------------------------------
  await page.waitForFunction(() => !!window.PiloteoNext, { timeout: 5000 }).catch(() => {});
  const hasBridge = await page.evaluate(() => !!window.PiloteoNext);
  ok(hasBridge, "window.PiloteoNext chargé (piloteo-solo-bridge.mjs)");
  const hasHook = await page.evaluate(() => typeof window.PiloteoNext?.__engineFromHandle === "function");
  ok(hasHook, "__engineFromHandle exposé (hook de test)");

  // --- non-régression : le panneau Réglages s'ouvre -------------------------
  await page.click("#piloteo-gear");
  const panelVisible = await page.locator("#piloteo-reglages").isVisible().catch(() => false);
  ok(panelVisible, "panneau Réglages s'ouvre (non-régression)");
  await page.evaluate(() => document.getElementById("piloteo-reglages")?.remove());

  // --- mode Dossier : aller-retour commit -> load sur un handle en mémoire --
  consoleErrors.length = 0;
  const seedState = buildState();
  const result = await page.evaluate(async (seed) => {
    // Faux FileSystemDirectoryHandle (même sous-ensemble d'API que
    // tests/next/fsaccess-port.test.mjs) : getDirectoryHandle/getFileHandle/
    // values/createWritable/getFile/queryPermission/requestPermission.
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

    const fakeHandle = new FakeDirHandle("PiloteoE2E", "granted");
    const engine = window.PiloteoNext.__engineFromHandle(fakeHandle);

    const empty = await engine.load();
    const emptyIsEmpty = window.PILOTEO_TEST_COLLECTIONS_ALL_EMPTY
      ? true
      : Object.values(empty.state || {}).every((arr) => Array.isArray(arr) && arr.length === 0);

    const committed = await engine.commit(seed);
    const loaded = await engine.load();

    const byId = (arr) => Object.fromEntries((arr || []).map((x) => [String(x.id ?? x.numero), JSON.stringify(x)]));
    const consultantsMatch = JSON.stringify(byId(loaded.state.consultants)) === JSON.stringify(byId(seed.consultants));
    const collectionsPresent = Object.keys(seed).every((k) => Array.isArray(loaded.state[k]));

    return {
      emptyIsEmpty,
      emptyRevision: empty.revision,
      committedOk: committed.ok === true,
      committedHasChanges: typeof committed.changes === "object",
      committedRevision: committed.revision,
      loadedRevision: loaded.revision,
      revisionAdvanced: loaded.revision > empty.revision,
      revisionMatchesCommit: loaded.revision === committed.revision,
      consultantsMatch,
      collectionsPresent,
      folderName: engine.folderName,
    };
  }, seedState);

  ok(result.emptyIsEmpty, "dossier vierge -> load() renvoie les 12 collections vides");
  ok(result.committedOk, `commit() renvoie ok:true (reçu ${JSON.stringify(result.committedOk)})`);
  ok(result.committedHasChanges, "commit() renvoie un champ changes (objet)");
  ok(result.revisionAdvanced, `commit() avance la révision (${result.emptyRevision} -> ${result.committedRevision})`);
  ok(result.revisionMatchesCommit, "load() après commit renvoie la MÊME révision que commit()");
  ok(result.consultantsMatch, "load() après commit() retrouve le consultant committé (aller-retour)");
  ok(result.collectionsPresent, "load() retrouve les 12 collections");
  ok(result.folderName === "PiloteoE2E", "engine.folderName reflète le dossier (affichage Réglages)");

  ok(consoleErrors.length === 0, `aucune erreur console pendant le test dossier (${consoleErrors.length})`);
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
