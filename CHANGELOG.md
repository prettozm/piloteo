# Journal des versions

## 1.1.0 — 2026-08-30 : robustification, white-label et déploiement multi-clients

### Sécurité
- Correction d'un XSS stocké critique (échappement `esc()` systématique) qui
  permettait une escalade utilisateur → administrateur ; sinks indirects inclus.
- CSP `script-src 'self'` sans `unsafe-inline` (JS externalisé dans `/app.js` et
  `/support.js`).
- `X-Forwarded-For` cru uniquement derrière un proxy de confiance
  (`PILOTEO_TRUSTED_PROXIES`).
- Content-Type JSON exigé (anti login-CSRF), timing de connexion uniforme,
  anti-injection de formules CSV, bornes anti-DoS sur le rate-limit.

### Robustesse
- Arrêt propre `SIGTERM`/`SIGINT` ; tâche de fond horaire (sauvegarde quotidienne
  fiabilisée, purge des sessions) ; handlers HTTP encapsulés ; socle de
  migrations (`PRAGMA user_version`) ; version applicative dans `/api/health`.
- Frontend : gestion propre de l'expiration de session, bannière de conflit
  persistante, gardes anti-crash, filet d'erreurs global.

### White-label et anonymisation
- Jeu de démonstration `seed.json` entièrement fictif (organisations et
  consultants renommés, identifiants remappés) — générateur :
  `scripts/make_demo_seed.py`.
- Marque configurable par client : `PILOTEO_ORG_NAME` (injectée côté serveur)
  et logo déposable sur le volume (`branding/logo.svg|png|jpg`, route
  `/brand-logo`, logo neutre par défaut).
- Retrait des documents Word d'origine porteurs de la marque initiale.

### Déploiement
- Conteneur : entrypoint qui prépare les volumes puis abandonne les privilèges
  (`setpriv`) — plus de `chown` manuel ; Litestream embarqué (réplication
  continue de la base vers un stockage S3, activée par
  `LITESTREAM_REPLICA_URL`).
- Fly.io multi-clients : `fly.toml` (région `cdg`, mono-machine, volume) et
  `scripts/fly-new-client.sh` (une app isolée par client : volume, secrets,
  URL).
- Environnements de développement : `.devcontainer/` (Codespaces) et
  `docker-compose.dev.yml`.

### Qualité
- Tests : 8 → 50+ (synchronisation, permissions, intégration HTTP) ; test E2E
  navigateur (Playwright) avec vérification XSS/CSP ; harnais de non-régression
  par snapshot DOM et par contenu d'export CSV.
- CI GitHub Actions : tests, build d'image, healthcheck, arrêt propre, E2E,
  scan de vulnérabilités (Trivy) ; Dependabot.
- Déduplication du frontend à comportement prouvé constant.

### Documentation
- Guides utilisateur, administrateur et déploiement ; audit consolidé
  (`docs/AUDIT_V1.md`) ; documentation généralisée (sans marque client).

## 1.0.0

Voir [`docs/V1_CHANGELOG.md`](docs/V1_CHANGELOG.md).
