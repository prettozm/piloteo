// src/workspace/org-sync.js
//
// `openOrgSync` — construit un `SyncEngine` en mode `trusted:true` prêt à
// l'emploi pour UN membre, ancré sur la chaîne de confiance publiée sur un
// dossier (`org-folder-store.js#loadTrust`) — docs/next/ORG_FOLDER_CONTRACT.md §3.
//
// Décisions/hypothèses :
//
// 1. AUCUNE des vérifications de confiance n'est dupliquée ici : `loadTrust`
//    (org-folder-store.js -> org-runtime.js#buildTrustedMembership) est la
//    SEULE source du `registry`/`membershipStore` passés au `SyncEngine`. Ce
//    module se contente de vérifier que `identity.memberId` a bien une place
//    dans CE `membershipStore` (membre connu, non révoqué) avant de construire
//    le moteur — un non-membre ou un membre révoqué n'obtient jamais de
//    `SyncEngine`, même en lecture (cohérent avec §3 du contrat : "sinon
//    throw").
//
// 2. `keyring:null` — mode Dossier de confiance (signé, non chiffré) : le
//    `SyncEngine` rend le `keyring` optionnel en `trusted:true` (voir
//    sync-engine.js décision 11 / constructeur). Aucune clé de workspace
//    n'est nécessaire dans ce mode.
//
// 3. `eventLog: new EventLog()` — un journal LOCAL et FRAIS à chaque appel
//    (jamais partagé entre deux `openOrgSync`, même pour le même membre) : un
//    process qui simule plusieurs membres sur le même dossier (tests) doit
//    pouvoir instancier un `SyncEngine` indépendant par membre, chacun avec
//    son propre journal local (cf. sync-engine.js décision 4).

import { EventLog } from "../events/event-log.js";
import * as cryptoService from "../crypto/crypto-service.js";
import * as policy from "../core/permissions.js";
import { SyncEngine } from "../sync/sync-engine.js";
import { loadTrust } from "./org-folder-store.js";

/**
 * Construit un `SyncEngine` trusted prêt à l'emploi pour `identity` sur le
 * dossier `adapter`, ancré sur la chaîne de confiance qui y est publiée.
 * @param {{adapter:import("../storage/storage-adapter.js").StorageAdapter,
 *          identity:{memberId:string, privateKeyRef:*},
 *          consultantId?:string}} params `consultantId` n'est pas utilisé
 *   directement ici (le membership publié porte déjà le sien) — accepté pour
 *   la forme du contrat §3 / usage futur (ex: validation croisée côté 2c-C),
 *   sans effet sur la construction du moteur.
 * @returns {Promise<{engine:SyncEngine, manifest:object, membership:object}>}
 */
export async function openOrgSync({ adapter, identity, consultantId } = {}) {
  if (!adapter) throw new Error("openOrgSync: 'adapter' requis");
  if (!identity || !identity.memberId || !identity.privateKeyRef) {
    throw new Error("openOrgSync: 'identity' invalide ({memberId, privateKeyRef} requis)");
  }

  const { manifest, registry, membershipStore } = await loadTrust(adapter);

  const membership = membershipStore.get(manifest.workspaceId, identity.memberId);
  if (!membership) {
    throw new Error(`openOrgSync: '${identity.memberId}' n'est pas membre de ce workspace (non membre)`);
  }
  if (membership.status === "revoked") {
    throw new Error(`openOrgSync: '${identity.memberId}' est un membre révoqué (aucun accès)`);
  }

  const engine = new SyncEngine({
    adapter,
    eventLog: new EventLog(),
    crypto: cryptoService,
    keyring: null,
    policy,
    memberRegistry: registry,
    membershipStore,
    actor: {
      workspaceId: manifest.workspaceId,
      memberId: identity.memberId,
      privateKeyRef: identity.privateKeyRef,
    },
    trusted: true,
  });

  return { engine, manifest, membership };
}
