# Générateur de licence Pilotéo (CLI éditeur)

> ⚠️ Cet outil est **hors PWA**. Il détient (ou génère) la clé **privée**
> Ed25519 de signature des licences. Cette clé privée ne doit **jamais** :
>
> - être committée dans ce dépôt (ni dans aucun dépôt de la PWA) ;
> - apparaître dans `src/license/license.js` ou tout autre code livré au
>   navigateur ;
> - transiter par un canal non chiffré (email en clair, chat, etc.).
>
> Seule la clé **publique** (JWK) imprimée par ce script va dans
> `src/license/license.js` (constante `EDITOR_PUBLIC_KEY_JWK`).

Voir aussi `docs/next/06_LICENCE_ET_ESSAI.md` §11 et `src/CONTRACTS.md` §10.

## Où vit la clé privée

Par défaut : `~/.piloteo-license-gen/editor-signing-key.json` (répertoire
personnel de la machine qui exécute le CLI — **jamais** un dossier du dépôt).
Le fichier est créé avec des permissions `0600` à la première génération.

Vous pouvez pointer vers un autre emplacement (coffre-fort de secrets, disque
chiffré, etc.) avec `--keyfile <chemin>`. Le script **refuse** tout `--keyfile`
situé à l'intérieur du dépôt Pilotéo.

Sauvegardez ce fichier séparément (ex: gestionnaire de secrets de l'équipe).
Sa perte oblige à régénérer une nouvelle paire de clés éditeur et à redistribuer
la nouvelle clé publique dans une prochaine version de la PWA (les licences
signées avec l'ancienne clé cesseraient alors de se vérifier — à traiter comme
une rotation de clé, avec transition documentée si cela arrive en production).

## Usage

```bash
node tools/license-gen/generate-license.mjs --help
```

Génération d'une licence TEAM, 20 membres, valable un an :

```bash
node tools/license-gen/generate-license.mjs \
  --workspaceId 3f2a9e0a-1111-4b22-9c33-abc123456789 \
  --plan TEAM \
  --maxMembers 20 \
  --expiresAt 2027-09-01T00:00:00.000Z \
  --out ./licence-acme.json
```

Licence perpétuelle (`expiresAt` non défini) :

```bash
node tools/license-gen/generate-license.mjs \
  --workspaceId 3f2a9e0a-1111-4b22-9c33-abc123456789 \
  --plan TEAM \
  --maxMembers 50 \
  --expiresAt never
```

Sortie (stdout) :

1. la clé **publique** éditeur (JWK) — à copier une fois dans
   `src/license/license.js` (`EDITOR_PUBLIC_KEY_JWK`) ;
2. le JSON de la licence signée — à transmettre au client (fichier à importer,
   ou clé à coller, cf. docs/next/06 §6).

La première exécution génère la paire de clés éditeur si elle n'existe pas
encore (message sur stderr). Les exécutions suivantes réutilisent la même
clé privée pour signer — la clé publique reste donc stable tant que le
keyfile n'est pas régénéré.

## Options

| Option | Obligatoire | Description |
|---|---|---|
| `--workspaceId` | oui | UUID du workspace ciblé |
| `--plan` | oui | ex: `TEAM` |
| `--maxMembers` | oui | entier, ou `null` pour illimité |
| `--expiresAt` | oui | ISO 8601 UTC, ou `never`/`null` pour perpétuelle |
| `--notBefore` | non | défaut: maintenant |
| `--issuedAt` | non | défaut: maintenant |
| `--features` | non | liste `a,b,c` |
| `--licenseId` | non | défaut: généré (UUID) |
| `--keyfile` | non | défaut: `~/.piloteo-license-gen/editor-signing-key.json` |
| `--out` | non | écrit la licence dans un fichier (sinon stdout uniquement) |

## Sécurité — limites assumées (docs/next/06 §10)

Sans serveur d'activation :

- l'horloge locale du poste client est manipulable ;
- le JavaScript de la PWA peut être patché par un utilisateur expert ;
- un utilisateur peut créer un nouveau workspace pour obtenir un nouvel essai.

Ce générateur protège l'usage professionnel normal (licence signée, vérifiable
hors-ligne), pas contre un attaquant qui modifierait le code de la PWA. Ne pas
réintroduire un backend Pilotéo uniquement pour fermer ces cas tant qu'ils ne
représentent pas une fraude commerciale réelle.
