// tests/next/static-hardening.test.mjs
//
// Durcissement du mode statique (docs/next/STATIC_HARDENING_CONTRACT.md).
// Tests PUREMENT statiques/Node (pas de navigateur ici — voir
// tests/e2e/static-hardening-solo.mjs pour le volet navigateur) :
//   - Point 2 : index.html porte la CSP EXACTE du contrat, ne contient plus
//     AUCUN <script>…</script> inline non vide, charge pages-config.js AVANT
//     tout le reste ; pages-config.js pose EXACTEMENT les deux globals
//     attendus (client id PUBLIC, aucun secret) ; aucun gestionnaire on*=
//     inline ne subsiste.
//   - Cohérence build : un build simulé (mêmes commandes que
//     .github/workflows/pages.yml) reproduit ces propriétés dans `_site/`, et
//     le workflow lui-même ne réinjecte plus le script inline force-solo.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

const EXPECTED_CLIENT_ID = "940162140944-llbfni295begfk20egmvnuqd9sc37cj8.apps.googleusercontent.com";
const EXPECTED_CSP =
  "default-src 'self'; " +
  "script-src 'self' https://accounts.google.com; " +
  "connect-src 'self' https://www.googleapis.com https://accounts.google.com; " +
  "frame-src https://accounts.google.com; " +
  "img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "base-uri 'self'; object-src 'none'";

async function readIndexHtml(root = REPO_ROOT) {
  return readFile(join(root, "index.html"), "utf8");
}

// Extrait tous les <script ...>...</script> avec leur attribut src éventuel.
function extractScriptTags(html) {
  const tags = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    const hasSrc = /\bsrc\s*=/.test(attrs);
    tags.push({ attrs, body, hasSrc, full: m[0] });
  }
  return tags;
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "piloteo-static-hardening-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Point 2 — CSP
// ---------------------------------------------------------------------------

test("index.html contient la balise CSP EXACTE du contrat (§2)", async () => {
  const html = await readIndexHtml();
  const re = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*>/i;
  const m = html.match(re);
  assert.ok(m, "aucune balise <meta http-equiv=\"Content-Security-Policy\"> trouvée dans index.html");
  assert.equal(m[1], EXPECTED_CSP, "le contenu de la CSP ne correspond pas EXACTEMENT au contrat §2");
});

test("la CSP script-src ne contient PAS 'unsafe-inline' (d'où l'externalisation)", async () => {
  const html = await readIndexHtml();
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/i);
  const scriptSrc = m[1].match(/script-src[^;]*/)[0];
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'/);
  // style-src, lui, garde 'unsafe-inline' (contrat : nombreux style="" existants).
  const styleSrc = m[1].match(/style-src[^;]*/)[0];
  assert.match(styleSrc, /'unsafe-inline'/);
});

// ---------------------------------------------------------------------------
// Point 2 — externalisation des scripts inline
// ---------------------------------------------------------------------------

test("index.html ne contient plus AUCUN <script>…</script> inline non vide (hors src=)", async () => {
  const html = await readIndexHtml();
  const tags = extractScriptTags(html);
  assert.ok(tags.length > 5, "sanity check : le fichier doit contenir plusieurs balises <script>");
  const inlineNonEmpty = tags.filter((t) => !t.hasSrc && t.body.trim().length > 0);
  assert.deepEqual(
    inlineNonEmpty.map((t) => t.full),
    [],
    "des <script> inline non vides subsistent (doivent être externalisés vers pages-config.js)"
  );
});

test("index.html charge pages-config.js, AVANT local-backend.js et AVANT les ponts qui lisent ses globals", async () => {
  const html = await readIndexHtml();
  const posConfig = html.indexOf('src="pages-config.js"');
  assert.ok(posConfig >= 0, "index.html ne charge pas pages-config.js");
  const posLocalBackend = html.indexOf('src="local-backend.js"');
  const posDriveBridge = html.indexOf('src="piloteo-drive-bridge.mjs"');
  const posSoloBridge = html.indexOf('src="piloteo-solo-bridge.mjs"');
  assert.ok(posLocalBackend > posConfig, "local-backend.js doit charger APRÈS pages-config.js");
  assert.ok(posDriveBridge > posConfig, "piloteo-drive-bridge.mjs (lit PILOTEO_GOOGLE_CLIENT_ID) doit charger APRÈS pages-config.js");
  assert.ok(posSoloBridge > posConfig, "piloteo-solo-bridge.mjs doit charger APRÈS pages-config.js");
});

test("aucun gestionnaire on*= inline ne subsiste dans index.html (audit : 0 attendu)", async () => {
  const html = await readIndexHtml();
  assert.doesNotMatch(html, /\son[a-z]+\s*=\s*"/i);
});

// ---------------------------------------------------------------------------
// pages-config.js — contenu exact
// ---------------------------------------------------------------------------

test("pages-config.js pose EXACTEMENT les deux globals attendus, aucun secret", async () => {
  const js = await readFile(join(REPO_ROOT, "pages-config.js"), "utf8");
  assert.match(js, /window\.PILOTEO_FORCE_SOLO\s*=\s*true\s*;/);
  assert.match(
    js,
    new RegExp(`window\\.PILOTEO_GOOGLE_CLIENT_ID\\s*=\\s*"${EXPECTED_CLIENT_ID.replace(/\./g, "\\.")}"\\s*;`)
  );
  // Rien d'autre qu'un client id PUBLIC : aucun secret, aucun autre exécutable.
  assert.doesNotMatch(js, /client_secret/i);
  assert.doesNotMatch(js, /password|mot de passe/i);
  assert.doesNotMatch(js, /private[_-]?key/i);
  // Contenu EXACT (à l'espace près), pour éviter toute dérive silencieuse.
  assert.equal(
    js.trim(),
    `window.PILOTEO_FORCE_SOLO=true; window.PILOTEO_GOOGLE_CLIENT_ID="${EXPECTED_CLIENT_ID}";`
  );
});

// ---------------------------------------------------------------------------
// Cohérence build — simulation des commandes de .github/workflows/pages.yml
// ---------------------------------------------------------------------------

test("build simulé (mêmes commandes que pages.yml) : _site/index.html garde la CSP + pages-config.js copié tel quel", async () => {
  await withTempDir(async (dir) => {
    const site = join(dir, "_site");
    await mkdir(join(site, "assets"), { recursive: true });
    for (const f of [
      "index.html", "app.js", "piloteo-events.js", "local-backend.js", "sw-solo.js",
      "manifest.webmanifest", "pages-config.js", "piloteo-solo-bridge.mjs",
      "piloteo-org-bridge.mjs", "piloteo-drive-bridge.mjs", "piloteo-migration-bridge.mjs",
      "piloteo-auth-bridge.mjs",
    ]) {
      await cp(join(REPO_ROOT, f), join(site, f));
    }
    await mkdir(join(site, "src"), { recursive: true });
    await cp(join(REPO_ROOT, "src"), join(site, "src"), { recursive: true });

    const builtHtml = await readFile(join(site, "index.html"), "utf8");
    assert.match(builtHtml, /<meta\s+http-equiv="Content-Security-Policy"/i);
    const builtTags = extractScriptTags(builtHtml);
    assert.deepEqual(
      builtTags.filter((t) => !t.hasSrc && t.body.trim().length > 0),
      []
    );

    const builtConfig = await readFile(join(site, "pages-config.js"), "utf8");
    const sourceConfig = await readFile(join(REPO_ROOT, "pages-config.js"), "utf8");
    assert.equal(builtConfig, sourceConfig, "pages-config.js doit être copié TEL QUEL dans _site");
    assert.match(builtConfig, /PILOTEO_FORCE_SOLO\s*=\s*true/);
  });
});

test("pages.yml : copie pages-config.js dans _site, ne réinjecte plus de script inline force-solo", async () => {
  const yml = await readFile(join(REPO_ROOT, ".github/workflows/pages.yml"), "utf8");
  assert.match(yml, /cp\s+pages-config\.js\s+_site\//, "le workflow doit copier pages-config.js dans _site/");
  assert.match(yml, /"pages-config\.js"/, "pages-config.js doit déclencher le workflow (paths:)");
  // L'ancien mécanisme (script inline injecté au build) ne doit plus exister.
  assert.doesNotMatch(yml, /window\.PILOTEO_FORCE_SOLO=true;<\/script>/);
  assert.doesNotMatch(yml, /<script>window\.PILOTEO_FORCE_SOLO/);
});
