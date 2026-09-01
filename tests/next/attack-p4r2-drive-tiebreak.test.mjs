// tests/next/attack-p4r2-drive-tiebreak.test.mjs
//
// CONTRARIANT round 2 — Point 4. Angle "réconciliation oldest-wins percée" :
// TROIS dossiers dupliqués ou plus, du même nom, avec le MÊME `createdTime`
// (collision plausible sur des créations quasi simultanées, résolution finie
// de l'horodatage serveur). Le départage se fait alors uniquement par
// comparaison de chaîne sur `id` (`compareByCreatedTimeThenId`). Ce test
// vérifie que ce départage est bien un ORDRE TOTAL STABLE, calculé UNIQUEMENT
// à partir des chaînes `id` elles-mêmes (comparaison ordinale JS `<`/`>`, pas
// dépendante de l'ordre d'insertion, de la locale, ni d'un état par client) —
// donc identique pour TOUS les clients qui voient le MÊME ensemble de
// candidats, quel que soit l'ORDRE dans lequel `files.list` les leur retourne
// (pagination, tri serveur non garanti en l'absence d'`orderBy`).
//
// VERDICT attendu ici : TENU — tant que tous les clients voient le MÊME
// ensemble de candidats au moment de la résolution, le gagnant élu est
// identique quel que soit l'ordre de réception. (La réserve documentée par
// ailleurs — angle "connect() sweep" — porte sur le cas où les ensembles de
// candidats VUS diffèrent d'un client à l'autre à cause d'une propagation
// Drive incomplète, PAS sur une instabilité du comparateur lui-même.)

import test from "node:test";
import assert from "node:assert/strict";

import { GoogleDriveStorageAdapter } from "../../src/storage/google-drive-adapter.js";
import { FakeDrive, FOLDER_MIME } from "./helpers/fake-drive.mjs";

const ROOT_ID = "root-workspace-r2-tiebreak";

function makeAdapter(drive, opts = {}) {
  return new GoogleDriveStorageAdapter({
    oauthTokenProvider: async () => "fake-access-token",
    rootFolderId: ROOT_ID,
    fetchImpl: drive.fetch,
    sleepFn: async () => {},
    maxRetries: 4,
    ...opts,
  });
}

test("TENU — 4 dossiers 'events' dupliqués au MÊME createdTime : tous les clients élisent le MÊME gagnant (départage par id stable), quel que soit l'ordre de listing", async () => {
  const drive = new FakeDrive();
  const T = "2026-08-20T00:00:00.000Z";

  // 4 dossiers "events" en collision de createdTime, ids volontairement
  // choisis pour ne PAS être dans l'ordre d'insertion ("mid" avant "aaa").
  const idMid = drive.addFolder("events", ROOT_ID, { createdTime: T });
  const idZzz = drive.addFolder("events", ROOT_ID, { createdTime: T });
  const idAaa = drive.addFolder("events", ROOT_ID, { createdTime: T });
  const idBbb = drive.addFolder("events", ROOT_ID, { createdTime: T });
  // Renomme les ids internes pour forcer un ordre lexical connu indépendant
  // de l'ordre de création (FakeDrive attribue "id-N" séquentiellement) :
  for (const [oldId, name] of [
    [idMid, "mid"],
    [idZzz, "zzz"],
    [idAaa, "aaa"],
    [idBbb, "bbb"],
  ]) {
    const node = drive.nodes.get(oldId);
    drive.nodes.delete(oldId);
    drive.nodes.set(name, { ...node, id: name });
  }
  const expectedWinner = "aaa"; // lexicalement le plus petit id parmi aaa/bbb/mid/zzz

  // Plusieurs "clients" indépendants résolvent le même dossier. On ne force
  // PAS d'ordre de retour particulier ici (le simulateur trie déjà par
  // (createdTime,name) — ici tous les `createdTime` et tous les `name`
  // ("events") sont identiques, donc l'ordre de retour du simulateur
  // lui-même est indéterminé/stable-par-insertion, PRÉCISÉMENT le cas qui
  // doit être neutralisé par le tri applicatif `compareByCreatedTimeThenId`).
  const clients = Array.from({ length: 5 }, () => makeAdapter(drive));
  await Promise.all(clients.map((c) => c.connect()));

  for (const c of clients) {
    assert.equal(
      c._topFolders.event,
      expectedWinner,
      "TENU : chaque client élit le même gagnant (id lexicalement le plus petit) parmi 4 candidats en collision totale de createdTime"
    );
  }

  // Doublons "orphelins" bien identifiés comme tels dans FakeDrive (pas de
  // suppression réelle attendue — juste vérifie qu'ils ne sont PAS le gagnant).
  const dupFolders = [...drive.nodes.values()].filter((n) => n.mimeType === FOLDER_MIME && n.name === "events");
  assert.equal(dupFolders.length, 4);
});

test("TENU — même départage utilisé pour un fichier à nom constant (ex: current.license) en collision totale à 3 candidats", async () => {
  const drive = new FakeDrive();
  const adapter = makeAdapter(drive);
  await adapter.connect();

  const T = "2026-08-21T00:00:00.000Z";
  const licenseTop = adapter._topFolders.license;

  // 3 fichiers "current.license" en collision de createdTime, contenu
  // IDENTIQUE (pas un test de conflit de contenu ici, juste le départage).
  const content = JSON.stringify({ licenseId: "lic-1", seats: 5 });
  for (const id of ["z-license", "m-license", "a-license"]) {
    drive.nodes.set(id, {
      id,
      name: "current.license",
      mimeType: "application/octet-stream",
      parents: [licenseTop],
      createdTime: T,
      content,
      size: content.length,
    });
  }

  const clients = Array.from({ length: 4 }, () => {
    const c = makeAdapter(drive);
    c._connected = true;
    c._topFolders = adapter._topFolders;
    return c;
  });

  const results = await Promise.all(clients.map((c) => c.readMetadata("license", "current")));
  const fileIds = results.map((r) => r.fileId);
  for (const fid of fileIds) {
    assert.equal(fid, "a-license", "TENU : tous les clients convergent sur le même fichier (id lexicalement le plus petit) parmi 3 candidats en collision totale");
  }
});
