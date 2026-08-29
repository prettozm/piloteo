# Pilotéo V1.0.0 — Audit de robustesse pour la mise en production

Audit réalisé sur l'archive livrée `piloteo-v1.0.0.zip`
(SHA-256 `a4a7da0ccf10203ae3eb0677e3057fd8ab9c5f4020d16249de7fd8e4c100128c`,
vérifié conforme au `.sha256` fourni), importée telle quelle comme commit de
base de ce dépôt avant toute correction.

L'audit couvre trois périmètres — **serveur** (`server.py`), **frontend**
(`index.html`, `support.html`) et **infrastructure/tests** — et respecte le
principe de proportionnalité posé par `docs/AI_HANDOFF.md` : on répond au besoin
strict d'un cabinet d'environ cinq utilisateurs, sans réécrire le métier ni
introduire de complexité inutile.

## Synthèse

| Périmètre | Constat principal | Gravité | État |
|---|---|---|---|
| Frontend | XSS stocké généralisé (aucun échappement HTML) → escalade `user`→`admin` | **Critique** | Corrigé |
| Frontend | `saveConsultant()` renvoie l'admin à l'écran de connexion | Haute | Corrigé |
| Frontend | Expiration de session (401) non gérée → perte de données silencieuse | Haute | Corrigé |
| Frontend | `saveSaisie()` crashe si le consultant n'a aucune mission | Haute | Corrigé |
| Serveur | `X-Forwarded-For` cru sans restriction → contournement du rate-limit et audit falsifié | Haute | Corrigé |
| Serveur | `SIGTERM` non intercepté → pas d'arrêt propre sous Docker | Haute | Corrigé |
| Serveur | Sauvegarde quotidienne dépendante d'une écriture ; pas de purge de sessions | Moyenne | Corrigé |
| Infra | Conteneur en root ; pas de limites ressources/logs | Moyenne | Corrigé |
| Infra | Restauration possible à chaud (service actif) → corruption | Moyenne | Corrigé |
| Tests | `merge_client_state` et toute la couche HTTP non testés | Moyenne | Corrigé (8 → 45 tests) |

**Points déjà sains dans la V1** (aucune correction) : hachage PBKDF2-HMAC-SHA256
600 000 itérations avec sel, CSRF systématique sur écriture, filtrage des données
côté serveur (`filter_state`) sans fuite inter-consultants, synchronisation
optimiste avec détection de conflit par entité (pas d'écrasement silencieux),
en-têtes de sécurité complets, aucune dépendance web tierce, aucune donnée métier
en `localStorage`, `support.html` correctement échappé, sauvegardes cohérentes via
l'API `sqlite3.backup()`. Le dépôt GitHub est **privé** (vérifié).

---

## 1. Serveur (`server.py`)

### 1.1 Confiance en `X-Forwarded-For` — Haute — corrigé
Le code retenait le **premier** élément de `X-Forwarded-For` sans vérifier
l'émetteur. Un client pouvait donc forger son IP, contournant le rate-limit de
connexion (10 essais / 15 min par IP) et polluant le journal d'audit — pourtant
présenté comme le mécanisme de traçabilité dans `docs/SECURITY.md`.
**Correctif :** l'en-tête n'est cru que si le pair TCP direct appartient à
`PILOTEO_TRUSTED_PROXIES` (127.0.0.0/8 + plages privées par défaut), et seul le
**dernier** hop est retenu (celui ajouté par le proxy de confiance). Le
`Caddyfile.example` force désormais `header_up X-Forwarded-For {remote_host}`.

### 1.2 Arrêt propre — Haute — corrigé
`main()` n'interceptait que `KeyboardInterrupt` ; `docker stop`/`compose down`
envoient `SIGTERM`, tuant le process sans passer par `server_close()`.
**Correctif :** handlers `SIGTERM`/`SIGINT` appelant `httpd.shutdown()` hors du
handler de signal, puis `server_close()` dans le `finally`. Vérifié : arrêt en
< 2 s, code de sortie 0.

### 1.3 Sauvegarde et hygiène de fond — Moyenne — corrigé
La sauvegarde quotidienne n'était déclenchée qu'à la première écriture métier du
jour (une journée sans saisie = pas de sauvegarde) et un échec marquait quand
même le jour comme fait. Les sessions expirées n'étaient purgées qu'au démarrage.
**Correctif :** thread `housekeeping` horaire qui déclenche la sauvegarde
quotidienne (échec journalisé et réessayé) et purge les sessions expirées, même
sans aucune activité.

### 1.4 Durcissements complémentaires — corrigés
- `Content-Type: application/json` exigé sur les corps → ferme la voie « login
  CSRF » via un formulaire cross-site.
- Timing de connexion uniforme (vérification factice si le compte n'existe pas) →
  empêche l'énumération de comptes par mesure de temps.
- Bornes anti-DoS mémoire sur la table de rate-limit + purge des IP inactives.
- Handlers HTTP encapsulés : une exception renvoie un 500 propre au lieu de couper
  la connexion et de fuiter une trace ; `if_revision` non entier ne provoque plus
  d'erreur.
- `PRAGMA user_version` (socle de migrations) : refus de démarrer sur une base
  plus récente que le code.
- `timeout` socket de 60 s (anti-slowloris) ; logs horodatés et flushés.

---

## 2. Frontend (`index.html`, `support.html`)

> `index.html` : ~8 200 lignes dont ~6 250 de JS dans une IIFE unique. Le métier y
> vit (choix assumé de la V1). Les correctifs ci-dessous sont **ciblés sécurité et
> robustesse** ; la dette de maintenabilité (voir §4) n'est délibérément pas traitée.

### 2.1 XSS stocké généralisé — Critique — corrigé
Toutes les tables, listes et graphiques étaient construits par concaténation de
chaînes injectées via `innerHTML`, **sans aucun échappement**, à partir de données
saisies par les utilisateurs (commentaires de temps/frais, noms d'affaire, de
mission, d'organisation, libellés de référence…).

**Chaîne d'attaque démontrée :** un simple `user` saisit dans le commentaire d'un
temps une charge `<img src=x onerror=…>` ; le serveur la stocke ; un administrateur
ouvrant « Détail des temps » l'exécute (la CSP autorise `unsafe-inline`) ; le script
lit le jeton CSRF via `GET /api/me` et crée un compte administrateur. **Escalade
`user` → `admin` sans autre interaction que la consultation d'un tableau.**

**Correctif :** fonction `esc()` (même contrat que celle déjà présente dans
`support.html`) ajoutée en tête de l'IIFE et appliquée à toute donnée métier
interpolée dans du HTML, y compris dans les attributs (`value=`, `option`,
`data-*`). Les valeurs numériques déjà formatées et les constantes ne sont pas
échappées (inutile).

**Sinks indirects supplémentaires trouvés par le test navigateur** (voir §3.4) —
au-delà du motif direct `${x.nom}`, le test E2E a révélé trois sinks où une donnée
utilisateur transitait par une variable ou un helper et échappait à la première
passe : le nom d'affaire passé en paramètre `${label}` des lignes de sous-total du
suivi des temps, le trigramme de la table des consultants, et `fraisCibleLabel()`
(qui renvoie un nom d'affaire) sur la page Frais. Tous échappés.

**Vérification :** analyse statique des 1 144 interpolations du fichier (toutes
tracées jusqu'à un formateur sûr, un `textContent`, une constante ou `esc()`) +
test navigateur injectant une charge XSS dans tous les champs texte libre et
parcourant chaque vue (aucun élément `<img>`/`onerror` créé, aucune boîte de
dialogue). Défense en profondeur : la CSP `script-src 'self'` (voir §3.4) bloque
de toute façon l'exécution de tout script inline résiduel.

### 2.2 Retour forcé à l'écran de connexion — Haute — corrigé
`saveConsultant()` appelait `renderIdentify()` (reliquat du prototype), qui masque
toute l'interface et réaffiche le formulaire de login à chaque création/édition de
consultant, alors que la session est valide. **Correctif :** appel supprimé.

### 2.3 Perte de données à l'expiration de session — Haute — corrigé
Un `401` sur `PUT /api/state` tombait dans la branche « Non synchronisé » et
bouclait indéfiniment : l'utilisateur continuait à saisir dans un état jamais
persisté. **Correctif :** le `401` arrête les timers, affiche un message explicite
et ramène proprement à l'écran de connexion sans jeter le travail silencieusement ;
le `location.reload()` brutal du polling est remplacé par la même reconnexion propre.

### 2.4 Crash sur consultant sans mission — Haute — corrigé
`saveSaisie()` déréférençait `mission.enveloppe` sans garde : un nouvel arrivant
sans mission affectée rencontrait un bouton « Enregistrer » silencieusement inerte.
**Correctif :** garde explicite avec message, et présélection du type « interne »
quand aucune mission n'est disponible.

### 2.5 Robustesse et confort — corrigés
- Conflit `409` / refus `403` : la modification locale n'est plus jetée derrière un
  toast fugace ; une bannière persistante indique l'entité concernée.
- Export CSV : neutralisation de l'injection de formules (préfixe apostrophe sur
  les cellules commençant par `= + - @`), qui protège le comptable destinataire.
- `scheduleSync()` ne sérialise plus l'état complet à chaque frappe (latence sur
  grosse base).
- Filet global `window.onerror`/`unhandledrejection` + gardes `?.` sur les accès
  `.find()` non protégés.
- Suppression du code mort `window.claude` (reliquat d'environnement d'artefact).

`support.html` était déjà sain (échappement `esc()` et gestion d'erreurs
correcte) — aucune correction nécessaire.

---

## 3. Infrastructure, sauvegarde et tests

### 3.1 Docker — Moyenne — corrigé
Le conteneur tournait en **root**. **Correctif :** utilisateur non-root (uid 1000)
dans l'image et le compose, `HEALTHCHECK` porté aussi dans le Dockerfile (portable
hors compose), limites `mem_limit`/`cpus`/`pids_limit`, et journalisation bornée
(`max-size`/`max-file`). Les volumes doivent appartenir à l'uid 1000 (documenté
dans `EXPLOITATION.md`).

### 3.2 Restauration à chaud — Moyenne — corrigé
`restore_backup.py` pouvait écraser la base pendant que le service tournait (WAL
actif) → incohérence. **Correctif :** garde-fou détectant un service actif
(présence de `-wal`/`-shm` ou verrou `BEGIN IMMEDIATE` impossible) et refusant la
restauration, avec option `--force` en dernier recours.

### 3.3 Tests — Moyenne — corrigé (8 → 45)
La V1 ne testait ni `merge_client_state` (le moteur de synchro, le code le plus
critique) ni la couche HTTP. **Ajouts :**
- `tests/test_sync.py` (15) : fusion optimiste, conflit sur même/autre entité,
  révision de base trop ancienne, permissions, branches de `filter_state`
  (missions pilotées, organisations partenaires, factures/notes/bordereaux),
  rate-limit, `client_ip` de confiance.
- `tests/test_http.py` (22) : intégration bout en bout (login, `Content-Type`,
  CSRF, `/api/state`, endpoints admin, logout, en-têtes de sécurité, 404).
- `.github/workflows/ci.yml` : compile + tests, build de l'image, healthcheck et
  vérification de l'arrêt propre `SIGTERM`.

### 3.4 Durcissement CSP et test navigateur — corrigés (2ᵉ lot)
- **CSP `script-src 'self'` sans `unsafe-inline`.** Tout le JavaScript a été
  externalisé (`index.html` → `/app.js`, `support.html` → `/support.js`, servis par
  `server.py`) ; aucun script ni gestionnaire d'événement en ligne ne subsiste.
  `unsafe-inline` a donc été retiré de `script-src` : un éventuel XSS résiduel ne
  peut plus exécuter de script. `style-src` conserve `unsafe-inline` (attributs
  `style=` en ligne dans l'UI, sans vecteur d'exécution de script) — documenté.
- **Test E2E navigateur** (`tests/e2e/smoke.mjs`, Playwright/Chromium) : démarre le
  serveur sur une base jetable, pilote un vrai navigateur (connexion, navigation de
  toutes les vues, console support), injecte des charges XSS et vérifie qu'aucune ne
  s'exécute, le tout sous la CSP stricte (zéro violation console). Ajouté au CI.
- **Harnais de non-régression par snapshot DOM** (`tests/e2e/snapshot.mjs`) : capture
  le rendu de toutes les vues sur données déterministes, pour prouver qu'un
  refactoring ne change pas le rendu (utilisé pour la déduplication du §4).

---

## 4. Dette de maintenabilité — traitée (2ᵉ lot)

La dette de duplication signalée initialement est réduite **à comportement
constant**, garanti par le harnais de snapshot DOM (§3.4) : le rendu de toutes les
vues doit rester identique octet pour octet avant/après (contrôle bloquant).

- sélecteurs d'année (~9 copies) mutualisés en un helper ;
- cœur de tracé des donuts (4 copies) extrait en un helper commun ;
- `wireExports` (240 lignes / 21 branches) **laissé en l'état** : la sortie CSV
  n'est pas couverte par un test automatisé, donc le refactorer sans filet serait
  imprudent — à faire après avoir ajouté des tests de contenu CSV (V1.1).

Reste assumé, sans impact sur la mise en production : `index.html` monolithique
(JS désormais dans `app.js`, mais toujours une IIFE plate) — un découpage en
modules ne se justifiera que si le fichier continue de croître.

## 5. Recommandations de suivi (V1.1 éventuelle)

1. Pinner l'image de base par digest SHA-256 + scan CVE périodique (`trivy`).
2. Flux « changement de mot de passe personnel » si la gestion manuelle devient
   pénible.
3. Anonymiser `seed.json` ou le générer par script si le dépôt devait s'ouvrir.
4. Ajouter des tests de contenu d'export CSV, puis mutualiser `wireExports`.
