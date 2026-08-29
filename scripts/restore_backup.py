#!/usr/bin/env python3
"""Restore a Pilotéo SQLite backup after the service has been stopped."""
from __future__ import annotations
import argparse, shutil, sqlite3
from datetime import datetime
from pathlib import Path

p=argparse.ArgumentParser(description="Restaure une sauvegarde Pilotéo. Arrêter le service avant exécution.")
p.add_argument("backup", type=Path)
p.add_argument("--database", type=Path, default=Path("data/piloteo.sqlite3"))
a=p.parse_args()
backup=a.backup.resolve(); db=a.database.resolve()
if not backup.is_file(): raise SystemExit(f"Sauvegarde introuvable: {backup}")
with sqlite3.connect(backup) as c:
    result=c.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok": raise SystemExit(f"Sauvegarde invalide: integrity_check={result}")
db.parent.mkdir(parents=True, exist_ok=True)
if db.exists():
    safety=db.with_name(f"{db.name}.before-restore-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(db,safety)
    print(f"Copie de sécurité de la base actuelle: {safety}")
shutil.copy2(backup,db)
for suffix in ("-wal","-shm"):
    Path(str(db)+suffix).unlink(missing_ok=True)
print(f"Restauration terminée: {backup} -> {db}")
