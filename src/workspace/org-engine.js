// src/workspace/org-engine.js
//
// Pont org-engine (docs/next/ORG_ENGINE_CONTRACT.md, lot 2c-C1) : enveloppe
// `openOrgSync` (2c-B) dans un « engine » `{manifest, membership, load, commit,
// members}` compatible avec le contrat `/api/state` de l'app — exactement ce
// que `solo-store.js#createSoloStore` fait déjà pour le dossier solo, mais
// pour le SyncEngine multi-membre trusted. Aucune UI, aucun câblage
// local-backend ici (lot 2c-C2).
//
// Décisions/hypothèses :
//
// 1. AUCUNE primitive canonique n'est réécrite : `openOrgSync` (org-sync.js,
//    2c-B) construit le `SyncEngine` trusted déjà ancré sur la chaîne de
//    confiance du dossier ; `snapshotToEventsDiff`/`projectionToSnapshot`
//    (solo-store.js) font TOUT le travail de diff/reconstruction snapshot ⇄
//    événements. Ce module ne fait qu'orchestrer ces deux briques, comme
//    `createSoloStore` orchestre `EventLog`/`buildEvent` pour le solo.
//
// 2. `commit(nextState)` n'utilise QUE les champs `{entityType, entityId,
//    operation, payload}` de chaque événement produit par `snapshotToEventsDiff`
//    — jamais l'enveloppe brute (qui porte un `baseVersion`/`parentEventId`
//    calculés par le diff à partir de SA PROPRE lecture de la projection,
//    potentiellement périmée d'un cycle pull/push à l'autre). C'est
//    `engine.createLocalEvent(...)` qui reconstruit l'enveloppe désormais
//    posée sur la lignée ACTUELLE du `SyncEngine` (son propre `_projection`,
//    rafraîchie par le `pull()` qui précède), avec la bonne `epoch` (mode
//    trusted, cf. sync-engine.js décision 11) — et c'est lui qui la signera
//    au `push()`. Les entités rejetées PAR LE DIFF LUI-MÊME (identité
//    absente/vide, clé réservée — jamais une question de permission) sont
//    reportées telles quelles dans `applied.rejected`.
//
// 3. DÉTECTION D'ÉCHEC DE PERMISSION/CONFLIT (cœur de ce lot, cf. contrat §1
//    « PERMISSION ») — comment ça marche concrètement, à partir du
//    comportement RÉEL de `SyncEngine` (déjà committé, non modifié ici) :
//      - `engine.createLocalEvent(...)` est un écrit LOCAL-FIRST : il ajoute
//        l'événement au journal LOCAL de ce membre (`eventLog.append`) SANS
//        jamais vérifier la policy (`recordLocalEvent` ne fait qu'un
//        `isWellFormedEnvelope` + vérif d'acteur — voir sync-engine.js). La
//        policy n'est appliquée QUE par `_processIncoming`, le pipeline des
//        événements REÇUS (`pull()`), jamais pour un événement qu'on vient de
//        créer soi-même. Un `commit()` qui s'arrêterait après `push()` sans
//        repull verrait donc TOUJOURS sa propre projection locale à jour,
//        même pour un événement qu'aucun autre membre n'acceptera jamais —
//        un faux succès silencieux (la leçon du point 1b, rappelée par le
//        contrat).
//      - Le `pull()` FINAL de `commit()` (après `push()`) est la clé : les
//        événements qu'on vient de publier soi-même via `push()` sont écrits
//        sur le dossier (`adapter.putImmutable`) mais n'ont JAMAIS transité
//        par le pipeline `pull()`/`_processIncoming` de CE `SyncEngine` — ils
//        ne sont donc PAS dans son `_seen`. Le `pull()` suivant les
//        redécouvre via `adapter.listChanges()` comme n'importe quel
//        événement « distant » et les fait passer par `_processIncoming`,
//        qui réévalue signature/membership/POLICY EXACTEMENT COMME POUR UN
//        AUTRE MEMBRE (la policy ne fait aucune exception pour « c'est moi »).
//        Deux issues possibles pour un événement qu'on a créé :
//          a) la policy REFUSE (ex: `user` sur une collection ADMIN_ONLY) ->
//             `_processIncoming` le rejette AVANT l'étape d'application,
//             `stage:"policy"`, consigné dans `pull().rejections` (ET dans
//             `engine.getRejections()`). L'événement reste néanmoins dans
//             l'`eventLog` local (il y avait été ajouté en LOCAL-FIRST avant
//             ce repull) : SA PROPRE projection locale continuerait de le
//             montrer si on ne consultait que `getProjection()` — d'où la
//             nécessité de croiser `pull().rejections` par `eventId`, jamais
//             de se fier à la seule projection locale post-commit pour
//             juger du succès.
//          b) la policy ACCEPTE mais l'entité a été modifiée entre-temps par
//             un AUTRE membre (vraie concurrence, `baseVersion` périmé) ->
//             `EventLog#replay()` (invoqué par `_refreshProjection`) classe
//             l'événement en `conflict` (`projection.__conflicts`), jamais
//             appliqué, jamais un écrasement silencieux — remonté par
//             `engine.getConflicts()`.
//        `commit()` compare donc l'ensemble des `eventId` qu'IL a créés
//        (retour de chaque `createLocalEvent`) à :
//          - `pull().rejections` (issue a, stage `"policy"` ou toute autre
//            étape — un membre tout juste révoqué produirait `"membership"`),
//          - `engine.getConflicts()` (issue b, concurrence).
//        Tout `eventId` créé localement qui apparaît dans l'un des deux est
//        un ÉCART entre ce que l'appelant croit avoir commité et ce qui a
//        RÉELLEMENT été accepté par la chaîne de confiance du dossier — il
//        est reporté dans `conflicts` (jamais un succès silencieux) et fait
//        basculer `ok` à `false`, pour que 2c-C2 puisse renvoyer un 409/403
//        à l'app plutôt qu'un faux 200.
//      - Note : ceci ne détecte QUE les échecs visibles via LE DOSSIER
//        PARTAGÉ (le membre publie, se relit lui-même). Un `push()` qui
//        échouerait réseau (`stillPending` non vide) laisse l'événement
//        `pending` — non couvert ici (hors périmètre §1 de ce lot, le
//        dossier local des tests est toujours disponible).
//
// 4. `load()` : `pull()` PUIS projection -> snapshot, exactement comme
//    demandé par le contrat. `revision = engine.eventLog.size()` (nombre
//    d'événements DISTINCTS connus localement après convergence — monotone
//    par construction de `EventLog`, jamais décroissant).
//
// 5. `members()` : le contrat suggère `org-folder-store.js#loadTrust(adapter)`
//    SI `openOrgSync` n'expose pas le `membershipStore`. Il l'expose en
//    réalité, comme propriété PUBLIQUE du `SyncEngine` qu'il construit
//    (`engine.membershipStore`, posée par le constructeur `SyncEngine` —
//    sync-engine.js, jamais réécrite ici) : c'est EXACTEMENT le même
//    `membershipStore` DÉJÀ vérifié par `buildTrustedMembership` (via
//    `loadTrust`, appelé une seule fois par `openOrgSync`) que celui que ce
//    `SyncEngine` utilise pour ses propres décisions de policy — la même
//    source de vérité, pas une seconde reconstruction indépendante qui
//    pourrait diverger. On réutilise donc `engine.membershipStore.list(...)`
//    plutôt que de rappeler `loadTrust` (qui referait tout le travail de
//    vérification de la chaîne de confiance en double). Cette liste reflète
//    l'état de la gouvernance AU MOMENT DE `openOrgEngine` (comme le reste de
//    l'`engine`) : un appelant qui veut voir une révocation toute fraîche
//    doit rouvrir un `openOrgEngine` (même comportement que pour
//    `openOrgSync`/rechargement d'`engine`, cf. tests/next/org-folder.test.mjs
//    scénario 6, "Alice recharge sa session sync").
//
// 6. `commit` retourne, EN PLUS de la forme minimale du contrat (`ok`,
//    `revision`, `state`, `changes`, `conflicts`), un champ `applied:{count,
//    rejected}` (déviation additive, même convention que
//    `solo-store.js#commit`) : `count` = nombre d'événements RÉELLEMENT créés
//    (utile pour l'idempotence — 0 pour un `nextState` identique, scénario 6
//    du contrat) et `rejected` = les entités rejetées PAR LE DIFF lui-même
//    (décision 2), distinctes de `conflicts` (rejets de PERMISSION/concurrence
//    après publication, décision 3).

import { openOrgSync } from "./org-sync.js";
import { snapshotToEventsDiff, projectionToSnapshot } from "../integration/solo-store.js";

/**
 * @param {{adapter:import("../storage/storage-adapter.js").StorageAdapter,
 *          identity:{memberId:string, privateKeyRef:*}, consultantId?:string}} params
 * @returns {Promise<{manifest:object, membership:object,
 *   load: () => Promise<{revision:number, state:object, conflicts:Array<object>}>,
 *   commit: (nextState:object) => Promise<{ok:boolean, revision:number, state:object,
 *     changes:object, conflicts:Array<object>, applied:{count:number, rejected:Array<object>}}>,
 *   members: () => Promise<Array<{memberId:string, consultantId:string, role:string, status:string}>>}>}
 */
export async function openOrgEngine({ adapter, identity, consultantId } = {}) {
  const { engine, manifest, membership } = await openOrgSync({ adapter, identity, consultantId });

  // §1.2 du contrat : connexion best-effort de l'adapter (idempotent, voir
  // FolderStorageAdapter#connect) PUIS pull initial pour partir d'un état à
  // jour dès l'ouverture (un appelant qui ferait `members()`/`load()` avant
  // tout `commit()` voit déjà la gouvernance/les données publiées par
  // d'autres membres).
  if (typeof engine.connect === "function") {
    await engine.connect();
  }
  await engine.pull();

  function currentRevision() {
    return engine.eventLog.size();
  }

  async function load() {
    await engine.pull();
    const projection = engine.getProjection();
    return {
      revision: currentRevision(),
      state: projectionToSnapshot(projection),
      conflicts: engine.getConflicts(),
    };
  }

  async function commit(nextState) {
    // 1. Base fraîche (le contrat exige un pull avant de diffé).
    await engine.pull();
    const baseProjection = engine.getProjection();
    const currentSnapshot = projectionToSnapshot(baseProjection);

    // 2. Diff snapshot -> opérations. On ne réutilise JAMAIS l'enveloppe
    //    brute (décision 2) : seulement {entityType, entityId, operation,
    //    payload} de chaque event, passés à `engine.createLocalEvent`, qui
    //    recalcule lui-même baseVersion/parentEventId/epoch sur SA propre
    //    lignée (`this._projection`), pas celle, potentiellement périmée,
    //    lue par `snapshotToEventsDiff` un instant plus tôt.
    const { events: diffEvents, rejected } = snapshotToEventsDiff(currentSnapshot, nextState, {
      workspaceId: manifest.workspaceId,
      actorId: identity.memberId,
      epoch: 1,
      projection: baseProjection,
    });

    const created = [];
    for (const ev of diffEvents) {
      const event = engine.createLocalEvent({
        entityType: ev.entityType,
        entityId: ev.entityId,
        operation: ev.operation,
        payload: ev.payload,
      });
      created.push(event);
    }

    // 3. Publie (signe + écrit sur le dossier).
    await engine.push();

    // 4. Repull : redécouvre nos PROPRES événements comme le ferait n'importe
    //    quel autre membre (décision 3) — seul moyen fiable de savoir si la
    //    policy/la concurrence les a réellement acceptés.
    const finalPull = await engine.pull();
    const finalProjection = engine.getProjection();

    // 5. Détection d'écart (décision 3) : tout eventId qu'ON a créé, mais qui
    //    revient soit en rejet (policy/membership/...) soit en conflit de
    //    concurrence, est un échec à ne jamais faire passer pour un succès.
    const createdIds = new Set(created.map((e) => e.eventId));
    const createdById = new Map(created.map((e) => [e.eventId, e]));

    const ownRejections = finalPull.rejections
      .filter((r) => r.eventId && createdIds.has(r.eventId))
      .map((r) => {
        const src = createdById.get(r.eventId);
        return {
          eventId: r.eventId,
          entityType: src?.entityType ?? null,
          entityId: src?.entityId ?? null,
          stage: r.stage,
          reason: r.reason,
        };
      });

    const ownConcurrencyConflicts = engine
      .getConflicts()
      .filter((c) => createdIds.has(c.eventId))
      .map((c) => ({ ...c, stage: "conflict" }));

    const conflicts = [...ownRejections, ...ownConcurrencyConflicts];

    return {
      ok: conflicts.length === 0,
      revision: currentRevision(),
      state: projectionToSnapshot(finalProjection),
      changes: {},
      conflicts,
      applied: { count: created.length, rejected },
    };
  }

  async function members() {
    const list = engine.membershipStore.list(manifest.workspaceId);
    return list.map((m) => ({
      memberId: m.memberId,
      consultantId: m.consultantId,
      role: m.role,
      status: m.status,
    }));
  }

  return { manifest, membership, load, commit, members };
}
