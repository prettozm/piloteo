// tests/next/attack-p5-migration.test.mjs
//
// CONTRARIANT — Point 5 (docs/next/MIGRATION_MODE_CONTRACT.md).
// Repros exécutables qui attaquent la garde de sûreté de la migration
// (snapshotToSeedEvents / verifyRoundTrip / diffSnapshots / planMigration,
// src/integration/migration.js) et l'orchestration de bascule
// (piloteo-migration-bridge.mjs / local-backend.js).
//
// HISTORIQUE (round de correction, gardé pour mémoire — CE FICHIER RESTE UN
// REPRO, il ne doit jamais être supprimé) : un snapshot solo contenant DEUX
// entités DISTINCTES qui partagent la MÊME valeur d'identité (même `id`,
// contenu différent — un doublon réaliste via `importBackupText()`, qui
// n'effectuait AUCUNE déduplication sur un `.piloteobackup` importé) faisait
// taire silencieusement le pipeline de bout en bout :
//  - `snapshotToEventsDiff` (solo-store.js) indexait par `Map.set(String(id), item)` :
//    la 2e entité écrasait la 1re SILENCIEUSEMENT ("dernier gagne"), sans
//    aucune entrée dans `rejected` ;
//  - `verifyRoundTrip` (la garde PURE exigée par le contrat §1) répondait
//    `ok:true` alors qu'une entité entière du snapshot source n'avait JAMAIS
//    été journalisée ;
//  - `diffSnapshots` lui-même était aveugle à l'écart : il indexait LES DEUX
//    côtés (attendu ET réel) par la MÊME clé d'identité, donc le côté
//    "attendu" collapsait exactement comme le côté "réel" avait été tronqué —
//    la comparaison "réussissait" en confrontant deux ensembles déjà amputés
//    du même doublon ;
//  - `org-engine.js#commit` réutilise `snapshotToEventsDiff` TELLE QUELLE :
//    la perte se produisait aussi à l'ÉCRITURE RÉELLE sur un dossier
//    d'organisation, et le rechargement post-commit
//    (`diffSnapshots(soloSnapshot, reloaded.state)`, la garde FINALE de
//    `piloteo-migration-bridge.mjs`) ne la voyait pas non plus ->
//    `piloteo_storage_mode` basculait, une entité solo disparaissait sans
//    aucun message d'erreur.
//
// CORRECTIF (3 points) :
//  1. `snapshotToEventsDiff` (solo-store.js) : AVANT `Map.set`, si l'identité
//     (après coercion `String()`) existe déjà dans `newMap`, l'entité est
//     REJETÉE explicitement (`rejected`, reason "identité dupliquée…"),
//     jamais fusionnée ni écrasée en silence. La PREMIÈRE occurrence du
//     tableau source reste seule candidate (comportement déterministe).
//  2. `diffSnapshots`/`isResumablePartialSeed` (migration.js) : comparent
//     désormais le NOMBRE d'occurrences de chaque identité (avant collapse
//     dans une `Map`) — toute collision (≥2 entités pour la même identité,
//     côté attendu OU côté réel) est un écart en soi, remonté explicitement
//     (`verifyRoundTrip`/`diffSnapshots` échouent -> pas de bascule).
//  3. `importBackupText` (local-backend.js) REFUSE explicitement un
//     `.piloteobackup` contenant des identités dupliquées au sein d'une même
//     collection (message clair, aucune donnée modifiée) plutôt que de
//     laisser la collision s'installer silencieusement dans IndexedDB.
//
// Les scénarios ci-dessous prouvent maintenant le CORRECTIF (fail-before /
// pass-after, cf. rapport du maker) : chaque test qui documentait un trou
// («*** CASSÉ ***») affirme désormais le comportement SÛR attendu.

import "fake-indexeddb/auto";

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  snapshotToSeedEvents,
  verifyRoundTrip,
  diffSnapshots,
  planMigration,
} from "../../src/integration/migration.js";
import { EventLog } from "../../src/events/event-log.js";

import { FolderStorageAdapter } from "../../src/storage/folder-storage-adapter.js";
import { NodeFsPort } from "../../src/storage/node-fs-port.js";
import { newMemberIdentity, createOrganization } from "../../src/workspace/org-runtime.js";
import { writeManifest, writeMemberRecord } from "../../src/workspace/org-folder-store.js";
import { openOrgEngine } from "../../src/workspace/org-engine.js";

const COLLECTIONS = [
  "consultants", "organisations", "affaires", "methodes", "typesTerritoire",
  "domainesIntervention", "categoriesFrais", "missions", "factures",
  "saisies", "bordereauxFrais", "notesFrais",
];

function emptySnapshot() {
  const s = {};
  for (const c of COLLECTIONS) s[c] = [];
  return s;
}

function freshIdentity() {
  return { workspaceId: globalThis.crypto.randomUUID(), actorId: globalThis.crypto.randomUUID(), epoch: 1 };
}

// ---------------------------------------------------------------------------
// 1a. snapshotToSeedEvents : deux entités DISTINCTES partageant le même `id`
//     -> la seconde est REJETÉE explicitement (jamais un "dernier gagne"
//     invisible), la première (déterministe : ordre du tableau source) est
//     journalisée normalement.
// ---------------------------------------------------------------------------

test("ATTACK-P5 1a (CORRIGÉ) : id dupliqué dans le solo -> la 2e entité est `rejected` explicitement, la 1re reste journalisée", () => {
  const solo = {
    ...emptySnapshot(),
    consultants: [
      { id: "c-1", nom: "Alice Dupont", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] },
      // MÊME id "c-1", mais une AUTRE personne, un AUTRE contenu (doublon
      // réaliste : import d'un .piloteobackup forgé/corrompu — cf.
      // local-backend.js#importBackupText, désormais durci au point 3).
      { id: "c-1", nom: "Ève Usurpatrice", trigramme: "EVE", statut: "en poste", admin: false, tempsPartiel: [] },
    ],
  };
  const identity = freshIdentity();

  const { events, rejected } = snapshotToSeedEvents(solo, identity);

  // La collision est signalée EXPLICITEMENT (comme pour une identité
  // manquante ou une clé réservée), jamais une fusion/écrasement silencieux.
  assert.equal(rejected.length, 1, "la 2e entité (même id) est rejetée");
  assert.equal(rejected[0].entityType, "consultants");
  assert.equal(rejected[0].entityId, "c-1");
  assert.match(rejected[0].reason, /identité dupliquée/i);

  // La PREMIÈRE occurrence (Alice) reste seule candidate, journalisée
  // normalement (comportement déterministe, pas de perte "aveugle").
  assert.equal(events.length, 1, "un seul event : la première entité rencontrée (Alice), jamais les deux fusionnées");
  assert.equal(events[0].entityId, "c-1");
  assert.equal(events[0].payload.nom, "Alice Dupont", "c'est bien la PREMIÈRE occurrence du tableau source qui est retenue");
});

// ---------------------------------------------------------------------------
// 1b. LA GARDE DE SÛRETÉ ELLE-MÊME (verifyRoundTrip) refuse désormais le
//     round-trip : même si `rejected` était ignoré par un appelant, la
//     collision est INDÉPENDAMMENT détectée par `diffSnapshots` (défense en
//     profondeur : la source elle-même — `solo` — porte 2 entités pour 1
//     identité, un écart en soi, quel que soit ce qui a été rejoué).
// ---------------------------------------------------------------------------

test("ATTACK-P5 1b (CORRIGÉ) : verifyRoundTrip répond ok:false — la collision d'identité est une garde à elle seule, indépendante de `rejected`", () => {
  const solo = {
    ...emptySnapshot(),
    consultants: [
      { id: "c-1", nom: "Alice Dupont", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] },
      { id: "c-1", nom: "Ève Usurpatrice", trigramme: "EVE", statut: "en poste", admin: false, tempsPartiel: [] },
    ],
  };
  const identity = freshIdentity();
  const { events, rejected } = snapshotToSeedEvents(solo, identity);
  assert.equal(rejected.length, 1, "la garde n°1 (seed) a déjà signalé la collision");

  const result = verifyRoundTrip(solo, events);

  // Preuve indépendante : Ève (rejetée) n'a jamais été journalisée ; Alice
  // (1re occurrence) est la seule survivante du round-trip.
  const rebuilt = new EventLog(events).replay();
  assert.equal(rebuilt.consultants["c-1"].nom, "Alice Dupont", "confirmation : seule la 1re occurrence (Alice) est journalisée, Ève est rejetée sans jamais écraser Alice");

  // Le contrat (§1) dit : « verifyRoundTrip est la garde de sûreté : si !ok,
  // on N'ACTIVE PAS la cible. » Même en ignorant `rejected`, la comparaison
  // au snapshot SOURCE (qui porte encore la collision, 2 entités pour l'id
  // "c-1") doit échouer : `diffSnapshots` signale désormais toute collision
  // d'identité comme un écart en soi (garde n°2, indépendante).
  assert.equal(result.ok, false, "garde n°2 (diffSnapshots) : la collision côté source est un écart en soi, jamais un faux `ok:true`");
  assert.ok(result.diff.some((d) => d.entityType === "consultants" && d.entityId === "c-1" && /identité dupliquée/i.test(d.reason)),
    "le diff explique la collision (pas juste un écart de contenu générique)");
});

// ---------------------------------------------------------------------------
// 1c. diffSnapshots lui-même (la garde POST-COMMIT réutilisée par
//     piloteo-migration-bridge.mjs après rechargement de la cible) détecte
//     désormais la collision, même comparée à une cible "plausible" (un seul
//     consultant, cohérent avec ce qu'un `Map.set` aurait produit).
// ---------------------------------------------------------------------------

test("ATTACK-P5 1c (CORRIGÉ) : diffSnapshots (garde POST-COMMIT) détecte la collision d'identité côté source", () => {
  const solo = {
    ...emptySnapshot(),
    consultants: [
      { id: "c-1", nom: "Alice Dupont", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] },
      { id: "c-1", nom: "Ève Usurpatrice", trigramme: "EVE", statut: "en poste", admin: false, tempsPartiel: [] },
    ],
  };
  // "Cible réellement écrite" : ce qu'un engine (folder/org) produirait après
  // avoir committé `solo` AVANT le correctif (un seul consultant "c-1", cf.
  // ancien comportement "dernier gagne") — c'est ce que
  // `piloteo-migration-bridge.mjs` compare à `soloSnapshot` via
  // `diffSnapshots` AVANT de déclarer `ok:true` (§2 point 4).
  const target = {
    ...emptySnapshot(),
    consultants: [{ id: "c-1", nom: "Ève Usurpatrice", trigramme: "EVE", statut: "en poste", admin: false, tempsPartiel: [] }],
  };

  const diff = diffSnapshots(solo, target);
  assert.ok(diff.length > 0, "la collision d'identité côté source (2 entités pour l'id c-1) est signalée, même face à une cible plausible");
  assert.ok(diff.some((d) => d.entityType === "consultants" && d.entityId === "c-1" && /identité dupliquée côté attendu/i.test(d.reason)));
});

// ---------------------------------------------------------------------------
// 1d. Bout en bout via le VRAI org-engine (comme mode-migration.test.mjs
//     test 6) : au moins une des trois gardes intercepte désormais la
//     collision AVANT toute bascule de `piloteo_storage_mode`.
// ---------------------------------------------------------------------------

test("ATTACK-P5 1d (CORRIGÉ, bout en bout) : org-engine.commit() + les 3 gardes interceptent la collision d'identité avant toute bascule", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-attack-p5-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "attack-p5" });
    await adapter.connect();

    const aliceKeys = await newMemberIdentity();
    const org = createOrganization({ name: "Cabinet Attaqué", identity: aliceKeys, consultantId: "c-1" });
    await writeManifest(adapter, org.manifest);
    await writeMemberRecord(adapter, org.memberRecord);

    const engine = await openOrgEngine({ adapter, identity: aliceKeys, consultantId: "c-1" });

    const soloSnapshot = {
      ...emptySnapshot(),
      consultants: [
        { id: "c-1", nom: "Alice Dupont", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] },
        { id: "c-1", nom: "Ève Usurpatrice", trigramme: "EVE", statut: "en poste", admin: false, tempsPartiel: [] },
      ],
    };

    // Pré-vérification pure (ce que `piloteo-migration-bridge.mjs` fait AVANT
    // toute écriture) : doit déjà intercepter la collision (garde n°1 : seed
    // rejected ; garde n°2 : verifyRoundTrip).
    const identityForSeed = { workspaceId: org.workspace.workspaceId, actorId: aliceKeys.memberId, epoch: 1 };
    const seed = snapshotToSeedEvents(soloSnapshot, identityForSeed);
    const preCheck = verifyRoundTrip(soloSnapshot, seed.events);

    assert.equal(seed.rejected.length, 1, "garde n°1 (seed) : la collision est signalée AVANT toute écriture réelle");
    assert.equal(preCheck.ok, false, "garde n°2 (verifyRoundTrip pur) : refuse aussi, indépendamment");

    // Écriture RÉELLE sur le dossier d'organisation (ce que
    // `engine.commit(soloSnapshot)` fait dans piloteo-migration-bridge.mjs) —
    // exécutée ici pour prouver que la garde n°3 (post-commit) intercepte
    // ÉGALEMENT la collision, en défense en profondeur (même si l'orchestrateur
    // réel s'arrêterait déjà à la garde n°1/n°2 et n'écrirait jamais).
    const commitResult = await engine.commit(soloSnapshot);
    assert.equal(commitResult.applied.rejected.length, 1, "org-engine.commit() rapporte lui aussi la collision (même snapshotToEventsDiff)");

    const reloaded = await engine.load();
    const finalDiff = diffSnapshots(soloSnapshot, reloaded.state);

    // La cible réellement écrite ne contient bien qu'UN consultant (la 1re
    // occurrence, Alice — comportement déterministe du correctif) — MAIS la
    // garde finale, elle, compare toujours au snapshot SOURCE (qui porte
    // encore la collision) et doit donc continuer de refuser.
    assert.equal(reloaded.state.consultants.length, 1);
    assert.equal(reloaded.state.consultants[0].nom, "Alice Dupont");
    assert.ok(finalDiff.length > 0, "garde n°3 (diffSnapshots post-commit) : refuse aussi, en défense en profondeur");

    // Attente bout en bout : les TROIS gardes interceptent — jamais de
    // bascule silencieuse possible, quelle que soit celle qu'un appelant
    // consulterait en premier.
    const allGuardsCaughtIt = seed.rejected.length > 0 && preCheck.ok === false && finalDiff.length > 0;
    assert.equal(allGuardsCaughtIt, true, "les TROIS gardes (seed.rejected, verifyRoundTrip, diffSnapshots post-commit) interceptent la collision — plus jamais une bascule silencieuse");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1e. Même piège via une collision de TYPE (id numérique vs id chaîne) :
//     un import de backup avec un id mal typé (JSON.parse laisse passer des
//     nombres) suffit — désormais intercepté de la même façon.
// ---------------------------------------------------------------------------

test("ATTACK-P5 1e (CORRIGÉ) : collision par coercion String(id) (numéro 1 vs chaîne \"1\") -> interceptée", () => {
  const solo = {
    ...emptySnapshot(),
    consultants: [
      // `id` numérique (jamais produit par l'app normale, mais un backup
      // JSON importé — désormais refusé explicitement par importBackupText,
      // point 3 — pourrait en porter un avant ce refus).
      { id: 1, nom: "Alice Dupont", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] },
      { id: "1", nom: "Ève Usurpatrice", trigramme: "EVE", statut: "en poste", admin: false, tempsPartiel: [] },
    ],
  };
  const identity = freshIdentity();
  const { events, rejected } = snapshotToSeedEvents(solo, identity);
  const result = verifyRoundTrip(solo, events);

  assert.equal(rejected.length, 1, "id=1 (nombre) et id=\"1\" (chaîne) collapsent sur la même clé String() -> collision signalée explicitement");
  assert.match(rejected[0].reason, /identité dupliquée/i);
  assert.equal(result.ok, false, "verifyRoundTrip refuse aussi, indépendamment de `rejected`");
  assert.equal(events.length, 1, "un seul event (la première occurrence, id=1 numérique)");
});

// ---------------------------------------------------------------------------
// Angle 3 (écrasement de cible étrangère) : tenté, TENU — isResumablePartialSeed
// exige un contenu STRICTEMENT identique pour chaque id déjà présent côté
// cible ; une cible = sous-ensemble + UNE entité étrangère bascule bien en
// "target-not-empty" (pas de reprise trompée). Documenté ici comme attaque
// tentée sans repro (voir aussi mode-migration.test.mjs qui couvre déjà le
// cas "contenu divergent, même id").
// ---------------------------------------------------------------------------

test("ATTACK-P5 3 : cible = sous-ensemble cohérent + UNE entité étrangère en plus -> refusée (target-not-empty), PAS une reprise trompée", () => {
  const solo = {
    ...emptySnapshot(),
    consultants: [
      { id: "c-1", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] },
      { id: "c-2", nom: "Bob", trigramme: "BOB", statut: "en poste", admin: false, tempsPartiel: [] },
    ],
  };
  // La cible porte c-1 IDENTIQUE (vraie reprise plausible) MAIS aussi une
  // entité c-999 qui n'existe PAS dans le solo (données d'une autre
  // organisation restées dans le même dossier).
  const target = {
    ...emptySnapshot(),
    consultants: [
      { id: "c-1", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] },
      { id: "c-999", nom: "Quelqu'un d'autre", trigramme: "QDA", statut: "en poste", admin: false, tempsPartiel: [] },
    ],
  };
  const plan = planMigration({ soloSnapshot: solo, targetExisting: target });
  assert.equal(plan.kind, "target-not-empty", "TENU : une seule entité étrangère en trop bloque toute reprise silencieuse");
});

// ---------------------------------------------------------------------------
// Angle 3bis (nouveau, corollaire direct du correctif) : une cible qui porte
// ELLE-MÊME une collision d'identité (dossier déjà corrompu, ou écrit par une
// version antérieure au correctif) ne doit JAMAIS être traitée comme une
// reprise silencieuse valide.
// ---------------------------------------------------------------------------

test("ATTACK-P5 3bis : cible avec une collision d'identité EN INTERNE -> jamais une reprise silencieuse (target-not-empty)", () => {
  const solo = {
    ...emptySnapshot(),
    consultants: [{ id: "c-1", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] }],
  };
  const corruptedTarget = {
    ...emptySnapshot(),
    consultants: [
      { id: "c-1", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] },
      { id: "c-1", nom: "Une autre Alice ?", trigramme: "AL2", statut: "en poste", admin: false, tempsPartiel: [] },
    ],
  };
  const plan = planMigration({ soloSnapshot: solo, targetExisting: corruptedTarget });
  assert.equal(plan.kind, "target-not-empty", "une cible ambiguë (collision interne) n'est jamais traitée comme une reprise cohérente");
});

// ---------------------------------------------------------------------------
// Angle 6 (déterminisme / ordre des clés) : tenté, TENU — même snapshot avec
// les collections énumérées dans un ordre différent (ordre des clés de
// l'objet racine, PAS l'ordre des tableaux) produit la même projection.
// ---------------------------------------------------------------------------

test("ATTACK-P5 6 : ordre des clés du snapshot racine n'affecte pas le résultat (déterminisme)", () => {
  const identity = freshIdentity();
  const a = {
    consultants: [{ id: "c-1", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] }],
    organisations: [], affaires: [], methodes: [], typesTerritoire: [], domainesIntervention: [],
    categoriesFrais: [], missions: [], factures: [], saisies: [], bordereauxFrais: [], notesFrais: [],
  };
  // Mêmes données, clés de l'objet racine réinsérées dans un ordre différent.
  const b = {
    notesFrais: [], bordereauxFrais: [], saisies: [], factures: [], missions: [],
    categoriesFrais: [], domainesIntervention: [], typesTerritoire: [], methodes: [], affaires: [],
    organisations: [],
    consultants: [{ id: "c-1", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] }],
  };
  const evA = snapshotToSeedEvents(a, identity);
  const evB = snapshotToSeedEvents(b, identity);
  assert.equal(evA.events.length, evB.events.length);
  assert.deepEqual(diffSnapshots(a, b), [], "TENU : ordre des clés racine sans effet");
});
