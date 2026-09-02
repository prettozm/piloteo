// tests/next/scope-hardening.test.mjs
//
// Lot 3 — docs/next/PARCOURS_IDENTITE_CONTRACT.md : rôle « utilisateur global »
// (role:"user" + scope:"global"). Ce fichier couvre l'ANTI-ESCALADE (le volet
// sécurité explicitement exigé par le contrat, même style que
// docs/next/ORG_TRUST_HARDENING_CONTRACT.md pour `consultantId` au round 4) :
// une fiche membre qui DÉCLARE `scope:"global"` sans invitation signée
// correspondante ne doit JAMAIS obtenir l'accès global — la portée provient
// EXCLUSIVEMENT de l'invitation SIGNÉE par l'owner/admin émetteur, vérifiée
// par `verifyInvitation`/`buildTrustedMembership`, jamais d'un champ
// auto-déclaré. Complète (ne duplique pas) `org-trust-hardening.test.mjs`.

import test from "node:test";
import assert from "node:assert/strict";
import {
  newMemberIdentity,
  createOrganization,
  inviteMember,
  acceptInvitation,
  buildTrustedMembership,
} from "../../src/workspace/org-runtime.js";
import * as cryptoService from "../../src/crypto/crypto-service.js";
import { canonicalPayload } from "../../src/workspace/invitations.js";
import { isGlobalUser, isAdmin, evaluate } from "../../src/core/permissions.js";

async function makeOrg(name = "Org") {
  const ownerIdentity = await newMemberIdentity();
  const org = createOrganization({ name, identity: ownerIdentity, consultantId: "c-owner" });
  const ownerSigner = (bytes) => cryptoService.sign(ownerIdentity.privateKeyRef, bytes);
  return { ownerIdentity, org, ownerSigner };
}

// ---------------------------------------------------------------------------
// Nominal : l'owner invite explicitement un « user global » -> membre admis
// avec scope:"global", consultantId:null (aucun consultant cible précisé).
// ---------------------------------------------------------------------------

test("nominal — owner invite un user GLOBAL (role:user, scope:global) : le membre admis porte scope:'global' et voit tout le métier", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg("Cabinet Global");

  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user", scope: "global",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  assert.equal(invitation.scope, "global", "scope fait bien partie de l'invitation (signée)");

  const gigiIdentity = await newMemberIdentity();
  const { membership, memberRecord } = await acceptInvitation({ invitation, identity: gigiIdentity });
  assert.equal(membership.role, "user");
  assert.equal(membership.scope, "global", "propagé depuis l'invitation vérifiée");
  assert.equal(membership.consultantId, null);

  const { membershipStore, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, memberRecord],
  });
  assert.equal(rejected.length, 0);
  const trustedMembership = membershipStore.get(org.workspace.workspaceId, gigiIdentity.memberId);
  assert.equal(trustedMembership.role, "user");
  assert.equal(trustedMembership.scope, "global");
  assert.equal(isGlobalUser(trustedMembership), true);
  assert.equal(isAdmin(trustedMembership), false, "un user global n'est PAS admin (gouvernance fermée)");
});

test("nominal — owner invite un user RATTACHÉ (consultantId, sans scope) : reste rattaché, scope:null, jamais 'global'", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user", consultantId: "c-bob",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  assert.equal(invitation.scope, undefined, "aucun scope signé");

  const bobIdentity = await newMemberIdentity();
  const { memberRecord } = await acceptInvitation({ invitation, identity: bobIdentity });
  const { membershipStore } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, memberRecord],
  });
  const bobMembership = membershipStore.get(org.workspace.workspaceId, bobIdentity.memberId);
  assert.equal(bobMembership.consultantId, "c-bob");
  assert.equal(bobMembership.scope, null);
  assert.equal(isGlobalUser(bobMembership), false);
});

test("non-régression — owner/admin restent inchangés : scope n'a d'effet que sur role:'user' (isAdmin court-circuite isGlobalUser)", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();
  // Un scope:"global" posé sur une invitation 'admin' est accepté (pas
  // d'erreur) mais totalement sans incidence : l'admin voit déjà tout.
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "admin", scope: "global",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  const adminIdentity = await newMemberIdentity();
  const { memberRecord } = await acceptInvitation({ invitation, identity: adminIdentity });
  const { membershipStore } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, memberRecord],
  });
  const adminMembership = membershipStore.get(org.workspace.workspaceId, adminIdentity.memberId);
  assert.equal(adminMembership.role, "admin");
  assert.equal(isAdmin(adminMembership), true);
  assert.equal(isGlobalUser(adminMembership), false, "role:admin n'est jamais 'global' au sens du marqueur (isAdmin le couvre déjà)");

  // Le owner (genèse) n'a jamais de scope non plus.
  const { membershipStore: genesisStore } = await buildTrustedMembership({ manifest: org.manifest, memberRecords: [org.memberRecord] });
  const ownerMembership = genesisStore.get(org.workspace.workspaceId, ownerIdentity.memberId);
  assert.equal(ownerMembership.scope, null);
  assert.equal(isAdmin(ownerMembership), true);
});

// ---------------------------------------------------------------------------
// ANTI-ESCALADE (impératif du contrat) : une fiche membre qui DÉCLARE
// scope:"global" sans invitation signée correspondante -> JAMAIS admise comme
// globale (repro type "escalade", CASSÉ -> TENU).
// ---------------------------------------------------------------------------

test("ANTI-ESCALADE cas A — un user RATTACHÉ falsifie sa propre fiche (membership.scope:'global') après avoir accepté une invitation SANS scope : jamais admis comme global, reste rattaché à son consultant", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg("Cabinet Attaqué (scope)");

  // L'owner invite Ève comme simple user rattaché à c-eve — AUCUN scope signé.
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user", consultantId: "c-eve",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });
  assert.equal(invitation.scope, undefined);

  const eveIdentity = await newMemberIdentity();
  const { memberRecord: honestRecord } = await acceptInvitation({ invitation, identity: eveIdentity });
  assert.equal(honestRecord.membership.scope, null, "sanity : acceptInvitation elle-même ne s'auto-promeut pas");

  // Ève (ou tout écrivain hostile du dossier partagé, CLAUDE.md §4) publie une
  // fiche TRAFIQUÉE : même joinProof/identité/invitation (elle ne peut pas
  // forger `joinProof`, mais elle contrôle librement l'objet `membership`
  // publié à côté, exactement comme la faille consultantId round 3), en y
  // ajoutant `scope:"global"`.
  const forgedRecord = {
    ...honestRecord,
    membership: { ...honestRecord.membership, scope: "global" },
  };

  const { membershipStore, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, forgedRecord],
  });
  assert.equal(rejected.length, 0, "Ève reste normalement admise (son identité/invitation sont légitimes) — seul le scope forgé doit être neutralisé");
  const eveMembership = membershipStore.get(org.workspace.workspaceId, eveIdentity.memberId);
  assert.ok(eveMembership, "Ève est admise");
  assert.notEqual(eveMembership.scope, "global", "JAMAIS le scope forgé");
  assert.equal(eveMembership.scope, null, "le scope reste null — aucun scope n'ayant été signé par l'invitation, jamais un choix libre de la fiche membre");
  assert.equal(isGlobalUser(eveMembership), false);
  assert.equal(eveMembership.consultantId, "c-eve", "reste rattaché au consultant réellement signé — le plus restrictif, jamais 'rien' ni 'global'");
});

test("ANTI-ESCALADE cas B — un user SANS consultant précisé (ni scope, ni consultantId à l'invitation) falsifie sa fiche en scope:'global' : reste au plus restrictif (aucun accès), jamais global", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();

  // Invitation "user" la plus nue possible : ni consultantId, ni scope.
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });

  const malloryIdentity = await newMemberIdentity();
  const { memberRecord: honestRecord } = await acceptInvitation({ invitation, identity: malloryIdentity });

  const forgedRecord = {
    ...honestRecord,
    membership: { ...honestRecord.membership, scope: "global", consultantId: "c-devrait-rester-null" },
  };

  const { membershipStore, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, forgedRecord],
  });
  assert.equal(rejected.length, 0);
  const malloryMembership = membershipStore.get(org.workspace.workspaceId, malloryIdentity.memberId);
  assert.equal(malloryMembership.scope, null, "jamais global");
  assert.equal(malloryMembership.consultantId, null, "consultantId forgé également neutralisé (liste blanche déjà en place round 4) — le plus restrictif : aucun accès métier");
  assert.equal(isGlobalUser(malloryMembership), false);

  // Preuve bout-en-bout côté moteur de droits : Mallory ne peut RIEN écrire
  // (ni comme global, ni comme rattaché à un consultant inexistant).
  const projection = { consultants: {}, saisies: {} };
  const event = { entityType: "consultants", operation: "update", entityId: "c-devrait-rester-null" };
  assert.equal(evaluate({ actorMembership: malloryMembership, projection, event, payload: { id: "c-devrait-rester-null" } }), "reject");
});

test("ANTI-ESCALADE cas C — un scope trafiqué APRÈS signature (invitation altérée : scope ajouté a posteriori) invalide le proof — invitation entière rejetée, pas seulement le scope ignoré", async () => {
  const { org, ownerIdentity, ownerSigner } = await makeOrg();

  // Invitation LÉGITIMEMENT signée SANS scope.
  const invitation = await inviteMember({
    workspaceId: org.workspace.workspaceId, role: "user", consultantId: "c-victime",
    issuer: { memberId: ownerIdentity.memberId }, issuerMembership: org.ownerMembership, signer: ownerSigner,
  });

  // Un attaquant intercepte l'invitation AVANT qu'elle soit consommée et lui
  // ajoute `scope:"global"` (la modifie en transit — le modèle "dossier de
  // confiance" ne protège l'intégrité QUE par la signature, jamais par le
  // secret du contenu).
  const tamperedInvitation = { ...invitation, scope: "global" };

  const attackerIdentity = await newMemberIdentity();
  // acceptInvitation ne vérifie pas la signature elle-même (délégué à
  // verifyInvitation/buildTrustedMembership en aval, cf. org-runtime.js) :
  // elle produit quand même une fiche, mais celle-ci ne doit JAMAIS être
  // admise comme globale ensuite.
  const { memberRecord } = await acceptInvitation({ invitation: tamperedInvitation, identity: attackerIdentity });
  assert.equal(memberRecord.membership.scope, "global", "sanity : la fiche PORTE bien le scope trafiqué (c'est le proof qui doit la stopper)");

  const { membershipStore, rejected } = await buildTrustedMembership({
    manifest: org.manifest, memberRecords: [org.memberRecord, memberRecord],
  });
  const admitted = membershipStore.get(org.workspace.workspaceId, attackerIdentity.memberId);
  assert.equal(admitted, null, "l'invitation trafiquée (scope ajouté après signature) est rejetée dans son ENSEMBLE — le proof ne correspond plus aux octets recomposés");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /invitation invalide|proof invalide/i);
});

test("ANTI-ESCALADE cas D — vérification directe de canonicalPayload : le proof d'une invitation SANS scope ne valide PAS les octets recomposés AVEC scope:'global' (le binding est structurel, pas seulement une convention d'org-runtime)", async () => {
  const ownerIdentity = await newMemberIdentity();
  const ownerSigner = (bytes) => cryptoService.sign(ownerIdentity.privateKeyRef, bytes);

  const fields = {
    workspaceId: "w1", invitationId: "inv-1", expectedGoogleId: null, role: "user",
    createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-08T00:00:00.000Z", nonce: "abc",
    issuerId: ownerIdentity.memberId, consultantId: null,
  };
  const canonicalWithoutScope = canonicalPayload(fields);
  const proof = await ownerSigner(new TextEncoder().encode(canonicalWithoutScope));

  const canonicalWithForgedScope = canonicalPayload({ ...fields, scope: "global" });
  const okForged = await cryptoService.verify(
    ownerIdentity.publicKeyJwk, new TextEncoder().encode(canonicalWithForgedScope), proof
  );
  assert.equal(okForged, false, "le proof signé SANS scope ne valide jamais des octets recomposés AVEC scope:'global'");

  const okHonest = await cryptoService.verify(
    ownerIdentity.publicKeyJwk, new TextEncoder().encode(canonicalWithoutScope), proof
  );
  assert.equal(okHonest, true, "sanity : le proof valide bien les octets réellement signés");
});
