// tests/next/fsaccess-port.test.mjs
//
// Port navigateur File System Access pour le mode Dossier. Comme l'API réelle
// n'existe pas sous Node, on la simule avec un faux FileSystemDirectoryHandle
// (sous-ensemble exact des méthodes utilisées par le port). On vérifie :
//  - le port lui-même (ensureDir/writeExclusive/write-once/readText/exists/listFiles/stat) ;
//  - que FolderStorageAdapter tourne À L'IDENTIQUE au-dessus de ce port (enfichabilité) ;
//  - la persistance du handle (IndexedDB via fake-indexeddb) ;
//  - les aides de permission et de sélection de dossier.

import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";

import {
  createFsAccessPort,
  ensureHandlePermission,
  pickDirectory,
} from "../../src/storage/fsaccess-port.js";
import {
  saveDirectoryHandle,
  loadDirectoryHandle,
  clearDirectoryHandle,
} from "../../src/storage/fsaccess-handle-store.js";
import { startFolderMode, resumeFolderMode } from "../../src/storage/folder-mode.js";
import { FolderStorageAdapter } from "../../src/storage/folder-storage-adapter.js";
import { buildEvent } from "../../src/events/event-schema.js";

// --- Faux FileSystemDirectoryHandle (sous-ensemble de l'API réelle) -----------
function notFound() {
  const e = new Error("not found");
  e.name = "NotFoundError";
  return e;
}
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

const WS = globalThis.crypto.randomUUID();
const ACTOR = globalThis.crypto.randomUUID();
function eventBlob({ id, createdAt }) {
  const e = buildEvent({
    workspaceId: WS, entityType: "saisies", entityId: id, operation: "create",
    actorId: ACTOR, baseVersion: 0, epoch: 1, parentEventId: null,
    payload: { id, date: "2026-01-05", consultantId: "c-x", type: "interne", missionId: null, dureeH: 1, pctFact: 0 },
  });
  if (createdAt) e.createdAt = createdAt;
  return e;
}

test("fsaccess-port : ensureDir, writeExclusive (+write-once), readText, exists, listFiles, stat", async () => {
  const root = new FakeDirHandle();
  const port = createFsAccessPort(root);

  await port.ensureDir("events/2026-08");
  assert.equal(await port.exists("events/2026-08/x.piloteo"), false);

  await port.writeExclusive("events/2026-08/x.piloteo", '{"a":1}');
  assert.equal(await port.readText("events/2026-08/x.piloteo"), '{"a":1}');
  assert.equal(await port.exists("events/2026-08/x.piloteo"), true);

  // write-once : refus d'écraser
  await assert.rejects(() => port.writeExclusive("events/2026-08/x.piloteo", '{"a":2}'), /write-once/);

  // writeExclusive crée les dossiers parents
  await port.writeExclusive("members/m1.piloteo", '{"m":1}');

  const files = (await port.listFiles("")).sort();
  assert.deepEqual(files, ["events/2026-08/x.piloteo", "members/m1.piloteo"].sort());

  const st = await port.stat("events/2026-08/x.piloteo");
  assert.equal(st.size, 7);
  assert.equal(typeof st.mtimeMs, "number");

  // listFiles d'un dossier absent => []
  assert.deepEqual(await port.listFiles("keys"), []);
});

test("fsaccess-port : FolderStorageAdapter tourne à l'identique au-dessus du port (write/list/read/restart)", async () => {
  const root = new FakeDirHandle();
  const adapter = new FolderStorageAdapter({ fsPort: createFsAccessPort(root) });
  await adapter.connect();

  const A = eventBlob({ id: "sA", createdAt: "2026-08-10T09:00:00.000Z" });
  const B = eventBlob({ id: "sB", createdAt: "2026-09-02T09:00:00.000Z" });
  await adapter.putImmutable("event", A.eventId, A);
  await adapter.putImmutable("event", B.eventId, B);

  const listed = (await adapter.listChanges()).changes.filter((c) => c.kind === "event").map((c) => c.id).sort();
  assert.deepEqual(listed, [A.eventId, B.eventId].sort());
  assert.deepEqual(await adapter.get("event", A.eventId), A);
  await assert.rejects(() => adapter.putImmutable("event", A.eventId, A), /write-once/);

  // restart : nouvel adaptateur sur le MÊME handle racine => retrouve tout
  const adapter2 = new FolderStorageAdapter({ fsPort: createFsAccessPort(root) });
  const listed2 = (await adapter2.listChanges()).changes.filter((c) => c.kind === "event").map((c) => c.id).sort();
  assert.deepEqual(listed2, [A.eventId, B.eventId].sort());
  assert.deepEqual(await adapter2.get("event", B.eventId), B);
});

test("fsaccess-handle-store : persistance IndexedDB (save/load/clear)", async () => {
  await clearDirectoryHandle();
  assert.equal(await loadDirectoryHandle(), null);
  // Stand-in sérialisable (le vrai handle est structured-cloneable côté navigateur).
  await saveDirectoryHandle({ marker: "dir-handle", id: 42 });
  assert.deepEqual(await loadDirectoryHandle(), { marker: "dir-handle", id: 42 });
  await clearDirectoryHandle();
  assert.equal(await loadDirectoryHandle(), null);
});

test("ensureHandlePermission : query-only au boot, request seulement en interactif", async () => {
  // 'granted' : accordé sans rien demander (les deux modes).
  assert.equal(await ensureHandlePermission(new FakeDirHandle("d", "granted")), true);
  assert.equal(await ensureHandlePermission(new FakeDirHandle("d", "granted"), "readwrite", true), true);
  // 'prompt' au BOOT (interactive absent/false) : NE PAS demander -> false
  // (l'UI affichera « Redonner l'accès »). C'est le correctif du bug
  // « User activation is required » : plus aucun requestPermission hors geste.
  const bootHandle = new FakeDirHandle("d", "prompt");
  assert.equal(await ensureHandlePermission(bootHandle, "readwrite"), false);
  assert.equal(bootHandle._perm, "prompt", "requestPermission NE doit PAS avoir été appelé au boot");
  // 'prompt' en INTERACTIF (geste) : demande et accorde -> true.
  assert.equal(await ensureHandlePermission(new FakeDirHandle("d", "prompt"), "readwrite", true), true);
  // requestPermission qui LÈVE (activation manquante, cas réel navigateur) :
  // même en interactif, on ne propage jamais l'exception -> false.
  const throwing = new FakeDirHandle("d", "prompt");
  throwing.requestPermission = async () => { throw new Error("User activation is required to request permissions."); };
  assert.equal(await ensureHandlePermission(throwing, "readwrite", true), false);
  // query qui lève : traité comme non accordé, sans propager.
  const qthrow = new FakeDirHandle("d", "prompt");
  qthrow.queryPermission = async () => { throw new Error("boom"); };
  assert.equal(await ensureHandlePermission(qthrow, "readwrite"), false);
  assert.equal(await ensureHandlePermission(null), false);
});

test("folder-mode : startFolderMode (choix + mémorisation) puis resumeFolderMode (reprise sans dialogue)", async () => {
  // `chosen` est un handle en mémoire ; on injecte pick/load pour simuler le
  // dialogue natif et la reprise (le round-trip IndexedDB d'un handle réel est
  // fidèle dans le navigateur, mais pas sous fake-indexeddb — cf. handle-store).
  const chosen = new FakeDirHandle("Piloteo", "granted");
  const started = await startFolderMode({ pick: async () => chosen });
  assert.ok(started.adapter, "adaptateur prêt après le choix du dossier");
  assert.equal((await started.adapter.health()).ok, true);

  const A = eventBlob({ id: "sResume", createdAt: "2026-08-10T09:00:00.000Z" });
  await started.adapter.putImmutable("event", A.eventId, A);

  // « Nouvelle session » : le dossier mémorisé est restauré (load injecté renvoie
  // le même handle), permission déjà accordée => pas de dialogue.
  const resumed = await resumeFolderMode({ load: async () => chosen });
  assert.ok(resumed && resumed.adapter, "reprise sans nouveau dialogue (permission accordée)");
  assert.deepEqual(await resumed.adapter.get("event", A.eventId), A, "le dossier mémorisé retrouve les données");
});

test("folder-mode : resumeFolderMode => null si aucun dossier mémorisé", async () => {
  assert.equal(await resumeFolderMode({ load: async () => null }), null);
});

test("folder-mode : resumeFolderMode => needsPermission si la permission n'est pas accordée", async () => {
  const chosen = new FakeDirHandle("Piloteo", "prompt");
  const r = await resumeFolderMode({ load: async () => chosen, ensurePermission: async () => false });
  assert.equal(r.adapter, null);
  assert.equal(r.needsPermission, true);
});

test("pickDirectory : lève clairement si l'API est indisponible (Firefox/Safari)", async () => {
  const saved = globalThis.showDirectoryPicker;
  delete globalThis.showDirectoryPicker;
  try {
    await assert.rejects(() => pickDirectory(), /indisponible/);
  } finally {
    if (saved) globalThis.showDirectoryPicker = saved;
  }
});
