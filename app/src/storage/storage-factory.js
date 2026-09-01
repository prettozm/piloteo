// src/storage/storage-factory.js
//
// Usine d'adaptateurs de STOCKAGE — traduit une configuration runtime normalisée
// (config/runtime-config.js) en l'adaptateur concret du mode « shared », et
// signale explicitement les modes qui n'utilisent PAS de StorageAdapter.
//
// Rappel du principe architectural de la passe :
//   LOCAL  -> IndexedDB directement (PAS de StorageAdapter, pas de synchro)
//   HOSTED -> backend V1 (server.py) (PAS de StorageAdapter)
//   SHARED -> StorageAdapter -> Folder | GoogleDrive
// On ne force donc PAS l'abstraction StorageAdapter au niveau le plus bas : elle
// n'existe que là où elle a un sens (le mode partagé).
//
// Gating Google (§10) : provider `google-drive` SANS `googleClientId` => on
// retombe sur un `InMemoryStorageAdapter` (fake/mémoire) et on l'indique dans
// `note`. Le moteur ne dépend jamais d'un vrai GCP ; le vrai adaptateur Drive
// n'est instancié que lorsqu'un client id ET un `oauthTokenProvider` sont
// fournis.

import { normalizeConfig } from "../config/runtime-config.js";
import { InMemoryStorageAdapter } from "./in-memory-adapter.js";
import { FolderStorageAdapter } from "./folder-storage-adapter.js";
import { GoogleDriveStorageAdapter } from "./google-drive-adapter.js";

/**
 * @param {object} rawConfig configuration runtime (sera normalisée)
 * @param {object} [deps]
 * @param {object} [deps.fsPort] requis pour provider "folder" (port filesystem)
 * @param {Function} [deps.oauthTokenProvider] requis pour Google réel (provider "google-drive" + googleClientId)
 * @param {string} [deps.driveId] optionnel, Shared Drive Google
 * @returns {{adapter:(object|null), mode:string, provider:(string|null), effective:string, note:string}}
 */
export function createStorageAdapter(rawConfig, deps = {}) {
  const config = normalizeConfig(rawConfig);

  if (config.mode === "local") {
    return {
      adapter: null,
      mode: "local",
      provider: "indexeddb",
      effective: "indexeddb",
      note: "Mode local : IndexedDB directement, aucun StorageAdapter (mono-utilisateur, hors ligne).",
    };
  }

  if (config.mode === "hosted") {
    return {
      adapter: null,
      mode: "hosted",
      provider: null,
      effective: "backend-v1",
      note: `Mode hosted : backend V1 (${config.endpoint}), aucun StorageAdapter local-first.`,
    };
  }

  // mode === "shared"
  const provider = config.storage.provider;

  if (provider === "folder") {
    if (!deps.fsPort) {
      throw new TypeError(
        "createStorageAdapter: provider 'folder' requiert deps.fsPort (NodeFsPort côté Node, port File System Access côté navigateur)."
      );
    }
    return {
      adapter: new FolderStorageAdapter({ fsPort: deps.fsPort, label: deps.label || "dossier" }),
      mode: "shared",
      provider: "folder",
      effective: "folder",
      note: "Mode partagé sur dossier : synchronisation du dossier à la charge de l'utilisateur/l'organisation.",
    };
  }

  // provider === "google-drive"
  if (!config.googleWired) {
    // §10 : pas de client id -> adaptateur mémoire/fake, jamais de dépendance GCP réelle.
    return {
      adapter: new InMemoryStorageAdapter(),
      mode: "shared",
      provider: "google-drive",
      effective: "in-memory-fake",
      note:
        "Mode partagé Google Drive demandé mais GOOGLE_CLIENT_ID absent : adaptateur mémoire/fake utilisé " +
        "(aucun appel réseau Google). Renseignez googleClientId pour activer Google réel.",
    };
  }
  if (typeof deps.oauthTokenProvider !== "function") {
    throw new TypeError(
      "createStorageAdapter: provider 'google-drive' avec googleClientId requiert deps.oauthTokenProvider (fonction renvoyant un access token drive.file)."
    );
  }
  return {
    adapter: new GoogleDriveStorageAdapter({
      oauthTokenProvider: deps.oauthTokenProvider,
      driveId: deps.driveId || null,
    }),
    mode: "shared",
    provider: "google-drive",
    effective: "google-drive",
    note: "Mode partagé Google Drive réel (client id présent, token provider fourni).",
  };
}
