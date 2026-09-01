# Google Drive en écriture vive — checklist navigateur RÉELLE (Point 4, §6)

> L'OAuth Google Identity Services (GIS) exige une interaction utilisateur
> réelle (fenêtre de consentement) dans un VRAI navigateur : il ne peut PAS
> être automatisé dans cet environnement d'exécution. Ce document est donc une
> **checklist manuelle**, à dérouler par une personne, avec son propre compte
> Google — elle réutilise l'acquis déjà prouvé par `tools/team-spike/index.html`
> (connexion GIS + appels REST Drive en conditions réelles).
>
> Tout ce qui est câblé et vérifiable SANS navigateur (transport REST, retry,
> idempotence, pagination, mapping d'erreurs) est couvert par
> `tests/next/drive-adapter-live.test.mjs` (fetch mocké, `npm run test:next`) —
> **ne pas re-dérouler ces cas ici**. Cette checklist ne couvre QUE ce qui ne
> peut être vérifié qu'en conditions réelles : l'OAuth interactif lui-même, et
> le comportement de la VRAIE API Drive (My Drive, Shared Drive, expiration de
> token, hors ligne).

## 0. Client ID OAuth utilisé pour ces tests

```
940162140944-llbfni295begfk20egmvnuqd9sc37cj8.apps.googleusercontent.com
```

C'est le **même Client ID public** que celui déjà utilisé par
`tools/team-spike/index.html` (scope `drive.file`, application de type SPA,
sans `client_secret`). Il n'est PAS un secret (CLAUDE.md §2.5) : il peut être
lu, copié, embarqué en clair. Il doit être déclaré, côté console Google Cloud,
avec les **origines JavaScript autorisées** correspondant à l'URL depuis
laquelle la page de test est réellement servie (ex : `http://localhost:8000`,
ou l'URL GitHub Pages du déploiement testé) — une origine non déclarée fait
échouer `initTokenClient`/`requestAccessToken` avec une erreur explicite
(« origine non autorisée »), visible dans la console du navigateur.

## 1. Prérequis

- **Navigateur** : Chrome, Edge ou Opera **desktop** (comme pour le mode
  Dossier — File System Access API ; Google Identity Services fonctionne plus
  largement, mais on reste sur le même périmètre navigateur que le reste de
  Pilotéo pour cette passe).
- **Compte Google de test** : ajouté comme « utilisateur de test » sur l'écran
  de consentement OAuth du projet GCP associé au Client ID ci-dessus (sinon
  Google refuse la connexion avec « accès non autorisé »).
- **Un second compte Google de test** (pour la case « inviter / rejoindre » et
  la concurrence 2 onglets, §4).
- **Pilotéo servi en HTTP(S)** depuis une origine déclarée dans le Client ID
  (ouvrir directement le fichier via `file://` ne fonctionne PAS avec GIS).

## 2. Activer le mode Drive pour ce test manuel

Le contrat de ce lot ne câble QUE le transport et le provider de token
(`src/storage/google-drive-adapter.js`, `piloteo-drive-bridge.mjs`) ; le
sélecteur de dossier racine Drive (Google Picker ou saisie d'un `rootFolderId`)
et le bouton Réglages restent à câbler dans `local-backend.js` (voir le rapport
du lot pour l'emplacement exact proposé). En attendant ce câblage UI, pour
dérouler cette checklist :

1. Servir Pilotéo normalement (`python3 server.py`, ou tout serveur statique).
2. Dans la page (`index.html`), juste **avant** le chargement de
   `piloteo-drive-bridge.mjs`, injecter temporairement (DevTools → Sources →
   Overrides, ou une copie locale de `index.html` non commitée) :
   ```html
   <script>window.PILOTEO_GOOGLE_CLIENT_ID = "940162140944-llbfni295begfk20egmvnuqd9sc37cj8.apps.googleusercontent.com";</script>
   <script src="https://accounts.google.com/gsi/client" async defer></script>
   <script type="module" src="piloteo-drive-bridge.mjs"></script>
   ```
3. Dans la console du navigateur, vérifier `window.PiloteoDrive.isAvailable === true`
   (sinon : Client ID absent/mal formé — voir `src/config/runtime-config.js`).
4. Créer/obtenir un `rootFolderId` Drive (le plus simple pour ce test manuel :
   ouvrir [drive.google.com](https://drive.google.com), créer un dossier
   « Pilotéo - TEST », en copier l'id depuis l'URL `.../folders/<ID>`).
5. Dans la console : `const { engine, adapter } = await window.PiloteoDrive.createDriveEngine({ rootFolderId: "<ID>" });`
   puis dérouler la checklist ci-dessous via `engine.load()`/`engine.commit(...)`
   (ou, une fois le câblage UI fait, via le bouton Réglages).

## 3. Parcours fonctionnel à dérouler (compte A)

- [ ] **Connexion** : `oauthTokenProvider()` déclenche bien la fenêtre Google
      (compte de test A), aucune erreur de scope/origine. Vérifier dans les
      DevTools → Network qu'AUCUNE requête ne porte le token en clair dans une
      URL (il ne doit apparaître que dans l'en-tête `Authorization` des appels
      `googleapis.com`), et que la console ne l'affiche JAMAIS
      (`console.log`/`console.info`).
- [ ] **Création de l'espace sur Drive** : `engine.load()` (première fois) crée
      `workspace/manifest.piloteo`, `members/`, `events/`, `keys/`,
      `licenses/` sous le dossier racine — vérifier visuellement dans
      drive.google.com que l'arborescence attendue existe, avec des noms de
      fichiers/dossiers **opaques** (jamais de nom de client/consultant/affaire
      en clair, cf. `fileNameForKind`).
- [ ] **Écriture** : dans l'app (ou via `engine.commit(nextState)`), créer une
      saisie ; vérifier qu'un fichier `<eventId>.piloteo` apparaît dans
      `events/<AAAA-MM>/`, et que son contenu (bouton « Télécharger » sur
      drive.google.com) est un JSON exploitable.
- [ ] **Relecture** : recharger la page (nouvel `engine`, même `rootFolderId`) ;
      vérifier que la saisie créée est bien relue (`engine.load()` la retrouve).
- [ ] **Token expiré → re-consentement** : dans les DevTools, invalider le
      cache mémoire (`window.PiloteoDrive.invalidateToken()`) puis relancer une
      opération ; vérifier qu'une NOUVELLE fenêtre Google (ou un
      rafraîchissement silencieux si la session Google est encore active)
      s'ouvre, sans jamais planter l'app.
- [ ] **Offline** : couper le réseau (DevTools → Network → Offline), tenter un
      commit ; vérifier une erreur explicite et récupérable (pas de silence, pas
      de duplication au retour en ligne — relire ensuite `putImmutable`
      idempotent, §Point 4 contrat, déjà couvert par les tests automatisés).

## 4. Concurrence 2 onglets → 409

- [ ] Ouvrir DEUX onglets sur le MÊME `rootFolderId` (même compte, ou compte A
      + compte B invité sur le même dossier Drive).
- [ ] Dans l'onglet 1, modifier une saisie ; dans l'onglet 2 (état chargé
      AVANT la modification de l'onglet 1), modifier la MÊME saisie sur un
      autre champ, puis committer.
- [ ] Vérifier que le second commit reçoit bien un **409** (pas un 200
      silencieux) avec l'état rechargé incluant la modification de l'onglet 1,
      et que l'entité en conflit apparaît dans `conflicts`/`__conflicts` —
      jamais un écrasement silencieux du travail du premier onglet.
- [ ] Vérifier dans `events/<AAAA-MM>/` que les DEUX fichiers d'événements
      existent (aucun n'a écrasé l'autre — c'est la projection, pas le
      transport, qui a arbitré, cf. `docs/next/DRIVE_CONFLITS_LOCKS.md`).

## 5. Matrice Drive à cocher

| Cas | Résultat attendu | ☐ |
|---|---|---|
| **My Drive**, compte Gmail personnel | Arbre créé, écriture/relecture OK | ☐ |
| **My Drive**, compte Google Workspace | Arbre créé, écriture/relecture OK | ☐ |
| **Shared Drive** Workspace (`driveId` fourni) | `supportsAllDrives`/`includeItemsFromAllDrives` actifs (vérifier Network), écriture/relecture OK | ☐ |
| Compte **sans accès** au dossier racine | Erreur explicite (403 `authError`/`insufficientPermissions` → `AUTH_ERROR`), jamais un plantage silencieux | ☐ |
| Accès **retiré en cours de session** (propriétaire révoque le partage pendant que l'app est ouverte) | Prochaine opération échoue en `AUTH_ERROR` (403), l'app le signale | ☐ |
| **Usage intensif à plusieurs membres actifs** (quota Drive dépassé) | 403 `rateLimitExceeded`/`userRateLimitExceeded` → retry silencieux avec backoff (§8d), **PAS** une invite à se reconnecter | ☐ |
| **Token expiré** (attendre l'expiration réelle, ~1h, ou forcer via §3) | Re-consentement demandé, pas de perte de données locales pendant l'attente | ☐ |
| **Offline** pendant une écriture | Erreur récupérable ; à la reconnexion, `putImmutable` idempotent évite tout doublon | ☐ |
| **2 onglets, écriture concurrente** | 409 + état rechargé (§4) | ☐ |

## 6. Ce que cette checklist NE re-teste PAS (déjà couvert automatiquement)

`tests/next/drive-adapter-live.test.mjs` (fetch mocké, `npm run test:next`)
couvre déjà, sans navigateur : résolution/création de l'arbre de dossiers,
idempotence de `putImmutable` (dédup par nom, aucun doublon sur retry),
`IMMUTABLE_CONFLICT` sur contenu divergent, `get` absent → `null`, pagination
`listChanges` complète sur plusieurs pages/dossiers mensuels, retry
429/5xx avec backoff, et `AUTH_ERROR` immédiat sur 401. Ne pas re-dérouler ces
cas manuellement — cette checklist est réservée à ce que SEUL un navigateur
réel avec un vrai compte Google peut prouver.

Depuis la révision post-revue adverse (§8, `docs/next/DRIVE_LIVE_CONTRACT.md`),
sont ÉGALEMENT couverts automatiquement (`tests/next/attack-p4-drive-races.test.mjs`,
`tests/next/attack-p4-drive-misc.test.mjs`) : la distinction 403 quota
(`rateLimitExceeded`/`userRateLimitExceeded`/`dailyLimitExceeded` → retry) vs
403 auth (`authError`/`insufficientPermissions` → `AUTH_ERROR` immédiat), la
réconciliation déterministe de l'arbre de dossiers et des singletons à nom
constant sous `connect()`/`putImmutable` concurrents, et l'absence de saut de
`listChanges` sur collision de `createdTime` — voir
`docs/next/DRIVE_CONFLITS_LOCKS.md` §2bis pour la doctrine complète.

Round 2 (§9, `docs/next/DRIVE_LIVE_CONTRACT.md`) ajoute
(`tests/next/attack-p4r2-drive-*.test.mjs`) : `listChanges` retourne désormais
l'ensemble ordonné COMPLET à chaque appel (aucun event jamais exclu, même si
son `createdTime` Drive se révèle antérieur à un watermark déjà émis — la
redélivrance qui en résulte est sans danger, dédupliquée en amont par
`SyncEngine`/`EventLog`) ; une instance Drive déjà connectée re-résout
paresseusement (`_liveTopFolder`) le dossier top-level qu'elle utilise à
CHAQUE opération, et finit par adopter un dossier réellement plus ancien
devenu visible après coup, sans jamais redémarrer ; une lecture réussit
malgré un doublon physique surnuméraire illisible (le gagnant seul suffit) ;
deux écritures logiquement identiques (ordre de clés JSON différent) ne
déclenchent plus de faux `IMMUTABLE_CONFLICT` (sérialisation canonique) ; et
`is403QuotaBody` reconnaît aussi le format `google.rpc.Status`
(`error.status === "RESOURCE_EXHAUSTED"`), avec priorité systématique à un
motif d'auth permanent en cas de mélange auth+quota.
