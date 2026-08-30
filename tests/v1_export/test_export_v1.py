#!/usr/bin/env python3
"""Tests pour tools/v1-export/export_v1.py.

Crée une base SQLite temporaire reproduisant le schéma minimal V1
(`app_state(state_json, revision)` + `PRAGMA user_version`), insère un
état de démo couvrant plusieurs collections (dont `bordereauxFrais`,
identifiée par `numero` et non `id` — piège de nommage V1_DOMAIN_MAP.md
§1), lance l'export, et vérifie :

  - le format de sortie exact attendu par src/migration/v1-import.js
    (`format`, `schemaVersion`, `exportedAt`, `revision`, `state` complet
    avec les 12 collections) ;
  - que la base SQLite temporaire n'est jamais modifiée par l'export
    (contenu ET mtime inchangés) ;
  - que l'ouverture en lecture seule (mode=ro) est bien ce que le script
    utilise (une écriture explicite sur une telle connexion échoue) ;
  - le comportement sur base absente / illisible (code retour non nul) ;
  - le comportement NaN/Infinity (refus par défaut, `--allow-nan` accepte).

Exécution :
    cd /home/user/piloteo && python3 -m unittest tests/v1_export/test_export_v1.py -v
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
EXPORT_SCRIPT = REPO_ROOT / "tools" / "v1-export" / "export_v1.py"

# Import direct du module (pas seulement en sous-processus) pour tester les
# fonctions internes (open_readonly, read_v1_state, serialize) unitairement.
_spec = importlib.util.spec_from_file_location("export_v1", EXPORT_SCRIPT)
export_v1 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(export_v1)  # type: ignore[union-attr]

ALL_COLLECTIONS = [
    "consultants", "organisations", "affaires", "methodes", "typesTerritoire",
    "domainesIntervention", "categoriesFrais", "missions", "factures",
    "saisies", "bordereauxFrais", "notesFrais",
]

DEMO_STATE = {
    "consultants": [
        {"id": "jdo", "nom": "Jean Dupont", "trigramme": "JDO", "statut": "en poste",
         "dateEmbauche": "2020-01-01", "dateDepart": None, "tjmBase": 500, "admin": True,
         "tempsPartiel": []},
    ],
    "organisations": [
        {"id": "O-1", "nom": "ACME", "type": "client", "adresse": "1 rue Test"},
    ],
    "affaires": [
        {"id": "A-1", "nom": "Affaire Test", "organisationId": "O-1", "nomAbrege": "AT",
         "motsCles": "", "pilote": "jdo", "piloteCommercial": "jdo", "typeVente": "directe",
         "pctReussite": 100, "dateDepot": "2024-01-01", "statut": "en cours", "budget": 10000,
         "jours": 20, "frais": 0, "dateDebut": "2024-01-01", "dateFin": "2024-12-31",
         "methodes": [], "territoires": [], "domaines": [], "partenaires": [],
         "repartitionCommerciale": []},
    ],
    "methodes": [{"id": "1", "label": "Agile"}],
    "typesTerritoire": [{"id": "1", "label": "National"}],
    "domainesIntervention": [{"id": "1", "label": "Conseil"}],
    "categoriesFrais": [{"id": "1", "categorie": "transport", "label": "Transport"}],
    "missions": [
        {"id": "M-1", "affaireId": "A-1", "nom": "Mission 1", "consultantId": "jdo",
         "statut": "en cours", "enveloppe": 10, "taux": 500, "dateDebut": "2024-01-01",
         "dateFin": "2024-06-30", "commentaires": "", "projectionManuelle": {}},
    ],
    "factures": [
        {"id": "F-1", "affaireId": "A-1", "numero": "FA-001", "formation": False,
         "montantMissionHT": 5000, "montantSousTraitanceHT": 0, "montantFraisTTC": 0,
         "echeancePrev": "2024-03-01", "dateDepot": None, "echeancePaiementPrev": "2024-04-01",
         "datePaiement": None, "payee": False, "statut": "en attente", "commentaires": ""},
    ],
    "saisies": [
        {"id": "S-1", "date": "2024-01-15", "consultantId": "jdo", "type": "mission",
         "missionId": "M-1", "categorie": None, "dureeH": 8, "pctFact": 100, "commentaire": ""},
    ],
    # Piège de nommage V1_DOMAIN_MAP.md §1 : clé d'identité = "numero", pas "id".
    "bordereauxFrais": [
        {"numero": "FRAIS_JDO_2024_001", "consultantId": "jdo", "annee": 2024, "seq": 1,
         "statut": "en saisie", "datePaiement": None},
    ],
    "notesFrais": [
        {"id": "NF-1", "date": "2024-01-20", "consultantId": "jdo", "affaireId": "A-1",
         "categorieTempsInterne": None, "categorieFraisId": "1", "refacturable": True,
         "numeroBordereau": "FRAIS_JDO_2024_001", "lignesTVA": [{"tauxTVA": 20, "montantHT": 100, "montantTVA": 20}],
         "commentaire": ""},
    ],
}


def _create_v1_db(db_path: Path, state: dict, revision: int = 7, user_version: int = 1) -> None:
    """Reproduit le schéma minimal V1 pertinent pour l'export (server.py:182-194)."""
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE app_state (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                revision INTEGER NOT NULL,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                updated_by INTEGER NULL
            )
            """
        )
        raw = json.dumps(state, ensure_ascii=False)
        conn.execute(
            "INSERT INTO app_state(singleton, revision, state_json, updated_at, updated_by) "
            "VALUES (1, ?, ?, ?, NULL)",
            (revision, raw, "2024-01-01T00:00:00Z"),
        )
        conn.execute(f"PRAGMA user_version={user_version}")
        conn.commit()
    finally:
        conn.close()


class ExportV1FormatTest(unittest.TestCase):
    """Vérifie le format de sortie exact attendu par v1-import.js."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "piloteo.sqlite3"
        _create_v1_db(self.db_path, DEMO_STATE, revision=7, user_version=1)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_output_has_exact_top_level_keys(self):
        conn = export_v1.open_readonly(self.db_path)
        try:
            schema_version, revision, state = export_v1.read_v1_state(conn)
        finally:
            conn.close()
        export_obj = export_v1.build_export(schema_version, revision, state, exported_at="2026-08-30T00:00:00Z")

        self.assertEqual(
            set(export_obj.keys()),
            {"format", "schemaVersion", "exportedAt", "revision", "state"},
        )
        self.assertEqual(export_obj["format"], "piloteo-v1-export")
        self.assertEqual(export_obj["schemaVersion"], 1)
        self.assertEqual(export_obj["revision"], 7)
        self.assertEqual(export_obj["exportedAt"], "2026-08-30T00:00:00Z")

    def test_state_has_all_12_collections(self):
        conn = export_v1.open_readonly(self.db_path)
        try:
            _, _, state = export_v1.read_v1_state(conn)
        finally:
            conn.close()
        self.assertEqual(set(state.keys()), set(ALL_COLLECTIONS))
        for name in ALL_COLLECTIONS:
            self.assertIsInstance(state[name], list)

    def test_state_content_matches_source_exactly(self):
        conn = export_v1.open_readonly(self.db_path)
        try:
            _, _, state = export_v1.read_v1_state(conn)
        finally:
            conn.close()
        self.assertEqual(state, DEMO_STATE)

    def test_bordereaux_frais_identified_by_numero(self):
        conn = export_v1.open_readonly(self.db_path)
        try:
            _, _, state = export_v1.read_v1_state(conn)
        finally:
            conn.close()
        bordereau = state["bordereauxFrais"][0]
        self.assertIn("numero", bordereau)
        self.assertNotIn("id", bordereau)
        self.assertEqual(bordereau["numero"], "FRAIS_JDO_2024_001")

    def test_missing_collection_defaults_to_empty_list(self):
        partial_state = {k: v for k, v in DEMO_STATE.items() if k != "notesFrais"}
        db2 = Path(self.tmpdir.name) / "partial.sqlite3"
        _create_v1_db(db2, partial_state, revision=1, user_version=1)
        conn = export_v1.open_readonly(db2)
        try:
            _, _, state = export_v1.read_v1_state(conn)
        finally:
            conn.close()
        self.assertEqual(state["notesFrais"], [])

    def test_cli_end_to_end_via_subprocess(self):
        result = subprocess.run(
            [sys.executable, str(EXPORT_SCRIPT), "--db", str(self.db_path)],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["format"], "piloteo-v1-export")
        self.assertEqual(payload["revision"], 7)
        self.assertEqual(set(payload["state"].keys()), set(ALL_COLLECTIONS))
        self.assertEqual(payload["state"]["bordereauxFrais"][0]["numero"], "FRAIS_JDO_2024_001")

    def test_cli_writes_to_out_file(self):
        out_path = Path(self.tmpdir.name) / "export.json"
        result = subprocess.run(
            [sys.executable, str(EXPORT_SCRIPT), "--db", str(self.db_path), "--out", str(out_path)],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertTrue(out_path.exists())
        payload = json.loads(out_path.read_text(encoding="utf-8"))
        self.assertEqual(payload["format"], "piloteo-v1-export")
        self.assertEqual(payload["revision"], 7)

    def test_help_exits_zero(self):
        result = subprocess.run(
            [sys.executable, str(EXPORT_SCRIPT), "--help"],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("--db", result.stdout)
        self.assertIn("--out", result.stdout)


class ExportV1ReadOnlyGuaranteeTest(unittest.TestCase):
    """La base source ne doit JAMAIS être modifiée par un export."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "piloteo.sqlite3"
        _create_v1_db(self.db_path, DEMO_STATE, revision=42, user_version=1)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_db_bytes_unchanged_after_export(self):
        before_bytes = self.db_path.read_bytes()
        before_mtime = self.db_path.stat().st_mtime_ns

        result = subprocess.run(
            [sys.executable, str(EXPORT_SCRIPT), "--db", str(self.db_path)],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)

        after_bytes = self.db_path.read_bytes()
        after_mtime = self.db_path.stat().st_mtime_ns
        self.assertEqual(before_bytes, after_bytes, "le contenu de la base a changé après export")
        self.assertEqual(before_mtime, after_mtime, "le mtime de la base a changé après export")

    def test_db_row_content_unchanged_after_export(self):
        result = subprocess.run(
            [sys.executable, str(EXPORT_SCRIPT), "--db", str(self.db_path)],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)

        conn = sqlite3.connect(self.db_path)
        try:
            row = conn.execute("SELECT revision, state_json FROM app_state WHERE singleton=1").fetchone()
            uv = conn.execute("PRAGMA user_version").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(row[0], 42)
        self.assertEqual(json.loads(row[1]), DEMO_STATE)
        self.assertEqual(uv, 1)

    def test_connection_opened_readonly_rejects_write(self):
        conn = export_v1.open_readonly(self.db_path)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("UPDATE app_state SET revision=999 WHERE singleton=1")
        finally:
            conn.close()

    def test_multiple_exports_do_not_accumulate_changes(self):
        for _ in range(3):
            result = subprocess.run(
                [sys.executable, str(EXPORT_SCRIPT), "--db", str(self.db_path)],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, msg=result.stderr)
        conn = sqlite3.connect(self.db_path)
        try:
            row = conn.execute("SELECT revision FROM app_state WHERE singleton=1").fetchone()
        finally:
            conn.close()
        self.assertEqual(row[0], 42)


class ExportV1ErrorHandlingTest(unittest.TestCase):
    """Base absente / illisible / vide -> échec propre, code retour non nul."""

    def test_missing_db_file_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "does-not-exist.sqlite3"
            result = subprocess.run(
                [sys.executable, str(EXPORT_SCRIPT), "--db", str(missing)],
                capture_output=True, text=True, timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("introuvable", result.stderr.lower())
            self.assertEqual(result.stdout.strip(), "")

    def test_non_sqlite_file_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as tmp:
            bogus = Path(tmp) / "not-a-db.sqlite3"
            bogus.write_text("ceci n'est pas une base sqlite", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(EXPORT_SCRIPT), "--db", str(bogus)],
                capture_output=True, text=True, timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertNotEqual(result.stderr.strip(), "")

    def test_empty_app_state_table_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "empty.sqlite3"
            conn = sqlite3.connect(db_path)
            try:
                conn.execute(
                    "CREATE TABLE app_state (singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL, "
                    "state_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by INTEGER)"
                )
                conn.commit()
            finally:
                conn.close()
            result = subprocess.run(
                [sys.executable, str(EXPORT_SCRIPT), "--db", str(db_path)],
                capture_output=True, text=True, timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)

    def test_directory_as_db_path_fails_cleanly(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run(
                [sys.executable, str(EXPORT_SCRIPT), "--db", tmp],
                capture_output=True, text=True, timeout=30,
            )
            self.assertNotEqual(result.returncode, 0)


class ExportV1NanInfinityTest(unittest.TestCase):
    """Dette V1 (V1_DOMAIN_MAP.md §7) : NaN/Infinity refusés par défaut."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmpdir.name) / "piloteo.sqlite3"
        state_with_nan = json.loads(json.dumps(DEMO_STATE))  # copie profonde
        # Injecte une valeur NaN, comme le ferait un client V1 hérité
        # (json.dumps stdlib sans allow_nan=False) — cf. V1_DOMAIN_MAP.md §7.
        state_with_nan["missions"][0]["taux"] = float("nan")
        raw = json.dumps(state_with_nan, ensure_ascii=False, allow_nan=True)

        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute(
                "CREATE TABLE app_state (singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL, "
                "state_json TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by INTEGER)"
            )
            conn.execute(
                "INSERT INTO app_state(singleton, revision, state_json, updated_at, updated_by) "
                "VALUES (1, 1, ?, '2024-01-01T00:00:00Z', NULL)",
                (raw,),
            )
            conn.execute("PRAGMA user_version=1")
            conn.commit()
        finally:
            conn.close()

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_export_refuses_nan_by_default(self):
        result = subprocess.run(
            [sys.executable, str(EXPORT_SCRIPT), "--db", str(self.db_path)],
            capture_output=True, text=True, timeout=30,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "")

    def test_export_allows_nan_with_flag(self):
        result = subprocess.run(
            [sys.executable, str(EXPORT_SCRIPT), "--db", str(self.db_path), "--allow-nan"],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("NaN", result.stdout)

    def test_find_non_finite_detects_nan_and_infinity(self):
        self.assertIsNotNone(export_v1._find_non_finite({"a": float("nan")}))
        self.assertIsNotNone(export_v1._find_non_finite({"a": [1, float("inf")]}))
        self.assertIsNotNone(export_v1._find_non_finite({"a": {"b": float("-inf")}}))
        self.assertIsNone(export_v1._find_non_finite({"a": [1, 2.5, "x", None, True]}))


if __name__ == "__main__":
    unittest.main()
