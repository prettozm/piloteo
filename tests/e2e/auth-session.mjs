// tests/e2e/auth-session.mjs
//
// Smoke E2E navigateur (Playwright + Chromium) du Point 3
// (docs/next/AUTH_SESSION_CONTRACT.md §5, cas 6-8) : prouve, DANS UN VRAI
// NAVIGATEUR, que la session locale à l'appareil verrouille/bloque
// réellement `/api/me` et `/api/state` — pas seulement le module pur
// (tests/next/auth-session.test.mjs) déjà couvert côté Node.
//
// Cas couverts :
//   6. Sans PIN : boot direct `active`, `/api/me` OK (non-régression).
//   7. Définir un PIN (hook de test) + `lockOnOpen` -> recharger -> overlay
//      affiché, `/api/state` RÉELLEMENT en attente -> déverrouiller (via la
//      vraie saisie du formulaire de l'overlay) -> `active`, la requête
//      bloquée se résout enfin.
//   8. `POST /api/logout` -> overlay affiché, `/api/me` bloqué jusqu'au
//      re-déverrouillage (sans PIN : clic direct sur « Déverrouiller »).
//   9. FAIL-CLOSED (round de correction, FAILLE 2 neutralisée) : PIN défini +
//      `piloteo-auth-bridge.mjs` bloqué au réseau -> overlay d'ERREUR affiché
//      (PAS l'écran de saisie normal), `/api/me`/`/api/state` répondent 503
//      (jamais 200, jamais un hang silencieux) — voir aussi le repro dédié
//      tests/e2e/attack-p3-session.mjs.
//  10. LONGUEUR MINIMALE DE PIN (round de correction r2, contrat §4) : le
//      VRAI formulaire Réglages (#piloteo-pin-*) refuse un code < 6 caractères
//      avec le message honnête, puis accepte un code >= 6 caractères.
//  11. COMPTEUR D'ÉCHECS PERSISTANT (round de correction r2, contrat §4) :
//      des échecs enregistrés SURVIVENT à un rechargement de page (seul un
//      déverrouillage réussi les remet à zéro) — un simple F5 ne doit jamais
//      « blanchir » le compteur anti-force-brute.
//
// Usage : node tests/e2e/auth-session.mjs
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

// Sert le dépôt en statique (aucun serveur métier), exactement comme
// tests/e2e/solo-folder.mjs.
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

async function dismissWelcomeIfAny(page) {
  const welcome = page.locator("#piloteo-welcome");
  if (await welcome.isVisible().catch(() => false)) {
    await page.click("#piloteo-welcome button");
    await page.waitForFunction(() => !document.getElementById("piloteo-welcome"), { timeout: 3000 }).catch(() => {});
  }
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

  // ===========================================================================
  // Cas 6 — sans PIN : boot direct actif, /api/me OK (non-régression).
  // ===========================================================================
  await page.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  await dismissWelcomeIfAny(page);

  await page.waitForFunction(() => !!(window.PiloteoAuth && window.PiloteoLocal && window.PiloteoLocal._authState), { timeout: 5000 });
  ok(true, "window.PiloteoAuth chargé (piloteo-auth-bridge.mjs)");

  const bootState = await page.evaluate(() => window.PiloteoLocal._authSessionReady().then(() => window.PiloteoLocal._authState()));
  ok(bootState && bootState.status === "active", `sans PIN, session active au boot (reçu ${JSON.stringify(bootState)})`);
  ok(bootState && bootState.hasPin === false, "aucun PIN défini par défaut");

  const meOk = await page.evaluate(async () => {
    const r = await fetch("/api/me");
    const data = await r.json();
    return { status: r.status, hasUser: !!data.user };
  });
  ok(meOk.status === 200 && meOk.hasUser, `/api/me répond 200 sans PIN (non-régression) (reçu ${JSON.stringify(meOk)})`);

  // ===========================================================================
  // Cas 7 — définir un PIN (hook de test) + lockOnOpen -> recharger -> overlay
  // -> /api/state RÉELLEMENT en attente -> déverrouiller via l'overlay -> actif.
  // ===========================================================================
  const PIN = "135792"; // 6 caractères min. imposés au round de correction (§4)
  await page.evaluate((pin) => window.PiloteoLocal._authSetPin(pin, { lockOnOpen: true }), PIN);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#piloteo-lock", { timeout: 10000 });
  ok(true, "overlay de verrouillage affiché après reload (PIN + lockOnOpen)");

  const hasPinInput = await page.locator("#piloteo-lock-pin").count();
  ok(hasPinInput === 1, "l'overlay affiche un champ de saisie du code (PIN défini)");

  // Une requête /api/state lancée maintenant doit rester EN ATTENTE (jamais
  // résolue avant déverrouillage) — la preuve du blocage RÉEL, pas seulement
  // un état affiché. On la stocke sur `window` pour la relire après unlock.
  await page.evaluate(() => {
    window.__pendingStateDone = false;
    window.__pendingState = fetch("/api/state")
      .then((r) => r.json())
      .then((d) => { window.__pendingStateDone = true; window.__pendingStateResult = d; });
  });
  await page.waitForTimeout(400);
  const stillPending = await page.evaluate(() => window.__pendingStateDone);
  ok(stillPending === false, "/api/state lancé pendant le verrou reste EN ATTENTE (bloqué)");

  // Mauvais code d'abord : doit être rejeté, overlay reste affiché, /api/state
  // toujours en attente.
  await page.fill("#piloteo-lock-pin", "00000");
  await page.click("#piloteo-lock-submit");
  await page.waitForFunction(() => {
    const m = document.getElementById("piloteo-lock-msg");
    return m && m.textContent && m.textContent.length > 0;
  }, { timeout: 5000 });
  const stillLocked = await page.locator("#piloteo-lock").count();
  ok(stillLocked === 1, "code incorrect -> overlay reste affiché");
  const stillPendingAfterBadPin = await page.evaluate(() => window.__pendingStateDone);
  ok(stillPendingAfterBadPin === false, "/api/state toujours bloqué après un code incorrect");

  // Bon code : déverrouille réellement.
  await page.fill("#piloteo-lock-pin", PIN);
  await page.click("#piloteo-lock-submit");
  await page.waitForFunction(() => !document.getElementById("piloteo-lock"), { timeout: 5000 });
  ok(true, "bon code -> overlay disparaît");

  await page.waitForFunction(() => window.__pendingStateDone === true, { timeout: 5000 });
  const unlockedState = await page.evaluate(() => window.__pendingStateResult);
  ok(unlockedState && typeof unlockedState.revision === "number" && unlockedState.state,
    `la requête /api/state qui était bloquée se résout après déverrouillage (reçu ${JSON.stringify(unlockedState).slice(0, 120)})`);

  const afterUnlockState = await page.evaluate(() => window.PiloteoLocal._authState());
  ok(afterUnlockState && afterUnlockState.status === "active" && afterUnlockState.failedAttempts === 0,
    `session active après déverrouillage, compteur d'échecs remis à zéro (reçu ${JSON.stringify(afterUnlockState)})`);

  const stateAfterUnlock = await page.evaluate(async () => {
    const r = await fetch("/api/state");
    return { status: r.status };
  });
  ok(stateAfterUnlock.status === 200, "un nouvel appel /api/state répond 200 une fois déverrouillé");

  // ===========================================================================
  // Cas 8 — POST /api/logout verrouille RÉELLEMENT : overlay affiché,
  // /api/me bloqué jusqu'au re-déverrouillage (ici sans PIN : on l'a retiré).
  // ===========================================================================
  await page.evaluate(() => window.PiloteoLocal._authClearPin());

  const logoutResp = await page.evaluate(async () => {
    const r = await fetch("/api/logout", { method: "POST" });
    return { status: r.status, body: await r.json() };
  });
  ok(logoutResp.status === 200 && logoutResp.body && logoutResp.body.ok === true, "POST /api/logout répond 200 {ok:true}");

  await page.waitForSelector("#piloteo-lock", { timeout: 5000 });
  ok(true, "POST /api/logout affiche l'overlay de verrouillage");

  const noPinInputAfterLogout = await page.locator("#piloteo-lock-pin").count();
  ok(noPinInputAfterLogout === 0, "aucun PIN actif -> overlay sans champ de saisie (verrou minimal)");

  await page.evaluate(() => {
    window.__pendingMeDone = false;
    window.__pendingMe = fetch("/api/me").then((r) => r.json()).then((d) => { window.__pendingMeDone = true; window.__pendingMeResult = d; });
  });
  await page.waitForTimeout(400);
  const meStillPending = await page.evaluate(() => window.__pendingMeDone);
  ok(meStillPending === false, "/api/me bloqué après /api/logout, jusqu'au re-déverrouillage");

  await page.click("#piloteo-lock-submit");
  await page.waitForFunction(() => !document.getElementById("piloteo-lock"), { timeout: 5000 });
  await page.waitForFunction(() => window.__pendingMeDone === true, { timeout: 5000 });
  const meAfterRelogin = await page.evaluate(() => window.__pendingMeResult);
  ok(meAfterRelogin && meAfterRelogin.user, "la requête /api/me qui était bloquée se résout après re-déverrouillage");

  // ===========================================================================
  // Cas 9 — FAIL-CLOSED (round de correction, FAILLE 2 neutralisée) : PIN
  // défini + `piloteo-auth-bridge.mjs` bloqué au réseau -> overlay d'ERREUR
  // (pas l'écran de saisie normal), /api/me et /api/state répondent 503.
  // Nouveau contexte propre pour ne pas hériter du Service Worker/cache déjà
  // peuplés par les cas précédents (qui rendraient le blocage réseau inopérant
  // — même précaution que tests/e2e/attack-p3-session.mjs).
  // ===========================================================================
  {
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    const cdp2 = await ctx2.newCDPSession(page2);
    await cdp2.send("Network.setCacheDisabled", { cacheDisabled: true });

    await page2.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
    await page2.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
    await dismissWelcomeIfAny(page2);
    await page2.waitForFunction(() => !!(window.PiloteoAuth && window.PiloteoLocal), { timeout: 5000 });

    const PIN9 = "112233"; // 6 caractères min. imposés au round de correction (§4)
    await page2.evaluate((pin) => window.PiloteoLocal._authSetPin(pin, { lockOnOpen: true }), PIN9);

    // Vide le Service Worker / Cache Storage (comme "Clear storage" DevTools ;
    // l'IndexedDB — donc le PIN — n'est PAS touchée) pour garantir qu'un
    // blocage réseau suivant soit un VRAI blocage, pas neutralisé par un
    // asset déjà en cache.
    await page2.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    });

    await page2.route("**/piloteo-auth-bridge.mjs", (route) => route.abort());
    await page2.reload({ waitUntil: "domcontentloaded" });
    await page2.waitForTimeout(3500); // délai fail-open contractuel (waitForPiloteoAuth(3000))

    const overlay = await page2.locator("#piloteo-lock").count();
    ok(overlay === 1, "overlay affiché (fail-CLOSED, pas de fail-open) quand PiloteoAuth est bloqué");

    const overlayState = await page2.locator("#piloteo-lock").getAttribute("data-piloteo-lock-state").catch(() => null);
    ok(overlayState === "auth-unavailable", `overlay marqué comme l'écran d'ERREUR dédié (reçu ${overlayState})`);

    const noPinInput = await page2.locator("#piloteo-lock-pin").count();
    ok(noPinInput === 0, "PAS l'écran de saisie normal (aucun champ PIN — rien à vérifier le code contre)");

    const meResp9 = await page2.evaluate(async () => {
      const r = await fetch("/api/me");
      let body = null; try { body = await r.json(); } catch {}
      return { status: r.status, hasUser: !!(body && body.user) };
    });
    ok(meResp9.status === 503 && !meResp9.hasUser, `/api/me répond 503 sans utilisateur, jamais 200 (reçu ${JSON.stringify(meResp9)})`);

    const stateResp9 = await page2.evaluate(async () => { const r = await fetch("/api/state"); return r.status; });
    ok(stateResp9 === 503, `/api/state répond 503, jamais 200 (reçu ${stateResp9})`);

    await ctx2.close();
  }

  // ===========================================================================
  // Cas 10 — LONGUEUR MINIMALE DE PIN (round de correction r2, contrat §4) :
  // le VRAI formulaire Réglages refuse < 6 caractères avec le message honnête,
  // puis accepte >= 6. Nouveau contexte propre (aucun PIN préexistant).
  // ===========================================================================
  {
    const ctx3 = await browser.newContext();
    const page3 = await ctx3.newPage();
    await page3.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
    await page3.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
    await dismissWelcomeIfAny(page3);
    await page3.waitForFunction(() => !!(window.PiloteoAuth && window.PiloteoLocal), { timeout: 5000 });

    await page3.click("#piloteo-gear");
    await page3.waitForSelector("#piloteo-reglages", { timeout: 5000 });

    // Code trop court (5 caractères) -> refusé, message honnête affiché.
    await page3.fill("#piloteo-pin-new", "12345");
    await page3.fill("#piloteo-pin-confirm", "12345");
    await page3.click("#piloteo-pin-submit");
    const shortMsg = await page3.locator("#piloteo-pin-msg").textContent();
    ok(/6 caractères minimum/.test(shortMsg || ""), `code < 6 caractères refusé avec un message qui cite le plancher (reçu "${shortMsg}")`);
    ok(/heure de l.appareil/.test(shortMsg || ""), `le message explique POURQUOI (mention honnête du contournement par l'heure de l'appareil) (reçu "${shortMsg}")`);
    const noPinYet = await page3.evaluate(() => window.PiloteoLocal._authState().hasPin);
    ok(noPinYet === false, "aucun PIN enregistré après un refus de longueur (rien n'a été persisté)");

    // Code valide (6 caractères) -> accepté.
    await page3.fill("#piloteo-pin-new", "246810");
    await page3.fill("#piloteo-pin-confirm", "246810");
    await page3.click("#piloteo-pin-submit");
    await page3.waitForFunction(() => window.PiloteoLocal._authState().hasPin === true, { timeout: 5000 });
    ok(true, "un code de 6 caractères est accepté (aucune raison de plancher plus haut que documenté)");

    await ctx3.close();
  }

  // ===========================================================================
  // Cas 11 — COMPTEUR D'ÉCHECS PERSISTANT (round de correction r2, contrat
  // §4) : des échecs enregistrés SURVIVENT à un rechargement — seul un
  // déverrouillage réussi (`registerSuccess`) remet le compteur à zéro.
  // Nouveau contexte propre.
  // ===========================================================================
  {
    const ctx4 = await browser.newContext();
    const page4 = await ctx4.newPage();
    await page4.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
    await page4.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
    await dismissWelcomeIfAny(page4);
    await page4.waitForFunction(() => !!(window.PiloteoAuth && window.PiloteoLocal), { timeout: 5000 });

    const PIN11 = "531975"; // 6 caractères min. imposés au round de correction (§4)
    await page4.evaluate((pin) => window.PiloteoLocal._authSetPin(pin, { lockOnOpen: true }), PIN11);
    await page4.reload({ waitUntil: "networkidle" });
    await page4.waitForSelector("#piloteo-lock-pin", { timeout: 10000 });

    async function wrongAttempt(page) {
      const before = await page.evaluate(() => window.PiloteoLocal._authState().failedAttempts);
      await page.fill("#piloteo-lock-pin", "000000");
      await page.click("#piloteo-lock-submit");
      await page.waitForFunction((n) => window.PiloteoLocal._authState().failedAttempts > n, before, { timeout: 5000 });
    }

    // 2 échecs (sous le seuil de blocage) puis RELOAD : le compteur ne doit
    // PAS revenir à zéro.
    await wrongAttempt(page4);
    await wrongAttempt(page4);
    const beforeReload = await page4.evaluate(() => window.PiloteoLocal._authState());
    ok(beforeReload.failedAttempts === 2, `2 échecs enregistrés avant le reload (reçu ${beforeReload.failedAttempts})`);

    await page4.reload({ waitUntil: "networkidle" });
    await page4.waitForSelector("#piloteo-lock-pin", { timeout: 10000 });
    const afterReload = await page4.evaluate(() => window.PiloteoLocal._authState());
    ok(afterReload.failedAttempts === 2,
      `le compteur d'échecs SURVIT au rechargement (attendu 2, reçu ${afterReload.failedAttempts}) — pas de "blanchiment" par un simple F5`);

    // 3 échecs de plus (total 5) -> déclenche le 1er blocage exponentiel,
    // PUIS reload encore : le blocage doit rester posé (lockedUntil dans le futur).
    await wrongAttempt(page4);
    await wrongAttempt(page4);
    await wrongAttempt(page4);
    const afterFive = await page4.evaluate(() => window.PiloteoLocal._authState());
    ok(afterFive.failedAttempts === 5 && afterFive.lockedUntil > Date.now(),
      `5 échecs -> blocage posé avant reload (failedAttempts=${afterFive.failedAttempts}, lockedUntil dans ${afterFive.lockedUntil - Date.now()}ms)`);

    await page4.reload({ waitUntil: "networkidle" });
    await page4.waitForSelector("#piloteo-lock-pin", { timeout: 10000 });
    const afterFiveAndReload = await page4.evaluate(() => window.PiloteoLocal._authState());
    ok(afterFiveAndReload.failedAttempts === 5 && afterFiveAndReload.lockedUntil > Date.now(),
      `le blocage (failedAttempts ET lockedUntil) SURVIT au rechargement (reçu ${JSON.stringify(afterFiveAndReload)}) — un F5 ne lève jamais le blocage`);
    const disabledAfterReload = await page4.locator("#piloteo-lock-pin").isDisabled().catch(() => null);
    ok(disabledAfterReload === true, "après reload, le champ de saisie reste bien DÉSACTIVÉ (blocage toujours appliqué par l'UI)");

    // Seul un déverrouillage RÉUSSI remet le compteur à zéro (une fois le
    // blocage honnêtement écoulé — 1er palier = 2^0 = 1s réelle, cf. §1 ;
    // l'UI elle-même réactive le champ via `refreshLockoutDisplay`, revérifié
    // chaque seconde).
    await page4.waitForFunction(() => !document.getElementById("piloteo-lock-pin").disabled, { timeout: 15000 });
    await page4.fill("#piloteo-lock-pin", PIN11);
    await page4.click("#piloteo-lock-submit");
    await page4.waitForFunction(() => !document.getElementById("piloteo-lock"), { timeout: 5000 });
    const afterSuccess = await page4.evaluate(() => window.PiloteoLocal._authState());
    ok(afterSuccess.failedAttempts === 0 && afterSuccess.status === "active",
      `déverrouillage réussi -> compteur remis à zéro par registerSuccess (reçu ${JSON.stringify(afterSuccess)})`);

    await ctx4.close();
  }

  // Un 404 réseau bénin et déjà connu (`/brand-logo`, absent en statique —
  // géré par `img.onerror` dans `applyBranding`) se répète à chaque
  // (re)chargement ; Chromium le logue en console sans exposer l'URL dans le
  // message (générique "Failed to load resource…"). Sans rapport avec le
  // Point 3 : on l'exclut de la surveillance, ne gardant que les vraies
  // erreurs JS (`pageerror: …`) — même esprit que tests/e2e/solo-folder.mjs,
  // qui ne surveille la console qu'après avoir écarté le bruit du boot.
  const relevantErrors = consoleErrors.filter((e) => e.indexOf("Failed to load resource") === -1);
  ok(relevantErrors.length === 0, `aucune erreur console pendant le test session (${relevantErrors.length})`);
  if (relevantErrors.length) relevantErrors.slice(0, 5).forEach((e) => console.log("    console:", e));
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
