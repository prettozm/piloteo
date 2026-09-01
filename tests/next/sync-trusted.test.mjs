// tests/next/sync-trusted.test.mjs
//
// Couvre docs/next/ORG_CONTRACT.md §2 : mode `trusted` de `sync/sync-engine.js`
// (« Dossier de confiance » — événements SIGNÉS (Ed25519) mais NON chiffrés).
// Harnais très fortement inspiré de `tests/next/sync.test.mjs` (mode chiffré
// par défaut), adapté pour NE PAS utiliser de clé de workspace/Keyring : deux
// "clients" (deux `SyncEngine` en `trusted:true`, chacun avec son PROPRE
// `EventLog`) partagent UN `InMemoryStorageAdapter`.
//
// Objectif de ces tests : prouver que le mode trusted retire UNIQUEMENT la
// confidentialité (le blob transporte le payload en clair) sans jamais
// affaiblir l'authenticité (signature toujours vérifiée, membre inconnu/
// révoqué toujours rejeté, policy métier toujours appliquée).

import test from "node:test";
import assert from "node:assert/strict";

import { EventLog } from "../../src/events/event-log.js";
import { buildEvent, canonicalize } from "../../src/events/event-schema.js";
import * as cryptoService from "../../src/crypto/crypto-service.js";
import { Keyring } from "../../src/crypto/keyring.js";
import * as policy from "../../src/core/permissions.js";
import { MembershipStore } from "../../src/workspace/memberships.js";
import { InMemoryStorageAdapter } from "../../src/storage/in-memory-adapter.js";
import { SyncEngine } from "../../src/sync/sync-engine.js";

// ---------------------------------------------------------------------------
// Harnais de test (mode trusted — sans Keyring/clé de workspace)
// ---------------------------------------------------------------------------

/** Registre de clés publiques de membres — fake minimal (interface documentée dans sync-engine.js). */
class FakeMemberRegistry {
  constructor() {
    this._byId = new Map();
  }
  register(memberId, publicKeyJwk) {
    this._byId.set(memberId, publicKeyJwk);
  }
  getPublicKey(memberId) {
    return this._byId.get(memberId) ?? null;
  }
}

async function makeMember({ workspaceId, membershipStore, memberRegistry, consultantId, role = "user" }) {
  const memberId = globalThis.crypto.randomUUID();
  const identity = await cryptoService.generateMemberIdentity();
  memberRegistry.register(memberId, identity.publicKeyJwk);
  membershipStore.add({ workspaceId, memberId, consultantId, role });
  return { memberId, privateKeyRef: identity.privateKeyRef };
}

function makeTrustedEngine({ adapter, workspaceId, memberId, privateKeyRef, memberRegistry, membershipStore }) {
  return new SyncEngine({
    adapter,
    eventLog: new EventLog(),
    crypto: cryptoService,
    // Pas de `keyring` : optionnel en mode trusted (décision 11 de sync-engine.js).
    policy,
    memberRegistry,
    membershipStore,
    actor: { workspaceId, memberId, privateKeyRef },
    trusted: true,
  });
}

/** Construit un workspace à deux membres (Alice owner / Bob user) partageant un adaptateur, SANS clé de workspace. */
async function makeHarness({ aliceRole = "owner", bobRole = "user" } = {}) {
  const workspaceId = globalThis.crypto.randomUUID();
  const adapter = new InMemoryStorageAdapter();
  const memberRegistry = new FakeMemberRegistry();
  const membershipStore = new MembershipStore();

  const alice = await makeMember({ workspaceId, membershipStore, memberRegistry, consultantId: "c-alice", role: aliceRole });
  const bob = await makeMember({ workspaceId, membershipStore, memberRegistry, consultantId: "c-bob", role: bobRole });

  const aliceEngine = makeTrustedEngine({
    adapter, workspaceId, memberId: alice.memberId, privateKeyRef: alice.privateKeyRef, memberRegistry, membershipStore,
  });
  const bobEngine = makeTrustedEngine({
    adapter, workspaceId, memberId: bob.memberId, privateKeyRef: bob.privateKeyRef, memberRegistry, membershipStore,
  });

  return {
    workspaceId, adapter, memberRegistry, membershipStore,
    alice: { ...alice, engine: aliceEngine },
    bob: { ...bob, engine: bobEngine },
  };
}

function saisiePayload(overrides = {}) {
  return {
    id: "sX", date: "2026-01-05", consultantId: "c-alice", type: "interne",
    missionId: null, dureeH: 1, pctFact: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Constructeur — keyring optionnel en trusted, requis sinon (aucune régression)
// ---------------------------------------------------------------------------

test("trusted : le constructeur n'exige PAS de keyring quand trusted:true", async () => {
  const workspaceId = globalThis.crypto.randomUUID();
  const adapter = new InMemoryStorageAdapter();
  const memberRegistry = new FakeMemberRegistry();
  const membershipStore = new MembershipStore();
  const alice = await makeMember({ workspaceId, membershipStore, memberRegistry, consultantId: "c-alice", role: "owner" });

  assert.doesNotThrow(() => makeTrustedEngine({
    adapter, workspaceId, memberId: alice.memberId, privateKeyRef: alice.privateKeyRef, memberRegistry, membershipStore,
  }));
});

test("non-trusted (défaut) : le constructeur exige toujours un keyring — comportement inchangé", async () => {
  const workspaceId = globalThis.crypto.randomUUID();
  const adapter = new InMemoryStorageAdapter();
  const memberRegistry = new FakeMemberRegistry();
  const membershipStore = new MembershipStore();
  const alice = await makeMember({ workspaceId, membershipStore, memberRegistry, consultantId: "c-alice", role: "owner" });

  assert.throws(() => new SyncEngine({
    adapter,
    eventLog: new EventLog(),
    crypto: cryptoService,
    policy,
    memberRegistry,
    membershipStore,
    actor: { workspaceId, memberId: alice.memberId, privateKeyRef: alice.privateKeyRef },
    // trusted absent => false par défaut
  }), /keyring/);
});

// ---------------------------------------------------------------------------
// 2. Convergence — payload en clair, signé, pas de ciphertext
// ---------------------------------------------------------------------------

test("trusted convergence : le blob publié porte le payload en CLAIR et signé (pas de ciphertext), les deux membres convergent", async () => {
  const h = await makeHarness();

  const evAlice = h.alice.engine.createLocalEvent({
    entityType: "saisies", entityId: "sA", operation: "create",
    payload: saisiePayload({ id: "sA", consultantId: "c-alice", dureeH: 3 }),
  });
  const evBob = h.bob.engine.createLocalEvent({
    entityType: "saisies", entityId: "sB", operation: "create",
    payload: saisiePayload({ id: "sB", consultantId: "c-bob", dureeH: 4 }),
  });

  // epoch=1 constant en mode trusted (décision 11), sans keyring.
  assert.equal(evAlice.epoch, 1);
  assert.equal(evBob.epoch, 1);

  await h.alice.engine.push();
  await h.bob.engine.push();

  const blobA = await h.adapter.get("event", evAlice.eventId);
  assert.ok("payload" in blobA && blobA.payload !== undefined, "le blob publié porte le payload en clair");
  assert.deepEqual(blobA.payload, saisiePayload({ id: "sA", consultantId: "c-alice", dureeH: 3 }));
  assert.ok(!("ciphertext" in blobA), "aucun ciphertext en mode trusted");
  assert.ok(typeof blobA.signature === "string" && blobA.signature.length > 0, "le blob est signé");

  await h.alice.engine.pull();
  await h.bob.engine.pull();

  const aliceProj = h.alice.engine.getProjection();
  const bobProj = h.bob.engine.getProjection();

  assert.ok(aliceProj.saisies.sA);
  assert.ok(aliceProj.saisies.sB, "Alice voit B (celle de Bob) après sync");
  assert.ok(bobProj.saisies.sA, "Bob voit A (celle d'Alice) après sync");
  assert.ok(bobProj.saisies.sB);
  assert.equal(h.alice.engine.getRejections().length, 0);
  assert.equal(h.bob.engine.getRejections().length, 0);
});

// ---------------------------------------------------------------------------
// 3. Hostile — signature invalide (payload en clair altéré après signature)
// ---------------------------------------------------------------------------

test("trusted hostile : un payload en clair altéré APRÈS signature invalide la signature => rejeté", async () => {
  const h = await makeHarness();

  const ev = h.alice.engine.createLocalEvent({
    entityType: "saisies", entityId: "sTamper", operation: "create",
    payload: saisiePayload({ id: "sTamper", consultantId: "c-alice", dureeH: 1 }),
  });
  await h.alice.engine.push();

  const blob = await h.adapter.get("event", ev.eventId);
  // Un attaquant modifie le payload en clair APRÈS coup (client hostile ayant
  // accès en écriture au dossier partagé) — canonicalize couvre le payload,
  // donc la signature d'origine ne doit plus valider.
  const tampered = { ...blob, payload: { ...blob.payload, dureeH: 999 } };

  const tamperedAdapter = new InMemoryStorageAdapter();
  await tamperedAdapter.putImmutable("event", ev.eventId, tampered);

  const observerEngine = makeTrustedEngine({
    adapter: tamperedAdapter, workspaceId: h.workspaceId, memberId: h.bob.memberId,
    privateKeyRef: h.bob.privateKeyRef, memberRegistry: h.memberRegistry, membershipStore: h.membershipStore,
  });
  const result = await observerEngine.pull();

  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].stage, "signature");
  assert.equal(observerEngine.getProjection().saisies?.sTamper, undefined, "jamais appliqué");
});

test("trusted hostile : signature explicitement invalide (forgée) => rejetée", async () => {
  const h = await makeHarness();

  const event = buildEvent({
    workspaceId: h.workspaceId, entityType: "saisies", entityId: "sForge", operation: "create",
    actorId: h.alice.memberId, baseVersion: 0, epoch: 1,
    payload: saisiePayload({ id: "sForge", consultantId: "c-alice" }),
  });
  const blob = { ...event, signature: "not-a-real-signature-base64url" };
  await h.adapter.putImmutable("event", event.eventId, blob);

  const result = await h.bob.engine.pull();
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].stage, "signature");
});

// ---------------------------------------------------------------------------
// 4. Hostile — membre révoqué / non-membre
// ---------------------------------------------------------------------------

test("trusted hostile : événement signé par un membre révoqué ou par un non-membre => rejeté (jamais appliqué)", async () => {
  const h = await makeHarness();

  // Membre révoqué : connu du registre de clés (signature vérifiable) mais membership revoked.
  const mallory = await makeMember({
    workspaceId: h.workspaceId, membershipStore: h.membershipStore, memberRegistry: h.memberRegistry,
    consultantId: "c-mallory", role: "user",
  });
  h.membershipStore.revoke(h.workspaceId, mallory.memberId);

  const revokedEvent = buildEvent({
    workspaceId: h.workspaceId, entityType: "saisies", entityId: "sMal", operation: "create",
    actorId: mallory.memberId, baseVersion: 0, epoch: 1,
    payload: saisiePayload({ id: "sMal", consultantId: "c-mallory" }),
  });
  const revokedBlob = { ...revokedEvent };
  revokedBlob.signature = await cryptoService.sign(mallory.privateKeyRef, canonicalize(revokedBlob));
  await h.adapter.putImmutable("event", revokedEvent.eventId, revokedBlob);

  // Non-membre : jamais enregistré, ni côté registre de clés ni côté memberships.
  const strangerIdentity = await cryptoService.generateMemberIdentity();
  const strangerMemberId = globalThis.crypto.randomUUID();
  const strangerEvent = buildEvent({
    workspaceId: h.workspaceId, entityType: "saisies", entityId: "sStr", operation: "create",
    actorId: strangerMemberId, baseVersion: 0, epoch: 1,
    payload: saisiePayload({ id: "sStr", consultantId: "c-stranger" }),
  });
  const strangerBlob = { ...strangerEvent };
  strangerBlob.signature = await cryptoService.sign(strangerIdentity.privateKeyRef, canonicalize(strangerBlob));
  await h.adapter.putImmutable("event", strangerEvent.eventId, strangerBlob);

  const result = await h.bob.engine.pull();

  assert.equal(result.rejections.length, 2);
  const stageByEventId = Object.fromEntries(result.rejections.map((r) => [r.eventId, r.stage]));
  assert.equal(stageByEventId[revokedEvent.eventId], "membership", "membre révoqué rejeté à l'étape membership");
  assert.equal(stageByEventId[strangerEvent.eventId], "signature", "non-membre rejeté dès la vérification de signature");

  const proj = h.bob.engine.getProjection();
  assert.equal(proj.saisies?.sMal, undefined);
  assert.equal(proj.saisies?.sStr, undefined);
});

// ---------------------------------------------------------------------------
// 5. Policy — user modifiant la saisie d'autrui
// ---------------------------------------------------------------------------

test("trusted policy : un user modifiant la saisie d'autrui => rejeté", async () => {
  const h = await makeHarness({ aliceRole: "user", bobRole: "user" });

  // Bob (client hostile ou modifié côté UI) fabrique et publie un événement
  // usurpant une saisie appartenant à Alice.
  h.bob.engine.createLocalEvent({
    entityType: "saisies", entityId: "sTheft", operation: "create",
    payload: saisiePayload({ id: "sTheft", consultantId: "c-alice", dureeH: 9 }),
  });
  await h.bob.engine.push();

  const result = await h.alice.engine.pull();
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].stage, "policy");
  assert.equal(h.alice.engine.getProjection().saisies?.sTheft, undefined, "jamais appliqué côté Alice");
});

// ---------------------------------------------------------------------------
// 6. owner traité comme admin métier (aucun nouveau pouvoir)
// ---------------------------------------------------------------------------

test("trusted policy : owner a les droits métier admin (ex: écrire sur une collection ADMIN_ONLY), sans nouveau pouvoir", async () => {
  const h = await makeHarness({ aliceRole: "owner", bobRole: "user" });

  const ev = h.alice.engine.createLocalEvent({
    entityType: "consultants", entityId: "cNew", operation: "create",
    payload: { id: "cNew", nom: "Nouveau consultant" },
  });
  await h.alice.engine.push();

  const result = await h.bob.engine.pull();
  assert.equal(result.rejections.length, 0, "owner peut écrire sur une collection ADMIN_ONLY, comme admin");
  assert.ok(h.bob.engine.getProjection().consultants.cNew);
  assert.equal(ev.epoch, 1);
});

// ---------------------------------------------------------------------------
// 7. Durcissement §5.5 (ORG_CONTRACT) — incohérence de mode, dans les 2 sens
// ---------------------------------------------------------------------------

test("mode : un moteur trusted:true rejette (stage 'mode') un blob portant un ciphertext", async () => {
  const h = await makeHarness();

  const event = buildEvent({
    workspaceId: h.workspaceId, entityType: "saisies", entityId: "sModeCipher", operation: "create",
    actorId: h.alice.memberId, baseVersion: 0, epoch: 1,
    payload: saisiePayload({ id: "sModeCipher", consultantId: "c-alice" }),
  });
  const { payload, ...withoutPayload } = event;
  const blob = { ...withoutPayload, ciphertext: "ZmFrZS1jaXBoZXJ0ZXh0" }; // ciphertext bidon mais bien formé
  blob.signature = await cryptoService.sign(h.alice.privateKeyRef, canonicalize(blob));
  await h.adapter.putImmutable("event", event.eventId, blob);

  const result = await h.bob.engine.pull();
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].stage, "mode");
  assert.equal(h.bob.engine.getProjection().saisies?.sModeCipher, undefined, "jamais appliqué");
});

test("mode : un moteur trusted:false (mode chiffré par défaut) rejette (stage 'mode') un blob sans ciphertext (payload en clair)", async () => {
  const workspaceId = globalThis.crypto.randomUUID();
  const workspaceKey = await cryptoService.generateWorkspaceKey();
  const adapter = new InMemoryStorageAdapter();
  const memberRegistry = new FakeMemberRegistry();
  const membershipStore = new MembershipStore();

  const alice = await makeMember({ workspaceId, membershipStore, memberRegistry, consultantId: "c-alice", role: "owner" });
  const bob = await makeMember({ workspaceId, membershipStore, memberRegistry, consultantId: "c-bob", role: "user" });

  const bobKeyring = new Keyring();
  bobKeyring.addEpoch(1, workspaceKey);
  const bobEngine = new SyncEngine({
    adapter, eventLog: new EventLog(), crypto: cryptoService, keyring: bobKeyring, policy,
    memberRegistry, membershipStore,
    actor: { workspaceId, memberId: bob.memberId, privateKeyRef: bob.privateKeyRef },
    // trusted absent => false (mode chiffré par défaut, INCHANGÉ)
  });

  const event = buildEvent({
    workspaceId, entityType: "saisies", entityId: "sModePlain", operation: "create",
    actorId: alice.memberId, baseVersion: 0, epoch: 1,
    payload: saisiePayload({ id: "sModePlain", consultantId: "c-alice" }),
  });
  // Blob EN CLAIR (comme en mode trusted) publié alors que ce moteur attend du chiffré.
  const blob = { ...event };
  blob.signature = await cryptoService.sign(alice.privateKeyRef, canonicalize(blob));
  await adapter.putImmutable("event", event.eventId, blob);

  const result = await bobEngine.pull();
  assert.equal(result.rejections.length, 1);
  assert.equal(result.rejections[0].stage, "mode");
  assert.equal(bobEngine.getProjection().saisies?.sModePlain, undefined, "jamais appliqué");
});
