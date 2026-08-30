// tests/next/workspace.test.mjs
//
// WorkspaceRuntime, memberships (CONTRACTS §8) et invitations
// (CONTRACTS §8, docs/next/01 §8, docs/next/05 §7-8).

import test from "node:test";
import assert from "node:assert/strict";
import {
  WorkspaceRuntime,
  createLocalWorkspace,
  createTeamWorkspace,
} from "../../src/workspace/workspace.js";
import { MembershipStore, createMembership } from "../../src/workspace/memberships.js";
import { createInvitation, isValid, consume, revoke } from "../../src/workspace/invitations.js";

// ---------------------------------------------------------------------------
// Workspace création

test("createLocalWorkspace: mode local, aucun compte Google requis", () => {
  const ws = createLocalWorkspace("Perso");
  assert.equal(ws.mode, "local");
  assert.equal(ws.name, "Perso");
  assert.equal(ws.storage.provider, "local");
  assert.equal(ws.storage.rootId, null);
  assert.match(ws.id, /^[0-9a-f-]{36}$/);
  assert.ok(ws.createdAt);
  assert.equal(typeof ws.schemaVersion, "number");
});

test("createTeamWorkspace: mode team porte le storage fourni par le client", () => {
  const ws = createTeamWorkspace("ACME", { provider: "google-drive", rootId: "root-123" });
  assert.equal(ws.mode, "team");
  assert.equal(ws.storage.provider, "google-drive");
  assert.equal(ws.storage.rootId, "root-123");
});

test("createTeamWorkspace: exige un storage avec provider", () => {
  assert.throws(() => createTeamWorkspace("ACME", null));
  assert.throws(() => createTeamWorkspace("ACME", {}));
});

// ---------------------------------------------------------------------------
// WorkspaceRuntime : workspace actif, membre actif, rôle courant

test("WorkspaceRuntime: charge un workspace puis un membre actif, expose mode/role", () => {
  const ws = createLocalWorkspace("Perso");
  const membership = createMembership({
    workspaceId: ws.id, memberId: "mem-1", consultantId: "cid-1", role: "owner",
  });
  const runtime = new WorkspaceRuntime();
  runtime.loadWorkspace(ws).setActiveMember(membership);

  assert.equal(runtime.mode, "local");
  assert.equal(runtime.isLocal, true);
  assert.equal(runtime.isTeam, false);
  assert.equal(runtime.role, "owner");
  assert.equal(runtime.isActive, true);
  const { workspace, membership: m } = runtime.requireActive();
  assert.equal(workspace.id, ws.id);
  assert.equal(m.memberId, "mem-1");
});

test("WorkspaceRuntime: refuse un membre n'appartenant pas au workspace actif", () => {
  const ws1 = createLocalWorkspace("W1");
  const ws2 = createLocalWorkspace("W2");
  const membershipForWs2 = createMembership({
    workspaceId: ws2.id, memberId: "mem-1", consultantId: "cid-1", role: "owner",
  });
  const runtime = new WorkspaceRuntime();
  runtime.loadWorkspace(ws1);
  assert.throws(() => runtime.setActiveMember(membershipForWs2));
});

test("WorkspaceRuntime: requireActive lève sans workspace/membre actif, ou membre révoqué", () => {
  const runtime = new WorkspaceRuntime();
  assert.throws(() => runtime.requireActive());

  const ws = createLocalWorkspace("Perso");
  runtime.loadWorkspace(ws);
  assert.throws(() => runtime.requireActive());

  const revoked = createMembership({
    workspaceId: ws.id, memberId: "mem-1", consultantId: "cid-1", role: "user", status: "revoked",
  });
  runtime.setActiveMember(revoked);
  assert.throws(() => runtime.requireActive());
});

test("WorkspaceRuntime: changer de workspace actif efface le membre actif incompatible", () => {
  const ws1 = createLocalWorkspace("W1");
  const ws2 = createLocalWorkspace("W2");
  const membership1 = createMembership({ workspaceId: ws1.id, memberId: "mem-1", consultantId: "cid-1", role: "owner" });
  const runtime = new WorkspaceRuntime();
  runtime.loadWorkspace(ws1).setActiveMember(membership1);
  assert.equal(runtime.role, "owner");

  runtime.loadWorkspace(ws2);
  assert.equal(runtime.activeMember, null, "le membre du workspace précédent ne doit pas fuiter");
  assert.equal(runtime.role, null);
});

// ---------------------------------------------------------------------------
// Memberships : rôle par workspace, jamais global ; multi-workspace

test("MembershipStore: CRUD de base (add/get/list/setRole/revoke)", () => {
  const store = new MembershipStore();
  const ws = createLocalWorkspace("Perso");
  store.add({ workspaceId: ws.id, memberId: "mem-1", consultantId: "cid-1", role: "user" });

  const got = store.get(ws.id, "mem-1");
  assert.equal(got.role, "user");
  assert.equal(got.status, "active");

  assert.equal(store.list(ws.id).length, 1);

  const promoted = store.setRole(ws.id, "mem-1", "admin");
  assert.equal(promoted.role, "admin");
  assert.equal(store.get(ws.id, "mem-1").role, "admin");

  const revoked = store.revoke(ws.id, "mem-1");
  assert.equal(revoked.status, "revoked");
  assert.equal(store.get(ws.id, "mem-1").status, "revoked");
});

test("MembershipStore: le rôle est par workspace, jamais global — multi-workspace, rôles différents", () => {
  const store = new MembershipStore();
  const acme = createLocalWorkspace("ACME");
  const betaSoft = createLocalWorkspace("BetaSoft");

  // Même personne (même memberId), rôles différents selon le workspace.
  store.add({ workspaceId: acme.id, memberId: "person-x", consultantId: "cid-x", role: "user" });
  store.add({ workspaceId: betaSoft.id, memberId: "person-x", consultantId: "cid-x", role: "admin" });

  assert.equal(store.get(acme.id, "person-x").role, "user");
  assert.equal(store.get(betaSoft.id, "person-x").role, "admin");

  // Changer le rôle dans un workspace ne doit pas affecter l'autre.
  store.setRole(acme.id, "person-x", "owner");
  assert.equal(store.get(acme.id, "person-x").role, "owner");
  assert.equal(store.get(betaSoft.id, "person-x").role, "admin");

  const memberships = store.listByMember("person-x");
  assert.equal(memberships.length, 2);
  const roles = memberships.map((m) => m.role).sort();
  assert.deepEqual(roles, ["admin", "owner"]);
});

test("createMembership: valide les champs requis et les enums", () => {
  assert.throws(() => createMembership({ memberId: "m", consultantId: "c" }));
  assert.throws(() => createMembership({ workspaceId: "w", consultantId: "c" }));
  assert.throws(() => createMembership({ workspaceId: "w", memberId: "m", consultantId: "c", role: "superadmin" }));
  const m = createMembership({ workspaceId: "w", memberId: "m", consultantId: "c" });
  assert.equal(m.role, "user");
  assert.equal(m.status, "active");
});

// ---------------------------------------------------------------------------
// Invitations : valide / expirée / consommée / révoquée

test("invitation valide juste après création, code visible sans clé maître en clair", async () => {
  const inv = await createInvitation({ workspaceId: "w1", expectedGoogleId: "google-abc", role: "user" });
  assert.equal(inv.status, "pending");
  assert.equal(inv.workspaceId, "w1");
  assert.ok(inv.invitationId);
  assert.ok(inv.nonce);
  assert.ok(inv.proof);
  assert.notEqual(inv.proof, inv.nonce);
  assert.ok(isValid(inv, new Date(inv.createdAt)));
});

test("invitation expirée => isValid false", async () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const inv = await createInvitation({ workspaceId: "w1", role: "user", ttlMs: 1000, now });
  assert.ok(isValid(inv, new Date(now.getTime() + 500)));
  assert.equal(isValid(inv, new Date(now.getTime() + 1001)), false);
});

test("invitation consommée => isValid false, ne peut pas être reconsommée", async () => {
  const inv = await createInvitation({ workspaceId: "w1", expectedGoogleId: "google-abc", role: "user" });
  const consumed = consume(inv, { googleId: "google-abc" });
  assert.equal(consumed.status, "consumed");
  assert.equal(isValid(consumed), false);
  assert.throws(() => consume(consumed, { googleId: "google-abc" }));
});

test("invitation consommée avec la mauvaise identité Google => rejet", async () => {
  const inv = await createInvitation({ workspaceId: "w1", expectedGoogleId: "google-abc", role: "user" });
  assert.throws(() => consume(inv, { googleId: "google-imposteur" }));
});

test("invitation révoquée avant usage => isValid false, ne peut pas être ensuite consommée", async () => {
  const inv = await createInvitation({ workspaceId: "w1", role: "user" });
  const revoked = revoke(inv);
  assert.equal(revoked.status, "revoked");
  assert.equal(isValid(revoked), false);
  assert.throws(() => consume(revoked, { googleId: "whatever" }));
});

test("invitation déjà consommée ne peut pas être révoquée", async () => {
  const inv = await createInvitation({ workspaceId: "w1", expectedGoogleId: "g1", role: "user" });
  const consumed = consume(inv, { googleId: "g1" });
  assert.throws(() => revoke(consumed));
});

test("createInvitation: accepte un signer explicite pour la preuve d'émission", async () => {
  const signer = async (bytes) => `sig:${bytes.length}`;
  const inv = await createInvitation({ workspaceId: "w1", role: "admin", signer });
  assert.match(inv.proof, /^sig:\d+$/);
});
