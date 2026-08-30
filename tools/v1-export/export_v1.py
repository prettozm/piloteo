#!/usr/bin/env python3
"""export_v1.py — Export canonique de l'état Pilotéo V1, en LECTURE SEULE.

Contexte : docs/next/03_MIGRATION_V1_VERS_LOCAL_FIRST.md (Phase 9),
consommé par `src/migration/v1-import.js` (`importV1`), qui attend en
entrée un objet :

    {
      "format": "piloteo-v1-export",
      "schemaVersion": <int>,   // PRAGMA user_version de la base V1
      "exportedAt": <ISO-8601 UTC>,
      "revision": <int>,        // app_state.revision au moment de l'export
      "state": { ...12 collections V1... }
    }

Ce script est un utilitaire AUTONOME, hors du serveur V1 (`server.py`,
non modifié). Il n'écrit JAMAIS dans la base SQLite V1 :

  - Ouverture SQLite en mode lecture seule STRICT via l'URI SQLite
    `file:<chemin>?mode=ro` (paramètre `uri=True` de `sqlite3.connect`) :
    toute tentative d'écriture échouerait avec `sqlite3.OperationalError:
    attempt to write a readonly database` — c'est le système de fichiers/
    SQLite qui l'impose, pas seulement une discipline de code.
  - Aucun `INSERT`/`UPDATE`/`CREATE`/`PRAGMA <x>=<y>` n'est jamais exécuté.
    Les seules requêtes émises sont des `SELECT`/`PRAGMA <x>` (lecture).
  - Le script peut tourner alors même que le serveur V1 (`server.py`) est
    éteint : il lit directement le fichier `.sqlite3`, sans passer par
    l'API HTTP.

Schéma V1 lu (cf. server.py:182-194, V1_DOMAIN_MAP.md §1) :

    CREATE TABLE app_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,   -- JSON à plat des 12 collections
        updated_at TEXT NOT NULL,
        updated_by INTEGER NULL REFERENCES users(id)
    );

`state_json` contient, à la racine, directement les 12 collections
listées dans `COLLECTION_KEYS` (server.py:63-76 / V1_DOMAIN_MAP.md §1) —
pas d'enveloppe supplémentaire. C'est ce dict qui devient la clé `state`
de l'export.

Dette V1 (V1_DOMAIN_MAP.md §7) : la V1 sérialise son JSON sans
`allow_nan=False`, donc NaN/Infinity/-Infinity peuvent en théorie se
trouver dans `state_json` si un client V1 en a un jour écrit. Le
local-first ne doit PAS reproduire cette dette : cet export DÉTECTE de
telles valeurs et refuse d'émettre un JSON non standard par défaut (code
retour non nul, message explicite) ; `--allow-nan` permet un export de
secours (diagnostic/débogage) qui les sérialise quand même en JSON non
standard (NaN/Infinity, tel que `json.dumps` stdlib le ferait), à
n'utiliser qu'en connaissance de cause — jamais pour alimenter
`v1-import.js` en production.

Usage :

    python3 tools/v1-export/export_v1.py --db data/piloteo.sqlite3
    python3 tools/v1-export/export_v1.py --db data/piloteo.sqlite3 --out export.json
    python3 tools/v1-export/export_v1.py --help
"""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

# Doit rester IDENTIQUE à COLLECTION_KEYS (server.py:63-76) / ENTITY_TYPES
# (src/events/event-schema.js) / V1_DOMAIN_MAP.md §1 — les 12 collections
# canoniques V1, avec leur clé d'identité (documentée ici pour mémoire ;
# l'export lui-même n'a pas besoin de la clé, seulement de la liste des
# noms de collection).
COLLECTION_KEYS = {
    "consultants": "id",
    "organisations": "id",
    "affaires": "id",
    "methodes": "id",
    "typesTerritoire": "id",
    "domainesIntervention": "id",
    "categoriesFrais": "id",
    "missions": "id",
    "factures": "id",
    "saisies": "id",
    "bordereauxFrais": "numero",
    "notesFrais": "id",
}

EXPORT_FORMAT = "piloteo-v1-export"
DEFAULT_SCHEMA_VERSION = 1  # repli si PRAGMA user_version vaut 0 (base jamais initialisée par server.py)


class ExportError(RuntimeError):
    """Erreur d'export propre (message utilisateur + code retour non nul)."""


def _iso_now_utc() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _find_non_finite(value, path="state"):
    """Parcourt récursivement `value` et retourne le chemin de la première
    valeur float NaN/Infinity/-Infinity rencontrée, ou None si aucune.

    Sert à détecter la dette V1 documentée en V1_DOMAIN_MAP.md §7 (le
    `json` de la V1 accepte NaN/Infinity faute de `allow_nan=False`).
    """
    if isinstance(value, float) and not math.isfinite(value):
        return path
    if isinstance(value, dict):
        for k, v in value.items():
            found = _find_non_finite(v, f"{path}.{k}")
            if found:
                return found
    elif isinstance(value, list):
        for i, v in enumerate(value):
            found = _find_non_finite(v, f"{path}[{i}]")
            if found:
                return found
    return None


def open_readonly(db_path: Path) -> sqlite3.Connection:
    """Ouvre `db_path` en lecture seule STRICTE (URI SQLite mode=ro).

    Toute écriture ultérieure sur cette connexion échoue au niveau SQLite
    lui-même (OperationalError), indépendamment de ce que fait le code
    Python appelant.
    """
    if not db_path.exists():
        raise ExportError(f"Base introuvable : {db_path}")
    if not db_path.is_file():
        raise ExportError(f"Chemin de base invalide (pas un fichier) : {db_path}")

    uri = f"file:{db_path.as_posix()}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.OperationalError as exc:
        raise ExportError(f"Impossible d'ouvrir la base en lecture seule ({db_path}) : {exc}") from exc

    conn.row_factory = sqlite3.Row
    try:
        # Vérification légère que le fichier est bien une base SQLite lisible
        # (échouerait ici, jamais lors d'une écriture, puisqu'on ne lit qu'un
        # PRAGMA et un SELECT plus bas).
        conn.execute("PRAGMA schema_version").fetchone()
    except sqlite3.DatabaseError as exc:
        conn.close()
        raise ExportError(f"Fichier illisible ou corrompu, pas une base SQLite valide : {db_path} ({exc})") from exc

    return conn


def read_v1_state(conn: sqlite3.Connection) -> tuple[int, int, dict]:
    """Lit l'état applicatif V1 le plus récent, sans écrire.

    Retourne (schema_version, revision, state_dict).
    """
    try:
        schema_row = conn.execute("PRAGMA user_version").fetchone()
    except sqlite3.DatabaseError as exc:
        raise ExportError(f"Lecture de PRAGMA user_version impossible : {exc}") from exc
    schema_version = int(schema_row[0]) if schema_row and schema_row[0] else DEFAULT_SCHEMA_VERSION

    try:
        row = conn.execute(
            "SELECT revision, state_json FROM app_state WHERE singleton=1"
        ).fetchone()
    except sqlite3.OperationalError as exc:
        raise ExportError(
            f"Table 'app_state' introuvable ou inattendue — base V1 valide ? ({exc})"
        ) from exc

    if row is None:
        raise ExportError(
            "Aucun état applicatif trouvé (table 'app_state' vide) — "
            "la base n'a jamais été initialisée par server.py."
        )

    revision = int(row["revision"])
    try:
        raw_state = json.loads(row["state_json"])
    except json.JSONDecodeError as exc:
        raise ExportError(f"state_json illisible (JSON invalide) en base : {exc}") from exc

    if not isinstance(raw_state, dict):
        raise ExportError("state_json ne contient pas un objet JSON à la racine.")

    # On ne conserve que les 12 collections canoniques, dans un ordre stable ;
    # une collection absente de la base (schéma V1 antérieur/tronqué) est
    # exportée comme liste vide plutôt que de faire échouer tout l'export.
    state = {}
    for name in COLLECTION_KEYS:
        collection = raw_state.get(name, [])
        if not isinstance(collection, list):
            raise ExportError(
                f"Collection '{name}' inattendue dans state_json (attendu une liste, "
                f"reçu {type(collection).__name__})."
            )
        state[name] = collection

    return schema_version, revision, state


def build_export(schema_version: int, revision: int, state: dict, exported_at: str | None = None) -> dict:
    return {
        "format": EXPORT_FORMAT,
        "schemaVersion": schema_version,
        "exportedAt": exported_at or _iso_now_utc(),
        "revision": revision,
        "state": state,
    }


def serialize(export_obj: dict, allow_nan: bool) -> str:
    """Sérialise l'export en JSON. Par défaut (allow_nan=False), refuse et
    lève ExportError si `state` contient des NaN/Infinity/-Infinity — la
    dette V1 documentée (V1_DOMAIN_MAP.md §7) ne doit pas se propager au
    format d'export canonique. `--allow-nan` permet un export non standard
    de secours (diagnostic uniquement).
    """
    if not allow_nan:
        bad_path = _find_non_finite(export_obj["state"])
        if bad_path:
            raise ExportError(
                "Valeur JSON non standard (NaN/Infinity/-Infinity) détectée dans "
                f"{bad_path} — export refusé (dette V1, cf. V1_DOMAIN_MAP.md §7). "
                "Relancer avec --allow-nan pour forcer un export de secours non standard."
            )
    # json.dumps stdlib : allow_nan=True par défaut (comportement V1 hérité,
    # utilisé volontairement seulement quand --allow-nan est demandé) ;
    # allow_nan=False fait lever ValueError si jamais une valeur passait au
    # travers de la détection ci-dessus (filet de sécurité).
    return json.dumps(export_obj, ensure_ascii=False, indent=2, allow_nan=allow_nan, sort_keys=False)


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="export_v1.py",
        description=(
            "Exporte l'état canonique Pilotéo V1 (table app_state) en JSON "
            "consommable par src/migration/v1-import.js. Ouvre la base SQLite "
            "STRICTEMENT en lecture seule (file:...?mode=ro) : n'altère jamais "
            "la base V1, et fonctionne même si le serveur V1 n'est pas démarré."
        ),
        epilog=(
            "Exemple :\n"
            "  python3 tools/v1-export/export_v1.py --db data/piloteo.sqlite3 --out export.json\n"
            "  node -e \"import('./src/migration/v1-import.js').then(...)\"  # cf. tools/v1-export/README.md\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--db",
        required=True,
        metavar="CHEMIN",
        help="Chemin vers la base SQLite V1 (ex. data/piloteo.sqlite3). Ouverte en lecture seule.",
    )
    parser.add_argument(
        "--out",
        metavar="FICHIER",
        help="Fichier de sortie JSON. Par défaut : stdout.",
    )
    parser.add_argument(
        "--allow-nan",
        action="store_true",
        help=(
            "Autorise l'export même si des valeurs NaN/Infinity/-Infinity sont "
            "présentes dans l'état (JSON non standard, dette V1 — cf. "
            "V1_DOMAIN_MAP.md §7). Sans cette option, un tel export est refusé."
        ),
    )
    args = parser.parse_args(argv)

    db_path = Path(args.db)
    conn = None
    try:
        conn = open_readonly(db_path)
        schema_version, revision, state = read_v1_state(conn)
        export_obj = build_export(schema_version, revision, state)
        payload = serialize(export_obj, allow_nan=args.allow_nan)
    except ExportError as exc:
        print(f"export_v1.py: erreur : {exc}", file=sys.stderr)
        return 1
    finally:
        if conn is not None:
            conn.close()

    if args.out:
        out_path = Path(args.out)
        out_path.write_text(payload + "\n", encoding="utf-8")
        print(f"Export écrit : {out_path} (revision={revision}, "
              f"{sum(len(v) for v in state.values())} entités)", file=sys.stderr)
    else:
        print(payload)

    return 0


if __name__ == "__main__":
    sys.exit(run())
