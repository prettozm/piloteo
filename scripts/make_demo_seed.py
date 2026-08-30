#!/usr/bin/env python3
"""Anonymise le jeu de démonstration (seed.json) — données 100 % fictives.

Remplace de façon déterministe les noms de consultants, les organisations
(dont des entités réelles utilisées comme clients fictifs dans le prototype)
et les identifiants dérivés, partout où ils apparaissent (ids croisés,
libellés d'affaires, mots-clés). Idempotent : relancer sur un seed déjà
anonymisé ne change rien.

Usage : python scripts/make_demo_seed.py [--in seed.json] [--out seed.json]
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path

# Consultants : (ancien id, ancien nom, ancien trigramme) -> (nouveau id, nom, trigramme)
CONSULTANTS = {
    "XDB": ("RBL", "Robin Blanchet", "RBL"),
    "CLR": ("MLN", "Morgane Lenoir", "MLN"),
    "TPT": ("AVR", "Antoine Verger", "AVR"),
    "SMR": ("CDM", "Claire Dumont", "CDM"),
    "LFT": ("ELS", "Élise Salmon", "ELS"),
    "NPR": ("NGR", "Noah Granger", "NGR"),
    "MDL": ("MRX", "Martin Roux", "MRX"),
}
OLD_NAMES = {
    "Xavier Dubreuil": "Robin Blanchet",
    "Camille Leroy": "Morgane Lenoir",
    "Thomas Petit": "Antoine Verger",
    "Sophie Moreau": "Claire Dumont",
    "Léa Fontaine": "Élise Salmon",
    "Nathan Perrot": "Noah Granger",
    "Marc Delisle": "Martin Roux",
}
OLD_TRIGRAMMES = {
    "XAD": "RBL", "CAL": "MLN", "THP": "AVR", "SOM": "CDM",
    "LEF": "ELS", "NAP": "NGR", "MAD": "MRX",
}

# Organisations : entités réelles ou d'origine -> équivalents fictifs.
# Les remplacements longs passent avant les courts (évite les collisions).
ORG_TOKENS = [
    ("Métropole de Rennes", "Agglomération de Valberny"),
    ("Département de l'Isère", "Département du Valmont"),
    ("Fondation Abbé Pierre", "Fondation Horizon Solidaire"),
    ("GreenBuild SAS", "BâtiVert SAS"),
    ("Solstice Ingénierie", "Meridio Ingénierie"),
    ("Vallon Études", "Ondine Études"),
    ("Ecobati Habitat", "Solerra Habitat"),
    ("ADEME", "ATD"),  # -> Agence Territoires Durables (fictive)
    ("Rennes", "Valberny"),
    ("Isère", "Valmont"),
    ("GreenBuild", "BâtiVert"),
    ("Solstice", "Meridio"),
    ("Vallon", "Ondine"),
    ("Ecobati", "Solerra"),
    ("FAP", "FHS"),
]
# Nom complet de la fausse agence, appliqué après le token court.
ORG_FULLNAME_FIX = [("organisations", "ATD", "Agence Territoires Durables")]


def remap_string(s: str) -> str:
    for old, new in ORG_TOKENS:
        s = s.replace(old, new)
    for old, new in OLD_NAMES.items():
        s = s.replace(old, new)
    for old, (new_id, _, _) in CONSULTANTS.items():
        if s == old:
            return new_id
        # ids embarqués dans des identifiants composés (ex. FRAIS_CLR_2026_001)
        s = s.replace(f"_{old}_", f"_{new_id}_")
    if s in OLD_TRIGRAMMES:
        return OLD_TRIGRAMMES[s]
    return s


def walk(o):
    if isinstance(o, dict):
        return {k: walk(v) for k, v in o.items()}
    if isinstance(o, list):
        return [walk(v) for v in o]
    if isinstance(o, str):
        return remap_string(o)
    return o


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="src", type=Path, default=Path("seed.json"))
    p.add_argument("--out", dest="dst", type=Path, default=Path("seed.json"))
    a = p.parse_args()
    data = json.loads(a.src.read_text(encoding="utf-8"))
    data = walk(data)
    # nom complet de la fausse agence dans la table organisations
    for coll, short, full in ORG_FULLNAME_FIX:
        for org in data.get(coll, []):
            if org.get("nom") == short:
                org["nom"] = full
    # contrôle : plus aucun jeton d'origine
    raw = json.dumps(data, ensure_ascii=False)
    leftovers = [t for t, _ in ORG_TOKENS if t in raw] + \
                [n for n in OLD_NAMES if n in raw] + \
                [t for t in OLD_TRIGRAMMES if f'"{t}"' in raw] + \
                [o for o in CONSULTANTS if f'"{o}"' in raw or f"_{o}_" in raw]
    if leftovers:
        raise SystemExit(f"Jetons d'origine encore présents: {leftovers}")
    a.dst.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"seed anonymisé écrit: {a.dst} ({len(raw)} octets)")


if __name__ == "__main__":
    main()
