// tests/e2e/org-promotion.mjs
//
// Smoke E2E navigateur (Playwright + Chromium), STYLE tests/e2e/org-onboarding.mjs :
// prouve, DANS UN VRAI NAVIGATEUR, docs/next/PARCOURS_IDENTITE_CONTRACT.md
// Lot 1 (accueil à 2 choix) + Lot 2 (« Partager cet espace » — promotion en
// place, MÊME workspaceId) via le VRAI câblage `local-backend.js` (pas
// seulement les ponts), au-dessus d'un `FileSystemDirectoryHandle` EN MÉMOIRE
// (même sous-ensemble d'API que tests/e2e/org-onboarding.mjs), sans dépendre
// du sélecteur natif.
//
// Prouve, dans l'ordre :
//   1. accueil : EXACTEMENT 2 cartes, « Créer une organisation » absente ;
//      « Travailler seul » démarre en solo (mode classique) ;
//   2. solo AVEC données (consultants/missions/saisies) -> « Partager cet
//      espace » (hook `_shareSpace`, dossier factice) -> org active,
//      workspaceId INCHANGÉ (== celui de l'espace solo AVANT promotion),
//      données visibles, owner = moi (role admin côté /api/me, role owner
//      côté membership org réel) ;
//   3. Réglages : quand redevenu solo, DEUX entrées distinctes « Partager cet
//      espace »/« Rejoindre une organisation » (jamais l'ancien bouton
//      unique) ;
//   4. idempotence : un 2e appel de promotion sur le MÊME dossier avec la
//      MÊME identité est un no-op sûr (`alreadyPromoted:true`), toujours un
//      seul owner, jamais un second manifeste ;
//   5. non-régression : `createOrganization`/`createOrg` (org neuve, flux
//      indépendant de la promotion) fonctionne toujours.
//
// Usage : node tests/e2e/org-promotion.mjs
//   PW_CHROMIUM=<chemin> pour piloter un binaire Chromium précis.

let _pw;
try { _pw = await import("playwright"); }
catch { _pw = await import("/opt/node22/lib/node_modules/playwright/index.js"); }
const chromium = _pw.chromium || _pw.default.chromium;

import { spawn } from "node:child_process";

const ROOT = new URL("../..", import.meta.url).pathname;
const PORT = 8201;
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

// Même simulateur EN MÉMOIRE de FileSystemDirectoryHandle que
// tests/e2e/org-onboarding.mjs (même sous-ensemble d'API).
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

  // ==========================================================================
  // 1. Accueil (Lot 1) : EXACTEMENT 2 cartes, « Créer une organisation »
  //    absente, « Travailler seul » démarre en solo.
  // ==========================================================================
  await page.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  ok(true, "mode classique (par défaut) démarre toujours");

  const welcomeVisible = await page.locator("#piloteo-welcome").isVisible().catch(() => false);
  ok(welcomeVisible, "écran de premier lancement affiché");
  const cardCount = await page.locator("#piloteo-welcome button").count();
  ok(cardCount === 2, `EXACTEMENT 2 cartes à l'accueil, Lot 1 (trouvé ${cardCount})`);
  const welcomeText = await page.locator("#piloteo-welcome").innerText();
  ok(/Travailler seul/i.test(welcomeText), "carte « Travailler seul » présente");
  ok(/Rejoindre une organisation/i.test(welcomeText), "carte « Rejoindre une organisation » présente");
  ok(!/Créer une organisation/i.test(welcomeText), "« Créer une organisation » ABSENTE de l'accueil (Lot 1)");

  await page.waitForFunction(() => !!window.PiloteoOrg, { timeout: 5000 }).catch(() => {});
  await page.click("#piloteo-welcome button"); // « Continuer » (carte 1, Travailler seul)
  await page.waitForFunction(() => !document.getElementById("piloteo-welcome"), { timeout: 3000 }).catch(() => {});
  ok(!(await page.locator("#piloteo-welcome").isVisible().catch(() => false)), "« Travailler seul » ferme l'accueil, solo actif");

  await page.evaluate(fakeDirHandleFactorySource);

  // ==========================================================================
  // 2. Solo AVEC données -> « Partager cet espace » -> org active, MÊME
  //    workspaceId, données visibles, owner = moi.
  // ==========================================================================
  const soloWorkspaceIdBefore = await page.evaluate(() => window.PiloteoLocal._getSoloWorkspaceId());
  ok(typeof soloWorkspaceIdBefore === "string" && soloWorkspaceIdBefore.length > 0,
    `workspaceId solo « cet appareil » persisté AVANT promotion (${soloWorkspaceIdBefore})`);
  const soloWorkspaceIdAgain = await page.evaluate(() => window.PiloteoLocal._getSoloWorkspaceId());
  ok(soloWorkspaceIdAgain === soloWorkspaceIdBefore, "workspaceId solo FIXE (relu identique)");

  // Seed des données solo AVANT promotion — un état CONTRÔLÉ, schéma valide
  // (même convention que tests/e2e/migration.mjs scénario 7 et
  // tests/e2e/org-onboarding-drive.mjs scénario « échec de migration ») :
  // PAS le seed.json de démo réel, dont certaines « saisies »/« notesFrais »
  // portent des ids hérités du format V1 rejetés par la validation de schéma
  // (`snapshotToEventsDiff`) — hors sujet ici, la promotion migre fidèlement
  // CE QUI EST VALIDE, la normalisation d'un seed legacy est un autre lot.
  const seedResult = await page.evaluate(async () => {
    const current = await (await fetch("/api/state")).json();
    const solo = {};
    Object.keys(current.state).forEach((c) => { solo[c] = []; });
    solo.consultants = [
      { id: "c-promo", nom: "Alice Promo", trigramme: "APR", statut: "en poste", admin: true, tempsPartiel: [] },
      { id: "c-promo-2", nom: "Bob Promo", trigramme: "BPR", statut: "en poste", admin: false, tempsPartiel: [] },
    ];
    solo.saisies = [
      { id: "s-promo-1", date: "2026-08-30", consultantId: "c-promo", type: "interne", missionId: null, categorie: "adm", dureeH: 2, pctFact: 0, commentaire: "" },
    ];
    const put = await (await fetch("/api/state", { method: "PUT", body: JSON.stringify({ state: solo }) })).json();
    return { consultantPresent: (put.state.consultants || []).some((c) => c.id === "c-promo"), consultantCount: put.state.consultants.length };
  });
  ok(seedResult.consultantPresent, "donnée solo seedée AVANT promotion (consultant c-promo)");

  // Bruit de chargement de page (favicon/manifest…) sans rapport avec la
  // promotion — même convention que tests/e2e/org-onboarding.mjs.
  consoleErrors.length = 0;

  // NOTE méthodologique (même convention que tests/e2e/migration.mjs
  // scénario 7 et tests/e2e/org-onboarding.mjs pour « Créer une
  // organisation ») : `activateShareSpace`/`_shareSpace` orchestre le VRAI
  // pas UI de migration (`decideAndRunMigration`), qui attend un clic RÉEL
  // sur « Continuer » puis « Fermer » (overlay `#piloteo-migration-step`) —
  // un `await` sur cette promesse DANS `page.evaluate` bloque indéfiniment
  // tant que Playwright ne clique pas ces boutons depuis l'EXTÉRIEUR. Ce test
  // exerce donc le MÊME mécanisme sous-jacent que `_shareSpace`
  // (`window.PiloteoOrg.promoteToOrg` -> pipeline de migration Point 5 ->
  // `activateOrgStorageMode`) via le hook bas niveau SANS UI
  // `_runGuardedMigration` (déjà utilisé ainsi par migration.mjs pour
  // `createOrg`), sans dupliquer la moindre logique de décision — seule
  // l'attente d'un clic est court-circuitée.
  const promotionResult = await page.evaluate(async () => {
    const handle = new window.__FakeDirHandle("PiloteoPromotionE2E");
    window.__promoHandle = handle; // réutilisé pour le test d'idempotence (scénario 4)

    const soloBefore = await (await fetch("/api/state")).json();
    const workspaceId = await window.PiloteoLocal._getSoloWorkspaceId();
    const { engine, adapter, manifest } = await window.PiloteoOrg.promoteToOrg({
      handle, workspaceId, name: "Cabinet Promotion E2E", consultantId: "c-promo",
    });

    const migration = await window.PiloteoLocal._runGuardedMigration(engine, soloBefore.state);
    await window.PiloteoOrg.activateOrgStorageMode(handle);
    window.PiloteoLocal._useOrgEngineForTest(engine, adapter);

    const me = await (await fetch("/api/me")).json();
    const st = await (await fetch("/api/state")).json();
    const members = await engine.members();
    const myIdentity = await window.PiloteoOrg.getOrCreateIdentity();

    return {
      manifestWorkspaceId: manifest.workspaceId,
      migrationOk: !migration.failed,
      storageModeIsOrg: window.PiloteoLocal._orgStorageMode(),
      meRole: me.user && me.user.role,
      consultantStillPresent: (st.state?.consultants || []).some((c) => c.id === "c-promo"),
      consultantCountBefore: soloBefore.state.consultants.length,
      consultantCountAfter: st.state.consultants.length,
      memberCount: members.length,
      ownerRole: (members.find((m) => m.memberId === myIdentity.memberId) || {}).role,
    };
  });

  ok(promotionResult.manifestWorkspaceId === soloWorkspaceIdBefore,
    `workspaceId APRÈS promotion == workspaceId solo D'ORIGINE (${promotionResult.manifestWorkspaceId} vs ${soloWorkspaceIdBefore})`);
  ok(promotionResult.migrationOk, "republication des événements solo (pipeline Point 5) acceptée, verifyRoundTrip OK");
  ok(promotionResult.storageModeIsOrg, "local-backend.js bascule en storageMode=\"org\" après promotion vérifiée");
  ok(promotionResult.meRole === "admin", `/api/me renvoie role=admin pour l'owner promu (reçu ${promotionResult.meRole})`);
  ok(promotionResult.consultantStillPresent, "les données solo (consultant c-promo) sont VISIBLES après promotion");
  ok(promotionResult.consultantCountAfter === promotionResult.consultantCountBefore,
    `aucune perte NI duplication de données (avant=${promotionResult.consultantCountBefore}, après=${promotionResult.consultantCountAfter})`);
  ok(promotionResult.memberCount === 1, `exactement 1 membre après promotion (owner seul) — reçu ${promotionResult.memberCount}`);
  ok(promotionResult.ownerRole === "owner", `owner == identité solo, rôle "owner" depuis le manifeste (reçu ${promotionResult.ownerRole})`);
  // Bruit connu, sans rapport avec la promotion (favicon/branding servis par
  // server.py, absents d'un simple `python3 -m http.server` ; GSI bloqué par
  // le bac à sable réseau de CET environnement de test — même filtrage que
  // tests/e2e/static-hardening-solo.mjs).
  const unexpectedPromotionErrors = consoleErrors.filter((e) => !/favicon|brand-logo|gsi\/client|ERR_CONNECTION_RESET/i.test(e));
  ok(unexpectedPromotionErrors.length === 0, `aucune erreur console inattendue pendant la promotion (${unexpectedPromotionErrors.length}/${consoleErrors.length})`);
  if (unexpectedPromotionErrors.length) unexpectedPromotionErrors.slice(0, 5).forEach((e) => console.log("    console:", e));

  // ==========================================================================
  // 3. Réglages : DEUX entrées distinctes visibles en solo (avant de refaire
  //    la promotion, on redevient solo pour observer le panneau tel qu'un
  //    utilisateur solo le verrait).
  // ==========================================================================
  await page.evaluate(() => { window.PiloteoLocal._deactivateOrg(); });
  await page.click("#piloteo-gear");
  await page.waitForSelector("#piloteo-reglages", { timeout: 5000 }).catch(() => {});
  const reglagesText = await page.locator("#piloteo-reglages").innerText().catch(() => "");
  ok(/Partager cet espace/i.test(reglagesText), "Réglages (solo) : entrée « Partager cet espace » présente");
  ok(/Rejoindre une organisation/i.test(reglagesText), "Réglages (solo) : entrée « Rejoindre une organisation » présente");
  ok(!/Créer \/ rejoindre une organisation/i.test(reglagesText), "l'ancien bouton unique « Créer / rejoindre » a disparu");
  await page.evaluate(() => document.getElementById("piloteo-reglages")?.remove());

  // ==========================================================================
  // 4. Idempotence : un 2e appel de promotion sur le MÊME dossier + MÊME
  //    identité -> no-op sûr, toujours 1 seul owner, jamais un 2e manifeste.
  // ==========================================================================
  consoleErrors.length = 0;
  const idempotenceResult = await page.evaluate(async () => {
    window.PiloteoOrg.pickDirectory = async () => window.__promoHandle;
    const soloWorkspaceId = await window.PiloteoLocal._getSoloWorkspaceId();

    const first = await window.PiloteoOrg.promoteToOrg({
      handle: window.__promoHandle, workspaceId: soloWorkspaceId, name: "Cabinet Promotion E2E", consultantId: null,
    });
    const second = await window.PiloteoOrg.promoteToOrg({
      handle: window.__promoHandle, workspaceId: soloWorkspaceId, name: "Cabinet Promotion E2E", consultantId: null,
    });
    const members = await second.engine.members();
    return {
      firstAlready: first.alreadyPromoted,
      secondAlready: second.alreadyPromoted,
      sameWorkspace: first.manifest.workspaceId === second.manifest.workspaceId && second.manifest.workspaceId === soloWorkspaceId,
      memberCount: members.length,
    };
  });
  ok(idempotenceResult.firstAlready === true, "réouverture d'un dossier déjà promu (organisation créée au scénario 2) -> already-promoted d'entrée");
  ok(idempotenceResult.secondAlready === true, "2e appel explicite -> already-promoted (no-op sûr, idempotent)");
  ok(idempotenceResult.sameWorkspace, "workspaceId inchangé à travers les deux appels");
  ok(idempotenceResult.memberCount === 1, `toujours EXACTEMENT 1 membre après un 2e appel (jamais un second owner) — reçu ${idempotenceResult.memberCount}`);
  ok(consoleErrors.length === 0, `aucune erreur console pendant le test d'idempotence (${consoleErrors.length})`);

  // ==========================================================================
  // 5. Non-régression : createOrg (org neuve, flux indépendant) marche
  //    toujours, avec un workspaceId DISTINCT de celui de la promotion.
  // ==========================================================================
  const freshOrgResult = await page.evaluate(async () => {
    const freshHandle = new window.__FakeDirHandle("PiloteoFreshOrgE2E");
    const bobIdentity = await window.PiloteoOrg.__identityStore.create();
    const { manifest } = await window.PiloteoOrg.createOrg({ handle: freshHandle, name: "Org fraîche E2E", consultantId: "c-bob", identity: bobIdentity });
    return { workspaceId: manifest.workspaceId };
  });
  ok(!!freshOrgResult.workspaceId, "createOrg (org neuve) fonctionne toujours (non-régression)");
  ok(freshOrgResult.workspaceId !== soloWorkspaceIdBefore, "createOrg génère un workspaceId DISTINCT de celui de la promotion (comportements bien séparés)");
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
