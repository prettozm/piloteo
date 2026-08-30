# tools/v1-export — Export canonique de l'état Pilotéo V1

Utilitaire **autonome** (Python 3 stdlib seule) qui exporte l'état
applicatif complet d'une base SQLite Pilotéo V1 vers le format JSON
`piloteo-v1-export` consommé par `src/migration/v1-import.js`
(`importV1`). Ne modifie ni `server.py`, ni `app.js`, ni la base V1
elle-même.

Contexte : docs/next/03_MIGRATION_V1_VERS_LOCAL_FIRST.md (Phase 9),
`src/V1_DOMAIN_MAP.md` §1.

## Garantie lecture seule

- La base SQLite est ouverte via l'URI SQLite `file:<chemin>?mode=ro`
  (`sqlite3.connect(uri, uri=True)`) : c'est SQLite lui-même qui refuse
  toute écriture sur cette connexion (`sqlite3.OperationalError: attempt
  to write a readonly database`), pas seulement une discipline de code.
- Le script n'exécute que des `SELECT` / `PRAGMA <x>` (lecture). Aucun
  `INSERT`/`UPDATE`/`CREATE`/`PRAGMA <x>=<y>` n'est jamais émis.
- Fonctionne que le serveur V1 (`server.py`) soit démarré ou non : accès
  direct au fichier `.sqlite3` sur disque, pas d'appel HTTP.
- Un fichier absent, illisible, ou non-SQLite fait échouer proprement le
  script (message clair sur stderr, code retour `1`) — jamais de
  création/altération de fichier.

## Ce qui est lu

Table `app_state` (`server.py:182-188`), état applicatif courant
(colonnes `revision`, `state_json`) et `PRAGMA user_version` (version de
schéma V1, `server.py:207,215-216`). `state_json` contient à sa racine,
directement, les 12 collections V1 listées dans `COLLECTION_KEYS`
(`server.py:63-76`, `V1_DOMAIN_MAP.md` §1) :

```
consultants, organisations, affaires, methodes, typesTerritoire,
domainesIntervention, categoriesFrais, missions, factures, saisies,
bordereauxFrais, notesFrais
```

(`bordereauxFrais` s'identifie par `numero`, toutes les autres par `id` —
non vérifié par cet export, qui délègue cette logique à
`v1-import.js`/`event-schema.js`.)

## Format de sortie

```json
{
  "format": "piloteo-v1-export",
  "schemaVersion": 1,
  "exportedAt": "2026-08-30T12:00:00.000Z",
  "revision": 42,
  "state": {
    "consultants": [ ... ],
    "organisations": [ ... ],
    "affaires": [ ... ],
    "methodes": [ ... ],
    "typesTerritoire": [ ... ],
    "domainesIntervention": [ ... ],
    "categoriesFrais": [ ... ],
    "missions": [ ... ],
    "factures": [ ... ],
    "saisies": [ ... ],
    "bordereauxFrais": [ ... ],
    "notesFrais": [ ... ]
  }
}
```

`schemaVersion` vaut `PRAGMA user_version` (ou `1` par défaut si la base
n'a jamais été initialisée / vaut `0`). `exportedAt` est un timestamp ISO
8601 UTC généré au moment de l'export (pas lu en base). `revision` est la
révision `app_state.revision` exacte lue.

## NaN / Infinity (dette V1)

La V1 sérialise son JSON sans `allow_nan=False`
(`V1_DOMAIN_MAP.md` §7) : NaN/Infinity/-Infinity pouvaient en théorie
s'être glissés dans `state_json`. Par défaut, `export_v1.py` **détecte**
ces valeurs et **refuse** l'export (message explicite, code retour `1`)
plutôt que de propager cette dette dans le format canonique. Utiliser
`--allow-nan` pour forcer quand même un export non standard
(diagnostic/débogage uniquement — **ne jamais** alimenter
`v1-import.js` avec un tel export).

## Usage

```bash
# Vers stdout
python3 tools/v1-export/export_v1.py --db data/piloteo.sqlite3

# Vers un fichier
python3 tools/v1-export/export_v1.py --db data/piloteo.sqlite3 --out export.json

# Aide
python3 tools/v1-export/export_v1.py --help
```

Codes retour : `0` succès, `1` erreur (base absente/illisible, table
`app_state` absente/vide, JSON invalide, NaN/Infinity sans `--allow-nan`,
etc. — message sur stderr dans tous les cas).

## Chaînage avec `v1-import.js`

`export_v1.py` produit exactement l'objet attendu en entrée par
`importV1(exportObj, opts)` (`src/migration/v1-import.js`) :
`exportObj.format === "piloteo-v1-export"` et `exportObj.state` avec les
12 collections. Exemple de chaînage complet (export → fichier → import) :

```bash
python3 tools/v1-export/export_v1.py --db data/piloteo.sqlite3 --out /tmp/export.json
```

```js
// import.mjs
import { readFileSync } from "node:fs";
import { importV1, compareCollections } from "./src/migration/v1-import.js";

const exportObj = JSON.parse(readFileSync("/tmp/export.json", "utf-8"));

const { workspace, genesisEvent, projection, events } = importV1(exportObj, {
  workspaceId: crypto.randomUUID(),
  actorId: crypto.randomUUID(), // owner du nouveau workspace
  workspaceName: "Import V1",
});

// Vérifie que la projection reconstruite est fonctionnellement identique
// à l'état V1 source (compte, ids, champs).
const { ok, differences } = compareCollections(exportObj.state, projection);
if (!ok) {
  console.error("Écarts détectés :", differences);
  process.exit(1);
}

console.log(`Import OK : ${events.length} entités, workspace ${workspace.id}, revision source ${exportObj.revision}`);
```

```bash
node import.mjs
```

## Tests

```bash
python3 -m unittest tests/v1_export/test_export_v1.py -v
```
