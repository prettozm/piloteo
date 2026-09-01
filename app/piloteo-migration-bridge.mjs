// piloteo-migration-bridge.mjs — pont navigateur du Point 5
// (docs/next/MIGRATION_MODE_CONTRACT.md) : orchestration DE LA MIGRATION
// solo -> cible (Dossier/Organisation/Google Drive) à la bascule de mode,
// au-dessus du module PUR `src/integration/migration.js`. Symétrique aux
// autres ponts (`piloteo-solo-bridge.mjs`, `piloteo-org-bridge.mjs`) : le seul
// point de contact avec `local-backend.js` (script classique) est
// `window.PiloteoMigration`.
//
// Décisions/hypothèses :
// - AUCUNE primitive canonique n'est réécrite : ce module importe uniquement
//   `src/integration/migration.js` (pur : `planMigration`, `snapshotToSeedEvents`,
//   `verifyRoundTrip`, `diffSnapshots`). L'écriture RÉELLE dans la cible passe
//   TOUJOURS par `engine.commit(nextState)` — l'engine déjà construit par
//   `piloteo-solo-bridge.mjs`/`piloteo-org-bridge.mjs`/`piloteo-drive-bridge.mjs`
//   (folder/org/drive), jamais reconstruit ici : c'est lui qui sait écrire
//   write-once et, pour l'org, signer (cf. org-engine.js#commit). Ce module
//   n'orchestre que la SÉQUENCE (plan -> pré-vérification pure -> écriture ->
//   vérification finale), engine-agnostique (n'importe quel `{load, commit}`).
// - `migrateSoloIntoEngine` ne déclenche AUCUNE sauvegarde (`.piloteobackup`) :
//   ça reste la responsabilité de l'appelant (`local-backend.js`, qui a déjà
//   `exportBackup()`), cf. contrat §2 point 1 ("déclencher... AVANT toute
//   écriture dans la cible") — ce pont n'a pas accès à cette fonction (elle vit
//   dans le script classique local-backend.js, pas dans le monde des modules).
// - Garde de sûreté FINALE (contrat §2 point 4, §1) : APRÈS `engine.commit()`,
//   on RECHARGE la cible (`engine.load()`) et on compare sa projection RÉELLE
//   au snapshot solo source via `diffSnapshots` (même normalisation que
//   `verifyRoundTrip`, cf. migration.js décision 2) — pas seulement le retour
//   de `commit()` lui-même, qui pourrait masquer un écart si l'engine ne
//   remontait pas fidèlement ses conflits. Un écart => `ok:false`, jamais de
//   bascule (l'appelant ne doit alors ni activer l'engine, ni écrire
//   `piloteo_storage_mode`).
// - `conflicts` retournés par `engine.commit()` (permission/concurrence — org)
//   sont TOUJOURS traités comme un échec de migration, même si `commitResult.ok`
//   vaut `true` par ailleurs (le wrapper `{load,commit}` de
//   piloteo-solo-bridge.mjs/piloteo-drive-bridge.mjs renvoie `ok:true` même en
//   cas de conflits mineurs — cf. leur en-tête ; ne jamais s'y fier seul).
// - Idempotence (contrat §2 point 3/6) : `engine.commit(soloSnapshot)` réutilise
//   le diff `snapshotToEventsDiff` de chaque engine (solo-store.js/org-engine.js) —
//   rejouer cette fonction avec le MÊME `soloSnapshot` sur une cible déjà seedée
//   ne produit aucun nouvel événement (diff nul) ; sur une cible partiellement
//   écrite (migration interrompue), les backends sont write-once par eventId :
//   aucune duplication. Ce module n'a donc rien de plus à faire pour la reprise
//   que rappeler la même séquence.

import {
  planMigration,
  snapshotToSeedEvents,
  verifyRoundTrip,
  diffSnapshots,
} from "./src/integration/migration.js";

function ephemeralIdentity() {
  const c = globalThis.crypto;
  return { workspaceId: c.randomUUID(), actorId: c.randomUUID(), epoch: 1 };
}

/**
 * Orchestration complète (contrat §2 points 2-4) : migre `soloSnapshot` vers
 * `engine` (n'importe quel `{load, commit}` déjà ouvert sur une cible),
 * SEULEMENT si la cible est vide, avec vérification de round-trip AVANT tout
 * succès déclaré. N'écrit JAMAIS si la cible contient déjà des données
 * (`"target-not-empty"`) ni si le snapshot solo est vide
 * (`"nothing-to-migrate"`, rien à faire).
 *
 * @param {{soloSnapshot:object, engine:{load:Function, commit:Function}}} params
 * @returns {Promise<{kind:"nothing-to-migrate"|"target-not-empty"|"seed", ok:boolean,
 *   counts:object, error?:string, rejected?:Array, diff?:Array, conflicts?:Array,
 *   revision?:number, state?:object}>}
 */
async function migrateSoloIntoEngine({ soloSnapshot, engine } = {}) {
  if (!engine || typeof engine.load !== "function" || typeof engine.commit !== "function") {
    throw new Error("migrateSoloIntoEngine: 'engine' invalide ({load,commit} attendu).");
  }

  const loaded = await engine.load();
  const plan = planMigration({ soloSnapshot, targetExisting: loaded.state });

  if (plan.kind === "nothing-to-migrate") {
    return { kind: plan.kind, ok: true, counts: plan.counts };
  }
  if (plan.kind === "target-not-empty") {
    return {
      kind: plan.kind,
      ok: false,
      counts: plan.counts,
      error: "La cible contient déjà des données Pilotéo : migration refusée pour ne rien écraser ni fusionner à l'aveugle.",
    };
  }

  // plan.kind === "seed" — identité EPHEMÈRE, utilisée UNIQUEMENT pour la
  // pré-vérification pure ci-dessous (aucune E/S) : l'écriture réelle passe
  // par `engine.commit()`, qui calcule sa PROPRE lignée/epoch (et signe, pour
  // l'org) sur sa propre identité (cf. org-engine.js décision 2).
  const identity = ephemeralIdentity();
  const { events: seedEvents, rejected } = snapshotToSeedEvents(soloSnapshot, identity);
  if (rejected.length > 0) {
    return {
      kind: "seed",
      ok: false,
      counts: plan.counts,
      rejected,
      error: `Migration annulée : ${rejected.length} entité(s) de l'état de cet appareil sont invalides (jamais migrées partiellement).`,
    };
  }
  const preCheck = verifyRoundTrip(soloSnapshot, seedEvents);
  if (!preCheck.ok) {
    return {
      kind: "seed",
      ok: false,
      counts: plan.counts,
      diff: preCheck.diff,
      error: "Migration annulée avant toute écriture : le jeu d'événements calculé ne se rejoue pas fidèlement (pré-vérification).",
    };
  }

  // Écriture réelle (idempotente, cf. en-tête) via l'engine cible existant.
  const commitResult = await engine.commit(soloSnapshot);
  if (commitResult && commitResult.conflicts && commitResult.conflicts.length > 0) {
    return {
      kind: "seed",
      ok: false,
      counts: plan.counts,
      conflicts: commitResult.conflicts,
      error: "Migration annulée : la cible a rejeté une partie des données (permissions ou concurrence).",
    };
  }

  // Garde de sûreté FINALE (contrat §1/§2 point 4) : la projection RÉELLEMENT
  // rechargée de la cible doit être identique au snapshot solo source.
  const reloaded = await engine.load();
  let diff;
  if (window.__PiloteoMigrationForcedFailure) {
    // Hook de TEST (contrat §4 scénario 9) : simule un échec de la garde de
    // sûreté finale sans avoir à provoquer un vrai bug de réplication —
    // auto-désarmé après CE SEUL appel (jamais un état persistant qui
    // fausserait un test suivant).
    delete window.__PiloteoMigrationForcedFailure;
    diff = [{ entityType: "__test__", entityId: "forced-failure", reason: "échec simulé (__forceNextVerificationFailure)" }];
  } else {
    diff = diffSnapshots(soloSnapshot, reloaded.state);
  }
  if (diff.length > 0) {
    return {
      kind: "seed",
      ok: false,
      counts: plan.counts,
      diff,
      error: "Vérification finale échouée : la cible ne correspond pas exactement à vos données. Rien n'a été basculé, vos données de cet appareil sont intactes.",
    };
  }

  return { kind: "seed", ok: true, counts: plan.counts, revision: reloaded.revision, state: reloaded.state };
}

window.PiloteoMigration = {
  migrateSoloIntoEngine,
  // Ré-exports purs (tests avancés / introspection), symétrique des autres ponts.
  planMigration,
  snapshotToSeedEvents,
  verifyRoundTrip,
  diffSnapshots,
  // Hook de TEST (contrat §4, scénario 9) : arme un échec FORCÉ de la garde de
  // sûreté finale pour le PROCHAIN appel de `migrateSoloIntoEngine` uniquement
  // (auto-désarmé après usage, voir ci-dessus) — permet de prouver, dans un
  // vrai navigateur, qu'un round-trip en échec n'entraîne JAMAIS de bascule de
  // mode ni de perte des données solo, sans dépendre d'un vrai bug de
  // réplication (impossible à provoquer autrement de façon déterministe).
  __forceNextVerificationFailure: function () {
    window.__PiloteoMigrationForcedFailure = true;
  },
  __disarmForcedVerificationFailure: function () {
    delete window.__PiloteoMigrationForcedFailure;
  },
};
