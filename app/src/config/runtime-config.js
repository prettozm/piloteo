// src/config/runtime-config.js
//
// Configuration RUNTIME de Pilotéo — quel MODE et quel STOCKAGE (passe
// « déploiements multiples »). C'est le contrat que le futur « déployeur »
// (docs/DEPLOYER_CONTRACT.md) se contentera d'écrire ; Pilotéo le lit pour
// choisir le bon chemin, sans jamais réimplémenter le métier.
//
// Forme normalisée :
//   { mode: "local",  storage: { provider: "indexeddb" } }
//   { mode: "shared", storage: { provider: "folder" } }
//   { mode: "shared", storage: { provider: "google-drive", googleClientId?: "..." } }
//   { mode: "hosted", endpoint: "https://..." }
//
// Décisions :
// - 4 modes exactement : local / shared / hosted (le diagramme de la passe).
//   « shared » porte deux providers de stockage : `folder` et `google-drive`.
// - Google (§10) : `google-drive` SANS `googleClientId` => l'usine de stockage
//   retombe sur un adaptateur mémoire/fake (le moteur ne dépend jamais d'un vrai
//   GCP). AVEC `googleClientId` => Google réel (adaptateur Drive câblé par
//   l'appelant via `oauthTokenProvider`). Cette bascule est décidée ici (config)
//   et appliquée par `storage/storage-factory.js`.
// - Ce module ne fait AUCUNE E/S et ne connaît aucun secret : `googleClientId`
//   n'est PAS un secret (c'est un identifiant public d'application OAuth) ;
//   aucun token, mot de passe ni clé n'est manipulé ici.

export const MODES = Object.freeze(["local", "shared", "hosted"]);
export const SHARED_PROVIDERS = Object.freeze(["folder", "google-drive"]);

function fail(msg) {
  throw new TypeError(`runtime-config: ${msg}`);
}

/**
 * Valide et normalise une configuration runtime.
 * @param {object} input
 * @returns {{mode:string, storage?:object, endpoint?:string, googleWired?:boolean}}
 */
export function normalizeConfig(input) {
  if (!input || typeof input !== "object") fail("configuration objet requise.");
  const mode = input.mode;
  if (!MODES.includes(mode)) fail(`mode invalide (${String(mode)}) — attendu ${MODES.join(" | ")}.`);

  if (mode === "local") {
    const provider = input.storage?.provider ?? "indexeddb";
    if (provider !== "indexeddb") fail(`mode local : storage.provider doit être "indexeddb" (reçu ${provider}).`);
    return { mode: "local", storage: { provider: "indexeddb" } };
  }

  if (mode === "hosted") {
    const endpoint = input.endpoint;
    if (typeof endpoint !== "string" || !/^https?:\/\//.test(endpoint)) {
      fail("mode hosted : `endpoint` (URL http/https du backend) requis.");
    }
    return { mode: "hosted", endpoint };
  }

  // mode === "shared"
  const provider = input.storage?.provider;
  if (!SHARED_PROVIDERS.includes(provider)) {
    fail(`mode shared : storage.provider doit être ${SHARED_PROVIDERS.join(" | ")} (reçu ${String(provider)}).`);
  }
  if (provider === "folder") {
    return { mode: "shared", storage: { provider: "folder" } };
  }
  // google-drive
  const googleClientId = input.storage.googleClientId ?? null;
  if (googleClientId !== null && (typeof googleClientId !== "string" || googleClientId.length === 0)) {
    fail("mode shared/google-drive : googleClientId doit être une chaîne non vide, ou absent.");
  }
  return {
    mode: "shared",
    storage: { provider: "google-drive", googleClientId },
    // Indique si Google est réellement câblable (client id présent) ou si l'usine
    // retombera sur un adaptateur fake/mémoire (§10).
    googleWired: googleClientId !== null,
  };
}

/**
 * Construit une config depuis un environnement de type `{ PILOTEO_MODE,
 * PILOTEO_STORAGE, GOOGLE_CLIENT_ID, PILOTEO_ENDPOINT }` (variables plates, ex:
 * `process.env` ou un objet injecté côté navigateur). Pratique pour le déployeur.
 */
export function configFromEnv(env = {}) {
  const mode = env.PILOTEO_MODE || "local";
  if (mode === "local") return normalizeConfig({ mode: "local" });
  if (mode === "hosted") return normalizeConfig({ mode: "hosted", endpoint: env.PILOTEO_ENDPOINT });
  const provider = env.PILOTEO_STORAGE || (env.GOOGLE_CLIENT_ID ? "google-drive" : "folder");
  return normalizeConfig({
    mode: "shared",
    storage: {
      provider,
      googleClientId: provider === "google-drive" ? (env.GOOGLE_CLIENT_ID || null) : undefined,
    },
  });
}
