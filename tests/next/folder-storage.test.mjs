// tests/next/folder-storage.test.mjs
//
// Couvre FolderStorageAdapter (nouveau mode « dossier ») via un système de
// fichiers RÉEL temporaire (NodeFsPort sur un mkdtemp). Matrice demandée par la
// passe (§16) : write event A, write event B, list, read, duplicate, restart.
// Plus un test d'intégration SyncEngine-sur-dossier (enfichabilité + convergence
// event-per-file) et la robustesse curseur (P0.2) au travers d'un adaptateur
// dossier dont l'énumération est complète.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FolderStorageAdapter } from "../../src/storage/folder-storage-adapter.js";
import { NodeFsPort } from "../../src/storage/node-fs-port.js";
import { buildEvent } from "../../src/events/event-schema.js";
import { EventLog } from "../../src/events/event-log.js";
import * as cryptoService from "../../src/crypto/crypto-service.js";
import { Keyring } from "../../src/crypto/keyring.js";
import * as policy from "../../src/core/permissions.js";
import { MembershipStore } from "../../src/workspace/memberships.js";
import { SyncEngine } from "../../src/sync/sync-engine.js";

const WS = globalThis.crypto.randomUUID();
const ACTOR = globalThis.crypto.randomUUID();

function makeAdapter(root) {
  return new FolderStorageAdapter({ fsPort: new NodeFsPort(root), label: "test" });
}

function eventBlob({ id, dureeH = 1, createdAt }) {
  const e = buildEvent({
    workspaceId: WS, entityType: "saisies", entityId: id, operation: "create",
    actorId: ACTOR, baseVersion: 0, epoch: 1, parentEventId: null,
    payload: { id, date: "2026-01-05", consultantId: "c-alice", type: "interne", missionId: null, dureeH, pctFact: 0 },
  });
  if (createdAt) e.createdAt = createdAt;
  return e;
}

test("FolderStorage : write A/B, list, read, duplicate (write-once), restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-folder-"));
  try {
    const adapter = makeAdapter(root);
    await adapter.connect();

    const A = eventBlob({ id: "sA", dureeH: 3, createdAt: "2026-08-10T09:00:00.000Z" });
    const B = eventBlob({ id: "sB", dureeH: 4, createdAt: "2026-09-02T09:00:00.000Z" });

    // write A, write B (fichiers immuables, sous-dossiers mensuels distincts)
    await adapter.putImmutable("event", A.eventId, A);
    await adapter.putImmutable("event", B.eventId, B);

    // list -> annonce A et B
    const { changes } = await adapter.listChanges();
    const listed = changes.filter((c) => c.kind === "event").map((c) => c.id).sort();
    assert.deepEqual(listed, [A.eventId, B.eventId].sort());

    // read -> contenus identiques
    assert.deepEqual(await adapter.get("event", A.eventId), A);
    assert.deepEqual(await adapter.get("event", B.eventId), B);

    // exists
    assert.equal(await adapter.exists("event", A.eventId), true);
    assert.equal(await adapter.exists("event", "inexistant"), false);

    // duplicate -> write-once refusé
    await assert.rejects(() => adapter.putImmutable("event", A.eventId, A), /write-once/);

    // readMetadata
    const meta = await adapter.readMetadata("event", A.eventId);
    assert.equal(meta.kind, "event");
    assert.equal(meta.id, A.eventId);
    assert.ok(meta.size > 0);

    // health
    assert.equal((await adapter.health()).ok, true);

    // restart : un NOUVEL adaptateur sur le MÊME dossier retrouve tout (persistance réelle)
    const adapter2 = makeAdapter(root);
    await adapter2.connect();
    const listed2 = (await adapter2.listChanges()).changes
      .filter((c) => c.kind === "event").map((c) => c.id).sort();
    assert.deepEqual(listed2, [A.eventId, B.eventId].sort());
    assert.deepEqual(await adapter2.get("event", B.eventId), B);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FolderStorage : blob event sans createdAt refusé (sous-dossier mensuel indéterminable)", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-folder-"));
  try {
    const adapter = makeAdapter(root);
    await assert.rejects(
      () => adapter.putImmutable("event", "sX", { eventId: "sX" /* pas de createdAt */ }),
      /createdAt/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FolderStorage : enfichable dans SyncEngine — deux membres convergent via un dossier partagé", async () => {
  const root = await mkdtemp(join(tmpdir(), "piloteo-folder-sync-"));
  try {
    const workspaceId = globalThis.crypto.randomUUID();
    const workspaceKey = await cryptoService.generateWorkspaceKey();
    const membershipStore = new MembershipStore();
    const memberRegistry = {
      _m: new Map(),
      register(id, jwk) { this._m.set(id, jwk); },
      getPublicKey(id) { return this._m.get(id) ?? null; },
    };

    async function makeMember(consultantId) {
      const memberId = globalThis.crypto.randomUUID();
      const identity = await cryptoService.generateMemberIdentity();
      memberRegistry.register(memberId, identity.publicKeyJwk);
      membershipStore.add({ workspaceId, memberId, consultantId, role: "user" });
      const keyring = new Keyring();
      keyring.addEpoch(1, workspaceKey);
      // Chaque membre a SON adaptateur dossier, mais tous pointent le MÊME dossier
      // (simule un dossier synchronisé partagé par une infra externe).
      const engine = new SyncEngine({
        adapter: makeAdapter(root), eventLog: new EventLog(), crypto: cryptoService,
        keyring, policy, memberRegistry, membershipStore,
        actor: { workspaceId, memberId, privateKeyRef: identity.privateKeyRef },
      });
      await engine.connect();
      return engine;
    }

    const alice = await makeMember("c-alice");
    const bob = await makeMember("c-bob");

    alice.createLocalEvent({
      entityType: "saisies", entityId: "sAlice", operation: "create",
      payload: { id: "sAlice", date: "2026-08-05", consultantId: "c-alice", type: "interne", missionId: null, dureeH: 2, pctFact: 0 },
    });
    bob.createLocalEvent({
      entityType: "saisies", entityId: "sBob", operation: "create",
      payload: { id: "sBob", date: "2026-08-06", consultantId: "c-bob", type: "interne", missionId: null, dureeH: 3, pctFact: 0 },
    });

    await alice.push();
    await bob.push();
    await alice.pull();
    await bob.pull();

    // Chaque partie voit les deux saisies (transport par fichiers immuables distincts).
    assert.ok(alice.getProjection().saisies.sAlice);
    assert.ok(alice.getProjection().saisies.sBob, "Alice voit la saisie de Bob via le dossier");
    assert.ok(bob.getProjection().saisies.sAlice, "Bob voit la saisie d'Alice via le dossier");
    assert.ok(bob.getProjection().saisies.sBob);
    assert.equal(alice.getRejections().length, 0);
    assert.equal(bob.getRejections().length, 0);
    assert.equal(alice.getConflicts().length, 0);
    assert.equal(bob.getConflicts().length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
