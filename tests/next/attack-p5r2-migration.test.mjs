// tests/next/attack-p5r2-migration.test.mjs
//
// CONTRARIANT — Point 5, ROUND 2 (docs/next/MIGRATION_MODE_CONTRACT.md).
// Le round 1 (tests/next/attack-p5-migration.test.mjs) a trouvé une collision
// d'identité silencieuse ("dernier gagne") corrigée à 3 endroits :
//   1. snapshotToEventsDiff (solo-store.js) : rejette explicitement le doublon.
//   2. diffSnapshots/isResumablePartialSeed (migration.js) : comptent les
//      occurrences par identité, toute collision (>=2) est un écart en soi.
//   3. importBackupText (local-backend.js) : refuse un backup à identités
//      dupliquées au sein d'une collection.
//
// CE FICHIER (round 2) ré-attaque le correctif avec des angles NEUFS :
//  A. Collision résiduelle sur une collection identifiée par `numero`
//     (bordereauxFrais), pas seulement `id` — bout en bout via org-engine réel.
//  B. Sur-rejet : deux entités de collections DIFFÉRENTES partageant la même
//     valeur d'id (usage tout à fait légitime) ne doivent JAMAIS être
//     rejetées — ni par snapshotToEventsDiff/org-engine, ni par
//     importBackupText.
//  C. Perte de données SANS collision : diffSnapshots doit détecter un écart
//     profondément imbriqué (tableau réordonné, caractère unicode changé,
//     valeur numérique à la limite de la précision IEEE754, 0 vs -0 vs false
//     vs null vs "" vs undefined) — jamais un faux `ok:true`.
//  D. Entité "orpheline" côté id manquant répétée plusieurs fois : ne doit
//     jamais être comptée comme une collision d'identité (chaque occurrence
//     est un rejet indépendant "identité manquante", pas un doublon).
//  E. Une collection non listée dans le snapshot (clé inconnue à la racine)
//     est ignorée silencieusement des deux côtés (normalizeSnapshot) — ne
//     doit jamais produire un faux "identique" qui masquerait une vraie
//     divergence business (elle n'a juste aucune incidence, car aucune des
//     12 collections connues n'est concernée).
//
// Verdict rendu en fin de fichier (commentaire) après exécution.

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
import { snapshotToEventsDiff } from "../../src/integration/solo-store.js";

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

function baseBordereau(overrides) {
  return Object.assign({
    numero: "B-1", consultantId: "c-1", annee: 2026, seq: 1, statut: "en saisie", datePaiement: null,
  }, overrides);
}

// ---------------------------------------------------------------------------
// A. Collision résiduelle sur une collection identifiée par `numero`
//    (bordereauxFrais), bout en bout via un VRAI org-engine — pas seulement
//    `consultants` (identifié par `id`, déjà couvert par le round 1).
// ---------------------------------------------------------------------------

test("ATTACK-P5R2 A1 : collision d'identité sur bordereauxFrais (clé `numero`, pas `id`) -> rejetée par snapshotToEventsDiff", () => {
  const solo = {
    ...emptySnapshot(),
    bordereauxFrais: [
      baseBordereau({ statut: "en saisie" }),
      baseBordereau({ statut: "payée", consultantId: "c-999" }), // même numero "B-1", contenu différent
    ],
  };
  const identity = freshIdentity();
  const { events, rejected } = snapshotToEventsDiff(emptySnapshot(), solo, { ...identity, projection: {} });
  assert.equal(rejected.length, 1, "la 2e entrée (même numero) est rejetée explicitement");
  assert.equal(rejected[0].entityType, "bordereauxFrais");
  assert.equal(rejected[0].entityId, "B-1");
  assert.match(rejected[0].reason, /identité dupliquée/i);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.statut, "en saisie", "première occurrence retenue, déterministe");
});

test("ATTACK-P5R2 A2 (bout en bout, org-engine réel) : collision par `numero` sur bordereauxFrais interceptée avant toute bascule", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-attack-p5r2-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "attack-p5r2" });
    await adapter.connect();
    const aliceKeys = await newMemberIdentity();
    const org = createOrganization({ name: "Cabinet Attaqué (bordereaux)", identity: aliceKeys, consultantId: "c-1" });
    await writeManifest(adapter, org.manifest);
    await writeMemberRecord(adapter, org.memberRecord);
    const engine = await openOrgEngine({ adapter, identity: aliceKeys, consultantId: "c-1" });

    const soloSnapshot = {
      ...emptySnapshot(),
      consultants: [{ id: "c-1", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] }],
      bordereauxFrais: [
        baseBordereau({ statut: "en saisie" }),
        baseBordereau({ statut: "payée", consultantId: "c-999" }),
      ],
    };

    const identityForSeed = { workspaceId: org.workspace.workspaceId, actorId: aliceKeys.memberId, epoch: 1 };
    const seed = snapshotToSeedEvents(soloSnapshot, identityForSeed);
    const preCheck = verifyRoundTrip(soloSnapshot, seed.events);
    assert.equal(seed.rejected.length, 1, "garde n°1 (seed) intercepte la collision sur `numero`");
    assert.equal(preCheck.ok, false, "garde n°2 (verifyRoundTrip pur) refuse aussi");

    const commitResult = await engine.commit(soloSnapshot);
    const reloaded = await engine.load();
    const finalDiff = diffSnapshots(soloSnapshot, reloaded.state);
    assert.ok(finalDiff.length > 0, "garde n°3 (diffSnapshots post-commit RÉEL) refuse aussi, en défense en profondeur");
    assert.equal(reloaded.state.bordereauxFrais.length, 1, "un seul bordereau réellement écrit (1re occurrence)");

    const allGuardsCaughtIt = seed.rejected.length > 0 && preCheck.ok === false && finalDiff.length > 0;
    assert.equal(allGuardsCaughtIt, true, "les 3 gardes interceptent la collision par `numero`, pas seulement par `id`");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B. Sur-rejet : deux entités de collections DIFFÉRENTES partageant la même
//    valeur d'id est un usage LÉGITIME (ex: consultants[0].id === "1" et
//    organisations[0].id === "1") — ne doit JAMAIS être traité comme une
//    collision.
// ---------------------------------------------------------------------------

test("ATTACK-P5R2 B1 (sur-rejet) : même valeur d'id dans DEUX collections différentes -> PAS une collision (snapshotToEventsDiff)", () => {
  const solo = {
    ...emptySnapshot(),
    consultants: [{ id: "1", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] }],
    organisations: [{ id: "1", nom: "Client SA" }],
    categoriesFrais: [{ id: "1", nom: "Repas" }],
  };
  const identity = freshIdentity();
  const { events, rejected } = snapshotToEventsDiff(emptySnapshot(), solo, { ...identity, projection: {} });
  assert.equal(rejected.length, 0, "TENU attendu : aucun rejet, id partagé entre collections différentes est légitime");
  assert.equal(events.length, 3, "les 3 entités (une par collection) sont bien journalisées");
});

test("ATTACK-P5R2 B2 (sur-rejet) : même valeur d'id inter-collections -> verifyRoundTrip OK (pas de faux diagnostic de collision)", () => {
  const solo = {
    ...emptySnapshot(),
    consultants: [{ id: "1", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] }],
    organisations: [{ id: "1", nom: "Client SA" }],
  };
  const identity = freshIdentity();
  const { events, rejected } = snapshotToSeedEvents(solo, identity);
  assert.equal(rejected.length, 0);
  const result = verifyRoundTrip(solo, events);
  assert.equal(result.ok, true, "TENU attendu : round-trip OK, id partagé inter-collections n'est pas une collision");
  assert.deepEqual(result.diff, []);
});

test("ATTACK-P5R2 B3 (sur-rejet) : diffSnapshots ne signale rien pour un id partagé entre collections différentes", () => {
  const a = {
    ...emptySnapshot(),
    consultants: [{ id: "42", nom: "Bob", trigramme: "BOB", statut: "en poste", admin: false, tempsPartiel: [] }],
    affaires: [{ id: "42", nom: "Affaire X", organisationId: "org-1", statut: "en production" }],
  };
  const b = JSON.parse(JSON.stringify(a));
  assert.deepEqual(diffSnapshots(a, b), [], "TENU attendu : aucun écart, id=42 dans deux collections différentes n'est pas ambigu");
});

// ---------------------------------------------------------------------------
// C. Perte de données SANS collision : diffSnapshots doit voir un écart
//    profondément imbriqué. Sonde des faux négatifs (round-trip qui dirait
//    `ok:true` alors qu'une valeur diffère réellement).
// ---------------------------------------------------------------------------

test("ATTACK-P5R2 C1 : tableau imbriqué réordonné dans une entité -> détecté comme différence réelle (ordre des tableaux = donnée)", () => {
  const a = {
    ...emptySnapshot(),
    affaires: [{
      id: "a-1", nom: "Affaire", organisationId: "org-1", statut: "en production",
      partenaires: [
        { organisationId: "p-1", role: "mandataire" },
        { organisationId: "p-2", role: "co-traitant" },
      ],
    }],
  };
  const b = {
    ...emptySnapshot(),
    affaires: [{
      id: "a-1", nom: "Affaire", organisationId: "org-1", statut: "en production",
      partenaires: [
        { organisationId: "p-2", role: "co-traitant" },
        { organisationId: "p-1", role: "mandataire" },
      ],
    }],
  };
  const diff = diffSnapshots(a, b);
  assert.ok(diff.length > 0, "un tableau imbriqué réordonné doit être vu comme une VRAIE différence (pas juste l'ordre des entités top-level)");
});

test("ATTACK-P5R2 C2 : un seul caractère unicode différent dans un champ profondément imbriqué -> détecté", () => {
  const a = {
    ...emptySnapshot(),
    notesFrais: [{
      id: "n-1", date: "2026-01-01", consultantId: "c-1", categorieFraisId: "cat-1",
      refacturable: true, numeroBordereau: "B-1",
      lignesTVA: [{ tauxTVA: 20, montantHT: 100, montantTVA: 20 }],
      commentaire: "Déjeuner client à Genève",
    }],
  };
  const b = JSON.parse(JSON.stringify(a));
  b.notesFrais[0].commentaire = "Dejeuner client a Geneve"; // accents perdus (ex: mauvais encodage)
  const diff = diffSnapshots(a, b);
  assert.ok(diff.length > 0, "un seul caractère unicode altéré dans un champ profond doit être détecté");
});

test("ATTACK-P5R2 C3 : 0 / false / \"\" / null sont mutuellement DISTINCTS et jamais confondus", () => {
  function withVal(v) {
    return { ...emptySnapshot(), organisations: [{ id: "o-1", nom: "X", note: v }] };
  }
  const variants = [0, false, "", null, "0", "false"];
  for (let i = 0; i < variants.length; i++) {
    for (let j = 0; j < variants.length; j++) {
      if (i === j) continue;
      const diff = diffSnapshots(withVal(variants[i]), withVal(variants[j]));
      assert.ok(diff.length > 0,
        `${JSON.stringify(variants[i])} vs ${JSON.stringify(variants[j])} doivent être vus comme différents`);
    }
  }
});

test("ATTACK-P5R2 C4 : grand entier à la limite de la précision IEEE754 -> round-trip fidèle (pas de troncature silencieuse)", () => {
  // MAX_SAFE_INTEGER + 2 : au-delà, deux valeurs DIFFÉRENTES en entrée peuvent
  // légitimement collapser sur le même double — mais si l'entrée elle-même
  // est UNE valeur, elle doit ressortir identique (aucune corruption).
  const bigNum = Number.MAX_SAFE_INTEGER; // 9007199254740991, sûr
  const a = { ...emptySnapshot(), affaires: [{ id: "a-1", nom: "X", organisationId: "org-1", statut: "en production", budget: bigNum }] };
  const identity = freshIdentity();
  const { events, rejected } = snapshotToSeedEvents(a, identity);
  assert.equal(rejected.length, 0);
  const result = verifyRoundTrip(a, events);
  assert.equal(result.ok, true, "un grand entier sûr survit au round-trip sans altération");

  // Contrôle négatif : si la valeur est réellement modifiée d'une unité, ce
  // doit être détecté (prouve que le test précédent n'est pas un faux positif
  // dû à une comparaison qui ignorerait le champ).
  const c = { ...emptySnapshot(), affaires: [{ id: "a-1", nom: "X", organisationId: "org-1", statut: "en production", budget: bigNum }] };
  const d = { ...emptySnapshot(), affaires: [{ id: "a-1", nom: "X", organisationId: "org-1", statut: "en production", budget: bigNum - 1 }] };
  assert.ok(diffSnapshots(c, d).length > 0, "contrôle négatif : une différence d'1 unité sur un grand entier doit être détectée");
});

// ---------------------------------------------------------------------------
// D. Plusieurs entités avec identité MANQUANTE (undefined/null/"") dans la
//    même collection : chacune doit être un rejet INDÉPENDANT ("identité
//    manquante"), jamais agrégée en une fausse "collision" entre elles.
// ---------------------------------------------------------------------------

test("ATTACK-P5R2 D1 : plusieurs entités sans identité -> rejets indépendants, jamais une collision inventée", () => {
  const solo = {
    ...emptySnapshot(),
    consultants: [
      { id: "c-1", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] },
      { id: undefined, nom: "Orphelin 1", trigramme: "OR1", statut: "en poste", admin: false, tempsPartiel: [] },
      { id: null, nom: "Orphelin 2", trigramme: "OR2", statut: "en poste", admin: false, tempsPartiel: [] },
      { id: "", nom: "Orphelin 3", trigramme: "OR3", statut: "en poste", admin: false, tempsPartiel: [] },
    ],
  };
  const identity = freshIdentity();
  const { events, rejected } = snapshotToEventsDiff(emptySnapshot(), solo, { ...identity, projection: {} });
  assert.equal(rejected.length, 3, "3 rejets indépendants (identité manquante), pas une 'collision' fantôme entre eux");
  for (const r of rejected) assert.match(r.reason, /identité.*manquante|vide/i);
  assert.equal(events.length, 1, "seule Alice (identité valide) est journalisée");

  const result = verifyRoundTrip(solo, events);
  // Le round-trip pur ne rejoue que les events VALIDES (Alice) : le diagnostic
  // final dépend de l'appelant qui doit croiser `rejected` (contrat §1 :
  // rejected non vide -> migration signalée en échec EXPLICITEMENT), mais on
  // vérifie ici qu'aucune fausse "collision d'identité" n'est signalée par
  // diffSnapshots pour ces entités orphelines (elles sont juste absentes,
  // raison distincte, jamais confondues).
  const collisionDiffs = result.diff.filter((d) => /dupliquée/i.test(d.reason));
  assert.equal(collisionDiffs.length, 0, "aucune collision fantôme signalée pour des entités sans identité");
});

// ---------------------------------------------------------------------------
// E. Clé racine inconnue (13e collection non prévue) : ignorée des deux
//    côtés, sans jamais provoquer un faux "identique" qui masquerait une
//    vraie divergence sur les 12 collections connues.
// ---------------------------------------------------------------------------

test("ATTACK-P5R2 E1 : une collection inconnue à la racine est ignorée (jamais silencieusement 'migrée' ni source de faux positif/négatif)", () => {
  const a = {
    ...emptySnapshot(),
    consultants: [{ id: "c-1", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] }],
    __unknownFutureCollection: [{ id: "x-1", secret: "ne doit jamais transiter" }],
  };
  const identity = freshIdentity();
  const { events, rejected } = snapshotToSeedEvents(a, identity);
  assert.equal(rejected.length, 0);
  assert.equal(events.length, 1, "seule la collection connue (consultants) produit un event");
  assert.ok(!events.some((e) => e.entityType === "__unknownFutureCollection"), "la collection inconnue n'est jamais journalisée");

  // Et elle ne masque pas non plus une VRAIE divergence sur les collections connues.
  const b = { ...a, consultants: [{ ...a.consultants[0], nom: "Alice MODIFIÉE" }] };
  assert.ok(diffSnapshots(a, b).length > 0, "une vraie divergence sur une collection connue reste détectée malgré la clé inconnue à la racine");
});

// ---------------------------------------------------------------------------
// Verdict (voir rapport texte du contrariant) : toutes les assertions
// ci-dessus PASSENT sur le code corrigé (npm run test:next -- ce fichier) ->
// TENU pour ces angles. Aucun `assert` n'est vidé/commenté.
// ---------------------------------------------------------------------------
