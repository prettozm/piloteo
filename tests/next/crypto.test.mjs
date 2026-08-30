// tests/next/crypto.test.mjs
//
// Tests du CryptoService (crypto/crypto-service.js, crypto/keyring.js).
// Couvre docs/next/07_TESTS_ET_RECETTE.md §8 : pas seulement le happy path.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateMemberIdentity,
  sign,
  verify,
  generateWorkspaceKey,
  encryptPayload,
  decryptPayload,
  generateMemberWrapKeypair,
  wrapKeyForMember,
  unwrapKeyForMember,
} from '../../src/crypto/crypto-service.js';
import { Keyring } from '../../src/crypto/keyring.js';

// ---------------------------------------------------------------------------
// Chiffrement AES-256-GCM
// ---------------------------------------------------------------------------

test('encryptPayload: le ciphertext ne contient pas le clair et n\'est pas égal au clair', async () => {
  const key = await generateWorkspaceKey();
  const plaintextObj = { entityType: 'saisie', montant: 1234.5, secretMarker: 'NE-DOIT-PAS-FUITER' };
  const ciphertext = await encryptPayload(key, plaintextObj);

  assert.notEqual(ciphertext, JSON.stringify(plaintextObj));
  assert.equal(ciphertext.includes('NE-DOIT-PAS-FUITER'), false);
  assert.equal(ciphertext.includes('saisie'), false);
});

test('encryptPayload/decryptPayload: round-trip fidèle', async () => {
  const key = await generateWorkspaceKey();
  const plaintextObj = { a: 1, b: 'texte', c: [1, 2, 3], d: { nested: true } };
  const ciphertext = await encryptPayload(key, plaintextObj);
  const decrypted = await decryptPayload(key, ciphertext);
  assert.deepEqual(decrypted, plaintextObj);
});

test('decryptPayload: rejette un tag corrompu', async () => {
  const key = await generateWorkspaceKey();
  const ciphertext = await encryptPayload(key, { x: 1 });
  // Le ciphertext (base64url) se termine par le tag GCM (16 derniers octets
  // de l'enveloppe binaire). On altère le dernier caractère utile.
  const corrupted = ciphertext.slice(0, -2) + (ciphertext.at(-2) === 'A' ? 'B' : 'A') + ciphertext.at(-1);
  await assert.rejects(() => decryptPayload(key, corrupted));
});

test('decryptPayload: rejette un nonce/IV altéré', async () => {
  const key = await generateWorkspaceKey();
  const ciphertext = await encryptPayload(key, { x: 1 });
  // L'IV occupe les octets [1..13) de l'enveloppe binaire, donc les
  // caractères base64url juste après le premier caractère (qui code la
  // version). On altère un caractère dans la zone de l'IV encodée.
  const chars = ciphertext.split('');
  const idx = 3; // à l'intérieur de la zone IV encodée
  chars[idx] = chars[idx] === 'A' ? 'B' : 'A';
  const corrupted = chars.join('');
  await assert.rejects(() => decryptPayload(key, corrupted));
});

test('decryptPayload: rejette une mauvaise clé', async () => {
  const key = await generateWorkspaceKey();
  const otherKey = await generateWorkspaceKey();
  const ciphertext = await encryptPayload(key, { x: 1 });
  await assert.rejects(() => decryptPayload(otherKey, ciphertext));
});

test('decryptPayload: rejette une enveloppe tronquée/vide', async () => {
  const key = await generateWorkspaceKey();
  await assert.rejects(() => decryptPayload(key, 'abc'));
  await assert.rejects(() => decryptPayload(key, ''));
});

test('encryptPayload: nonce unique -> deux chiffrements du même clair diffèrent', async () => {
  const key = await generateWorkspaceKey();
  const plaintextObj = { same: 'valeur-identique' };
  const c1 = await encryptPayload(key, plaintextObj);
  const c2 = await encryptPayload(key, plaintextObj);
  assert.notEqual(c1, c2);
  // Mais les deux se déchiffrent correctement vers le même objet.
  assert.deepEqual(await decryptPayload(key, c1), plaintextObj);
  assert.deepEqual(await decryptPayload(key, c2), plaintextObj);
});

// ---------------------------------------------------------------------------
// Identité de membre / signature Ed25519
// ---------------------------------------------------------------------------

test('sign/verify: signature valide acceptée', async () => {
  const { publicKeyJwk, privateKeyRef } = await generateMemberIdentity();
  const bytes = new TextEncoder().encode('événement canonique de test');
  const signature = await sign(privateKeyRef, bytes);
  const ok = await verify(publicKeyJwk, bytes, signature);
  assert.equal(ok, true);
});

test('verify: signature invalide (aléatoire) rejetée', async () => {
  const { publicKeyJwk } = await generateMemberIdentity();
  const bytes = new TextEncoder().encode('événement canonique de test');
  const fakeSignature = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const ok = await verify(publicKeyJwk, bytes, fakeSignature);
  assert.equal(ok, false);
});

test('verify: signature d\'une autre identité rejetée', async () => {
  const memberA = await generateMemberIdentity();
  const memberB = await generateMemberIdentity();
  const bytes = new TextEncoder().encode('événement canonique de test');
  const signature = await sign(memberA.privateKeyRef, bytes);
  const ok = await verify(memberB.publicKeyJwk, bytes, signature);
  assert.equal(ok, false);
});

test('verify: événement (bytes) modifié après signature -> rejeté', async () => {
  const { publicKeyJwk, privateKeyRef } = await generateMemberIdentity();
  const original = new TextEncoder().encode(JSON.stringify({ op: 'update', amount: 100 }));
  const signature = await sign(privateKeyRef, original);

  const tampered = new TextEncoder().encode(JSON.stringify({ op: 'update', amount: 999 }));
  const ok = await verify(publicKeyJwk, tampered, signature);
  assert.equal(ok, false);
});

test('privateKeyRef: la clé privée Ed25519 n\'est pas exportable', async () => {
  const { privateKeyRef } = await generateMemberIdentity();
  assert.equal(privateKeyRef.cryptoKey.extractable, false);
});

// ---------------------------------------------------------------------------
// Keyring / rotation d'epoch
// ---------------------------------------------------------------------------

test('Keyring: addEpoch/current/get', async () => {
  const keyring = new Keyring();
  assert.equal(keyring.current(), null);

  const key1 = await generateWorkspaceKey();
  keyring.addEpoch(1, key1);
  assert.equal(keyring.current(), key1);
  assert.equal(keyring.get(1), key1);
  assert.equal(keyring.get(2), null);
});

test('Keyring: rotate() crée une nouvelle epoch courante, l\'ancienne reste lisible', async () => {
  const keyring = new Keyring();
  const key1 = await generateWorkspaceKey();
  keyring.addEpoch(1, key1);

  const oldPlaintext = { msg: 'chiffré avec epoch 1' };
  const oldCiphertext = await encryptPayload(keyring.current(), oldPlaintext);

  const { epoch, key: key2 } = await keyring.rotate(generateWorkspaceKey);
  assert.equal(epoch, 2);
  assert.equal(keyring.current(), key2);
  assert.notEqual(key2, key1);

  const newPlaintext = { msg: 'chiffré avec epoch 2' };
  const newCiphertext = await encryptPayload(keyring.current(), newPlaintext);

  // L'ancienne epoch (récupérée via get(1)) lit toujours l'ancien blob.
  const decryptedOld = await decryptPayload(keyring.get(1), oldCiphertext);
  assert.deepEqual(decryptedOld, oldPlaintext);

  // Mais l'ancienne clé ne lit PAS le nouveau blob (chiffré avec epoch 2).
  await assert.rejects(() => decryptPayload(keyring.get(1), newCiphertext));

  // La clé courante (epoch 2) lit le nouveau blob.
  const decryptedNew = await decryptPayload(keyring.current(), newCiphertext);
  assert.deepEqual(decryptedNew, newPlaintext);
});

test('Keyring.addEpoch: rejette un numéro d\'epoch invalide', async () => {
  const keyring = new Keyring();
  const key = await generateWorkspaceKey();
  assert.throws(() => keyring.addEpoch(0, key));
  assert.throws(() => keyring.addEpoch(1.5, key));
});

// ---------------------------------------------------------------------------
// Distribution de clé (wrap/unwrap) pour un membre
// ---------------------------------------------------------------------------

test('wrapKeyForMember/unwrapKeyForMember: round-trip pour un membre', async () => {
  const epochKey = await generateWorkspaceKey();
  const member = await generateMemberWrapKeypair();

  const wrapped = await wrapKeyForMember(epochKey, member.publicKeyJwk);
  assert.equal(typeof wrapped, 'string');

  const unwrapped = await unwrapKeyForMember(wrapped, member.privateKeyRef);

  // Vérifie que la clé récupérée déchiffre bien un message chiffré avec la
  // clé de workspace d'origine (preuve fonctionnelle d'égalité des clés).
  const plaintextObj = { proof: 'unwrap-ok', n: 42 };
  const ciphertext = await encryptPayload(epochKey, plaintextObj);
  const decrypted = await decryptPayload(unwrapped, ciphertext);
  assert.deepEqual(decrypted, plaintextObj);
});

test('unwrapKeyForMember: rejette avec la clé privée d\'un autre membre', async () => {
  const epochKey = await generateWorkspaceKey();
  const memberA = await generateMemberWrapKeypair();
  const memberB = await generateMemberWrapKeypair();

  const wrapped = await wrapKeyForMember(epochKey, memberA.publicKeyJwk);
  await assert.rejects(() => unwrapKeyForMember(wrapped, memberB.privateKeyRef));
});

test('unwrapKeyForMember: rejette une enveloppe corrompue', async () => {
  const epochKey = await generateWorkspaceKey();
  const member = await generateMemberWrapKeypair();
  const wrapped = await wrapKeyForMember(epochKey, member.publicKeyJwk);
  const corrupted = wrapped.slice(0, -4) + 'XXXX';
  await assert.rejects(() => unwrapKeyForMember(corrupted, member.privateKeyRef));
});

test('wrapKeyForMember: deux appels pour le même membre produisent des enveloppes différentes (éphémère unique)', async () => {
  const epochKey = await generateWorkspaceKey();
  const member = await generateMemberWrapKeypair();
  const wrapped1 = await wrapKeyForMember(epochKey, member.publicKeyJwk);
  const wrapped2 = await wrapKeyForMember(epochKey, member.publicKeyJwk);
  assert.notEqual(wrapped1, wrapped2);
});
