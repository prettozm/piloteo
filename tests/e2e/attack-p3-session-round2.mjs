// tests/e2e/attack-p3-session-round2.mjs — CONTRARIANT round 2 du Point 3
// (docs/next/AUTH_SESSION_CONTRACT.md, contrat amendé §0/§1/§2).
//
// Round 1 avait cassé le lot par (A) monkey-patch de Date.now() DANS la page
// et (B) fail-open réseau. (A) est maintenant explicitement HORS PÉRIMÈTRE
// (contrat §0 amendé : un script exécuté dans la page n'est pas une menace
// couverte). (B) est corrigé : local-backend.js est fail-CLOSED (503).
//
// Ce script (round 2) cherche un NOUVEAU contournement du recoupement
// d'horloge (`canAttemptCrossChecked`, §1) qui NE PASSE PAR AUCUN SCRIPT DANS
// LA PAGE — donc qui reste dans le modèle de menace couvert.
//
// CONSTAT : `canAttemptCrossChecked` recoupe deux ESTIMATIONS dérivées d'une
// SEULE ET MÊME lecture de `Date.now()`, faite UNE FOIS par chargement de
// page (`_clockRefWall = Date.now()` en tête de local-backend.js) :
//   wallNow  = Date.now()                                    (lecture directe, à chaque appel)
//   monoNow  = _clockRefWall + (performance.now() - _clockRefMono)
// `performance.now()` est bien immunisé contre un monkey-patch DANS la page
// (round 1). Mais `_clockRefWall`, lui, est simplement `Date.now()` lu à
// l'exécution du script — c'est-à-dire l'horloge SYSTÈME/OS au moment du
// chargement de la page. Si cette horloge système est en avance (l'utilisateur
// ou un tiers a changé la date de l'appareil dans les Réglages OS — un geste
// qui NE NÉCESSITE AUCUN SCRIPT, juste un accès à l'appareil, le même niveau
// d'accès physique que le modèle de menace du PIN suppose déjà), alors
// `_clockRefWall` capture directement cette valeur avancée : `monoNow` EST
// TOUT AUTANT avancé que `wallNow` (les deux sont dérivés de la même horloge
// OS trafiquée), donc le recoupement ("les deux doivent s'accorder") ne
// détecte RIEN — il est nourri par la même source corrompue des deux côtés.
//
// Repro : on simule un changement d'horloge SYSTÈME (pas une ligne de JS dans
// la page) via LD_PRELOAD=libfaketime, avec FAKETIME_DONT_FAKE_MONOTONIC=1 —
// c'est-à-dire qu'on avance UNIQUEMENT l'horloge murale (CLOCK_REALTIME, ce
// que `Date.now()`/`new Date()` lisent), en laissant l'horloge monotone du
// PROCESSUS (CLOCK_MONOTONIC, ce que `performance.now()` lit) totalement
// INTACTE — exactement le comportement d'un vrai changement de date OS (qui
// ne remet jamais à zéro le compteur d'uptime matériel). AUCUN `page.evaluate`
// n'altère `window.Date`/`window.performance` : le navigateur lit son horloge
// système normalement, cette horloge système est juste mensongère — comme si
// l'utilisateur avait ouvert le panneau Réglages > Date & heure de son OS.
//
// Usage : node tests/e2e/attack-p3-session-round2.mjs
//   Nécessite `faketime`/`libfaketime` installés (LD_PRELOAD) et Playwright.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let _pw;
try { _pw = await import("playwright"); }
catch { _pw = await import("/opt/node22/lib/node_modules/playwright/index.js"); }
const chromium = _pw.chromium || _pw.default.chromium;

const ROOT = new URL("../..", import.meta.url).pathname;
const PORT = 8196;
const BASE = `http://127.0.0.1:${PORT}`;
const FT_FILE = join(tmpdir(), `piloteo-attack-p3-round2-faketime-${process.pid}.txt`);
// Variante multi-thread (recommandée pour un programme aussi threadé que
// Chromium) de libfaketime. Chemin Debian/Ubuntu standard (paquet `faketime`) ;
// ce script s'auto-diagnostique si absent (voir le bloc try/catch de lancement).
const LIBFAKETIME = "/usr/lib/x86_64-linux-gnu/faketime/libfaketimeMT.so.1";

const failures = [];
const brokenList = [];
const ok = (cond, msg) => { if (cond) { console.log("  ✓", msg); } else { failures.push(msg); console.log("  ✗ (test):", msg); } };
const broken = (cond, msg) => { if (cond) { brokenList.push(msg); console.log("  💥 CASSÉ:", msg); } else { console.log("  ✓ (tenu):", msg); } };

function writeFakeTimeAbsolute(date) {
  const iso = date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  writeFileSync(FT_FILE, "@" + iso + "\n");
}

const srv = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
srv.stderr.on("data", () => {});
async function waitServer() {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/index.html`); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 200)); }
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

{
  const { existsSync } = await import("node:fs");
  if (!existsSync(LIBFAKETIME)) {
    console.error(
      `libfaketime introuvable (${LIBFAKETIME}).\n` +
      "Cette repro a besoin de simuler un changement d'horloge SYSTÈME (pas un\n" +
      "script dans la page) : installez-le puis relancez, ex. (Debian/Ubuntu) :\n" +
      "  apt-get install -y faketime"
    );
    process.exit(2);
  }
}

let browser;
try {
  await waitServer();
  writeFakeTimeAbsolute(new Date()); // horloge "OS" initialement honnête (= heure réelle)

  const exe = process.env.PW_CHROMIUM || chromium.executablePath();
  browser = await chromium.launch({
    executablePath: exe,
    // --single-process --no-zygote : évite la contention massive du sémaphore
    // de synchronisation inter-processus de libfaketime sur l'arbre de
    // processus habituel de Chromium (constatée empiriquement : sans ces
    // options, chaque appel d'horloge dans chacun des dizaines de threads/
    // processus de Chromium sérialise sur le même sémaphore -> le navigateur
    // devient quasi inutilisable). N'affecte en rien la logique testée
    // (local-backend.js/session.js tournent identiquement en page unique).
    args: ["--no-sandbox", "--single-process", "--no-zygote"],
    env: Object.assign({}, process.env, {
      LD_PRELOAD: LIBFAKETIME,
      FAKETIME_TIMESTAMP_FILE: FT_FILE,
      // Réglage CLÉ : on ne fausse QUE l'horloge murale (Date.now), jamais
      // l'horloge monotone (performance.now) — exactement ce qui se passe
      // quand un être humain change la date dans les Réglages de son OS :
      // le compteur d'uptime matériel, lui, ne bouge jamais.
      FAKETIME_DONT_FAKE_MONOTONIC: "1",
      // (pas de FAKETIME_NO_CACHE : la valeur par défaut du cache de
      // libfaketime est ~10s — on attend ce délai après avoir écrit une
      // nouvelle horloge avant de compter sur sa prise en compte, voir plus bas.)
    }),
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  await dismissWelcomeIfAny(page);
  await page.waitForFunction(() => !!(window.PiloteoAuth && window.PiloteoLocal), { timeout: 5000 });

  // Témoin : l'horloge "OS" (fausse mais honnête pour l'instant) correspond
  // bien à l'heure réelle vue par la page — la baseline n'est pas biaisée.
  const clockCheck = await page.evaluate(() => ({ dateNow: Date.now(), perf: performance.now() }));
  const realNow = Date.now();
  ok(Math.abs(clockCheck.dateNow - realNow) < 5000, `témoin : horloge de la page proche de l'heure réelle avant toute manipulation (delta=${Math.abs(clockCheck.dateNow - realNow)}ms)`);

  const PIN = "97531";
  await page.evaluate((pin) => window.PiloteoLocal._authSetPin(pin, { lockOnOpen: true }), PIN);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#piloteo-lock-pin", { timeout: 10000 });

  // On construit un blocage de 32s réelles (10 échecs -> exposant 5 ->
  // 2^5=32s), en ATTENDANT réellement chaque fenêtre avant l'échec suivant
  // (un essai fait PENDANT un blocage est refusé par `canAttempt` avant même
  // d'appeler `verifyPin`/`registerFailure` — il ne compte pas comme un
  // nouvel échec). 32s réelles donne une marge confortable au-dessus du
  // temps réel que prendra l'ATTAQUE elle-même (écriture fichier + attente du
  // cache libfaketime ~10s + reload), pour que le contournement ne puisse
  // JAMAIS être confondu avec "le blocage s'est juste écoulé normalement".
  console.log("\n=== Construction d'un blocage de 32s réelles (10 échecs, attente réelle entre chaque) ===");
  async function submitWrongAndWait() {
    const before = await page.evaluate(() => window.PiloteoLocal._authState().failedAttempts);
    await page.fill("#piloteo-lock-pin", "00000");
    await page.click("#piloteo-lock-submit");
    await page.waitForFunction((n) => window.PiloteoLocal._authState().failedAttempts > n, before, { timeout: 5000 });
    return page.evaluate(() => window.PiloteoLocal._authState());
  }
  let st = null;
  for (let i = 0; i < 5; i++) st = await submitWrongAndWait(); // échecs 1..5 : le 5e pose le 1er lockedUntil (aucune attente nécessaire, gate ouvert jusque-là)
  for (let i = 0; i < 4; i++) { // 4 cycles de plus -> failedAttempts 6..9, puis le 10e ci-dessous
    while (true) {
      const gate = await page.evaluate(() => { const PA = window.PiloteoAuth; return PA.canAttemptCrossChecked(window.PiloteoLocal._authState(), Date.now(), Date.now()); });
      if (gate.allowed) break;
      await new Promise((r) => setTimeout(r, Math.min(gate.waitMs + 100, 3000)));
    }
    st = await submitWrongAndWait();
  }
  // À ce stade failedAttempts=9 ; on attend l'expiration puis on pose le 10e
  // échec, qui porte le blocage à exposant 5 (32s réelles).
  while (true) {
    const gate = await page.evaluate(() => { const PA = window.PiloteoAuth; return PA.canAttemptCrossChecked(window.PiloteoLocal._authState(), Date.now(), Date.now()); });
    if (gate.allowed) break;
    await new Promise((r) => setTimeout(r, Math.min(gate.waitMs + 100, 3000)));
  }
  st = await submitWrongAndWait();
  const realNowAfterBuildup = Date.now();
  ok(st.failedAttempts === 10 && (st.lockedUntil - realNowAfterBuildup) > 25000,
    `10 échecs enregistrés, blocage réel d'au moins ~32s posé (failedAttempts=${st.failedAttempts}, lockedUntil dans ${st.lockedUntil - realNowAfterBuildup}ms)`);
  const stateAfter5 = st;

  console.log("\n=== TÉMOIN 1 : état de l'overlay juste après le 10e échec, SANS manipulation -> doit rester BLOQUÉ ===");
  {
    // L'UI désactive elle-même le champ/bouton pendant un blocage
    // (`refreshLockoutDisplay`/`setBusy`) : une tentative de saisie n'a donc
    // même pas de prise — le champ est `disabled`. C'est déjà la preuve que
    // le blocage réel est bien appliqué normalement (pas un artefact du test).
    const disabled = await page.locator("#piloteo-lock-pin").isDisabled().catch(() => null);
    ok(disabled === true, `témoin : champ de saisie DÉSACTIVÉ (blocage actif, aucune manipulation d'horloge)`);
    const msg = await page.locator("#piloteo-lock-msg").textContent().catch(() => "");
    ok(/Trop de tentatives/.test(msg || ""), `témoin : message de blocage affiché ("${msg}")`);
    const gateNow = await page.evaluate(() => { const PA = window.PiloteoAuth; return PA.canAttemptCrossChecked(window.PiloteoLocal._authState(), Date.now(), Date.now()); });
    ok(gateNow.allowed === false && gateNow.waitMs > 20000, `témoin : canAttemptCrossChecked refuse toujours, waitMs=${gateNow.waitMs}ms restants (attendu ~30s+)`);
  }

  console.log("\n=== TÉMOIN 2 : reload seul (sans manipulation d'horloge) ne lève pas non plus le blocage ===");
  {
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#piloteo-lock-pin", { timeout: 10000 });
    const gate = await page.evaluate(() => {
      const PA = window.PiloteoAuth;
      const st = window.PiloteoLocal._authState();
      return PA.canAttemptCrossChecked(st, Date.now(), Date.now()); // approx : on lit juste l'état, pas de manip
    });
    ok(gate.allowed === false, `témoin : après un simple reload (horloge honnête), le blocage tient toujours (waitMs=${gate.waitMs})`);
  }

  console.log("\n=== ATTAQUE : horloge SYSTÈME avancée (PAS de script dans la page) + reload ===");
  {
    const stBefore = await page.evaluate(() => window.PiloteoLocal._authState());
    const realT0 = Date.now();
    console.log(`  lockedUntil actuel (réel) dans ${stBefore.lockedUntil - realT0}ms`);

    // L'ATTAQUE elle-même : faire croire au PROCESSUS navigateur que l'horloge
    // murale du système a avancé de 2 jours — SANS toucher à performance.now
    // (FAKETIME_DONT_FAKE_MONOTONIC=1, réglé au lancement du navigateur), en
    // écrivant simplement le fichier lu par libfaketime. C'est l'équivalent
    // exact d'aller dans Réglages > Date & heure de l'OS et d'avancer la date
    // — zéro ligne de JavaScript exécutée dans la page.
    writeFakeTimeAbsolute(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
    // Le cache interne de libfaketime (~10s par défaut, mesuré empiriquement)
    // doit expirer avant que le PROCESSUS navigateur ne relise le fichier —
    // c'est l'équivalent réaliste du temps qu'il faut à un OS pour propager
    // un changement de date à toutes ses horloges internes, pas un artefact
    // du test. On attend large (11s) pour ne dépendre d'aucun timing fin.
    await new Promise((r) => setTimeout(r, 11000));

    // Un rechargement de page (F5) est un geste utilisateur banal, pas un
    // script : il refait exécuter local-backend.js, qui recapture
    // `_clockRefWall = Date.now()` — cette fois-ci depuis l'horloge système
    // DÉJÀ mensongère.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#piloteo-lock-pin", { timeout: 10000 });

    const realT1 = Date.now(); // horloge Node (réelle, jamais faussée) : mesure le temps RÉEL écoulé
    await page.fill("#piloteo-lock-pin", PIN);
    await page.click("#piloteo-lock-submit");
    const unlocked = await page.waitForFunction(() => !document.getElementById("piloteo-lock"), { timeout: 3000 }).then(() => true).catch(() => false);
    const realElapsedMs = Date.now() - realT1;

    broken(unlocked === true,
      `déverrouillage réussi en ${realElapsedMs}ms réels (mesurés par l'horloge Node, jamais faussée) après avoir seulement avancé l'horloge SYSTÈME du navigateur (pas de script dans la page) puis rechargé — le blocage exponentiel (qui exigeait un vrai blocage de ${stBefore.lockedUntil - realT0}ms) est intégralement contourné`);

    if (unlocked) {
      const finalState = await page.evaluate(() => window.PiloteoLocal._authState());
      ok(finalState.status === "active", `session active après contournement (${JSON.stringify(finalState)})`);
      const stateResp = await page.evaluate(async () => { const r = await fetch("/api/state"); return r.status; });
      broken(stateResp === 200, "/api/state accessible après le contournement par horloge système (impact : accès complet aux données, brute-force du PIN sans aucune attente réelle)");
    }
  }

  await ctx.close();
} catch (e) {
  failures.push("exception: " + (e && e.message || e));
  console.error(e);
} finally {
  if (browser) await browser.close();
  srv.kill("SIGTERM");
  try { const { unlinkSync } = await import("node:fs"); unlinkSync(FT_FILE); } catch {}
}

console.log("\n--- Bilan (round 2) ---");
if (failures.length) {
  console.log(`${failures.length} problème(s) dans le harnais de test lui-même :`);
  failures.forEach((f) => console.log(" -", f));
}
if (brokenList.length) {
  console.log(`\nVERDICT : CASSÉ — ${brokenList.length} repro(s) contournent le recoupement d'horloge SANS exécuter de script dans la page :`);
  brokenList.forEach((f) => console.log(" - " + f));
  process.exit(1);
}
if (failures.length) process.exit(1);
console.log("VERDICT : TENU sur cet angle — le recoupement d'horloge résiste.");
process.exit(0);
