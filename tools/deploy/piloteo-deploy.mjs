#!/usr/bin/env node
// tools/deploy/piloteo-deploy.mjs
//
// Déployeur CLI de Pilotéo (Point 6, docs/next/DEPLOYER_ASSISTANT_CONTRACT.md).
// Fait EXACTEMENT les 4 choses de docs/DEPLOYER_CONTRACT.md §1 : choisir /
// valider / écrire / lancer éventuellement — rien de plus. Ne réimplémente
// AUCUN métier : la configuration produite passe TOUJOURS par
// `normalizeConfig` (src/config/runtime-config.js, source de vérité) ; ce
// module ne connaît aucun format de config qui lui soit propre.
//
// Node stdlib UNIQUEMENT (zéro dépendance npm). La LOGIQUE PURE (traduire les
// réponses en config, valider les prérequis, générer le CONTENU des fichiers)
// est isolée dans des fonctions EXPORTÉES, sans aucune E/S cachée — ce sont
// elles qu'importe tests/next/deployer.test.mjs. Le prompt interactif et
// l'exécution des scripts de lancement (Fly/VPS) les enrobent seulement.
//
// Usage interactif (une question, 4 réponses) :
//   node tools/deploy/piloteo-deploy.mjs
//
// Usage non interactif (CI / répétable), mêmes réponses via flags ou env :
//   node tools/deploy/piloteo-deploy.mjs --mode local --yes
//   node tools/deploy/piloteo-deploy.mjs --mode shared --provider folder --yes
//   node tools/deploy/piloteo-deploy.mjs --mode shared --provider google-drive \
//     --google-client-id 123-abc.apps.googleusercontent.com --yes
//   node tools/deploy/piloteo-deploy.mjs --mode hosted --endpoint https://piloteo.example.fr \
//     --target vps --yes [--deploy]
//   node tools/deploy/piloteo-deploy.mjs --mode hosted --endpoint https://piloteo-dupont.fly.dev \
//     --target fly --client dupont --org-name "Cabinet Dupont" --admin-id ADM --yes [--deploy]
//
// Dry-run PAR DÉFAUT : le lancement (Fly/VPS) n'est qu'IMPRIMÉ, jamais
// exécuté, sauf `--deploy` explicite. `--yes` saute la confirmation
// interactive (nécessaire en CI, où rien ne peut répondre à un prompt).

import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

import { normalizeConfig } from "../../src/config/runtime-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// Erreur dédiée : toujours un message actionnable pour l'installateur, jamais
// une trace technique brute.
// ---------------------------------------------------------------------------
export class DeployerError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeployerError";
  }
}

// ---------------------------------------------------------------------------
// 1. CHOISIR — la question unique, 4 réponses (docs/DEPLOYER_CONTRACT.md §1).
// ---------------------------------------------------------------------------

export const USAGE_ANSWERS = Object.freeze([
  { key: "local", label: "Local — un seul poste, hors ligne, aucune synchronisation." },
  { key: "folder", label: "Dossier partagé — les données vivent dans un dossier synchronisé (OneDrive, Drive Desktop, Dropbox, NAS…)." },
  { key: "google-drive", label: "Google Drive — les données vivent dans Google Drive via l'API Drive." },
  { key: "hosted", label: "Hébergement serveur — un backend hébergé (server.py)." },
]);

/**
 * Forme plausible d'un Client ID OAuth PUBLIC Google (jamais un secret —
 * CLAUDE.md §2.5) : `<numéro-de-projet>-<identifiant>.apps.googleusercontent.com`,
 * le format RÉEL émis par Google Cloud Console (ex. celui déjà utilisé par
 * `tools/team-spike/index.html` et `docs/next/DRIVE_LIVE_MANUAL.md` :
 * `940162140944-llbfni295begfk20egmvnuqd9sc37cj8.apps.googleusercontent.com`).
 * Resserré au jeu de caractères réel (chiffres, tiret, alphanumérique/`_`) —
 * PAS un `\S+` générique : un `\S+` laisse passer des métacaractères JS
 * (`</script>`, guillemets, backticks…) qui n'ont simplement jamais leur place
 * dans un vrai client id. `renderConfigJs` reste protégé par `JSON.stringify`
 * en défense en profondeur (ceinture ET bretelles), mais ce portail d'entrée
 * ne doit lui-même accepter QUE la forme réelle.
 */
export function isPlausibleGoogleClientId(value) {
  return typeof value === "string" && /^[0-9]+-[0-9a-zA-Z_]+\.apps\.googleusercontent\.com$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// 2. VALIDER + traduire en config NORMALISÉE — logique PURE, aucune E/S.
// ---------------------------------------------------------------------------

/**
 * Traduit les réponses (la réponse unique `answer`, ou directement
 * `mode`/`provider` — équivalent des flags non interactifs) en configuration
 * runtime NORMALISÉE (`normalizeConfig`, seule source de vérité du format).
 *
 * Lève `DeployerError` (message actionnable) si :
 *  - la réponse/le mode est absent ou inconnu ;
 *  - Drive est choisi sans `googleClientId` de forme plausible — règle DU
 *    déployeur (docs/DEPLOYER_CONTRACT.md §4 : « valide présence et forme »),
 *    plus stricte ici que `normalizeConfig` (qui tolère un id absent pour
 *    retomber en fake mémoire côté runtime, §10) : un DÉPLOIEMENT explicite en
 *    Drive sans id serait une configuration inerte, on la refuse en amont ;
 *  - `normalizeConfig` rejette la forme obtenue (mode inconnu, provider
 *    incohérent, endpoint absent/mal formé…) — le message d'erreur canonique
 *    de `normalizeConfig` est alors repris tel quel (pas de duplication de
 *    règles de validation).
 *
 * @param {{answer?:string, mode?:string, provider?:string, googleClientId?:(string|null), endpoint?:string}} answers
 * @returns {object} config normalisée (voir `normalizeConfig`)
 */
export function buildDeployConfig(answers = {}) {
  let mode = answers.mode;
  let provider = answers.provider;

  if (answers.answer) {
    const answer = answers.answer;
    if (answer === "local") mode = "local";
    else if (answer === "folder") { mode = "shared"; provider = "folder"; }
    else if (answer === "google-drive") { mode = "shared"; provider = "google-drive"; }
    else if (answer === "hosted") mode = "hosted";
    else throw new DeployerError(`Réponse inconnue (${answer}) — attendu ${USAGE_ANSWERS.map((a) => a.key).join(" | ")}.`);
  }

  if (!mode) {
    throw new DeployerError("Aucun mode choisi (répondez à la question, ou passez --mode local|shared|hosted).");
  }

  let raw;
  if (mode === "local") {
    raw = { mode: "local" };
  } else if (mode === "hosted") {
    raw = { mode: "hosted", endpoint: answers.endpoint };
  } else if (mode === "shared") {
    // Règle DU déployeur (au-delà de normalizeConfig) : Drive explicitement
    // choisi exige un id plausible — sinon le déploiement serait inerte.
    if (provider === "google-drive" && !isPlausibleGoogleClientId(answers.googleClientId)) {
      throw new DeployerError(
        "Mode Google Drive : GOOGLE_CLIENT_ID requis et de forme plausible " +
          "(identifiant public terminé par .apps.googleusercontent.com). " +
          "Fournissez --google-client-id (ou la variable GOOGLE_CLIENT_ID) — " +
          "c'est un identifiant PUBLIC d'application OAuth, jamais un secret."
      );
    }
    raw = {
      mode: "shared",
      storage: {
        provider,
        googleClientId: provider === "google-drive" ? answers.googleClientId.trim() : undefined,
      },
    };
  } else {
    // Mode inconnu : laisser `normalizeConfig` produire le message canonique.
    raw = { mode };
  }

  try {
    return normalizeConfig(raw);
  } catch (err) {
    throw new DeployerError(`Configuration invalide : ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 3. ÉCRIRE — génération du CONTENU (pur) puis écriture fichier (E/S).
// ---------------------------------------------------------------------------

/** Contenu de `deploy/piloteo.runtime.json` — la config normalisée, telle quelle. */
export function renderRuntimeJson(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Contenu de `deploy/piloteo.config.js` — le SEUL canal par lequel le pont
 * Drive lit le client id (`piloteo-drive-bridge.mjs` lit
 * `window.PILOTEO_GOOGLE_CLIENT_ID`). Pose aussi `window.PILOTEO_MODE` dans
 * tous les modes. JAMAIS de secret : `googleClientId` est un identifiant
 * PUBLIC (CLAUDE.md §2.5) ; aucune autre valeur de la config n'est un secret
 * (endpoint hosted = URL publique du backend). Déterministe (même config =>
 * même sortie), donc idempotent par construction.
 *
 * IMPORTANT — ce fichier doit TOUJOURS être chargé via `<script src="deploy/
 * piloteo.config.js"></script>`, JAMAIS inliné (copié tel quel dans un bloc
 * `<script>…</script>`). `googleClientId` est validé en amont par
 * `isPlausibleGoogleClientId` (chiffres/tiret/alphanumérique/`_` uniquement,
 * donc jamais de `</script>` littéral) et `JSON.stringify` échappe déjà toute
 * valeur ici (défense en profondeur) — mais un inlining futur resterait un
 * vecteur si cette règle de validation changeait un jour ; ne JAMAIS inliner
 * évite la question.
 */
export function renderConfigJs(config) {
  const lines = [
    "// deploy/piloteo.config.js — généré par tools/deploy/piloteo-deploy.mjs.",
    "// NE PAS ÉDITER À LA MAIN : relancez le déployeur pour le régénérer.",
    "// Aucun secret : googleClientId (s'il est présent) est l'identifiant PUBLIC",
    "// d'une application OAuth Google (CLAUDE.md §2.5 / docs/DEPLOYER_CONTRACT.md §3).",
    "// À charger UNIQUEMENT via <script src=\"deploy/piloteo.config.js\"></script> —",
    "// JAMAIS inliné dans un bloc <script>…</script>.",
    "// À charger AVANT les ponts (piloteo-*-bridge.mjs) dans index.html.",
    `window.PILOTEO_MODE = ${JSON.stringify(config.mode)};`,
  ];
  if (config.mode === "shared" && config.storage.provider === "google-drive" && config.storage.googleClientId) {
    lines.push(`window.PILOTEO_GOOGLE_CLIENT_ID = ${JSON.stringify(config.storage.googleClientId)};`);
  }
  return `${lines.join("\n")}\n`;
}

/** Écrit `deploy/piloteo.runtime.json` + `deploy/piloteo.config.js` (idempotent : réécriture stable). */
export function writeDeployArtifacts(config, { deployDir } = {}) {
  const dir = deployDir || path.join(REPO_ROOT, "deploy");
  mkdirSync(dir, { recursive: true });
  const runtimeJsonPath = path.join(dir, "piloteo.runtime.json");
  const configJsPath = path.join(dir, "piloteo.config.js");
  writeFileSync(runtimeJsonPath, renderRuntimeJson(config));
  writeFileSync(configJsPath, renderConfigJs(config));
  return { runtimeJsonPath, configJsPath };
}

/**
 * Calcule (sans écrire) ce qu'il faudrait faire pour préparer `.env` en mode
 * hébergé : ne touche jamais le disque, seulement `existsSync`. Lève
 * `DeployerError` si une copie serait nécessaire mais `.env.example` est
 * introuvable — pensé pour être appelé PENDANT la phase de validation
 * (avant toute écriture), afin qu'un mode hébergé sans `.env.example`
 * n'écrive PAS non plus `piloteo.runtime.json`/`piloteo.config.js`
 * (atomicité : soit tout, soit rien — voir `runNonInteractive`).
 */
export function planHostedEnv({ rootDir = REPO_ROOT } = {}) {
  const examplePath = path.join(rootDir, ".env.example");
  const envPath = path.join(rootDir, ".env");
  if (existsSync(envPath)) {
    return { envPath, examplePath, needsCopy: false };
  }
  if (!existsSync(examplePath)) {
    throw new DeployerError(`.env.example introuvable (${examplePath}) — impossible de préparer .env.`);
  }
  return { envPath, examplePath, needsCopy: true };
}

/**
 * Mode hébergé : prépare `.env` (racine du dépôt) depuis `.env.example`,
 * SEULEMENT s'il n'existe pas encore (idempotent, ne jamais écraser des
 * réglages déjà édités). N'invente et n'écrit JAMAIS un mot de passe en
 * clair : le contenu copié est celui de `.env.example`, placeholders inclus.
 */
export function ensureHostedEnv({ rootDir = REPO_ROOT } = {}) {
  const plan = planHostedEnv({ rootDir });
  if (plan.needsCopy) {
    copyFileSync(plan.examplePath, plan.envPath);
    return { path: plan.envPath, created: true };
  }
  return { path: plan.envPath, created: false };
}

// ---------------------------------------------------------------------------
// Prérequis par mode (docs/DEPLOYER_CONTRACT.md §4). `checkCommand` est
// injectable pour les tests (sans dépendre de l'environnement réel).
// ---------------------------------------------------------------------------

export function commandExists(cmd) {
  try {
    const res = spawnSync("sh", ["-c", `command -v -- ${JSON.stringify(cmd)}`], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Valide les prérequis du mode. Ne valide QUE ce que §4 du contrat demande —
 * rien de métier. Renvoie des avertissements informatifs (Dossier, Drive sans
 * id) et lève `DeployerError` seulement sur un prérequis dur manquant
 * (Docker/flyctl absents en mode Hébergement).
 */
export function validatePrerequisites(config, { target, checkCommand = commandExists } = {}) {
  const warnings = [];

  if (config.mode === "local") {
    return { ok: true, warnings };
  }

  if (config.mode === "shared" && config.storage.provider === "folder") {
    warnings.push(
      "Mode Dossier partagé : nécessite un navigateur Chromium desktop (Chrome/Edge/Opera — File System " +
        "Access API) ; Firefox et Safari sont hors périmètre sans wrapper desktop. Vérifiez que le dossier " +
        "cible est accessible en écriture (docs/modes/FOLDER_STORAGE.md)."
    );
    return { ok: true, warnings };
  }

  if (config.mode === "shared" && config.storage.provider === "google-drive") {
    warnings.push(
      "Google Drive : le fournisseur de token OAuth (drive.file) reste à câbler côté application " +
        "(hors ressort du déployeur, docs/DEPLOYER_CONTRACT.md §3)."
    );
    return { ok: true, warnings };
  }

  if (config.mode === "hosted") {
    if (!checkCommand("docker")) {
      throw new DeployerError(
        "Mode Hébergement : Docker introuvable. Installez-le (curl -fsSL https://get.docker.com | sh) puis relancez."
      );
    }
    if (target === "fly" && !checkCommand("fly")) {
      throw new DeployerError(
        "Cible Fly : flyctl introuvable (https://fly.io/docs/flyctl/install/). Installez-le puis relancez."
      );
    }
    return { ok: true, warnings };
  }

  return { ok: true, warnings };
}

// ---------------------------------------------------------------------------
// 4. LANCER ÉVENTUELLEMENT — mode Hébergement UNIQUEMENT, dry-run par défaut.
//    Orchestre les scripts EXISTANTS (fly-new-client.sh, deploy-vps.sh) —
//    ne les réécrit pas.
// ---------------------------------------------------------------------------

/**
 * Résout la commande de lancement (pure) — ne l'exécute jamais elle-même.
 * `redact: true` sur la cible Fly : `scripts/fly-new-client.sh` affiche le mot
 * de passe admin généré UNE SEULE FOIS sur stdout (script existant, hors
 * scope) — `runLaunchCommand` doit rédiger cette sortie avant de la ré-émettre
 * (voir sa doc). La cible VPS n'imprime jamais de secret (`deploy-vps.sh` n'en
 * génère aucun) : `redact` reste `false`, la sortie continue de s'afficher en
 * direct (utile pour suivre `docker compose up --build`).
 */
export function resolveLaunchCommand(config, { target, client, orgName, adminId, region } = {}) {
  if (config.mode !== "hosted") {
    return null; // le lancement ne concerne QUE le mode Hébergement (contrat §1).
  }
  if (target === "fly") {
    if (!client || !orgName || !adminId) {
      throw new DeployerError(
        "Cible Fly : --client, --org-name et --admin-id sont requis " +
          '(scripts/fly-new-client.sh <client> "<Nom du cabinet>" <trigramme-admin> [region]).'
      );
    }
    const args = [client, orgName, adminId];
    if (region) args.push(region);
    // redact explicite (défaut sûr de runLaunchCommand de toute façon, voir plus bas).
    return { cmd: "scripts/fly-new-client.sh", args, cwd: REPO_ROOT, redact: true };
  }
  if (target === "vps") {
    // Seule cible qui opte explicitement pour la sortie EN DIRECT : deploy-vps.sh
    // (script écrit par ce même lot) ne génère ni n'affiche jamais de secret —
    // laisser passer permet de suivre `docker compose up --build` en direct.
    return { cmd: "scripts/deploy-vps.sh", args: [], cwd: REPO_ROOT, redact: false };
  }
  throw new DeployerError(`Cible de lancement inconnue (${String(target)}) — attendu fly | vps.`);
}

/**
 * Échappement shell POSIX en guillemets SIMPLES — la seule forme qui neutralise
 * TOUS les métacaractères shell (espace, `;`, `` ` ``, `$()`, `"`, `&&`, `|`…) :
 * à l'intérieur de guillemets simples, RIEN n'est interprété par un shell
 * POSIX sauf le guillemet simple lui-même, qu'on ferme/échappe/rouvre via la
 * séquence classique `'\''` (fermer, un guillemet simple littéral via
 * backslash HORS quotes, rouvrir).
 */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Représentation imprimable d'une commande de lancement (dry-run) — le texte
 * que `printResult` présente comme « la commande à lancer pour de vrai »,
 * destiné à être COPIÉ-COLLÉ par un humain dans SON PROPRE shell (spawnSync,
 * lui, n'utilise jamais de shell et reste sûr indépendamment de ceci).
 *
 * CHAQUE argument est SYSTÉMATIQUEMENT guillemété en simples quotes
 * (`shQuote`) — jamais seulement « s'il contient un espace », et jamais via
 * `JSON.stringify` (qui échappe les guillemets doubles mais laisse `` ` ``,
 * `$()` et `;` actifs à l'intérieur de guillemets DOUBLES en shell POSIX :
 * `--org-name` ou `--client` contenant ces métacaractères exécuterait du code
 * arbitraire au copier-coller sans cette garantie).
 */
export function formatCommand({ cmd, args }) {
  return [cmd, ...args.map(shQuote)].join(" ");
}

/**
 * Toute ligne de sortie évoquant un secret (mot de passe/password/secret) est
 * remplacée par un espace réservé — jamais supprimée silencieusement (la
 * ligne reste visible, juste sans sa valeur), pour ne rien cacher de la
 * structure de la sortie tout en ne laissant fuiter aucune valeur.
 */
export const SECRET_LINE_PATTERN = /mot de passe|password|secret/i;
export const REDACTED_LINE = "[secret masqué — récupérable via `fly secrets`/le tableau de bord Fly]";

/** Rédige (masque) toute ligne d'un texte évoquant un secret — exporté pour les tests. */
export function redactSecretLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (SECRET_LINE_PATTERN.test(line) ? REDACTED_LINE : line))
    .join("\n");
}

/**
 * Exécute réellement la commande de lancement (E/S — jamais appelé sans
 * `--deploy`). SÛR PAR DÉFAUT : `redact` vaut `true` sauf si l'appelant s'en
 * exclut EXPLICITEMENT (`resolveLaunchCommand` ne le fait que pour la cible
 * VPS, qui ne génère ni n'affiche jamais de secret). Sur `redact` actif, la
 * sortie n'est PAS branchée en direct sur le terminal (`stdio:"inherit"`, qui
 * ferait fuiter le mot de passe admin généré tel quel — cas de la cible Fly,
 * `scripts/fly-new-client.sh` — dans les logs de tout CI capturant la sortie
 * de ce process) : elle est capturée puis ré-émise ligne à ligne, secrets
 * masqués (`redactSecretLines`). Le secret existe déjà côté Fly (`fly
 * secrets`) : il n'a besoin de transiter en clair nulle part ici. Voir aussi
 * l'avertissement de `--help`/`docs/deployment/DEPLOYER.md`.
 */
export function runLaunchCommand({ cmd, args, cwd, redact = true }) {
  const full = path.isAbsolute(cmd) ? cmd : path.join(cwd, cmd);
  if (!redact) {
    const res = spawnSync(full, args, { cwd, stdio: "inherit" });
    if (res.error) throw res.error;
    return { status: res.status };
  }
  const res = spawnSync(full, args, { cwd, stdio: ["inherit", "pipe", "pipe"], encoding: "utf8" });
  if (res.error) throw res.error;
  if (res.stdout) process.stdout.write(redactSecretLines(res.stdout));
  if (res.stderr) process.stderr.write(redactSecretLines(res.stderr));
  return { status: res.status };
}

// ---------------------------------------------------------------------------
// Orchestration NON interactive (logique, testable — aucun prompt ici).
// ---------------------------------------------------------------------------

/**
 * Enchaîne choisir(déjà fait, `flags`) → valider → écrire → résout le
 * lancement éventuel (ne l'exécute que si `flags.deploy`).
 *
 * ATOMICITÉ : toute la VALIDATION (config, prérequis, cible/paramètres de
 * lancement, faisabilité de `.env`) est faite AVANT la moindre écriture — une
 * config invalide, un `--target` inconnu, des paramètres Fly incomplets, ou
 * un `.env.example` manquant n'écrivent RIEN (ni `piloteo.runtime.json`, ni
 * `piloteo.config.js`, ni `.env`) : soit tout, soit rien.
 */
export function runNonInteractive(flags, { rootDir = REPO_ROOT, deployDir } = {}) {
  const config = buildDeployConfig({
    mode: flags.mode,
    provider: flags.provider,
    googleClientId: flags.googleClientId,
    endpoint: flags.endpoint,
  });

  // --- VALIDER intégralement (aucune E/S d'écriture ci-dessous) ---
  const validation = validatePrerequisites(config, { target: flags.target });

  let launch = null;
  if (config.mode === "hosted" && flags.target) {
    launch = resolveLaunchCommand(config, {
      target: flags.target,
      client: flags.client,
      orgName: flags.orgName,
      adminId: flags.adminId,
      region: flags.region,
    });
  }

  let hostedEnvPlan = null;
  if (config.mode === "hosted") {
    hostedEnvPlan = planHostedEnv({ rootDir });
  }

  // --- ÉCRIRE : tout ce qui précède a réussi, on peut toucher le disque ---
  const dir = deployDir || path.join(rootDir, "deploy");
  const { runtimeJsonPath, configJsPath } = writeDeployArtifacts(config, { deployDir: dir });

  const result = { config, runtimeJsonPath, configJsPath, warnings: validation.warnings };

  if (hostedEnvPlan) {
    if (hostedEnvPlan.needsCopy) {
      copyFileSync(hostedEnvPlan.examplePath, hostedEnvPlan.envPath);
      result.env = { path: hostedEnvPlan.envPath, created: true };
    } else {
      result.env = { path: hostedEnvPlan.envPath, created: false };
    }
  }

  // --- LANCER ÉVENTUELLEMENT ---
  if (launch) {
    result.launch = launch;
    result.launchCommand = formatCommand(launch);
    if (flags.deploy) {
      result.executed = true;
      runLaunchCommand(launch);
    } else {
      result.executed = false;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI : parsing des flags, prompt interactif, point d'entrée `main()`.
// Non couvert par les tests unitaires (contrat : « le prompt interactif n'est
// pas testé, le chemin non-interactif l'est ») — reste un enrobage mince des
// fonctions pures ci-dessus.
// ---------------------------------------------------------------------------

const FLAG_SPECS = {
  "--mode": "mode",
  "--provider": "provider",
  "--google-client-id": "googleClientId",
  "--endpoint": "endpoint",
  "--target": "target",
  "--client": "client",
  "--org-name": "orgName",
  "--admin-id": "adminId",
  "--region": "region",
  "--out-dir": "outDir",
};

export function parseArgs(argv, env = process.env) {
  const out = {
    mode: env.PILOTEO_MODE || undefined,
    provider: env.PILOTEO_STORAGE || undefined,
    googleClientId: env.GOOGLE_CLIENT_ID || null,
    endpoint: env.PILOTEO_ENDPOINT || undefined,
    target: undefined,
    client: undefined,
    orgName: undefined,
    adminId: undefined,
    region: undefined,
    outDir: undefined,
    yes: false,
    deploy: false,
    help: false,
  };
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--yes") { out.yes = true; continue; }
    if (a === "--deploy") { out.deploy = true; continue; }
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    const field = FLAG_SPECS[a];
    if (!field) {
      throw new DeployerError(`Option inconnue : ${a} (--help pour la liste).`);
    }
    i += 1;
    if (i >= args.length) {
      throw new DeployerError(`Option ${a} : valeur manquante.`);
    }
    out[field] = args[i];
  }
  return out;
}

function printHelp(out = console.log) {
  out(`Déployeur Pilotéo — choisir / valider / écrire / lancer éventuellement (docs/DEPLOYER_CONTRACT.md §1).

Interactif (une question, 4 réponses) :
  node tools/deploy/piloteo-deploy.mjs

Non interactif (flags, équivalents des variables PILOTEO_MODE/PILOTEO_STORAGE/GOOGLE_CLIENT_ID/PILOTEO_ENDPOINT) :
  --mode <local|shared|hosted>
  --provider <folder|google-drive>        (mode shared)
  --google-client-id <id>                 (provider google-drive ; PUBLIC, jamais un secret)
  --endpoint <https://...>                (mode hosted)
  --target <fly|vps>                      (mode hosted — lancement optionnel)
  --client / --org-name / --admin-id / --region   (cible fly, cf. scripts/fly-new-client.sh)
  --out-dir <dir>                         (par défaut deploy/ à la racine)
  --yes                                   saute la confirmation
  --deploy                                exécute réellement le lancement (sinon dry-run : imprime la commande)

Exemples :
  node tools/deploy/piloteo-deploy.mjs --mode local --yes
  node tools/deploy/piloteo-deploy.mjs --mode shared --provider folder --yes
  node tools/deploy/piloteo-deploy.mjs --mode shared --provider google-drive --google-client-id 123456789-abc123.apps.googleusercontent.com --yes
  node tools/deploy/piloteo-deploy.mjs --mode hosted --endpoint https://piloteo.example.fr --target vps --yes [--deploy]

AVERTISSEMENT (--deploy --target fly) : scripts/fly-new-client.sh affiche le
mot de passe admin généré UNE SEULE FOIS sur sa sortie. Ce déployeur rédige
(masque) cette ligne avant de la ré-émettre — mais si le terminal qui exécute
CETTE commande a lui-même sa sortie persistée SANS rédaction en amont (capture
d'écran, script qui logue avant d'appeler piloteo-deploy.mjs...), le secret
pourrait quand même être exposé ailleurs dans la chaîne. Ne lancez --deploy
--target fly que depuis un contexte dont vous maîtrisez la journalisation, ou
récupérez le mot de passe ensuite via \`fly secrets\`/le tableau de bord Fly
plutôt que de compter sur la sortie affichée.
`);
}

function printResult(write, result) {
  write(`\nMode : ${result.config.mode}\n`);
  write("Fichiers écrits :\n");
  write(`  - ${result.runtimeJsonPath}\n`);
  write(`  - ${result.configJsPath}\n`);
  if (result.env) {
    write(
      result.env.created
        ? `  - ${result.env.path} (créé depuis .env.example — À ÉDITER avant lancement, placeholders non secrets)\n`
        : `  - ${result.env.path} (déjà présent, laissé inchangé)\n`
    );
  }
  for (const w of result.warnings || []) write(`Avertissement : ${w}\n`);
  if (result.launchCommand) {
    if (result.executed) {
      write(`\nLancement exécuté : ${result.launchCommand}\n`);
    } else {
      write(`\nDry-run (rien exécuté) — commande à lancer pour de vrai :\n  ${result.launchCommand}\n`);
      write("  (relancer avec --deploy pour l'exécuter réellement)\n");
    }
  }
}

function promptQuestion(rl, text) {
  return new Promise((resolve) => rl.question(text, resolve));
}

/** Enrobe `runNonInteractive` d'une confirmation interactive, sautée par `--yes`. */
async function confirmAndRun(flags, opts) {
  const config = buildDeployConfig({
    mode: flags.mode,
    provider: flags.provider,
    googleClientId: flags.googleClientId,
    endpoint: flags.endpoint,
  });
  if (!flags.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (
      await promptQuestion(
        rl,
        `Confirmer l'écriture de la configuration ${JSON.stringify(config)} ? [y/N] `
      )
    )
      .trim()
      .toLowerCase();
    rl.close();
    if (!["y", "yes", "o", "oui"].includes(ans)) {
      throw new DeployerError("Annulé (confirmation refusée). Relancez avec --yes pour un usage non interactif.");
    }
  }
  return runNonInteractive(flags, opts);
}

/** Le prompt interactif — la question unique, 4 réponses (non testé unitairement, voir contrat). */
export async function runInteractive({ rootDir = REPO_ROOT, deployDir } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Comment souhaitez-vous utiliser Pilotéo ?");
    USAGE_ANSWERS.forEach((a, i) => console.log(`  ${i + 1}. ${a.label}`));
    const choice = (await promptQuestion(rl, "Votre choix [1-4] : ")).trim();
    const answer = USAGE_ANSWERS[Number(choice) - 1]?.key;
    if (!answer) throw new DeployerError(`Choix invalide (${choice}) — entrez un nombre entre 1 et 4.`);

    const flags = { yes: true, deploy: false };
    if (answer === "local") {
      flags.mode = "local";
    } else if (answer === "folder") {
      flags.mode = "shared";
      flags.provider = "folder";
    } else if (answer === "google-drive") {
      flags.mode = "shared";
      flags.provider = "google-drive";
      flags.googleClientId = (
        await promptQuestion(rl, "Client ID OAuth Google (public, ex: xxx.apps.googleusercontent.com) : ")
      ).trim();
    } else if (answer === "hosted") {
      flags.mode = "hosted";
      flags.endpoint = (await promptQuestion(rl, "URL publique du backend hébergé (https://...) : ")).trim();
      const target = (await promptQuestion(rl, "Cible de lancement — fly, vps, ou vide [aucune] : ")).trim().toLowerCase();
      if (target) {
        flags.target = target;
        if (target === "fly") {
          flags.client = (await promptQuestion(rl, "Identifiant client (slug, ex: dupont) : ")).trim();
          flags.orgName = (await promptQuestion(rl, "Nom du cabinet : ")).trim();
          flags.adminId = (await promptQuestion(rl, "Trigramme de l'administrateur (ex: ADM) : ")).trim();
        }
        const deployNow = (await promptQuestion(rl, "Lancer réellement maintenant ? [y/N] : ")).trim().toLowerCase();
        flags.deploy = ["y", "yes", "o", "oui"].includes(deployNow);
      }
    }

    const result = runNonInteractive(flags, { rootDir, deployDir });
    printResult((s) => process.stdout.write(s), result);
    return result;
  } finally {
    rl.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  if (flags.help) {
    printHelp((s) => console.log(s));
    return;
  }
  try {
    const deployDir = flags.outDir ? path.resolve(flags.outDir) : undefined;
    if (flags.mode) {
      const result = await confirmAndRun(flags, { deployDir });
      printResult((s) => process.stdout.write(s), result);
    } else {
      await runInteractive({ deployDir });
    }
  } catch (err) {
    if (err instanceof DeployerError) {
      console.error(`Erreur : ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

// Exécution directe (`node tools/deploy/piloteo-deploy.mjs ...`), pas import par les tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
