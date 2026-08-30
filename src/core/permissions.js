// src/core/permissions.js
//
// PolicyEngine local-first — porte fidèlement `server.py::can_change()` (V1) et
// `server.py::filter_state()` / `affair_ids_for_user()`.
//
// Références normatives : src/CONTRACTS.md §7/§8/§12, src/V1_DOMAIN_MAP.md §2/§3/§4.
//
// Décisions / hypothèses prises ici (à documenter, car non figées ailleurs) :
//
// 1. Forme de la `projection` : la reducer (§3 CONTRACTS, non livré dans ce lot)
//    indexe chaque entité par sa clé d'identité propre. On adopte donc ici la
//    forme `projection[entityType] = { [identityKey]: entity }` — une map, pas
//    un tableau (contrairement aux `state.consultants` etc. de V1). L'identityKey
//    est `id` pour toutes les collections sauf `bordereauxFrais` (`numero`).
//    `filterProjectionForRole` restitue une projection de même forme (vue).
//
// 2. `event.operation` (CONTRACTS §1) ∈ {"create","update","delete"} — équivalent
//    aux opérations V1 add/update/delete de `can_change`. `event.entityId` porte
//    la valeur de la clé d'identité de l'entité visée (donc un `numero` pour
//    `bordereauxFrais`, pas un champ nommé "id").
//
// 3. `payload` est l'état métier complet candidat de l'entité pour create/update
//    (mêmes hypothèses que V1 : "new" est l'objet entier, pas un patch partiel).
//    Pour delete, il n'y a pas de payload utile ; l'état "old" vient de la
//    projection courante.
//
// 4. `evaluate()` ne renvoie jamais `"conflict"` : la concurrence (par version
//    d'entité) est hors du ressort de ce module (cf. events/conflict.js, non
//    livré ici) — seul `"accept"|"reject"` est produit, conformément à la
//    consigne de mission. La signature CONTRACTS §7 admet `"conflict"` comme
//    valeur possible du contrat global ; ce module ne l'émet simplement jamais.
//
// 5. `owner` est traité comme équivalent `admin` pour les DROITS métier (owner =
//    admin + gouvernance workspace, CONTRACTS §8 / V1_DOMAIN_MAP §2) : aucune
//    règle métier supplémentaire n'est créée pour `owner`.
//
// 6. Un membership `status:"revoked"` est rejeté d'office, avant toute autre
//    règle (docs/next/05 §8-9, docs/next/01 §16).
//
// 7. Toutes les comparaisons d'identifiants (consultantId, pilote, etc.) sont
//    faites via `String(...)`, à l'identique des `str(...)` de `server.py`
//    (les ids V1 ne sont pas garantis homogènes en type).
//
// 8. `filterProjectionForRole` est une **projection de vue** en lecture : elle
//    ne modifie jamais le journal ni la projection source (retour = nouvel
//    objet, entités clonées superficiellement/en profondeur via structuredClone
//    quand disponible, sinon JSON round-trip).

// ---------------------------------------------------------------------------
// Constantes du domaine (V1_DOMAIN_MAP §1-2, CONTRACTS §12)

export const ENTITY_TYPES = [
  "consultants",
  "organisations",
  "affaires",
  "methodes",
  "typesTerritoire",
  "domainesIntervention",
  "categoriesFrais",
  "missions",
  "factures",
  "saisies",
  "bordereauxFrais",
  "notesFrais",
];

// Clé d'identité par collection — bordereauxFrais s'identifie par `numero`.
export const ENTITY_KEY_FIELD = {
  consultants: "id",
  organisations: "id",
  affaires: "id",
  methodes: "id",
  typesTerritoire: "id",
  domainesIntervention: "id",
  categoriesFrais: "id",
  missions: "id",
  factures: "id",
  saisies: "id",
  bordereauxFrais: "numero",
  notesFrais: "id",
};

// Écriture réservée admin (server.py:77-80 / V1_DOMAIN_MAP §2).
export const ADMIN_ONLY = new Set([
  "consultants",
  "organisations",
  "methodes",
  "typesTerritoire",
  "domainesIntervention",
  "categoriesFrais",
  "factures",
]);

const BORDEREAU_ALLOWED_TRANSITIONS = new Set([
  "en saisie>en saisie",
  "en saisie>note à payer",
  "note à payer>note à payer",
]);

// ---------------------------------------------------------------------------
// Helpers rôle / membership

export function isRevoked(membership) {
  return !!membership && membership.status === "revoked";
}

export function isAdmin(membership) {
  return !!membership && (membership.role === "admin" || membership.role === "owner");
}

function s(v) {
  return v === undefined || v === null ? "" : String(v);
}

// ---------------------------------------------------------------------------
// affair_ids_for_user (server.py:292-304 / V1_DOMAIN_MAP §3 dernière ligne)
//
// related(cid) = affaires où cid est pilote, piloteCommercial, crédité en
// repartitionCommerciale, ou consultant d'une mission de l'affaire.
// piloted(cid) = sous-ensemble strict où cid est le pilote.

export function affairIdsForUser(projection, consultantId) {
  const proj = projection || {};
  const cid = s(consultantId);
  const affaires = Object.values(proj.affaires || {});
  const missions = Object.values(proj.missions || {});

  const ownMissionAffairs = new Set(
    missions.filter((m) => s(m && m.consultantId) === cid).map((m) => s(m && m.affaireId))
  );

  const related = new Set();
  const piloted = new Set();

  for (const a of affaires) {
    if (!a) continue;
    const aid = s(a.id);
    const isPilote = s(a.pilote) === cid;
    if (isPilote) {
      piloted.add(aid);
      related.add(aid);
    }
    const rep = a.repartitionCommerciale || [];
    const isPiloteCommercial = s(a.piloteCommercial) === cid;
    const isInRepartition = rep.some((r) => s(r && r.consultantId) === cid);
    const hasMissionOnAffair = ownMissionAffairs.has(aid);
    if (isPiloteCommercial || isInRepartition || hasMissionOnAffair) {
      related.add(aid);
    }
  }

  return { related, piloted };
}

// ---------------------------------------------------------------------------
// PolicyEngine.evaluate — porte can_change() (server.py:377-430)

export function evaluate({ actorMembership, projection, event, payload } = {}) {
  if (!actorMembership) return "reject";
  if (isRevoked(actorMembership)) return "reject";
  if (isAdmin(actorMembership)) return "accept";

  if (!event || !event.entityType || !event.operation) return "reject";

  const cid = s(actorMembership.consultantId);
  const { entityType, operation, entityId } = event;

  // 2. non-admin sur collection ADMIN_ONLY => reject.
  if (ADMIN_ONLY.has(entityType)) return "reject";

  const proj = projection || {};
  const store = proj[entityType] || {};

  // old = état courant de l'entité (absent pour un create) ;
  // new = état candidat proposé (absent pour un delete) ;
  // candidate = new ?? old ?? {} — même logique que server.py.
  const oldVal = operation === "create" ? null : store[entityId] ?? null;
  const newVal = operation === "delete" ? null : payload ?? null;
  const candidate = newVal || oldVal || {};

  // Défense anti-usurpation (toutes collections) : le reducer indexe l'entité
  // par `event.entityId` ; un payload ne peut donc pas déclarer une identité
  // différente de `entityId`. Sans ce garde, un acteur autorisé sur l'entité
  // qu'il *déclare* dans le payload pourrait faire écraser une AUTRE entité
  // réellement ciblée par `entityId`. Le champ d'identité dépend de la
  // collection (`numero` pour bordereauxFrais, `id` sinon).
  if (newVal) {
    const declaredId = newVal[ENTITY_KEY_FIELD[entityType]];
    if (declaredId !== undefined && s(declaredId) !== s(entityId)) {
      return "reject";
    }
  }

  if (entityType === "saisies") {
    if (operation === "delete") return "reject"; // suppression jamais autorisée en V1
    if (s(candidate.consultantId) !== cid || (oldVal && s(oldVal.consultantId) !== cid)) {
      return "reject";
    }
    if (candidate.type === "mission") {
      const missions = proj.missions || {};
      const mission = missions[candidate.missionId] || null;
      if (!mission || s(mission.consultantId) !== cid) return "reject";
    }
    return "accept";
  }

  if (entityType === "notesFrais") {
    if (operation === "delete") return "reject";
    if (s(candidate.consultantId) !== cid || (oldVal && s(oldVal.consultantId) !== cid)) {
      return "reject";
    }
    if (candidate.affaireId) {
      const { related } = affairIdsForUser(proj, cid);
      if (!related.has(s(candidate.affaireId))) return "reject";
    }
    return "accept";
  }

  if (entityType === "bordereauxFrais") {
    if (operation === "delete") return "reject";
    if (s(candidate.consultantId) !== cid || (oldVal && s(oldVal.consultantId) !== cid)) {
      return "reject";
    }
    if (newVal && newVal.statut === "payée") return "reject"; // paiement réservé admin
    if (oldVal && newVal) {
      const transitionKey = `${oldVal.statut}>${newVal.statut}`;
      if (!BORDEREAU_ALLOWED_TRANSITIONS.has(transitionKey)) return "reject";
      if (newVal.datePaiement) return "reject"; // date de paiement réservée admin
    }
    return "accept";
  }

  if (entityType === "affaires" || entityType === "missions") {
    const affaires = proj.affaires || {};

    if (entityType === "affaires") {
      if (operation === "create") return "reject"; // création d'affaire réservée admin
      // Autorisation fondée sur l'affaire RÉELLEMENT ciblée (`entityId`),
      // jamais sur un `id` porté par le payload de l'acteur.
      const affair = affaires[entityId] || null;
      if (!affair || s(affair.pilote) !== cid) return "reject";
      if (newVal && s(newVal.pilote) !== cid) return "reject"; // changement de pilote réservé admin
      return "accept";
    }

    // missions : l'affaire de gouvernance est celle de la mission RÉELLE, pas
    // celle déclarée dans un payload hostile.
    if (operation === "create") {
      // Créer une mission : l'acteur doit piloter l'affaire cible du payload.
      const affair = affaires[s(newVal && newVal.affaireId)] || null;
      if (!affair || s(affair.pilote) !== cid) return "reject";
      return "accept";
    }
    // update / delete : l'affaire de référence est celle de la mission stockée
    // à `entityId` (`oldVal`), pas celle prétendue par le payload.
    if (!oldVal) return "reject";
    const currentAffair = affaires[s(oldVal.affaireId)] || null;
    if (!currentAffair || s(currentAffair.pilote) !== cid) return "reject";
    if (newVal && s(newVal.affaireId) !== s(oldVal.affaireId)) {
      // Déplacer une mission vers une autre affaire exige de piloter AUSSI la cible.
      const targetAffair = affaires[s(newVal.affaireId)] || null;
      if (!targetAffair || s(targetAffair.pilote) !== cid) return "reject";
    }
    return "accept";
  }

  // Filet par défaut (server.py:430).
  return "reject";
}

// ---------------------------------------------------------------------------
// filterProjectionForRole — porte filter_state() (server.py:307-356)
//
// Projection de VUE en lecture, dérivée ; ne modifie jamais le journal ni la
// projection source.

function clone(value) {
  if (value === undefined) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function emptyView() {
  const view = {};
  for (const t of ENTITY_TYPES) view[t] = {};
  return view;
}

export function filterProjectionForRole(projection, membership) {
  const proj = projection || {};

  if (!membership || isRevoked(membership)) {
    // Aucune identité active / membre révoqué : aucune vue (cohérent avec le
    // refus d'office en écriture — pas de contrat V1 explicite pour ce cas en
    // lecture, on choisit le plus restrictif).
    return emptyView();
  }

  if (isAdmin(membership)) {
    const full = emptyView();
    for (const t of ENTITY_TYPES) full[t] = clone(proj[t] || {});
    return full;
  }

  const cid = s(membership.consultantId);
  const { related, piloted } = affairIdsForUser(proj, cid);

  const missions = proj.missions || {};
  const visibleMissionIds = new Set(
    Object.values(missions)
      .filter((m) => s(m && m.consultantId) === cid || piloted.has(s(m && m.affaireId)))
      .map((m) => s(m.id))
  );

  const affaires = proj.affaires || {};
  const visibleAffaires = {};
  for (const [id, a] of Object.entries(affaires)) {
    if (related.has(s(id))) visibleAffaires[id] = clone(a);
  }

  const orgIds = new Set();
  for (const a of Object.values(visibleAffaires)) {
    if (a.organisationId != null) orgIds.add(s(a.organisationId));
    for (const p of a.partenaires || []) {
      if (p && p.organisationId != null) orgIds.add(s(p.organisationId));
    }
  }
  const organisations = proj.organisations || {};
  const visibleOrganisations = {};
  for (const [id, o] of Object.entries(organisations)) {
    if (orgIds.has(s(id))) visibleOrganisations[id] = clone(o);
  }

  const visibleMissions = {};
  for (const [id, m] of Object.entries(missions)) {
    if (visibleMissionIds.has(s(id))) visibleMissions[id] = clone(m);
  }

  const factures = proj.factures || {};
  const visibleFactures = {};
  for (const [id, f] of Object.entries(factures)) {
    if (piloted.has(s(f && f.affaireId))) visibleFactures[id] = clone(f);
  }

  const bordereauxFrais = proj.bordereauxFrais || {};
  const visibleBordereaux = {};
  for (const [numero, b] of Object.entries(bordereauxFrais)) {
    if (s(b && b.consultantId) === cid) visibleBordereaux[numero] = clone(b);
  }

  const notesFrais = proj.notesFrais || {};
  const visibleNotesFrais = {};
  for (const [id, n] of Object.entries(notesFrais)) {
    if (s(n && n.consultantId) === cid || piloted.has(s(n && n.affaireId))) {
      visibleNotesFrais[id] = clone(n);
    }
  }

  const consultants = proj.consultants || {};
  const visibleConsultants = {};
  for (const [id, c] of Object.entries(consultants)) {
    if (s(id) === cid) {
      visibleConsultants[id] = clone(c);
    } else {
      // Forme minimale : sans tjmBase, sans tempsPartiel (V1_DOMAIN_MAP §4).
      visibleConsultants[id] = {
        id: c.id,
        nom: c.nom,
        trigramme: c.trigramme,
        statut: c.statut,
        admin: false,
        tjmBase: 0,
        dateEmbauche: c.dateEmbauche || "1900-01-01",
        dateDepart: c.dateDepart ?? null,
        tempsPartiel: [],
      };
    }
  }

  const saisies = proj.saisies || {};
  const visibleSaisies = {};
  for (const [id, sa] of Object.entries(saisies)) {
    const own = s(sa && sa.consultantId) === cid;
    const mission = missions[sa && sa.missionId];
    const onPiloted = !!(mission && piloted.has(s(mission.affaireId)));
    if (own || onPiloted) visibleSaisies[id] = clone(sa);
  }

  return {
    consultants: visibleConsultants,
    organisations: visibleOrganisations,
    affaires: visibleAffaires,
    methodes: clone(proj.methodes || {}),
    typesTerritoire: clone(proj.typesTerritoire || {}),
    domainesIntervention: clone(proj.domainesIntervention || {}),
    categoriesFrais: clone(proj.categoriesFrais || {}),
    missions: visibleMissions,
    factures: visibleFactures,
    saisies: visibleSaisies,
    bordereauxFrais: visibleBordereaux,
    notesFrais: visibleNotesFrais,
  };
}
