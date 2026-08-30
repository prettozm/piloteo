// src/storage/in-memory-adapter.js
//
// InMemoryStorageAdapter — StorageAdapter (CONTRACTS §5) pour les tests et le
// mode local (aucun backend, aucune dépendance réseau).
//
// Décisions/hypothèses :
// - Stockage `Map<"kind:id", {blob, writtenAt, seq}>` : write-once STRICT —
//   `putImmutable` lève si `(kind,id)` existe déjà (docs/next/04 §3). Aucune
//   opération ne permet de modifier/supprimer un blob déjà écrit (pas de
//   `delete` exposé : cohérent avec l'immutabilité des events, et rien dans le
//   contrat CONTRACTS §5 n'exige de suppression).
// - Curseur : un **entier ordinal monotone** = nombre de blobs écrits au
//   moment de l'appel. `listChanges(cursor)` renvoie tous les blobs écrits
//   depuis `cursor` (exclusif), dans leur ORDRE D'ÉCRITURE, et le nouveau
//   curseur (= nombre total de blobs connus). `cursor` absent/non-entier =
//   depuis le début (0). Rejouer le même curseur est idempotent (mêmes
//   `{kind,id}` retournés, jamais de doublon ni de trou).
// - Panne simulée : `setOffline(true)` fait échouer `connect/putImmutable/get/
//   listChanges` (lèvent une erreur explicite, jamais un blocage silencieux)
//   — sert à tester la résilience du SyncEngine (CONTRACTS §6, docs/next/04
//   §13 : un événement local reste `pending` tant que l'adaptateur n'a pas
//   confirmé). `readMetadata/share/revoke/health` restent utilisables hors
//   ligne : `health()` en particulier DOIT pouvoir répondre `{ok:false}` sans
//   lever, pour permettre à l'appelant de détecter la panne proprement.
// - `share(member)`/`revoke(member)` sont de simples registres en mémoire
//   (pas d'ACL réelle à simuler ici) : utile pour vérifier qu'un appelant
//   orchestre bien les deux retraits (Drive + Pilotéo, docs/next/04 §7).

import { StorageAdapter, assertValidKind } from "./storage-adapter.js";

export class InMemoryStorageAdapter extends StorageAdapter {
  constructor() {
    super();
    /** @type {Map<string, {blob:*, writtenAt:string, seq:number, kind:string, id:string}>} */
    this._store = new Map();
    /** Ordre d'écriture, pour un curseur ordinal monotone. */
    this._order = [];
    this._connected = false;
    this._offline = false;
    this._sharedMembers = new Set();
  }

  /** Simule une panne réseau/service : true = les opérations réseau échouent. */
  setOffline(offline) {
    this._offline = !!offline;
  }

  isOffline() {
    return this._offline;
  }

  _key(kind, id) {
    return `${kind}:${id}`;
  }

  _assertOnline(methodName) {
    if (this._offline) {
      throw new Error(`InMemoryStorageAdapter.${methodName}: hors ligne (panne simulée).`);
    }
  }

  async connect() {
    this._assertOnline("connect");
    this._connected = true;
  }

  async putImmutable(kind, id, blob) {
    assertValidKind(kind);
    this._assertOnline("putImmutable");
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("InMemoryStorageAdapter.putImmutable: id doit être une chaîne non vide.");
    }
    const key = this._key(kind, id);
    if (this._store.has(key)) {
      throw new Error(
        `InMemoryStorageAdapter.putImmutable: write-once violé — (${kind}, ${id}) a déjà été écrit.`
      );
    }
    const entry = { blob, writtenAt: new Date().toISOString(), seq: this._order.length, kind, id };
    this._store.set(key, entry);
    this._order.push(key);
    return { id };
  }

  async get(kind, id) {
    assertValidKind(kind);
    this._assertOnline("get");
    const entry = this._store.get(this._key(kind, id));
    if (!entry) {
      throw new Error(`InMemoryStorageAdapter.get: introuvable (${kind}, ${id}).`);
    }
    return entry.blob;
  }

  async listChanges(cursor) {
    this._assertOnline("listChanges");
    const from = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
    const slice = this._order.slice(from);
    const changes = slice.map((key) => {
      const entry = this._store.get(key);
      return { kind: entry.kind, id: entry.id };
    });
    return { changes, cursor: this._order.length };
  }

  async readMetadata(kind, id) {
    assertValidKind(kind);
    const entry = this._store.get(this._key(kind, id));
    if (!entry) {
      throw new Error(`InMemoryStorageAdapter.readMetadata: introuvable (${kind}, ${id}).`);
    }
    return { kind: entry.kind, id: entry.id, writtenAt: entry.writtenAt, seq: entry.seq };
  }

  async share(member) {
    this._sharedMembers.add(member);
  }

  async revoke(member) {
    this._sharedMembers.delete(member);
  }

  /** Best-effort : ne lève jamais, même hors ligne. */
  async health() {
    if (this._offline) {
      return { ok: false, detail: "hors ligne (panne simulée)" };
    }
    return { ok: true, detail: `ok (${this._order.length} blob(s), ${this._sharedMembers.size} membre(s) partagé(s))` };
  }
}
