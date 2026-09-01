// src/workspace/workspace.js
//
// WorkspaceRuntime — CONTRACTS §8, docs/next/01_CDC_LOCAL_FIRST.md §4-7.
//
// Décisions / hypothèses :
// 1. `workspace.storage` suit exactement CONTRACTS §8 : `{provider, rootId}`.
//    Un workspace local a `storage:{provider:"local", rootId:null}` (aucun
//    connecteur distant) ; un workspace team reçoit le storage fourni par
//    l'appelant (ex: `{provider:"google-drive", rootId:"..."}`), cohérent avec
//    le contrat StorageAdapter (CONTRACTS §5) mais sans en dépendre ici (aucun
//    appel réseau, aucun import d'adaptateur : ce module ne fait que porter la
//    donnée `workspace`).
// 2. `schemaVersion` par défaut = 1 (LocalStore CONTRACTS §9 gère la
//    migration ; ce module fixe juste la valeur initiale d'un workspace neuf).
// 3. Le mode solo n'exige aucune identité Google : `createLocalWorkspace` ne
//    prend qu'un `name`. C'est à l'appelant (bootstrap applicatif, hors de ce
//    lot) de créer ensuite un membership `owner` avec une identité technique
//    locale via `workspace/memberships.js`.
// 4. `WorkspaceRuntime` porte l'état "runtime" (workspace actif + membre actif
//    + rôle courant dérivé) ; il ne persiste rien (LocalStore s'en charge,
//    hors de ce lot) et ne fait aucune I/O.
// 5. Le rôle n'est jamais global : `role` est toujours lu depuis le membership
//    actif pour LE workspace actif (jamais mémorisé indépendamment), ce qui
//    empêche structurellement une fuite de rôle inter-workspace.

function uuid() {
  return globalThis.crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

export const DEFAULT_SCHEMA_VERSION = 1;

/**
 * Crée un workspace en mode solo/local — aucun compte Google requis
 * (docs/next/01 §4.3, §6.1).
 */
export function createLocalWorkspace(name, { schemaVersion = DEFAULT_SCHEMA_VERSION } = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("createLocalWorkspace: 'name' requis");
  }
  return {
    id: uuid(),
    name,
    mode: "local",
    createdAt: nowIso(),
    schemaVersion,
    storage: { provider: "local", rootId: null },
  };
}

/**
 * Crée un workspace Team, apporté par le stockage choisi par le client
 * (docs/next/01 §4.1). `storage` = {provider, rootId}.
 */
export function createTeamWorkspace(name, storage, { schemaVersion = DEFAULT_SCHEMA_VERSION } = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("createTeamWorkspace: 'name' requis");
  }
  if (!storage || typeof storage !== "object" || !storage.provider) {
    throw new Error("createTeamWorkspace: 'storage' requis avec au moins {provider}");
  }
  return {
    id: uuid(),
    name,
    mode: "team",
    createdAt: nowIso(),
    schemaVersion,
    storage: { provider: storage.provider, rootId: storage.rootId ?? null },
  };
}

const VALID_ROLES = new Set(["owner", "admin", "user"]);

/**
 * Runtime porté par l'application : workspace actif + membre actif.
 * Aucune I/O, aucune dépendance réseau.
 */
export class WorkspaceRuntime {
  constructor() {
    this._workspace = null;
    this._activeMember = null;
  }

  /** Charge le workspace actif (remplace tout membre actif précédent). */
  loadWorkspace(workspace) {
    if (!workspace || !workspace.id) {
      throw new Error("loadWorkspace: workspace invalide");
    }
    if (this._activeMember && this._activeMember.workspaceId !== workspace.id) {
      this._activeMember = null;
    }
    this._workspace = workspace;
    return this;
  }

  get workspace() {
    return this._workspace;
  }

  /** Définit le membre actif — doit appartenir au workspace actif. */
  setActiveMember(membership) {
    if (!membership) throw new Error("setActiveMember: membership requis");
    if (!this._workspace) throw new Error("setActiveMember: aucun workspace actif chargé");
    if (membership.workspaceId !== this._workspace.id) {
      throw new Error("setActiveMember: membership n'appartient pas au workspace actif");
    }
    if (!VALID_ROLES.has(membership.role)) {
      throw new Error(`setActiveMember: rôle invalide '${membership.role}'`);
    }
    this._activeMember = membership;
    return this;
  }

  get activeMember() {
    return this._activeMember;
  }

  /** Mode du workspace actif : "local" | "team" | null si aucun workspace chargé. */
  get mode() {
    return this._workspace ? this._workspace.mode : null;
  }

  get isLocal() {
    return this.mode === "local";
  }

  get isTeam() {
    return this.mode === "team";
  }

  /** Rôle courant — toujours dérivé du membre actif pour CE workspace, jamais global. */
  get role() {
    return this._activeMember ? this._activeMember.role : null;
  }

  get isActive() {
    return !!this._workspace && !!this._activeMember && this._activeMember.status === "active";
  }

  /** Lève si aucun workspace/membre actif — utile en garde d'entrée d'API métier. */
  requireActive() {
    if (!this._workspace) throw new Error("Aucun workspace actif");
    if (!this._activeMember) throw new Error("Aucun membre actif pour ce workspace");
    if (this._activeMember.status === "revoked") throw new Error("Membre révoqué");
    return { workspace: this._workspace, membership: this._activeMember };
  }

  clear() {
    this._workspace = null;
    this._activeMember = null;
    return this;
  }
}
