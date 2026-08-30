// src/crypto/keyring.js
//
// Gestion des clés de workspace par "epoch" (CONTRACTS §4, docs/next/05 §3/§8).
// Chaque epoch est une clé AES-256-GCM (CryptoKey WebCrypto) indexée par un
// numéro entier croissant. Les anciens événements restent déchiffrables tant
// que leur epoch d'origine est conservée dans le Keyring ; les nouveaux
// événements sont chiffrés avec l'epoch courante (la plus récente). Une
// rotation (révocation d'un membre, notamment) crée une nouvelle epoch sans
// supprimer les précédentes : c'est à l'appelant (SyncEngine / politique de
// rétention) de décider s'il faut, un jour, purger une epoch trop ancienne.
//
// Aucune primitive crypto ici : ce module ne fait qu'indexer des clés déjà
// produites par crypto-service.js (generateWorkspaceKey). Jamais de clé
// loggée.

class Keyring {
  constructor() {
    /** @type {Map<number, CryptoKey>} */
    this._epochs = new Map();
    this._currentEpoch = null;
  }

  /**
   * Enregistre une clé pour l'epoch `n`. Si `n` est strictement supérieur à
   * l'epoch courante connue (ou si aucune epoch n'existe encore), elle
   * devient l'epoch courante.
   * @param {number} n numéro d'epoch (entier >= 1)
   * @param {CryptoKey} key clé de workspace (AES-256-GCM)
   */
  addEpoch(n, key) {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error('Keyring.addEpoch: numéro d\'epoch invalide (entier >= 1 attendu).');
    }
    if (!key) {
      throw new Error('Keyring.addEpoch: clé manquante.');
    }
    this._epochs.set(n, key);
    if (this._currentEpoch === null || n > this._currentEpoch) {
      this._currentEpoch = n;
    }
  }

  /**
   * Retourne la clé de l'epoch courante (la plus récente connue), ou null si
   * le keyring est vide.
   * @returns {CryptoKey|null}
   */
  current() {
    if (this._currentEpoch === null) return null;
    return this._epochs.get(this._currentEpoch) ?? null;
  }

  /**
   * Numéro de l'epoch courante, ou null si le keyring est vide.
   * @returns {number|null}
   */
  currentEpochNumber() {
    return this._currentEpoch;
  }

  /**
   * Retourne la clé de l'epoch `n`, ou null si inconnue localement (par ex.
   * clé révoquée jamais reçue, ou epoch future non encore distribuée).
   * @param {number} n
   * @returns {CryptoKey|null}
   */
  get(n) {
    return this._epochs.get(n) ?? null;
  }

  /**
   * Crée une nouvelle epoch (numéro courant + 1) avec une nouvelle clé
   * (fournie par l'appelant via crypto-service.generateWorkspaceKey()), la
   * fait passer courante, et la retourne avec son numéro. Les epochs
   * précédentes restent dans le keyring (déchiffrement des anciens
   * événements toujours possible).
   * @param {() => Promise<CryptoKey>|CryptoKey} generateKey fonction produisant une nouvelle clé (ex: crypto-service.generateWorkspaceKey)
   * @returns {Promise<{epoch:number, key:CryptoKey}>}
   */
  async rotate(generateKey) {
    if (typeof generateKey !== 'function') {
      throw new Error('Keyring.rotate: une fonction generateKey (ex: generateWorkspaceKey) est requise.');
    }
    const nextEpoch = (this._currentEpoch ?? 0) + 1;
    const key = await generateKey();
    this.addEpoch(nextEpoch, key);
    return { epoch: nextEpoch, key };
  }

  /** Liste triée des numéros d'epoch connus localement. */
  knownEpochs() {
    return Array.from(this._epochs.keys()).sort((a, b) => a - b);
  }
}

export { Keyring };
