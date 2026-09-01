// tests/e2e/static-hardening-solo.mjs
//
// Smoke E2E navigateur (Playwright + Chromium), STYLE tests/e2e/solo-folder.mjs :
// prouve, DANS UN VRAI NAVIGATEUR servi EXACTEMENT comme GitHub Pages (aucun
// serveur métier, dépôt servi en statique — voir .github/workflows/pages.yml),
// le Point 1 du contrat (docs/next/STATIC_HARDENING_CONTRACT.md §1) :
//
//   - au chargement de l'app solo statique (window.PILOTEO_FORCE_SOLO===true,
//     posé par pages-config.js, SANS aucun paramètre ?solo=1 — exactement le
//     visiteur du site déployé), #support-admin-panel est ABSENT du DOM
//     (getElementById renvoie null) — pas seulement grisé/masqué visuellement ;
//   - aucun lien cliquable href="/support" n'existe nulle part dans le
//     document ;
//   - non-régression : le reste de l'UI démarre normalement (shell affiché,
//     navigation entre vues, y compris la vue Administration qui contenait
//     le panneau), aucune erreur console.
//
// Usage : node tests/e2e/static-hardening-solo.mjs
//   PW_CHROMIUM=<chemin> pour piloter un binaire Chromium précis.

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

// Sert le dépôt en statique (aucun serveur métier) : exactement ce que sert
// GitHub Pages une fois `_site` assemblé (pages-config.js au repo root, comme
// index.html le charge) — voir .github/workflows/pages.yml.
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

let browser;
try {
  await waitServer();
  const exe = process.env.PW_CHROMIUM || chromium.executablePath();
  browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const loc = m.location && m.location();
    consoleErrors.push(m.text() + (loc && loc.url ? ` [${loc.url}]` : ""));
  });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  // GSI (`https://accounts.google.com/gsi/client`) est un VRAI script externe :
  // ce bac à sable n'a pas d'accès réseau sortant vers Google — le stubber ici
  // (script vide, 200) pour un test HERMÉTIQUE, comme les autres e2e Drive
  // (org-onboarding-drive.mjs) le font pour les appels googleapis.com. Ce n'est
  // PAS ce qu'on veut mesurer : l'objet du test est la CSP (script-src
  // autorise bien 'self' + accounts.google.com — une CSP qui le bloquerait
  // produirait un message "Refused to load"/"Content-Security-Policy", pas un
  // 404/reset réseau) et l'absence du panneau Support.
  await page.route("https://accounts.google.com/gsi/client**", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "" })
  );

  // --- chargement de l'app SANS aucun paramètre : exactement le visiteur du
  //     site déployé (pages-config.js force le solo via PILOTEO_FORCE_SOLO). ---
  await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle" });

  const forcedSolo = await page.evaluate(() => window.PILOTEO_FORCE_SOLO === true);
  ok(forcedSolo, "window.PILOTEO_FORCE_SOLO===true posé par pages-config.js (sans ?solo=1)");

  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  ok(true, "app solo statique démarre (shell affiché) — SANS ?solo=1");

  // --- fermer l'écran d'accueil éventuel (premier lancement), comme le
  //     ferait un utilisateur réel, avant de poursuivre (non-régression). ---
  const welcome = page.locator("#piloteo-welcome");
  if (await welcome.isVisible().catch(() => false)) {
    await page.click("#piloteo-welcome button");
    await page.waitForFunction(() => !document.getElementById("piloteo-welcome"), { timeout: 3000 }).catch(() => {});
  }

  // --- Point 2 (CSP) : le service worker (mode hors ligne) s'enregistre
  //     toujours — la CSP par défaut ne restreint pas worker-src explicitement
  //     mais retombe sur script-src, qui autorise 'self' (sw-solo.js est
  //     same-origin). ------------------------------------------------------
  const swRegistered = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    for (let i = 0; i < 25; i++) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  });
  ok(swRegistered === true || swRegistered === "unsupported", `service worker enregistré malgré la CSP (reçu ${swRegistered})`);

  // --- Point 1 : #support-admin-panel ABSENT du DOM --------------------------
  const supportPanel = await page.evaluate(() => {
    const el = document.getElementById("support-admin-panel");
    return { present: !!el, offsetParent: el ? el.offsetParent : "absent" };
  });
  ok(supportPanel.present === false, `#support-admin-panel absent du DOM (present=${supportPanel.present})`);

  // --- Point 1 : aucun lien cliquable href="/support" -------------------------
  const supportLinks = await page.evaluate(() => document.querySelectorAll('a[href="/support"]').length);
  ok(supportLinks === 0, `aucun lien href="/support" présent (trouvé ${supportLinks})`);

  // --- Point 1 (round contrariant) : un lien nu href="/support" réinséré APRÈS
  //     la fenêtre du MutationObserver borné (5s) doit RESTER inaccessible,
  //     grâce à la règle CSS permanente a[href="/support"]{display:none}. -------
  const lateLink = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 5300)); // au-delà des 5000ms de l'observer
    const a = document.createElement("a");
    a.href = "/support"; a.textContent = "Support";
    document.body.appendChild(a);
    return { present: !!document.querySelector('a[href="/support"]'), offsetParent: a.offsetParent };
  });
  ok(
    lateLink.offsetParent === null,
    `lien nu href="/support" injecté après la fenêtre de 5s reste non-cliquable (offsetParent=${lateLink.offsetParent === null ? "null" : "VISIBLE"})`
  );
  await page.evaluate(() => document.querySelectorAll('a[href="/support"]').forEach((a) => a.remove()));

  // --- non-régression : navigation vers la vue Administration (qui contenait
  //     le panneau) — le reste de la vue doit toujours fonctionner. -----------
  await page.click('[data-view="admin"]');
  await page.waitForSelector("#view-admin:not([hidden])", { timeout: 5000 }).catch(() => {});
  const adminViewVisible = await page.locator("#view-admin").isVisible().catch(() => false);
  ok(adminViewVisible, "vue Administration s'affiche toujours (non-régression)");
  const stillAbsentAfterNav = await page.evaluate(() => document.getElementById("support-admin-panel") === null);
  ok(stillAbsentAfterNav, "#support-admin-panel toujours absent après navigation (idempotent)");

  // --- non-régression : le reste de l'UI (panneau Réglages) fonctionne -------
  await page.click("#piloteo-gear");
  const panelVisible = await page.locator("#piloteo-reglages").isVisible().catch(() => false);
  ok(panelVisible, "panneau Réglages s'ouvre toujours (non-régression)");
  await page.evaluate(() => document.getElementById("piloteo-reglages")?.remove());

  // favicon.ico et /brand-logo : routes SERVEUR (server.py) absentes d'un
  // simple `python3 -m http.server` (exactement ce que sert GitHub Pages,
  // SANS server.py — voir garde-fou pages.yml qui ignore déjà les chemins
  // absolus type /brand-logo, ce ne sont "pas des fichiers"). Bruit connu,
  // sans rapport avec la CSP ou le Point 1. Tout le reste doit être
  // silencieux — en particulier AUCUN message CSP ("Refused to load"/
  // "Content-Security-Policy") : la preuve que script-src 'self'
  // https://accounts.google.com laisse bien passer les modules ES et le
  // script GSI stubbé ci-dessus.
  const unexpectedErrors = consoleErrors.filter((e) => !/favicon|brand-logo/i.test(e));
  ok(unexpectedErrors.length === 0, `aucune erreur console inattendue (${unexpectedErrors.length}/${consoleErrors.length})`);
  if (unexpectedErrors.length) unexpectedErrors.slice(0, 5).forEach((e) => console.log("    console:", e));
  const cspViolation = consoleErrors.some((e) => /content-security-policy|refused to load|refused to execute/i.test(e));
  ok(!cspViolation, "aucune violation CSP (modules ES / GSI / SW non bloqués par la CSP)");

  // --- non-régression : mode Dossier/Organisation non affectés (le drapeau
  //     PILOTEO_FORCE_SOLO force juste "pas de serveur", pas un sous-mode
  //     particulier — voir local-backend.js#isSolo). ---------------------------
  const bridgesLoaded = await page.evaluate(() => !!window.PiloteoNext && !!window.PiloteoOrg);
  ok(bridgesLoaded, "les ponts Dossier/Organisation restent chargés (non-régression)");
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
