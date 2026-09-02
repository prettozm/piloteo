// tests/next/drive-promotion-bridge.test.mjs
//
// Lot 5 (docs/next/PARCOURS_IDENTITE_CONTRACT.md) — « Partager cet espace »
// vers Google Drive (promotion en place, mobile). À la différence de
// tests/next/org-promotion.test.mjs (qui RÉIMPLÉMENTE la séquence
// d'orchestration côté test parce que les ponts navigateur ne peuvent pas
// être importés facilement sous Node), ce fichier exerce le VRAI CODE des
// ponts :
//   - `piloteo-org-bridge.mjs#promoteAdapterToOrg` — le cœur ADAPTER-AGNOSTIQUE
//     extrait au Lot 5, ici exercé DIRECTEMENT sur un VRAI
//     `GoogleDriveStorageAdapter` (+ FakeDrive) ET sur un VRAI
//     `FolderStorageAdapter` (+ NodeFsPort), pour prouver qu'il s'agit bien
//     du MÊME code de décision/collision pour les deux transports (rien n'est
//     dupliqué) ;
//   - `piloteo-org-bridge.mjs#promoteToOrg` — le mince enrobage Dossier (non-
//     régression du Lot 2, via un FileSystemDirectoryHandle FACTICE en
//     mémoire, même simulateur que tests/e2e/org-promotion.mjs) ;
//   - `piloteo-drive-bridge.mjs#promoteDriveOrg` — le câblage PUBLIC Drive
//     (Lot 5) : ordre OAuth-first, `createDriveRootFolder`, persistance
//     `piloteo_storage_mode`/`piloteo_drive_root_folder_id`, identité
//     PARTAGÉE avec `piloteo-org-bridge.mjs` — OAuth (Google Identity
//     Services) et le transport réseau (`fetch` vers googleapis.com) sont
//     STUBBÉS (même patron que tests/e2e/org-onboarding-drive.mjs), AUCUN
//     appel réseau réel.
//
// Comme tests/next/drive-onboarding.test.mjs : les deux ponts référencent
// `window` au chargement (posent `window.PiloteoOrg`/`window.PiloteoDrive`) —
// on shim `globalThis.window`, `indexedDB` (fake-indexeddb, pour l'identité
// PERSISTÉE de piloteo-org-bridge.mjs) et un `localStorage` minimal AVANT de
// les importer, dans le MÊME ORDRE que index.html (org-bridge avant
// drive-bridge). `window.PILOTEO_GOOGLE_CLIENT_ID` est posé AVANT l'import de
// piloteo-drive-bridge.mjs (résolu une seule fois au chargement du module,
// comme en production) pour que `PiloteoDrive.isAvailable` soit vrai et que
// `promoteDriveOrg` (chemin RÉEL public) soit exerçable de bout en bout —
// `node --test` isole chaque fichier de test dans son PROPRE processus, donc
// ceci n'affecte pas drive-onboarding.test.mjs (qui teste, LUI, le cas
// `GOOGLE_CLIENT_ID` absent, dans son propre processus).

import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { FolderStorageAdapter } from "../../src/storage/folder-storage-adapter.js";
import { NodeFsPort } from "../../src/storage/node-fs-port.js";
import { GoogleDriveStorageAdapter } from "../../src/storage/google-drive-adapter.js";
import { writeMemberRecord, loadTrust } from "../../src/workspace/org-folder-store.js";
import { createMembership } from "../../src/workspace/memberships.js";
import { snapshotToSeedEvents, verifyRoundTrip, diffSnapshots, planMigration } from "../../src/integration/migration.js";
import { FakeDrive } from "./helpers/fake-drive.mjs";

if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
}
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map();
  globalThis.localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
  };
}
// AVANT l'import de piloteo-drive-bridge.mjs : GOOGLE_CLIENT_ID configuré ->
// PiloteoDrive.isAvailable=true, pour exercer promoteDriveOrg de bout en bout
// (chemin RÉEL public, OAuth/fetch stubbés plus bas).
globalThis.window.PILOTEO_GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const orgBridgeUrl = pathToFileURL(path.join(repoRoot, "..", "piloteo-org-bridge.mjs")).href;
const driveBridgeUrl = pathToFileURL(path.join(repoRoot, "..", "piloteo-drive-bridge.mjs")).href;
// Ordre du document `index.html` (contrat §3) : org-bridge AVANT drive-bridge.
const orgBridgeModule = await import(orgBridgeUrl);
await import(driveBridgeUrl);
const PiloteoOrg = globalThis.window.PiloteoOrg;
const PiloteoDrive = globalThis.window.PiloteoDrive;
const { promoteAdapterToOrg } = orgBridgeModule;

assert.equal(typeof promoteAdapterToOrg, "function", "sanity : piloteo-org-bridge.mjs exporte bien promoteAdapterToOrg (le cœur factorisé)");
assert.equal(PiloteoDrive.isAvailable, true, "sanity : GOOGLE_CLIENT_ID configuré -> mode Drive disponible pour ce fichier de test");

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

function makeDriveAdapter(drive, rootFolderId) {
  return new GoogleDriveStorageAdapter({
    oauthTokenProvider: async () => "fake-access-token",
    rootFolderId,
    fetchImpl: drive.fetch,
    sleepFn: async () => {},
  });
}

// Republie un snapshot solo CONTRÔLÉ sur `engine` (pipeline Point 5, réutilisé
// tel quel — jamais dupliqué) et vérifie l'aller-retour (compte + contenu),
// exactement comme le fera `local-backend.js#decideAndRunMigration`. Renvoie
// le résultat du commit pour d'éventuelles assertions supplémentaires.
async function republishAndVerify(engine, soloSnapshot, workspaceId, actorId) {
  const loadedBefore = await engine.load();
  const plan = planMigration({ soloSnapshot, targetExisting: loadedBefore.state });
  assert.equal(plan.kind, "seed", "un workspace fraîchement promu est vide -> plan de migration 'seed'");
  const seed = snapshotToSeedEvents(soloSnapshot, { workspaceId, actorId, epoch: 1 });
  assert.equal(seed.rejected.length, 0);
  assert.equal(verifyRoundTrip(soloSnapshot, seed.events).ok, true, "pré-vérification pure OK avant toute écriture");
  const commit = await engine.commit(soloSnapshot);
  assert.equal(commit.ok, true, JSON.stringify(commit.conflicts || commit.applied));
  const reloaded = await engine.load();
  assert.deepEqual(diffSnapshots(soloSnapshot, reloaded.state), [], "projection identique avant/après promotion (aucune perte, aucun doublon)");
  return { commit, reloaded };
}

// ---------------------------------------------------------------------------
// A. promoteAdapterToOrg (cœur RÉEL, export ES) sur un VRAI
//    GoogleDriveStorageAdapter + FakeDrive — Lot 5.
// ---------------------------------------------------------------------------

test("promoteAdapterToOrg (Drive, code RÉEL) : workspaceId préservé, owner = identité PARTAGÉE (PiloteoOrg), events solo republiés SANS perte/doublon", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Cabinet Drive Bridge Test", null);
  const adapter = makeDriveAdapter(drive, root);
  const workspaceId = globalThis.crypto.randomUUID();
  const identity = await PiloteoOrg.getOrCreateIdentity(); // identité PARTAGÉE, jamais une 2e fabriquée

  const result = await promoteAdapterToOrg({ adapter, workspaceId, name: "Cabinet Drive Bridge Test", consultantId: "c-alice", identity });
  assert.equal(result.manifest.workspaceId, workspaceId, "workspaceId après promotion == workspaceId solo d'origine");
  assert.equal(result.alreadyPromoted, false);
  assert.equal(result.completedOwnerRecord, false);
  assert.equal(result.identity.memberId, identity.memberId);

  const soloSnapshot = {
    ...emptySnapshot(),
    consultants: [consultant("c-alice", "Alice"), consultant("c-bob", "Bob")],
    missions: [mission("m-1", "c-alice")],
    saisies: [saisie("s-1", "c-alice"), saisie("s-2", "c-bob")],
  };
  const { commit } = await republishAndVerify(result.engine, soloSnapshot, workspaceId, identity.memberId);
  assert.equal(commit.applied.count, 5, "5 entités solo republiées (2 consultants + 1 mission + 2 saisies) sur Drive");
  assert.equal(commit.applied.rejected.length, 0);

  const trust = await loadTrust(adapter);
  assert.equal(trust.rejected.length, 0, JSON.stringify(trust.rejected));
  const ownerMembership = trust.membershipStore.get(workspaceId, identity.memberId);
  assert.equal(ownerMembership.role, "owner");
  assert.equal(ownerMembership.status, "active");
  assert.deepEqual(trust.registry.getPublicKey(identity.memberId), identity.publicKeyJwk);
});

test("promoteAdapterToOrg (Drive, code RÉEL) : idempotence — 2e appel (même dossier/identité) -> already-promoted, AUCUN second owner/manifeste", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Drive Bridge Idempotence", null);
  const adapter = makeDriveAdapter(drive, root);
  const workspaceId = globalThis.crypto.randomUUID();
  const identity = await PiloteoOrg.getOrCreateIdentity();

  const first = await promoteAdapterToOrg({ adapter, workspaceId, name: "X", consultantId: null, identity });
  assert.equal(first.alreadyPromoted, false);

  const second = await promoteAdapterToOrg({ adapter, workspaceId, name: "X", consultantId: null, identity });
  assert.equal(second.alreadyPromoted, true, "2e appel identique -> NO-OP idempotent, jamais une erreur ni une réécriture");
  assert.deepEqual(second.manifest, first.manifest, "le manifeste n'a PAS été réécrit par le 2e appel");

  const trust = await loadTrust(adapter);
  assert.equal(trust.rejected.length, 0, JSON.stringify(trust.rejected));
  assert.equal(trust.trusted.filter((r) => r.memberId === identity.memberId).length, 1, "toujours EXACTEMENT une fiche owner, jamais un doublon");
});

test("promoteAdapterToOrg (Drive, code RÉEL) : CORRECTIF Lot 2 (promotion interrompue) — panne EXACTEMENT entre writeManifest et writeMemberRecord, puis retry -> 'complete-owner', dossier RÉPARÉ (canonical : la relecture Drive, clés triées, reconnaît le MÊME owner)", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Drive Bridge Interrompue", null);
  const adapter = makeDriveAdapter(drive, root);
  const workspaceId = globalThis.crypto.randomUUID();
  const identity = await PiloteoOrg.getOrCreateIdentity();

  const realPutImmutable = adapter.putImmutable.bind(adapter);
  adapter.putImmutable = (kind, id, blob) => {
    if (kind === "member") return Promise.reject(new Error("panne réseau simulée (coupure pendant la republication de la fiche owner)"));
    return realPutImmutable(kind, id, blob);
  };
  await assert.rejects(
    () => promoteAdapterToOrg({ adapter, workspaceId, name: "Cabinet Interrompu", consultantId: "c-alice", identity }),
    /panne réseau simulée/
  );
  adapter.putImmutable = realPutImmutable;

  // État CASSÉ intermédiaire : owner PAS admis (exactement ce que le retry doit réparer).
  const trustAfterFailure = await loadTrust(adapter);
  assert.equal(trustAfterFailure.membershipStore.get(workspaceId, identity.memberId), null);

  // Retry NORMAL (même utilisateur, même dossier) — via le VRAI promoteAdapterToOrg,
  // manifeste RELU depuis Drive (canonicalStringify, clés triées) comparé à
  // l'identité locale (ordre natif WebCrypto) : doit être reconnu comme le
  // MÊME owner (non-régression round 3 canonique), jamais un faux conflict.
  const repaired = await promoteAdapterToOrg({ adapter, workspaceId, name: "Cabinet Interrompu", consultantId: "c-alice", identity });
  assert.equal(repaired.completedOwnerRecord, true, "le retry détecte l'owner manquant et republie SEULEMENT sa fiche");
  assert.equal(repaired.manifest.workspaceId, workspaceId, "workspaceId préservé à travers la réparation");

  const trustAfterRepair = await loadTrust(adapter);
  assert.equal(trustAfterRepair.rejected.length, 0, JSON.stringify(trustAfterRepair.rejected));
  const ownerMembership = trustAfterRepair.membershipStore.get(workspaceId, identity.memberId);
  assert.ok(ownerMembership, "l'owner est maintenant admis");
  assert.equal(ownerMembership.role, "owner");

  const loaded = await repaired.engine.load();
  const commit = await repaired.engine.commit({
    ...loaded.state,
    consultants: [...loaded.state.consultants, { id: "c-alice", nom: "Alice", trigramme: "ALI", statut: "en poste", admin: true, tempsPartiel: [] }],
  });
  assert.equal(commit.ok, true, "l'owner réparé peut désormais ÉCRIRE dans son propre workspace Drive");

  const third = await promoteAdapterToOrg({ adapter, workspaceId, name: "Cabinet Interrompu", consultantId: "c-alice", identity });
  assert.equal(third.alreadyPromoted, true, "une fois réparé, un appel supplémentaire est un NO-OP sûr");
});

test("promoteAdapterToOrg (Drive, code RÉEL) : CORRECTIF Lot 2 (slot owner empoisonné) — un TIERS occupe le slot owner sur Drive -> erreur EXPLICITE distincte, JAMAIS avalée silencieusement, PUIS récupérable après retrait de la fiche hostile", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Drive Bridge Empoisonné", null);
  const adapter = makeDriveAdapter(drive, root);
  const workspaceId = globalThis.crypto.randomUUID();
  const identity = await PiloteoOrg.getOrCreateIdentity();
  const attacker = await PiloteoOrg.__identityStore.create();

  // Panne EXACTEMENT entre writeManifest et writeMemberRecord (état identique
  // au test précédent, juste AVANT réparation).
  const realPutImmutable = adapter.putImmutable.bind(adapter);
  adapter.putImmutable = (kind, id, blob) => {
    if (kind === "member") return Promise.reject(new Error("panne réseau simulée"));
    return realPutImmutable(kind, id, blob);
  };
  await assert.rejects(
    () => promoteAdapterToOrg({ adapter, workspaceId, name: "Cabinet Empoisonné", consultantId: "c-alice", identity }),
    /panne réseau simulée/
  );
  adapter.putImmutable = realPutImmutable;

  // L'ATTAQUANT — AUCUNE clé privée requise (ownerMemberId/ownerPublicKeyJwk
  // sont PUBLICS dans le manifeste dès writeManifest) — dépose une fiche
  // "member" sous le MÊME ownerMemberId, avec SA PROPRE clé, AVANT le retry.
  const hostileMembership = createMembership({ workspaceId, memberId: identity.memberId, consultantId: null, role: "owner" });
  const hostileRecord = {
    kind: "member",
    memberId: identity.memberId,
    publicKeyJwk: attacker.publicKeyJwk,
    membership: hostileMembership,
    authorization: { genesis: true },
  };
  await writeMemberRecord(adapter, hostileRecord);

  // Retry légitime via le VRAI promoteAdapterToOrg : erreur EXPLICITE et
  // DISTINCTE, jamais confondue avec "n'est pas membre" (round 1), jamais un
  // succès silencieux (usurpation).
  await assert.rejects(
    () => promoteAdapterToOrg({ adapter, workspaceId, name: "Cabinet Empoisonné", consultantId: "c-alice", identity }),
    (err) => {
      assert.match(err.message, /tierce|hostile|contest/i);
      assert.doesNotMatch(err.message, /n'est pas membre/i);
      return true;
    }
  );

  const trustAfterAttack = await loadTrust(adapter);
  assert.equal(trustAfterAttack.membershipStore.get(workspaceId, identity.memberId), null,
    "l'owner légitime n'est pas admis tant que le slot est occupé par la fiche hostile");

  // RÉCUPÉRATION (ORG_TRUST_HARDENING_CONTRACT.md §3) : retrait de la fiche
  // hostile côté Drive (permissions du dossier — simulé ici en retirant
  // directement le nœud du FakeDrive, ce qu'un accès Drive réel permet
  // identiquement).
  for (const [nodeId, node] of drive.nodes) {
    if (node.name === `${identity.memberId}.piloteo` && (node.parents || []).length) {
      drive.nodes.delete(nodeId);
    }
  }

  const repaired = await promoteAdapterToOrg({ adapter, workspaceId, name: "Cabinet Empoisonné", consultantId: "c-alice", identity });
  assert.equal(repaired.completedOwnerRecord, true, "réparation réussie après retrait de la fiche hostile sur Drive");
  const trustFinal = await loadTrust(adapter);
  const ownerMembership = trustFinal.membershipStore.get(workspaceId, identity.memberId);
  assert.ok(ownerMembership, "l'owner LÉGITIME est enfin admis après retrait de la fiche hostile");
  assert.equal(ownerMembership.role, "owner");
});

test("promoteAdapterToOrg (Drive, code RÉEL) : anti-usurpation — re-promouvoir un dossier Drive déjà promu avec une AUTRE identité -> 'conflict' (rejet AVANT toute écriture), owner original inchangé", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Drive Bridge Anti-Usurpation", null);
  const adapter = makeDriveAdapter(drive, root);
  const workspaceId = globalThis.crypto.randomUUID();
  const owner = await PiloteoOrg.getOrCreateIdentity();
  const attacker = await PiloteoOrg.__identityStore.create();

  await promoteAdapterToOrg({ adapter, workspaceId, name: "Cabinet Protégé", consultantId: null, identity: owner });

  await assert.rejects(
    () => promoteAdapterToOrg({ adapter, workspaceId, name: "Cabinet Protégé", consultantId: null, identity: attacker }),
    /organisation différente|propriétaire différent/
  );

  const trust = await loadTrust(adapter);
  assert.equal(trust.manifest.ownerMemberId, owner.memberId);
  assert.notEqual(trust.manifest.ownerMemberId, attacker.memberId);
});

// ---------------------------------------------------------------------------
// B. promoteAdapterToOrg (MÊME export) sur un VRAI FolderStorageAdapter —
//    prouve qu'il s'agit bien du même cœur, littéralement, pour les deux
//    transports (non-régression Lot 2 au niveau du cœur factorisé).
// ---------------------------------------------------------------------------

test("promoteAdapterToOrg (Dossier, code RÉEL, NON-RÉGRESSION Lot 2) : MÊME export ES utilisé pour Drive — workspaceId préservé, owner = identité solo", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-drive-promotion-bridge-folder-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "bridge-folder-test" });
    const workspaceId = globalThis.crypto.randomUUID();
    const identity = await PiloteoOrg.getOrCreateIdentity();

    const result = await promoteAdapterToOrg({ adapter, workspaceId, name: "Cabinet Folder Bridge", consultantId: "c-alice", identity });
    assert.equal(result.manifest.workspaceId, workspaceId);

    const soloSnapshot = { ...emptySnapshot(), consultants: [consultant("c-alice", "Alice")] };
    await republishAndVerify(result.engine, soloSnapshot, workspaceId, identity.memberId);

    const trust = await loadTrust(adapter);
    assert.equal(trust.membershipStore.get(workspaceId, identity.memberId).role, "owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C. promoteToOrg (mode Dossier, mince enrobage de promoteAdapterToOrg) —
//    via un FileSystemDirectoryHandle FACTICE en mémoire, même simulateur que
//    tests/e2e/org-promotion.mjs (non-régression du point d'entrée public).
// ---------------------------------------------------------------------------

function notFound() { const e = new Error("not found"); e.name = "NotFoundError"; return e; }
class FakeFileHandle {
  constructor(name) { this.kind = "file"; this.name = name; this._content = ""; this._lastModified = 1000; }
  async getFile() {
    const c = this._content;
    return { size: new TextEncoder().encode(c).length, lastModified: this._lastModified, text: async () => c };
  }
  async createWritable() {
    const self = this; let buf = "";
    return { async write(chunk) { buf += chunk; }, async close() { self._content = buf; self._lastModified += 1; } };
  }
}
class FakeDirHandle {
  constructor(name = "root", perm = "granted") { this.kind = "directory"; this.name = name; this._children = new Map(); this._perm = perm; }
  async getDirectoryHandle(name, { create } = {}) {
    let h = this._children.get(name);
    if (h) { if (h.kind !== "directory") throw notFound(); return h; }
    if (!create) throw notFound();
    h = new FakeDirHandle(name); this._children.set(name, h); return h;
  }
  async getFileHandle(name, { create } = {}) {
    let h = this._children.get(name);
    if (h) { if (h.kind !== "file") throw notFound(); return h; }
    if (!create) throw notFound();
    h = new FakeFileHandle(name); this._children.set(name, h); return h;
  }
  async *values() { for (const h of this._children.values()) yield h; }
  async queryPermission() { return this._perm; }
  async requestPermission() { this._perm = "granted"; return "granted"; }
}

test("promoteToOrg (Dossier, point d'entrée public, NON-RÉGRESSION Lot 2) : délègue à promoteAdapterToOrg — workspaceId préservé, engine.folderName posé", async () => {
  const handle = new FakeDirHandle("PiloteoDriveBridgeTestFolder");
  const workspaceId = globalThis.crypto.randomUUID();
  const identity = await PiloteoOrg.getOrCreateIdentity();

  const result = await PiloteoOrg.promoteToOrg({ handle, workspaceId, name: "Cabinet Enrobage", consultantId: "c-x", identity });
  assert.equal(result.manifest.workspaceId, workspaceId);
  assert.equal(result.engine.folderName, "PiloteoDriveBridgeTestFolder", "engine.folderName posé par le mince enrobage (withFolderName)");
  assert.equal(result.alreadyPromoted, false);

  const second = await PiloteoOrg.promoteToOrg({ handle, workspaceId, name: "Cabinet Enrobage", consultantId: "c-x", identity });
  assert.equal(second.alreadyPromoted, true, "idempotence préservée à travers le point d'entrée public");
});

// ---------------------------------------------------------------------------
// D. promoteDriveOrg (piloteo-drive-bridge.mjs, câblage PUBLIC Lot 5) — OAuth
//    (Google Identity Services) et transport réseau STUBBÉS, AUCUN appel
//    réseau réel, même patron que tests/e2e/org-onboarding-drive.mjs.
// ---------------------------------------------------------------------------

function stubGis() {
  globalThis.window.google = {
    accounts: {
      oauth2: {
        initTokenClient(opts) {
          return {
            requestAccessToken() {
              setTimeout(() => opts.callback({ access_token: "fake-drive-promotion-token", expires_in: 3600 }), 0);
            },
          };
        },
      },
    },
  };
}
function routeFetchToDrive(drive) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    if (url.indexOf("https://www.googleapis.com/") === 0) return drive.fetch(url, init || {});
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test("promoteDriveOrg : rejette EXPLICITEMENT si 'workspaceId' est absent, AVANT tout appel réseau (jamais un espace partagé sans lien avec le solo)", async () => {
  await assert.rejects(() => PiloteoDrive.promoteDriveOrg({ name: "X" }), /workspaceId/);
});

test("promoteDriveOrg (chemin PUBLIC, Lot 5) : OAuth-first, crée le dossier racine Drive, promeut EN PLACE le workspace solo fourni, identité PARTAGÉE, events solo republiés sans perte", async () => {
  stubGis();
  const drive = new FakeDrive();
  const restoreFetch = routeFetchToDrive(drive);
  try {
    const workspaceId = globalThis.crypto.randomUUID();
    const identityBefore = await PiloteoOrg.getOrCreateIdentity();
    localStorage.removeItem("piloteo_storage_mode");
    localStorage.removeItem("piloteo_drive_root_folder_id");

    const result = await PiloteoDrive.promoteDriveOrg({ workspaceId, name: "Cabinet Mobile Drive", consultantId: "c-mobile" });

    assert.equal(result.manifest.workspaceId, workspaceId, "workspaceId préservé (jamais un nouveau workspace)");
    assert.equal(result.engine.folderName, "Google Drive");
    assert.ok(typeof result.rootFolderId === "string" && result.rootFolderId.length > 0, "un dossier racine Drive a bien été créé");
    const rootNode = drive.nodes.get(result.rootFolderId);
    assert.ok(rootNode && rootNode.name.indexOf("Pilotéo - Cabinet Mobile Drive") === 0, "le dossier racine porte bien le nom d'affichage demandé (createDriveRootFolder)");
    assert.equal(identityBefore.memberId, result.identity.memberId, "identité PARTAGÉE avec piloteo-org-bridge.mjs — jamais une 2e identité créée par le câblage Drive");

    // CORRECTIF contrariant (axe 4, « persist-avant-vérif ») : promoteDriveOrg
    // NE persiste PLUS piloteo_storage_mode/piloteo_drive_root_folder_id —
    // c'est à l'appelant (local-backend.js#activateShareSpaceDrive) de le
    // faire, UNIQUEMENT après avoir vérifié la republication des events (voir
    // le test dédié plus bas et tests/e2e/attack-persist-before-verify-drive.mjs).
    // Sans ce correctif, un rechargement PENDANT l'attente utilisateur de
    // decideAndRunMigration (APRÈS ce point) aurait laissé un mode "org-drive"
    // pointant sur un espace Drive VIDE (events jamais republiés).
    assert.equal(localStorage.getItem("piloteo_storage_mode"), null,
      "promoteDriveOrg N'ACTIVE PAS le mode org-drive lui-même (corrige la fenêtre de reboot cassée)");
    assert.equal(localStorage.getItem("piloteo_drive_root_folder_id"), null,
      "promoteDriveOrg NE persiste PAS rootFolderId lui-même (idem)");

    const soloSnapshot = { ...emptySnapshot(), consultants: [consultant("c-mobile", "Mobile")], saisies: [saisie("s-mobile-1", "c-mobile")] };
    const { commit } = await republishAndVerify(result.engine, soloSnapshot, workspaceId, identityBefore.memberId);
    assert.equal(commit.applied.count, 2, "les 2 entités solo (1 consultant + 1 saisie) sont republiées sur Drive via le chemin public promoteDriveOrg");

    // Simule l'activation FINALE que fait local-backend.js#activateShareSpaceDrive
    // (son SEUL .then final, APRÈS republication vérifiée ci-dessus) : le
    // mode n'est posé QU'ICI, jamais avant.
    localStorage.setItem("piloteo_storage_mode", "org-drive");
    localStorage.setItem("piloteo_drive_root_folder_id", result.rootFolderId);
    assert.equal(localStorage.getItem("piloteo_storage_mode"), "org-drive");
    assert.equal(localStorage.getItem("piloteo_drive_root_folder_id"), result.rootFolderId);
  } finally {
    restoreFetch();
  }
});

test("promoteDriveOrg (chemin PUBLIC, Lot 5) : CORRECTIF axe 4 (persist-avant-vérif) — la genèse Drive écrite AVANT toute activation locale reste ORPHELINE mais RÉCUPÉRABLE (un 'Partager' ultérieur sur le MÊME rootFolderId la répare, jamais un second owner)", async () => {
  stubGis();
  const drive = new FakeDrive();
  const restoreFetch = routeFetchToDrive(drive);
  try {
    const workspaceId = globalThis.crypto.randomUUID();
    const identity = await PiloteoOrg.getOrCreateIdentity();
    localStorage.removeItem("piloteo_storage_mode");
    localStorage.removeItem("piloteo_drive_root_folder_id");

    // "Reload avant activation" simulé : promoteDriveOrg s'exécute (genèse
    // écrite sur Drive) mais on n'active JAMAIS le mode ensuite (comme un
    // rechargement pendant decideAndRunMigration l'aurait fait) — le mode
    // reste solo/absent (déjà prouvé ci-dessus). Un "Partager" ultérieur
    // recommence proprement sur le MÊME dossier.
    const first = await PiloteoDrive.promoteDriveOrg({ workspaceId, name: "Cabinet Orphelin", consultantId: null });
    assert.equal(localStorage.getItem("piloteo_storage_mode"), null, "mode toujours PAS activé (simule le reboot solo après un reload)");

    const adapterAgain = new GoogleDriveStorageAdapter({
      oauthTokenProvider: async () => "fake-access-token", rootFolderId: first.rootFolderId, fetchImpl: drive.fetch, sleepFn: async () => {},
    });
    const second = await PiloteoDrive.__promoteOrgOnAdapter({ adapter: adapterAgain, workspaceId, name: "Cabinet Orphelin", consultantId: null, identity });
    assert.equal(second.alreadyPromoted, true, "la genèse orpheline (déjà écrite) est reconnue -> no-op sûr, jamais un second owner");
    assert.deepEqual(second.manifest, first.manifest);
  } finally {
    restoreFetch();
  }
});

test("promoteDriveOrg (chemin PUBLIC, Lot 5) : réouvrir le MÊME rootFolderId (adapter reconstruit, comme une reprise) reste régi par le MÊME cœur — already-promoted, jamais un second owner", async () => {
  stubGis();
  const drive = new FakeDrive();
  const restoreFetch = routeFetchToDrive(drive);
  try {
    const workspaceId = globalThis.crypto.randomUUID();
    const identity = await PiloteoOrg.getOrCreateIdentity();
    const first = await PiloteoDrive.promoteDriveOrg({ workspaceId, name: "Cabinet Reprise", consultantId: null });

    // Reprise : adapter RECONSTRUIT (comme resumeDriveOrg le ferait) sur le
    // MÊME rootFolderId — exerce le hook __promoteOrgOnAdapter (même cœur).
    const adapterAgain = new GoogleDriveStorageAdapter({
      oauthTokenProvider: async () => "fake-access-token", rootFolderId: first.rootFolderId, fetchImpl: drive.fetch, sleepFn: async () => {},
    });
    const second = await PiloteoDrive.__promoteOrgOnAdapter({ adapter: adapterAgain, workspaceId, name: "Cabinet Reprise", consultantId: null, identity });
    assert.equal(second.alreadyPromoted, true, "reprise sur le même dossier Drive -> no-op idempotent, jamais un second owner");
    assert.deepEqual(second.manifest, first.manifest);
  } finally {
    restoreFetch();
  }
});
