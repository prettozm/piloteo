// tests/next/sync-cursor.test.mjs
//
// Régression P0.2 (audit — curseur de synchronisation).
//
// Défaut corrigé : `pull()` avançait le curseur même quand le `get(id)` d'un
// événement annoncé par `listChanges` échouait temporairement. Au pull suivant,
// l'événement (désormais AVANT le nouveau curseur) disparaissait du résultat et
// était perdu à jamais.
//
// Correction : le nouveau curseur n'est commité que si le batch a été traité
// sans erreur récupérable. Un échec fetch conserve l'ancien curseur ; au pull
// suivant l'événement est ré-annoncé et re-fetché (retry), les autres déjà
// traités étant sautés via `_seen` (idempotence).

import test from "node:test";
import assert from "node:assert/strict";

import { EventLog } from "../../src/events/event-log.js";
import * as cryptoService from "../../src/crypto/crypto-service.js";
import { Keyring } from "../../src/crypto/keyring.js";
import * as policy from "../../src/core/permissions.js";
import { MembershipStore } from "../../src/workspace/memberships.js";
import { InMemoryStorageAdapter } from "../../src/storage/in-memory-adapter.js";
import { SyncEngine } from "../../src/sync/sync-engine.js";

class FakeMemberRegistry {
  constructor() { this._byId = new Map(); }
  register(id, jwk) { this._byId.set(id, jwk); }
  getPublicKey(id) { return this._byId.get(id) ?? null; }
}

/**
 * Enveloppe un adaptateur et fait échouer `get(kind,id)` UNE seule fois par id
 * listé dans `failOnce` (panne transitoire), puis délègue normalement ensuite.
 * Toutes les autres méthodes délèguent tel quel.
 */
class FlakyGetAdapter {
  constructor(inner, failOnce = []) {
    this.inner = inner;
    this._failOnce = new Set(failOnce);
    this._alreadyFailed = new Set();
  }
  connect() { return this.inner.connect(); }
  listChanges(cursor) { return this.inner.listChanges(cursor); }
  putImmutable(kind, id, blob) { return this.inner.putImmutable(kind, id, blob); }
  health() { return this.inner.health(); }
  async get(kind, id) {
    if (this._failOnce.has(id) && !this._alreadyFailed.has(id)) {
      this._alreadyFailed.add(id);
      throw new Error(`panne transitoire simulée sur get(${id})`);
    }
    return this.inner.get(kind, id);
  }
}

test("P0.2 cursor : un échec fetch transitoire ne fait PAS avancer le curseur ; l'événement est retenté et finit appliqué", async () => {
  const workspaceId = globalThis.crypto.randomUUID();
  const workspaceKey = await cryptoService.generateWorkspaceKey();
  const memberRegistry = new FakeMemberRegistry();
  const membershipStore = new MembershipStore();

  // Auteur : Alice, publie un événement valide dans l'adaptateur partagé.
  const aliceId = globalThis.crypto.randomUUID();
  const aliceIdentity = await cryptoService.generateMemberIdentity();
  memberRegistry.register(aliceId, aliceIdentity.publicKeyJwk);
  membershipStore.add({ workspaceId, memberId: aliceId, consultantId: "c-alice", role: "user" });

  const sharedAdapter = new InMemoryStorageAdapter();
  const aliceKeyring = new Keyring();
  aliceKeyring.addEpoch(1, workspaceKey);
  const aliceEngine = new SyncEngine({
    adapter: sharedAdapter, eventLog: new EventLog(), crypto: cryptoService,
    keyring: aliceKeyring, policy, memberRegistry, membershipStore,
    actor: { workspaceId, memberId: aliceId, privateKeyRef: aliceIdentity.privateKeyRef },
  });
  const ev = aliceEngine.createLocalEvent({
    entityType: "saisies", entityId: "sFlaky", operation: "create",
    payload: { id: "sFlaky", date: "2026-01-05", consultantId: "c-alice", type: "interne", missionId: null, dureeH: 1, pctFact: 0 },
  });
  await aliceEngine.push();

  // Observateur : Bob, avec un adaptateur qui échoue une fois sur ce get.
  const bobId = globalThis.crypto.randomUUID();
  const bobIdentity = await cryptoService.generateMemberIdentity();
  memberRegistry.register(bobId, bobIdentity.publicKeyJwk);
  membershipStore.add({ workspaceId, memberId: bobId, consultantId: "c-bob", role: "user" });
  const bobKeyring = new Keyring();
  bobKeyring.addEpoch(1, workspaceKey);
  const flaky = new FlakyGetAdapter(sharedAdapter, [ev.eventId]);
  const bobEngine = new SyncEngine({
    adapter: flaky, eventLog: new EventLog(), crypto: cryptoService,
    keyring: bobKeyring, policy, memberRegistry, membershipStore,
    actor: { workspaceId, memberId: bobId, privateKeyRef: bobIdentity.privateKeyRef },
  });

  const cursorBefore = bobEngine.getCursor();

  // 1er pull : le get échoue -> rejet "fetch", curseur NON avancé, rien appliqué.
  const first = await bobEngine.pull();
  assert.equal(first.rejections.length, 1);
  assert.equal(first.rejections[0].stage, "fetch");
  assert.equal(first.cursorAdvanced, false, "le curseur ne doit pas avancer après un échec récupérable");
  assert.equal(bobEngine.getCursor(), cursorBefore, "curseur inchangé");
  assert.equal(bobEngine.getProjection().saisies?.sFlaky, undefined, "événement pas encore appliqué");

  // 2e pull : l'événement est ré-annoncé (curseur conservé) et re-fetché avec succès.
  const second = await bobEngine.pull();
  assert.equal(second.rejections.length, 0, "plus d'erreur au retry");
  assert.equal(second.cursorAdvanced, true, "le curseur avance une fois le batch traité sans erreur");
  assert.ok(bobEngine.getProjection().saisies.sFlaky, "événement finalement appliqué (aucune perte)");
  assert.notEqual(bobEngine.getCursor(), cursorBefore, "curseur avancé après succès");
});
