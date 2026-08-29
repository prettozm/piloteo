// Filet de non-régression des exports CSV. Déclenche chaque bouton [data-export]
// atteignable et capture le contenu CSV généré (le Blob survit à revokeObjectURL),
// sans modifier app.js. Sert à garantir qu'un refactor de wireExports ne change
// aucun octet des CSV produits.
//   node tests/e2e/csvexport.mjs save   -> écrit la baseline
//   node tests/e2e/csvexport.mjs check  -> compare (échoue si diff)
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
const BASELINE = join(ROOT, "tests/e2e/csvexport.baseline.json");
const PORT = 8139, BASE = `http://127.0.0.1:${PORT}`, PW = "mot-de-passe-e2e-tres-long";
const dd = mkdtempSync(join(tmpdir(), "pcsv-"));
const env = { ...process.env, PILOTEO_DATA_DIR: dd, PILOTEO_BACKUP_DIR: join(dd, "b"), PILOTEO_PORT: String(PORT), PILOTEO_HOST: "127.0.0.1", PILOTEO_ADMIN_USERNAME: "admin", PILOTEO_ADMIN_PASSWORD: PW, PILOTEO_ADMIN_CONSULTANT_ID: "SMR", PILOTEO_ADMIN_NAME: "Admin CSV" };
const srv = spawn("python3", ["server.py"], { cwd: ROOT, env, stdio: ["ignore", "ignore", "ignore"] });

// export -> vue d'accueil ; certains nécessitent une étape préalable (drill).
const EXPORTS = [
  ["mes-affaires", "mapage"], ["mes-missions", "mapage"],
  ["mes-temps", "mestemps"], ["suivi-temps", "mestemps"],
  ["mes-frais", "mesfrais"],
  ["effectifs", "societe"], ["ca-affaires", "societe"], ["suivi-temps-societe", "societe"],
  ["consultants", "consultants"],
  ["frais-societe", "frais"], ["bordereaux", "frais"],
  ["factures-societe", "facturation"],
  ["portefeuille", "affaires"],
  ["commercial-societe", "commercial"],
];
// exports contextuels (drill dans un détail) : atteints séparément.
const CONTEXTUAL = ["missions-affaire", "factures-affaire", "detail-temps", "commercial-moi"];

const out = {};
let browser;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || chromium.executablePath() });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { window.__lastBlob = b; return orig(b); };
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.fill("#login-user", "admin"); await page.fill("#login-password", PW); await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#main-shell:not([hidden])");

  const capture = async (kind) => {
    const btn = page.locator(`[data-export="${kind}"]`).first();
    if (!(await btn.count()) || await btn.isHidden().catch(() => true)) return false;
    await page.evaluate(() => { window.__lastBlob = null; });
    await btn.click();
    for (let i = 0; i < 20 && !(await page.evaluate(() => !!window.__lastBlob)); i++) await page.waitForTimeout(50);
    const txt = await page.evaluate(async () => window.__lastBlob ? await window.__lastBlob.text() : null);
    if (txt != null) out[kind] = txt;
    return txt != null;
  };

  for (const [kind, view] of EXPORTS) {
    const nav = page.locator(`.nav-item[data-view="${view}"]`);
    if (await nav.count()) { await nav.first().click(); await page.waitForTimeout(250); }
    await capture(kind);
  }
  // Contextuels : fiche affaire (missions/factures)
  await page.click('.nav-item[data-view="affaires"]'); await page.waitForTimeout(250);
  const row = page.locator('#view-affaires .row-clickable, #view-affaires [data-id]').first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(400); await capture("missions-affaire"); await capture("factures-affaire"); }
  // detail-temps : depuis la société (lien "détail") si présent
  await page.click('.nav-item[data-view="societe"]').catch(() => {}); await page.waitForTimeout(250);
  const dt = page.locator('[data-detail-temps], a:has-text("Détail"), .row-clickable').first();
  if (await dt.count()) { try { await dt.click({ timeout: 800 }); await page.waitForTimeout(300); await capture("detail-temps"); } catch {} }
  // commercial-moi : bascule si présente
  const cm = page.locator('[data-view="commercial-moi"], [data-toggle="commercial-moi"]').first();
  if (await cm.count()) { try { await cm.click({ timeout: 800 }); await page.waitForTimeout(300); await capture("commercial-moi"); } catch {} }
} finally {
  if (browser) await browser.close();
  srv.kill("SIGTERM");
  rmSync(dd, { recursive: true, force: true });
}

const keys = Object.keys(out).sort();
const norm = JSON.stringify(keys.map(k => [k, out[k]]));
console.log(`exports capturés (${keys.length}): ${keys.join(", ")}`);
if (MODE === "save") {
  writeFileSync(BASELINE, norm);
  console.log(`baseline CSV écrite: ${norm.length} octets`);
} else {
  if (!existsSync(BASELINE)) { console.log("Pas de baseline CSV. Lancer d'abord: node tests/e2e/csvexport.mjs save"); process.exit(2); }
  const base = readFileSync(BASELINE, "utf8");
  if (base === norm) console.log(`CSV IDENTIQUE (${keys.length} exports) — contenu inchangé.`);
  else {
    const b = new Map(JSON.parse(base)); const diffs = [];
    for (const k of keys) if (b.get(k) !== out[k]) diffs.push(k);
    for (const [k] of b) if (!(k in out)) diffs.push(k + " (manquant)");
    console.log("CSV DIFFÉRENT — exports modifiés:", diffs.join(", ") || "(ensemble de clés)");
    process.exit(1);
  }
}
