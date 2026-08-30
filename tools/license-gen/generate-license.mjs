#!/usr/bin/env node
// tools/license-gen/generate-license.mjs
//
// ⚠️ CLI ÉDITEUR — HORS PWA. Ce script génère et manipule la clé PRIVÉE
// Ed25519 de signature des licences Pilotéo. Cette clé privée ne doit JAMAIS :
//   - être committée dans ce dépôt (ou tout autre dépôt de la PWA) ;
//   - être copiée dans `src/license/license.js` ou tout code livré au
//     navigateur ;
//   - être partagée par un canal non chiffré.
// Elle doit vivre UNIQUEMENT sur la machine de l'éditeur (ou un coffre-fort
// de secrets), dans le fichier désigné par `--keyfile` (par défaut HORS du
// dépôt, sous le répertoire personnel de l'utilisateur — voir DEFAULT_KEYFILE
// ci-dessous). Voir README.md à côté de ce fichier.
//
// Ce script réutilise `sign`/`verify` de `src/crypto/crypto-service.js`
// (Ed25519, WebCrypto) pour la signature — aucune primitive crypto maison.
// Seule la génération/persistance de la paire de clés éditeur (avec clé
// privée EXPORTABLE, pour pouvoir la sauvegarder entre deux exécutions du
// CLI) est propre à ce script : `crypto-service.js#generateMemberIdentity`
// génère volontairement une clé non exportable (adaptée à une identité de
// membre en mémoire, pas à un secret éditeur persistant sur disque).
//
// Usage :
//   node generate-license.mjs --help
//   node generate-license.mjs \
//     --workspaceId <uuid> --plan TEAM --maxMembers 20 \
//     --expiresAt 2027-09-01T00:00:00.000Z \
//     [--notBefore 2026-09-01T00:00:00.000Z] [--features a,b,c] \
//     [--keyfile /chemin/hors/depot/editor-signing-key.json] \
//     [--out ./ma-licence.json]
//
// Sortie (stdout) :
//   - la clé PUBLIQUE (JWK) à copier dans `EDITOR_PUBLIC_KEY_JWK`
//     (src/license/license.js) ;
//   - le JSON de la licence signée (aussi écrit sur disque si --out fourni).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { sign, verify } from "../../src/crypto/crypto-service.js";
import { canonicalizeLicense, LICENSE_FORMAT } from "../../src/license/license.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Hors du dépôt par défaut : le répertoire personnel de l'utilisateur qui
// exécute le CLI, jamais un sous-dossier du dépôt Pilotéo.
const DEFAULT_KEYFILE = path.join(os.homedir(), ".piloteo-license-gen", "editor-signing-key.json");

const HELP = `
Générateur de licence Pilotéo (CLI éditeur — hors PWA)

Usage:
  node generate-license.mjs --workspaceId <uuid> --plan <PLAN> --maxMembers <n> --expiresAt <iso|never> [options]

Options obligatoires:
  --workspaceId <uuid>     workspace ciblé par la licence
  --plan <string>          ex: TEAM, SOLO_PLUS
  --maxMembers <n|null>    nombre max de memberships actifs ("null" = illimité)
  --expiresAt <iso|never>  date ISO 8601 UTC, ou "never"/"null" pour perpétuelle

Options:
  --notBefore <iso>        défaut: maintenant
  --issuedAt <iso>         défaut: maintenant
  --features <a,b,c>       liste de features, défaut: aucune
  --licenseId <uuid>       défaut: généré
  --keyfile <path>         paire de clés éditeur (JWK), défaut:
                            ${DEFAULT_KEYFILE}
                            (HORS DU DÉPÔT — ne jamais pointer vers src/)
  --out <path>             écrit la licence signée dans ce fichier (sinon stdout seulement)
  --help                   affiche cette aide

⚠️ La clé privée éditeur ne doit jamais entrer dans le dépôt ni dans la PWA.
Seule la clé publique (imprimée par ce script) va dans src/license/license.js
(constante EDITOR_PUBLIC_KEY_JWK).
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "help") {
      out.help = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      out[key] = true; // flag booléen sans valeur
    } else {
      out[key] = value;
      i++;
    }
  }
  return out;
}

function fail(message) {
  process.stderr.write(`Erreur: ${message}\n`);
  process.exit(1);
}

async function loadOrCreateEditorKeypair(keyfile) {
  if (existsSync(keyfile)) {
    const raw = await readFile(keyfile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.privateKeyJwk || !parsed.publicKeyJwk) {
      fail(`keyfile ${keyfile} mal formé (privateKeyJwk/publicKeyJwk attendus).`);
    }
    const s = globalThis.crypto.subtle;
    const privateKey = await s.importKey(
      "jwk",
      parsed.privateKeyJwk,
      { name: "Ed25519" },
      true,
      ["sign"]
    );
    return {
      publicKeyJwk: parsed.publicKeyJwk,
      privateKeyRef: { keyType: "ed25519", cryptoKey: privateKey },
      created: false,
    };
  }

  // Pas de clé existante : on en génère une nouvelle paire éditeur, avec
  // clé privée EXPORTABLE (contrairement à generateMemberIdentity) afin de
  // pouvoir la persister sur disque pour les exécutions futures du CLI.
  const s = globalThis.crypto.subtle;
  const keyPair = await s.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyJwk = await s.exportKey("jwk", keyPair.publicKey);
  const privateKeyJwk = await s.exportKey("jwk", keyPair.privateKey);

  await mkdir(path.dirname(keyfile), { recursive: true });
  await writeFile(
    keyfile,
    JSON.stringify({ format: "piloteo-editor-signing-key-v1", publicKeyJwk, privateKeyJwk }, null, 2),
    { mode: 0o600 }
  );

  return {
    publicKeyJwk,
    privateKeyRef: { keyType: "ed25519", cryptoKey: keyPair.privateKey },
    created: true,
  };
}

function parseExpiresAt(value) {
  if (value === undefined) fail("--expiresAt est obligatoire (date ISO, ou 'never'/'null' pour perpétuelle).");
  if (value === "never" || value === "null" || value === "") return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) fail(`--expiresAt invalide: ${value}`);
  return d.toISOString();
}

function parseMaxMembers(value) {
  if (value === undefined) fail("--maxMembers est obligatoire (entier, ou 'null' pour illimité).");
  if (value === "null" || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) fail(`--maxMembers invalide: ${value}`);
  return n;
}

function isUuidLike(v) {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || process.argv.length <= 2) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (!isUuidLike(args.workspaceId)) fail("--workspaceId doit être un UUID.");
  if (!args.plan || typeof args.plan !== "string") fail("--plan est obligatoire.");

  const maxMembers = parseMaxMembers(args.maxMembers);
  const expiresAt = parseExpiresAt(args.expiresAt);
  const now = new Date().toISOString();
  const notBefore = args.notBefore ? new Date(args.notBefore).toISOString() : now;
  const issuedAt = args.issuedAt ? new Date(args.issuedAt).toISOString() : now;
  const features = args.features ? String(args.features).split(",").map((f) => f.trim()).filter(Boolean) : [];
  const licenseId = args.licenseId && isUuidLike(args.licenseId) ? args.licenseId : globalThis.crypto.randomUUID();

  const keyfile = args.keyfile ? path.resolve(args.keyfile) : DEFAULT_KEYFILE;
  const repoRoot = path.resolve(__dirname, "..", "..");
  if (keyfile.startsWith(repoRoot)) {
    fail(
      `--keyfile (${keyfile}) est À L'INTÉRIEUR du dépôt Pilotéo. La clé privée éditeur ne doit jamais y résider. Choisissez un chemin hors dépôt.`
    );
  }

  const { publicKeyJwk, privateKeyRef, created } = await loadOrCreateEditorKeypair(keyfile);

  const licenseWithoutSignature = {
    format: LICENSE_FORMAT,
    licenseId,
    workspaceId: args.workspaceId,
    plan: args.plan,
    maxMembers,
    issuedAt,
    notBefore,
    expiresAt,
    features,
  };

  const bytes = canonicalizeLicense(licenseWithoutSignature);
  const signature = await sign(privateKeyRef, bytes);
  const license = { ...licenseWithoutSignature, signature };

  // Auto-contrôle avant de livrer quoi que ce soit : la licence produite doit
  // se vérifier avec sa propre clé publique.
  const selfCheck = await verify(publicKeyJwk, canonicalizeLicense(license), license.signature);
  if (!selfCheck) {
    fail("Auto-vérification de la signature échouée (bug interne) — licence NON émise.");
  }

  if (args.out) {
    const outPath = path.resolve(args.out);
    if (outPath.startsWith(repoRoot) && outPath.includes(`${path.sep}src${path.sep}`)) {
      fail(`--out (${outPath}) pointe dans src/ du dépôt PWA — refusé (une licence n'est pas du code livré).`);
    }
    await writeFile(outPath, JSON.stringify(license, null, 2), "utf8");
    process.stderr.write(`Licence écrite: ${outPath}\n`);
  }

  if (created) {
    process.stderr.write(`Nouvelle paire de clés éditeur générée et sauvegardée dans: ${keyfile}\n`);
    process.stderr.write(`⚠️  Sauvegardez ce fichier séparément (coffre-fort). Ne JAMAIS le committer.\n`);
  }

  process.stdout.write("\n=== Clé PUBLIQUE éditeur (JWK) — à copier dans src/license/license.js (EDITOR_PUBLIC_KEY_JWK) ===\n");
  process.stdout.write(JSON.stringify(publicKeyJwk, null, 2) + "\n");

  process.stdout.write("\n=== Licence signée (JSON) ===\n");
  process.stdout.write(JSON.stringify(license, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`Erreur inattendue: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
