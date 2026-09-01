// piloteo-drive-bridge.mjs — pont navigateur du mode Google Drive (Point 4,
// docs/next/DRIVE_LIVE_CONTRACT.md §2), symétrique à `piloteo-solo-bridge.mjs`
// (mode Dossier, point 1b) : même « engine » `{load, commit}` (SyncEngine
// trusted / `solo-store.js`, mono-écrivain, Folder Trusted), mais transporté
// sur Google Drive au lieu d'un `FileSystemDirectoryHandle` local.
//
// Décisions/hypothèses :
// - AUCUNE primitive canonique n'est réécrite : ce module importe uniquement
//   `src/integration/solo-store.js#createSoloStore` (le même orchestrateur
//   diff/replay que le mode Dossier) et `src/storage/google-drive-adapter.js`
//   (`GoogleDriveStorageAdapter`, câblé au Point 4). Le seul code NOUVEAU ici
//   est : (a) le provider de token OAuth navigateur (Google Identity Services,
//   absent du reste du dépôt), et (b) un petit adaptateur `backend` — analogue
//   à `createFolderEventBackend` de `solo-store.js` — qui relie N'IMPORTE QUEL
//   `StorageAdapter` déjà construit (ici un `GoogleDriveStorageAdapter`) au
//   contrat `backend` attendu par `createSoloStore` (§5 de CONVERGENCE_CONTRACT).
//   `createFolderEventBackend` ne peut pas être réutilisé tel quel : il
//   construit LUI-MÊME un `FolderStorageAdapter` depuis un `fsPort` (couplage
//   volontaire, cf. son en-tête) — ici l'adaptateur est déjà construit
//   (Google Drive, pas un `fsPort`). Le corps de `createDriveEventBackend`
//   ci-dessous est donc le report à l'identique de la LOGIQUE de
//   `createFolderEventBackend` (get-or-create du manifeste, listEvents
//   filtré sur kind:"event", write-once sur `appendEvent`), appliqué à un
//   adaptateur injecté plutôt que construit en interne.
// - `local-backend.js` est un script CLASSIQUE (pas de modules) : le seul
//   point de contact entre les deux mondes est `window.PiloteoDrive`, posé
//   ici, exactement comme `window.PiloteoNext`/`window.PiloteoOrg`.
// - GOOGLE IDENTITY SERVICES (GIS), modèle TOKEN (pas de code-flow serveur,
//   pas de `client_secret` — SPA pure, cf. CLAUDE.md §2.5) : réutilise
//   EXACTEMENT les patterns prouvés par `tools/team-spike/index.html`
//   (`google.accounts.oauth2.initTokenClient({client_id, scope})`,
//   `tokenClient.requestAccessToken()`). Le script GIS
//   (`https://accounts.google.com/gsi/client`) n'est PAS chargé par ce module
//   (il est chargé par la page hôte, `index.html`, comme le spike le fait) —
//   ce module attend juste que `window.google.accounts.oauth2` existe.
// - `client_id` vient de la config runtime (`GOOGLE_CLIENT_ID`), JAMAIS en dur
//   ici : lu depuis `window.PILOTEO_GOOGLE_CLIENT_ID` (même famille de
//   drapeau globale que `window.PILOTEO_FORCE_SOLO`, posé par le déploiement/
//   la page hôte — docs/DEPLOYER_CONTRACT.md §2 : « un objet injecté côté
//   navigateur » pour `configFromEnv`), puis validé/normalisé par
//   `src/config/runtime-config.js#normalizeConfig` (réutilisé, jamais
//   réimplémenté) pour appliquer EXACTEMENT le même gating que
//   `storage-factory.js` (§10) : absent/vide => `isAvailable=false`, mode
//   Drive proprement indisponible (jamais un throw au chargement du module).
// - Le TOKEN n'est JAMAIS persisté (ni `localStorage`, ni IndexedDB) : gardé
//   uniquement dans une variable de MODULE (mémoire de page), effacée à
//   chaque rechargement. Jamais loggé (aucun `console.log`/`console.info` ne
//   porte sa valeur). Ré-obtenu (`requestAccessToken()`, interaction
//   utilisateur possible) dès qu'il est absent ou expiré (marge de 30s avant
//   `expires_in` réel, pour ne jamais présenter un token sur le point d'expirer
//   à une requête Drive).
// - `createDriveEngine({rootFolderId, driveId})` construit un
//   `GoogleDriveStorageAdapter` (avec CE module comme `oauthTokenProvider`) et
//   l'enveloppe dans le même engine `{load, commit}` que le mode Dossier, pour
//   que `local-backend.js` route `/api/state` dessus EXACTEMENT comme le mode
//   Dossier (409 sur conflit métier — mapping déjà en place côté
//   `local-backend.js`, non dupliqué ici). Lève une erreur claire si le mode
//   Drive est indisponible (`GOOGLE_CLIENT_ID` absent) plutôt que de tenter un
//   appel réseau voué à échouer.
// - Pas de persistance de `rootFolderId`/`driveId` dans ce module : la
//   création/la reprise d'un workspace Drive (choix du dossier racine côté
//   Google Picker, mémorisation locale) est HORS SCOPE de ce lot (le contrat
//   §2 ne demande que le provider de token + `createDriveEngine`) ; câbler ce
//   choix dans `local-backend.js`/Réglages est laissé à une passe ultérieure
//   (voir le rapport du lot pour l'emplacement exact suggéré).

import { createSoloStore } from "./src/integration/solo-store.js";
import { GoogleDriveStorageAdapter, DRIVE_SCOPE } from "./src/storage/google-drive-adapter.js";
import { normalizeConfig } from "./src/config/runtime-config.js";

// ---------------------------------------------------------------------------
// Gating (docs/next/DRIVE_LIVE_CONTRACT.md §5, storage-factory.js §10) :
// `GOOGLE_CLIENT_ID` vient de la config runtime, jamais en dur. Lu une seule
// fois au chargement du module depuis le drapeau global posé par la page hôte
// (même famille que `window.PILOTEO_FORCE_SOLO`, piloteo-solo-bridge.mjs).
// ---------------------------------------------------------------------------

function resolveGoogleClientId() {
  const raw =
    (typeof window !== "undefined" && window.PILOTEO_GOOGLE_CLIENT_ID) ||
    null;
  try {
    const config = normalizeConfig({
      mode: "shared",
      storage: { provider: "google-drive", googleClientId: raw || null },
    });
    return config.googleWired ? config.storage.googleClientId : null;
  } catch {
    // Une valeur mal formée (ex: chaîne vide explicite) ne doit jamais faire
    // planter le chargement de la page : mode Drive simplement indisponible.
    return null;
  }
}

const GOOGLE_CLIENT_ID = resolveGoogleClientId();

// ---------------------------------------------------------------------------
// Provider de token OAuth navigateur — Google Identity Services, modèle TOKEN
// (docs/next/DRIVE_LIVE_CONTRACT.md §2, prouvé par tools/team-spike/index.html).
// ---------------------------------------------------------------------------

let tokenClient = null;
let cachedToken = null; // { accessToken, expiresAt } — MÉMOIRE DE PAGE UNIQUEMENT, jamais persisté/loggé.
let pendingTokenRequest = null;

/** Attend que le script GIS (chargé par la page hôte) ait exposé `google.accounts.oauth2`. */
function waitForGis(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      resolve();
      return;
    }
    let waited = 0;
    const step = 50;
    (function poll() {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        resolve();
        return;
      }
      waited += step;
      if (waited >= timeoutMs) {
        reject(new Error("piloteo-drive-bridge: Google Identity Services (GIS) non chargé (script absent ou hors ligne)."));
        return;
      }
      setTimeout(poll, step);
    })();
  });
}

/** Déclenche `requestAccessToken()` (interaction utilisateur possible) et résout le nouveau token. */
function requestNewAccessToken() {
  if (pendingTokenRequest) return pendingTokenRequest; // une seule demande en vol à la fois.
  pendingTokenRequest = waitForGis()
    .then(
      () =>
        new Promise((resolve, reject) => {
          if (!tokenClient) {
            tokenClient = window.google.accounts.oauth2.initTokenClient({
              client_id: GOOGLE_CLIENT_ID,
              scope: DRIVE_SCOPE,
              callback: (resp) => {
                if (resp && resp.access_token) {
                  const expiresInMs = (Number(resp.expires_in) || 3600) * 1000;
                  // Marge de 30s : ne jamais présenter à Drive un token sur le point d'expirer.
                  cachedToken = { accessToken: resp.access_token, expiresAt: Date.now() + expiresInMs - 30000 };
                  resolve(resp.access_token);
                } else {
                  reject(new Error("piloteo-drive-bridge: connexion Google refusée/fermée — " + ((resp && resp.error) || "raison inconnue")));
                }
              },
              error_callback: (err) => {
                reject(new Error("piloteo-drive-bridge: erreur Google Identity Services — " + ((err && err.type) || err)));
              },
            });
          }
          tokenClient.requestAccessToken();
        })
    )
    .finally(() => {
      pendingTokenRequest = null;
    });
  return pendingTokenRequest;
}

/**
 * `window.PiloteoDrive.oauthTokenProvider()` — Promise<accessToken> : renvoie le
 * token en cache MÉMOIRE s'il n'est pas expiré, sinon relance `requestAccessToken()`.
 * Jamais persisté, jamais loggé (docs/next/DRIVE_LIVE_CONTRACT.md §2).
 */
async function oauthTokenProvider() {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error(
      "piloteo-drive-bridge: mode Google Drive indisponible (GOOGLE_CLIENT_ID absent de la configuration runtime)."
    );
  }
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }
  return requestNewAccessToken();
}

/** Force une nouvelle demande de token au prochain appel (ex: après une `DriveAuthError` explicite). */
function invalidateToken() {
  cachedToken = null;
}

// ---------------------------------------------------------------------------
// Engine {load, commit} au-dessus d'un GoogleDriveStorageAdapter — même
// contrat que `piloteo-solo-bridge.mjs#buildEngine` (mode Dossier), pour que
// `local-backend.js` route `/api/state` dessus EXACTEMENT pareil (409 sur
// conflit, mapping déjà en place côté local-backend.js — non dupliqué ici).
// ---------------------------------------------------------------------------

/**
 * Backend `solo-store.js` (§5 CONVERGENCE_CONTRACT) au-dessus d'un `StorageAdapter`
 * DÉJÀ CONSTRUIT (ici Google Drive) — même logique que
 * `solo-store.js#createFolderEventBackend`, reportée ici car cette dernière
 * construit elle-même un `FolderStorageAdapter` interne (couplage volontaire,
 * cf. son en-tête) incompatible avec un adaptateur déjà construit.
 */
function createDriveEventBackend({ adapter }) {
  let connected = false;
  let cachedIdentity = null;

  return {
    async init() {
      if (!connected) {
        await adapter.connect();
        connected = true;
      }
      if (!cachedIdentity) {
        if (await adapter.exists("workspace", "manifest")) {
          cachedIdentity = await adapter.get("workspace", "manifest");
        } else {
          const fresh = {
            workspaceId: crypto.randomUUID(),
            actorId: crypto.randomUUID(),
            epoch: 1,
          };
          try {
            await adapter.putImmutable("workspace", "manifest", fresh);
            cachedIdentity = fresh;
          } catch (err) {
            // Course de création (Point 4 §3 : write-once, le perdant se réconcilie) :
            // un autre écrivain a créé le manifeste entre le `exists()` et notre écriture.
            if (err && err.code === "IMMUTABLE_CONFLICT" && (await adapter.exists("workspace", "manifest"))) {
              cachedIdentity = await adapter.get("workspace", "manifest");
            } else {
              throw err;
            }
          }
        }
      }
    },

    identity() {
      if (!cachedIdentity) {
        throw new Error("createDriveEventBackend: identity() appelé avant init().");
      }
      return cachedIdentity;
    },

    async listEvents() {
      const { changes } = await adapter.listChanges();
      const events = [];
      for (const change of changes) {
        if (change.kind !== "event") continue;
        events.push(await adapter.get("event", change.id));
      }
      return events;
    },

    async appendEvent(event) {
      if (await adapter.exists("event", event.eventId)) return; // write-once : doublon -> no-op
      await adapter.putImmutable("event", event.eventId, event);
    },

    async revision() {
      const { changes } = await adapter.listChanges();
      return changes.filter((c) => c.kind === "event").length;
    },
  };
}

/** Construit l'engine `{load, commit}` au-dessus d'un `GoogleDriveStorageAdapter` déjà configuré. */
function buildEngine(adapter) {
  const backend = createDriveEventBackend({ adapter });
  const store = createSoloStore({ backend });

  return {
    folderName: "Google Drive",

    async load() {
      const { revision, state } = await store.load();
      return { revision, state };
    },

    async commit(nextState) {
      const { revision, state, conflicts } = await store.commit(nextState);
      const out = { ok: true, revision, state, changes: {} };
      if (conflicts && conflicts.length) out.conflicts = conflicts;
      return out;
    },
  };
}

/**
 * Construit un `GoogleDriveStorageAdapter` + l'engine `{load, commit}` réutilisant
 * le même pont que Dossier/Org (Point 4 §2). Lève une erreur claire si le mode
 * Drive est indisponible (`GOOGLE_CLIENT_ID` absent) plutôt que de tenter un appel
 * réseau voué à échouer.
 *
 * @param {{rootFolderId:string, driveId?:string}} opts `rootFolderId` : id Drive du
 *   dossier racine du workspace (déjà créé/reçu par invitation — le choix/la création
 *   de ce dossier, via Google Picker, est hors scope de ce lot, voir en-tête).
 * @returns {{engine:{load,commit,folderName}, adapter:GoogleDriveStorageAdapter}}
 */
function createDriveEngine({ rootFolderId, driveId } = {}) {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error(
      "createDriveEngine: mode Google Drive indisponible (GOOGLE_CLIENT_ID absent de la configuration runtime)."
    );
  }
  if (typeof rootFolderId !== "string" || rootFolderId.length === 0) {
    throw new Error("createDriveEngine: 'rootFolderId' (id Drive du dossier racine du workspace) requis.");
  }
  const adapter = new GoogleDriveStorageAdapter({
    oauthTokenProvider,
    rootFolderId,
    driveId: driveId || null,
  });
  return { engine: buildEngine(adapter), adapter };
}

window.PiloteoDrive = {
  isAvailable: GOOGLE_CLIENT_ID !== null,
  DRIVE_SCOPE,
  oauthTokenProvider,
  invalidateToken,
  createDriveEngine,
  // Hook de test : construit l'engine directement depuis un adaptateur déjà
  // configuré (ex: GoogleDriveStorageAdapter avec fetchImpl mocké), sans passer
  // par GIS ni par `window.PILOTEO_GOOGLE_CLIENT_ID` — symétrique de
  // `__engineFromHandle`/`__openOrgEngineFromHandle` des autres ponts.
  __engineFromAdapter: buildEngine,
};
