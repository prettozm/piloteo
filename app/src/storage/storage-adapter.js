// src/storage/storage-adapter.js
//
// StorageAdapter — contrat CONTRACTS.md §5, docs/next/04_SYNC_ET_STOCKAGE_DRIVE.md §1.
//
// Décisions/hypothèses :
// - Ce module ne définit QUE le contrat de transport de blobs immuables. Il ne
//   connaît ni le métier, ni les droits, ni le chiffrement, ni la crypto — un
//   `StorageAdapter` conforme pourrait aussi bien transporter des octets sans
//   aucun rapport avec Pilotéo. « Aucune règle métier » (CONTRACTS §5) est un
//   invariant strict : cette classe ne DOIT jamais être enrichie de logique
//   spécifique à `saisies`/`affaires`/etc.
// - `kind` ∈ {"workspace","member","event","key","license"} (cf. arborescence
//   Drive de docs/next/04 §2). `STORAGE_KINDS` est la liste autoritaire ; tout
//   adaptateur concret DOIT valider `kind` avec `assertValidKind` avant toute
//   opération, pour qu'un appelant qui se trompe de `kind` échoue vite et
//   clairement plutôt que de silencieusement écrire au mauvais endroit.
// - `id` est l'identifiant du blob au sein de son `kind` (ex: `eventId` pour
//   `kind:"event"`, `memberId` pour `kind:"member"`...). Ce module ne préjuge
//   pas de son format (UUID, `numero`, etc.) — c'est aux modules appelants
//   (SyncEngine, WorkspaceRuntime) de garantir des `id` bien formés.
// - `putImmutable(kind, id, blob)` : write-once. Un adaptateur DOIT refuser
//   d'écraser un `(kind,id)` déjà écrit (docs/next/04 §3 — immutabilité). Ceci
//   n'est PAS appliqué ici (classe de base abstraite) mais DOIT l'être par
//   chaque implémentation concrète (`InMemoryStorageAdapter`,
//   `GoogleDriveStorageAdapter`).
// - `listChanges(cursor)` renvoie `{changes:[{kind,id}], cursor}` : `cursor`
//   est un jeton opaque pour l'appelant (peut être un entier, une chaîne, un
//   objet — chaque adaptateur définit son propre format et le documente).
//   L'appelant (SyncEngine) ne fait jamais d'hypothèse sur sa forme interne.
// - `share(member)` / `revoke(member)` gèrent l'accès au transport (ACL Drive,
//   par ex.) — jamais les droits métier Pilotéo (PolicyEngine, `core/permissions.js`).
// - `health()` renvoie un statut best-effort, jamais une exception pour un
//   simple "je ne sais pas répondre" (préférer `{ok:false, detail:"..."}`).
// - Cette classe est volontairement une interface "à la JS" : chaque méthode
//   lève par défaut une erreur explicite ("must be implemented by subclass"),
//   ainsi un adaptateur incomplet échoue immédiatement à l'appel plutôt que de
//   se comporter silencieusement comme un no-op.

/** Les 5 catégories de blobs transportées (docs/next/04 §2). */
export const STORAGE_KINDS = Object.freeze([
  "workspace",
  "member",
  "event",
  "key",
  "license",
]);

/** Lève si `kind` n'est pas une des 5 catégories reconnues. */
export function assertValidKind(kind) {
  if (!STORAGE_KINDS.includes(kind)) {
    throw new TypeError(
      `StorageAdapter: kind invalide (${String(kind)}) — attendu l'un de ${STORAGE_KINDS.join(", ")}`
    );
  }
}

function notImplemented(methodName) {
  throw new Error(`StorageAdapter.${methodName}: doit être implémentée par la sous-classe.`);
}

/**
 * Interface de base — aucune règle métier, aucune E/S réelle ici.
 * Les sous-classes (`InMemoryStorageAdapter`, `GoogleDriveStorageAdapter`, ...)
 * implémentent chaque méthode pour un transport donné.
 */
export class StorageAdapter {
  /** Établit la connexion au transport (peut être un no-op pour certains adaptateurs). */
  async connect() {
    return notImplemented("connect");
  }

  /**
   * Écrit un blob immuable. DOIT échouer si `(kind,id)` a déjà été écrit
   * (write-once — docs/next/04 §3). Résout `{id}` en cas de succès.
   * @param {string} kind
   * @param {string} id
   * @param {*} blob
   * @returns {Promise<{id:string}>}
   */
  async putImmutable(kind, id, blob) {
    return notImplemented("putImmutable");
  }

  /** Lit un blob précédemment écrit. Doit échouer clairement si absent. */
  async get(kind, id) {
    return notImplemented("get");
  }

  /**
   * Liste les changements depuis `cursor` (jeton opaque, `undefined`/`null` =
   * depuis le début). Retourne `{changes:[{kind,id}], cursor}` — le nouveau
   * `cursor` permet de reprendre exactement là où cet appel s'est arrêté.
   */
  async listChanges(cursor) {
    return notImplemented("listChanges");
  }

  /** Métadonnées d'un blob (sans son contenu) : dates, taille, etc. */
  async readMetadata(kind, id) {
    return notImplemented("readMetadata");
  }

  /** Accorde l'accès transport à un membre (ex: ACL Drive). Jamais un droit métier. */
  async share(member) {
    return notImplemented("share");
  }

  /** Retire l'accès transport à un membre. Jamais un droit métier. */
  async revoke(member) {
    return notImplemented("revoke");
  }

  /** Statut de santé best-effort : `{ok:boolean, detail:string}`. Ne devrait pas lever pour un simple "hors service". */
  async health() {
    return notImplemented("health");
  }
}
