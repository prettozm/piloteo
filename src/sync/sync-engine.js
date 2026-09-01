// src/sync/sync-engine.js
//
// SyncEngine — CONTRACTS.md §6, cycle docs/next/04_SYNC_ET_STOCKAGE_DRIVE.md §4,
// ordre de traitement hostile docs/next/05_SECURITE_CRYPTO_IDENTITE.md §9.
//
// Décisions/hypothèses (à documenter, la forme exacte de certains collaborateurs
// n'étant pas figée ailleurs — cf. consigne « définis une petite interface claire
// et injecte-la ») :
//
// 1. `memberRegistry` (NON committé ailleurs, interface définie ICI) :
//      { getPublicKey(actorId) -> publicKeyJwk | null|undefined }
//    Retourne la clé publique Ed25519 (JWK) de signature d'un membre à partir
//    de son `actorId` (= `memberId`), ou une valeur falsy si inconnu. C'est le
//    SEUL moyen de vérifier une signature ; un acteur absent du registre est
//    traité comme un membre inconnu (rejet, cf. étape « verify signature »).
//    Dans les tests, un simple objet/Map fait l'affaire (fake).
//
// 2. `membershipStore` : instance de `workspace/memberships.js#MembershipStore`
//    (module committé), interrogée via `.get(workspaceId, actorId)`. Un
//    membership absent OU `status:"revoked"` est rejeté à l'étape « verify
//    membership » — AVANT même la politique métier (docs/next/05 §9 : "Un
//    membre `revoked` est rejeté").
//
// 3. `actor` : identité LOCALE de ce client `{ workspaceId, memberId,
//    privateKeyRef }` — `privateKeyRef` sert à signer les événements que CE
//    moteur pousse (`push()`). Chaque `SyncEngine` représente UN membre d'UN
//    workspace ; un même process peut instancier plusieurs `SyncEngine` (un
//    par membre simulé) partageant le même `adapter` pour les tests multi-clients.
//
// 4. `eventLog` : instance de `events/event-log.js#EventLog` PROPRE à ce
//    client (jamais partagée entre deux `SyncEngine`). Elle porte les
//    événements LOCAUX (créés par ce client, payload en clair) ET les
//    événements DISTANTS acceptés (déchiffrés puis ré-attachés en `payload`
//    clair — cf. event-schema.js §1 : "un même reducer traite les deux [modes]
//    après déchiffrement"). Un événement REJETÉ (signature/membership/policy/
//    schéma invalides) n'est JAMAIS ajouté à `eventLog` : il ne doit jamais
//    pouvoir influencer la projection, même en `conflict`. Un événement qui
//    passe toutes les vérifications mais arrive en concurrence sur la même
//    entité EST ajouté au journal (il est légitime), et c'est
//    `EventLog#replay()` (déjà committé, déterministe par construction — tri
//    causal par entité/baseVersion puis createdAt puis eventId) qui le
//    classera en `conflict` dans `projection.__conflicts` sans jamais écraser
//    l'entité. Ce choix réutilise tel quel l'invariant déjà garanti par
//    `event-log.js` plutôt que de dupliquer une logique de classement ici :
//    c'est ce qui garantit "ordre de réception différent => projection
//    identique" (docs/next/07 §7) sans code supplémentaire.
//
// 5. Statut `pending -> published` (CONTRACTS §1) : ce moteur ne modifie PAS
//    l'objet événement pour porter ce statut (l'événement reste immuable) ; il
//    le suit dans une structure interne (`_pendingStatus: Map<eventId,status>`)
//    tenue par CE `SyncEngine`, aux côtés de `_pendingEvents` (les événements
//    que CE client a lui-même créés, donc les seuls qu'il ait la responsabilité
//    de publier). Un événement reçu par `pull()` n'entre jamais dans ces maps :
//    il est déjà "publié" par construction (on vient de le lire depuis
//    l'adaptateur).
//
// 6. Un événement REÇU déjà vu (même `eventId`) est ignoré silencieusement dès
//    le tri des `changes` (avant même `adapter.get`), via `_seen : Set<eventId>`
//    — idempotence garantie sans re-décrypter/re-vérifier inutilement
//    (CONTRACTS §6 : "un événement distant déjà vu est ignoré sans erreur").
//
// 7. Ordre de traitement d'un événement distant (docs/next/05 §9, et forme
//    exacte du pipeline CONTRACTS §6) — implémenté dans `_processIncoming`,
//    DANS CET ORDRE EXACT, sans court-circuit qui sauterait une étape :
//      parse envelope (isWellFormedEnvelope + validateEnvelope)
//        -> workspace attendu (rejette une référence à un workspace étranger)
//        -> verify signature (memberRegistry + crypto.verify)
//        -> decrypt (keyring + crypto.decryptPayload ; epoch inconnue => rejet explicite)
//        -> validate schema (validatePayload)
//        -> verify membership (membershipStore ; inconnu/révoqué => rejet)
//        -> verify policy (policy.evaluate ; tout sauf "accept" => rejet)
//        -> verify concurrency + apply (délégué à EventLog#replay(), point 4)
//    Chaque rejet est journalisé (`getRejections()`) avec l'étape et la raison
//    — jamais un throw qui interromprait le traitement des autres événements
//    du lot (un blob hostile ne doit jamais bloquer la synchro des autres).
//
// 8. `crypto` est le NAMESPACE du module `crypto/crypto-service.js` (import
//    `* as crypto`), pas une instance : ce moteur utilise `crypto.sign`,
//    `crypto.verify`, `crypto.encryptPayload`, `crypto.decryptPayload`.
//
// 9. `localStore` est OPTIONNEL et n'est PAS un contrat figé ici (CONTRACTS §9
//    hors périmètre de ce lot) : s'il est fourni, ce moteur tente, en best
//    effort (try/catch, jamais bloquant), de lire/écrire son curseur via
//    `localStore.get('sync_cursors', cursorKey)` / `.put('sync_cursors', ...)`
//    s'ils existent. Son absence ne change AUCUN comportement testé ici.
//
// 10. `refs` transmis à `validatePayload` : seul `workspaceId` est vérifié ici
//     (`{ workspaceId: actor.workspaceId }`) — les ensembles de références
//     croisées (`consultants`, `affaires`, ...) sont un raffinement optionnel
//     que l'appelant peut ajouter en construisant sa propre policy/refs ; ce
//     moteur ne les calcule pas lui-même (nécessiterait de connaître le
//     schéma complet du domaine, hors périmètre strict de SyncEngine).
//
// 11. Option `trusted` (défaut `false`, docs/next/ORG_CONTRACT.md §2) : modèle
//     « Dossier de confiance » — événements SIGNÉS (Ed25519) mais NON
//     chiffrés (payload en clair dans le blob publié ; la confidentialité
//     repose sur les permissions du SI du client, pas sur ce moteur). Seule la
//     CONFIDENTIALITÉ disparaît : `push()` ne chiffre pas (le blob publié EST
//     l'enveloppe, `payload` en clair, jamais de `ciphertext`, signée via
//     `canonicalize(blob)` qui couvre déjà `payload`) ; `_processIncoming()`
//     saute l'étape « decrypt » (`payload = blob.payload`, déjà en clair) et
//     n'exige pas de `keyring`/epoch connue localement ; `createLocalEvent()`
//     utilise une `epoch` constante à `1` (buildEvent exige `epoch>=1`) sans
//     dépendre d'un `keyring` non vide — le `keyring` devient OPTIONNEL au
//     constructeur en mode `trusted`. TOUTES les autres étapes du pipeline
//     (envelope, verify signature, validate schema, verify membership, verify
//     policy, concurrence via EventLog#replay()) restent EXACTEMENT les mêmes,
//     dans le même ordre : un événement non signé, mal signé, d'un membre
//     inconnu/révoqué, ou refusé par la policy est rejeté à l'identique.
//     Le mode par défaut (`trusted:false`) est un no-op de cette option :
//     chaque branche `trusted` a un `else` qui reproduit le code historique à
//     l'identique, donc aucune régression du comportement chiffré existant.

import { canonicalize, isWellFormedEnvelope, buildEvent } from "../events/event-schema.js";
import { validateEnvelope, validatePayload } from "../events/validation.js";

const CURSOR_STORE = "sync_cursors";

function nowIso() {
  return new Date().toISOString();
}

export class SyncEngine {
  /**
   * @param {object} deps
   * @param {import("../storage/storage-adapter.js").StorageAdapter} deps.adapter
   * @param {import("../events/event-log.js").EventLog} deps.eventLog journal LOCAL de ce client
   * @param {*} deps.crypto namespace de crypto/crypto-service.js (sign, verify, encryptPayload, decryptPayload)
   * @param {import("../crypto/keyring.js").Keyring} deps.keyring
   * @param {{evaluate: Function}} deps.policy typiquement core/permissions.js (evaluate)
   * @param {*} [deps.localStore] optionnel, voir décision 9
   * @param {{getPublicKey:(actorId:string)=>*}} deps.memberRegistry voir décision 1
   * @param {import("../workspace/memberships.js").MembershipStore} deps.membershipStore
   * @param {{workspaceId:string, memberId:string, privateKeyRef:*}} deps.actor identité locale de ce client
   * @param {boolean} [deps.trusted=false] mode « Dossier de confiance » (signé, non chiffré) — voir décision 11
   */
  constructor({
    adapter,
    eventLog,
    crypto,
    keyring,
    policy,
    localStore = null,
    memberRegistry,
    membershipStore,
    actor,
    trusted = false,
  } = {}) {
    if (!adapter) throw new TypeError("SyncEngine: 'adapter' requis.");
    if (!eventLog) throw new TypeError("SyncEngine: 'eventLog' requis.");
    if (!crypto) throw new TypeError("SyncEngine: 'crypto' requis.");
    // En mode trusted, aucun chiffrement n'a lieu : le keyring devient
    // optionnel (décision 11). En mode par défaut, comportement inchangé.
    if (!trusted && !keyring) throw new TypeError("SyncEngine: 'keyring' requis.");
    if (!policy || typeof policy.evaluate !== "function") {
      throw new TypeError("SyncEngine: 'policy' (avec .evaluate) requis.");
    }
    if (!memberRegistry || typeof memberRegistry.getPublicKey !== "function") {
      throw new TypeError("SyncEngine: 'memberRegistry' (avec .getPublicKey) requis.");
    }
    if (!membershipStore || typeof membershipStore.get !== "function") {
      throw new TypeError("SyncEngine: 'membershipStore' (avec .get) requis.");
    }
    if (!actor || !actor.workspaceId || !actor.memberId || !actor.privateKeyRef) {
      throw new TypeError("SyncEngine: 'actor' {workspaceId, memberId, privateKeyRef} requis.");
    }

    this.adapter = adapter;
    this.eventLog = eventLog;
    this.crypto = crypto;
    this.keyring = keyring ?? null;
    this.policy = policy;
    this.localStore = localStore;
    this.memberRegistry = memberRegistry;
    this.membershipStore = membershipStore;
    this.actor = actor;
    this.trusted = !!trusted;

    this._cursorKey = `${actor.workspaceId}:${actor.memberId}`;
    this._cursor = undefined;
    this._seen = new Set();
    /** @type {Map<string,object>} événements créés localement par CE client, en attente/publiés */
    this._pendingEvents = new Map();
    /** @type {Map<string,'pending'|'published'>} */
    this._pendingStatus = new Map();
    this._rejections = [];
    /** @type {Map<string,object>} conflits connus, dédupliqués par eventId */
    this._conflicts = new Map();
    this._connected = false;

    this._projection = this.eventLog.replay();
    this._mergeConflictsFromProjection();
  }

  // -------------------------------------------------------------------------
  // Connexion (best effort, ne bloque pas les tests avec un InMemoryStorageAdapter)
  // -------------------------------------------------------------------------

  async connect() {
    await this.adapter.connect();
    this._connected = true;
    await this._tryLoadCursor();
  }

  async _tryLoadCursor() {
    if (!this.localStore || typeof this.localStore.get !== "function") return;
    try {
      const saved = await this.localStore.get(CURSOR_STORE, this._cursorKey);
      if (saved && typeof saved === "object" && "cursor" in saved) {
        this._cursor = saved.cursor;
      }
    } catch {
      // Best effort : l'absence/l'échec de lecture du curseur ne bloque jamais la synchro.
    }
  }

  async _trySaveCursor() {
    if (!this.localStore || typeof this.localStore.put !== "function") return;
    try {
      await this.localStore.put(CURSOR_STORE, this._cursorKey, { cursor: this._cursor });
    } catch {
      // Best effort.
    }
  }

  // -------------------------------------------------------------------------
  // Création d'événements locaux
  // -------------------------------------------------------------------------

  /**
   * Construit un événement local à partir de l'état projeté courant (baseVersion
   * et epoch dérivés automatiquement) et l'enregistre (voir `recordLocalEvent`).
   */
  createLocalEvent({ entityType, entityId, operation, payload }) {
    const versions = this._projection.__versions || {};
    const currentEntity = versions[entityType]?.[entityId];
    const currentVersion = currentEntity?.version ?? 0;
    // P0.1 — ancrage causal : l'événement descend explicitement du dernier
    // événement ayant amené l'entité à son état courant (null si création).
    const parentEventId = currentEntity?.lastEventId ?? null;
    // En mode trusted (décision 11), pas de rotation d'epoch/chiffrement :
    // epoch constante à 1 (buildEvent exige epoch>=1), sans dépendre du
    // keyring (optionnel dans ce mode). Comportement par défaut inchangé.
    let epoch;
    if (this.trusted) {
      epoch = 1;
    } else {
      epoch = this.keyring.currentEpochNumber();
      if (epoch === null) {
        throw new Error("SyncEngine.createLocalEvent: keyring vide, aucune epoch courante disponible.");
      }
    }
    const event = buildEvent({
      workspaceId: this.actor.workspaceId,
      entityType,
      entityId,
      operation,
      actorId: this.actor.memberId,
      baseVersion: currentVersion,
      epoch,
      payload,
      parentEventId,
    });
    return this.recordLocalEvent(event);
  }

  /**
   * Enregistre un événement déjà construit (`buildEvent`) comme événement
   * LOCAL de ce client : appliqué immédiatement à la projection locale
   * (local-first) et marqué `pending` pour publication ultérieure (`push()`).
   */
  recordLocalEvent(event) {
    if (!isWellFormedEnvelope(event)) {
      throw new TypeError("SyncEngine.recordLocalEvent: événement mal formé.");
    }
    if (event.workspaceId !== this.actor.workspaceId) {
      throw new TypeError("SyncEngine.recordLocalEvent: workspaceId ne correspond pas à cet acteur.");
    }
    if (event.actorId !== this.actor.memberId) {
      throw new TypeError("SyncEngine.recordLocalEvent: actorId ne correspond pas à ce client.");
    }
    const { appended } = this.eventLog.append(event);
    if (appended) {
      this._pendingEvents.set(event.eventId, event);
      this._pendingStatus.set(event.eventId, "pending");
      this._refreshProjection();
    }
    return event;
  }

  // -------------------------------------------------------------------------
  // push() — CONTRACTS §6 : publie les pending ; published seulement après confirmation.
  // -------------------------------------------------------------------------

  async push() {
    const published = [];
    const stillPending = [];
    for (const [eventId, status] of this._pendingStatus.entries()) {
      if (status !== "pending") continue;
      const event = this._pendingEvents.get(eventId);
      try {
        let blob;
        if (this.trusted) {
          // Décision 11 : pas de chiffrement — le blob publié EST l'enveloppe
          // avec son `payload` en clair (jamais de `ciphertext`).
          blob = { ...event };
        } else {
          const epochKey = this.keyring.get(event.epoch);
          if (!epochKey) {
            throw new Error(`clé de l'epoch ${event.epoch} introuvable localement — publication impossible.`);
          }
          const ciphertext = await this.crypto.encryptPayload(epochKey, event.payload);
          const { payload, ...envelopeWithoutPayload } = event;
          blob = { ...envelopeWithoutPayload, ciphertext };
        }
        const bytes = canonicalize(blob);
        const signature = await this.crypto.sign(this.actor.privateKeyRef, bytes);
        blob.signature = signature;

        await this.adapter.putImmutable("event", eventId, blob);
        // Confirmation reçue : marquer published SEULEMENT maintenant.
        this._pendingStatus.set(eventId, "published");
        published.push(eventId);
      } catch (err) {
        // Panne réseau ou autre échec : reste `pending`, jamais de perte.
        stillPending.push({ eventId, error: String((err && err.message) || err) });
      }
    }
    return { published, stillPending };
  }

  // -------------------------------------------------------------------------
  // pull() — CONTRACTS §6 / docs/next/04 §4 / docs/next/05 §9.
  // -------------------------------------------------------------------------

  async pull() {
    const { changes, cursor } = await this.adapter.listChanges(this._cursor);
    const rejections = [];
    let appendedAny = false;
    // P0.2 — un échec RÉCUPÉRABLE (fetch d'un blob annoncé qui échoue
    // temporairement) interdit d'avancer le curseur : sinon l'événement
    // concerné sortirait du prochain `listChanges` et serait perdu à jamais.
    // On conserve alors l'ancien curseur pour rejouer le batch plus tard ; les
    // événements DÉJÀ traités dans ce même batch sont dans `_seen` et seront
    // sautés sans ré-application (idempotence), seul l'événement en échec est
    // re-fetché. Un rejet PERMANENT (signature/schéma/policy/…) n'est pas
    // récupérable : l'événement est marqué `_seen`, on peut avancer le curseur.
    let recoverableError = false;

    for (const change of changes) {
      if (!change || change.kind !== "event") {
        // Distribution de member/key/license : hors périmètre de ce lot
        // (SyncEngine ne traite ici que le flux d'événements métier).
        continue;
      }
      const { id } = change;
      if (this._seen.has(id)) {
        continue; // déjà vu : ignoré sans erreur (idempotence), on ne re-fetch même pas.
      }

      let blob;
      try {
        blob = await this.adapter.get("event", id);
      } catch (err) {
        // NE PAS marquer `_seen` (l'événement n'a pas été traité) et retenir
        // le curseur pour retry ultérieur.
        rejections.push(this._reject(id, "fetch", String((err && err.message) || err)));
        recoverableError = true;
        continue;
      }

      const outcome = await this._processIncoming(blob);
      this._seen.add(id);
      if (outcome.rejected) {
        rejections.push(outcome);
      } else if (outcome.appended) {
        appendedAny = true;
      }
    }

    if (appendedAny) this._refreshProjection();
    // Le curseur n'est commité QUE si le batch a été entièrement consommé sans
    // erreur récupérable (cf. P0.2). En cas d'échec fetch, on garde l'ancien.
    if (!recoverableError) {
      this._cursor = cursor;
      await this._trySaveCursor();
    }

    return { processed: changes.length, rejections, cursorAdvanced: !recoverableError };
  }

  /**
   * Pipeline hostile-safe pour UN blob reçu — voir décision 7 pour l'ordre exact.
   * Ne lève jamais : retourne toujours `{rejected, ...}` ou `{rejected:false, appended, eventId}`.
   */
  async _processIncoming(blob) {
    // 1. parse envelope
    if (!isWellFormedEnvelope(blob)) {
      return this._reject(blob && blob.eventId, "envelope", "enveloppe mal formée (isWellFormedEnvelope)");
    }
    const envCheck = validateEnvelope(blob);
    if (!envCheck.ok) {
      return this._reject(blob.eventId, "envelope", envCheck.reason);
    }
    if (blob.workspaceId !== this.actor.workspaceId) {
      return this._reject(blob.eventId, "envelope", "référence à un workspace étranger");
    }

    // 2. verify signature
    const publicKeyJwk = this.memberRegistry.getPublicKey(blob.actorId);
    if (!publicKeyJwk) {
      return this._reject(
        blob.eventId,
        "signature",
        `acteur inconnu du registre de membres (${blob.actorId}) — client hostile ou membre non distribué`
      );
    }
    let sigOk = false;
    try {
      sigOk = await this.crypto.verify(publicKeyJwk, canonicalize(blob), blob.signature);
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      return this._reject(blob.eventId, "signature", "signature invalide — événement rejeté (client hostile)");
    }

    // 3. decrypt (sautée en mode trusted — décision 11 : le payload voyage déjà en clair)
    let payload;
    if (this.trusted) {
      payload = blob.payload;
    } else {
      const epochKey = this.keyring.get(blob.epoch);
      if (!epochKey) {
        return this._reject(blob.eventId, "decrypt", `epoch ${blob.epoch} inconnue localement`);
      }
      try {
        payload = await this.crypto.decryptPayload(epochKey, blob.ciphertext);
      } catch (err) {
        return this._reject(blob.eventId, "decrypt", `déchiffrement refusé: ${(err && err.message) || err}`);
      }
    }

    // 4. validate schema
    const payloadCheck = validatePayload(blob.entityType, blob.operation, payload, {
      refs: { workspaceId: this.actor.workspaceId },
    });
    if (!payloadCheck.ok) {
      return this._reject(blob.eventId, "schema", payloadCheck.reason);
    }

    // 5. verify membership
    const membership = this.membershipStore.get(this.actor.workspaceId, blob.actorId);
    if (!membership || membership.status === "revoked") {
      return this._reject(
        blob.eventId,
        "membership",
        `membre inconnu ou révoqué (${blob.actorId}) — client hostile`
      );
    }

    // 6. verify policy
    const decision = this.policy.evaluate({
      actorMembership: membership,
      projection: this._projection,
      event: blob,
      payload,
    });
    if (decision !== "accept") {
      return this._reject(blob.eventId, "policy", `refusé par la politique (${decision})`);
    }

    // 7. verify concurrency + apply : délégué à EventLog#replay() (voir décision 4).
    const localEvent = { ...blob, payload };
    delete localEvent.ciphertext;
    const { appended } = this.eventLog.append(localEvent);
    return { rejected: false, appended, eventId: blob.eventId };
  }

  _reject(eventId, stage, reason) {
    const entry = { eventId: eventId || null, stage, reason, at: nowIso() };
    this._rejections.push(entry);
    return { rejected: true, ...entry };
  }

  // -------------------------------------------------------------------------
  // sync() — pull, push, court second passage (CONTRACTS §6).
  // -------------------------------------------------------------------------

  async sync() {
    const firstPull = await this.pull();
    const pushResult = await this.push();
    const secondPull = await this.pull();
    return { firstPull, push: pushResult, secondPull };
  }

  // -------------------------------------------------------------------------
  // Lecture d'état
  // -------------------------------------------------------------------------

  _refreshProjection() {
    this._projection = this.eventLog.replay();
    this._mergeConflictsFromProjection();
  }

  _mergeConflictsFromProjection() {
    for (const c of this._projection.__conflicts || []) {
      if (!this._conflicts.has(c.eventId)) this._conflicts.set(c.eventId, c);
    }
  }

  getProjection() {
    return this._projection;
  }

  getCursor() {
    return this._cursor;
  }

  getConflicts() {
    return Array.from(this._conflicts.values());
  }

  getRejections() {
    return this._rejections.slice();
  }

  /** Statut de publication d'un événement créé PAR CE client ('pending'|'published'|undefined si inconnu). */
  getEventStatus(eventId) {
    return this._pendingStatus.get(eventId);
  }

  /** eventId des événements locaux pas encore confirmés publiés. */
  getPendingEventIds() {
    return Array.from(this._pendingStatus.entries())
      .filter(([, status]) => status === "pending")
      .map(([eventId]) => eventId);
  }
}
