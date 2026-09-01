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
// Onboarding Drive (docs/next/DRIVE_ONBOARDING_CONTRACT.md, lot A) : mêmes
// primitives d'organisation que piloteo-org-bridge.mjs#createOrg
// (createOrganization + writeManifest + writeMemberRecord + openOrgEngine),
// RÉUTILISÉES telles quelles ici sur un GoogleDriveStorageAdapter au lieu d'un
// FolderStorageAdapter — la logique d'org (org-runtime.js/org-folder-store.js/
// org-engine.js) est déjà agnostique de l'adaptateur (contrat §0). Aucune
// logique d'org n'est réécrite.
import { openOrgEngine } from "./src/workspace/org-engine.js";
import { createOrganization } from "./src/workspace/org-runtime.js";
import { writeManifest, writeMemberRecord } from "./src/workspace/org-folder-store.js";

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

// ---------------------------------------------------------------------------
// Onboarding Drive (docs/next/DRIVE_ONBOARDING_CONTRACT.md, lot A) : créer +
// inviter + reprendre une organisation dont le « dossier » est un espace
// Google Drive au lieu d'un `FileSystemDirectoryHandle` local — pour un
// onboarding utilisable partout, y compris mobile (l'API File System Access
// ne marche pas sur un dossier Drive synchronisé). Le « rejoindre » (Google
// Picker) est le lot B, hors scope ici.
//
// Décisions/hypothèses :
// - IDENTITÉ PARTAGÉE (contrat §1) : la MÊME identité de membre Ed25519
//   persistée par `piloteo-org-bridge.mjs` (`window.PiloteoOrg.getOrCreateIdentity`)
//   est réutilisée — jamais une seconde identité fabriquée ici. `index.html`
//   charge `piloteo-org-bridge.mjs` avant `piloteo-drive-bridge.mjs` (les deux
//   sont des modules ES non-`async`, donc exécutés dans l'ordre du document),
//   mais l'accès se fait par un lookup PARESSEUX de `window.PiloteoOrg` à
//   CHAQUE appel (jamais figé au chargement du module) — robuste à un ordre de
//   chargement différent en test. Si `window.PiloteoOrg` est absent, on lève
//   une erreur explicite plutôt que de fabriquer une identité de repli (ce qui
//   violerait "jamais une 2e identité").
// - `createDriveRootFolder`/`createDriveOrg`/`openDriveOrg`/`resumeDriveOrg`
//   sont couverts par `tests/next/drive-onboarding.test.mjs` via les hooks de
//   TEST `__createOrgOnAdapter`/`__openOrgOnAdapter` ci-dessous (adaptateur
//   Drive déjà construit sur un FakeDrive, `fetchImpl` mocké) : ils exercent
//   EXACTEMENT la même chaîne (createOrganization + writeManifest +
//   writeMemberRecord + openOrgEngine) que les fonctions publiques, sans OAuth
//   ni appel réseau réel à Google (impossible à automatiser ici, cf.
//   docs/next/DRIVE_ONBOARDING_MANUAL.md). Seule la création RÉELLE du dossier
//   racine (`createDriveRootFolder`, un appel `fetch` direct vers l'API Drive,
//   mêmes endpoints/en-têtes que `tools/team-spike/index.html`, déjà prouvés
//   en navigateur réel) et l'obtention interactive d'un token restent
//   vérifiables UNIQUEMENT en navigateur réel.
// - `resumeDriveOrg` : SYMÉTRIQUE de `piloteo-org-bridge.mjs#resumeOrg` — au
//   boot (`interactive` absent/`false`), ne consulte QUE le token déjà en
//   cache MÉMOIRE (`cachedToken`, jamais `requestAccessToken()`) ; comme ce
//   cache est une variable de MODULE (jamais persisté, décision Point 4 ci-
//   dessus), il est TOUJOURS vide après un rechargement de page — `resumeDriveOrg()`
//   renvoie donc `{needsAuth:true}` à CHAQUE boot d'une organisation Drive
//   mémorisée, jusqu'à ce qu'un geste utilisateur (bouton « Se reconnecter à
//   Google ») appelle `resumeDriveOrg({interactive:true})`, qui peut alors
//   déclencher `requestAccessToken()`. JAMAIS d'appel interactif hors geste.
// ---------------------------------------------------------------------------

const DRIVE_STORAGE_MODE_KEY = "piloteo_storage_mode"; // partagé avec les autres ponts (un seul mode actif à la fois)
const DRIVE_ROOT_FOLDER_ID_KEY = "piloteo_drive_root_folder_id"; // localStorage : id Drive du dossier racine de l'org active

/** `window.PiloteoOrg`, si chargé — jamais mis en cache (lookup à chaque appel, cf. décision ci-dessus). */
function orgBridge() {
  return (typeof window !== "undefined" && window.PiloteoOrg) || null;
}

/** Identité de membre PARTAGÉE (piloteo-org-bridge.mjs) — jamais une 2e identité fabriquée ici (contrat §1). */
async function getSharedIdentity() {
  const PO = orgBridge();
  if (!PO || typeof PO.getOrCreateIdentity !== "function") {
    throw new Error(
      "piloteo-drive-bridge: window.PiloteoOrg indisponible — piloteo-org-bridge.mjs doit être chargé (index.html) " +
        "pour fournir l'identité de membre partagée (jamais une 2e identité fabriquée ici)."
    );
  }
  return PO.getOrCreateIdentity();
}

function persistDriveOrgMode(rootFolderId) {
  try { localStorage.setItem(DRIVE_STORAGE_MODE_KEY, "org-drive"); } catch (e) { /* localStorage indisponible : dégradé, pas bloquant */ }
  try { localStorage.setItem(DRIVE_ROOT_FOLDER_ID_KEY, rootFolderId); } catch (e) { /* idem */ }
}
function loadStoredRootFolderId() {
  try { return localStorage.getItem(DRIVE_ROOT_FOLDER_ID_KEY) || null; } catch (e) { return null; }
}

/** Le token en cache MÉMOIRE s'il est valide, `null` sinon — QUERY-ONLY, ne déclenche jamais `requestAccessToken()`. */
function cachedTokenOnly() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken;
  return null;
}

/**
 * Crée un dossier Drive `Pilotéo - <name>` (`files.create`, mimeType dossier,
 * scope `drive.file` suffit) via le token courant. Mêmes appels REST que
 * `tools/team-spike/index.html` (endpoints/en-têtes déjà prouvés en navigateur
 * réel). Vérifiable UNIQUEMENT en navigateur réel (docs/next/DRIVE_ONBOARDING_MANUAL.md).
 * @param {string} name nom d'affichage de l'organisation
 * @returns {Promise<{rootFolderId:string, webViewLink:string|null}>}
 */
async function createDriveRootFolder(name) {
  const token = await oauthTokenProvider();
  const folderName = "Pilotéo - " + (name && String(name).trim() ? String(name).trim() : "Organisation");
  const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`createDriveRootFolder: échec de la création du dossier Drive (HTTP ${res.status}) ${body}`);
  }
  const data = await res.json();
  return { rootFolderId: data.id, webViewLink: data.webViewLink || null };
}

/**
 * Chaîne d'organisation générique (contrat §0/§1), sur un `GoogleDriveStorageAdapter`
 * DÉJÀ CONSTRUIT — hook de TEST public (`__createOrgOnAdapter`) ET brique
 * interne de `createDriveOrg`. `createOrganization`/`writeManifest`/
 * `writeMemberRecord`/`openOrgEngine` : RÉUTILISÉS tels quels (aucune logique
 * d'org réécrite), exactement la séquence de `piloteo-org-bridge.mjs#createOrg`.
 */
async function createOrgOnAdapter({ adapter, name, consultantId, identity } = {}) {
  if (!adapter) throw new Error("createOrgOnAdapter: 'adapter' requis.");
  await adapter.connect();
  const id = identity || (await getSharedIdentity());
  const org = createOrganization({ name, identity: id, consultantId });
  await writeManifest(adapter, org.manifest);
  await writeMemberRecord(adapter, org.memberRecord);
  const engine = await openOrgEngine({ adapter, identity: id, consultantId });
  engine.folderName = "Google Drive";
  return { engine, adapter, manifest: engine.manifest };
}

/** Rouvre (sans rien publier) une organisation existante sur un adapter Drive DÉJÀ CONSTRUIT — hook de TEST public (`__openOrgOnAdapter`) ET brique interne de `openDriveOrg`/`resumeDriveOrg`. */
async function openOrgOnAdapter({ adapter, consultantId, identity } = {}) {
  if (!adapter) throw new Error("openOrgOnAdapter: 'adapter' requis.");
  await adapter.connect();
  const id = identity || (await getSharedIdentity());
  const engine = await openOrgEngine({ adapter, identity: id, consultantId });
  engine.folderName = "Google Drive";
  return { engine, adapter, manifest: engine.manifest, membership: engine.membership };
}

/**
 * Crée une organisation sur un dossier Drive FRAÎCHEMENT CRÉÉ (contrat §1) :
 * `oauthTokenProvider()` (déclenche le consentement si besoin, DANS le geste
 * utilisateur qui a appelé cette fonction) → `createDriveRootFolder(name)` →
 * `GoogleDriveStorageAdapter` → même chaîne d'org que `createOrgOnAdapter`.
 * Persiste `piloteo_storage_mode="org-drive"` + `rootFolderId` pour la reprise.
 * @returns {Promise<{engine:object, adapter:GoogleDriveStorageAdapter, manifest:object, rootFolderId:string, webViewLink:string|null}>}
 */
async function createDriveOrg({ name, consultantId, identity } = {}) {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error("createDriveOrg: mode Google Drive indisponible (GOOGLE_CLIENT_ID absent de la configuration runtime).");
  }
  await oauthTokenProvider(); // déclenche le consentement si besoin (contrat §1) — DANS le geste utilisateur appelant.
  const { rootFolderId, webViewLink } = await createDriveRootFolder(name);
  const adapter = new GoogleDriveStorageAdapter({ oauthTokenProvider, rootFolderId });
  const result = await createOrgOnAdapter({ adapter, name, consultantId, identity });
  persistDriveOrgMode(rootFolderId);
  return Object.assign({}, result, { rootFolderId, webViewLink });
}

/**
 * Rouvre une organisation Drive existante (contrat §1) — pour la reprise au
 * boot et pour un futur « rejoindre » (lot B).
 * @returns {Promise<{engine:object, adapter:GoogleDriveStorageAdapter, manifest:object, membership:object, rootFolderId:string}>}
 */
async function openDriveOrg({ rootFolderId, consultantId, identity } = {}) {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error("openDriveOrg: mode Google Drive indisponible (GOOGLE_CLIENT_ID absent de la configuration runtime).");
  }
  if (typeof rootFolderId !== "string" || rootFolderId.length === 0) {
    throw new Error("openDriveOrg: 'rootFolderId' (id Drive du dossier racine du workspace) requis.");
  }
  const adapter = new GoogleDriveStorageAdapter({ oauthTokenProvider, rootFolderId });
  const result = await openOrgOnAdapter({ adapter, consultantId, identity });
  return Object.assign({}, result, { rootFolderId });
}

/**
 * Reprise au boot (contrat §1, symétrique de `piloteo-org-bridge.mjs#resumeOrg`) :
 * lit le `rootFolderId` mémorisé (`null` si aucun) ; sinon QUERY-ONLY sur le
 * token (jamais `requestAccessToken()` hors geste) — `{needsAuth:true}` si
 * aucun token valide en cache mémoire, sinon rouvre l'organisation.
 * `opts.interactive:true` (UNIQUEMENT depuis un geste utilisateur — bouton
 * « Se reconnecter à Google ») autorise `oauthTokenProvider()` à déclencher
 * `requestAccessToken()`.
 * @returns {Promise<null|{needsAuth:true}|{engine:object, adapter:GoogleDriveStorageAdapter, manifest:object, membership:object, rootFolderId:string}>}
 */
async function resumeDriveOrg(opts) {
  const rootFolderId = loadStoredRootFolderId();
  if (!rootFolderId) return null;
  const interactive = !!(opts && opts.interactive);
  let token = cachedTokenOnly();
  if (!token) {
    if (!interactive) return { needsAuth: true }; // JAMAIS d'appel interactif hors geste utilisateur.
    token = await oauthTokenProvider(); // dans le geste (« Se reconnecter à Google ») : interactif autorisé.
  }
  return openDriveOrg({ rootFolderId });
}

/** Invite un futur membre — IDENTIQUE au pont org (invite ne dépend pas du stockage) : délégué tel quel. */
async function driveInvite(args) {
  const PO = orgBridge();
  if (!PO || typeof PO.invite !== "function") {
    throw new Error("piloteo-drive-bridge: window.PiloteoOrg indisponible (invite) — piloteo-org-bridge.mjs doit être chargé.");
  }
  return PO.invite(args);
}
/** Révoque un membre — IDENTIQUE au pont org (écrit sur l'adapter générique passé) : délégué tel quel. */
async function driveRevoke(args) {
  const PO = orgBridge();
  if (!PO || typeof PO.revoke !== "function") {
    throw new Error("piloteo-drive-bridge: window.PiloteoOrg indisponible (revoke) — piloteo-org-bridge.mjs doit être chargé.");
  }
  return PO.revoke(args);
}
/** Liste les membres d'une organisation Drive ouverte — IDENTIQUE au pont org : délégué tel quel. */
async function driveListMembers(engine) {
  const PO = orgBridge();
  if (!PO || typeof PO.listMembers !== "function") {
    throw new Error("piloteo-drive-bridge: window.PiloteoOrg indisponible (listMembers) — piloteo-org-bridge.mjs doit être chargé.");
  }
  return PO.listMembers(engine);
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

  // --- Onboarding Drive (docs/next/DRIVE_ONBOARDING_CONTRACT.md, lot A) ----
  createDriveRootFolder,
  createDriveOrg,
  openDriveOrg,
  resumeDriveOrg,
  invite: driveInvite,
  revoke: driveRevoke,
  listMembers: driveListMembers,
  // Hooks de TEST (symétriques à `__engineFromAdapter`) : exercent la chaîne
  // d'organisation directement sur un adaptateur Drive déjà construit (ex:
  // FakeDrive), sans OAuth ni appel réseau réel à Google.
  __createOrgOnAdapter: createOrgOnAdapter,
  __openOrgOnAdapter: openOrgOnAdapter,
};
