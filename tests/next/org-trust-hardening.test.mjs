// tests/next/org-trust-hardening.test.mjs
//
// Couvre docs/next/ORG_TRUST_HARDENING_CONTRACT.md §4 (durcissement
// anti-usurpation, round contrariant 2 — suite du correctif DoS gouvernance
// Drive, round 1) : `buildTrustedMembership` (src/workspace/org-runtime.js)
// ne doit JAMAIS trancher une décision de SÉCURITÉ sur un champ non signé
// (`createdTime`, ordre de listing/candidats). Les 5 cas ci-dessous sont
// MODE-AGNOSTIQUES : la plupart appellent `buildTrustedMembership` directement
// (fonction PURE, aucune notion de stockage — donc valable identiquement pour
// le mode Dossier, Solo/InMemory ET Drive), et deux d'entre eux (1bis, 5bis)
// exercent en PLUS le pipeline complet `GoogleDriveStorageAdapter#getAllCandidates`
// + `org-folder-store.js#listGovernance/loadTrust` sur un FakeDrive — pour
// prouver que les DEUX correctifs (round 1 "DoS gouvernance" + round 2
// "anti-usurpation" ici) fonctionnent ENSEMBLE sur le chemin où la collision
// physique de fichiers est réellement possible (Drive : deux fichiers peuvent
// porter le même nom).
//
// Reproduit le scénario du contrariant (`attack-driveorg2-escalation.mjs`,
// racine du dépôt) : Eve rejoue l'invitation PUBLIQUE de Bob (visible en clair
// dans sa fiche membre déjà publiée — modèle "dossier de confiance", jamais
// chiffré) avec SA PROPRE clé, sous LE MEMBERID DE BOB.

import test from "node:test";
import assert from "node:assert/strict";
import {
  newMemberIdentity,
  createOrganization,
  inviteMember,
  acceptInvitation,
  buildTrustedMembership,
  createRevocation,
  revocationCanonicalPayload,
} from "../../src/workspace/org-runtime.js";
import * as cryptoService from "../../src/crypto/crypto-service.js";
import {
  writeManifest,
  writeMemberRecord,
  writeRevocation,
  loadTrust,
} from "../../src/workspace/org-folder-store.js";
import { GoogleDriveStorageAdapter, fileNameForKind } from "../../src/storage/google-drive-adapter.js";
import { FakeDrive } from "./helpers/fake-drive.mjs";

/** Construit une organisation fraîche : owner + son signer Ed25519 (même harnais qu'ailleurs). */
async function makeOrg(name = "Org") {
  const ownerIdentity = await newMemberIdentity();
  const org = createOrganization({ name, identity: ownerIdentity, consultantId: "c-owner" });
  const ownerSigner = (bytes) => cryptoService.sign(ownerIdentity.privateKeyRef, bytes);
  return { ownerIdentity, org, ownerSigner };
}

function driveAdapter(drive, rootFolderId) {
  return new GoogleDriveStorageAdapter({
    oauthTokenProvider: async () => "fake-access-token",
    rootFolderId,
    fetchImpl: drive.fetch,
    sleepFn: async () => {},
  });
}

// ---------------------------------------------------------------------------
// Cas 1 — Repro contrariant neutralisée (pure buildTrustedMembership) : Eve
// rejoue l'invitation de Bob (admin) avec SA clé, sous le memberId de Bob.
// ---------------------------------------------------------------------------
test("cas 1 — usurpation : Eve rejoue l'invitation de Bob (admin) avec sa propre clé sous le memberId de Bob -> la clé d'Eve n'est JAMAIS admise pour ce memberId, aucun rôle ne lui est attribué", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg("Cabinet Attaqué");

  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });

  const bobIdentity = await newMemberIdentity();
  const { memberRecord: bobRecord } = await acceptInvitation({ invitation, identity: bobIdentity, consultantId: "c-bob" });

  // Eve : MÊME invitation (publique, visible dans la fiche de Bob une fois
  // publiée), SA PROPRE paire de clés, mais elle CHOISIT le memberId de Bob —
  // rien dans `acceptInvitation` ne l'en empêche (c'est le cœur de la faille).
  const eveKeys = await cryptoService.generateMemberIdentity();
  const eveIdentity = { memberId: bobIdentity.memberId, publicKeyJwk: eveKeys.publicKeyJwk, privateKeyRef: eveKeys.privateKeyRef };
  const { memberRecord: eveRecord } = await acceptInvitation({ invitation, identity: eveIdentity, consultantId: "c-eve" });
  assert.equal(eveRecord.memberId, bobIdentity.memberId, "sanity : la fiche forgée porte bien le memberId de Bob");

  for (const order of [
    [org.memberRecord, bobRecord, eveRecord],
    [org.memberRecord, eveRecord, bobRecord], // ORDRE INVERSÉ : même verdict exigé (jamais un "premier gagne").
  ]) {
    const { registry, rejected } = await buildTrustedMembership({ manifest: org.manifest, memberRecords: order });
    assert.notDeepEqual(
      registry.getPublicKey(bobIdentity.memberId), eveKeys.publicKeyJwk,
      "la clé d'Eve n'est JAMAIS celle qui fait foi pour le memberId de Bob"
    );
    // Le memberId est CONTESTÉ (clés divergentes) : ni Eve, ni (dans cette
    // variante stricte) Bob ne sont admis — le contrat accepte ce minimum
    // ("au minimum le slot va en conflit — mais AUCUNE admission de
    // l'attaquant"). Les DEUX fiches apparaissent en `rejected`, observables.
    assert.equal(registry.getMembership(bobIdentity.memberId), null, "aucune admission fantôme sous le memberId de Bob");
    assert.equal(rejected.length, 2, "les deux fiches contestées sont rejetées, jamais une disparition silencieuse");
    assert.ok(rejected.every((r) => /contesté/i.test(r.reason)), "raison explicite : memberId contesté");
  }
});

// ---------------------------------------------------------------------------
// Cas 1bis — MÊME scénario, mais via le pipeline COMPLET sur Drive
// (getAllCandidates + listGovernance + loadTrust), collision PHYSIQUE de
// fichiers (round 1 + round 2 ensemble). Reproduit exactement
// attack-driveorg2-escalation.mjs.
// ---------------------------------------------------------------------------
test("cas 1bis (Drive, pipeline complet) — fichier hostile <bobMemberId>.piloteo déposé HORS putImmutable, createdTime antérieur au fichier légitime -> la clé d'Eve n'est jamais admise, même quand elle 'gagne' l'ordre de tri physique", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Cabinet Attaqué Drive", null);
  const adapter = driveAdapter(drive, root);
  await adapter.connect();

  const { org, ownerIdentity, ownerSigner } = await makeOrg("Cabinet Attaqué Drive");
  await writeManifest(adapter, org.manifest);
  await writeMemberRecord(adapter, org.memberRecord);

  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const bobIdentity = await newMemberIdentity();
  const { memberRecord: bobRecord } = await acceptInvitation({ invitation, identity: bobIdentity, consultantId: "c-bob" });
  await writeMemberRecord(adapter, bobRecord); // fichier légitime, via putImmutable.

  const bobFileName = fileNameForKind("member", bobIdentity.memberId);
  const bobNode = [...drive.nodes.values()].find((n) => n.name === bobFileName && n.mimeType !== "application/vnd.google-apps.folder");
  assert.ok(bobNode, "sanity : le fichier physique de Bob existe");

  const eveKeys = await cryptoService.generateMemberIdentity();
  const eveIdentity = { memberId: bobIdentity.memberId, publicKeyJwk: eveKeys.publicKeyJwk, privateKeyRef: eveKeys.privateKeyRef };
  const { memberRecord: eveRecord } = await acceptInvitation({ invitation, identity: eveIdentity, consultantId: "c-eve" });

  // Dépôt HOSTILE, hors putImmutable, avec un `createdTime` ANTÉRIEUR au
  // fichier réel de Bob — LE seul critère de tri utilisé par
  // `_findAllFilesByNameInKindSubtree` : si l'admission dépendait encore de
  // cet ordre, Eve "gagnerait" en étant examinée en premier.
  const hostileId = `hostile-${drive.newId()}`;
  drive.nodes.set(hostileId, {
    id: hostileId,
    name: bobFileName,
    mimeType: "application/octet-stream",
    parents: bobNode.parents,
    createdTime: new Date(new Date(bobNode.createdTime).getTime() - 60_000).toISOString(),
    content: JSON.stringify(eveRecord),
    size: JSON.stringify(eveRecord).length,
  });

  // Round 1 (DoS) toujours fermé : les DEUX candidats sont fournis, jamais un throw.
  const candidates = await adapter.getAllCandidates("member", bobIdentity.memberId);
  assert.equal(candidates.length, 2);

  const trust = await loadTrust(adapter);
  assert.notDeepEqual(
    trust.registry.getPublicKey(bobIdentity.memberId), eveKeys.publicKeyJwk,
    "round 2 fermé : même en 'gagnant' le tri physique par createdTime, la clé d'Eve n'est jamais admise"
  );
  assert.equal(trust.registry.getMembership(bobIdentity.memberId), null, "memberId contesté -> aucune admission fantôme");
  assert.ok(
    trust.rejected.some((r) => r.reason && /contesté/i.test(r.reason)),
    "conflit observable (rejected), jamais une disparition/admission silencieuse"
  );
  // Le owner, lui, reste intact (round 1) et peut toujours agir.
  assert.equal(trust.registry.getPublicKey(org.manifest.ownerMemberId).x, ownerIdentity.publicKeyJwk.x);
});

// ---------------------------------------------------------------------------
// Cas 2 — Invitation rejouée par deux identités DIFFÉRENTES (memberId
// distincts, pas un vol de memberId) : aucune des deux n'obtient le rôle,
// quel que soit l'ordre d'examen.
// ---------------------------------------------------------------------------
test("cas 2 — invitation rejouée par deux memberId DIFFÉRENTS (Bob et Mallory) -> aucun des deux n'est admis, conflit observable, indépendant de l'ordre", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });

  const bobIdentity = await newMemberIdentity();
  const { memberRecord: bobRecord } = await acceptInvitation({ invitation, identity: bobIdentity, consultantId: "c-bob" });
  const malloryIdentity = await newMemberIdentity();
  const { memberRecord: malloryRecord } = await acceptInvitation({ invitation, identity: malloryIdentity, consultantId: "c-mallory" });

  for (const order of [
    [org.memberRecord, bobRecord, malloryRecord],
    [org.memberRecord, malloryRecord, bobRecord],
  ]) {
    const { trusted, rejected, registry } = await buildTrustedMembership({ manifest: org.manifest, memberRecords: order });
    assert.equal(trusted.length, 1, "genèse seule — ni Bob ni Mallory");
    assert.equal(rejected.length, 2, "les deux fiches contestées sont rejetées");
    assert.equal(registry.getMembership(bobIdentity.memberId), null);
    assert.equal(registry.getMembership(malloryIdentity.memberId), null);
    rejected.forEach((r) => assert.match(r.reason, /rejou|rejeu/i));
  }
});

// ---------------------------------------------------------------------------
// Cas 3 — Owner intouchable : une fiche hostile réutilisant ownerMemberId
// (avec une autre clé) est ignorée, l'owner reste owner via le manifeste.
// ---------------------------------------------------------------------------
test("cas 3 — fiche hostile réutilisant ownerMemberId (autre clé, fausse genèse) -> ignorée, l'owner reste owner (manifeste)", async () => {
  const { org, ownerIdentity } = await makeOrg();
  const attackerIdentity = await newMemberIdentity();
  const forgedGenesis = {
    kind: "member",
    memberId: org.manifest.ownerMemberId,
    publicKeyJwk: attackerIdentity.publicKeyJwk,
    membership: { workspaceId: org.workspace.workspaceId, memberId: org.manifest.ownerMemberId, role: "owner", status: "active", consultantId: "c-attacker" },
    authorization: { genesis: true },
  };

  const { registry, trusted, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [forgedGenesis], // genèse RÉELLE pas même publiée : le manifeste seul doit suffire.
  });
  assert.deepEqual(registry.getPublicKey(org.manifest.ownerMemberId), org.manifest.ownerPublicKeyJwk, "la clé de l'owner reste celle du MANIFESTE, jamais celle de l'attaquant");
  assert.equal(registry.getMembership(org.manifest.ownerMemberId).role, "owner");
  assert.equal(trusted.length, 0, "la fiche genèse forgée n'est pas admise dans 'trusted'");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].record, forgedGenesis);
});

// ---------------------------------------------------------------------------
// Cas 4 — Non-régression : le cas NOMINAL (une invitation, une identité)
// admet normalement ; un doublon EXACT (même memberId, même clé, même
// contenu canonique) n'est pas un conflit, admis une fois.
// ---------------------------------------------------------------------------
test("cas 4 — non-régression : invitation consommée UNE fois par UNE identité -> membre admis normalement ; un doublon EXACT (même clé, même contenu) n'est pas un conflit", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const bobIdentity = await newMemberIdentity();
  const { memberRecord: bobRecord } = await acceptInvitation({ invitation, identity: bobIdentity, consultantId: "c-bob" });

  // Cas nominal simple.
  const nominal = await buildTrustedMembership({ manifest: org.manifest, memberRecords: [org.memberRecord, bobRecord] });
  assert.equal(nominal.trusted.length, 2, "genèse + Bob");
  assert.equal(nominal.rejected.length, 0);
  assert.deepEqual(nominal.registry.getPublicKey(bobIdentity.memberId), bobIdentity.publicKeyJwk);
  assert.equal(nominal.registry.getMembership(bobIdentity.memberId).role, "user");

  // Doublon EXACT (même objet, resérialisé — simule deux candidats physiques
  // identiques, ex. un retry idempotent côté Drive/dossier) : PAS un conflit,
  // Bob toujours admis UNE fois, aucun rejet.
  const bobRecordClone = JSON.parse(JSON.stringify(bobRecord));
  const withDuplicate = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, bobRecord, bobRecordClone],
  });
  assert.equal(withDuplicate.trusted.length, 2, "genèse + Bob (le doublon exact ne compte pas comme une 2e entrée)");
  assert.equal(withDuplicate.rejected.length, 0, "un doublon EXACT n'est PAS un conflit (règle 4) — zéro rejet");
  assert.equal(withDuplicate.registry.getMembership(bobIdentity.memberId).role, "user");
});

// ---------------------------------------------------------------------------
// Cas 5 — Révocations : une fiche de révocation hostile divergente ne fait
// PAS disparaître une vraie révocation, ni n'en injecte une admise.
// ---------------------------------------------------------------------------
test("cas 5 — révocation hostile divergente : ne fait pas disparaître la VRAIE révocation, et n'est jamais elle-même admise (signature invalide, jamais un arbitrage createdTime)", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const adminIdentity = await newMemberIdentity();
  const { membership: adminMembership, memberRecord: adminRecord } = await acceptInvitation({ invitation, identity: adminIdentity, consultantId: "c-admin" });

  // Révocation LÉGITIME (signée par le owner, seule autorité).
  const realRevocation = await createRevocation({
    workspaceId: org.workspace.workspaceId, revokedMemberId: adminIdentity.memberId,
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership,
    revokedRole: "admin", signer: ownerSigner,
  });

  // Révocation HOSTILE : cible un memberId DIFFÉRENT (Alice/owner elle-même,
  // ce qui serait catastrophique si admis) et prétend être émise par le owner,
  // mais avec un `proof` FORGÉ (l'attaquant ne détient AUCUNE clé de confiance
  // — il ne peut pas produire une vraie signature Ed25519 de l'owner).
  const bogusProof = await cryptoService.sign((await newMemberIdentity()).privateKeyRef, new TextEncoder().encode("n'importe quoi"));
  const hostileRevocation = {
    kind: "revocation",
    revocationId: "hostile-revocation-id",
    workspaceId: org.workspace.workspaceId,
    revokedMemberId: ownerIdentity.memberId, // cible le OWNER lui-même.
    revokedAt: new Date(0).toISOString(), // createdTime/date "antérieure" arbitraire : SANS INCIDENCE.
    issuerId: ownerIdentity.memberId, // prétend être émise par le owner...
    proof: bogusProof, // ...mais la signature ne vérifie PAS (forgée par un tiers sans la clé du owner).
  };

  const { registry, revoked, rejected } = await buildTrustedMembership({
    manifest: org.manifest,
    memberRecords: [org.memberRecord, adminRecord],
    revocations: [hostileRevocation, realRevocation], // ordre arbitraire, y compris hostile EN PREMIER.
  });

  // La VRAIE révocation s'applique (admin bien révoqué).
  assert.equal(registry.getMembership(adminIdentity.memberId).status, "revoked", "la révocation LÉGITIME de l'admin s'applique toujours");
  assert.ok(revoked.some((r) => r.memberId === adminIdentity.memberId), "révocation légitime bien journalisée dans 'revoked'");

  // La révocation HOSTILE n'est JAMAIS appliquée : le owner reste actif.
  assert.equal(registry.getMembership(ownerIdentity.memberId).status, "active", "la révocation hostile (signature forgée) N'A PAS révoqué le owner");
  assert.ok(!revoked.some((r) => r.memberId === ownerIdentity.memberId), "aucune fausse révocation injectée pour le owner");
  assert.ok(
    rejected.some((r) => r.record === hostileRevocation),
    "la révocation hostile est explicitement rejetée (observable), jamais une disparition silencieuse"
  );

  // Même verdict avec l'ordre inversé (réel avant hostile) — aucune dépendance à l'ordre.
  const reversedOrder = await buildTrustedMembership({
    manifest: org.manifest,
    memberRecords: [org.memberRecord, adminRecord],
    revocations: [realRevocation, hostileRevocation],
  });
  assert.equal(reversedOrder.registry.getMembership(adminIdentity.memberId).status, "revoked");
  assert.equal(reversedOrder.registry.getMembership(ownerIdentity.memberId).status, "active");
});

// ---------------------------------------------------------------------------
// Cas 5bis (Drive, pipeline complet) — une fiche de révocation LÉGITIME et un
// fichier hostile PHYSIQUEMENT COLLISIONNANT (même nom de fichier — même
// `revocationId`, forgé après lecture du fichier légitime) : le correctif
// round 1 (getAllCandidates) fournit les deux candidats à la vérification de
// signature, qui rejette le hostile et laisse la vraie révocation s'appliquer.
// ---------------------------------------------------------------------------
test("cas 5bis (Drive, pipeline complet) — fichier de révocation hostile en collision physique (même nom) avec le fichier légitime -> la vraie révocation s'applique quand même, la hostile est rejetée", async () => {
  const drive = new FakeDrive();
  const root = drive.addFolder("Pilotéo - Révocation Drive", null);
  const adapter = driveAdapter(drive, root);
  await adapter.connect();

  const { org, ownerIdentity, ownerSigner } = await makeOrg("Révocation Drive");
  await writeManifest(adapter, org.manifest);
  await writeMemberRecord(adapter, org.memberRecord);

  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const adminIdentity = await newMemberIdentity();
  const { memberRecord: adminRecord } = await acceptInvitation({ invitation, identity: adminIdentity, consultantId: "c-admin" });
  await writeMemberRecord(adapter, adminRecord);

  const realRevocation = await createRevocation({
    workspaceId: org.workspace.workspaceId, revokedMemberId: adminIdentity.memberId,
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership,
    revokedRole: "admin", signer: ownerSigner,
  });
  await writeRevocation(adapter, realRevocation);

  const revocationFileName = fileNameForKind("member", "revocation-" + realRevocation.revocationId);
  const realNode = [...drive.nodes.values()].find((n) => n.name === revocationFileName && n.mimeType !== "application/vnd.google-apps.folder");
  assert.ok(realNode, "sanity : le fichier de révocation légitime existe physiquement");

  // Un tiers avec accès Éditeur brut lit le nom du fichier (pas secret) et y
  // dépose un fichier hostile portant EXACTEMENT LE MÊME NOM (même
  // revocationId), contenu forgé ciblant le OWNER — createdTime ANTÉRIEUR
  // pour tenter de "gagner" un éventuel tri physique.
  const bogusProof = await cryptoService.sign((await newMemberIdentity()).privateKeyRef, new TextEncoder().encode("forge"));
  const hostileRevocation = {
    kind: "revocation", revocationId: realRevocation.revocationId,
    workspaceId: org.workspace.workspaceId, revokedMemberId: ownerIdentity.memberId,
    revokedAt: new Date(0).toISOString(), issuerId: ownerIdentity.memberId, proof: bogusProof,
  };
  const hostileId = `hostile-rev-${drive.newId()}`;
  drive.nodes.set(hostileId, {
    id: hostileId,
    name: revocationFileName,
    mimeType: "application/octet-stream",
    parents: realNode.parents,
    createdTime: new Date(new Date(realNode.createdTime).getTime() - 60_000).toISOString(),
    content: JSON.stringify(hostileRevocation),
    size: JSON.stringify(hostileRevocation).length,
  });

  const candidates = await adapter.getAllCandidates("member", "revocation-" + realRevocation.revocationId);
  assert.equal(candidates.length, 2, "round 1 : les deux candidats physiques sont fournis, jamais un throw qui ferait disparaître le vrai");

  const trust = await loadTrust(adapter);
  assert.equal(trust.registry.getMembership(adminIdentity.memberId).status, "revoked", "la VRAIE révocation de l'admin s'applique toujours malgré la collision physique");
  assert.equal(trust.registry.getMembership(ownerIdentity.memberId).status, "active", "le owner N'EST PAS révoqué par le fichier hostile en collision");
});

// ===========================================================================
// Round contrariant 3 — EMPOISONNEMENT DE membershipStore
// (docs/next/ORG_TRUST_HARDENING_CONTRACT.md, correctif org-runtime.js
// PASSE 3 : `membershipStore.add(...)`/`registry._add(...)` ne doivent JAMAIS
// reprendre `record.membership.memberId`/`.role`/`.status` TELS QUELS — ces
// champs ne sont PAS couverts par `joinProof` (`joinCanonicalPayload` ne
// signe que `(invitationId, memberId, publicKeyJwk)`). N'IMPORTE QUEL membre
// légitimement admis (même rôle "user") pouvait publier une fiche dont SON
// PROPRE joinProof reste valide, mais dont `membership.memberId`/`.status`/
// `.role` visent/falsifient un TIERS. Reproduit
// attack-driveorg3-membership-poisoning.mjs / attack-driveorg3-syncengine-e2e.mjs
// (racine du dépôt).
// ===========================================================================

/** Construit une org avec un owner, un Bob (admin) révoqué, et une invitation
 *  légitime "honnête" pour Eve (rôle au choix) — harnais commun aux 3 cas.
 *  Round contrariant 4 : `consultantId` est désormais signé dans CHAQUE
 *  invitation (décidé par l'émetteur, le owner ici), plus un choix libre à
 *  l'acceptation — voir `tests/next/org-trust-hardening.test.mjs` cas 10-13. */
async function makePoisoningHarness(eveRole = "user") {
  const { org, ownerIdentity, ownerSigner } = await makeOrg("Cabinet Ciblé");

  const invBob = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin", consultantId: "c-bob",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const bobIdentity = await newMemberIdentity();
  const { memberRecord: bobRecord } = await acceptInvitation({ invitation: invBob, identity: bobIdentity });
  const revokeBob = await createRevocation({
    workspaceId: org.workspace.workspaceId, revokedMemberId: bobIdentity.memberId,
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership,
    revokedRole: "admin", signer: ownerSigner,
  });

  const invEve = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: eveRole, consultantId: "c-eve",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const eveIdentity = await newMemberIdentity();
  const { memberRecord: eveRecordHonest } = await acceptInvitation({ invitation: invEve, identity: eveIdentity });

  return { org, ownerIdentity, ownerSigner, bobIdentity, bobRecord, revokeBob, eveIdentity, eveRecordHonest };
}

test("cas 6 (round 3, ATTAQUE A) — un membre révoqué (Bob) ne peut PAS être ressuscité via membership.memberId/status falsifiés dans la fiche honnête d'un tiers (Eve, rôle 'user')", async () => {
  const { org, bobIdentity, bobRecord, revokeBob, eveRecordHonest } = await makePoisoningHarness("user");

  // Eve publie SA PROPRE fiche (joinProof valide pour SA clé/SON memberId),
  // mais avec `membership.memberId` pointant vers Bob et `status:"active"` —
  // le joinProof ne couvre PAS `membership`, donc cette falsification ne casse
  // aucune signature.
  const eveRecordResurrectsBob = {
    ...eveRecordHonest,
    membership: { ...eveRecordHonest.membership, memberId: bobIdentity.memberId, status: "active" },
  };

  const attack = await buildTrustedMembership({
    manifest: org.manifest,
    memberRecords: [org.memberRecord, bobRecord, eveRecordResurrectsBob],
    revocations: [revokeBob],
  });

  const bobMembership = attack.membershipStore.get(org.workspace.workspaceId, bobIdentity.memberId);
  assert.ok(bobMembership, "l'entrée de Bob existe toujours dans membershipStore");
  assert.equal(bobMembership.status, "revoked", "Bob RESTE 'revoked' — aucune résurrection via la fiche falsifiée d'un tiers");
  assert.equal(attack.registry.getMembership(bobIdentity.memberId).status, "revoked", "registry et membershipStore restent cohérents");
});

test("cas 7 (round 3, ATTAQUE B) — un membre (Eve, rôle 'user') ne peut PAS neutraliser le OWNER via membership.memberId/status falsifiés dans sa propre fiche", async () => {
  const { org, ownerIdentity, eveRecordHonest } = await makePoisoningHarness("user");

  const eveRecordKillsOwner = {
    ...eveRecordHonest,
    membership: { ...eveRecordHonest.membership, memberId: org.manifest.ownerMemberId, status: "revoked" },
  };

  const attack = await buildTrustedMembership({
    manifest: org.manifest,
    memberRecords: [org.memberRecord, eveRecordKillsOwner],
    revocations: [],
  });

  const ownerMembership = attack.membershipStore.get(org.workspace.workspaceId, org.manifest.ownerMemberId);
  assert.ok(ownerMembership, "l'entrée du owner existe dans membershipStore");
  assert.equal(ownerMembership.status, "active", "le OWNER reste 'active' — jamais neutralisé par la fiche falsifiée d'un tiers");
  assert.equal(attack.registry.getMembership(org.manifest.ownerMemberId).status, "active");
});

test("cas 8 (round 3, escalade de rôle) — un membre invité 'user' ne peut PAS se hisser 'admin' via membership.role falsifié : soit la fiche est rejetée d'emblée (garde-fou évaluation existant), soit — si elle était admise — le rôle proviendrait TOUJOURS de l'invitation VÉRIFIÉE, jamais de l'objet membership", async () => {
  const { org, eveIdentity, eveRecordHonest } = await makePoisoningHarness("user");

  const eveRecordSelfPromotes = {
    ...eveRecordHonest,
    membership: { ...eveRecordHonest.membership, role: "admin" }, // falsifie SON PROPRE rôle (memberId inchangé, cette fois).
  };

  const attack = await buildTrustedMembership({
    manifest: org.manifest,
    memberRecords: [org.memberRecord, eveRecordSelfPromotes],
    revocations: [],
  });

  // Défense en profondeur À DEUX NIVEAUX, toutes deux vérifiées ici :
  //  (1) `evaluate()` (PASSE 1, INCHANGÉE) rejette déjà toute fiche dont
  //      `membership.role !== invitation.role` — Eve n'est donc PAS admise du
  //      tout dans ce cas précis (aucune entrée, ni registry ni
  //      membershipStore) : AUCUNE escalade, observable dans `rejected`.
  const eveMembership = attack.membershipStore.get(org.workspace.workspaceId, eveIdentity.memberId);
  assert.equal(eveMembership, null, "aucune admission pour une fiche auto-incohérente (role != invitation.role) — comportement déjà correct, INCHANGÉ");
  assert.equal(attack.registry.getMembership(eveIdentity.memberId), null);
  assert.ok(
    attack.rejected.some((r) => r.record === eveRecordSelfPromotes && /rôle du membership/i.test(r.reason)),
    "rejet explicite et observable (jamais une disparition silencieuse)"
  );

  //  (2) MÊME quand `membership.role` COÏNCIDE avec l'invitation (donc passe
  //      `evaluate()`), la valeur EFFECTIVEMENT écrite dans registry/
  //      membershipStore (PASSE 3, correctif de ce round) provient
  //      structurellement de `record.authorization.invitation.role` — jamais
  //      d'une lecture de `record.membership.role` — ce qui BORNE aussi tout
  //      chemin FUTUR qui admettrait une fiche sans repasser par ce contrôle
  //      de correspondance. Vérifié directement ici : le champ EFFECTIVEMENT
  //      utilisé pour un membre honnête est bien celui de l'invitation.
  const honestAttempt = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, eveRecordHonest], revocations: [],
  });
  const honestMembership = honestAttempt.membershipStore.get(org.workspace.workspaceId, eveIdentity.memberId);
  assert.equal(honestMembership.role, "user", "le rôle admis correspond exactement à celui de l'invitation vérifiée");
});

test("cas 9 (round 3, non-régression) — cas nominal : un membre invité est admis avec son VRAI rôle (celui de l'invitation) ; une révocation légitime s'applique toujours après le correctif", async () => {
  const { org, bobIdentity, bobRecord, revokeBob, eveIdentity, eveRecordHonest } = await makePoisoningHarness("admin");

  // Sans AUCUNE falsification : Eve (invitée "admin") est admise avec role="admin".
  const nominal = await buildTrustedMembership({
    manifest: org.manifest,
    memberRecords: [org.memberRecord, eveRecordHonest],
    revocations: [],
  });
  const eveMembership = nominal.membershipStore.get(org.workspace.workspaceId, eveIdentity.memberId);
  assert.ok(eveMembership, "Eve est admise normalement");
  assert.equal(eveMembership.role, "admin", "le rôle nominal (depuis l'invitation, non falsifié) est toujours correctement attribué");
  assert.equal(eveMembership.status, "active");
  assert.equal(eveMembership.consultantId, "c-eve", "le consultantId nominal (depuis l'invitation SIGNÉE — round 4) est correctement attribué");

  // Bob (admin), révoqué légitimement (SANS attaque) : toujours 'revoked'.
  const withRevocation = await buildTrustedMembership({
    manifest: org.manifest,
    memberRecords: [org.memberRecord, bobRecord],
    revocations: [revokeBob],
  });
  const bobMembership = withRevocation.membershipStore.get(org.workspace.workspaceId, bobIdentity.memberId);
  assert.ok(bobMembership);
  assert.equal(bobMembership.role, "admin", "le rôle de Bob (depuis SON invitation) reste correct même révoqué");
  assert.equal(bobMembership.status, "revoked", "la révocation légitime s'applique toujours normalement après le correctif");
});

// ===========================================================================
// Round contrariant 4 — USURPATION DE consultantId
// (docs/next/ORG_TRUST_HARDENING_CONTRACT.md, correctif : `consultantId` est
// désormais SIGNÉ dans l'invitation — `invitations.js#canonicalPayload` — et
// `org-runtime.js#acceptInvitation` n'utilise plus JAMAIS un `consultantId`
// fourni librement par l'accepteur. `core/permissions.js` scope TOUTE
// lecture/écriture non-admin par égalité stricte sur `consultantId` : avant ce
// correctif, n'importe quel membre légitimement invité pouvait déclarer, à
// l'acceptation de SA PROPRE invitation, le `consultantId` d'un AUTRE
// consultant existant et se faire traiter comme lui. Reproduit
// attack-driveorg4-consultantid-impersonation.mjs (racine du dépôt).
// ===========================================================================

test("cas 10 (round 4, repro contrariant) — Ève ne peut PAS usurper le consultantId de Bob en le déclarant librement à l'acceptation de SA PROPRE invitation légitime", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg("Le Clat d'Théia");

  // L'admin (owner) invite Ève en tant que "user", SANS lui destiner un
  // consultant précis à l'émission (cas le plus défavorable : c'est
  // EXACTEMENT le scénario du repro contrariant).
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });

  const eveIdentity = await newMemberIdentity();
  // Ève, avec SA PROPRE identité/joinProof valides, déclare `consultantId:"c-bob"`
  // — le profil d'un AUTRE consultant déjà existant dans l'organisation.
  const { memberRecord: eveRecord } = await acceptInvitation({
    invitation, identity: eveIdentity, consultantId: "c-bob", // <- usurpation tentée, paramètre désormais IGNORÉ.
  });

  const { membershipStore, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, eveRecord],
  });
  assert.equal(rejected.length, 0, "Ève reste normalement admise (son identité/invitation sont légitimes)");

  const eveMembership = membershipStore.get(org.workspace.workspaceId, eveIdentity.memberId);
  assert.ok(eveMembership, "Ève est admise");
  assert.equal(eveMembership.role, "user");
  assert.notEqual(eveMembership.consultantId, "c-bob", "JAMAIS le consultantId usurpé de Bob");
  assert.equal(eveMembership.consultantId, null, "aucun consultant n'ayant été précisé à l'invitation, consultantId reste null — jamais un choix libre de l'accepteur");
});

test("cas 11 (round 4) — le consultantId admis provient TOUJOURS de l'invitation SIGNÉE, jamais du paramètre libre de acceptInvitation (même quand il coïncide, même quand il diverge)", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user", consultantId: "c-eve",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const eveIdentity = await newMemberIdentity();

  // Variante A : le paramètre libre COÏNCIDE avec l'invitation -> consultantId
  // final == "c-eve" (mais parce que c'est ce que l'invitation portait, pas
  // parce que l'accepteur l'a choisi).
  const { memberRecord: recordMatching } = await acceptInvitation({ invitation, identity: eveIdentity, consultantId: "c-eve" });
  const trustMatching = await buildTrustedMembership({ manifest: org.manifest, memberRecords: [org.memberRecord, recordMatching] });
  assert.equal(trustMatching.membershipStore.get(org.workspace.workspaceId, eveIdentity.memberId).consultantId, "c-eve");

  // Variante B : le paramètre libre DIVERGE de l'invitation -> IGNORÉ, le
  // consultantId final reste EXACTEMENT celui de l'invitation ("c-eve").
  const { memberRecord: recordDivergent } = await acceptInvitation({ invitation, identity: eveIdentity, consultantId: "c-un-autre-profil" });
  const trustDivergent = await buildTrustedMembership({ manifest: org.manifest, memberRecords: [org.memberRecord, recordDivergent] });
  assert.equal(
    trustDivergent.membershipStore.get(org.workspace.workspaceId, eveIdentity.memberId).consultantId,
    "c-eve",
    "le paramètre libre divergent est totalement ignoré — la valeur de l'invitation SIGNÉE prévaut toujours"
  );
});

test("cas 12 (round 4) — genèse : le consultantId du owner provient du MANIFESTE (write-once), jamais d'une fiche membre falsifiable", async () => {
  const { org, ownerIdentity } = await makeOrg("Cabinet Genèse");
  assert.equal(org.manifest.ownerConsultantId, "c-owner", "le manifeste ancre le consultantId du owner, comme ownerMemberId/ownerPublicKeyJwk");

  // Fiche genèse LÉGITIME (publiée par createOrganization elle-même) : le
  // consultantId admis doit correspondre au manifeste.
  const { membershipStore } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord],
  });
  assert.equal(membershipStore.get(org.workspace.workspaceId, ownerIdentity.memberId).consultantId, "c-owner");

  // Une fiche genèse qui divergerait sur `membership.consultantId` (par
  // ailleurs conforme au manifeste sur memberId/role/publicKeyJwk) n'aurait de
  // toute façon aucune incidence : PASSE 3 lit `manifest.ownerConsultantId`,
  // jamais `record.membership.consultantId`, pour la genèse.
  const tamperedGenesis = { ...org.memberRecord, membership: { ...org.memberRecord.membership, consultantId: "c-usurpe" } };
  const trustTampered = await buildTrustedMembership({ manifest: org.manifest, memberRecords: [tamperedGenesis] });
  const ownerMembership = trustTampered.membershipStore.get(org.workspace.workspaceId, ownerIdentity.memberId);
  assert.ok(ownerMembership, "la fiche genèse (par ailleurs conforme) reste admise");
  assert.equal(ownerMembership.consultantId, "c-owner", "le consultantId du owner vient TOUJOURS du manifeste, jamais de la fiche membre");
});

test("cas 13 (round 4, non-régression) — nominal : l'owner signe consultantId=X à l'invitation -> le membre est admis avec CE consultantId X (invite -> accept -> admis)", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin", consultantId: "c-cible-precise",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  assert.equal(invitation.consultantId, "c-cible-precise", "consultantId fait bien partie de l'invitation (signée)");

  const memberIdentity = await newMemberIdentity();
  const { memberRecord } = await acceptInvitation({ invitation, identity: memberIdentity });

  const { membershipStore, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, memberRecord],
  });
  assert.equal(rejected.length, 0);
  const membership = membershipStore.get(org.workspace.workspaceId, memberIdentity.memberId);
  assert.equal(membership.role, "admin");
  assert.equal(membership.consultantId, "c-cible-precise", "le membre est admis avec EXACTEMENT le consultantId choisi par l'émetteur à l'invitation");
});
