// Harnais de non-régression par capture DOM. Rend toutes les vues sur un jeu de
// données déterministe (seed.json) et capture le innerHTML de chaque vue.
//   node tests/e2e/snapshot.mjs save   -> écrit la baseline
//   node tests/e2e/snapshot.mjs check  -> compare à la baseline (échoue si diff)
// Sert à prouver qu'un refactoring (déduplication) ne change pas le rendu.
let _pw;
try { _pw = await import("playwright"); }
catch { _pw = await import("/opt/node22/lib/node_modules/playwright/index.js"); }
const chromium = _pw.chromium || _pw.default.chromium;
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODE = process.argv[2] || "check";
const ROOT = new URL("../..", import.meta.url).pathname;
const BASELINE = join(ROOT, "tests/e2e/snapshot.baseline.json");
const PORT = 8137, BASE = `http://127.0.0.1:${PORT}`, PW = "mot-de-passe-e2e-tres-long";
const dd = mkdtempSync(join(tmpdir(), "psnap-"));
const env = { ...process.env, PILOTEO_DATA_DIR: dd, PILOTEO_BACKUP_DIR: join(dd, "b"), PILOTEO_PORT: String(PORT), PILOTEO_HOST: "127.0.0.1", PILOTEO_ADMIN_USERNAME: "admin", PILOTEO_ADMIN_PASSWORD: PW, PILOTEO_ADMIN_CONSULTANT_ID: "SMR", PILOTEO_ADMIN_NAME: "Admin Snap" };
const srv = spawn("python3", ["server.py"], { cwd: ROOT, env, stdio: ["ignore", "ignore", "ignore"] });

const snap = {};
let browser;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || chromium.executablePath() });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.fill("#login-user", "admin"); await page.fill("#login-password", PW); await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#main-shell:not([hidden])");
  const views = await page.evaluate(() => [...document.querySelectorAll(".nav-item")].map(n => n.getAttribute("data-view")));
  for (const v of views) {
    const nav = page.locator(`.nav-item[data-view="${v}"]`);
    if (!(await nav.count())) continue;
    try { await nav.first().click(); await page.waitForTimeout(300); } catch { continue; }
    // capture le innerHTML de la vue, en neutralisant le bruit non déterministe
    const html = await page.evaluate((v) => {
      const el = document.getElementById("view-" + v);
      if (!el) return null;
      let h = el.innerHTML;
      // normaliser d'éventuels identifiants de patterns SVG aléatoires
      h = h.replace(/(hatch|pattern|grad|clip)[-_][a-z0-9]+/gi, "$1-X");
      return h;
    }, v);
    if (html != null) snap[v] = html;
  }
} finally {
  if (browser) await browser.close();
  srv.kill("SIGTERM");
  rmSync(dd, { recursive: true, force: true });
}

const keys = Object.keys(snap).sort();
const norm = JSON.stringify(keys.map(k => [k, snap[k]]));
if (MODE === "save") {
  writeFileSync(BASELINE, norm);
  console.log(`baseline écrite: ${keys.length} vues, ${norm.length} octets`);
} else {
  if (!existsSync(BASELINE)) { console.log("Pas de baseline. Lancer d'abord: node tests/e2e/snapshot.mjs save"); process.exit(2); }
  const base = readFileSync(BASELINE, "utf8");
  if (base === norm) { console.log(`SNAPSHOT IDENTIQUE (${keys.length} vues) — rendu inchangé.`); }
  else {
    // trouver les vues qui diffèrent
    const b = new Map(JSON.parse(base)); const diffs = [];
    for (const k of keys) if (b.get(k) !== snap[k]) diffs.push(k);
    for (const [k] of b) if (!(k in snap)) diffs.push(k + " (disparue)");
    console.log("SNAPSHOT DIFFÉRENT — vues modifiées:", diffs.join(", ") || "(structure)");
    process.exit(1);
  }
}
