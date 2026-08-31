// tests/next/config-factory.test.mjs
//
// Configuration runtime (4 modes) + usine de stockage, avec le GATING Google
// (§10) : google-drive sans googleClientId => adaptateur fake/mémoire ; avec
// googleClientId + token provider => adaptateur Drive réel.

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig, configFromEnv } from "../../src/config/runtime-config.js";
import { createStorageAdapter } from "../../src/storage/storage-factory.js";
import { InMemoryStorageAdapter } from "../../src/storage/in-memory-adapter.js";
import { FolderStorageAdapter } from "../../src/storage/folder-storage-adapter.js";
import { GoogleDriveStorageAdapter } from "../../src/storage/google-drive-adapter.js";

// Port filesystem factice (méthodes présentes, non appelées par l'usine).
const fakeFsPort = {
  ensureDir: async () => {}, writeExclusive: async () => {}, readText: async () => "{}",
  exists: async () => false, listFiles: async () => [], stat: async () => ({ mtimeMs: 0, size: 0 }),
};

test("normalizeConfig : 4 formes valides", () => {
  assert.deepEqual(normalizeConfig({ mode: "local" }), { mode: "local", storage: { provider: "indexeddb" } });
  assert.deepEqual(normalizeConfig({ mode: "shared", storage: { provider: "folder" } }),
    { mode: "shared", storage: { provider: "folder" } });
  const g = normalizeConfig({ mode: "shared", storage: { provider: "google-drive", googleClientId: "abc.apps.googleusercontent.com" } });
  assert.equal(g.googleWired, true);
  const gNo = normalizeConfig({ mode: "shared", storage: { provider: "google-drive" } });
  assert.equal(gNo.googleWired, false);
  assert.deepEqual(normalizeConfig({ mode: "hosted", endpoint: "https://x.example" }),
    { mode: "hosted", endpoint: "https://x.example" });
});

test("normalizeConfig : rejets", () => {
  assert.throws(() => normalizeConfig({ mode: "bogus" }));
  assert.throws(() => normalizeConfig({ mode: "hosted" }), /endpoint/);
  assert.throws(() => normalizeConfig({ mode: "shared", storage: { provider: "s3" } }));
  assert.throws(() => normalizeConfig({ mode: "local", storage: { provider: "folder" } }));
});

test("configFromEnv : variables plates", () => {
  assert.equal(configFromEnv({ PILOTEO_MODE: "local" }).mode, "local");
  assert.equal(configFromEnv({ PILOTEO_MODE: "hosted", PILOTEO_ENDPOINT: "https://h.example" }).endpoint, "https://h.example");
  // GOOGLE_CLIENT_ID présent en shared sans provider explicite => google-drive câblé
  const g = configFromEnv({ PILOTEO_MODE: "shared", GOOGLE_CLIENT_ID: "abc" });
  assert.equal(g.storage.provider, "google-drive");
  assert.equal(g.googleWired, true);
  // shared sans rien => folder par défaut
  assert.equal(configFromEnv({ PILOTEO_MODE: "shared" }).storage.provider, "folder");
});

test("factory : local et hosted n'utilisent PAS de StorageAdapter", () => {
  const local = createStorageAdapter({ mode: "local" });
  assert.equal(local.adapter, null);
  assert.equal(local.effective, "indexeddb");
  const hosted = createStorageAdapter({ mode: "hosted", endpoint: "https://h.example" });
  assert.equal(hosted.adapter, null);
  assert.equal(hosted.effective, "backend-v1");
});

test("factory : folder => FolderStorageAdapter (fsPort requis)", () => {
  const r = createStorageAdapter({ mode: "shared", storage: { provider: "folder" } }, { fsPort: fakeFsPort });
  assert.ok(r.adapter instanceof FolderStorageAdapter);
  assert.equal(r.effective, "folder");
  assert.throws(() => createStorageAdapter({ mode: "shared", storage: { provider: "folder" } }), /fsPort/);
});

test("factory : google-drive SANS client id => adaptateur fake/mémoire (gating §10)", () => {
  const r = createStorageAdapter({ mode: "shared", storage: { provider: "google-drive" } });
  assert.ok(r.adapter instanceof InMemoryStorageAdapter, "retombée mémoire sans GOOGLE_CLIENT_ID");
  assert.equal(r.effective, "in-memory-fake");
  assert.match(r.note, /GOOGLE_CLIENT_ID absent/);
});

test("factory : google-drive AVEC client id => Drive réel (token provider requis)", () => {
  const cfg = { mode: "shared", storage: { provider: "google-drive", googleClientId: "abc.apps.googleusercontent.com" } };
  const r = createStorageAdapter(cfg, { oauthTokenProvider: async () => "token" });
  assert.ok(r.adapter instanceof GoogleDriveStorageAdapter);
  assert.equal(r.effective, "google-drive");
  // client id présent mais pas de token provider => erreur claire
  assert.throws(() => createStorageAdapter(cfg), /oauthTokenProvider/);
});
