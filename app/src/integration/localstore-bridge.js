// src/integration/localstore-bridge.js
//
// Pont Phase 1 (docs/next/03_MIGRATION_V1_VERS_LOCAL_FIRST.md « Phase 1 —
// Introduire LocalStore sans supprimer le serveur ») entre l'état serveur V1
// et `src/storage/local-store.js`, plus une fonction pure pour l'écran de
// démarrage à 3 choix (CONTRACTS.md §9, docs/next/01_CDC_LOCAL_FIRST.md §4).
//
// Module ES **framework-free** (aucune dépendance runtime, npm ou navigateur
// spécifique) : compatible navigateur et Node, comme tout le reste de
// `src/` (CONTRACTS.md §0). Ne touche ni au DOM, ni à `fetch`, ni à
// `app.js`/`index.html`/`server.py`.
//
// ---------------------------------------------------------------------------
// INERTIE PAR DÉFAUT — lire avant d'intégrer
// ---------------------------------------------------------------------------
// Ce module n'exécute RIEN à l'import : pas d'auto-exécution, pas d'écoute
// d'événement global, pas de patch de `window.fetch`/`XMLHttpRequest`, pas
// d'accès à `document`. Chaque fonction exportée n'a d'effet que si un
// appelant l'invoque explicitement avec les bons arguments. Importer ce
// fichier dans une page ne change donc RIEN au comportement V1 tant qu'aucun
// code n'appelle `mirrorServerState`/`loadMirroredState`/`chooseStartMode`.
//
// Câblage Phase 1 (futur, hors périmètre de ce lot — détaillé dans
// pwa/README.md) : d'après les coutures identifiées dans
// `src/V1_DOMAIN_MAP.md` §6 —
//   - `collectState()` (app.js:528) est la SOURCE d'écriture de l'état front ;
//   - `applyRemoteState(state, ...)` (app.js:554) est le SINK qui répartit un
//     état reçu vers les 12 variables de module ;
//   - `syncNow()` (app.js:730) est la COUTURE réseau (`PUT /api/state`).
// Une future intégration appellerait, SANS réécrire ces fonctions :
//   1. `mirrorServerState(localStore, workspaceId, data.state)` juste après
//      chaque réponse serveur appliquée via `applyRemoteState` (miroir local
//      de ce que le serveur vient de confirmer) ;
//   2. `loadMirroredState(localStore, workspaceId)` au démarrage, pour
//      pré-remplir l'UI depuis le miroir local pendant qu'`GET /api/state`
//      est en vol (perçu par l'utilisateur comme un chargement instantané),
//      SANS jamais remplacer le serveur comme source de vérité en Phase 1
//      (le miroir est purement un cache de lecture, pas encore autoritaire).
// Le serveur reste la source de vérité en Phase 1 (docs/next/03) : ce pont ne
// fait que recopier ce que le serveur envoie, il ne décide jamais rien.
// ---------------------------------------------------------------------------

/** @private Valide un LocalStore-like minimal (duck-typing, pas d'import de classe). */
function requireLocalStore(localStore) {
  if (
    !localStore ||
    typeof localStore.saveLocalProjection !== "function" ||
    typeof localStore.loadWorkspaceState !== "function"
  ) {
    throw new TypeError(
      "localstore-bridge: localStore doit exposer saveLocalProjection() et loadWorkspaceState() " +
        "(voir src/storage/local-store.js)",
    );
  }
}

function requireWorkspaceId(workspaceId) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new TypeError("localstore-bridge: workspaceId doit être une chaîne non vide");
  }
}

/**
 * Écrit dans `localStore` la projection d'état reçue du serveur — le
 * « sink » Phase 1. Ne fait AUCUNE transformation métier : `serverState` est
 * enregistré tel quel comme projection courante du workspace, en remplacement
 * de la précédente (CONTRACTS.md §9 `saveLocalProjection`). Le serveur reste
 * la source de vérité en Phase 1 ; ceci est un miroir de lecture, pas une
 * réconciliation ni un import (voir migration/v1-import.js pour l'import réel).
 *
 * N'est appelé par rien automatiquement : un futur point d'intégration
 * l'invoquerait explicitement après chaque réponse serveur appliquée (voir
 * le commentaire d'en-tête).
 *
 * @param {import("../storage/local-store.js").LocalStore} localStore
 * @param {string} workspaceId
 * @param {object} serverState - objet reçu du serveur (forme `collectState()`
 *   côté V1 : les 12 collections). Non validé structurellement ici — la
 *   validation de forme est une responsabilité séparée (CONTRACTS.md §2),
 *   volontairement hors du périmètre d'un simple miroir Phase 1.
 * @returns {Promise<{mirrored: true, workspaceId: string}>}
 */
export async function mirrorServerState(localStore, workspaceId, serverState) {
  requireLocalStore(localStore);
  requireWorkspaceId(workspaceId);
  if (serverState === undefined) {
    throw new TypeError("localstore-bridge.mirrorServerState: serverState requis (objet ou null)");
  }
  await localStore.saveLocalProjection(workspaceId, serverState);
  return { mirrored: true, workspaceId };
}

/**
 * Relit la dernière projection miroir sauvegardée pour `workspaceId`, ou
 * `null` si aucune n'a jamais été écrite (jamais synchronisé localement, ou
 * workspace inconnu du LocalStore). Simple relecture — aucune fusion, aucune
 * décision de fraîcheur (c'est au futur appelant de comparer avec l'état
 * serveur si besoin).
 *
 * @param {import("../storage/local-store.js").LocalStore} localStore
 * @param {string} workspaceId
 * @returns {Promise<object|null>}
 */
export async function loadMirroredState(localStore, workspaceId) {
  requireLocalStore(localStore);
  requireWorkspaceId(workspaceId);
  return localStore.loadWorkspaceState(workspaceId);
}

const START_MODES = Object.freeze(["create", "join", "solo"]);

/**
 * Fonction PURE (aucun effet de bord, aucun I/O) qui détermine le mode de
 * démarrage à partir du choix de l'écran d'accueil à 3 options
 * (docs/next/01_CDC_LOCAL_FIRST.md §4) :
 *   - §4.1 « Créer un espace pour mon entreprise ou mon équipe » -> "create"
 *   - §4.2 « J'ai reçu une invitation »                          -> "join"
 *   - §4.3 « Mes données restent sur cet appareil »               -> "solo"
 *
 * Contrat d'entrée : `input` est un objet `{ intent, invitationCode }` où :
 *   - `invitationCode` (optionnel) : une chaîne non vide présente (ex. lien
 *     d'invitation ouvert directement, §4.2 « saisie ou scan du code/lien »)
 *     force TOUJOURS le mode "join", quel que soit `intent` — un lien
 *     d'invitation entrant prime sur un choix explicite potentiellement
 *     obsolète (évite qu'un utilisateur arrivant via un lien d'invitation
 *     atterrisse ailleurs que sur le parcours de rejoindre).
 *   - `intent` : un des trois littéraux `"create" | "join" | "solo"`,
 *     reflétant le bouton cliqué par l'utilisateur.
 * Toute autre forme (objet sans signal exploitable, `intent` inconnu, entrée
 * non-objet) est une **entrée invalide** : ce n'est jamais deviné à l'aveugle
 * (cf. philosophie de validation stricte, CONTRACTS.md §2/§12) — la fonction
 * lève une `TypeError` explicite plutôt que de retourner un mode par défaut
 * silencieux.
 *
 * @param {{intent?: "create"|"join"|"solo", invitationCode?: string}} input
 * @returns {"create"|"join"|"solo"}
 */
export function chooseStartMode(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("chooseStartMode: input doit être un objet {intent?, invitationCode?}");
  }

  const { intent, invitationCode } = input;

  if (typeof invitationCode === "string" && invitationCode.trim().length > 0) {
    return "join";
  }

  if (typeof intent === "string" && START_MODES.includes(intent)) {
    return intent;
  }

  throw new TypeError(
    `chooseStartMode: entrée invalide (intent=${JSON.stringify(intent)}, ` +
      `invitationCode=${JSON.stringify(invitationCode)}) — attendu intent ∈ ` +
      `${JSON.stringify(START_MODES)} ou un invitationCode non vide`,
  );
}

export { START_MODES };
