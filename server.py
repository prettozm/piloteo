#!/usr/bin/env python3
"""Pilotéo V1 — minimal multi-user server (Python stdlib + SQLite).

The browser UI remains the functional application. This server adds the parts that
must not live in the browser: authentication, authorization, durable state,
optimistic synchronization, audit trail and backups.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import html
import ipaddress
import json
import mimetypes
import os
import secrets
import shutil
import signal
import sqlite3
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone, timedelta
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("PILOTEO_DATA_DIR", ROOT / "data")).resolve()
DB_PATH = DATA_DIR / "piloteo.sqlite3"
BACKUP_DIR = Path(os.environ.get("PILOTEO_BACKUP_DIR", DATA_DIR / "backups")).resolve()
HOST = os.environ.get("PILOTEO_HOST", "0.0.0.0")
PORT = int(os.environ.get("PILOTEO_PORT", "8080"))
SESSION_HOURS = int(os.environ.get("PILOTEO_SESSION_HOURS", "12"))
FORCE_HTTPS = os.environ.get("PILOTEO_FORCE_HTTPS", "0").lower() in {"1", "true", "yes"}
PBKDF2_ITERATIONS = int(os.environ.get("PILOTEO_PBKDF2_ITERATIONS", "600000"))
HISTORY_LIMIT = int(os.environ.get("PILOTEO_HISTORY_LIMIT", "100"))
BACKUP_RETENTION = int(os.environ.get("PILOTEO_BACKUP_RETENTION", "30"))
SESSION_COOKIE = "piloteo_session"
SCHEMA_VERSION = 1
APP_VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip() if (ROOT / "VERSION").exists() else "dev"

# Marque affichée dans l'interface (white-label) : chaque client déploie avec
# son propre nom via PILOTEO_ORG_NAME et, s'il le souhaite, son logo déposé
# dans <PILOTEO_DATA_DIR>/branding/logo.(svg|png|jpg) — sinon logo neutre.
ORG_NAME = os.environ.get("PILOTEO_ORG_NAME", "Pilotéo").strip() or "Pilotéo"

# X-Forwarded-For n'est cru que si le pair TCP direct est un proxy de confiance.
# Par défaut : boucle locale et plages privées, car le contrat de déploiement est
# « port 8080 jamais publié ailleurs que sur 127.0.0.1, derrière le proxy HTTPS ».
# Si Pilotéo devait être exposé directement, mettre PILOTEO_TRUSTED_PROXIES à vide.
_DEFAULT_TRUSTED_PROXIES = "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
TRUSTED_PROXIES = [
    ipaddress.ip_network(part.strip())
    for part in os.environ.get("PILOTEO_TRUSTED_PROXIES", _DEFAULT_TRUSTED_PROXIES).split(",")
    if part.strip()
]

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
ADMIN_ONLY = {
    "consultants", "organisations", "methodes", "typesTerritoire",
    "domainesIntervention", "categoriesFrais", "factures",
}

_DB_INIT_LOCK = threading.Lock()
_LOGIN_ATTEMPTS: dict[str, deque[float]] = defaultdict(deque)
_LOGIN_LOCK = threading.Lock()
_LAST_BACKUP_DAY = None
_BACKUP_LOCK = threading.Lock()
_BACKUP_DAY_LOCK = threading.Lock()


def log(message: str) -> None:
    print(f"{iso_now()} {message}", flush=True)


def is_trusted_proxy(peer_ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(peer_ip)
    except ValueError:
        return False
    return any(addr in net for net in TRUSTED_PROXIES)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utcnow().isoformat(timespec="seconds")


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def hash_password(password: str, salt: bytes | None = None, iterations: int = PBKDF2_ITERATIONS) -> tuple[str, str, int]:
    if salt is None:
        salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return base64.b64encode(salt).decode(), base64.b64encode(digest).decode(), iterations


def verify_password(password: str, salt_b64: str, hash_b64: str, iterations: int) -> bool:
    salt = base64.b64decode(salt_b64)
    expected = base64.b64decode(hash_b64)
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# Empreinte factice vérifiée quand l'identifiant n'existe pas, pour que la durée
# de la réponse ne révèle pas si un compte existe (énumération par mesure de temps).
_DUMMY_SALT, _DUMMY_HASH, _DUMMY_ITERATIONS = hash_password(secrets.token_urlsafe(24))


def load_seed() -> dict:
    path = ROOT / "seed.json"
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        data = {k: [] for k in COLLECTION_KEYS}
    for k in COLLECTION_KEYS:
        data.setdefault(k, [])
    return data


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    with _DB_INIT_LOCK:
        conn = db_connect()
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    display_name TEXT NOT NULL,
                    consultant_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('user','admin')) DEFAULT 'user',
                    password_salt TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    password_iterations INTEGER NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    csrf_token TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    last_seen TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS app_state (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    revision INTEGER NOT NULL,
                    state_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    updated_by INTEGER NULL REFERENCES users(id)
                );
                CREATE TABLE IF NOT EXISTS state_history (
                    revision INTEGER PRIMARY KEY,
                    state_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    created_by INTEGER NULL REFERENCES users(id)
                );
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    user_id INTEGER NULL REFERENCES users(id),
                    username TEXT,
                    action TEXT NOT NULL,
                    target TEXT,
                    detail TEXT,
                    ip TEXT
                );
                """
            )
            db_version = conn.execute("PRAGMA user_version").fetchone()[0]
            if db_version > SCHEMA_VERSION:
                raise RuntimeError(
                    f"La base ({db_version}) est plus récente que ce serveur ({SCHEMA_VERSION}). "
                    "Mettre à jour le code avant de démarrer."
                )
            # Emplacement des futures migrations : appliquer ici chaque palier
            # db_version -> db_version+1 avant de tamponner la version courante.
            if db_version < SCHEMA_VERSION:
                conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            row = conn.execute("SELECT revision FROM app_state WHERE singleton=1").fetchone()
            if not row:
                seed = load_seed()
                now = iso_now()
                raw = json.dumps(seed, ensure_ascii=False, separators=(",", ":"))
                conn.execute("INSERT INTO app_state(singleton,revision,state_json,updated_at,updated_by) VALUES(1,1,?,?,NULL)", (raw, now))
                conn.execute("INSERT OR REPLACE INTO state_history(revision,state_json,created_at,created_by) VALUES(1,?,?,NULL)", (raw, now))
            ensure_bootstrap_admin(conn)
            conn.execute("DELETE FROM sessions WHERE expires_at < ?", (iso_now(),))
        finally:
            conn.close()


def ensure_bootstrap_admin(conn: sqlite3.Connection) -> None:
    count = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    if count:
        return
    username = os.environ.get("PILOTEO_ADMIN_USERNAME", "").strip()
    password = os.environ.get("PILOTEO_ADMIN_PASSWORD", "")
    consultant_id = os.environ.get("PILOTEO_ADMIN_CONSULTANT_ID", "").strip()
    display_name = os.environ.get("PILOTEO_ADMIN_NAME", "Administrateur Pilotéo").strip()
    if not username or not password or not consultant_id:
        raise RuntimeError(
            "Première initialisation: définir PILOTEO_ADMIN_USERNAME, PILOTEO_ADMIN_PASSWORD "
            "et PILOTEO_ADMIN_CONSULTANT_ID. Aucun mot de passe par défaut n'est créé."
        )
    if len(password) < 12:
        raise RuntimeError("PILOTEO_ADMIN_PASSWORD doit contenir au moins 12 caractères.")
    salt, digest, iterations = hash_password(password)
    now = iso_now()
    cur = conn.execute(
        "INSERT INTO users(username,display_name,consultant_id,role,password_salt,password_hash,password_iterations,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (username, display_name, consultant_id, "admin", salt, digest, iterations, 1, now, now),
    )
    user_id = cur.lastrowid
    row = conn.execute("SELECT revision,state_json FROM app_state WHERE singleton=1").fetchone()
    state = json.loads(row["state_json"])
    consultant = next((c for c in state.get("consultants", []) if str(c.get("id")) == consultant_id), None)
    if consultant is None:
        state["consultants"].append({
            "id": consultant_id, "nom": display_name, "trigramme": consultant_id[:3].upper(),
            "dateEmbauche": utcnow().date().isoformat(), "dateDepart": None, "tjmBase": 0,
            "admin": True, "statut": "en poste", "tempsPartiel": []
        })
    else:
        consultant["admin"] = True
    raw = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    new_rev = int(row["revision"]) + 1
    conn.execute("UPDATE app_state SET revision=?,state_json=?,updated_at=?,updated_by=? WHERE singleton=1", (new_rev, raw, now, user_id))
    conn.execute("INSERT INTO state_history(revision,state_json,created_at,created_by) VALUES(?,?,?,?)", (new_rev, raw, now, user_id))
    audit(conn, user_id, username, "bootstrap_admin", consultant_id, "Premier compte administrateur créé", "local")


def audit(conn: sqlite3.Connection, user_id, username, action: str, target: str | None, detail: str | None, ip: str | None) -> None:
    conn.execute(
        "INSERT INTO audit_log(created_at,user_id,username,action,target,detail,ip) VALUES(?,?,?,?,?,?,?)",
        (iso_now(), user_id, username, action, target, detail, ip),
    )


def user_public(row: sqlite3.Row | dict, include_csrf: str | None = None) -> dict:
    d = dict(row)
    out = {
        "id": d["id"], "username": d["username"], "display_name": d["display_name"],
        "consultant_id": d["consultant_id"], "role": d["role"], "active": bool(d["active"]),
    }
    if include_csrf:
        out["csrf_token"] = include_csrf
    return out


def is_admin(user: sqlite3.Row | dict) -> bool:
    return dict(user).get("role") == "admin"


def affair_ids_for_user(state: dict, cid: str) -> tuple[set[str], set[str]]:
    missions = state.get("missions", [])
    own_mission_affairs = {str(m.get("affaireId")) for m in missions if str(m.get("consultantId")) == cid}
    related, piloted = set(), set()
    for a in state.get("affaires", []):
        aid = str(a.get("id"))
        rep = a.get("repartitionCommerciale") or []
        if str(a.get("pilote")) == cid:
            piloted.add(aid)
            related.add(aid)
        if str(a.get("piloteCommercial")) == cid or any(str(r.get("consultantId")) == cid for r in rep) or aid in own_mission_affairs:
            related.add(aid)
    return related, piloted


def filter_state(full: dict, user: sqlite3.Row | dict) -> dict:
    if is_admin(user):
        return json.loads(json.dumps(full))
    cid = str(dict(user)["consultant_id"])
    related, piloted = affair_ids_for_user(full, cid)
    missions = full.get("missions", [])
    visible_mission_ids = {
        str(m.get("id")) for m in missions
        if str(m.get("consultantId")) == cid or str(m.get("affaireId")) in piloted
    }
    visible_affaires = [a for a in full.get("affaires", []) if str(a.get("id")) in related]
    org_ids = set()
    for a in visible_affaires:
        if a.get("organisationId") is not None:
            org_ids.add(str(a.get("organisationId")))
        for p in (a.get("partenaires") or []):
            if p.get("organisationId") is not None:
                org_ids.add(str(p.get("organisationId")))
    visible = {
        "consultants": [],
        "organisations": [o for o in full.get("organisations", []) if str(o.get("id")) in org_ids],
        "affaires": visible_affaires,
        "methodes": full.get("methodes", []),
        "typesTerritoire": full.get("typesTerritoire", []),
        "domainesIntervention": full.get("domainesIntervention", []),
        "categoriesFrais": full.get("categoriesFrais", []),
        "missions": [m for m in missions if str(m.get("id")) in visible_mission_ids],
        "factures": [f for f in full.get("factures", []) if str(f.get("affaireId")) in piloted],
        "saisies": [],
        "bordereauxFrais": [b for b in full.get("bordereauxFrais", []) if str(b.get("consultantId")) == cid],
        "notesFrais": [n for n in full.get("notesFrais", []) if str(n.get("consultantId")) == cid or str(n.get("affaireId")) in piloted],
    }
    for c in full.get("consultants", []):
        if str(c.get("id")) == cid:
            visible["consultants"].append(c)
        else:
            visible["consultants"].append({
                "id": c.get("id"), "nom": c.get("nom"), "trigramme": c.get("trigramme"),
                "statut": c.get("statut"), "admin": False, "tjmBase": 0,
                "dateEmbauche": c.get("dateEmbauche") or "1900-01-01", "dateDepart": c.get("dateDepart"),
                "tempsPartiel": [],
            })
    mission_by_id = {str(m.get("id")): m for m in missions}
    for s in full.get("saisies", []):
        own = str(s.get("consultantId")) == cid
        m = mission_by_id.get(str(s.get("missionId")))
        on_piloted = bool(m and str(m.get("affaireId")) in piloted)
        if own or on_piloted:
            visible["saisies"].append(s)
    return json.loads(json.dumps(visible))


def entity_map(items: list, key: str) -> dict[str, dict]:
    return {str(x.get(key)): x for x in items if isinstance(x, dict) and x.get(key) is not None}


def diff_collection(base: list, client: list, key: str) -> list[tuple[str, str, dict | None, dict | None]]:
    b = entity_map(base, key)
    c = entity_map(client, key)
    changes = []
    for ident in sorted(set(b) | set(c)):
        if ident not in b:
            changes.append(("add", ident, None, c[ident]))
        elif ident not in c:
            changes.append(("delete", ident, b[ident], None))
        elif b[ident] != c[ident]:
            changes.append(("update", ident, b[ident], c[ident]))
    return changes


def can_change(user: sqlite3.Row | dict, collection: str, op: str, old: dict | None, new: dict | None, current_state: dict) -> tuple[bool, str]:
    if is_admin(user):
        return True, ""
    cid = str(dict(user)["consultant_id"])
    if collection in ADMIN_ONLY:
        return False, "Réservé à un administrateur"
    candidate = new or old or {}
    if collection == "saisies":
        if op == "delete":
            return False, "La suppression d'une saisie n'est pas autorisée en V1"
        if str(candidate.get("consultantId")) != cid or (old and str(old.get("consultantId")) != cid):
            return False, "Un utilisateur ne peut modifier que ses propres saisies de temps"
        if candidate.get("type") == "mission":
            mission = next((m for m in current_state.get("missions", []) if str(m.get("id")) == str(candidate.get("missionId"))), None)
            if not mission or str(mission.get("consultantId")) != cid:
                return False, "La mission de la saisie n'est pas affectée à cet utilisateur"
        return True, ""
    if collection == "notesFrais":
        if op == "delete":
            return False, "La suppression d'un frais n'est pas autorisée en V1"
        if str(candidate.get("consultantId")) != cid or (old and str(old.get("consultantId")) != cid):
            return False, "Un utilisateur ne peut modifier que ses propres frais"
        if candidate.get("affaireId"):
            related, _ = affair_ids_for_user(current_state, cid)
            if str(candidate.get("affaireId")) not in related:
                return False, "Le frais ne peut pas être rattaché à une affaire hors du périmètre utilisateur"
        return True, ""
    if collection == "bordereauxFrais":
        if op == "delete":
            return False, "La suppression d'une note de frais n'est pas autorisée en V1"
        if str(candidate.get("consultantId")) != cid or (old and str(old.get("consultantId")) != cid):
            return False, "Un utilisateur ne peut modifier que ses propres notes de frais"
        if new and new.get("statut") == "payée":
            return False, "Le paiement d'une note de frais est réservé à un administrateur"
        if old and new:
            allowed = {("en saisie", "en saisie"), ("en saisie", "note à payer"), ("note à payer", "note à payer")}
            if (old.get("statut"), new.get("statut")) not in allowed:
                return False, "Transition de statut de note de frais non autorisée"
            if new.get("datePaiement"):
                return False, "La date de paiement est réservée à un administrateur"
        return True, ""
    if collection in {"affaires", "missions"}:
        if op == "add" and collection == "affaires":
            return False, "La création d'une affaire est réservée à un administrateur"
        affair_id = str(candidate.get("id")) if collection == "affaires" else str(candidate.get("affaireId"))
        affair = next((a for a in current_state.get("affaires", []) if str(a.get("id")) == affair_id), None)
        if not affair and collection == "missions" and new:
            affair = next((a for a in current_state.get("affaires", []) if str(a.get("id")) == str(new.get("affaireId"))), None)
        if not affair or str(affair.get("pilote")) != cid:
            return False, "Seul le pilote de l'affaire peut modifier l'affaire ou ses missions"
        if collection == "affaires" and new and str(new.get("pilote")) != cid:
            return False, "Le changement de pilote est réservé à un administrateur"
        return True, ""
    return False, "Modification non autorisée"


def merge_client_state(conn: sqlite3.Connection, user: sqlite3.Row, client_state: dict, base_revision: int, ip: str) -> tuple[int, dict, list[str]]:
    row = conn.execute("SELECT revision,state_json FROM app_state WHERE singleton=1").fetchone()
    current_revision = int(row["revision"])
    current_full = json.loads(row["state_json"])
    if base_revision == current_revision:
        base_full = current_full
    else:
        hist = conn.execute("SELECT state_json FROM state_history WHERE revision=?", (base_revision,)).fetchone()
        if not hist:
            raise SyncConflict(["Historique de synchronisation trop ancien"])
        base_full = json.loads(hist["state_json"])
    base_visible = filter_state(base_full, user)
    changed_summary = []
    conflicts = []
    full = json.loads(json.dumps(current_full))

    for collection, key in COLLECTION_KEYS.items():
        base_items = base_visible.get(collection, [])
        client_items = client_state.get(collection, [])
        if not isinstance(client_items, list):
            raise ValueError(f"Collection invalide: {collection}")
        changes = diff_collection(base_items, client_items, key)
        if not changes:
            continue
        full_map = entity_map(full.get(collection, []), key)
        base_full_map = entity_map(base_full.get(collection, []), key)
        for op, ident, old_visible, new_visible in changes:
            old_full_at_base = base_full_map.get(ident)
            current_entity = full_map.get(ident)
            if base_revision != current_revision and current_entity != old_full_at_base:
                conflicts.append(f"{collection}:{ident}")
                continue
            allowed, reason = can_change(user, collection, op, old_visible, new_visible, current_full)
            if not allowed:
                raise PermissionError(reason)
            if op == "delete":
                full_map.pop(ident, None)
            else:
                full_map[ident] = new_visible
            changed_summary.append(f"{collection}:{op}:{ident}")
        full[collection] = list(full_map.values())
    if conflicts:
        raise SyncConflict(conflicts)
    if not changed_summary:
        return current_revision, filter_state(current_full, user), []

    new_revision = current_revision + 1
    now = iso_now()
    raw = json.dumps(full, ensure_ascii=False, separators=(",", ":"))
    conn.execute("UPDATE app_state SET revision=?,state_json=?,updated_at=?,updated_by=? WHERE singleton=1", (new_revision, raw, now, user["id"]))
    conn.execute("INSERT INTO state_history(revision,state_json,created_at,created_by) VALUES(?,?,?,?)", (new_revision, raw, now, user["id"]))
    conn.execute(
        "DELETE FROM state_history WHERE revision NOT IN (SELECT revision FROM state_history ORDER BY revision DESC LIMIT ?)",
        (HISTORY_LIMIT,),
    )
    summary = ", ".join(changed_summary[:20]) + ("…" if len(changed_summary) > 20 else "")
    audit(conn, user["id"], user["username"], "state_update", f"revision:{new_revision}", summary, ip)
    return new_revision, filter_state(full, user), changed_summary


class SyncConflict(Exception):
    def __init__(self, conflicts: list[str]):
        super().__init__("Conflit de synchronisation")
        self.conflicts = conflicts


def backup_database(reason: str = "auto") -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = utcnow().strftime("%Y%m%d-%H%M%S")
    target = BACKUP_DIR / f"piloteo-{stamp}-{reason}.sqlite3"
    with _BACKUP_LOCK:
        src = db_connect()
        dst = sqlite3.connect(target)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        backups = sorted(BACKUP_DIR.glob("piloteo-*.sqlite3"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in backups[BACKUP_RETENTION:]:
            old.unlink(missing_ok=True)
    return target


def maybe_daily_backup() -> None:
    global _LAST_BACKUP_DAY
    day = utcnow().date().isoformat()
    with _BACKUP_DAY_LOCK:
        if _LAST_BACKUP_DAY == day:
            return
    try:
        target = backup_database("daily")
    except Exception as e:
        # Ne pas marquer le jour comme fait : la prochaine occasion retentera.
        log(f"ALERTE sauvegarde quotidienne échouée: {e!r}")
        return
    with _BACKUP_DAY_LOCK:
        _LAST_BACKUP_DAY = day
    log(f"sauvegarde quotidienne écrite: {target.name}")


def purge_expired_sessions() -> None:
    conn = db_connect()
    try:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (iso_now(),))
    finally:
        conn.close()


def housekeeping_loop(stop_event: threading.Event) -> None:
    """Sauvegarde quotidienne et purge des sessions, même sans aucune écriture métier."""
    while not stop_event.wait(timeout=3600):
        try:
            maybe_daily_backup()
            purge_expired_sessions()
        except Exception as e:
            log(f"housekeeping en échec: {e!r}")


def login_rate_limited(ip: str) -> bool:
    now = time.time()
    with _LOGIN_LOCK:
        # Purge des IP sans échec récent pour que la table ne grossisse pas indéfiniment.
        for stale in [k for k, q in _LOGIN_ATTEMPTS.items() if not q or now - q[-1] > 900]:
            _LOGIN_ATTEMPTS.pop(stale, None)
        q = _LOGIN_ATTEMPTS[ip]
        while q and now - q[0] > 900:
            q.popleft()
        return len(q) >= 10


def record_login_failure(ip: str) -> None:
    with _LOGIN_LOCK:
        if len(_LOGIN_ATTEMPTS) >= 10_000 and ip not in _LOGIN_ATTEMPTS:
            return  # borne dure : ne jamais laisser un scan distribué épuiser la mémoire
        _LOGIN_ATTEMPTS[ip].append(time.time())


def clear_login_failures(ip: str) -> None:
    with _LOGIN_LOCK:
        _LOGIN_ATTEMPTS.pop(ip, None)


def make_session(conn: sqlite3.Connection, user_id: int) -> tuple[str, str, str]:
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(24)
    now = utcnow()
    expires = now + timedelta(hours=SESSION_HOURS)
    conn.execute(
        "INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,last_seen,expires_at) VALUES(?,?,?,?,?,?)",
        (token_hash(token), user_id, csrf, now.isoformat(timespec="seconds"), now.isoformat(timespec="seconds"), expires.isoformat(timespec="seconds")),
    )
    return token, csrf, expires.isoformat(timespec="seconds")


def load_session(conn: sqlite3.Connection, token: str | None):
    if not token:
        return None, None
    row = conn.execute(
        "SELECT s.csrf_token,s.expires_at,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?",
        (token_hash(token),),
    ).fetchone()
    if not row or not row["active"] or row["expires_at"] < iso_now():
        if row:
            conn.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash(token),))
        return None, None
    conn.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (iso_now(), token_hash(token)))
    return row, row["csrf_token"]


class PilotHandler(BaseHTTPRequestHandler):
    server_version = "Piloteo/1.0"
    # Coupe les connexions qui n'envoient rien (slowloris) au lieu de bloquer un thread.
    timeout = 60

    def log_message(self, fmt, *args):
        # Keep standard access log but never bodies/passwords.
        log(f"{self.address_string()} - {fmt % args}")

    @property
    def client_ip(self) -> str:
        peer = self.client_address[0]
        if not is_trusted_proxy(peer):
            return peer
        # Dernier élément : celui ajouté par le proxy de confiance le plus proche.
        # Le premier élément est contrôlable par le client et ne doit jamais être cru.
        forwarded = self.headers.get("X-Forwarded-For", "").split(",")[-1].strip()
        return forwarded or peer

    def security_headers(self, cache: bool = False):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        # script-src sans 'unsafe-inline' : tout le JS est servi depuis /app.js
        # (aucun script inline, aucun gestionnaire on* dans le HTML). style-src
        # garde 'unsafe-inline' car l'UI utilise des attributs style= en ligne ;
        # ce n'est pas un vecteur d'exécution de script.
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.send_header("Cache-Control", "public, max-age=300" if cache else "no-store")
        if FORCE_HTTPS:
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

    def send_json(self, status: int, payload: dict, extra_headers: dict | None = None):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.security_headers(False)
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > 5_000_000:
            raise ValueError("Requête trop volumineuse")
        if length:
            # Un formulaire HTML cross-site ne peut pas envoyer application/json :
            # l'exiger ferme la voie « login CSRF » via enctype=text/plain.
            ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if ctype != "application/json":
                raise ValueError("Content-Type application/json requis")
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def session_token(self) -> str | None:
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def auth(self, require_admin: bool = False, require_csrf: bool = False):
        conn = db_connect()
        user, csrf = load_session(conn, self.session_token())
        if not user:
            conn.close()
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "Authentification requise"})
            return None
        if require_admin and not is_admin(user):
            conn.close()
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "Accès administrateur requis"})
            return None
        if require_csrf and not hmac.compare_digest(self.headers.get("X-CSRF-Token", ""), csrf or ""):
            conn.close()
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "Jeton de sécurité invalide"})
            return None
        return conn, user, csrf

    def _guarded(self, handler) -> None:
        # Un handler qui lève ne doit ni tuer la connexion sans réponse ni fuiter une trace.
        try:
            handler()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            log(f"erreur non gérée {self.command} {self.path}: {e!r}")
            try:
                self.send_json(500, {"error": "Erreur serveur"})
            except Exception:
                pass

    def do_GET(self):
        self._guarded(self._handle_get)

    def do_POST(self):
        self._guarded(self._handle_post)

    def do_PUT(self):
        self._guarded(self._handle_put)

    def do_PATCH(self):
        self._guarded(self._handle_patch)

    def _handle_get(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            try:
                conn = db_connect(); conn.execute("SELECT 1").fetchone(); conn.close()
                self.send_json(200, {"status": "ok", "version": APP_VERSION})
            except Exception:
                self.send_json(503, {"status": "error"})
            return
        if path == "/api/me":
            auth = self.auth()
            if not auth: return
            conn, user, csrf = auth
            try:
                self.send_json(200, {"user": user_public(user, csrf), "force_https": FORCE_HTTPS})
            finally: conn.close()
            return
        if path == "/api/state":
            auth = self.auth()
            if not auth: return
            conn, user, csrf = auth
            try:
                row = conn.execute("SELECT revision,state_json,updated_at FROM app_state WHERE singleton=1").fetchone()
                rev = int(row["revision"])
                try:
                    if_rev = int(parse_qs(parsed.query).get("if_revision", ["-1"])[0])
                except ValueError:
                    if_rev = -1
                if if_rev == rev:
                    self.send_json(200, {"revision": rev, "changed": False, "updated_at": row["updated_at"]})
                else:
                    state = filter_state(json.loads(row["state_json"]), user)
                    self.send_json(200, {"revision": rev, "changed": True, "state": state, "updated_at": row["updated_at"]})
            finally: conn.close()
            return
        if path == "/api/admin/users":
            auth = self.auth(require_admin=True)
            if not auth: return
            conn, user, csrf = auth
            try:
                rows = conn.execute("SELECT id,username,display_name,consultant_id,role,active,created_at,updated_at FROM users ORDER BY username").fetchall()
                self.send_json(200, {"users": [dict(r) | {"active": bool(r["active"])} for r in rows]})
            finally: conn.close()
            return
        if path == "/api/admin/audit":
            auth = self.auth(require_admin=True)
            if not auth: return
            conn, user, csrf = auth
            try:
                rows = conn.execute("SELECT created_at,username,action,target,detail,ip FROM audit_log ORDER BY id DESC LIMIT 200").fetchall()
                self.send_json(200, {"audit": [dict(r) for r in rows]})
            finally: conn.close()
            return
        if path in {"/support", "/support.html", "/support.js"}:
            auth = self.auth(require_admin=True)
            if not auth: return
            conn, user, csrf = auth
            conn.close()
            self.serve_file(ROOT / ("support.js" if path == "/support.js" else "support.html"),
                            cache=(path == "/support.js"))
            return
        if path in {"/", "/index.html"}:
            self.serve_file(ROOT / "index.html", template=True)
            return
        if path == "/app.js":
            self.serve_file(ROOT / "app.js", cache=True)
            return
        if path == "/local-backend.js":
            # Script du mode solo (Phase 2). Inerte tant que le mode solo n'est
            # pas activé côté client ; ne change pas le comportement serveur V1.
            self.serve_file(ROOT / "local-backend.js", cache=True)
            return
        if path == "/sw-solo.js":
            # Service worker du mode solo (offline). Non enregistré hors solo.
            self.serve_file(ROOT / "sw-solo.js", cache=True)
            return
        if path == "/brand-logo":
            # Logo du client s'il a été déposé sur le volume, sinon logo neutre.
            for candidate in (DATA_DIR / "branding" / "logo.svg",
                              DATA_DIR / "branding" / "logo.png",
                              DATA_DIR / "branding" / "logo.jpg",
                              ROOT / "assets" / "logo-default.svg"):
                if candidate.exists():
                    self.serve_file(candidate, cache=True)
                    return
            self.send_error(404)
            return
        if path == "/favicon.ico":
            # Pas d'icône dédiée : répondre 204 plutôt que 404 (évite du bruit
            # dans les logs, le navigateur la demande automatiquement).
            self.send_response(HTTPStatus.NO_CONTENT)
            self.security_headers(cache=True)
            self.end_headers()
            return
        self.send_error(404)

    def serve_file(self, path: Path, cache: bool = False, template: bool = False):
        if not path.exists():
            self.send_error(404); return
        raw = path.read_bytes()
        if template:
            raw = raw.replace(b"{{PILOTEO_ORG_NAME}}", html.escape(ORG_NAME).encode("utf-8"))
        self.send_response(200)
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix == ".js":
            ctype = "text/javascript; charset=utf-8"
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.security_headers(cache)
        self.end_headers()
        self.wfile.write(raw)

    def _handle_post(self):
        path = urlparse(self.path).path
        if path == "/api/login":
            if login_rate_limited(self.client_ip):
                self.send_json(429, {"error": "Trop de tentatives. Réessayez plus tard."}); return
            try:
                body = self.read_json()
                username = str(body.get("username", "")).strip()
                password = str(body.get("password", ""))
            except Exception:
                self.send_json(400, {"error": "Requête invalide"}); return
            conn = db_connect()
            try:
                user = conn.execute("SELECT * FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
                if user:
                    ok = bool(user["active"] and verify_password(password, user["password_salt"], user["password_hash"], int(user["password_iterations"])))
                else:
                    verify_password(password, _DUMMY_SALT, _DUMMY_HASH, _DUMMY_ITERATIONS)
                    ok = False
                if not ok:
                    record_login_failure(self.client_ip)
                    audit(conn, user["id"] if user else None, username, "login_failed", None, None, self.client_ip)
                    self.send_json(401, {"error": "Identifiant ou mot de passe incorrect"}); return
                clear_login_failures(self.client_ip)
                conn.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
                token, csrf, expires = make_session(conn, user["id"])
                audit(conn, user["id"], user["username"], "login", None, None, self.client_ip)
                cookie = f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_HOURS*3600}"
                if FORCE_HTTPS: cookie += "; Secure"
                self.send_json(200, {"user": user_public(user, csrf), "expires_at": expires}, {"Set-Cookie": cookie})
            finally: conn.close()
            return
        if path == "/api/logout":
            auth = self.auth(require_csrf=True)
            if not auth: return
            conn, user, csrf = auth
            try:
                conn.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash(self.session_token() or ""),))
                audit(conn, user["id"], user["username"], "logout", None, None, self.client_ip)
                cookie = f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
                if FORCE_HTTPS: cookie += "; Secure"
                self.send_json(200, {"ok": True}, {"Set-Cookie": cookie})
            finally: conn.close()
            return
        if path == "/api/admin/users":
            auth = self.auth(require_admin=True, require_csrf=True)
            if not auth: return
            conn, user, csrf = auth
            try:
                body = self.read_json()
                username = str(body.get("username", "")).strip()
                display_name = str(body.get("display_name", "")).strip()
                consultant_id = str(body.get("consultant_id", "")).strip()
                role = str(body.get("role", "user"))
                password = str(body.get("password", ""))
                if not username or not display_name or not consultant_id or role not in {"user","admin"} or len(password) < 12:
                    self.send_json(400, {"error": "Champs requis manquants ou mot de passe inférieur à 12 caractères"}); return
                state = json.loads(conn.execute("SELECT state_json FROM app_state WHERE singleton=1").fetchone()["state_json"])
                if not any(str(c.get("id")) == consultant_id for c in state.get("consultants", [])):
                    self.send_json(400, {"error": "Le consultant doit d'abord exister dans Pilotéo"}); return
                salt, digest, iterations = hash_password(password)
                now = iso_now()
                try:
                    cur = conn.execute("INSERT INTO users(username,display_name,consultant_id,role,password_salt,password_hash,password_iterations,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (username,display_name,consultant_id,role,salt,digest,iterations,1,now,now))
                except sqlite3.IntegrityError:
                    self.send_json(409, {"error": "Cet identifiant existe déjà"}); return
                audit(conn, user["id"], user["username"], "user_create", username, f"consultant={consultant_id}, role={role}", self.client_ip)
                self.send_json(201, {"id": cur.lastrowid})
            finally: conn.close()
            return
        if path == "/api/admin/backup":
            auth = self.auth(require_admin=True, require_csrf=True)
            if not auth: return
            conn, user, csrf = auth
            try:
                target = backup_database("manual")
                audit(conn, user["id"], user["username"], "backup_manual", target.name, None, self.client_ip)
                self.send_json(200, {"ok": True, "file": target.name})
            finally: conn.close()
            return
        self.send_error(404)

    def _handle_put(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            auth = self.auth(require_csrf=True)
            if not auth: return
            conn, user, csrf = auth
            try:
                body = self.read_json()
                base_revision = int(body.get("base_revision", 0))
                client_state = body.get("state")
                if not isinstance(client_state, dict):
                    self.send_json(400, {"error": "État invalide"}); return
                conn.execute("BEGIN IMMEDIATE")
                try:
                    revision, state, summary = merge_client_state(conn, user, client_state, base_revision, self.client_ip)
                    conn.execute("COMMIT")
                except SyncConflict as e:
                    conn.execute("ROLLBACK")
                    row = conn.execute("SELECT revision,state_json FROM app_state WHERE singleton=1").fetchone()
                    latest = filter_state(json.loads(row["state_json"]), user)
                    self.send_json(409, {"error": "Conflit de synchronisation", "conflicts": e.conflicts, "revision": int(row["revision"]), "state": latest})
                    return
                except PermissionError as e:
                    conn.execute("ROLLBACK")
                    audit(conn, user["id"], user["username"], "permission_denied", "state", str(e), self.client_ip)
                    self.send_json(403, {"error": str(e)})
                    return
                except Exception:
                    conn.execute("ROLLBACK")
                    raise
                self.send_json(200, {"ok": True, "revision": revision, "state": state, "changes": len(summary)})
                maybe_daily_backup()
            except ValueError as e:
                self.send_json(400, {"error": str(e)})
            except Exception as e:
                self.send_json(500, {"error": "Erreur serveur lors de la synchronisation"})
                log(f"sync error: {e!r}")
            finally: conn.close()
            return
        self.send_error(404)

    def _handle_patch(self):
        parsed = urlparse(self.path)
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 4 and parts[:3] == ["api", "admin", "users"]:
            auth = self.auth(require_admin=True, require_csrf=True)
            if not auth: return
            conn, user, csrf = auth
            try:
                try: target_id = int(parts[3])
                except ValueError:
                    self.send_json(400, {"error": "Utilisateur invalide"}); return
                body = self.read_json()
                target = conn.execute("SELECT * FROM users WHERE id=?", (target_id,)).fetchone()
                if not target:
                    self.send_json(404, {"error": "Utilisateur introuvable"}); return
                updates, params = [], []
                if "active" in body:
                    active = 1 if bool(body["active"]) else 0
                    if target_id == user["id"] and not active:
                        self.send_json(400, {"error": "Vous ne pouvez pas désactiver votre propre compte"}); return
                    updates.append("active=?"); params.append(active)
                if "role" in body:
                    role = str(body["role"])
                    if role not in {"user","admin"}:
                        self.send_json(400, {"error": "Rôle invalide"}); return
                    if target_id == user["id"] and role != "admin":
                        self.send_json(400, {"error": "Vous ne pouvez pas retirer votre propre rôle administrateur"}); return
                    updates.append("role=?"); params.append(role)
                if "password" in body:
                    password = str(body["password"])
                    if len(password) < 12:
                        self.send_json(400, {"error": "Le mot de passe doit contenir au moins 12 caractères"}); return
                    salt, digest, iterations = hash_password(password)
                    updates += ["password_salt=?","password_hash=?","password_iterations=?"]
                    params += [salt,digest,iterations]
                    conn.execute("DELETE FROM sessions WHERE user_id=? AND user_id<>?", (target_id, user["id"]))
                if not updates:
                    self.send_json(400, {"error": "Aucune modification"}); return
                updates.append("updated_at=?"); params.append(iso_now()); params.append(target_id)
                conn.execute(f"UPDATE users SET {','.join(updates)} WHERE id=?", params)
                audit(conn, user["id"], user["username"], "user_update", target["username"], ",".join(k for k in body if k != "password") + (",password_reset" if "password" in body else ""), self.client_ip)
                self.send_json(200, {"ok": True})
            finally: conn.close()
            return
        self.send_error(404)


def main() -> None:
    init_db()
    maybe_daily_backup()
    httpd = ThreadingHTTPServer((HOST, PORT), PilotHandler)
    stop_event = threading.Event()
    housekeeping = threading.Thread(target=housekeeping_loop, args=(stop_event,), daemon=True, name="housekeeping")
    housekeeping.start()

    def request_shutdown(signum, frame):
        log(f"signal {signal.Signals(signum).name} reçu, arrêt en cours")
        # shutdown() bloque jusqu'à la sortie de serve_forever : à lancer hors du handler.
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)
    log(f"Pilotéo V1 listening on http://{HOST}:{PORT} — database {DB_PATH}")
    try:
        httpd.serve_forever()
    finally:
        stop_event.set()
        httpd.server_close()
        log("arrêt terminé")


if __name__ == "__main__":
    main()
