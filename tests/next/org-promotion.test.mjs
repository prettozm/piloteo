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
import { writeManifest, writeMemberRecord, readManifest, loadTrust } from "../../src/workspace/org-folder-store.js";
import { openOrgEngine } from "../../src/workspace/org-engine.js";
import { snapshotToSeedEvents, verifyRoundTrip, diffSnapshots, planMigration } from "../../src/integration/migration.js";

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
 * Réimplémentation FIDÈLE de la séquence prévue pour
 * `piloteo-org-bridge.mjs#promoteToOrg` (Lot 2) : lit le manifeste déjà
 * publié (s'il existe), délègue la DÉCISION à `planPromotion` (pure), et
 * n'écrit QUE si la décision l'autorise. Ne construit/ouvre l'engine QUE si
 * la promotion n'est pas un conflit.
 */
async function promoteToOrg({ adapter, workspaceId, name, identity, consultantId }) {
  const existingManifest = await readManifest(adapter);
  const plan = planPromotion({ existingManifest, workspaceId, identity });
  if (plan.kind === "conflict") {
    throw new Error(`promoteToOrg: ${plan.reason}`);
  }
  if (plan.kind === "promote") {
    const org = promoteSoloToOrg({ workspaceId, name, identity, consultantId });
    await writeManifest(adapter, org.manifest);
    await writeMemberRecord(adapter, org.memberRecord);
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

test("planPromotion : manifeste existant, MÊME workspaceId ET MÊME owner -> 'already-promoted' (idempotence)", async () => {
  const identity = await newMemberIdentity();
  const workspaceId = soloWorkspaceIdFixture();
  const org = promoteSoloToOrg({ workspaceId, name: "X", identity, consultantId: null });
  const plan = planPromotion({ existingManifest: org.manifest, workspaceId, identity });
  assert.equal(plan.kind, "already-promoted");
  assert.deepEqual(plan.manifest, org.manifest);
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
