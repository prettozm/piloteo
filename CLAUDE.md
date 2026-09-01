# CLAUDE.md — Règles de travail sur Pilotéo (local-first)

> Ce fichier est chargé automatiquement à chaque session. Il fige les
> invariants du projet et le protocole de développement. Il prime sur les
> habitudes par défaut, jamais sur le prompt système du harnais.

## 1. Ce qu'est le projet

Pilotéo migre d'une app client/serveur (V1, `app.js` + `server.py`) vers une
**PWA local-first** : pas de backend métier, journal d'événements signé,
stockage côté client (IndexedDB, dossier local via File System Access, dossier
partagé/Drive). Trois modes coexistent : **solo (cet appareil)**, **dossier**,
**organisation (dossier partagé, multi-membres)**.

## 2. Invariants NON négociables

1. **`app.js` et `server.py` restent INTACTS.** Toute la logique local-first
   passe par des ponts (`local-backend.js` intercepte `/api/*`, ponts ES
   `piloteo-*-bridge.mjs` exposent `window.PiloteoNext` / `window.PiloteoOrg`).
   Si une évolution semble imposer de modifier `app.js`, s'arrêter et demander.
2. **Tests toujours verts avant tout commit** : `npm run test:next` (node:test +
   fake-indexeddb) et les e2e Playwright/Chromium (`tests/e2e/*.mjs`).
3. **Le contrat précède le code.** Chaque lot a un contrat dans `docs/next/*_CONTRACT.md`
   qui sert d'oracle : le code est jugé CONTRE le contrat, pas contre une opinion.
4. **Sécurité d'abord sur les organisations.** Modèle retenu : « dossier de
   confiance » — événements **signés (Ed25519), NON chiffrés** ; la confidentialité
   repose sur les permissions du dossier SI. Le chiffrement reste derrière une
   revue de sécurité (gate). Chaîne de confiance cryptographique obligatoire
   (manifeste genesis write-once, invitations signées, révocation signée avec
   « autorité révoquée = zéro »). Ne jamais faire confiance à un rôle auto-déclaré.
5. **Aucun secret dans le dépôt public** (`prettozm/piloteo`). Le Client ID OAuth
   Google est public (SPA + PKCE/token model, scope `drive.file`) et peut être
   embarqué ; un client_secret, une clé privée, un token ne le sont JAMAIS.
6. **Pas de PR sans demande explicite.** Développer sur la branche désignée.

## 3. Protocole de développement — boucle maker → vérificateur → contrariant

Tout lot non trivial suit ce cycle, avec des **sous-agents Sonnet** (Haiku pour
les tâches mécaniques) lancés via l'outil `Agent` :

```
contrat (docs/next/*_CONTRACT.md)
        │
        ▼
  MAKER          implémente + écrit les tests ; livre le code
        │
        ▼
  VÉRIFICATEUR   rejoue les tests, relit CONTRE le contrat, liste les écarts
        │
        ▼
  CONTRARIANT    attaque : cherche une repro qui casse (sécu, causalité, conflits)
        │
   repro ? ── oui ──► retour MAKER (nouveau round)
        │
        non → VALIDÉ → commit → lot suivant
```

Règles de la boucle :
- Les trois rôles sont des **agents séparés** (contexte isolé) ; le contrariant
  reçoit le code + le contrat, **pas** les justifications du maker.
- Un round ne clôt que si le contrariant **échoue à produire une repro réelle**.
  « Je n'ai pas trouvé de faille » ne suffit pas s'il n'a pas essayé d'attaquer.
- Le vérificateur **exécute** les tests, il ne les lit pas seulement.
- Voir `.claude/agents/{maker,verificateur,contrariant}.md` pour les consignes de rôle.

## 4. Où regarder (carte des fichiers)

| Sujet | Fichiers |
|---|---|
| Cahier des charges local-first | `docs/next/00_…09_…` |
| Contrats de lot (oracle) | `docs/next/*_CONTRACT.md` |
| Moteur événementiel | `src/events/` (schema, reducer, conflict) |
| Sync (pipeline hostile) | `src/sync/sync-engine.js` |
| Store solo event-first | `src/integration/solo-store.js` |
| Stockage (adapters/ports) | `src/storage/` (folder, fsaccess, node-fs, google-drive) |
| Organisations (chaîne de confiance) | `src/workspace/org-*.js` |
| Backend navigateur classique | `local-backend.js` (intercepte `/api/*`) |
| Ponts ES | `piloteo-solo-bridge.mjs`, `piloteo-org-bridge.mjs` |
| Config / gating | `src/config/runtime-config.js`, `src/storage/storage-factory.js` |
| Tests | `tests/next/*.test.mjs`, `tests/e2e/*.mjs` |
| Déploiement | `.github/workflows/pages.yml`, `docs/DEPLOYER_CONTRACT.md` |

## 5. Commandes

```bash
npm run test:next          # tests unitaires Next (node:test)
node tests/e2e/<x>.mjs      # e2e Playwright/Chromium (PW_CHROMIUM, --no-sandbox)
```

## 6. Deux dépôts

- `prettozm/piloteo` — **public**, déploiement (Pages) ; pas de PII, pas de secret.
- `prettozm/piloteo-src` — **privé**, source. Porter les passes validées dessus.
