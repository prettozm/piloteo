#!/usr/bin/env python3
"""Restore a Pilotéo SQLite backup after the service has been stopped."""
from __future__ import annotations
import argparse, shutil, sqlite3
from datetime import datetime
from pathlib import Path

p=argparse.ArgumentParser(description="Restaure une sauvegarde Pilotéo. Arrêter le service avant exécution.")
p.add_argument("backup", type=Path)
p.add_argument("--database", type=Path, default=Path("data/piloteo.sqlite3"))
p.add_argument("--force", action="store_true", help="Ignorer le garde-fou « service arrêté » (déconseillé).")
a=p.parse_args()
backup=a.backup.resolve(); db=a.database.resolve()
if not backup.is_file(): raise SystemExit(f"Sauvegarde introuvable: {backup}")

# Intégrité de la sauvegarde source AVANT toute écriture.
with sqlite3.connect(backup) as c:
    result=c.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok": raise SystemExit(f"Sauvegarde invalide: integrity_check={result}")

# Garde-fou : si un fichier -wal/-shm existe ou si un verrou exclusif est
# impossible à prendre sur la base cible, c'est que le service tourne encore.
# Restaurer à chaud corromprait la base. On refuse sauf --force.
if db.exists() and not a.force:
    hot = any(Path(str(db)+suffix).exists() for suffix in ("-wal","-shm"))
    if not hot:
        try:
            probe=sqlite3.connect(str(db), timeout=1)
            try:
                probe.execute("BEGIN IMMEDIATE"); probe.execute("ROLLBACK")
            finally:
                probe.close()
        except sqlite3.OperationalError:
            hot=True
    if hot:
        raise SystemExit(
            "La base cible semble en cours d'utilisation (service actif). "
            "Arrêter Pilotéo (docker compose down) avant de restaurer, "
            "ou relancer avec --force si vous êtes certain que le service est arrêté."
        )

db.parent.mkdir(parents=True, exist_ok=True)
if db.exists():
    safety=db.with_name(f"{db.name}.before-restore-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(db,safety)
    print(f"Copie de sécurité de la base actuelle: {safety}")
shutil.copy2(backup,db)
for suffix in ("-wal","-shm"):
    Path(str(db)+suffix).unlink(missing_ok=True)
print(f"Restauration terminée: {backup} -> {db}")
