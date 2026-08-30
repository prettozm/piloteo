"""Tests unitaires du moteur de synchronisation, du filtrage et des gardes serveur.

Couvre merge_client_state (fusion optimiste, conflits, permissions), les branches
de filter_state non couvertes par test_server.py, le rate-limiting et client_ip.
Base SQLite temporaire, sans couche HTTP.
"""
import os
import tempfile
import time
import unittest
from pathlib import Path

# Base temporaire AVANT import de server (les chemins sont résolus à l'import).
_TMP = tempfile.mkdtemp(prefix="piloteo-test-")
os.environ["PILOTEO_DATA_DIR"] = _TMP
os.environ["PILOTEO_BACKUP_DIR"] = _TMP + "/backups"
os.environ.setdefault("PILOTEO_ADMIN_USERNAME", "admin")
os.environ.setdefault("PILOTEO_ADMIN_PASSWORD", "mot-de-passe-de-test-long")
os.environ.setdefault("PILOTEO_ADMIN_CONSULTANT_ID", "CDM")

import server  # noqa: E402


def base_state():
    return {
        "consultants": [
            {"id": "U1", "nom": "Un", "trigramme": "UN1", "statut": "en poste", "admin": False, "tjmBase": 500, "dateEmbauche": "2026-01-01", "dateDepart": None, "tempsPartiel": []},
            {"id": "U2", "nom": "Deux", "trigramme": "DE2", "statut": "en poste", "admin": False, "tjmBase": 900, "dateEmbauche": "2026-01-01", "dateDepart": None, "tempsPartiel": []},
        ],
        "organisations": [
            {"id": "O1", "nom": "Client 1", "adresse": "1 rue A"},
            {"id": "O2", "nom": "Client 2", "adresse": "2 rue B"},
            {"id": "O3", "nom": "Partenaire", "adresse": "3 rue C"},
        ],
        "affaires": [
            {"id": "A1", "organisationId": "O1", "pilote": "U1", "piloteCommercial": "U1", "repartitionCommerciale": [], "partenaires": [{"organisationId": "O3"}]},
            {"id": "A2", "organisationId": "O2", "pilote": "U2", "piloteCommercial": "U2", "repartitionCommerciale": []},
        ],
        "missions": [
            {"id": "M1", "affaireId": "A1", "consultantId": "U1"},
            {"id": "M2", "affaireId": "A2", "consultantId": "U2"},
            {"id": "M3", "affaireId": "A1", "consultantId": "U2"},  # mission de U2 sur affaire pilotée par U1
        ],
        "saisies": [
            {"id": "S1", "consultantId": "U1", "missionId": "M1", "type": "mission"},
            {"id": "S2", "consultantId": "U2", "missionId": "M2", "type": "mission"},
        ],
        "notesFrais": [
            {"id": "N1", "consultantId": "U1", "affaireId": "A1"},
            {"id": "N2", "consultantId": "U2", "affaireId": "A2"},
        ],
        "bordereauxFrais": [
            {"numero": "B1", "consultantId": "U1", "statut": "en saisie", "datePaiement": None},
            {"numero": "B2", "consultantId": "U2", "statut": "en saisie", "datePaiement": None},
        ],
        "factures": [{"id": "F1", "affaireId": "A1"}, {"id": "F2", "affaireId": "A2"}],
        "methodes": [], "typesTerritoire": [], "domainesIntervention": [], "categoriesFrais": [],
    }


USER1 = {"id": 1, "role": "user", "consultant_id": "U1", "username": "u1"}
USER2 = {"id": 2, "role": "user", "consultant_id": "U2", "username": "u2"}
ADMIN = {"id": 9, "role": "admin", "consultant_id": "CDM", "username": "admin"}


class FilterStateBranches(unittest.TestCase):
    def test_pilot_sees_all_missions_of_piloted_affair(self):
        out = server.filter_state(base_state(), USER1)
        ids = {m["id"] for m in out["missions"]}
        # M1 (sienne) et M3 (mission d'un autre sur l'affaire A1 qu'il pilote)
        self.assertEqual(ids, {"M1", "M3"})

    def test_partner_organisation_is_visible(self):
        out = server.filter_state(base_state(), USER1)
        ids = {o["id"] for o in out["organisations"]}
        self.assertIn("O3", ids)  # partenaire de A1
        self.assertNotIn("O2", ids)  # affaire d'un autre

    def test_factures_only_for_piloted_affairs(self):
        out = server.filter_state(base_state(), USER1)
        self.assertEqual([f["id"] for f in out["factures"]], ["F1"])

    def test_bordereaux_only_own(self):
        out = server.filter_state(base_state(), USER1)
        self.assertEqual([b["numero"] for b in out["bordereauxFrais"]], ["B1"])

    def test_notesfrais_own_or_piloted_affair(self):
        out = server.filter_state(base_state(), USER1)
        self.assertEqual({n["id"] for n in out["notesFrais"]}, {"N1"})

    def test_saisies_on_piloted_affair_visible(self):
        # U2 a une saisie S? sur M3 (affaire A1 pilotée par U1) -> visible par U1
        st = base_state()
        st["saisies"].append({"id": "S3", "consultantId": "U2", "missionId": "M3", "type": "mission"})
        out = server.filter_state(st, USER1)
        self.assertIn("S3", {s["id"] for s in out["saisies"]})

    def test_admin_sees_everything(self):
        out = server.filter_state(base_state(), ADMIN)
        self.assertEqual(len(out["affaires"]), 2)
        self.assertEqual(len(out["factures"]), 2)


class MergeSync(unittest.TestCase):
    def setUp(self):
        server.init_db()
        conn = server.db_connect()
        raw = server.json.dumps(base_state(), ensure_ascii=False, separators=(",", ":"))
        conn.execute("UPDATE app_state SET revision=1, state_json=? WHERE singleton=1", (raw,))
        conn.execute("DELETE FROM state_history")
        conn.execute("INSERT INTO state_history(revision,state_json,created_at,created_by) VALUES(1,?,?,NULL)", (raw, server.iso_now()))
        conn.commit()
        self.conn = conn

    def tearDown(self):
        self.conn.close()

    def _put(self, user, mutate, base_rev=1):
        visible = server.filter_state(base_state(), user)
        mutate(visible)
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            rev, state, summary = server.merge_client_state(self.conn, user, visible, base_rev, "127.0.0.1")
            self.conn.execute("COMMIT")
            return rev, state, summary
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

    def test_user_updates_own_saisie(self):
        def mut(v):
            v["saisies"][0]["commentaire"] = "à jour"
        rev, state, summary = self._put(USER1, mut)
        self.assertEqual(rev, 2)
        self.assertEqual(len(summary), 1)

    def test_user_cannot_touch_admin_only_collection(self):
        def mut(v):
            v["methodes"].append({"id": "ME9", "nom": "x"})
        with self.assertRaises(PermissionError):
            self._put(USER1, mut)

    def test_concurrent_edit_same_entity_conflicts(self):
        # U1 modifie S1 sur base_revision=1, mais entre-temps la révision serveur
        # a avancé avec une autre valeur de S1.
        newer = base_state()
        newer["saisies"][0]["commentaire"] = "serveur"
        raw = server.json.dumps(newer, ensure_ascii=False, separators=(",", ":"))
        self.conn.execute("UPDATE app_state SET revision=2, state_json=? WHERE singleton=1", (raw, ))
        self.conn.execute("INSERT INTO state_history(revision,state_json,created_at,created_by) VALUES(2,?,?,NULL)", (raw, server.iso_now()))
        self.conn.commit()

        def mut(v):
            v["saisies"][0]["commentaire"] = "client"
        with self.assertRaises(server.SyncConflict):
            self._put(USER1, mut, base_rev=1)

    def test_concurrent_edit_different_entity_merges(self):
        # Le serveur avance en modifiant S2 (invisible pour U1) ; U1 modifie S1.
        newer = base_state()
        newer["saisies"][1]["commentaire"] = "serveur autre"
        raw = server.json.dumps(newer, ensure_ascii=False, separators=(",", ":"))
        self.conn.execute("UPDATE app_state SET revision=2, state_json=? WHERE singleton=1", (raw, ))
        self.conn.execute("INSERT INTO state_history(revision,state_json,created_at,created_by) VALUES(2,?,?,NULL)", (raw, server.iso_now()))
        self.conn.commit()

        def mut(v):
            v["saisies"][0]["commentaire"] = "client"
        rev, state, summary = self._put(USER1, mut, base_rev=1)
        self.assertEqual(rev, 3)
        # Les deux modifications coexistent dans l'état canonique.
        full = server.json.loads(self.conn.execute("SELECT state_json FROM app_state WHERE singleton=1").fetchone()["state_json"])
        s = {x["id"]: x.get("commentaire") for x in full["saisies"]}
        self.assertEqual(s["S1"], "client")
        self.assertEqual(s["S2"], "serveur autre")

    def test_too_old_base_revision_raises(self):
        with self.assertRaises(server.SyncConflict):
            self._put(USER1, lambda v: v["saisies"][0].update(commentaire="x"), base_rev=999)


class RateLimit(unittest.TestCase):
    def setUp(self):
        server._LOGIN_ATTEMPTS.clear()

    def test_blocks_after_ten_failures(self):
        ip = "203.0.113.7"
        for _ in range(10):
            self.assertFalse(server.login_rate_limited(ip))
            server.record_login_failure(ip)
        self.assertTrue(server.login_rate_limited(ip))

    def test_stale_ips_are_purged(self):
        server._LOGIN_ATTEMPTS["old"].append(time.time() - 1000)
        server.login_rate_limited("trigger")  # déclenche la purge
        self.assertNotIn("old", server._LOGIN_ATTEMPTS)


class ClientIpTrust(unittest.TestCase):
    def test_trusted_proxy_networks_parsed(self):
        self.assertTrue(server.is_trusted_proxy("127.0.0.1"))
        self.assertTrue(server.is_trusted_proxy("10.1.2.3"))
        self.assertFalse(server.is_trusted_proxy("203.0.113.10"))
        self.assertFalse(server.is_trusted_proxy("pas-une-ip"))


if __name__ == "__main__":
    unittest.main()
