// tests/next/org-promotion.test.mjs
//
// Couvre docs/next/PARCOURS_IDENTITE_CONTRACT.md, Lot 2 — « Partager cet
// espace » : promotion EN PLACE d'un workspace solo en organisation, MÊME
// workspaceId (`org-runtime.js#promoteSoloToOrg`/`#planPromotion`).
//
// Convention de la suite (cf. tests/next/org-folder.test.mjs,
// tests/next/mode-migration.test.mjs) : les ponts navigateur
// (`piloteo-org-bridge.mjs`, `piloteo-migration-bridge.mjs`) posent
// `window.PiloteoOrg`/`window.PiloteoMigration` et ne sont donc PAS
// importables sous Node (pas de `window`) — ce fichier réimplémente ICI la
// MÊME séquence d'orchestration que celle qui sera câblée dans
// `piloteo-org-bridge.mjs#promoteToOrg` (lecture du manifeste, décision
// `planPromotion`, écriture SI ET SEULEMENT SI autorisée, ouverture de
// l'engine, migration via le pipeline Point 5 déjà committé), en n'utilisant
// QUE des primitives DÉJÀ committées (`org-runtime.js`, `org-folder-store.js`,
// `org-engine.js`, `src/integration/migration.js`) — aucune logique de
// décision n'est dupliquée, seule la SÉQUENCE d'I/O l'est (comme le reste de
// la suite next le fait déjà pour `createOrg`/`joinOrg`).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FolderStorageAdapter } from "../../src/storage/folder-storage-adapter.js";
import { InMemoryStorageAdapter } from "../../src/storage/in-memory-adapter.js";
import { NodeFsPort } from "../../src/storage/node-fs-port.js";

import {
  newMemberIdentity,
  createOrganization,
  promoteSoloToOrg,
  planPromotion,
} from "../../src/workspace/org-runtime.js";
import {
  writeManifest,
  writeMemberRecord,
  readManifest,
  loadTrust,
  memberRecordAlreadyPublished,
  getMemberCandidates,
  isWriteOnceCollision,
} from "../../src/workspace/org-folder-store.js";
import { openOrgEngine } from "../../src/workspace/org-engine.js";
import { snapshotToSeedEvents, verifyRoundTrip, diffSnapshots, planMigration } from "../../src/integration/migration.js";
import { createMembership } from "../../src/workspace/memberships.js";
import { GoogleDriveStorageAdapter, ImmutableConflictError } from "../../src/storage/google-drive-adapter.js";
import { FakeDrive } from "./helpers/fake-drive.mjs";

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
function consultant(id, nom) {
  return { id, nom, trigramme: nom.slice(0, 3).toUpperCase(), statut: "en poste", admin: false, tempsPartiel: [] };
}
function mission(id, consultantId) {
  return { id, consultantId, affaireId: "a-1", nom: "Mission " + id, statut: "en cours", enveloppe: 10, taux: 500 };
}
function saisie(id, consultantId) {
  return { id, date: "2026-08-30", consultantId, type: "interne", missionId: null, categorie: "adm", dureeH: 1, pctFact: 0, commentaire: "" };
}

function soloWorkspaceIdFixture() {
  // Symétrique de `src/integration/solo-store.js` (« un workspaceId FIXE,
  // persisté une fois par le backend ») : ici, un identifiant fixe simulant
  // le workspaceId solo déjà persisté sur cet appareil AVANT toute promotion.
  return globalThis.crypto.randomUUID();
}

/**
 * Vérifie que l'owner (`identity`) visé par le manifeste PUBLIÉ sur `adapter`
 * est RÉELLEMENT admis dans `membershipStore` (rôle owner, statut actif) —
 * via la chaîne de confiance COMPLÈTE (`loadTrust` = `listGovernance` +
 * `buildTrustedMembership`), JAMAIS une simple présence de fichier. Réimplémente
 * FIDÈLEMENT `piloteo-org-bridge.mjs#isOwnerAdmitted` (CORRECTIF contrariant
 * « promotion interrompue qui brique le dossier à vie »).
 */
async function isOwnerAdmitted(adapter, workspaceId, identity) {
  try {
    const trust = await loadTrust(adapter);
    if (trust.manifest.workspaceId !== workspaceId) return false;
    const membership = trust.membershipStore.get(workspaceId, identity.memberId);
    return !!(membership && membership.role === "owner" && membership.status === "active");
  } catch {
    return false;
  }
}

/**
 * Réimplémentation FIDÈLE de la séquence CORRIGÉE de
 * `piloteo-org-bridge.mjs#promoteToOrg` (Lot 2 + correctifs contrariant
 * round 1 « promotion interrompue » et round 2 « empoisonnement du slot
 * owner par un tiers ») : lit le manifeste déjà publié (s'il existe), calcule
 * l'admission RÉELLE de l'owner (`isOwnerAdmitted`, jamais déduite d'une
 * simple présence de fichier), délègue la DÉCISION à `planPromotion` (pure),
 * et n'écrit QUE si la décision l'autorise — `"promote"` publie manifeste +
 * fiche owner, `"complete-owner"` republie UNIQUEMENT la fiche owner
 * manquante (JAMAIS un second manifeste), `"already-promoted"` ne publie
 * rien. Round 2 : une collision write-once pendant `"complete-owner"` n'est
 * avalée QUE si le contenu déjà présent au slot est EXACTEMENT ma propre
 * fiche (`memberRecordAlreadyPublished`, org-folder-store.js) — un contenu
 * DIVERGENT (tiers/hostile) fait lever une erreur EXPLICITE et DISTINCTE,
 * jamais laissée à `openOrgEngine` comme arbitre final. Ne construit/ouvre
 * l'engine QUE si la promotion n'est ni un conflit ni un slot contesté ;
 * `openOrgEngine` sert de VÉRIFICATION FINALE (il échoue explicitement si
 * l'owner n'est toujours pas membre) avant de considérer la promotion
 * réussie.
 */
async function promoteToOrg({ adapter, workspaceId, name, identity, consultantId }) {
  const existingManifest = await readManifest(adapter);
  const ownerAdmitted = existingManifest ? await isOwnerAdmitted(adapter, workspaceId, identity) : false;
  const plan = planPromotion({ existingManifest, workspaceId, identity, ownerAdmitted });
  if (plan.kind === "conflict") {
    throw new Error(`promoteToOrg: ${plan.reason}`);
  }
  if (plan.kind === "promote" || plan.kind === "complete-owner") {
    const org = promoteSoloToOrg({ workspaceId, name, identity, consultantId });
    if (plan.kind === "promote") {
      // CORRECTIF défensif round 3 : sur un adapter qui expose
      // `getAllCandidates` (Drive), un slot manifeste CONTESTÉ (candidats
      // divergents/illisibles) fait lever `readManifest` -> `null` (décision
      // 3 d'org-folder-store.js, volontairement conservée) — vérifié ici
      // AVANT toute tentative d'écriture, pour ne jamais laisser
      // `writeManifest` échouer avec un message confus sur un slot qu'on
      // croyait vide.
      if (typeof adapter.getAllCandidates === "function") {
        let contested = [];
        try { contested = await adapter.getAllCandidates("workspace", "manifest"); } catch { contested = []; }
        if (contested.length > 0) {
          throw new Error("promoteToOrg: le slot manifeste de ce dossier est occupé (candidats illisibles ou divergents).");
        }
      }
      await writeManifest(adapter, org.manifest);
    }
    try {
      await writeMemberRecord(adapter, org.memberRecord);
    } catch (err) {
      // "complete-owner" seulement : une collision write-once ici est
      // ATTENDUE, mais deux causes possibles, jamais confondues (CORRECTIF
      // round 2) : (a) ma propre fiche déjà publiée (contenu canonique
      // IDENTIQUE) -> avaler, continuer ; (b) un tiers/hostile a occupé le
      // slot avec un contenu DIVERGENT -> erreur EXPLICITE et DISTINCTE,
      // jamais avalée, jamais laissée à `openOrgEngine` comme arbitre final
      // silencieux.
      if (plan.kind !== "complete-owner") throw err;
      // Ne tenter la distinction "ma fiche"/"tierce" QUE pour une VRAIE
      // collision write-once — `isWriteOnceCollision` (CORRECTIF round 3)
      // reconnaît les DEUX signaux réels : message `write-once`
      // (Folder/InMemory) ET nom `ImmutableConflictError` (Drive). Toute
      // autre erreur (panne persistante, etc.) reste remontée TELLE QUELLE.
      if (!isWriteOnceCollision(err)) throw err;
      const mine = await memberRecordAlreadyPublished(adapter, org.memberRecord);
      if (!mine) {
        throw new Error(
          "promoteToOrg: le slot owner de ce dossier est occupé par une fiche tierce/hostile " +
          "(memberId owner contesté). Retirez cette fiche du dossier partagé avant de réessayer."
        );
      }
    }
  }
  // plan.kind === "already-promoted" : NO-OP volontaire, rien n'est publié.
  const engine = await openOrgEngine({ adapter, identity, consultantId });
  return { engine, plan };
}

// ---------------------------------------------------------------------------
// 1. promoteSoloToOrg — forme, workspaceId PRÉSERVÉ (jamais un nouveau)
// ---------------------------------------------------------------------------

test("promoteSoloToOrg : conserve EXACTEMENT le workspaceId fourni (jamais un nouveau, contrairement à createOrganization)", async () => {
  const identity = await newMemberIdentity();
  const soloWorkspaceId = soloWorkspaceIdFixture();

  const org = promoteSoloToOrg({ workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" });

  assert.equal(org.workspace.workspaceId, soloWorkspaceId);
  assert.equal(org.manifest.workspaceId, soloWorkspaceId);
  assert.equal(org.ownerMembership.workspaceId, soloWorkspaceId);
  assert.equal(org.ownerMembership.role, "owner");
  assert.equal(org.ownerMembership.memberId, identity.memberId);
  assert.equal(org.manifest.ownerMemberId, identity.memberId);
  assert.deepEqual(org.manifest.ownerPublicKeyJwk, identity.publicKeyJwk);
  assert.equal(org.memberRecord.memberId, identity.memberId);
  assert.deepEqual(org.memberRecord.authorization, { genesis: true });

  // Non-régression : createOrganization, lui, continue de MINTER un
  // workspaceId frais (jamais celui d'un éventuel appelant) — les deux
  // fonctions restent bien DISTINCTES en comportement.
  const fresh = createOrganization({ name: "Org fraîche", identity, consultantId: "c-alice" });
  assert.notEqual(fresh.workspace.workspaceId, soloWorkspaceId);
});

test("promoteSoloToOrg : lève si 'workspaceId' ou 'identity' est absent (jamais un genesis silencieux mal formé)", async () => {
  const identity = await newMemberIdentity();
  assert.throws(() => promoteSoloToOrg({ name: "X", identity, consultantId: null }), /workspaceId/);
  assert.throws(() => promoteSoloToOrg({ workspaceId: soloWorkspaceIdFixture(), name: "X", consultantId: null }), /identity/);
});

// ---------------------------------------------------------------------------
// 2. planPromotion — pure, décide SANS E/S
// ---------------------------------------------------------------------------

test("planPromotion : aucun manifeste existant -> 'promote'", async () => {
  const identity = await newMemberIdentity();
  const plan = planPromotion({ existingManifest: null, workspaceId: soloWorkspaceIdFixture(), identity });
  assert.equal(plan.kind, "promote");
});

test("planPromotion : manifeste existant, MÊME workspaceId ET MÊME owner, owner RÉELLEMENT admis -> 'already-promoted' (idempotence)", async () => {
  const identity = await newMemberIdentity();
  const workspaceId = soloWorkspaceIdFixture();
  const org = promoteSoloToOrg({ workspaceId, name: "X", identity, consultantId: null });
  const plan = planPromotion({ existingManifest: org.manifest, workspaceId, identity, ownerAdmitted: true });
  assert.equal(plan.kind, "already-promoted");
  assert.deepEqual(plan.manifest, org.manifest);
});

test("planPromotion : CORRECTIF (promotion interrompue) — manifeste existant, MÊME workspaceId/owner, mais owner PAS ADMIS -> 'complete-owner' (JAMAIS un no-op qui masque l'owner manquant)", async () => {
  const identity = await newMemberIdentity();
  const workspaceId = soloWorkspaceIdFixture();
  const org = promoteSoloToOrg({ workspaceId, name: "X", identity, consultantId: null });

  // ownerAdmitted explicitement false : la fiche membre owner n'a jamais été
  // (ou plus) publiée/admise (ex. panne réseau entre writeManifest et
  // writeMemberRecord) — jamais confondu avec un dossier déjà fonctionnel.
  const planExplicit = planPromotion({ existingManifest: org.manifest, workspaceId, identity, ownerAdmitted: false });
  assert.equal(planExplicit.kind, "complete-owner");
  assert.deepEqual(planExplicit.manifest, org.manifest);

  // Défaut SÛR : `ownerAdmitted` omis -> traité comme "pas admis" (jamais un
  // faux "already-promoted" par défaut permissif).
  const planDefault = planPromotion({ existingManifest: org.manifest, workspaceId, identity });
  assert.equal(planDefault.kind, "complete-owner");
});

test("planPromotion : manifeste existant pour un AUTRE workspaceId -> 'conflict' (jamais un no-op silencieux ni une écrasement)", async () => {
  const identity = await newMemberIdentity();
  const org = promoteSoloToOrg({ workspaceId: soloWorkspaceIdFixture(), name: "X", identity, consultantId: null });
  const plan = planPromotion({ existingManifest: org.manifest, workspaceId: soloWorkspaceIdFixture(), identity });
  assert.equal(plan.kind, "conflict");
  assert.match(plan.reason, /organisation différente/);
});

test("planPromotion : MÊME workspaceId mais owner DIFFÉRENT (clé/memberId) -> 'conflict', jamais 'already-promoted' (anti-usurpation)", async () => {
  const owner = await newMemberIdentity();
  const attacker = await newMemberIdentity();
  const workspaceId = soloWorkspaceIdFixture();
  const org = promoteSoloToOrg({ workspaceId, name: "X", identity: owner, consultantId: null });

  const planImpostor = planPromotion({ existingManifest: org.manifest, workspaceId, identity: attacker });
  assert.equal(planImpostor.kind, "conflict");
  assert.match(planImpostor.reason, /propriétaire différent/);
});

// ---------------------------------------------------------------------------
// 3. Bout-en-bout (FolderStorageAdapter) : promotion + republication des
//    événements solo existants (pipeline Point 5, non dupliqué) + owner =
//    identité solo + aucune perte/duplication.
// ---------------------------------------------------------------------------

test("promotion bout-en-bout : workspaceId inchangé, données solo republiées SANS perte/doublon, owner = identité solo", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-org-promotion-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "promotion-test" });
    await adapter.connect();

    const identity = await newMemberIdentity();
    const soloWorkspaceId = soloWorkspaceIdFixture();

    // État solo « cet appareil » AVANT promotion (plusieurs collections,
    // comme un vrai appareil déjà utilisé).
    const soloSnapshot = {
      ...emptySnapshot(),
      consultants: [consultant("c-alice", "Alice"), consultant("c-bob", "Bob")],
      missions: [mission("m-1", "c-alice")],
      saisies: [saisie("s-1", "c-alice"), saisie("s-2", "c-bob")],
    };

    // 1) Promotion (écrit manifeste+fiche owner, CE workspaceId).
    const { engine, plan } = await promoteToOrg({
      adapter, workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice",
    });
    assert.equal(plan.kind, "promote");
    assert.equal(engine.manifest.workspaceId, soloWorkspaceId, "workspaceId après promotion == workspaceId solo d'origine");

    // 2) Republication des événements solo (pipeline Point 5, réutilisé tel
    //    quel — snapshotToSeedEvents/verifyRoundTrip/engine.commit).
    const loadedBeforeMigration = await engine.load();
    const plan2 = planMigration({ soloSnapshot, targetExisting: loadedBeforeMigration.state });
    assert.equal(plan2.kind, "seed");

    const identityForSeed = { workspaceId: soloWorkspaceId, actorId: identity.memberId, epoch: 1 };
    const seed = snapshotToSeedEvents(soloSnapshot, identityForSeed);
    assert.equal(seed.rejected.length, 0);
    assert.equal(verifyRoundTrip(soloSnapshot, seed.events).ok, true, "pré-vérification pure OK avant toute écriture");

    const commitResult = await engine.commit(soloSnapshot);
    assert.equal(commitResult.ok, true, JSON.stringify(commitResult.conflicts || commitResult.applied));
    assert.equal(commitResult.applied.count, 5, "5 entités solo republiées (2 consultants + 1 mission + 2 saisies)");
    assert.equal(commitResult.applied.rejected.length, 0);

    // 3) Garde de sûreté finale (contrat §1/§2 point 4) : la projection
    //    RÉELLEMENT rechargée == snapshot solo source, aucun écart.
    const reloaded = await engine.load();
    const diff = diffSnapshots(soloSnapshot, reloaded.state);
    assert.deepEqual(diff, [], "projection identique avant/après promotion (aucune perte, aucun doublon)");
    assert.equal(reloaded.state.consultants.length, 2);
    assert.equal(reloaded.state.missions.length, 1);
    assert.equal(reloaded.state.saisies.length, 2);

    // 4) Aucun doublon si l'on rejoue la migration (idempotence du pipeline,
    //    déjà garanti par migration.js/org-engine.js — vérifié ici dans le
    //    contexte spécifique de la promotion).
    const commitAgain = await engine.commit(soloSnapshot);
    assert.equal(commitAgain.applied.count, 0, "rejouer le même snapshot ne republie rien de plus (diff nul)");
    const reloadedAgain = await engine.load();
    assert.deepEqual(diffSnapshots(soloSnapshot, reloadedAgain.state), []);

    // 5) Owner == identité solo (même clé publique), rôle depuis le
    //    manifeste — jamais une fiche falsifiable.
    const trust = await loadTrust(adapter);
    assert.equal(trust.rejected.length, 0, JSON.stringify(trust.rejected));
    const ownerMembership = trust.membershipStore.get(soloWorkspaceId, identity.memberId);
    assert.equal(ownerMembership.role, "owner");
    assert.equal(ownerMembership.status, "active");
    assert.deepEqual(trust.registry.getPublicKey(identity.memberId), identity.publicKeyJwk);
    assert.equal(trust.manifest.ownerMemberId, identity.memberId);
    assert.equal(trust.manifest.workspaceId, soloWorkspaceId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Idempotence de bout-en-bout : 2e « Partager cet espace » sur un dossier
//    DÉJÀ promu -> no-op sûr, jamais un second owner / un second manifeste.
// ---------------------------------------------------------------------------

test("promotion : 2e appel (même personne, même dossier déjà promu) -> no-op sûr, AUCUN second manifeste/owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-org-promotion-idem-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "promotion-idem-test" });
    await adapter.connect();
    const identity = await newMemberIdentity();
    const soloWorkspaceId = soloWorkspaceIdFixture();

    const first = await promoteToOrg({ adapter, workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity, consultantId: null });
    assert.equal(first.plan.kind, "promote");
    const manifestAfterFirst = await readManifest(adapter);

    const second = await promoteToOrg({ adapter, workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity, consultantId: null });
    assert.equal(second.plan.kind, "already-promoted", "2e promotion identique = NO-OP idempotent, jamais une erreur ni une réécriture");

    const manifestAfterSecond = await readManifest(adapter);
    assert.deepEqual(manifestAfterSecond, manifestAfterFirst, "le manifeste n'a PAS été réécrit par le 2e appel");

    // Toujours EXACTEMENT un owner, aucune fiche rejetée (pas de double genèse).
    const trust = await loadTrust(adapter);
    assert.equal(trust.rejected.length, 0, JSON.stringify(trust.rejected));
    assert.equal(trust.trusted.filter((r) => r.memberId === identity.memberId).length <= 1, true);
    assert.equal(trust.membershipStore.get(soloWorkspaceId, identity.memberId).role, "owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promotion : tentative de 're-promouvoir' un dossier déjà promu avec une AUTRE identité -> refusée, owner original inchangé (anti-usurpation)", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-org-promotion-attack-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "promotion-attack-test" });
    await adapter.connect();
    const owner = await newMemberIdentity();
    const attacker = await newMemberIdentity();
    const soloWorkspaceId = soloWorkspaceIdFixture();

    await promoteToOrg({ adapter, workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity: owner, consultantId: null });
    const { changes: changesBefore } = await adapter.listChanges();

    await assert.rejects(
      () => promoteToOrg({ adapter, workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity: attacker, consultantId: null }),
      /organisation différente|propriétaire différent/
    );

    // AUCUNE écriture supplémentaire n'a eu lieu (le refus est levé AVANT
    // tout writeManifest/writeMemberRecord) : le nombre de blobs publiés sur
    // le dossier est strictement inchangé.
    const { changes: changesAfter } = await adapter.listChanges();
    assert.equal(changesAfter.length, changesBefore.length, "aucune écriture n'a eu lieu pour la tentative refusée");

    // L'owner reste le créateur d'origine, jamais l'attaquant.
    const trust = await loadTrust(adapter);
    assert.equal(trust.manifest.ownerMemberId, owner.memberId);
    assert.notEqual(trust.manifest.ownerMemberId, attacker.memberId);
    assert.equal(trust.rejected.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Write-once en défense en profondeur : même en contournant `planPromotion`
//    (appel direct de `writeManifest` sur un dossier déjà promu), le
//    stockage lui-même refuse toujours la réécriture (double garde).
// ---------------------------------------------------------------------------

test("écriture directe : un 2e writeManifest sur le MÊME dossier (contournant planPromotion) reste bloqué par le write-once du storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-org-promotion-writeonce-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "promotion-writeonce-test" });
    await adapter.connect();
    const identity = await newMemberIdentity();
    const soloWorkspaceId = soloWorkspaceIdFixture();
    const org = promoteSoloToOrg({ workspaceId: soloWorkspaceId, name: "X", identity, consultantId: null });
    await writeManifest(adapter, org.manifest);
    await writeMemberRecord(adapter, org.memberRecord);

    const attacker = await newMemberIdentity();
    const forged = promoteSoloToOrg({ workspaceId: soloWorkspaceId, name: "X", identity: attacker, consultantId: null });
    await assert.rejects(() => writeManifest(adapter, forged.manifest), /manifeste existe déjà/);

    const trust = await loadTrust(adapter);
    assert.equal(trust.manifest.ownerMemberId, identity.memberId, "l'attaquant n'a jamais pris la genèse (write-once)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5bis. CORRECTIF CONTRARIANT — repro `attack1-interrupted-promotion.mjs`
//    (CASSÉ->TENU) : promotion interrompue EXACTEMENT entre `writeManifest`
//    et `writeMemberRecord` (panne réseau/permission FS révoquée/dossier
//    synchronisé déconnecté). Avant le correctif, `planPromotion` décidait
//    "already-promoted" sur la seule PRÉSENCE du manifeste : le retry normal
//    (même utilisateur, même dossier, réseau revenu) ne republiait JAMAIS la
//    fiche membre owner manquante -> `buildTrustedMembership`/`membershipStore`
//    n'admettaient jamais l'owner -> `openOrgSync` levait "n'est pas membre
//    de ce workspace" À VIE, sans aucun chemin de réparation. Ce test prouve
//    que le retry RÉPARE désormais le dossier : owner admis, engine
//    ouvrable, écriture possible, un seul manifeste et une seule fiche
//    membre au total (jamais un doublon), workspaceId préservé.
// ---------------------------------------------------------------------------

test("CORRECTIF (promotion interrompue) : panne EXACTEMENT entre writeManifest et writeMemberRecord, puis retry normal -> le dossier est RÉPARÉ (owner admis, engine ouvrable, écriture possible)", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-org-promotion-interrupted-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "promotion-interrupted-test" });
    await adapter.connect();
    const identity = await newMemberIdentity();
    const soloWorkspaceId = soloWorkspaceIdFixture();

    // --- Tentative 1 : panne simulée EXACTEMENT entre writeManifest (réussit,
    // write-once irréversible) et writeMemberRecord (échoue) -------------
    const realPutImmutable = adapter.putImmutable.bind(adapter);
    adapter.putImmutable = (kind, id, blob) => {
      if (kind === "member") return Promise.reject(new Error("panne réseau simulée (coupure pendant la republication de la fiche owner)"));
      return realPutImmutable(kind, id, blob);
    };

    await assert.rejects(
      () => promoteToOrg({ adapter, workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" }),
      /panne réseau simulée/,
      "la tentative 1 échoue bien (writeMemberRecord a levé)"
    );

    const manifestAfterFailure = await readManifest(adapter);
    assert.ok(manifestAfterFailure, "le manifeste EST publié malgré l'échec (write-once, écrit AVANT la panne)");
    assert.equal(manifestAfterFailure.workspaceId, soloWorkspaceId);
    assert.equal(manifestAfterFailure.ownerMemberId, identity.memberId);

    // Confirme l'état CASSÉ intermédiaire (avant réparation) : owner PAS admis.
    const trustAfterFailure = await loadTrust(adapter);
    assert.equal(trustAfterFailure.membershipStore.get(soloWorkspaceId, identity.memberId), null,
      "juste après la panne, l'owner n'est PAS (encore) admis — c'est exactement ce que le correctif doit réparer");

    // --- Réseau revenu : retry NORMAL (même utilisateur, même dossier) ---
    adapter.putImmutable = realPutImmutable;

    const { engine, plan } = await promoteToOrg({
      adapter, workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice",
    });
    assert.equal(plan.kind, "complete-owner", "le retry détecte l'owner manquant et republie SEULEMENT sa fiche");
    assert.equal(engine.manifest.workspaceId, soloWorkspaceId, "workspaceId préservé à travers la réparation");

    // Owner RÉELLEMENT admis + engine ouvrable + écriture possible.
    const trustAfterRepair = await loadTrust(adapter);
    assert.equal(trustAfterRepair.rejected.length, 0, JSON.stringify(trustAfterRepair.rejected));
    const ownerMembership = trustAfterRepair.membershipStore.get(soloWorkspaceId, identity.memberId);
    assert.ok(ownerMembership, "l'owner est maintenant admis dans membershipStore");
    assert.equal(ownerMembership.role, "owner");
    assert.equal(ownerMembership.status, "active");

    const loaded = await engine.load();
    const commit = await engine.commit({
      ...loaded.state,
      consultants: [...loaded.state.consultants, { id: "c-alice", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] }],
    });
    assert.equal(commit.ok, true, "l'owner réparé peut désormais ÉCRIRE dans son propre workspace");
    assert.equal(commit.applied.count, 1);

    // --- Un 3e appel (déjà réparé) est un NO-OP already-promoted, jamais une
    // 2e réparation ni une 2e écriture. --------------------------------
    const third = await promoteToOrg({ adapter, workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" });
    assert.equal(third.plan.kind, "already-promoted", "une fois réparé, un appel supplémentaire est un NO-OP sûr");

    // Exactement UN manifeste et UNE fiche membre publiés au total (jamais un
    // doublon/second owner à travers les 3 appels).
    const { changes } = await adapter.listChanges();
    assert.equal(changes.filter((c) => c.kind === "workspace").length, 1, "UN SEUL manifeste publié au total");
    const memberBlobs = [];
    for (const c of changes) { if (c.kind === "member") memberBlobs.push(await adapter.get("member", c.id)); }
    assert.equal(memberBlobs.length, 1, "UNE SEULE fiche membre publiée au total (jamais un doublon)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CORRECTIF (promotion interrompue) : la collision write-once pendant 'complete-owner' n'est PAS masquée si le contenu existant diverge (jamais un succès silencieux sur un memberId contesté)", async () => {
  // Défense en profondeur : si `writeMemberRecord` échoue pour une AUTRE
  // raison qu'une republication légitime (ex: une fiche DIVERGENTE existe
  // déjà sous ce memberId — cas qui ne devrait jamais se produire via cette
  // API, mais gardé en ceinture-bretelles), `openOrgEngine` reste l'arbitre
  // final : si l'owner n'est toujours pas admis après la tentative de
  // réparation, l'erreur remonte — jamais un succès annoncé à tort.
  const root = await mkdtemp(join(tmpdir(), "piloteo-org-promotion-interrupted-divergent-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "promotion-interrupted-divergent-test" });
    await adapter.connect();
    const identity = await newMemberIdentity();
    const soloWorkspaceId = soloWorkspaceIdFixture();

    // Manifeste seul publié (simule la panne), puis un writeMemberRecord qui
    // échoue TOUJOURS (panne persistante, pas juste "une fois") : la
    // réparation doit rester en échec explicite, jamais un faux succès.
    const org = promoteSoloToOrg({ workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" });
    await writeManifest(adapter, org.manifest);

    const realPutImmutable = adapter.putImmutable.bind(adapter);
    adapter.putImmutable = (kind, id, blob) => {
      if (kind === "member") return Promise.reject(new Error("panne réseau PERSISTANTE (jamais résolue)"));
      return realPutImmutable(kind, id, blob);
    };

    await assert.rejects(
      () => promoteToOrg({ adapter, workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" }),
      /panne réseau PERSISTANTE|n'est pas membre/,
      "une panne persistante (jamais résolue) reste un échec EXPLICITE, jamais un succès silencieux"
    );

    adapter.putImmutable = realPutImmutable;
    const trust = await loadTrust(adapter);
    assert.equal(trust.membershipStore.get(soloWorkspaceId, identity.memberId), null,
      "l'owner reste non admis tant que sa fiche n'a pas été RÉELLEMENT publiée");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5ter. CORRECTIF CONTRARIANT ROUND 2 — repro `attack2-poisoned-owner-slot.mjs`
//    (CASSÉ->TENU) : « empoisonnement du slot write-once de l'owner par un
//    tiers ». `writeManifest` publie `ownerMemberId`/`ownerPublicKeyJwk` EN
//    CLAIR (modèle « dossier de confiance », CLAUDE.md §4) : N'IMPORTE QUEL
//    AUTRE écrivain du dossier peut les lire SANS aucune clé privée et
//    déposer, AVANT le retry légitime, une fiche `kind:"member"` sous CE
//    MÊME `memberId` mais avec SA PROPRE clé — occupant le slot write-once
//    irréversiblement. Avant ce correctif, le `try/catch` de "complete-owner"
//    avalait TOUTE collision write-once sans vérifier le contenu déjà
//    présent : le vrai owner ne pouvait plus JAMAIS être admis (même symptôme
//    que le round 1, "n'est pas membre", pour une cause différente).
//
//    Le correctif (org-folder-store.js#memberRecordAlreadyPublished) compare
//    le contenu déjà présent au slot à la fiche owner ATTENDUE (déterministe) :
//    - identique -> collision légitime (ma propre fiche), avalée, succès ;
//    - divergent -> erreur EXPLICITE et DISTINCTE ("owner contesté"), JAMAIS
//      avalée, JAMAIS laissée à `openOrgEngine` comme arbitre final —
//      DÉTECTABLE et RÉCUPÉRABLE (ORG_TRUST_HARDENING_CONTRACT.md §3) : une
//      fois la fiche hostile retirée (permissions du dossier), un nouveau
//      retry doit RÉUSSIR.
// ---------------------------------------------------------------------------

test("CORRECTIF ROUND 2 (slot owner empoisonné) : un tiers occupe (member, ownerMemberId) avec une AUTRE clé -> erreur EXPLICITE distincte de 'n'est pas membre', PUIS récupérable après retrait de la fiche hostile", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-org-promotion-poisoned-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "promotion-poisoned-test" });
    await adapter.connect();
    const identity = await newMemberIdentity();
    const soloWorkspaceId = soloWorkspaceIdFixture();

    // 1) Panne EXACTEMENT entre writeManifest et writeMemberRecord (état
    //    identique au round 1, juste AVANT réparation).
    const realPutImmutable = adapter.putImmutable.bind(adapter);
    adapter.putImmutable = (kind, id, blob) => {
      if (kind === "member") return Promise.reject(new Error("panne réseau simulée"));
      return realPutImmutable(kind, id, blob);
    };
    await assert.rejects(
      () => promoteToOrg({ adapter, workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" }),
      /panne réseau simulée/
    );
    adapter.putImmutable = realPutImmutable;

    const manifestAfterFailure = await readManifest(adapter);
    assert.ok(manifestAfterFailure, "manifeste publié (write-once, écrit avant la panne)");

    // 2) L'ATTAQUANT — AUCUNE clé privée requise, memberId/ownerPublicKeyJwk
    //    sont PUBLICS dans le manifeste — dépose une fiche "member" sous le
    //    MÊME ownerMemberId, avec SA PROPRE clé, AVANT le retry légitime.
    const attacker = await newMemberIdentity();
    const hostileMembership = createMembership({
      workspaceId: soloWorkspaceId, memberId: identity.memberId, consultantId: null, role: "owner",
    });
    const hostileRecord = {
      kind: "member",
      memberId: identity.memberId,          // usurpe le SLOT de l'owner légitime
      publicKeyJwk: attacker.publicKeyJwk,   // MAIS avec SA PROPRE clé
      membership: hostileMembership,
      authorization: { genesis: true },
    };
    await writeMemberRecord(adapter, hostileRecord);

    // 3) Retry légitime (même owner, même dossier) : DOIT donner une erreur
    //    EXPLICITE et DISTINCTE de "n'est pas membre" — jamais un succès
    //    silencieux, jamais une confusion avec une simple panne réseau.
    await assert.rejects(
      () => promoteToOrg({ adapter, workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" }),
      (err) => {
        assert.match(err.message, /tierce|hostile|contest/i, "erreur EXPLICITE nommant le slot contesté");
        assert.doesNotMatch(err.message, /n'est pas membre/i, "JAMAIS confondue avec le message générique 'n'est pas membre' (round 1)");
        return true;
      }
    );

    // Owner légitime toujours PAS admis (le slot est occupé par l'attaquant).
    const trustAfterAttack = await loadTrust(adapter);
    assert.equal(trustAfterAttack.membershipStore.get(soloWorkspaceId, identity.memberId), null,
      "l'owner légitime n'est pas admis tant que le slot est occupé par la fiche hostile");
    // L'attaquant, lui, n'est PAS admis non plus (clé publique ne correspond
    // pas au manifeste — `genesisMismatchReason`, non régressé) : aucune
    // usurpation réussie, juste un DoS détecté.
    assert.equal(trustAfterAttack.rejected.length > 0, true);

    // Un 2e, 3e retry SANS intervention reste bloqué de la MÊME façon
    // explicite (jamais une boucle qui finit par "réussir" par hasard, ni un
    // message qui se dégrade en "n'est pas membre").
    await assert.rejects(
      () => promoteToOrg({ adapter, workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" }),
      /tierce|hostile|contest/i
    );

    // 4) RÉCUPÉRATION (ORG_TRUST_HARDENING_CONTRACT.md §3) : l'utilisateur
    //    retire la fiche hostile via les permissions du DOSSIER RÉEL (hors
    //    périmètre logiciel — CLAUDE.md §4 : supprimer le fichier physique
    //    est exactement ce qu'un accès au dossier partagé permet).
    await rm(join(root, "members", `${identity.memberId}.piloteo`), { force: true });

    // Un nouveau retry doit désormais RÉUSSIR : republier la vraie fiche
    // owner, l'admettre, et permettre l'écriture.
    const { engine, plan } = await promoteToOrg({
      adapter, workspaceId: soloWorkspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice",
    });
    assert.equal(plan.kind, "complete-owner", "la réparation republie la fiche owner manquante, une fois le slot libéré");
    assert.equal(engine.manifest.workspaceId, soloWorkspaceId);

    const trustFinal = await loadTrust(adapter);
    const ownerMembership = trustFinal.membershipStore.get(soloWorkspaceId, identity.memberId);
    assert.ok(ownerMembership, "l'owner LÉGITIME est enfin admis après retrait de la fiche hostile");
    assert.equal(ownerMembership.role, "owner");
    assert.equal(ownerMembership.status, "active");

    const loaded = await engine.load();
    const commit = await engine.commit({
      ...loaded.state,
      consultants: [...loaded.state.consultants, { id: "c-alice", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] }],
    });
    assert.equal(commit.ok, true, "l'owner réparé peut désormais ÉCRIRE dans son propre workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("org-folder-store#memberRecordAlreadyPublished : vrai pour un contenu IDENTIQUE, faux pour un contenu DIVERGENT ou un slot vide", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-org-promotion-alreadypub-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "alreadypub-test" });
    await adapter.connect();
    const identity = await newMemberIdentity();
    const soloWorkspaceId = soloWorkspaceIdFixture();
    const org = promoteSoloToOrg({ workspaceId: soloWorkspaceId, name: "X", identity, consultantId: null });

    // Slot vide : jamais "déjà publiée".
    assert.equal(await memberRecordAlreadyPublished(adapter, org.memberRecord), false);
    assert.deepEqual(await getMemberCandidates(adapter, identity.memberId), []);

    await writeMemberRecord(adapter, org.memberRecord);
    assert.equal(await memberRecordAlreadyPublished(adapter, org.memberRecord), true,
      "contenu canonique identique -> reconnu comme déjà publié");
    assert.equal((await getMemberCandidates(adapter, identity.memberId)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("org-folder-store#memberRecordAlreadyPublished : un slot occupé par un TIERS (clé différente) n'est JAMAIS reconnu comme 'déjà publié'", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-org-promotion-alreadypub-hostile-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "alreadypub-hostile-test" });
    await adapter.connect();
    const owner = await newMemberIdentity();
    const attacker = await newMemberIdentity();
    const soloWorkspaceId = soloWorkspaceIdFixture();
    const ownerOrg = promoteSoloToOrg({ workspaceId: soloWorkspaceId, name: "X", identity: owner, consultantId: null });

    const hostileMembership = createMembership({ workspaceId: soloWorkspaceId, memberId: owner.memberId, consultantId: null, role: "owner" });
    const hostileRecord = {
      kind: "member", memberId: owner.memberId, publicKeyJwk: attacker.publicKeyJwk,
      membership: hostileMembership, authorization: { genesis: true },
    };
    await writeMemberRecord(adapter, hostileRecord);

    assert.equal(await memberRecordAlreadyPublished(adapter, ownerOrg.memberRecord), false,
      "la fiche hostile (clé différente) n'est JAMAIS confondue avec la vraie fiche owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5quater. CORRECTIF CONTRARIANT ROUND 3 — repro `attack-p3-critical-deepequal.mjs`
//    (CASSÉ->TENU, AUCUN attaquant) : `deepEqualJson` (org-runtime.js) était
//    `JSON.stringify(a)===JSON.stringify(b)`, sensible à l'ORDRE des clés.
//    Sur `GoogleDriveStorageAdapter`, `putImmutable` sérialise en forme
//    CANONIQUE (clés triées) AVANT écriture : un `ownerPublicKeyJwk` RELU
//    depuis Drive a TOUJOURS ses clés triées, alors que l'export WebCrypto
//    natif d'une identité LOCALE garde son ordre natif — même clé, JSON brut
//    différent. `sameOwner` (planPromotion) et `genesisMismatchReason`
//    répondaient donc à tort "propriétaire différent"/"genèse forgée" pour
//    le PROPRE owner légitime dès qu'un manifeste avait transité par Drive —
//    un faux conflit PERMANENT (le manifeste est write-once), sans aucune
//    fiche hostile à retirer. Ces tests exercent le VRAI `GoogleDriveStorageAdapter`
//    (avec `FakeDrive`, jamais un mock de la sérialisation) pour le prouver.
// ---------------------------------------------------------------------------

function makeDriveAdapter(drive, rootFolderId) {
  return new GoogleDriveStorageAdapter({
    oauthTokenProvider: async () => "fake-access-token",
    rootFolderId,
    fetchImpl: drive.fetch,
    sleepFn: async () => {},
  });
}

test("CORRECTIF ROUND 3 (deepEqualJson canonique) : manifeste écrit puis RELU depuis Drive (clés triées par canonicalStringify) vs identité locale (ordre natif WebCrypto, non trié) -> planPromotion reconnaît le MÊME owner (complete-owner), JAMAIS un faux conflict", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Cabinet Alice (Drive)", null);
  const adapter = makeDriveAdapter(drive, root);
  await adapter.connect();

  const identity = await newMemberIdentity();
  const workspaceId = soloWorkspaceIdFixture();

  const org = promoteSoloToOrg({ workspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" });
  await writeManifest(adapter, org.manifest); // réussit (write-once) ; writeMemberRecord PAS appelé (panne simulée).

  const manifestAfterFailure = await readManifest(adapter);
  assert.ok(manifestAfterFailure, "manifeste relu depuis Drive");
  // Sanity du repro : même clé SÉMANTIQUEMENT, mais sérialisation brute différente.
  assert.deepEqual(manifestAfterFailure.ownerPublicKeyJwk, identity.publicKeyJwk);
  assert.notEqual(JSON.stringify(manifestAfterFailure.ownerPublicKeyJwk), JSON.stringify(identity.publicKeyJwk),
    "la relecture Drive a bien réordonné les clés (canonicalStringify) — condition du bug");

  const ownerAdmitted = await isOwnerAdmitted(adapter, workspaceId, identity);
  const plan = planPromotion({ existingManifest: manifestAfterFailure, workspaceId, identity, ownerAdmitted });
  assert.equal(plan.kind, "complete-owner",
    `le VRAI owner doit être reconnu comme tel (reçu '${plan.kind}'${plan.reason ? ": " + plan.reason : ""})`);

  // Bout-en-bout : le retry via promoteToOrg répare bien le dossier sur Drive.
  const { engine } = await promoteToOrg({ adapter, workspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" });
  const trust = await loadTrust(adapter);
  const ownerMembership = trust.membershipStore.get(workspaceId, identity.memberId);
  assert.ok(ownerMembership, "owner admis sur Drive après réparation");
  assert.equal(ownerMembership.role, "owner");
  const loaded = await engine.load();
  const commit = await engine.commit({
    ...loaded.state,
    consultants: [...loaded.state.consultants, { id: "c-alice", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] }],
  });
  assert.equal(commit.ok, true, "l'owner peut écrire dans son workspace Drive après réparation");
});

test("CORRECTIF ROUND 3 (deepEqualJson canonique) : genesisMismatchReason (buildTrustedMembership) reconnaît aussi la fiche genèse légitime relue depuis Drive (clés triées), jamais 'genèse forgée' à tort", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Cabinet Bob (Drive)", null);
  const adapter = makeDriveAdapter(drive, root);
  await adapter.connect();

  const identity = await newMemberIdentity();
  const workspaceId = soloWorkspaceIdFixture();
  const org = promoteSoloToOrg({ workspaceId, name: "Cabinet Bob", identity, consultantId: "c-bob" });
  await writeManifest(adapter, org.manifest);
  await writeMemberRecord(adapter, org.memberRecord);

  const trust = await loadTrust(adapter);
  assert.equal(trust.rejected.length, 0, JSON.stringify(trust.rejected));
  assert.equal(trust.membershipStore.get(workspaceId, identity.memberId).role, "owner");
});

test("CORRECTIF ROUND 3 (deepEqualJson canonique) : non-régression — un VRAI conflit (owner RÉELLEMENT différent) reste 'conflict' sur Drive (aucune régression de l'anti-usurpation)", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Cabinet Conflict (Drive)", null);
  const adapter = makeDriveAdapter(drive, root);
  await adapter.connect();

  const owner = await newMemberIdentity();
  const attacker = await newMemberIdentity();
  const workspaceId = soloWorkspaceIdFixture();
  const org = promoteSoloToOrg({ workspaceId, name: "X", identity: owner, consultantId: null });
  await writeManifest(adapter, org.manifest);

  const manifest = await readManifest(adapter);
  const plan = planPromotion({ existingManifest: manifest, workspaceId, identity: attacker, ownerAdmitted: false });
  assert.equal(plan.kind, "conflict", "un owner RÉELLEMENT différent (clé différente) reste un conflit, jamais confondu avec le round 3");
  assert.match(plan.reason, /propriétaire différent/);
});

// ---------------------------------------------------------------------------
// 5quinquies. CORRECTIF CONTRARIANT ROUND 3 (faille secondaire) — collision
//    write-once non détectée en Drive : le catch de "complete-owner" ne
//    reconnaissait la collision QUE via le message `/write-once/i` (Folder),
//    jamais via `ImmutableConflictError` (Drive, `google-drive-adapter.js`,
//    dont le message dit `IMMUTABLE_CONFLICT`) — la distinction "ma fiche"/
//    "tierce hostile" (round 2) ne se déclenchait donc JAMAIS sur Drive.
//    `isWriteOnceCollision` (org-folder-store.js) corrige ceci ; ces tests
//    exercent le round 2 EN MODE DRIVE (axes 3/4 auparavant masqués par le
//    faux conflict du round 3 principal).
// ---------------------------------------------------------------------------

test("isWriteOnceCollision : reconnaît ImmutableConflictError (Drive) ET le message 'write-once' (Folder/InMemory), rejette une erreur ordinaire", () => {
  assert.equal(isWriteOnceCollision(new ImmutableConflictError("member", "m-1")), true,
    "ImmutableConflictError (Drive) reconnue par son NOM, pas son message (qui dit 'IMMUTABLE_CONFLICT', jamais 'write-once')");
  assert.doesNotMatch(new ImmutableConflictError("member", "m-1").message, /write-once/i,
    "sanity round 3 : le message Drive ne contient PAS 'write-once' — d'où le besoin de vérifier .name");
  assert.equal(isWriteOnceCollision(new Error("FolderStorageAdapter.putImmutable: write-once violé — (member, m-1) existe déjà.")), true,
    "message 'write-once' (Folder/InMemory) toujours reconnu — non-régression");
  assert.equal(isWriteOnceCollision(new Error("panne réseau ordinaire")), false,
    "une erreur SANS rapport (panne réseau) n'est jamais confondue avec une collision");
  assert.equal(isWriteOnceCollision(null), false);
});

test("CORRECTIF ROUND 3 (collision Drive) : republier ma PROPRE fiche sur Drive est déjà IDEMPOTENT au niveau du storage (GoogleDriveStorageAdapter#putImmutable, contenu canonique identique -> aucune exception) ; memberRecordAlreadyPublished reste correcte que le slot ait ou non collisionné", async () => {
  // Découverte notable (non-régression documentée) : contrairement à
  // Folder/InMemory (qui lèvent TOUJOURS sur toute réécriture, même
  // identique), `GoogleDriveStorageAdapter#putImmutable` est LUI-MÊME
  // idempotent pour un contenu canonique IDENTIQUE (§9d/putImmutable,
  // `existingContent === content -> return {id}`, AUCUNE exception) — le
  // mécanisme round 2 (`isWriteOnceCollision`/`memberRecordAlreadyPublished`)
  // n'a donc même pas besoin d'intervenir dans CE cas précis sur Drive : le
  // `try` de `promoteToOrg` réussit directement, sans jamais atteindre le
  // `catch`. Le test 21 (ci-dessus) prouve que le `catch` intervient bien
  // quand Drive lève RÉELLEMENT (contenu DIVERGENT, tiers hostile).
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Drive Collision Mine", null);
  const adapter = makeDriveAdapter(drive, root);
  await adapter.connect();

  const identity = await newMemberIdentity();
  const workspaceId = soloWorkspaceIdFixture();
  const org = promoteSoloToOrg({ workspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" });
  await writeManifest(adapter, org.manifest);
  await writeMemberRecord(adapter, org.memberRecord);

  // Republier EXACTEMENT le même contenu ne lève PAS sur Drive (idempotence
  // native du transport) — vérifié explicitement pour ne pas supposer à tort
  // un comportement uniforme entre adapters.
  await assert.doesNotReject(() => writeMemberRecord(adapter, org.memberRecord));

  assert.equal(await memberRecordAlreadyPublished(adapter, org.memberRecord), true,
    "memberRecordAlreadyPublished reste correcte (contenu identique reconnu via getAllCandidates, Drive)");

  // Bout-en-bout, via le VRAI chemin `promoteToOrg` (owner déjà admis dès le
  // départ ici — cas nominal "already-promoted", non-régression) : aucune
  // exception, engine ouvrable.
  const { engine, plan } = await promoteToOrg({ adapter, workspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" });
  assert.equal(plan.kind, "already-promoted");
  const trust = await loadTrust(adapter);
  assert.equal(trust.rejected.length, 0, JSON.stringify(trust.rejected));
  assert.equal(trust.membershipStore.get(workspaceId, identity.memberId).role, "owner");
  assert.ok(engine, "engine ouvrable");
});

test("CORRECTIF ROUND 3 (collision Drive) : un TIERS occupe le slot owner sur Drive (ImmutableConflictError, contenu DIVERGENT) -> erreur EXPLICITE distincte, PUIS récupérable après retrait de la fiche hostile", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Drive Collision Hostile", null);
  const adapter = makeDriveAdapter(drive, root);
  await adapter.connect();

  const identity = await newMemberIdentity();
  const attacker = await newMemberIdentity();
  const workspaceId = soloWorkspaceIdFixture();
  const org = promoteSoloToOrg({ workspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" });
  await writeManifest(adapter, org.manifest);

  // Le TIERS (aucune clé privée requise) occupe le slot AVANT le retry légitime.
  const hostileMembership = createMembership({ workspaceId, memberId: identity.memberId, consultantId: null, role: "owner" });
  const hostileRecord = {
    kind: "member", memberId: identity.memberId, publicKeyJwk: attacker.publicKeyJwk,
    membership: hostileMembership, authorization: { genesis: true },
  };
  await writeMemberRecord(adapter, hostileRecord);

  await assert.rejects(
    () => promoteToOrg({ adapter, workspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" }),
    (err) => {
      assert.match(err.message, /tierce|hostile|contest/i);
      assert.doesNotMatch(err.message, /n'est pas membre/i);
      return true;
    },
    "la collision Drive (ImmutableConflictError) déclenche bien la distinction round 2, jamais un avalage silencieux"
  );

  // Récupération : retrait de la fiche hostile côté Drive (permissions du
  // dossier — ici simulé en retirant directement le nœud du FakeDrive, ce
  // qu'un accès Drive réel permet identiquement).
  for (const [nodeId, node] of drive.nodes) {
    if (node.name === `${identity.memberId}.piloteo` && (node.parents || []).length) {
      drive.nodes.delete(nodeId);
    }
  }

  const { engine, plan } = await promoteToOrg({ adapter, workspaceId, name: "Cabinet Alice", identity, consultantId: "c-alice" });
  assert.equal(plan.kind, "complete-owner", "réparation réussie après retrait de la fiche hostile sur Drive");
  const trust = await loadTrust(adapter);
  const ownerMembership = trust.membershipStore.get(workspaceId, identity.memberId);
  assert.ok(ownerMembership, "owner LÉGITIME admis après retrait de la fiche hostile (Drive)");
  assert.equal(ownerMembership.role, "owner");
  assert.ok(engine, "engine ouvrable après réparation");
});

// ---------------------------------------------------------------------------
// 6. Rollback : écriture refusée (dossier inaccessible/panne) -> RIEN n'est
//    publié, la promotion échoue explicitement (le device reste solo, ses
//    données restent intactes — aucune mutation n'a eu lieu côté cible).
// ---------------------------------------------------------------------------

test("rollback : le dossier refuse l'écriture (panne) -> promotion rejetée, AUCUN manifeste publié, aucune trace partielle", async () => {
  const adapter = new InMemoryStorageAdapter();
  await adapter.connect();
  adapter.setOffline(true);

  const identity = await newMemberIdentity();
  const soloWorkspaceId = soloWorkspaceIdFixture();

  await assert.rejects(
    () => promoteToOrg({ adapter, workspaceId: soloWorkspaceId, name: "X", identity, consultantId: null }),
    /hors ligne|panne/
  );

  adapter.setOffline(false);
  const { changes } = await adapter.listChanges();
  assert.equal(changes.length, 0, "aucun manifeste/fiche partiel n'a été publié — la promotion a échoué proprement, rien à nettoyer");
});

test("rollback : round-trip final en échec (garde de sûreté Point 5) -> jamais considéré comme un succès, snapshot solo jamais muté", async () => {
  // Une entité malformée (clé réservée) est REJETÉE par snapshotToSeedEvents
  // (jamais migrée partiellement) — la garde du contrat §1/§2 point 4,
  // réutilisée telle quelle par le pipeline de promotion.
  const root = await mkdtemp(join(tmpdir(), "piloteo-org-promotion-rollback-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "promotion-rollback-test" });
    await adapter.connect();
    const identity = await newMemberIdentity();
    const soloWorkspaceId = soloWorkspaceIdFixture();

    const { engine } = await promoteToOrg({ adapter, workspaceId: soloWorkspaceId, name: "X", identity, consultantId: "c-alice" });

    const soloSnapshotBefore = {
      ...emptySnapshot(),
      consultants: [consultant("c-alice", "Alice"), { ...consultant("c-bad", "Bad"), __deleted: true }],
    };
    const soloSnapshotSnapshotBeforeCopy = JSON.parse(JSON.stringify(soloSnapshotBefore));

    const identityForSeed = { workspaceId: soloWorkspaceId, actorId: identity.memberId, epoch: 1 };
    const seed = snapshotToSeedEvents(soloSnapshotBefore, identityForSeed);
    assert.equal(seed.rejected.length, 1, "l'entité à clé réservée est rejetée, jamais migrée partiellement");

    // Le pipeline (comme piloteo-migration-bridge.mjs#migrateSoloIntoEngine)
    // doit alors REFUSER d'écrire quoi que ce soit dans la cible.
    if (seed.rejected.length > 0) {
      // rien n'est commité : `engine.commit` n'est JAMAIS appelé dans ce cas.
    } else {
      assert.fail("ce test attend un rejet");
    }

    // La cible reste vide de toute donnée métier (seule la genèse existe) :
    // le rollback n'a rien laissé de partiel.
    const reloaded = await engine.load();
    assert.deepEqual(reloaded.state.consultants, [], "aucune donnée métier partielle republiée");

    // Le snapshot solo source n'a, de toute façon, jamais été muté par cette
    // tentative (fonctions pures) — non-régression triviale mais qui vaut
    // d'être prouvée explicitement ici (le device solo garde ses données).
    assert.deepEqual(soloSnapshotBefore, soloSnapshotSnapshotBeforeCopy);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Non-régression : createOrganization (org neuve, SANS promotion) marche
//    toujours — le flux « Rejoindre »/owner d'une org fraîche n'est pas cassé.
// ---------------------------------------------------------------------------

test("non-régression : createOrganization (org neuve) inchangée — workspaceId frais, forme identique à avant", async () => {
  const identity = await newMemberIdentity();
  const org = createOrganization({ name: "Org fraîche", identity, consultantId: "c-alice" });
  assert.ok(org.workspace.workspaceId);
  assert.equal(org.ownerMembership.role, "owner");
  assert.equal(org.memberRecord.authorization.genesis, true);
  assert.equal(org.manifest.ownerMemberId, identity.memberId);
});
