// tests/next/policy.test.mjs
//
// Reprend la matrice de droits V1 (docs/next/07_TESTS_ET_RECETTE.md §5) sur le
// PolicyEngine (src/core/permissions.js). Fixture minimale mais couvrant les
// points délicats : rôle dérivé "pilote", transitions de bordereau, périmètre
// related/piloted, filtrage de lecture par rôle.

import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  affairIdsForUser,
  filterProjectionForRole,
  isGlobalUser,
} from "../../src/core/permissions.js";

// ---------------------------------------------------------------------------
// Fixture

function buildProjection() {
  return {
    consultants: {
      c1: {
        id: "c1", nom: "Alice", trigramme: "ALI", statut: "en poste",
        dateEmbauche: "2020-01-01", dateDepart: null, tjmBase: 500,
        admin: false, tempsPartiel: [],
      },
      c2: {
        id: "c2", nom: "Bob", trigramme: "BOB", statut: "en poste",
        dateEmbauche: "2020-01-01", dateDepart: null, tjmBase: 600,
        admin: false, tempsPartiel: [],
      },
    },
    organisations: {
      o1: { id: "o1", nom: "Org Un", type: "client", adresse: "" },
    },
    affaires: {
      a1: {
        id: "a1", nom: "Affaire pilotée par c1", organisationId: "o1",
        pilote: "c1", piloteCommercial: null, repartitionCommerciale: [],
        statut: "en cours",
      },
      a2: {
        id: "a2", nom: "Affaire pilotée par c2", organisationId: null,
        pilote: "c2", piloteCommercial: null, repartitionCommerciale: [],
        statut: "en cours",
      },
    },
    methodes: {},
    typesTerritoire: {},
    domainesIntervention: {},
    categoriesFrais: {},
    missions: {
      m1: { id: "m1", affaireId: "a1", nom: "Mission 1", consultantId: "c1", statut: "en cours" },
    },
    factures: {},
    saisies: {
      s1: { id: "s1", consultantId: "c1", date: "2026-01-05", type: "mission", missionId: "m1", dureeH: 7, pctFact: 100 },
      s2: { id: "s2", consultantId: "c2", date: "2026-01-05", type: "interne", missionId: null, dureeH: 7, pctFact: 0 },
    },
    bordereauxFrais: {
      B1: { numero: "B1", consultantId: "c1", annee: 2026, seq: 1, statut: "en saisie", datePaiement: null },
    },
    notesFrais: {
      n1: { id: "n1", consultantId: "c1", affaireId: "a1", categorieFraisId: "cat1", refacturable: true },
      n2: { id: "n2", consultantId: "c1", affaireId: "a2", categorieFraisId: "cat1", refacturable: true },
    },
  };
}

const userC1 = { workspaceId: "w1", memberId: "mem-c1", consultantId: "c1", role: "user", status: "active" };
const revokedC1 = { ...userC1, memberId: "mem-c1-rev", status: "revoked" };
const adminMember = { workspaceId: "w1", memberId: "mem-adm", consultantId: "admin1", role: "admin", status: "active" };
const ownerMember = { workspaceId: "w1", memberId: "mem-own", consultantId: "own1", role: "owner", status: "active" };
// Lot 3 (docs/next/PARCOURS_IDENTITE_CONTRACT.md) : « utilisateur global »,
// représentation `role:"user"` + `scope:"global"`, `consultantId:null` (non
// rattaché à un profil consultant précis — voir org-runtime.js/scope-hardening
// pour la provenance signée réelle ; ici on teste le moteur de droits en aval,
// sur un membership DÉJÀ construit avec cette forme).
const globalUserMember = { workspaceId: "w1", memberId: "mem-glob", consultantId: null, role: "user", scope: "global", status: "active" };
const revokedGlobalUserMember = { ...globalUserMember, memberId: "mem-glob-rev", status: "revoked" };

// ---------------------------------------------------------------------------
// saisies

test("user modifie ses propres saisies de temps => accept", () => {
  const projection = buildProjection();
  const event = { entityType: "saisies", operation: "update", entityId: "s1" };
  const payload = { ...projection.saisies.s1, dureeH: 8 };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "accept");
});

test("user ne modifie pas les saisies d'un tiers => reject", () => {
  const projection = buildProjection();
  const event = { entityType: "saisies", operation: "update", entityId: "s2" };
  const payload = { ...projection.saisies.s2, dureeH: 3 };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "reject");
});

test("user ne peut pas supprimer une saisie (toujours reject en V1)", () => {
  const projection = buildProjection();
  const event = { entityType: "saisies", operation: "delete", entityId: "s1" };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload: null }), "reject");
});

test("saisie type=mission dont la mission n'est pas affectée à l'utilisateur => reject", () => {
  const projection = buildProjection();
  projection.missions.m2 = { id: "m2", affaireId: "a2", nom: "Mission 2", consultantId: "c2", statut: "en cours" };
  const event = { entityType: "saisies", operation: "create", entityId: "s3" };
  const payload = { id: "s3", consultantId: "c1", date: "2026-01-06", type: "mission", missionId: "m2", dureeH: 2 };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "reject");
});

// ---------------------------------------------------------------------------
// ADMIN_ONLY

test("user ne modifie pas un consultant/référentiel ADMIN_ONLY => reject", () => {
  const projection = buildProjection();
  const event = { entityType: "consultants", operation: "update", entityId: "c2" };
  const payload = { ...projection.consultants.c2, tjmBase: 999 };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "reject");
});

test("admin modifie n'importe quoi (y compris ADMIN_ONLY) => accept", () => {
  const projection = buildProjection();
  const event = { entityType: "consultants", operation: "update", entityId: "c2" };
  const payload = { ...projection.consultants.c2, tjmBase: 999 };
  assert.equal(evaluate({ actorMembership: adminMember, projection, event, payload }), "accept");
  const event2 = { entityType: "affaires", operation: "create", entityId: "a3" };
  const payload2 = { id: "a3", nom: "Nouvelle affaire", pilote: "c2" };
  assert.equal(evaluate({ actorMembership: adminMember, projection, event: event2, payload: payload2 }), "accept");
  assert.equal(evaluate({ actorMembership: ownerMember, projection, event: event2, payload: payload2 }), "accept");
});

// ---------------------------------------------------------------------------
// Lot 3 (docs/next/PARCOURS_IDENTITE_CONTRACT.md) — « utilisateur global »
// (role:"user" + scope:"global") : mêmes droits qu'un admin sur les données
// MÉTIER (y compris ADMIN_ONLY — "éditer les données de référence n'est pas
// de l'administration au sens de ce modèle"), sans restriction de
// consultantId contrairement à un user rattaché.

test("isGlobalUser: ne reconnaît QUE role:user + scope:global — jamais un admin/owner, jamais un user sans scope ou avec un scope différent", () => {
  assert.equal(isGlobalUser(globalUserMember), true);
  assert.equal(isGlobalUser(userC1), false, "user rattaché (pas de scope) n'est pas global");
  assert.equal(isGlobalUser(adminMember), false, "un admin n'est pas 'global' au sens de ce marqueur (isAdmin le couvre déjà)");
  assert.equal(isGlobalUser(ownerMember), false);
  assert.equal(isGlobalUser({ ...userC1, scope: "GLOBAL" }), false, "casse/valeur non exacte => pas global");
  assert.equal(isGlobalUser({ ...userC1, scope: "consultant" }), false, "toute autre valeur de scope => pas global");
  assert.equal(isGlobalUser(null), false);
});

test("user global : écrit une entité ADMIN_ONLY (consultants) => accept, comme un admin", () => {
  const projection = buildProjection();
  const event = { entityType: "consultants", operation: "update", entityId: "c2" };
  const payload = { ...projection.consultants.c2, tjmBase: 999 };
  assert.equal(evaluate({ actorMembership: globalUserMember, projection, event, payload }), "accept");
});

test("user global : crée une affaire et en change le pilote (réservé admin pour un user rattaché) => accept", () => {
  const projection = buildProjection();
  const event = { entityType: "affaires", operation: "create", entityId: "a3" };
  const payload = { id: "a3", nom: "Nouvelle affaire", pilote: "c2" };
  assert.equal(evaluate({ actorMembership: globalUserMember, projection, event, payload }), "accept");

  const event2 = { entityType: "affaires", operation: "update", entityId: "a2" };
  const payload2 = { ...projection.affaires.a2, pilote: "c1" };
  assert.equal(evaluate({ actorMembership: globalUserMember, projection, event: event2, payload: payload2 }), "accept");
});

test("user global : modifie une saisie/note de frais d'un consultant qui n'est PAS lui (aucune restriction de consultantId, contrairement à un user rattaché) => accept", () => {
  const projection = buildProjection();
  // userC1 (rattaché à c1) ne peut PAS toucher s2 (c2) — non-régression déjà
  // couverte plus haut. Le user global, lui, le peut : aucune notion de
  // consultantId ne le limite (comme un admin).
  const event = { entityType: "saisies", operation: "update", entityId: "s2" };
  const payload = { ...projection.saisies.s2, dureeH: 3 };
  assert.equal(evaluate({ actorMembership: globalUserMember, projection, event, payload }), "accept");

  const eventBordereau = { entityType: "bordereauxFrais", operation: "update", entityId: "B1" };
  const payloadBordereau = { ...projection.bordereauxFrais.B1, statut: "payée" };
  assert.equal(
    evaluate({ actorMembership: globalUserMember, projection, event: eventBordereau, payload: payloadBordereau }),
    "accept",
    "le paiement d'un bordereau, réservé admin pour un user rattaché, est admis pour un user global"
  );
});

test("user global révoqué => reject d'office, comme n'importe quel membre révoqué", () => {
  const projection = buildProjection();
  const event = { entityType: "consultants", operation: "update", entityId: "c2" };
  const payload = { ...projection.consultants.c2, tjmBase: 999 };
  assert.equal(evaluate({ actorMembership: revokedGlobalUserMember, projection, event, payload }), "reject");
});

test("filterProjectionForRole: user global voit TOUTE la projection métier (y compris affaires/consultants hors de son périmètre 'consultant')", () => {
  const projection = buildProjection();
  const view = filterProjectionForRole(projection, globalUserMember);
  assert.ok(view.affaires.a1 && view.affaires.a2, "les deux affaires (piloté par c1 ET par c2) sont visibles");
  assert.deepEqual(view.consultants.c2, projection.consultants.c2, "profil consultant COMPLET (tjmBase inclus), pas la forme minimale d'un user rattaché");
  assert.deepEqual(view.saisies, projection.saisies);
  assert.deepEqual(view.bordereauxFrais, projection.bordereauxFrais);
  assert.deepEqual(view.notesFrais, projection.notesFrais);
});

test("filterProjectionForRole: user rattaché reste limité à son consultant (non-régression, comparaison directe avec un user global)", () => {
  const projection = buildProjection();
  const restrictedView = filterProjectionForRole(projection, userC1);
  const globalView = filterProjectionForRole(projection, globalUserMember);
  assert.equal(restrictedView.affaires.a2, undefined, "user rattaché : a2 (hors périmètre) invisible");
  assert.ok(globalView.affaires.a2, "user global : a2 visible");
  assert.notDeepEqual(restrictedView.consultants.c2, projection.consultants.c2, "vue restreinte = forme minimale (tjmBase masqué), pas le profil complet");
  assert.equal(restrictedView.consultants.c2.tjmBase, 0, "user rattaché : tjmBase masqué pour un tiers");
});

// ---------------------------------------------------------------------------
// pilote dérivé / affaires / missions

test("pilote modifie l'affaire qu'il pilote => accept", () => {
  const projection = buildProjection();
  const event = { entityType: "affaires", operation: "update", entityId: "a1" };
  const payload = { ...projection.affaires.a1, nom: "Affaire pilotée par c1 (renommée)" };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "accept");
});

test("non-pilote ne modifie pas une affaire qu'il ne pilote pas => reject", () => {
  const projection = buildProjection();
  const event = { entityType: "affaires", operation: "update", entityId: "a2" };
  const payload = { ...projection.affaires.a2, nom: "Tentative" };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "reject");
});

test("changer le pilote d'une affaire est réservé à l'admin => reject pour un user", () => {
  const projection = buildProjection();
  const event = { entityType: "affaires", operation: "update", entityId: "a1" };
  const payload = { ...projection.affaires.a1, pilote: "c2" };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "reject");
});

test("création d'affaire par un user => reject (réservé admin)", () => {
  const projection = buildProjection();
  const event = { entityType: "affaires", operation: "create", entityId: "a3" };
  const payload = { id: "a3", nom: "Nouvelle affaire", pilote: "c1" };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "reject");
});

test("pilote peut créer une mission sur l'affaire qu'il pilote => accept", () => {
  const projection = buildProjection();
  const event = { entityType: "missions", operation: "create", entityId: "m3" };
  const payload = { id: "m3", affaireId: "a1", nom: "Mission 3", consultantId: "c2", statut: "en cours" };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "accept");
});

// ---------------------------------------------------------------------------
// Non-régression sécurité : usurpation de champ payload (autorisation fondée
// sur l'entité réelle ciblée par entityId, jamais sur le payload de l'acteur).

const userC2 = { workspaceId: "w1", memberId: "mem-c2", consultantId: "c2", role: "user", status: "active" };

test("SÉCURITÉ: hijack cross-affaire d'une mission (payload.affaireId falsifié) => reject", () => {
  const projection = buildProjection();
  // m1 appartient réellement à a1 (pilotée par c1). c2 ne pilote que a2.
  // c2 cible m1 (entityId) en prétendant (payload.affaireId=a2) piloter son affaire.
  const event = { entityType: "missions", operation: "update", entityId: "m1" };
  const payload = { id: "m1", affaireId: "a2", nom: "Détournée", consultantId: "c2", statut: "en cours" };
  assert.equal(evaluate({ actorMembership: userC2, projection, event, payload }), "reject");
});

test("SÉCURITÉ: prise de contrôle d'une affaire tierce (payload.id falsifié) => reject", () => {
  const projection = buildProjection();
  // c2 pilote a2. Il cible a1 (entityId, pilotée par c1) mais usurpe payload.id=a2.
  const event = { entityType: "affaires", operation: "update", entityId: "a1" };
  const payload = { ...projection.affaires.a2, id: "a2", nom: "Prise de contrôle" };
  assert.equal(evaluate({ actorMembership: userC2, projection, event, payload }), "reject");
});

test("SÉCURITÉ: déplacer une mission vers une affaire non pilotée => reject", () => {
  const projection = buildProjection();
  // c1 pilote a1 et la mission m1. Il tente de déplacer m1 vers a2 (pilotée par c2).
  const event = { entityType: "missions", operation: "update", entityId: "m1" };
  const payload = { id: "m1", affaireId: "a2", nom: "Mission 1", consultantId: "c1", statut: "en cours" };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "reject");
});

test("SÉCURITÉ: usurpation de numero de bordereau (payload.numero != entityId) => reject", () => {
  const projection = buildProjection();
  // B1 appartient à c1. c2 cible B1 en usurpant un numero qui lui appartiendrait.
  const event = { entityType: "bordereauxFrais", operation: "update", entityId: "B1" };
  const payload = { numero: "B2", consultantId: "c2", annee: 2026, seq: 2, statut: "en saisie", datePaiement: null };
  assert.equal(evaluate({ actorMembership: userC2, projection, event, payload }), "reject");
});

// ---------------------------------------------------------------------------
// bordereauxFrais : transitions

test("bordereau: transition autorisée (en saisie -> note à payer) => accept", () => {
  const projection = buildProjection();
  const event = { entityType: "bordereauxFrais", operation: "update", entityId: "B1" };
  const payload = { ...projection.bordereauxFrais.B1, statut: "note à payer" };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "accept");
});

test("bordereau: transition interdite (note à payer -> en saisie) => reject", () => {
  const projection = buildProjection();
  projection.bordereauxFrais.B1.statut = "note à payer";
  const event = { entityType: "bordereauxFrais", operation: "update", entityId: "B1" };
  const payload = { ...projection.bordereauxFrais.B1, statut: "en saisie" };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "reject");
});

test("bordereau: passage à statut 'payée' par un user => reject", () => {
  const projection = buildProjection();
  const event = { entityType: "bordereauxFrais", operation: "update", entityId: "B1" };
  const payload = { ...projection.bordereauxFrais.B1, statut: "payée" };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "reject");
});

test("bordereau: renseigner datePaiement par un user => reject", () => {
  const projection = buildProjection();
  const event = { entityType: "bordereauxFrais", operation: "update", entityId: "B1" };
  const payload = { ...projection.bordereauxFrais.B1, statut: "en saisie", datePaiement: "2026-02-01" };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "reject");
});

test("bordereau: delete toujours interdit", () => {
  const projection = buildProjection();
  const event = { entityType: "bordereauxFrais", operation: "delete", entityId: "B1" };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload: null }), "reject");
});

// ---------------------------------------------------------------------------
// notesFrais : périmètre via affaire pilotée

test("notesFrais rattaché à une affaire piloté par l'utilisateur => accept", () => {
  const projection = buildProjection();
  const event = { entityType: "notesFrais", operation: "update", entityId: "n1" };
  const payload = { ...projection.notesFrais.n1, refacturable: false };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "accept");
});

test("notesFrais rattaché à une affaire hors périmètre => reject", () => {
  const projection = buildProjection();
  const event = { entityType: "notesFrais", operation: "update", entityId: "n2" };
  const payload = { ...projection.notesFrais.n2, refacturable: false };
  assert.equal(evaluate({ actorMembership: userC1, projection, event, payload }), "reject");
});

// ---------------------------------------------------------------------------
// membre révoqué

test("membre révoqué => reject d'office, même sur ses propres données", () => {
  const projection = buildProjection();
  const event = { entityType: "saisies", operation: "update", entityId: "s1" };
  const payload = { ...projection.saisies.s1, dureeH: 8 };
  assert.equal(evaluate({ actorMembership: revokedC1, projection, event, payload }), "reject");
});

// ---------------------------------------------------------------------------
// affairIdsForUser

test("affairIdsForUser: related inclut pilote, piloteCommercial, repartition et mission ; piloted = pilote strict", () => {
  const projection = buildProjection();
  projection.affaires.a3 = {
    id: "a3", nom: "Affaire commerciale", organisationId: null,
    pilote: "other", piloteCommercial: "c1", repartitionCommerciale: [],
  };
  projection.affaires.a4 = {
    id: "a4", nom: "Affaire répartition", organisationId: null,
    pilote: "other", piloteCommercial: null, repartitionCommerciale: [{ consultantId: "c1", pct: 10 }],
  };
  const { related, piloted } = affairIdsForUser(projection, "c1");
  assert.ok(related.has("a1"));
  assert.ok(related.has("a3"));
  assert.ok(related.has("a4"));
  assert.ok(!related.has("a2"));
  assert.deepEqual([...piloted], ["a1"]);
});

// ---------------------------------------------------------------------------
// filterProjectionForRole

test("filterProjectionForRole: un user ne reçoit pas une affaire hors périmètre", () => {
  const projection = buildProjection();
  const view = filterProjectionForRole(projection, userC1);
  assert.ok(view.affaires.a1, "a1 (pilotée) doit être visible");
  assert.equal(view.affaires.a2, undefined, "a2 (hors périmètre) ne doit pas être visible");
});

test("filterProjectionForRole: un user ne reçoit pas le tjmBase des autres consultants", () => {
  const projection = buildProjection();
  const view = filterProjectionForRole(projection, userC1);
  assert.equal(view.consultants.c1.tjmBase, 500, "sa propre fiche reste complète");
  assert.equal(view.consultants.c2.tjmBase, 0, "tjmBase masqué pour un tiers");
  assert.deepEqual(view.consultants.c2.tempsPartiel, []);
});

test("filterProjectionForRole: saisies visibles = les siennes + celles d'une mission d'affaire pilotée", () => {
  const projection = buildProjection();
  projection.saisies.s3 = { id: "s3", consultantId: "c2", date: "2026-01-07", type: "mission", missionId: "m1", dureeH: 5, pctFact: 100 };
  const view = filterProjectionForRole(projection, userC1);
  assert.ok(view.saisies.s1, "sa propre saisie");
  assert.ok(view.saisies.s3, "saisie de c2 sur une mission de l'affaire a1 pilotée par c1");
  assert.equal(view.saisies.s2, undefined, "saisie de c2 hors périmètre");
});

test("filterProjectionForRole: admin voit une projection complète", () => {
  const projection = buildProjection();
  const view = filterProjectionForRole(projection, adminMember);
  assert.deepEqual(view, projection);
  assert.notEqual(view, projection, "doit être une copie, pas la même référence");
});

test("filterProjectionForRole: membre révoqué ne reçoit aucune vue", () => {
  const projection = buildProjection();
  const view = filterProjectionForRole(projection, revokedC1);
  assert.deepEqual(view.affaires, {});
  assert.deepEqual(view.saisies, {});
});
