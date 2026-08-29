// Test E2E navigateur (Playwright + Chromium) — non-régression fonctionnelle et sécurité.
//
// Démarre une vraie instance server.py sur une base temporaire, pilote un
// navigateur réel : connexion admin, navigation des vues, création d'une saisie
// de temps avec un commentaire piégé (XSS), et vérifie :
//   - qu'aucune erreur console / dialog XSS ne survient ;
//   - que le payload XSS s'affiche comme texte (esc() actif) ;
//   - que les vues principales se rendent sans exception.
//
// Usage : node tests/e2e/smoke.mjs   (nécessite server.py au repo root)
import pw from "/opt/node22/lib/node_modules/playwright/index.js";
const { chromium } = pw;
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PW = "mot-de-passe-e2e-tres-long";
const dataDir = mkdtempSync(join(tmpdir(), "piloteo-e2e-"));

const env = {
  ...process.env,
  PILOTEO_DATA_DIR: dataDir,
  PILOTEO_BACKUP_DIR: join(dataDir, "backups"),
  PILOTEO_PORT: String(PORT),
  PILOTEO_HOST: "127.0.0.1",
  PILOTEO_ADMIN_USERNAME: "admin",
  PILOTEO_ADMIN_PASSWORD: ADMIN_PW,
  PILOTEO_ADMIN_CONSULTANT_ID: "SMR",
  PILOTEO_ADMIN_NAME: "Admin E2E",
};

const failures = [];
const ok = (cond, msg) => { if (cond) { console.log("  ✓", msg); } else { failures.push(msg); console.log("  ✗", msg); } };

const srv = spawn("python3", ["server.py"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
srv.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("serveur jamais up");
}

let browser;
try {
  await waitHealth();
  browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  let xssFired = false;
  page.on("dialog", async (d) => { xssFired = true; await d.dismiss(); });

  // --- connexion ---
  await page.goto(BASE, { waitUntil: "networkidle" });
  ok(await page.locator("#identify-screen").isVisible(), "écran de connexion affiché");
  await page.fill("#login-user", "admin");
  await page.fill("#login-password", ADMIN_PW);
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  ok(true, "connexion admin réussie, shell affiché");
  // Les erreurs console d'avant la session (ex. /api/me 401 avant login) ne
  // comptent pas : on n'observe que ce qui se passe une fois connecté.
  consoleErrors.length = 0;

  // --- navigation des vues admin ---
  const views = await page.locator(".nav-item:not([hidden])").count();
  ok(views > 0, `navigation admin visible (${views} entrées)`);
  for (const v of ["societe", "affaires", "commercial", "facturation", "frais", "consultants", "organisations", "admin"]) {
    const nav = page.locator(`.nav-item[data-view="${v}"]`);
    if (await nav.count() && !(await nav.first().isHidden())) {
      await nav.first().click();
      await page.waitForTimeout(200);
      ok(await page.locator(`#view-${v}`).isVisible().catch(() => false), `vue ${v} rendue`);
    }
  }

  // --- non-régression XSS : injecter via l'API un commentaire piégé, puis l'afficher ---
  const csrf = await page.evaluate(async () => {
    const r = await fetch("/api/me"); return (await r.json()).user.csrf_token;
  });
  const injected = await page.evaluate(async (csrf) => {
    const r = await fetch("/api/state"); const s = await r.json();
    const st = s.state;
    // saisie piégée rattachée au premier consultant/mission dispo, sinon on
    // insère dans une collection tolérée pour éprouver le rendu.
    const payload = '<img src=x onerror="window.__xss=1">';
    // Injecté dans deux sinks distincts : un commentaire de saisie et un nom
    // d'affaire (ce dernier rendu de façon fiable dans le portefeuille).
    if (st.saisies && st.saisies.length) st.saisies[0].commentaire = payload;
    if (st.affaires && st.affaires.length) st.affaires[0].nom = payload + " " + (st.affaires[0].nom || "");
    const put = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ base_revision: s.revision, state: st }),
    });
    return { status: put.status, payload };
  }, csrf);
  ok(injected.status === 200, `commentaire piégé enregistré (PUT ${injected.status})`);

  // recharger et parcourir les vues qui affichent des commentaires/noms de saisie
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  consoleErrors.length = 0;
  for (const v of ["societe", "affaires", "frais", "commercial"]) {
    const nav = page.locator(`.nav-item[data-view="${v}"]`);
    if (await nav.count() && !(await nav.first().isHidden())) { await nav.first().click(); await page.waitForTimeout(250); }
  }
  await page.waitForTimeout(300);
  // Assertion de sécurité la plus dure : aucun élément <img> n'a pu naître du
  // payload (esc a transformé le HTML en texte). + pas de dialog, pas de flag.
  const injectedImg = await page.evaluate(() => document.querySelectorAll('img[src="x"]').length);
  const xssAsText = await page.evaluate(() => document.body.innerHTML.includes("&lt;img src=x"));
  const flag = await page.evaluate(() => window.__xss === 1);
  ok(!xssFired, "aucune boîte de dialogue XSS déclenchée");
  ok(!flag, "le payload onerror ne s'est PAS exécuté (esc actif)");
  ok(injectedImg === 0, "aucun élément <img> créé depuis le payload");
  ok(xssAsText, "le payload est présent sous forme échappée dans le DOM");

  ok(consoleErrors.length === 0, `aucune erreur console (${consoleErrors.length})`);
  if (consoleErrors.length) consoleErrors.slice(0, 5).forEach((e) => console.log("    console:", e));
} catch (e) {
  failures.push("exception: " + e.message);
  console.error(e);
} finally {
  if (browser) await browser.close();
  srv.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length) { console.log(`\nE2E ÉCHEC (${failures.length}) :`); failures.forEach((f) => console.log(" -", f)); process.exit(1); }
console.log("\nE2E OK");
