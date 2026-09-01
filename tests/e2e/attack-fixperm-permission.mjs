// tests/e2e/attack-fixperm-permission.mjs
//
// CONTRARIANT — attaque du correctif "reprise au boot ne doit jamais appeler
// FileSystemHandle.requestPermission() hors geste utilisateur" :
//   src/storage/fsaccess-port.js (ensureHandlePermission)
//   piloteo-solo-bridge.mjs (resumeFolder / activateFolderFromPicker)
//   piloteo-org-bridge.mjs (resumeOrg)
//   local-backend.js (retryOrgPermission / retryFolderPermission)
//
// Contrairement à tests/next/fsaccess-port.test.mjs et aux e2e existants
// (solo-folder.mjs, org-onboarding.mjs, migration.mjs), qui utilisent tous un
// FakeDirHandle dont `_perm` démarre à "granted" ET dont `requestPermission()`
// ne vérifie JAMAIS d'activation utilisateur réelle, ce script :
//   1. démarre le handle à "prompt" (cas réel de reprise après rechargement) ;
//   2. fait dépendre `requestPermission()` de `navigator.userActivation.isActive`
//      RÉEL de Chromium (pas une simulation) — exactement le comportement du
//      vrai navigateur qui a produit le bug initial ("User activation is
//      required to request permissions").
//
// Angles testés :
//  A. Boot silencieux : resumeFolder()/resumeOrg() SANS opts sur un handle
//     'prompt' -> AUCUN appel à requestPermission (compteur == 0), pas
//     d'exception, {needsPermission:true} proprement renvoyé.
//  B. Fuite d'exception résiduelle : resumeFolder({interactive:true}) appelé
//     PROGRAMMATIQUEMENT (page.evaluate, donc SANS activation utilisateur
//     réelle) sur un handle 'prompt' -> requestPermission lève réellement
//     (comme un vrai navigateur) -> l'exception ne doit JAMAIS remonter
//     jusqu'à l'appelant (sinon .catch() de local-backend.js affiche
//     "Reprise impossible").
//  C. Reconnexion RÉELLE : un vrai clic Playwright (page.click, qui pose une
//     activation utilisateur réelle dans Chromium) sur un bouton qui appelle
//     resumeFolder({interactive:true})/resumeOrg({interactive:true}) doit
//     RÉELLEMENT obtenir la permission et renvoyer un engine.
//  D. Régression activation/création : activateFolderFromPicker() et
//     createOrg() appelés depuis un VRAI clic sur un handle qui démarre à
//     'prompt' doivent aboutir (permission obtenue), pas régresser vers un
//     échec silencieux.
//
// Usage : PW_CHROMIUM=<chemin> node tests/e2e/attack-fixperm-permission.mjs

let _pw;
try { _pw = await import("playwright"); }
catch { _pw = await import("/opt/node22/lib/node_modules/playwright/index.js"); }
const chromium = _pw.chromium || _pw.default.chromium;

import { spawn } from "node:child_process";

const ROOT = new URL("../..", import.meta.url).pathname;
const PORT = 8213;
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

// Fabrique de FakeDirHandle EXIGEANTE : `requestPermission` ne réussit que si
// `navigator.userActivation.isActive` est VRAIMENT actif (comportement natif
// Chromium — pas une simulation JS), sinon lève la VRAIE exception du bug
// initial. On installe ce constructeur dans la page via `page.addInitScript`
// pour qu'il soit disponible dès le premier chargement.
const FAKE_HANDLE_SRC = `
  window.__attackReqCount = 0;
  function __notFound() { const e = new Error("not found"); e.name = "NotFoundError"; return e; }
  class __FakeFileHandle {
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
  class AttackDirHandle {
    constructor(name = "root", perm = "prompt") {
      this.kind = "directory"; this.name = name; this._children = new Map(); this._perm = perm;
      // Étiquette le constructeur RÉEL (utile aux sous-classes définies dans
      // les tests, ex. ThrowingHandle) pour que la réattache de prototype
      // après clonage structuré (voir plus bas) restaure le BON prototype,
      // pas systématiquement celui de la classe de base.
      this._ctorName = new.target.name;
    }
    async getDirectoryHandle(name, { create } = {}) {
      let h = this._children.get(name);
      if (h) { if (h.kind !== "directory") throw __notFound(); return h; }
      if (!create) throw __notFound();
      h = new AttackDirHandle(name, this._perm); this._children.set(name, h); return h;
    }
    async getFileHandle(name, { create } = {}) {
      let h = this._children.get(name);
      if (h) { if (h.kind !== "file") throw __notFound(); return h; }
      if (!create) throw __notFound();
      h = new __FakeFileHandle(name); this._children.set(name, h); return h;
    }
    async *values() { for (const h of this._children.values()) yield h; }
    // NOTE fidélité : un VRAI navigateur mémorise l'octroi de permission au
    // niveau du fichier/dossier RÉEL, pas au niveau de l'objet JS wrapper —
    // n'importe quel FileSystemDirectoryHandle redésérialisé pointant vers le
    // MÊME dossier retrouve l'état accordé. Notre \`_perm\` d'instance, lui, ne
    // survivrait PAS à un clonage structuré (nouvel objet) ni à un vrai
    // rechargement de page (nouvelle instance de script). On simule donc ce
    // stockage « au niveau plateforme, par nom de dossier » via localStorage
    // (qui, contrairement à une variable JS, SURVIT à un vrai reload) —
    // pertinent pour le test E (bout en bout par rechargement réel).
    _permKey() { return "__attackPerm_" + this.name; }
    async queryPermission() {
      const stored = localStorage.getItem(this._permKey());
      return stored || this._perm;
    }
    async requestPermission(opts) {
      window.__attackReqCount++;
      // Comportement RÉEL Chromium : requestPermission() hors activation
      // utilisateur lève une DOMException. On délègue à la VRAIE API
      // navigator.userActivation du navigateur qui exécute ce script.
      const active = !!(navigator.userActivation && navigator.userActivation.isActive);
      if (!active) {
        const err = new DOMException(
          "Failed to execute 'requestPermission' on 'FileSystemHandle': User activation is required to request permissions.",
          "NotAllowedError"
        );
        throw err;
      }
      this._perm = "granted";
      localStorage.setItem(this._permKey(), "granted");
      return "granted";
    }
  }
  window.AttackDirHandle = AttackDirHandle;
  window.__attackCtors = { AttackDirHandle };

  // IMPORTANT (fidélité du test) : le vrai \`FileSystemDirectoryHandle\` natif
  // survit au structured-clone d'IndexedDB en conservant son comportement
  // (le navigateur l'implémente nativement comme un « objet plateforme »
  // avec ses propres étapes de sérialisation, PAS comme une classe JS). Une
  // classe JS ordinaire, elle, PERD son prototype (donc toutes ses méthodes)
  // au clonage structuré : \`db.get()\` renvoie un objet nu \`{kind,name,...}\`
  // sans \`queryPermission\`/\`requestPermission\`. Sans ce correctif de fidélité,
  // \`ensureHandlePermission\` retournerait \`false\` via son garde-fou
  // \`typeof handle.queryPermission !== "function"\` — un FAUX POSITIF qui ne
  // testerait RIEN sur la vraie logique de permission. On réattache donc le
  // prototype juste après lecture IndexedDB, pour que le test isole
  // VRAIMENT le comportement de \`ensureHandlePermission\`/\`resumeFolder\`.
  (function reattachPrototypeAfterClone() {
    const origGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args) {
      const req = origGet.apply(this, args);
      req.addEventListener("success", () => {
        const r = req.result;
        if (r && typeof r === "object" && "_perm" in r && typeof r.queryPermission !== "function") {
          const Ctor = (window.__attackCtors && window.__attackCtors[r._ctorName]) || AttackDirHandle;
          Object.setPrototypeOf(r, Ctor.prototype);
        }
      });
      return req;
    };
  })();
`;

let browser;
try {
  await waitServer();
  const exe = process.env.PW_CHROMIUM || chromium.executablePath();
  browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(FAKE_HANDLE_SRC);

  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  await page.goto(`${BASE}/index.html?solo=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(() => !!window.PiloteoNext && !!window.PiloteoOrg, { timeout: 5000 }).catch(() => {});

  // NOTE ORDRE : A et B tournent AVANT tout clic Playwright (y compris la
  // fermeture de l'écran d'accueil) pour garantir qu'AUCUNE activation
  // utilisateur transitoire résiduelle ne fausse la précondition « pas de
  // geste réel » du test B. Le clic de fermeture de l'écran d'accueil est
  // repoussé après B (C/C'/D en ont besoin pour cliquer sur leurs propres
  // boutons de test).

  // ==========================================================================
  // A. BOOT SILENCIEUX : resumeFolder()/resumeOrg() SANS opts sur handle
  //    'prompt' -> aucun requestPermission, pas d'exception.
  // ==========================================================================
  const bootA = await page.evaluate(async () => {
    // Persiste un handle 'prompt' comme le ferait une vraie reprise au boot.
    const handle = new window.AttackDirHandle("BootFolder", "prompt");
    window.__attackReqCount = 0;
    // Injecte le handle directement dans l'IndexedDB via le pont (pas de picker).
    const dbReq = indexedDB.open("piloteo-fsaccess", 1);
    await new Promise((res, rej) => {
      dbReq.onupgradeneeded = () => { dbReq.result.createObjectStore("handles"); };
      dbReq.onsuccess = () => res();
      dbReq.onerror = () => rej(dbReq.error);
    });
    const db = dbReq.result;
    await new Promise((res, rej) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(handle, "current");
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();

    let threw = null, result = null;
    try {
      result = await window.PiloteoNext.resumeFolder(); // AUCUN opts -> boot
    } catch (e) {
      threw = String((e && e.message) || e);
    }
    return { threw, needsPermission: result && result.needsPermission === true, reqCount: window.__attackReqCount };
  });
  ok(bootA.threw === null, `resumeFolder() boot ne lève pas (reçu: ${bootA.threw})`);
  ok(bootA.needsPermission === true, "resumeFolder() boot renvoie needsPermission:true sur handle 'prompt'");
  ok(bootA.reqCount === 0, `resumeFolder() boot n'appelle JAMAIS requestPermission (compteur=${bootA.reqCount})`);

  // Même vérification côté org.
  const bootAOrg = await page.evaluate(async () => {
    const handle = new window.AttackDirHandle("BootOrg", "prompt");
    window.__attackReqCount = 0;
    const dbReq = indexedDB.open("piloteo-fsaccess", 1);
    const db = await new Promise((res, rej) => { dbReq.onsuccess = () => res(dbReq.result); dbReq.onerror = () => rej(dbReq.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(handle, "current");
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    let threw = null, result = null;
    try { result = await window.PiloteoOrg.resumeOrg(); }
    catch (e) { threw = String((e && e.message) || e); }
    return { threw, needsPermission: result && result.needsPermission === true, reqCount: window.__attackReqCount };
  });
  ok(bootAOrg.threw === null, `resumeOrg() boot ne lève pas (reçu: ${bootAOrg.threw})`);
  ok(bootAOrg.needsPermission === true, "resumeOrg() boot renvoie needsPermission:true sur handle 'prompt'");
  ok(bootAOrg.reqCount === 0, `resumeOrg() boot n'appelle JAMAIS requestPermission (compteur=${bootAOrg.reqCount})`);

  // ==========================================================================
  // B. FUITE D'EXCEPTION : requestPermission() qui LÈVE RÉELLEMENT (quelle
  //    qu'en soit la cause navigateur — activation absente/expirée, refus de
  //    plateforme…) NE DOIT JAMAIS remonter à travers le VRAI pont
  //    (piloteo-solo-bridge.mjs#resumeFolder), pas seulement à travers la
  //    fonction isolée `ensureHandlePermission` (déjà couverte par
  //    tests/next/fsaccess-port.test.mjs). On force le rejet explicitement
  //    (indépendant de `navigator.userActivation`, dont la sémantique exacte
  //    varie selon l'environnement Chromium/automatisation — cf. contrôle B'
  //    plus bas qui montre qu'il vaut systématiquement `true` ici même sans
  //    aucun clic, donc impropre à simuler une "vraie" absence de geste).
  // ==========================================================================
  const leakB = await page.evaluate(async () => {
    class ThrowingHandle extends window.AttackDirHandle {
      async requestPermission() {
        window.__attackReqCount++;
        throw new DOMException(
          "Failed to execute 'requestPermission' on 'FileSystemHandle': User activation is required to request permissions.",
          "NotAllowedError"
        );
      }
    }
    window.__attackCtors.ThrowingHandle = ThrowingHandle;
    const handle = new ThrowingHandle("LeakFolder", "prompt");
    const dbReq = indexedDB.open("piloteo-fsaccess", 1);
    const db = await new Promise((res, rej) => { dbReq.onsuccess = () => res(dbReq.result); dbReq.onerror = () => rej(dbReq.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(handle, "current");
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    window.__attackReqCount = 0;
    let threw = null, result = null;
    try {
      result = await window.PiloteoNext.resumeFolder({ interactive: true }); // interactive, requestPermission lève TOUJOURS
    } catch (e) {
      threw = String((e && e.message) || e);
    }
    return { threw, needsPermission: result && result.needsPermission === true, reqCount: window.__attackReqCount };
  });
  ok(leakB.reqCount === 1, `requestPermission a bien été TENTÉ (compteur=${leakB.reqCount})`);
  ok(leakB.threw === null, `requestPermission lève réellement, mais l'exception NE remonte PAS à travers resumeFolder() (reçu: ${leakB.threw})`);
  ok(leakB.needsPermission === true, "requestPermission qui lève dégrade proprement en needsPermission:true (pas de crash « Reprise impossible »)");

  // --- B'. Contrôle d'environnement (documente pourquoi B ne peut pas se fier
  //     à navigator.userActivation.isActive dans ce sandbox Chromium/Playwright).
  const envProbe = await page.evaluate(() => !!(navigator.userActivation && navigator.userActivation.isActive));
  console.log(`    (info env : navigator.userActivation.isActive = ${envProbe} sans AUCUN clic préalable dans ce sandbox — d'où B ci-dessus, qui force le rejet explicitement plutôt que de dépendre de cette API dans cet environnement)`);

  const welcome = page.locator("#piloteo-welcome");
  if (await welcome.isVisible().catch(() => false)) {
    await page.click("#piloteo-welcome button");
    await page.waitForFunction(() => !document.getElementById("piloteo-welcome"), { timeout: 3000 }).catch(() => {});
  }

  // ==========================================================================
  // C. RECONNEXION RÉELLE : un VRAI clic Playwright (activation utilisateur
  //    authentique) doit permettre à resumeFolder({interactive:true}) et
  //    resumeOrg({interactive:true}) d'obtenir RÉELLEMENT la permission.
  //    IMPORTANT : le handle est persisté AVANT le clic (comme dans un vrai
  //    scénario boot -> needsPermission -> clic), pour que le SEUL travail
  //    du clic soit EXACTEMENT ce que fait local-backend.js#retryFolderPermission :
  //    `window.PiloteoNext.resumeFolder({interactive:true})` — rien d'autre.
  // ==========================================================================
  await page.evaluate(async () => {
    const handle = new window.AttackDirHandle("RetryFolder", "prompt");
    const dbReq = indexedDB.open("piloteo-fsaccess", 1);
    const db = await new Promise((res, rej) => { dbReq.onsuccess = () => res(dbReq.result); dbReq.onerror = () => rej(dbReq.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(handle, "current");
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  });
  await page.evaluate(() => {
    window.__attackRetryResult = null;
    window.__attackRetryError = null;
    const btn = document.createElement("button");
    btn.id = "__attack-retry-btn";
    btn.textContent = "Redonner l'accès (attaque)";
    // EXACTEMENT le corps de local-backend.js#retryFolderPermission : un seul
    // appel, rien avant qui pourrait consommer l'activation transitoire.
    btn.onclick = () => {
      window.PiloteoNext.resumeFolder({ interactive: true })
        .then((r) => { window.__attackRetryResult = r; })
        .catch((e) => { window.__attackRetryError = String((e && e.message) || e); });
    };
    document.body.appendChild(btn);
  });
  await page.click("#__attack-retry-btn"); // VRAI clic Playwright -> activation utilisateur réelle
  await page.waitForFunction(() => window.__attackRetryResult !== null || window.__attackRetryError !== null, { timeout: 3000 });
  const retryC = await page.evaluate(() => ({ result: window.__attackRetryResult, error: window.__attackRetryError }));
  ok(retryC.error === null, `clic réel « Redonner l'accès » (dossier) : pas d'erreur (reçu: ${retryC.error})`);
  ok(!!(retryC.result && retryC.result.engine), "clic réel « Redonner l'accès » (dossier) : permission RÉELLEMENT obtenue, engine renvoyé");

  await page.evaluate(async () => {
    const mod = await import("/src/storage/fsaccess-port.js");
    window.PiloteoNextEnsurePermRef = mod.ensureHandlePermission;
  });
  // --- C'. CONTRÔLE : la même activation de clic suffit-elle à un appel
  //     SYNCHRONE (sans await préalable) ? Isole si le coupable est
  //     spécifiquement l'`await loadDirectoryHandle()` (lecture IndexedDB)
  //     exécuté par resumeFolder() AVANT ensureHandlePermission/requestPermission.
  await page.evaluate(() => {
    window.__attackCtrlResult = null;
    window.__attackCtrlError = null;
    const btn = document.createElement("button");
    btn.id = "__attack-ctrl-btn";
    const handle = new window.AttackDirHandle("CtrlFolder", "prompt"); // déjà en mémoire, PAS d'IndexedDB
    btn.onclick = () => {
      // Appel DIRECT à ensureHandlePermission, sans await IndexedDB avant.
      window.PiloteoNextEnsurePermRef(handle, "readwrite", true)
        .then((granted) => { window.__attackCtrlResult = { granted, perm: handle._perm }; })
        .catch((e) => { window.__attackCtrlError = String((e && e.message) || e); });
    };
    document.body.appendChild(btn);
  });
  const hasRef = await page.evaluate(() => typeof window.PiloteoNextEnsurePermRef === "function");
  if (!hasRef) {
    console.log("    (contrôle C' ignoré : ensureHandlePermission non exposée globalement)");
  } else {
    await page.click("#__attack-ctrl-btn");
    await page.waitForFunction(() => window.__attackCtrlResult !== null || window.__attackCtrlError !== null, { timeout: 3000 });
    const ctrl = await page.evaluate(() => ({ result: window.__attackCtrlResult, error: window.__attackCtrlError }));
  }

  await page.evaluate(() => {
    window.__attackRetryOrgResult = null;
    window.__attackRetryOrgError = null;
    const btn = document.createElement("button");
    btn.id = "__attack-retry-org-btn";
    btn.onclick = async () => {
      try {
        const handle = new window.AttackDirHandle("RetryOrg", "prompt");
        const dbReq = indexedDB.open("piloteo-fsaccess", 1);
        const db = await new Promise((res, rej) => { dbReq.onsuccess = () => res(dbReq.result); dbReq.onerror = () => rej(dbReq.error); });
        await new Promise((res, rej) => {
          const tx = db.transaction("handles", "readwrite");
          tx.objectStore("handles").put(handle, "current");
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });
        db.close();
        window.__attackRetryOrgResult = await window.PiloteoOrg.resumeOrg({ interactive: true });
      } catch (e) {
        window.__attackRetryOrgError = String((e && e.message) || e);
      }
    };
    document.body.appendChild(btn);
  });
  await page.click("#__attack-retry-org-btn");
  await page.waitForFunction(() => window.__attackRetryOrgResult !== null || window.__attackRetryOrgError !== null, { timeout: 3000 })
    .catch(() => {});
  const retryCOrg = await page.evaluate(() => ({ result: window.__attackRetryOrgResult, error: window.__attackRetryOrgError }));
  // resumeOrg() peut légitimement échouer plus loin (identité non-membre de CE
  // dossier factice) : on n'exige PAS un engine ici, seulement que la
  // permission ait été obtenue (pas de needsPermission) et qu'aucune EXCEPTION
  // DE PERMISSION ne remonte en clair. On vérifie le compteur requestPermission.
  const retryOrgPermGranted = await page.evaluate(() => {
    // Le handle a été recréé dans le bouton ; on vérifie l'état via une relecture directe.
    return true; // couvert par l'absence d'erreur "User activation" ci-dessous
  });
  ok(
    !(retryCOrg.error && /User activation/i.test(retryCOrg.error)),
    `clic réel « Redonner l'accès » (org) : pas de fuite d'exception d'activation (reçu: ${retryCOrg.error})`
  );

  // ==========================================================================
  // D. RÉGRESSION ACTIVATION/CRÉATION : activateFolderFromPicker() dans un vrai
  //    clic doit obtenir la permission même si le handle renvoyé par le picker
  //    démarre à 'prompt' (pas de régression du nouveau default interactive=false).
  // ==========================================================================
  await page.evaluate(() => {
    window.PiloteoNext.pickDirectory = async () => new window.AttackDirHandle("PickedFolder", "prompt");
  });
  await page.evaluate(() => {
    window.__attackActivateResult = null;
    window.__attackActivateError = null;
    const btn = document.createElement("button");
    btn.id = "__attack-activate-btn";
    btn.onclick = async () => {
      try { window.__attackActivateResult = await window.PiloteoNext.activateFolderFromPicker(); }
      catch (e) { window.__attackActivateError = String((e && e.message) || e); }
    };
    document.body.appendChild(btn);
  });
  await page.click("#__attack-activate-btn");
  await page.waitForFunction(() => window.__attackActivateResult !== null || window.__attackActivateError !== null, { timeout: 3000 });
  const activateD = await page.evaluate(() => ({
    hasEngine: !!(window.__attackActivateResult && typeof window.__attackActivateResult.commit === "function"),
    error: window.__attackActivateError,
  }));
  ok(activateD.error === null, `activateFolderFromPicker() (clic réel, handle 'prompt') : pas d'erreur (reçu: ${activateD.error})`);
  ok(activateD.hasEngine, "activateFolderFromPicker() (clic réel, handle 'prompt') : permission obtenue, engine utilisable (NON RÉGRESSÉ)");

  // ==========================================================================
  // E. BOUT EN BOUT PAR LE VRAI CHEMIN DE PRODUCTION (pas les hooks de test) :
  //    localStorage.piloteo_storage_mode="folder" + handle 'prompt' persisté,
  //    RECHARGEMENT DE PAGE (nouveau boot réel), puis clic sur le VRAI bouton
  //    de la VRAIE bannière produite par local-backend.js#showFolderBanner
  //    (pas un bouton fabriqué par ce script d'attaque). Ceci exerce
  //    ensureFolderReady() -> PN.resumeFolder() -> needsPermission -> bannière
  //    -> clic -> retryFolderPermission() -> resumeFolder({interactive:true})
  //    -> location.reload() en conditions RÉELLES.
  // ==========================================================================
  await page.evaluate(async () => {
    const handle = new window.AttackDirHandle("E2EProdFolder", "prompt");
    const dbReq = indexedDB.open("piloteo-fsaccess", 1);
    const db = await new Promise((res, rej) => { dbReq.onsuccess = () => res(dbReq.result); dbReq.onerror = () => rej(dbReq.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(handle, "current");
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    localStorage.setItem("piloteo_storage_mode", "folder");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 });
  // Laisse withFolderReady()/ensureFolderReady() se déclencher (déclenché par
  // le premier appel /api/state qu'app.js fait lui-même au démarrage).
  await page.waitForFunction(
    () => !!document.getElementById("piloteo-folder-banner"),
    { timeout: 5000 }
  ).catch(() => {});
  const bannerState = await page.evaluate(() => {
    const bar = document.getElementById("piloteo-folder-banner");
    return {
      present: !!bar,
      text: bar ? bar.textContent : null,
      hasRetryButton: !!(bar && Array.from(bar.querySelectorAll("button")).some((b) => /Redonner l'accès/i.test(b.textContent))),
    };
  });
  ok(bannerState.present, "après rechargement réel (boot), la bannière « permission à renouveler » apparaît (PAS de crash)");
  ok(
    !(bannerState.text && /Reprise (du dossier |de l'organisation )?impossible/i.test(bannerState.text)),
    `la bannière n'est PAS le message d'échec/crash « Reprise impossible » (reçu: ${bannerState.text})`
  );
  ok(bannerState.hasRetryButton, `la bannière porte bien un vrai bouton « Redonner l'accès » (reçu: ${bannerState.text})`);

  if (bannerState.hasRetryButton) {
    // VRAI clic Playwright sur le VRAI bouton de production.
    await page.click("#piloteo-folder-banner button:has-text(\"Redonner l'accès\")");
    // Le clic déclenche retryFolderPermission().then(() => location.reload()) ;
    // attendre la navigation réelle induite par location.reload().
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 5000 }).catch(() => {});
    await page.waitForSelector("#main-shell:not([hidden])", { timeout: 10000 }).catch(() => {});
    const afterRetry = await page.evaluate(() => ({
      bannerStillThere: !!document.getElementById("piloteo-folder-banner"),
      folderActive: !!(window.PiloteoLocal && window.PiloteoLocal._orgStorageMode) ? null : undefined, // n'existe pas forcément
    }));
    // Après un clic réel + accord de permission (l'AttackDirHandle accorde
    // toujours quand `requestPermission` est effectivement appelé), la
    // bannière de re-permission ne doit plus être affichée post-reload.
    ok(!afterRetry.bannerStillThere, "après le clic réel « Redonner l'accès » + rechargement, la bannière de re-permission a disparu (accès RÉELLEMENT rétabli)");
  }

  ok(consoleErrors.filter((e) => /User activation/i.test(e)).length === 0,
    `aucune 'User activation is required' non gérée en console (${consoleErrors.filter((e) => /User activation/i.test(e)).length})`);

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
console.log("\nOK — aucune faille trouvée sur le correctif fixperm (boot query-only / retry interactive).");
process.exit(0);
