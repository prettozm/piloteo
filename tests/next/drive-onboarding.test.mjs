// tests/next/drive-onboarding.test.mjs
//
// Onboarding Drive (docs/next/DRIVE_ONBOARDING_CONTRACT.md §4, lot A : créer +
// inviter + reprendre une organisation sur Google Drive) contre le FakeDrive
// existant (tests/next/helpers/fake-drive.mjs) + les hooks de TEST
// `__createOrgOnAdapter`/`__openOrgOnAdapter` de piloteo-drive-bridge.mjs
// (adaptateur Drive DÉJÀ CONSTRUIT sur un FakeDrive) — AUCUN OAuth réel, AUCUN
// appel réseau réel à Google (impossible à automatiser ici ; voir
// docs/next/DRIVE_ONBOARDING_MANUAL.md pour la checklist navigateur).
//
// Comme tests/next/drive-bridge.test.mjs : `piloteo-org-bridge.mjs` et
// `piloteo-drive-bridge.mjs` référencent `window` au chargement (posent
// respectivement `window.PiloteoOrg`/`window.PiloteoDrive`) — modules écrits
// pour un navigateur, jamais importés ailleurs par un test node:test. On shim
// `globalThis.window`, `globalThis.indexedDB` (fake-indexeddb — nécessaire à
// l'identité PERSISTÉE de `piloteo-org-bridge.mjs`, `getOrCreateIdentity`) et
// un `localStorage` minimal (absent de Node ; chaque accès y est déjà protégé
// par try/catch côté production — son absence serait silencieusement no-op —
// on le fournit ici pour pouvoir exercer RÉELLEMENT le scénario 3,
// `resumeDriveOrg`) AVANT d'importer les DEUX ponts, dans le MÊME ORDRE que
// `index.html` (org-bridge avant drive-bridge, contrat §3).
//
// IMPÉRATIF du contrat §1 : la MÊME identité de membre Ed25519 persistée par
// `piloteo-org-bridge.mjs` doit être réutilisée par le pont Drive — JAMAIS une
// seconde identité fabriquée. On importe donc le VRAI `piloteo-org-bridge.mjs`
// (pas un double fabriqué pour ce test) : c'est la seule façon de prouver que
// `piloteo-drive-bridge.mjs` appelle réellement `window.PiloteoOrg.getOrCreateIdentity`
// plutôt que de générer sa propre identité.

import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { GoogleDriveStorageAdapter } from "../../src/storage/google-drive-adapter.js";
import { writeMemberRecord } from "../../src/workspace/org-folder-store.js";
import { createMembership } from "../../src/workspace/memberships.js";
import { FakeDrive } from "./helpers/fake-drive.mjs";

if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
}
// localStorage minimal (Node n'en fournit pas par défaut) : Map en mémoire,
// partagée par tout le fichier de test — chaque test qui en dépend pose/efface
// explicitement les clés qui l'intéressent (pas de nettoyage automatique entre
// tests, comme pour n'importe quel `localStorage` réel entre deux appels).
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map();
  globalThis.localStorage = {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
  };
}

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Ordre du document `index.html` (contrat §3) : org-bridge AVANT drive-bridge —
// pour que `window.PiloteoOrg` soit déjà posé quand drive-bridge en a besoin.
await import(pathToFileURL(path.join(repoRoot, "..", "piloteo-org-bridge.mjs")).href);
await import(pathToFileURL(path.join(repoRoot, "..", "piloteo-drive-bridge.mjs")).href);
const PiloteoOrg = globalThis.window.PiloteoOrg;
const PiloteoDrive = globalThis.window.PiloteoDrive;

function makeAdapter(drive, rootFolderId) {
  return new GoogleDriveStorageAdapter({
    oauthTokenProvider: async () => "fake-access-token",
    rootFolderId,
    fetchImpl: drive.fetch,
    sleepFn: async () => {},
  });
}

test("piloteo-drive-bridge : createDriveOrg/openDriveOrg (fonctions publiques) indisponibles proprement sans GOOGLE_CLIENT_ID — jamais de tentative réseau", async () => {
  assert.equal(PiloteoDrive.isAvailable, false, "aucun window.PILOTEO_GOOGLE_CLIENT_ID dans cet environnement de test -> indisponible");
  await assert.rejects(
    () => PiloteoDrive.createDriveOrg({ name: "Cabinet X", consultantId: "c-1" }),
    /GOOGLE_CLIENT_ID/,
    "createDriveOrg doit échouer proprement (pas d'appel réseau) quand le mode Drive est indisponible"
  );
  await assert.rejects(
    () => PiloteoDrive.openDriveOrg({ rootFolderId: "root-x" }),
    /GOOGLE_CLIENT_ID/,
    "openDriveOrg doit échouer proprement (pas d'appel réseau) quand le mode Drive est indisponible"
  );
});

test("createDriveOrg (hook __createOrgOnAdapter) : manifeste + fiche owner écrits ; openDriveOrg (hook __openOrgOnAdapter) sur le MÊME FakeDrive relit le même manifeste/membership ; /api/state (engine.load/commit) fonctionne ; l'identité est réutilisée (pas de 2e identité créée)", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Cabinet Test", null);

  const identityBefore = await PiloteoOrg.getOrCreateIdentity();

  const adapterA = makeAdapter(drive, root);
  const created = await PiloteoDrive.__createOrgOnAdapter({ adapter: adapterA, name: "Cabinet Test", consultantId: "c-1" });
  assert.ok(created.manifest && created.manifest.workspaceId, "manifeste de genèse publié");
  assert.equal(created.manifest.ownerMemberId, identityBefore.memberId,
    "le créateur EST l'identité PARTAGÉE de piloteo-org-bridge.mjs — jamais une identité fabriquée par le pont Drive");
  assert.equal(created.engine.membership.role, "owner");
  assert.equal(created.engine.folderName, "Google Drive");

  // La fiche membre owner a bien été écrite (kind:"member", write-once).
  const memberBlob = await adapterA.get("member", identityBefore.memberId);
  assert.ok(memberBlob && memberBlob.kind === "member" && memberBlob.authorization.genesis === true);

  // /api/state : c'est exactement l'engine {load,commit} que local-backend.js
  // route pour `storageMode==="org-drive"` (§2 du contrat) — même contrat que
  // pour le mode dossier (org-engine.js, non modifié ici).
  const loaded = await created.engine.load();
  assert.deepEqual(loaded.state.consultants, [], "état initial vierge");
  assert.equal(loaded.revision, 0);
  const committed = await created.engine.commit({ ...loaded.state, consultants: [{ id: "c-1", nom: "Alice" }] });
  assert.equal(committed.ok, true);
  assert.equal(committed.state.consultants.length, 1);
  assert.equal(committed.state.consultants[0].nom, "Alice");

  // Pas de 2e identité : `getOrCreateIdentity()` reste mémoïsé après l'appel
  // interne fait par le pont Drive pendant `createOrgOnAdapter`.
  const identityAfter = await PiloteoOrg.getOrCreateIdentity();
  assert.equal(identityAfter.memberId, identityBefore.memberId);
  assert.deepEqual(identityAfter.publicKeyJwk, identityBefore.publicKeyJwk);

  // Réouverture sur un DEUXIÈME adaptateur Drive (même FakeDrive/rootFolderId,
  // comme une reprise au boot) : même manifeste, même membership (rôle "owner" —
  // local-backend.js le mappe "admin" pour app.js, hors scope de ce pont).
  const adapterB = makeAdapter(drive, root);
  const reopened = await PiloteoDrive.__openOrgOnAdapter({ adapter: adapterB });
  assert.deepEqual(reopened.manifest, created.manifest);
  assert.equal(reopened.membership.role, "owner");
  assert.equal(reopened.membership.memberId, identityBefore.memberId);
  const reloaded = await reopened.engine.load();
  assert.equal(reloaded.state.consultants.length, 1, "l'écriture précédente (adapter A) est visible à la réouverture (adapter B)");
});

test("PiloteoDrive.invite génère un code non vide (délégué au pont org) ; une 2e identité qui rejoint (acceptInvitation) puis openDriveOrg (hook) sur le même FakeDrive voit le manifeste et les membres (préfigure le join, sans Picker — lot B) ; PiloteoDrive.revoke retire son accès ; une fiche genèse FORGÉE est rejetée (chaîne de confiance intacte)", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Cabinet B", null);

  const ownerIdentity = await PiloteoOrg.getOrCreateIdentity();
  const adapterOwner = makeAdapter(drive, root);
  const created = await PiloteoDrive.__createOrgOnAdapter({ adapter: adapterOwner, name: "Cabinet B", consultantId: "c-owner" });

  // invite/revoke/listMembers exposés par PiloteoDrive : DÉLÉGUÉS tels quels
  // au pont org (contrat §1 — identiques, ne dépendent pas du stockage).
  const inv = await PiloteoDrive.invite({ engine: created.engine, adapter: adapterOwner, role: "user", ttlDays: 1 });
  assert.ok(inv && typeof inv.code === "string" && inv.code.length > 0, "invite() génère un code non vide");
  assert.ok(inv.invitation && inv.invitation.proof, "l'invitation est signée");

  // Une SECONDE identité (jamais l'identité "courante" persistée de ce
  // navigateur — `__identityStore.create()`, même hook que celui déjà exposé
  // par piloteo-org-bridge.mjs pour ses propres e2e multi-membres) consomme
  // l'invitation (acceptInvitation, org-runtime.js — réutilisé tel quel, la
  // logique de join elle-même ne dépend pas du stockage) puis publie sa fiche
  // membre sur le MÊME FakeDrive. Le choix du dossier via Google Picker (join
  // UI) est le lot B, hors scope : on connaît déjà `root` ici.
  const strangerIdentity = await PiloteoOrg.__identityStore.create();
  assert.notEqual(strangerIdentity.memberId, ownerIdentity.memberId);

  const { acceptInvitation } = await import(pathToFileURL(path.join(repoRoot, "..", "src", "workspace", "org-runtime.js")).href);
  const { memberRecord } = await acceptInvitation({ invitation: inv.invitation, identity: strangerIdentity, consultantId: "c-stranger" });
  const adapterStranger = makeAdapter(drive, root);
  await adapterStranger.connect();
  await writeMemberRecord(adapterStranger, memberRecord);

  const opened = await PiloteoDrive.__openOrgOnAdapter({ adapter: adapterStranger, identity: strangerIdentity });
  assert.deepEqual(opened.manifest, created.manifest, "le manifeste publié est visible depuis n'importe quelle identité membre");
  assert.equal(opened.membership.role, "user");

  let members = await PiloteoDrive.listMembers(opened.engine);
  assert.equal(members.length, 2);
  assert.ok(members.some((m) => m.memberId === ownerIdentity.memberId && m.role === "owner" && m.status === "active"));
  assert.ok(members.some((m) => m.memberId === strangerIdentity.memberId && m.role === "user" && m.status === "active"));

  // Chaîne de confiance intacte : une fiche FORGÉE (réutilise le raisonnement
  // de tests/next/org-runtime.test.mjs "buildTrustedMembership" — une fiche
  // prétendant à une admission sans invitation/joinProof valides est rejetée,
  // `isCandidateShape`) publiée directement sur le même FakeDrive, sous une
  // identité JAMAIS invitée, n'est JAMAIS admise — elle n'apparaît jamais dans
  // members(), même après réouverture. `memberId` DISTINCT de l'owner (le
  // write-once refuserait de toute façon un id déjà pris — ici on prouve le
  // rejet PAR LA CHAÎNE DE CONFIANCE elle-même, pas seulement par le transport).
  const forgedIdentity = await PiloteoOrg.__identityStore.create();
  const forgedRecord = {
    kind: "member",
    memberId: forgedIdentity.memberId,
    publicKeyJwk: forgedIdentity.publicKeyJwk,
    membership: createMembership({
      workspaceId: created.manifest.workspaceId, memberId: forgedIdentity.memberId,
      consultantId: "c-forged", role: "admin",
    }),
    authorization: { genesis: true }, // prétend être une genèse alors qu'il n'est PAS l'owner du manifeste
  };
  await writeMemberRecord(adapterStranger, forgedRecord); // écrit sans erreur (id distinct) : le rejet vient de la VÉRIFICATION, pas du transport.

  const reopenedAfterForge = await PiloteoDrive.__openOrgOnAdapter({ adapter: makeAdapter(drive, root), identity: strangerIdentity });
  const membersAfterForge = await PiloteoDrive.listMembers(reopenedAfterForge.engine);
  assert.equal(membersAfterForge.length, 2, "toujours owner + stranger — jamais une 3e entrée depuis la fiche forgée");
  assert.ok(!membersAfterForge.some((m) => m.memberId === forgedIdentity.memberId), "fiche forgée (genèse usurpée) jamais admise");

  // Révocation (PiloteoDrive.revoke, déléguée) : le owner retire l'accès du
  // stranger — chaîne de confiance signée, écrite sur le MÊME adapter générique.
  // `created.engine` est PÉRIMÉ (ouvert AVANT que le stranger ne rejoigne : sa
  // vue de la gouvernance date de ce moment-là, cf. org-engine.js décision 5) —
  // on réouvre l'engine du owner (identité courante par défaut) pour une vue
  // FRAÎCHE incluant le stranger, comme le ferait local-backend.js en rouvrant
  // le panneau Réglages après un rechargement.
  const ownerReopened = await PiloteoDrive.__openOrgOnAdapter({ adapter: makeAdapter(drive, root) });
  await PiloteoDrive.revoke({ engine: ownerReopened.engine, adapter: ownerReopened.adapter, memberId: strangerIdentity.memberId });
  const afterRevoke = await PiloteoDrive.__openOrgOnAdapter({ adapter: makeAdapter(drive, root) }); // identité courante = owner
  const membersAfterRevoke = await PiloteoDrive.listMembers(afterRevoke.engine);
  const strangerEntry = membersAfterRevoke.find((m) => m.memberId === strangerIdentity.memberId);
  assert.ok(strangerEntry && strangerEntry.status === "revoked", "le stranger est bien révoqué (jamais retiré silencieusement)");
});

test("resumeDriveOrg sans rootFolderId mémorisé -> null (rien à reprendre)", async () => {
  localStorage.removeItem("piloteo_drive_root_folder_id");
  const result = await PiloteoDrive.resumeDriveOrg();
  assert.equal(result, null);
});

test("resumeDriveOrg (boot, non-interactif) sans token en cache mémoire -> {needsAuth:true} — JAMAIS d'appel OAuth interactif", async () => {
  // Simule une organisation Drive déjà mémorisée (comme après un createDriveOrg
  // réel dans une session précédente) : rootFolderId + storageMode persistés
  // côté localStorage — SANS aucun token en cache mémoire (cas réaliste : le
  // token n'est JAMAIS persisté entre deux chargements de page, cf. l'en-tête
  // de piloteo-drive-bridge.mjs). GOOGLE_CLIENT_ID reste absent dans cet
  // environnement de test : si `resumeDriveOrg` appelait par erreur
  // `oauthTokenProvider()` en mode non-interactif, cet appel LÈVERAIT
  // (message "GOOGLE_CLIENT_ID absent") plutôt que de renvoyer `{needsAuth:true}`
  // — ce test échouerait donc bien si le garde-fou "jamais interactif au boot"
  // était violé.
  localStorage.setItem("piloteo_storage_mode", "org-drive");
  localStorage.setItem("piloteo_drive_root_folder_id", "root-xyz");
  const result = await PiloteoDrive.resumeDriveOrg();
  assert.deepEqual(result, { needsAuth: true });
  // Idempotent : un second appel sans geste utilisateur redonne la même réponse.
  const result2 = await PiloteoDrive.resumeDriveOrg({ interactive: false });
  assert.deepEqual(result2, { needsAuth: true });
});

// ---------------------------------------------------------------------------
// CORRECTIF SÉCURITÉ (« DoS gouvernance Drive », round contrariant) : un
// fichier hostile divergent `<memberId>.piloteo` déposé DIRECTEMENT sur Drive
// (accès Éditeur brut au dossier partagé — jamais un membre Pilotéo, jamais
// une signature, jamais un appel à `putImmutable`) sous le MÊME NOM que la
// fiche du OWNER ne doit JAMAIS l'exclure de sa propre organisation. Reproduit
// EXACTEMENT le scénario du repro contrariant (`attack-driveorg-member-dos.mjs`,
// racine du dépôt) : sans le correctif de `org-folder-store.js#listGovernance`/
// `GoogleDriveStorageAdapter#getAllCandidates`, cette réouverture lève
// "n'est pas membre de ce workspace" pour le OWNER — un DoS total et
// silencieux avec un seul fichier hostile, aucune signature/rôle requis.
// ---------------------------------------------------------------------------
test("SÉCURITÉ — un fichier hostile divergent <ownerMemberId>.piloteo déposé DIRECTEMENT sur Drive (jamais via putImmutable) n'exclut PAS le owner : la fiche légitime SIGNÉE reste admise, la fiche hostile est rejetée par vérification de signature", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Cabinet Attaqué", null);

  const ownerIdentity = await PiloteoOrg.getOrCreateIdentity();
  const adapterOwner = makeAdapter(drive, root);
  const created = await PiloteoDrive.__createOrgOnAdapter({ adapter: adapterOwner, name: "Cabinet Attaqué", consultantId: "c-owner" });
  assert.equal(created.engine.membership.role, "owner");

  // Sanity check : sans attaque, la réouverture fonctionne (comme avant tout ce round).
  const sane = await PiloteoDrive.__openOrgOnAdapter({ adapter: makeAdapter(drive, root) });
  assert.equal(sane.membership.role, "owner");

  // ATTAQUE : un fichier hostile, MÊME NOM que la fiche owner
  // (`<ownerMemberId>.piloteo`), déposé DIRECTEMENT dans le nœud FakeDrive —
  // jamais via `writeMemberRecord`/`putImmutable` (c'est exactement ce qu'un
  // tiers avec un accès Éditeur brut au dossier Drive ferait : un upload de
  // fichier, sans jamais passer par l'app Pilotéo). Contenu GARBAGE, sans
  // signature, sans authorization valide — un id de nœud STABLE (même valeur
  // pour la clé de la Map et le champ `id`, comme un vrai fichier Drive : un
  // seul id physique).
  const membersFolderId = adapterOwner._topFolders.member;
  assert.ok(membersFolderId, "dossier 'members' résolu par l'adapter owner");
  const hostileFileId = "id-hostile-" + Math.random().toString(16).slice(2);
  drive.nodes.set(hostileFileId, {
    id: hostileFileId,
    name: `${ownerIdentity.memberId}.piloteo`, // MÊME NOM que la fiche légitime du owner
    mimeType: "application/octet-stream",
    parents: [membersFolderId],
    createdTime: drive.nowIso(), // plus récent que l'original — sans incidence sur l'issue
    content: '{"kind":"member","memberId":"' + ownerIdentity.memberId + '","garbage":true}',
    size: 10,
  });

  // Preuve intermédiaire : GoogleDriveStorageAdapter#get() détecte TOUJOURS la
  // divergence et lève (comportement VOULU, inchangé — Point 4 §8b) ; c'est
  // `getAllCandidates`, PAS `get`, que `listGovernance` doit désormais utiliser.
  const freshAdapter = makeAdapter(drive, root);
  await freshAdapter.connect();
  await assert.rejects(
    () => freshAdapter.get("member", ownerIdentity.memberId),
    /IMMUTABLE_CONFLICT/,
    "get() continue de lever sur une divergence physique (comportement Point 4 inchangé)"
  );
  const candidates = await freshAdapter.getAllCandidates("member", ownerIdentity.memberId);
  assert.equal(candidates.length, 2, "getAllCandidates renvoie LES DEUX candidats (légitime + hostile), sans lever");
  assert.ok(candidates.some((c) => c && c.authorization && c.authorization.genesis === true), "le candidat légitime (fiche genèse signée) est présent");
  assert.ok(candidates.some((c) => c && c.garbage === true), "le candidat hostile est présent aussi (c'est buildTrustedMembership qui doit trancher, pas listGovernance)");

  // LE TEST : une réouverture FRAÎCHE (reprise au boot d'un autre appareil,
  // simple rechargement de page) doit RÉUSSIR pour le owner — jamais "n'est
  // pas membre" à cause du fichier hostile.
  const reopened = await PiloteoDrive.__openOrgOnAdapter({ adapter: makeAdapter(drive, root) });
  assert.equal(reopened.membership.role, "owner", "le owner RESTE membre (rôle 'owner' intact) malgré le fichier hostile");
  assert.equal(reopened.membership.memberId, ownerIdentity.memberId);

  const members = await PiloteoDrive.listMembers(reopened.engine);
  assert.equal(members.length, 1, "toujours UN SEUL membre (le owner) — la fiche hostile n'a jamais été admise");
  assert.equal(members[0].memberId, ownerIdentity.memberId);
  assert.equal(members[0].status, "active", "le owner reste actif (jamais exclu/révoqué par le fichier hostile)");

  // Le owner peut toujours AGIR en tant que owner (gouvernance non dégradée) :
  // inviter fonctionne toujours après l'attaque.
  const inv = await PiloteoDrive.invite({ engine: reopened.engine, adapter: reopened.adapter, role: "user", ttlDays: 1 });
  assert.ok(inv && inv.code && inv.code.length > 0, "le owner peut toujours inviter après l'attaque (gouvernance non dégradée)");
});
