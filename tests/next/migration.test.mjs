// tests/next/migration.test.mjs
//
// Tests de l'import V1 -> Next (src/migration/v1-import.js) — docs/next/07 §12.
// Fabrique un petit `state` V1 de démonstration couvrant plusieurs
// collections (dont `bordereauxFrais`, identifié par `numero`), importe,
// et vérifie l'équivalence via `compareCollections`.

import test from "node:test";
import assert from "node:assert/strict";

import { importV1, compareCollections, V1_EXPORT_FORMAT } from "../../src/migration/v1-import.js";

const WORKSPACE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ACTOR_ID = "bbbbbbbb-2222-4222-8222-222222222222";

function makeV1State() {
  return {
    consultants: [
      {
        id: "c1",
        nom: "Alice Dupont",
        trigramme: "ADU",
        statut: "en poste",
        dateEmbauche: "2020-01-15",
        dateDepart: null,
        tjmBase: 650,
        admin: true,
        tempsPartiel: [],
      },
      {
        id: "c2",
        nom: "Bob Martin",
        trigramme: "BMA",
        statut: "en poste",
        dateEmbauche: "2021-06-01",
        dateDepart: null,
        tjmBase: 500,
        admin: false,
        tempsPartiel: [],
      },
    ],
    organisations: [
      { id: "O-1", nom: "ACME Corp", type: "client", adresse: "1 rue de Paris" },
    ],
    affaires: [
      {
        id: "A-1",
        nom: "Migration Next",
        organisationId: "O-1",
        nomAbrege: "MIGN",
        motsCles: "local-first",
        pilote: "c1",
        piloteCommercial: "c1",
        typeVente: "forfait",
        pctReussite: 80,
        dateDepot: "2026-01-01",
        statut: "en production",
        budget: 100000,
        jours: 120,
        frais: 2000,
        dateDebut: "2026-02-01",
        dateFin: "2026-12-31",
        methodes: ["m1"],
        territoires: ["t1"],
        domaines: ["d1"],
        partenaires: [],
        repartitionCommerciale: [{ consultantId: "c1", pct: 100 }],
      },
    ],
    methodes: [{ id: "m1", label: "Agile" }],
    typesTerritoire: [{ id: "t1", label: "France" }],
    domainesIntervention: [{ id: "d1", label: "Data" }],
    categoriesFrais: [{ id: "cf1", categorie: "transport", label: "Transport" }],
    missions: [
      {
        id: "M-1",
        affaireId: "A-1",
        nom: "Dev backend",
        consultantId: "c1",
        statut: "en cours",
        enveloppe: 60,
        taux: 700,
        dateDebut: "2026-02-01",
        dateFin: "2026-12-31",
        commentaires: "",
        projectionManuelle: { "2026-02": 10 },
      },
    ],
    factures: [
      {
        id: "F-1",
        affaireId: "A-1",
        numero: "FA-2026-001",
        formation: false,
        montantMissionHT: 42000,
        montantSousTraitanceHT: 0,
        montantFraisTTC: 500,
        echeancePrev: "2026-03-01",
        dateDepot: null,
        echeancePaiementPrev: "2026-04-01",
        datePaiement: null,
        payee: false,
        statut: "envoyée",
        commentaires: "",
      },
    ],
    saisies: [
      {
        id: "S-1",
        date: "2026-02-10",
        consultantId: "c1",
        type: "mission",
        missionId: "M-1",
        categorie: null,
        dureeH: 7,
        pctFact: 100,
        commentaire: "",
      },
      {
        id: "S-2",
        date: "2026-02-11",
        consultantId: "c2",
        type: "interne",
        missionId: null,
        categorie: "formation",
        dureeH: 3.5,
        pctFact: 0,
        commentaire: "Formation interne",
      },
    ],
    bordereauxFrais: [
      { numero: "FRAIS_ADU_2026_001", consultantId: "c1", annee: 2026, seq: 1, statut: "en saisie", datePaiement: null },
      { numero: "FRAIS_BMA_2026_001", consultantId: "c2", annee: 2026, seq: 1, statut: "payée", datePaiement: "2026-03-01" },
    ],
    notesFrais: [
      {
        id: "NF-1",
        date: "2026-02-10",
        consultantId: "c1",
        affaireId: "A-1",
        categorieTempsInterne: null,
        categorieFraisId: "cf1",
        refacturable: true,
        numeroBordereau: "FRAIS_ADU_2026_001",
        lignesTVA: [{ tauxTVA: 20, montantHT: 100, montantTVA: 20 }],
        commentaire: "Taxi client",
      },
      {
        id: "NF-2",
        date: "2026-02-11",
        consultantId: "c2",
        affaireId: null,
        categorieTempsInterne: "interne-formation",
        categorieFraisId: "cf1",
        refacturable: false,
        numeroBordereau: "FRAIS_BMA_2026_001",
        lignesTVA: [],
        commentaire: "",
      },
    ],
  };
}

function makeV1Export(state) {
  return {
    format: V1_EXPORT_FORMAT,
    schemaVersion: 1,
    exportedAt: "2026-08-30T00:00:00.000Z",
    revision: 42,
    state,
  };
}

// ---------------------------------------------------------------------------
// Import basique
// ---------------------------------------------------------------------------

test("importV1: crée workspace, genesisEvent, et une projection équivalente au state V1", () => {
  const state = makeV1State();
  const exportObj = makeV1Export(state);

  const { workspace, genesisEvent, projection, events } = importV1(exportObj, {
    workspaceId: WORKSPACE_ID,
    actorId: ACTOR_ID,
    now: "2026-08-30T12:00:00.000Z",
  });

  assert.equal(workspace.id, WORKSPACE_ID);
  assert.ok(workspace.createdAt);
  assert.equal(workspace.importedFromV1.revision, 42);

  assert.equal(genesisEvent.type, "workspace.imported");
  assert.equal(genesisEvent.workspaceId, WORKSPACE_ID);
  assert.equal(genesisEvent.actorId, ACTOR_ID);
  const expectedEntityCount =
    state.consultants.length +
    state.organisations.length +
    state.affaires.length +
    state.methodes.length +
    state.typesTerritoire.length +
    state.domainesIntervention.length +
    state.categoriesFrais.length +
    state.missions.length +
    state.factures.length +
    state.saisies.length +
    state.bordereauxFrais.length +
    state.notesFrais.length;
  assert.equal(genesisEvent.entityCount, expectedEntityCount);
  assert.equal(events.length, expectedEntityCount);

  const cmp = compareCollections(state, projection);
  assert.deepEqual(cmp.differences, []);
  assert.equal(cmp.ok, true);
});

test("importV1: bordereauxFrais est bien indexé par 'numero' (pas 'id')", () => {
  const state = makeV1State();
  const exportObj = makeV1Export(state);
  const { projection } = importV1(exportObj, { workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, now: Date.now() });

  const bordereauxBucket = projection.bordereauxFrais;
  assert.ok(bordereauxBucket["FRAIS_ADU_2026_001"]);
  assert.ok(bordereauxBucket["FRAIS_BMA_2026_001"]);
  assert.equal(bordereauxBucket["FRAIS_ADU_2026_001"].consultantId, "c1");
  assert.equal(bordereauxBucket["FRAIS_BMA_2026_001"].statut, "payée");
});

test("importV1: chaque collection retrouve son nombre d'entités exact", () => {
  const state = makeV1State();
  const exportObj = makeV1Export(state);
  const { projection } = importV1(exportObj, { workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, now: Date.now() });

  for (const [entityType, arr] of Object.entries(state)) {
    const bucket = projection[entityType] || {};
    assert.equal(Object.keys(bucket).length, arr.length, `${entityType}: nombre d'entités`);
  }
});

// ---------------------------------------------------------------------------
// Non-mutation de l'entrée
// ---------------------------------------------------------------------------

test("importV1: ne mute jamais exportObj (deep-equal avant/après, référence de state intacte)", () => {
  const state = makeV1State();
  const exportObj = makeV1Export(state);
  const snapshot = JSON.parse(JSON.stringify(exportObj));

  const { projection } = importV1(exportObj, { workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, now: Date.now() });

  assert.deepEqual(exportObj, snapshot);

  // Mutation de la projection ne doit pas se répercuter sur l'entrée V1
  // (clonage effectif, pas juste une référence partagée).
  projection.consultants["c1"].nom = "MUTÉ";
  assert.equal(state.consultants[0].nom, "Alice Dupont");
});

// ---------------------------------------------------------------------------
// compareCollections — détecte des écarts volontaires
// ---------------------------------------------------------------------------

test("compareCollections: détecte un écart de nombre d'entités", () => {
  const state = makeV1State();
  const exportObj = makeV1Export(state);
  const { projection } = importV1(exportObj, { workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, now: Date.now() });

  const stateWithExtra = {
    ...state,
    consultants: [...state.consultants, { id: "c3", nom: "Zoé", trigramme: "ZZZ", statut: "en poste", dateEmbauche: "2026-01-01", dateDepart: null, tjmBase: 400, admin: false, tempsPartiel: [] }],
  };

  const cmp = compareCollections(stateWithExtra, projection);
  assert.equal(cmp.ok, false);
  assert.ok(cmp.differences.some((d) => d.entityType === "consultants" && d.kind === "count-mismatch"));
});

test("compareCollections: détecte un écart de champ", () => {
  const state = makeV1State();
  const exportObj = makeV1Export(state);
  const { projection } = importV1(exportObj, { workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, now: Date.now() });

  const stateWithFieldDiff = JSON.parse(JSON.stringify(state));
  stateWithFieldDiff.consultants[0].tjmBase = 999999;

  const cmp = compareCollections(stateWithFieldDiff, projection);
  assert.equal(cmp.ok, false);
  assert.ok(cmp.differences.some((d) => d.entityType === "consultants" && d.kind === "field-mismatch" && d.id === "c1"));
});

test("compareCollections: détecte un id manquant côté projection", () => {
  const state = makeV1State();
  const exportObj = makeV1Export(state);
  const { projection } = importV1(exportObj, { workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, now: Date.now() });

  const strippedProjection = { ...projection, consultants: { ...projection.consultants } };
  delete strippedProjection.consultants["c2"];

  const cmp = compareCollections(state, strippedProjection);
  assert.equal(cmp.ok, false);
  assert.ok(cmp.differences.some((d) => d.entityType === "consultants" && d.kind === "count-mismatch"));
  assert.ok(cmp.differences.some((d) => d.entityType === "consultants" && d.kind === "missing-id" && d.id === "c2"));
});

// ---------------------------------------------------------------------------
// Réimport idempotent
// ---------------------------------------------------------------------------

test("importV1: réimport idempotent — même state source, même résultat fonctionnel", () => {
  const state = makeV1State();
  const exportObj = makeV1Export(state);

  const first = importV1(exportObj, { workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, now: "2026-08-30T00:00:00.000Z" });
  const second = importV1(exportObj, { workspaceId: WORKSPACE_ID, actorId: ACTOR_ID, now: "2026-08-30T00:00:00.000Z" });

  const cmp1 = compareCollections(state, first.projection);
  const cmp2 = compareCollections(state, second.projection);
  assert.equal(cmp1.ok, true);
  assert.equal(cmp2.ok, true);

  // Les deux imports produisent les mêmes entités/champs métier (les eventId
  // et lastEventId internes diffèrent nécessairement -- comparaison sur les
  // champs métier uniquement, pas sur __versions).
  for (const entityType of Object.keys(state)) {
    const bucket1 = first.projection[entityType];
    const bucket2 = second.projection[entityType];
    assert.deepEqual(Object.keys(bucket1).sort(), Object.keys(bucket2).sort(), `${entityType}: mêmes ids`);
    for (const id of Object.keys(bucket1)) {
      assert.deepEqual(bucket1[id], bucket2[id], `${entityType}/${id}: mêmes champs`);
    }
  }

  // L'entrée V1 originale n'a pas été affectée par le premier import,
  // permettant au second import de repartir des mêmes données.
  assert.equal(exportObj.state.consultants.length, 2);
});
