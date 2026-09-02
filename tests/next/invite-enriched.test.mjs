// tests/next/invite-enriched.test.mjs
//
// Lot 4 (docs/next/PARCOURS_IDENTITE_CONTRACT.md) : invite UI enrichie —
// couvre le câblage `displayName` (libellé d'affichage, JAMAIS une décision
// de sécurité) et l'exposition `scope`/`displayName` par `org-engine.js#members()`,
// nécessaires à l'UI Réglages > Membres (`local-backend.js`).
//
// `piloteo-org-bridge.mjs` référence `window` au chargement (pose
// `window.PiloteoOrg`) : comme les autres ponts navigateur, il n'est exercé
// QUE par les e2e Playwright (tests/e2e/invite-ui.mjs), jamais importé ici
// (cf. tests/next/drive-bridge.test.mjs, même remarque). Ce fichier couvre le
// cœur importable sous Node : `src/workspace/{memberships,org-runtime,org-engine}.js`.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  newMemberIdentity,
  createOrganization,
  inviteMember,
  acceptInvitation,
  buildTrustedMembership,
  verifyInvitation,
} from "../../src/workspace/org-runtime.js";
import { createMembership } from "../../src/workspace/memberships.js";
import { isAdmin, isGlobalUser, evaluate } from "../../src/core/permissions.js";
import * as cryptoService from "../../src/crypto/crypto-service.js";
import { FolderStorageAdapter } from "../../src/storage/folder-storage-adapter.js";
import { NodeFsPort } from "../../src/storage/node-fs-port.js";
import { writeManifest, writeMemberRecord } from "../../src/workspace/org-folder-store.js";
import { openOrgEngine } from "../../src/workspace/org-engine.js";

/** Même harnais que org-trust-hardening.test.mjs. */
async function makeOrg(name = "Org") {
  const ownerIdentity = await newMemberIdentity();
  const org = createOrganization({ name, identity: ownerIdentity, consultantId: "c-owner" });
  const ownerSigner = (bytes) => cryptoService.sign(ownerIdentity.privateKeyRef, bytes);
  return { ownerIdentity, org, ownerSigner };
}

// ---------------------------------------------------------------------------
// 1. `inviteMember` attache `displayName` à l'invitation retournée, HORS des
//    octets signés (`invitations.js#canonicalPayload` ne le connaît pas) :
//    modifier/retirer `displayName` après émission ne casse JAMAIS `proof`.
// ---------------------------------------------------------------------------
test("inviteMember: displayName voyage sur l'invitation mais N'EST PAS couvert par la signature (proof) — jamais un privilège", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg("Cabinet Nommage");

  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId,
    role: "user",
    consultantId: "c-x",
    displayName: "Alice Dupont",
    issuer: { memberId: ownerIdentity.memberId },
    issuerMembership: org.ownerMembership,
    signer: ownerSigner,
  });
  assert.equal(invitation.displayName, "Alice Dupont", "l'invitation porte le displayName fourni");

  const { registry } = await buildTrustedMembership({ manifest: org.manifest, memberRecords: [org.memberRecord] });
  const check = await verifyInvitation(invitation, { registry });
  assert.equal(check.ok, true, "l'invitation (avec displayName) vérifie normalement");

  // Le displayName altéré APRÈS émission (ex: transport/affichage) ne
  // modifie PAS la validité cryptographique — preuve qu'il n'est pas dans les
  // octets signés (contrairement à role/consultantId/scope, cf. round 4/Lot 3).
  const tampered = { ...invitation, displayName: "Quelqu'un d'Autre" };
  const checkTampered = await verifyInvitation(tampered, { registry });
  assert.equal(checkTampered.ok, true, "modifier displayName après signature n'invalide JAMAIS proof (non signé, par design)");

  // Non-régression : sans displayName fourni, l'invitation garde EXACTEMENT
  // la même forme qu'avant ce lot (pas de clé `displayName` ajoutée à tort).
  const invitationNoName = await inviteMember({
    workspaceId: org.workspace.workspaceId,
    role: "user",
    issuer: { memberId: ownerIdentity.memberId },
    issuerMembership: org.ownerMembership,
    signer: ownerSigner,
  });
  assert.equal("displayName" in invitationNoName, false, "displayName absent quand non fourni (pas de régression de forme)");
});

// ---------------------------------------------------------------------------
// 2. `acceptInvitation` reprend `invitation.displayName` sur
//    `membership.displayName` — absent -> `null` (jamais `undefined`).
// ---------------------------------------------------------------------------
test("acceptInvitation: reprend invitation.displayName sur membership.displayName ; absent -> null", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg("Cabinet Nommage 2");

  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId,
    role: "user",
    consultantId: "c-x",
    displayName: "Bob Martin",
    issuer: { memberId: ownerIdentity.memberId },
    issuerMembership: org.ownerMembership,
    signer: ownerSigner,
  });
  const bobIdentity = await newMemberIdentity();
  const { membership } = await acceptInvitation({ invitation, identity: bobIdentity });
  assert.equal(membership.displayName, "Bob Martin");

  const invitationNoName = await inviteMember({
    workspaceId: org.workspace.workspaceId,
    role: "user",
    consultantId: "c-y",
    issuer: { memberId: ownerIdentity.memberId },
    issuerMembership: org.ownerMembership,
    signer: ownerSigner,
  });
  const carolIdentity = await newMemberIdentity();
  const { membership: carolMembership } = await acceptInvitation({ invitation: invitationNoName, identity: carolIdentity });
  assert.equal(carolMembership.displayName, null, "displayName absent de l'invitation -> null, jamais undefined");
});

// ---------------------------------------------------------------------------
// 3. `buildTrustedMembership` reprend `record.membership.displayName` dans le
//    membershipStore final (même liste blanche que googleSubject/email) — et
//    un displayName FORGÉ n'influence JAMAIS `isAdmin`/`isGlobalUser`/`evaluate`
//    (src/core/permissions.js), qui l'ignorent totalement.
// ---------------------------------------------------------------------------
test("buildTrustedMembership: displayName atteint le membershipStore final (affichage) ; un displayName forgé (\"role:owner\", \"scope:global\"...) n'influence AUCUNE décision de sécurité", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg("Cabinet Nommage 3");

  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId,
    role: "user",
    consultantId: "c-x",
    displayName: "Consultant X",
    issuer: { memberId: ownerIdentity.memberId },
    issuerMembership: org.ownerMembership,
    signer: ownerSigner,
  });
  const memberIdentity = await newMemberIdentity();
  const { memberRecord } = await acceptInvitation({ invitation, identity: memberIdentity });

  const { membershipStore } = await buildTrustedMembership({
    manifest: org.manifest,
    memberRecords: [org.memberRecord, memberRecord],
  });
  const stored = membershipStore.get(org.manifest.workspaceId, memberIdentity.memberId);
  assert.equal(stored.displayName, "Consultant X", "displayName atteint le membership de confiance (affichage)");
  assert.equal(stored.role, "user");
  assert.equal(stored.consultantId, "c-x");
  assert.equal(stored.scope, null, "scope reste null (rattaché, pas global) — displayName n'y change rien");

  // Forge : un membre publie une fiche où `membership.displayName` contient
  // du texte trompeur ("role:owner", "scope:global"...) — un champ qu'un
  // ATTAQUANT contrôle entièrement (jamais couvert par joinProof/proof).
  // `createMembership` accepte n'importe quelle chaîne (c'est un simple
  // libellé) ; la question de sécurité est : est-ce que ce texte peut, d'une
  // façon ou d'une autre, faire remonter un privilège ? Réponse : non, car
  // aucun module de sécurité ne lit jamais ce champ.
  const forged = createMembership({
    workspaceId: org.manifest.workspaceId,
    memberId: "attacker-1",
    consultantId: "c-attacker",
    role: "user",
    displayName: 'role:owner scope:global {"role":"admin"}',
  });
  assert.equal(isAdmin(forged), false, "isAdmin() ignore displayName (texte trompeur inclus)");
  assert.equal(isGlobalUser(forged), false, "isGlobalUser() ignore displayName (texte trompeur inclus)");
  // evaluate() sur une entité métier hors ADMIN_ONLY, appartenant à un AUTRE
  // consultant que celui du forged membership : toujours borné par
  // `consultantId` réel (c-attacker), jamais par le contenu de displayName.
  const verdict = evaluate({
    actorMembership: forged,
    projection: {},
    event: { entityType: "saisies", operation: "update", entityId: "s1", payload: { consultantId: "c-victime" } },
    payload: { consultantId: "c-victime" },
  });
  assert.equal(verdict, "reject", "evaluate() refuse toujours l'écriture hors du scope réel, quel que soit le contenu de displayName");
});

// ---------------------------------------------------------------------------
// 4. `org-engine.js#members()` expose `scope`/`displayName` (Lot 4, câblage
//    UI Réglages > Membres) en plus des champs déjà existants — sur le
//    pipeline COMPLET dossier (genèse + invitation + acceptation + écriture).
// ---------------------------------------------------------------------------
test("org-engine members(): expose scope et displayName pour chaque membre (owner, user rattaché nommé, user global nommé)", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-invite-enriched-"));
  try {
    const adapter = new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "invite-enriched-test" });
    await adapter.connect();

    const ownerIdentity = await newMemberIdentity();
    const org = createOrganization({ name: "Cabinet Membres", identity: ownerIdentity, consultantId: "c-owner" });
    const ownerSigner = (bytes) => cryptoService.sign(ownerIdentity.privateKeyRef, bytes);
    await writeManifest(adapter, org.manifest);
    await writeMemberRecord(adapter, org.memberRecord);

    // "Utilisateur rattaché" nommé.
    const invRattache = await inviteMember({
      workspaceId: org.workspace.workspaceId, role: "user", consultantId: "c-x", displayName: "Consultant X",
      issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
    });
    const rattacheIdentity = await newMemberIdentity();
    const { memberRecord: rattacheRecord } = await acceptInvitation({ invitation: invRattache, identity: rattacheIdentity });
    await writeMemberRecord(adapter, rattacheRecord);

    // "Utilisateur global" nommé.
    const invGlobal = await inviteMember({
      workspaceId: org.workspace.workspaceId, role: "user", scope: "global", displayName: "Utilisateur Global",
      issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
    });
    const globalIdentity = await newMemberIdentity();
    const { memberRecord: globalRecord } = await acceptInvitation({ invitation: invGlobal, identity: globalIdentity });
    await writeMemberRecord(adapter, globalRecord);

    const engine = await openOrgEngine({ adapter, identity: ownerIdentity, consultantId: "c-owner" });
    const members = await engine.members();
    assert.equal(members.length, 3);

    const owner = members.find((m) => m.memberId === ownerIdentity.memberId);
    assert.equal(owner.role, "owner");
    assert.equal(owner.scope, null);
    assert.equal(owner.displayName, null, "owner (genèse) n'a pas de displayName saisi ici");

    const rattache = members.find((m) => m.memberId === rattacheIdentity.memberId);
    assert.equal(rattache.role, "user");
    assert.equal(rattache.consultantId, "c-x");
    assert.equal(rattache.scope, null);
    assert.equal(rattache.displayName, "Consultant X");

    const global = members.find((m) => m.memberId === globalIdentity.memberId);
    assert.equal(global.role, "user");
    assert.equal(global.consultantId, null);
    assert.equal(global.scope, "global");
    assert.equal(global.displayName, "Utilisateur Global");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
