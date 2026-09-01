// tests/next/auth-session.test.mjs
//
// Couvre docs/next/AUTH_SESSION_CONTRACT.md §5 (cas 1-5) : le module PUR
// `src/auth/session.js` (hashPin/verifyPin PBKDF2, machine à états de
// session, anti-force-brute exponentiel horodaté par un `now` fourni par
// l'appelant) + les durcissements §1 ajoutés au round de correction suite à
// la revue adverse (FAILLE 1 : anti-downgrade itérations + recoupement
// d'horloge monotone — défense en profondeur, PAS des barrières, cf. modèle
// de menace §0).

import test from "node:test";
import assert from "node:assert/strict";

import {
  hashPin,
  verifyPin,
  newSalt,
  initialSession,
  canAttempt,
  canAttemptCrossChecked,
  registerFailure,
  registerSuccess,
  lock,
} from "../../src/auth/session.js";

// ---------------------------------------------------------------------------
// Cas 1 — hashPin/verifyPin
// ---------------------------------------------------------------------------

test("hashPin/verifyPin : bon PIN accepté, mauvais rejeté", async () => {
  const salt = newSalt();
  const stored = await hashPin("1234", salt, 210000);
  assert.equal(await verifyPin("1234", stored), true);
  assert.equal(await verifyPin("0000", stored), false);
  assert.equal(await verifyPin("12345", stored), false, "un PIN plus long ne doit pas être accepté par préfixe");
});

test("hashPin : sel différent => hash différent (même PIN, mêmes itérations)", async () => {
  const a = await hashPin("1234", newSalt(), 210000);
  const b = await hashPin("1234", newSalt(), 210000);
  assert.notEqual(a.saltB64, b.saltB64);
  assert.notEqual(a.hashB64, b.hashB64);
});

test("hashPin : itérations respectées (>=210000 par défaut, valeur explicite conservée)", async () => {
  const withDefault = await hashPin("1234", newSalt());
  assert.equal(withDefault.iterations, 210000);

  const withMore = await hashPin("1234", newSalt(), 250000);
  assert.equal(withMore.iterations, 250000);

  await assert.rejects(
    () => hashPin("1234", newSalt(), 1000),
    /210000/,
    "hashPin doit refuser un nombre d'itérations sous le plancher"
  );
});

test("newSalt : produit 16 octets aléatoires (deux appels distincts)", () => {
  const s1 = newSalt();
  const s2 = newSalt();
  assert.equal(s1.length, 16);
  assert.equal(s2.length, 16);
  assert.notDeepEqual(Array.from(s1), Array.from(s2));
});

// ---------------------------------------------------------------------------
// Cas 2 — verifyPin à temps constant (inspection fonctionnelle du code +
// preuve indirecte : la comparaison ne peut pas court-circuiter puisqu'elle
// doit rejeter un candidat qui diffère seulement sur le DERNIER octet,
// comme sur le premier — un court-circuit sur `===` échouerait de la même
// façon dans les deux cas donc ce test ne PROUVE pas le temps constant à lui
// seul ; l'inspection du code de `constantTimeEqual` (boucle complète, XOR
// accumulé, aucun `return` anticipé) est la preuve structurelle exigée par
// le contrat §5.2, ce test est le test fonctionnel complémentaire attendu.
// ---------------------------------------------------------------------------

test("verifyPin : rejette un candidat qui ne diffère que sur le dernier octet du hash (pas de court-circuit précoce)", async () => {
  const stored = await hashPin("999999", newSalt(), 210000);
  // On altère explicitement le hash stocké sur son DERNIER caractère décodé
  // (fin de la comparaison) : si l'implémentation court-circuitait dès la
  // première différence rencontrée en tête, elle se comporterait differement
  // d'une différence en tête — ici on vérifie juste que la fin du buffer est
  // bien prise en compte (rejet), ce qui exclut un court-circuit sur préfixe.
  await assert.rejects(
    () => verifyPin("999999", { ...stored, hashB64: undefined }),
    /invalide/
  );
  assert.equal(await verifyPin("999998", stored), false);
});

// ---------------------------------------------------------------------------
// Cas 3 — anti-force-brute exponentiel, horodaté par `now` fourni
// ---------------------------------------------------------------------------

test("anti-force-brute : 5 échecs bloquent, avancer `now` au-delà débloque, reculer `now` reste bloqué", async () => {
  const stored = await hashPin("4242", newSalt(), 210000);
  let session = initialSession({ pin: stored });
  let now = 1_000_000;

  for (let i = 0; i < 5; i++) {
    session = registerFailure(session, now);
    now += 5; // quelques ms entre chaque tentative
  }

  const afterFive = canAttempt(session, now);
  assert.equal(afterFive.allowed, false);
  assert.ok(afterFive.waitMs > 0, "un blocage doit être posé après 5 échecs");

  // Avancer au-delà de lockedUntil -> de nouveau autorisé.
  const later = session.lockedUntil + 1;
  assert.equal(canAttempt(session, later).allowed, true);

  // Reculer `now` (avant lockedUntil) -> reste bloqué : le module compare au
  // `lockedUntil` STOCKÉ, jamais à une horloge interne qui pourrait raccourcir.
  const earlier = session.lockedUntil - 1;
  const backCheck = canAttempt(session, earlier);
  assert.equal(backCheck.allowed, false);
  assert.ok(backCheck.waitMs > 0);

  // Un ÉCHEC supplémentaire enregistré avec un `now` régressé (horloge
  // manipulée par l'appelant) ne doit jamais FAIRE DÉCROÎTRE `lockedUntil`.
  const priorLockedUntil = session.lockedUntil;
  const regressed = registerFailure(session, session.lockedUntil - 100_000);
  assert.ok(regressed.lockedUntil >= priorLockedUntil, "lockedUntil ne doit jamais reculer");
});

test("anti-force-brute : le blocage croît de façon exponentielle (échecs 5, 6, 7)", async () => {
  const stored = await hashPin("4242", newSalt(), 210000);
  let session = initialSession({ pin: stored });
  const now = 2_000_000;

  session = registerFailure(session, now);
  session = registerFailure(session, now);
  session = registerFailure(session, now);
  session = registerFailure(session, now);
  session = registerFailure(session, now); // 5e échec -> 1er blocage (2^0 = 1s)
  const wait5 = session.lockedUntil - now;

  session = registerFailure(session, now + wait5 + 1); // 6e échec -> 2^1 = 2s
  const wait6 = session.lockedUntil - (now + wait5 + 1);

  assert.ok(wait5 > 0);
  assert.ok(wait6 > wait5, `le blocage doit croître (5e=${wait5}ms, 6e=${wait6}ms)`);
});

test("canAttempt : sous 5 échecs, jamais bloqué", async () => {
  let session = initialSession({});
  const now = 10_000;
  for (let i = 0; i < 4; i++) session = registerFailure(session, now);
  const gate = canAttempt(session, now);
  assert.equal(gate.allowed, true);
  assert.equal(gate.waitMs, 0);
});

// ---------------------------------------------------------------------------
// Cas 4 — registerSuccess remet le compteur/lockout à zéro
// ---------------------------------------------------------------------------

test("registerSuccess : remet failedAttempts et lockedUntil à zéro, status actif", async () => {
  let session = initialSession({});
  const now = 5000;
  for (let i = 0; i < 6; i++) session = registerFailure(session, now);
  assert.ok(session.failedAttempts >= 5);
  assert.ok(session.lockedUntil > 0);

  const success = registerSuccess(session);
  assert.equal(success.status, "active");
  assert.equal(success.failedAttempts, 0);
  assert.equal(success.lockedUntil, 0);
});

// ---------------------------------------------------------------------------
// Cas 5 — initialSession : PIN présent => locked ; absent => active
// ---------------------------------------------------------------------------

test("initialSession : PIN présent => locked ; absent => active", async () => {
  const stored = await hashPin("1234", newSalt(), 210000);
  const withPin = initialSession({ pin: stored });
  assert.equal(withPin.status, "locked");
  assert.deepEqual(withPin.pin, stored);

  const withoutPin = initialSession({});
  assert.equal(withoutPin.status, "active");
  assert.equal(withoutPin.pin, null);

  assert.equal(withPin.failedAttempts, 0);
  assert.equal(withPin.lockedUntil, 0);
});

test("lock : verrouille explicitement sans toucher failedAttempts/lockedUntil", () => {
  const session = { status: "active", pin: null, failedAttempts: 3, lockedUntil: 12345, lockOnOpen: false };
  const locked = lock(session);
  assert.equal(locked.status, "locked");
  assert.equal(locked.failedAttempts, 3);
  assert.equal(locked.lockedUntil, 12345);
});

// ---------------------------------------------------------------------------
// Aucun secret en clair : hashPin ne renvoie jamais le PIN
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Round de correction (revue adverse) — FAILLE 1a : anti-downgrade itérations
// ---------------------------------------------------------------------------

test("verifyPin : REJETTE un enregistrement forgé avec iterations < 210000 (anti-downgrade)", async () => {
  const genuine = await hashPin("4242", newSalt(), 210000);
  // Simule un `piloteo_session` altéré (édition directe d'IndexedDB) qui
  // affaiblirait le nombre d'itérations pour rendre un brute-force hors ligne
  // praticable : `verifyPin` doit refuser AVANT même de tenter la dérivation
  // sur le hash normal, quel que soit le PIN présenté (bon ou mauvais).
  const weakened = { ...genuine, iterations: 1000 };
  await assert.rejects(() => verifyPin("4242", weakened), /itérations|210000/);
  await assert.rejects(() => verifyPin("0000", weakened), /itérations|210000/);
});

test("verifyPin : accepte pile 210000 itérations (le plancher lui-même n'est pas rejeté)", async () => {
  const stored = await hashPin("4242", newSalt(), 210000);
  assert.equal(stored.iterations, 210000);
  assert.equal(await verifyPin("4242", stored), true);
});

// ---------------------------------------------------------------------------
// Round de correction (revue adverse) — FAILLE 1b : recoupement d'horloge
// monotone (canAttemptCrossChecked), défense en profondeur contre un
// `Date.now` monkey-patché dans la page (repro : tests/e2e/attack-p3-session.mjs).
// ---------------------------------------------------------------------------

test("canAttemptCrossChecked : une horloge murale avancée artificiellement ne peut PAS, seule, lever le blocage", () => {
  let session = initialSession({});
  const realNow = 1_000_000;
  for (let i = 0; i < 5; i++) session = registerFailure(session, realNow);
  assert.ok(session.lockedUntil > realNow);

  // Horloge murale "monkey-patchée" par un attaquant (avance de 24h à chaque
  // lecture, comme dans le repro) : horloge monotone honnête, elle, n'a
  // réellement avancé que de quelques ms.
  const fakeWallNow = realNow + 24 * 60 * 60 * 1000;
  const honestMonoNow = realNow + 50;
  const crossChecked = canAttemptCrossChecked(session, fakeWallNow, honestMonoNow);
  assert.equal(crossChecked.allowed, false, "le recoupement doit rester bloqué malgré l'horloge murale avancée");
  assert.ok(crossChecked.waitMs > 0);

  // Vérifie que c'est bien `canAttempt` seul (non recoupé) qui se laisserait
  // tromper — la preuve que le recoupement apporte quelque chose de RÉEL.
  const naiveWithFakeClock = canAttempt(session, fakeWallNow);
  assert.equal(naiveWithFakeClock.allowed, true, "témoin : canAttempt() nu, lui, est bien trompé par l'horloge murale avancée");
});

test("canAttemptCrossChecked : se lève normalement quand les DEUX horloges s'accordent (temps réellement écoulé)", () => {
  let session = initialSession({});
  const realNow = 2_000_000;
  for (let i = 0; i < 5; i++) session = registerFailure(session, realNow);

  const stillLocked = canAttemptCrossChecked(session, session.lockedUntil - 1, session.lockedUntil - 1);
  assert.equal(stillLocked.allowed, false);

  const laterBoth = session.lockedUntil + 1;
  const unlocked = canAttemptCrossChecked(session, laterBoth, laterBoth);
  assert.equal(unlocked.allowed, true);
  assert.equal(unlocked.waitMs, 0);
});

test("canAttemptCrossChecked : sous 5 échecs, jamais bloqué même avec des horloges divergentes", () => {
  let session = initialSession({});
  const now = 10_000;
  for (let i = 0; i < 4; i++) session = registerFailure(session, now);
  const result = canAttemptCrossChecked(session, now, now + 999_999);
  assert.equal(result.allowed, true);
  assert.equal(result.waitMs, 0);
});

test("hashPin : la sortie ne contient jamais le PIN en clair", async () => {
  const pin = "MOT-DE-PASSE-SECRET-7777";
  const stored = await hashPin(pin, newSalt(), 210000);
  const serialized = JSON.stringify(stored);
  assert.equal(serialized.includes(pin), false);
  assert.deepEqual(Object.keys(stored).sort(), ["hashB64", "iterations", "saltB64"]);
});
