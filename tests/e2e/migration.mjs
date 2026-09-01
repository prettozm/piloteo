// tests/e2e/migration.mjs
//
// Smoke E2E navigateur (Playwright + Chromium) du Point 5
// (docs/next/MIGRATION_MODE_CONTRACT.md §4, scénarios 7-9) : prouve, DANS UN
// VRAI NAVIGATEUR, que la migration à la bascule de mode (solo -> org) est
// vérifiée AVANT toute bascule, jamais destructive, jamais aveugle sur une
// cible non vide. Style identique à tests/e2e/org-onboarding.mjs (mêmes hooks
// `__openOrgEngineFromHandle`/fausse FileSystemDirectoryHandle en mémoire) et
// tests/e2e/solo-folder.mjs.
//
// Le sélecteur natif (`showDirectoryPicker`) n'étant pas automatisable
// (absent de ce Chromium headless — vérifié : `typeof window.showDirectoryPicker
// === "undefined"`), les scénarios 7-9 pilotent l'orchestration RÉELLE de
// local-backend.js (`runGuardedMigration`, exposée via
// `window.PiloteoLocal._runGuardedMigration`) directement sur des engines
// construits via les hooks de test des ponts. Les scénarios 10-12 vont plus
// loin et exercent les VRAIES `activateFolder()`/`activateCreateOrg()` de
// bout en bout (§3 du contrat, pas UI explicite) : `window.PiloteoNext.pickDirectory`/
// `window.PiloteoOrg.pickDirectory` sont de simples propriétés d'objet
// (jamais un import fermé) et sont donc substituables depuis la page pour
// injecter un faux `FileSystemDirectoryHandle`, sans dupliquer la logique
// métier — `hasFileSystemAccess` est de même juste une propriété forcée à
// `true` pour l'occasion (ne change AUCUN comportement testé, seule la garde
// d'entrée « navigateur non compatible » est contournée).
//
// Prouve, dans l'ordre :
//   7. Solo peuplé (plusieurs collections) -> migration vers une org VIDE ->
//      verifyRoundTrip OK -> `/api/state` (mode org) renvoie le MÊME état
//      métier que le solo AVANT bascule ; une sauvegarde .piloteobackup a été
//      déclenchée ; le mode est bien passé à "org".
//   8. Cible non vide (données ÉTRANGÈRES, pas une reprise) -> migration
//      refusée (`"target-not-empty"`), solo TOUJOURS actif, aucune perte, la
//      cible étrangère n'est pas altérée.
//   9. Échec de la vérification finale simulé (hook
//      `__forceNextVerificationFailure`) -> pas de bascule, solo intact
//      (même si l'écriture elle-même avait réussi côté cible).
//   10. Pas UI explicite (§3), de bout en bout via la VRAIE `activateFolder()` :
//       message initial (compte + cible + annonce de sauvegarde) ->
//       Continuer -> indicateur de progression -> résultat "Migration
//       réussie" -> Fermer -> bascule réelle en mode Dossier.
//   11. Pas UI explicite, de bout en bout via la VRAIE `activateCreateOrg()`,
//       avec un échec de vérification simulé : résultat "Rien n'a changé, vos
//       données locales sont intactes." -> Fermer -> promesse rejetée, PAS de
//       bascule en mode org.
//   12. Message DÉDIÉ `target-not-empty` pour l'organisation (symétrique du
//       confirm() du Dossier) : cible étrangère -> résultat dédié affiché
//       ("contient déjà un espace Pilotéo") -> refus, solo intact.
//   13. CONTRARIANT (durcissement, cf. attack-p5-migration.test.mjs point 3) :
//       `importBackupText()` REFUSE un .piloteobackup contenant deux entités
//       distinctes de même identité — jamais une collision installée
//       silencieusement dans IndexedDB.
//
// Usage : node tests/e2e/migration.mjs
//   PW_CHROMIUM=<chemin> pour piloter un binaire Chromium précis.

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

// Même fausse FileSystemDirectoryHandle en mémoire que tests/e2e/org-onboarding.mjs.
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

  await page.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(
    () => !!window.PiloteoOrg && !!window.PiloteoMigration && !!window.PiloteoLocal,
    { timeout: 5000 }
  );
  ok(true, "ponts chargés (PiloteoOrg, PiloteoMigration, PiloteoLocal)");
  // CSP (script-src sans 'unsafe-inline') bloque addScriptTag inline : on passe
  // par page.evaluate (CDP Runtime.evaluate, non soumis à la CSP de la page).
  await page.evaluate(fakeDirHandleFactorySource);

  // Ferme l'écran d'accueil s'il est là (non bloquant pour la suite).
  await page.evaluate(() => document.getElementById("piloteo-welcome")?.querySelector("button")?.click());
  // Erreurs de chargement bénignes (manifest/branding, cf. tests/e2e/org-onboarding.mjs)
  // avant nos scénarios : ne comptent pas dans les assertions "aucune erreur console".
  consoleErrors.length = 0;

  // ==========================================================================
  // 7. Solo peuplé -> migration vers une org VIDE -> verifyRoundTrip OK ->
  //    /api/state (org) == solo avant bascule ; sauvegarde produite ; mode org actif.
  // ==========================================================================
  const scenario7 = await page.evaluate(async () => {
    // Remplace le solo par un état CONTRÔLÉ (plusieurs collections, schéma
    // valide) — pas le seed.json de démo réel (dates/ids hérités du format V1,
    // hors sujet ici : Point 5 migre fidèlement CE QUI EST VALIDE, la
    // normalisation d'un éventuel seed legacy est hors périmètre de ce lot).
    const before = await (await fetch("/api/state")).json();
    const solo = {};
    Object.keys(before.state).forEach((c) => { solo[c] = []; });
    solo.consultants = [{ id: "c-mig", nom: "Migrée", trigramme: "MIG", statut: "en poste", admin: false, tempsPartiel: [] }];
    solo.saisies = [
      { id: "s-mig-1", date: "2026-08-30", consultantId: "c-mig", type: "interne", missionId: null, categorie: "adm", dureeH: 2, pctFact: 0, commentaire: "" },
    ];
    const putRes = await fetch("/api/state", { method: "PUT", body: JSON.stringify({ state: solo }) });
    const soloBefore = (await putRes.json()).state;

    const backupCountBefore = window.PiloteoLocal._preMigrationBackupCount();

    // Org VIDE fraîchement créée (fausse FileSystemDirectoryHandle, cf. hooks
    // de test — même pattern que tests/e2e/org-onboarding.mjs). `createOrg`
    // seule (sans passer par `activateOrgStorageMode`) NE bascule PAS le mode
    // (Point 5 : différé jusqu'à vérification, cf. piloteo-org-bridge.mjs).
    const handle = new window.__FakeDirHandle("PiloteoMigrationE2E-vide");
    const bobIdentity = await window.PiloteoOrg.__identityStore.create();
    const { engine, adapter } = await window.PiloteoOrg.createOrg({ handle, name: "Migration E2E", consultantId: "c-mig", identity: bobIdentity });

    const migration = await window.PiloteoLocal._runGuardedMigration(engine, soloBefore);

    // Bascule RÉELLE (ce que fait activateCreateOrg après vérification OK).
    await window.PiloteoOrg.activateOrgStorageMode(handle);
    window.PiloteoLocal._useOrgEngineForTest(engine, adapter);

    const afterState = await (await fetch("/api/state")).json();
    const backupCountAfter = window.PiloteoLocal._preMigrationBackupCount();

    function byId(list, key) {
      const m = {};
      (list || []).forEach((x) => { m[String(x[key !== undefined ? key : "id"])] = JSON.stringify(x); });
      return m;
    }
    const collections = Object.keys(soloBefore);
    const sameSets = collections.every((c) => {
      const key = c === "bordereauxFrais" ? "numero" : "id";
      const a = byId(soloBefore[c], key), b = byId(afterState.state[c], key);
      const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
      return JSON.stringify(ka) === JSON.stringify(kb) && ka.every((id) => a[id] === b[id]);
    });

    return {
      migrationFailed: migration.failed,
      migrationBlocked: migration.blocked,
      migrationKind: migration.kind,
      migrated: migration.migrated,
      backupTriggered: backupCountAfter > backupCountBefore,
      orgStorageMode: window.PiloteoLocal._orgStorageMode(),
      sameBusinessState: sameSets,
      soloConsultantCount: soloBefore.consultants.length,
      afterConsultantCount: afterState.state.consultants.length,
    };
  });

  ok(!scenario7.migrationFailed, "migration acceptée (pas d'échec)");
  ok(!scenario7.migrationBlocked, "cible vide -> pas bloquée");
  ok(scenario7.migrationKind === "seed", `plan de migration = "seed" (reçu ${scenario7.migrationKind})`);
  ok(scenario7.migrated === true, "migration effectivement appliquée");
  ok(scenario7.backupTriggered, "une sauvegarde .piloteobackup a été déclenchée AVANT l'écriture cible");
  ok(scenario7.orgStorageMode, "local-backend.js a basculé en storageMode=\"org\"");
  ok(scenario7.sameBusinessState, "/api/state (mode org) renvoie le MÊME état métier que le solo avant bascule");
  ok(scenario7.afterConsultantCount === scenario7.soloConsultantCount, "aucune entité perdue ni dupliquée");
  ok(consoleErrors.length === 0, `aucune erreur console (scénario 7) (${consoleErrors.length})`);
  if (consoleErrors.length) consoleErrors.slice(0, 5).forEach((e) => console.log("    console:", e));

  // Retour à cet appareil pour isoler les scénarios suivants.
  await page.evaluate(() => window.PiloteoLocal._deactivateOrg());

  // ==========================================================================
  // 8. Cible non vide (données ÉTRANGÈRES) -> migration refusée, solo TOUJOURS
  //    actif, aucune perte, cible étrangère non altérée.
  // ==========================================================================
  const scenario8 = await page.evaluate(async () => {
    const soloBefore = (await (await fetch("/api/state")).json()).state;
    const storageModeBefore = window.PiloteoLocal._storageMode();

    // Cible avec des données ÉTRANGÈRES (aucun rapport avec le solo courant) :
    // une "autre" organisation, déjà peuplée par quelqu'un d'autre.
    const handle = new window.__FakeDirHandle("PiloteoMigrationE2E-etrangere");
    const carolIdentity = await window.PiloteoOrg.__identityStore.create();
    const { engine } = await window.PiloteoOrg.createOrg({ handle, name: "Autre organisation", consultantId: "c-carol", identity: carolIdentity });
    const foreignState = {
      ...soloBefore,
      consultants: [{ id: "c-etranger", nom: "Personne Étrangère", trigramme: "ETR", statut: "en poste", admin: false, tempsPartiel: [] }],
    };
    await engine.commit(foreignState);
    const targetBefore = (await engine.load()).state;

    const migration = await window.PiloteoLocal._runGuardedMigration(engine, soloBefore);

    const targetAfter = (await engine.load()).state;
    const soloAfter = (await (await fetch("/api/state")).json()).state;

    return {
      migrationBlocked: migration.blocked,
      migrationFailed: migration.failed,
      migrationKind: migration.kind,
      storageModeUnchanged: window.PiloteoLocal._storageMode() === storageModeBefore,
      orgStorageMode: window.PiloteoLocal._orgStorageMode(),
      targetUntouched: JSON.stringify(targetBefore.consultants) === JSON.stringify(targetAfter.consultants),
      soloUntouched: JSON.stringify(soloBefore.consultants) === JSON.stringify(soloAfter.consultants),
      targetForeignConsultantId: (targetAfter.consultants[0] || {}).id,
    };
  });

  ok(scenario8.migrationBlocked, `cible non vide (étrangère) -> "target-not-empty" (kind reçu ${scenario8.migrationKind})`);
  ok(!scenario8.migrationFailed, "\"blocked\" n'est pas un \"failed\" (distinction du contrat §2 point 2)");
  ok(scenario8.storageModeUnchanged, "mode de stockage INCHANGÉ (pas de bascule)");
  ok(!scenario8.orgStorageMode, "mode org PAS actif après un refus");
  ok(scenario8.targetUntouched, "la cible étrangère n'a subi AUCUNE écriture (jamais d'écrasement/fusion)");
  ok(scenario8.soloUntouched, "les données solo sont INTACTES (aucune perte)");
  ok(scenario8.targetForeignConsultantId === "c-etranger", "la cible garde ses propres données étrangères telles quelles");

  // ==========================================================================
  // 9. Échec de la vérification finale simulé -> pas de bascule, solo intact,
  //    même si l'écriture avait réussi côté cible.
  // ==========================================================================
  const scenario9 = await page.evaluate(async () => {
    const soloBefore = (await (await fetch("/api/state")).json()).state;
    const storageModeBefore = window.PiloteoLocal._storageMode();

    const handle = new window.__FakeDirHandle("PiloteoMigrationE2E-echec-verif");
    const daveIdentity = await window.PiloteoOrg.__identityStore.create();
    const { engine } = await window.PiloteoOrg.createOrg({ handle, name: "Vérif en échec", consultantId: "c-dave", identity: daveIdentity });

    window.PiloteoMigration.__forceNextVerificationFailure();
    const migration = await window.PiloteoLocal._runGuardedMigration(engine, soloBefore);

    const soloAfter = (await (await fetch("/api/state")).json()).state;

    return {
      migrationFailed: migration.failed,
      migrationBlocked: migration.blocked,
      migrationKind: migration.kind,
      hasDiff: Array.isArray(migration.diff) && migration.diff.length > 0,
      hasError: typeof migration.error === "string" && migration.error.length > 0,
      storageModeUnchanged: window.PiloteoLocal._storageMode() === storageModeBefore,
      orgStorageMode: window.PiloteoLocal._orgStorageMode(),
      soloUntouched: JSON.stringify(soloBefore.consultants) === JSON.stringify(soloAfter.consultants),
    };
  });

  ok(scenario9.migrationFailed, `échec de vérification -> migration.failed=true (kind reçu ${scenario9.migrationKind})`);
  ok(!scenario9.migrationBlocked, "un échec de vérification n'est pas un \"blocked\" (cible vide au départ)");
  ok(scenario9.hasDiff, "l'écart de la vérification finale est rapporté (diff non vide)");
  ok(scenario9.hasError, "un message d'erreur explicite est renvoyé");
  ok(scenario9.storageModeUnchanged, "mode de stockage INCHANGÉ malgré l'écriture réussie côté cible");
  ok(!scenario9.orgStorageMode, "mode org PAS actif après un échec de vérification");
  ok(scenario9.soloUntouched, "les données solo sont INTACTES (aucune perte, aucune bascule)");

  // ==========================================================================
  // 10. Pas UI explicite (§3), DE BOUT EN BOUT via la VRAIE activateFolder() :
  //     message (compte + cible + sauvegarde annoncée) -> Continuer ->
  //     indicateur de progression -> résultat "Migration réussie" -> Fermer
  //     -> bascule RÉELLE en mode Dossier. `window.PiloteoNext.pickDirectory`
  //     est substitué (simple propriété, pas un import fermé — voir
  //     piloteo-solo-bridge.mjs) pour contourner le sélecteur natif.
  // ==========================================================================
  await page.evaluate(() => {
    window.PiloteoNext.hasFileSystemAccess = true;
    window.PiloteoNext.pickDirectory = async () => new window.__FakeDirHandle("PiloteoMigrationE2E-ui-folder");
    window.__scenario10Promise = window.PiloteoLocal._activateFolder()
      .then((r) => ({ ok: true, value: r }))
      .catch((e) => ({ ok: false, error: e && e.message }));
  });

  await page.waitForSelector("#piloteo-migration-message", { timeout: 8000 });
  const intro10 = await page.textContent("#piloteo-migration-message");
  ok(/\d+ élément/.test(intro10), `message initial cite le nombre d'éléments (reçu: "${intro10}")`);
  ok(intro10.includes("sous forme de journal"), "message initial mentionne le journal");
  ok(intro10.includes("sauvegarde de sécurité"), "message initial annonce la sauvegarde préalable");
  ok(intro10.includes("le dossier"), "message initial nomme la cible (dossier)");

  await page.click('#piloteo-migration-actions button:has-text("Continuer")');
  await page.waitForSelector("#piloteo-migration-progress:not([hidden])", { timeout: 10000 });
  const progress10 = await page.textContent("#piloteo-migration-progress");
  ok(progress10.length > 0, `indicateur de progression affiché pendant seed+vérification (reçu: "${progress10}")`);

  await page.waitForSelector("#piloteo-migration-result:not([hidden])", { timeout: 10000 });
  const result10 = await page.textContent("#piloteo-migration-result");
  ok(result10.includes("Migration réussie"), `résultat succès affiché (reçu: "${result10}")`);

  await page.click('#piloteo-migration-actions button:has-text("Fermer")');
  const outcome10 = await page.evaluate(() => window.__scenario10Promise);
  ok(outcome10.ok, `activateFolder() (VRAIE, via le pas UI) résout avec succès (erreur éventuelle: ${outcome10.error})`);
  ok(!!(outcome10.value && outcome10.value.migration && outcome10.value.migration.migrated === true), "le résultat porte migrated:true");

  const after10 = await page.evaluate(() => ({
    storageMode: window.PiloteoLocal._storageMode(),
    hasFolderEngine: window.PiloteoLocal._hasActiveFolderEngine(),
  }));
  ok(after10.storageMode === "folder", `bascule RÉELLE en mode Dossier après le pas UI (reçu ${after10.storageMode})`);
  ok(after10.hasFolderEngine, "un engine Dossier est actif après le pas UI");

  // Retour à cet appareil pour isoler le scénario suivant.
  await page.evaluate(() => window.PiloteoLocal._deactivateFolder());

  // ==========================================================================
  // 11. Pas UI explicite, DE BOUT EN BOUT via la VRAIE activateCreateOrg(),
  //     avec un échec de vérification simulé -> résultat « Rien n'a changé,
  //     vos données locales sont intactes. » -> Fermer -> promesse rejetée,
  //     PAS de bascule en mode org.
  // ==========================================================================
  await page.evaluate(() => {
    window.PiloteoOrg.hasFileSystemAccess = true;
    window.PiloteoOrg.pickDirectory = async () => new window.__FakeDirHandle("PiloteoMigrationE2E-ui-org-echec");
    window.PiloteoMigration.__forceNextVerificationFailure();
    window.__scenario11Promise = window.PiloteoLocal._createOrg("Org UI Échec")
      .then((r) => ({ ok: true, value: r }))
      .catch((e) => ({ ok: false, error: e && e.message }));
  });

  await page.waitForSelector("#piloteo-migration-message", { timeout: 8000 });
  const intro11 = await page.textContent("#piloteo-migration-message");
  ok(intro11.includes("l'organisation"), `message initial nomme la cible (organisation) (reçu: "${intro11}")`);

  await page.click('#piloteo-migration-actions button:has-text("Continuer")');
  await page.waitForSelector("#piloteo-migration-progress:not([hidden])", { timeout: 10000 });

  await page.waitForSelector("#piloteo-migration-result:not([hidden])", { timeout: 10000 });
  const result11 = await page.textContent("#piloteo-migration-result");
  ok(result11.includes("Rien n'a changé, vos données locales sont intactes."), `résultat échec avec message « intactes » (reçu: "${result11}")`);

  await page.click('#piloteo-migration-actions button:has-text("Fermer")');
  const outcome11 = await page.evaluate(() => window.__scenario11Promise);
  ok(!outcome11.ok, "activateCreateOrg() (VRAIE, via le pas UI) est REJETÉE après un échec de vérification");
  ok((outcome11.error || "").includes("perdues"), `l'erreur finale confirme l'absence de perte (reçu: "${outcome11.error}")`);

  const after11 = await page.evaluate(() => ({
    storageMode: window.PiloteoLocal._storageMode(),
    orgStorageMode: window.PiloteoLocal._orgStorageMode(),
  }));
  ok(after11.storageMode !== "org" && !after11.orgStorageMode, "PAS de bascule en mode org après l'échec du pas UI");

  // ==========================================================================
  // 12. Message DÉDIÉ target-not-empty pour l'ORGANISATION (contrat §2 point
  //     2, symétrique du confirm() du Dossier) — via le VRAI orchestrateur
  //     `decideAndRunMigration`, SANS hook `onTargetNotEmpty` : exactement ce
  //     qu'utilise `activateCreateOrg()` (aucune logique dupliquée ici).
  // ==========================================================================
  const scenario12 = await page.evaluate(async () => {
    const soloBefore = (await (await fetch("/api/state")).json()).state;

    const handle = new window.__FakeDirHandle("PiloteoMigrationE2E-org-etrangere-ui");
    const eveIdentity = await window.PiloteoOrg.__identityStore.create();
    const { engine } = await window.PiloteoOrg.createOrg({ handle, name: "Organisation étrangère", consultantId: "c-eve", identity: eveIdentity });
    const foreignState = {
      ...soloBefore,
      consultants: [{ id: "c-etranger-2", nom: "Autrui", trigramme: "AUT", statut: "en poste", admin: false, tempsPartiel: [] }],
    };
    await engine.commit(foreignState);

    window.__scenario12Promise = window.PiloteoLocal
      ._decideAndRunMigration(engine, soloBefore, "l'organisation « Etrangère »")
      .then((r) => ({ ok: true, value: r }))
      .catch((e) => ({ ok: false, error: e && e.message }));
    return { started: true };
  });
  ok(scenario12.started, "orchestrateur UI lancé sur une cible étrangère préexistante");

  await page.waitForSelector("#piloteo-migration-result:not([hidden])", { timeout: 8000 });
  const result12 = await page.textContent("#piloteo-migration-result");
  ok(result12.includes("contient déjà un espace Pilotéo"), `message DÉDIÉ target-not-empty pour l'org (reçu: "${result12}")`);
  ok(result12.includes("Choisissez un dossier vide, ou ouvrez l'existant sans migrer."), "message précise la marche à suivre");

  await page.click('#piloteo-migration-actions button:has-text("Fermer")');
  const outcome12 = await page.evaluate(() => window.__scenario12Promise);
  ok(!outcome12.ok, "orchestrateur REJETÉ sur cible étrangère (jamais un succès silencieux)");
  ok((outcome12.error || "").includes("contient déjà un espace Pilotéo"), "l'erreur finale porte le message dédié");

  // ==========================================================================
  // 13. CONTRARIANT (durcissement) : importBackupText() REFUSE explicitement
  //     un .piloteobackup portant deux entités DISTINCTES avec la même
  //     identité (collision) — jamais un import silencieux qui installerait
  //     la collision dans IndexedDB (repro attack-p5-migration.test.mjs point
  //     3, cf. src/integration/migration.js + solo-store.js).
  // ==========================================================================
  const scenario13 = await page.evaluate(async () => {
    const before = (await (await fetch("/api/state")).json()).state;
    const dupState = {};
    Object.keys(before).forEach((c) => { dupState[c] = []; });
    dupState.consultants = [
      { id: "c-dup", nom: "Alice Dupont", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] },
      { id: "c-dup", nom: "Ève Usurpatrice", trigramme: "EVE", statut: "en poste", admin: false, tempsPartiel: [] },
    ];
    const backupText = JSON.stringify({
      format: "piloteo-backup-v1",
      exportedAt: new Date().toISOString(),
      revision: 1,
      manifest: {},
      state: dupState,
    });

    let importError = null;
    try {
      await window.PiloteoLocal._importBackupText(backupText);
    } catch (e) {
      importError = e && e.message;
    }

    const after = (await (await fetch("/api/state")).json()).state;
    return {
      importError,
      stateUnchanged: JSON.stringify(before) === JSON.stringify(after),
      afterHasDuplicate: (after.consultants || []).filter((c) => c.id === "c-dup").length,
    };
  });

  ok(!!scenario13.importError, `import d'un backup à identités dupliquées REJETÉ (erreur reçue: ${scenario13.importError})`);
  ok((scenario13.importError || "").includes("Import refusé"), `message clair « Import refusé » (reçu: "${scenario13.importError}")`);
  ok((scenario13.importError || "").includes("c-dup"), `le message cite l'identité en collision (reçu: "${scenario13.importError}")`);
  ok(scenario13.stateUnchanged, "l'état solo est INCHANGÉ après le refus (aucune donnée modifiée)");
  ok(scenario13.afterHasDuplicate === 0, "aucune trace du doublon dans l'état après le refus");
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
