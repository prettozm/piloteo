// src/workspace/memberships.js
//
// Modèle membership — CONTRACTS §8 :
//   membership: { workspaceId, memberId, googleSubject, email, consultantId,
//                 role:"owner|admin|user", status:"active|revoked" }
//
// Décisions / hypothèses :
// 1. CRUD **en mémoire** uniquement (LocalStore/IndexedDB, CONTRACTS §9, hors
//    de ce lot). `MembershipStore` est une structure pure, sans I/O, réutilisable
//    aussi bien côté navigateur que Node/tests.
// 2. Invariant central : le rôle est stocké **par (workspaceId, memberId)**,
//    jamais globalement pour une personne — structurellement garanti ici en
//    indexant d'abord par `workspaceId` puis par `memberId`. Une même personne
//    (même `googleSubject`/`email`) peut ainsi avoir des memberships différents
//    (rôles différents) dans des workspaces différents (docs/next/01 §5).
// 3. `memberId` est l'identifiant **local** du membre (identité cryptographique
//    locale, cf. docs/next/05 §4) — distinct de `googleSubject` qui est
//    l'identifiant du fournisseur d'identité Google (mode Team uniquement,
//    optionnel en mode solo).
// 4. `revoke()` ne supprime jamais le membership : il passe `status` à
//    `"revoked"` (traçabilité, cohérent avec "aucun écrasement silencieux" et
//    docs/next/05 §8 : la révocation est un état, pas une suppression).

const VALID_ROLES = new Set(["owner", "admin", "user"]);
const VALID_STATUSES = new Set(["active", "revoked"]);

/**
 * Construit un membership valide avec ses valeurs par défaut.
 */
export function createMembership({
  workspaceId,
  memberId,
  googleSubject = null,
  email = null,
  consultantId,
  role = "user",
  status = "active",
} = {}) {
  if (!workspaceId) throw new Error("createMembership: 'workspaceId' requis");
  if (!memberId) throw new Error("createMembership: 'memberId' requis");
  if (!consultantId) throw new Error("createMembership: 'consultantId' requis");
  if (!VALID_ROLES.has(role)) throw new Error(`createMembership: rôle invalide '${role}'`);
  if (!VALID_STATUSES.has(status)) throw new Error(`createMembership: statut invalide '${status}'`);
  return { workspaceId, memberId, googleSubject, email, consultantId, role, status };
}

/**
 * Store en mémoire des memberships, indexé par workspace puis par membre.
 * Garantit l'invariant "le rôle n'est jamais global à l'utilisateur".
 */
export class MembershipStore {
  constructor() {
    /** @type {Map<string, Map<string, object>>} workspaceId -> memberId -> membership */
    this._byWorkspace = new Map();
  }

  _bucket(workspaceId, { create = false } = {}) {
    let bucket = this._byWorkspace.get(workspaceId);
    if (!bucket && create) {
      bucket = new Map();
      this._byWorkspace.set(workspaceId, bucket);
    }
    return bucket;
  }

  /** Ajoute (ou remplace) un membership. Retourne le membership stocké. */
  add(membership) {
    const m = createMembership(membership);
    const bucket = this._bucket(m.workspaceId, { create: true });
    bucket.set(m.memberId, m);
    return m;
  }

  get(workspaceId, memberId) {
    const bucket = this._bucket(workspaceId);
    return bucket ? bucket.get(memberId) ?? null : null;
  }

  /** Liste les memberships d'un workspace. */
  list(workspaceId) {
    const bucket = this._bucket(workspaceId);
    return bucket ? Array.from(bucket.values()) : [];
  }

  /** Liste tous les memberships d'un membre donné, tous workspaces confondus
   *  (multi-workspace, rôles potentiellement différents). */
  listByMember(memberId) {
    const result = [];
    for (const bucket of this._byWorkspace.values()) {
      const m = bucket.get(memberId);
      if (m) result.push(m);
    }
    return result;
  }

  setRole(workspaceId, memberId, role) {
    if (!VALID_ROLES.has(role)) throw new Error(`setRole: rôle invalide '${role}'`);
    const existing = this.get(workspaceId, memberId);
    if (!existing) throw new Error("setRole: membership introuvable");
    const updated = { ...existing, role };
    this._bucket(workspaceId, { create: true }).set(memberId, updated);
    return updated;
  }

  revoke(workspaceId, memberId) {
    const existing = this.get(workspaceId, memberId);
    if (!existing) throw new Error("revoke: membership introuvable");
    const updated = { ...existing, status: "revoked" };
    this._bucket(workspaceId, { create: true }).set(memberId, updated);
    return updated;
  }

  /** Réactive un membre précédemment révoqué (nouvelle epoch de clé côté
   *  crypto, hors du ressort de ce module). */
  reactivate(workspaceId, memberId) {
    const existing = this.get(workspaceId, memberId);
    if (!existing) throw new Error("reactivate: membership introuvable");
    const updated = { ...existing, status: "active" };
    this._bucket(workspaceId, { create: true }).set(memberId, updated);
    return updated;
  }

  remove(workspaceId, memberId) {
    const bucket = this._bucket(workspaceId);
    return bucket ? bucket.delete(memberId) : false;
  }
}
