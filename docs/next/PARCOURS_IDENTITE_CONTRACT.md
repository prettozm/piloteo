# Contrat — Parcours d'identité & d'appartenance (modèle mental simplifié)

> Fige le modèle mental validé avec l'utilisateur : Pilotéo ne gère PAS de
> « comptes ». Il gère des **identités locales** et des **appartenances**
> (memberships) à des **workspaces**. Trois règles fondamentales, non
> négociables, servent d'oracle :
>
> 1. L'utilisateur possède une **identité locale** (créée sur son poste).
> 2. Le **stockage externe** (dossier/OneDrive/SharePoint/Drive/NAS) détermine
>    s'il peut *physiquement accéder* aux données — hors périmètre Pilotéo.
> 3. L'**invitation** (signée) détermine s'il est *membre* de l'organisation ;
>    le **membership** (rôle vérifié) détermine ce qu'il a le *droit de faire*.
>
> Accès au stockage et droits Pilotéo sont DEUX choses différentes.
>
> `app.js`/`server.py` restent INTACTS (CLAUDE.md §1) : tout passe par
> `local-backend.js`, les ponts ES et `src/*`. Sécurité d'abord (CLAUDE.md §4).

Ce contrat ne réécrit PAS l'existant : il fige les **écarts** entre le code
actuel et le modèle cible. Ce qui suit est déjà construit et NE change pas —
seulement à préserver en non-régression :
- identité locale + workspace + membership, sans comptes serveur ;
- solo ⇒ owner ; invitation signée Ed25519 (rôle, `usage=1`, expiration) ;
  chaîne de confiance durcie (liste blanche de champs vérifiés, `consultantId`
  signé, genèse depuis le manifeste — ORG_TRUST_HARDENING_CONTRACT.md) ;
- events immuables un-par-fichier, `parentEventId`, conflit = deux descendants
  du même parent (jamais last-write-wins, branche perdante non ressuscitable) ;
- `workspace.json` = manifeste genesis write-once ; join = identité locale +
  choix du dossier + membership ; invite UI (rôle + code 14 j).

---

## Lot 1 — Accueil à deux choix

**Constat.** `renderWelcomeScreen()` (`local-backend.js`) affiche 3 cartes :
« Utiliser seul », « Créer une organisation », « Rejoindre une organisation ».

**Exigence.** Au **premier lancement**, exactement DEUX choix :
- **[ Travailler seul ]** — crée l'identité locale + workspace solo + membership
  owner, tout en IndexedDB (comportement solo actuel). Aucune question de rôle.
- **[ Rejoindre une organisation ]** — flux join existant (choisir le dossier
  partagé + coller le code).

« Créer une organisation » DISPARAÎT de l'accueil : la création d'org devient
l'action **« Partager cet espace »** (Lot 2), accessible depuis Réglages une
fois qu'on travaille en solo. Aucune question « êtes-vous administrateur ? » :
l'administration DÉCOULE du geste (créer seul ⇒ owner ; rejoindre ⇒ rôle de
l'invitation).

**Contrainte.** Ne pas casser le flux « Rejoindre » (dossier + Drive). Le lien
« Créer / rejoindre une organisation » du panneau Réglages (ligne ~1969) est
remplacé par « Partager cet espace » (Lot 2) + « Rejoindre une organisation ».

**Tests.** e2e (statique, style `static-hardening-solo.mjs`) : au premier
lancement, exactement 2 cartes ; « Créer une organisation » absente de l'accueil ;
« Travailler seul » démarre en solo owner ; « Rejoindre » ouvre le flux code.

---

## Lot 2 — « Partager cet espace » : promotion en place (MÊME workspaceId)

**Constat.** `createOrganization({ name, identity, consultantId })`
(`org-runtime.js`) génère un **NOUVEAU** `workspaceId` (`ws.id`). Il n'existe
aucun chemin « promouvoir mon workspace solo en org partagée ».

**Exigence.** Depuis Réglages en solo, **« Partager cet espace »** :
1. demande OÙ stocker les données partagées (dossier / Drive), vérifie
   lecture + écriture (le seul contrôle d'accès au stockage) ;
2. **conserve le `workspaceId` solo** (`W-001 Local → W-001 Shared`) — PAS de
   nouveau workspace, PAS un « export → nouvelle org » ;
3. écrit le manifeste genesis dans le dossier avec CE `workspaceId`, l'identité
   solo comme **owner** (clé publique owner ancrée write-once) ;
4. **republie les événements solo existants** dans le dossier partagé (events
   immuables un-par-fichier), de façon idempotente et sûre (réutilise le
   pipeline de migration Point 5 / `snapshotToEventsDiff` — pas de perte, pas de
   doublon, `parentEventId` préservé) ;
5. bascule le mode de stockage sur le dossier/Drive choisi APRÈS vérification
   d'un aller-retour réussi (gate `verifyRoundTrip` existant) ; en cas d'échec,
   **rollback** : on reste en solo, données intactes (règle Point 5).

**Invariants de sûreté (oracle).**
- Le `workspaceId` après promotion == le `workspaceId` solo d'origine.
- Aucune donnée solo perdue ni dupliquée (projection identique avant/après,
  `verifyRoundTrip`).
- Le manifeste genesis est write-once : une seconde promotion du même workspace
  ne réécrit pas le manifeste ni ne crée un second owner.
- L'owner de l'org == l'identité solo (même clé publique) ; il obtient le rôle
  `owner` depuis le manifeste, jamais depuis une fiche falsifiable.

**Tests.**
- unit (`tests/next/`) : `promoteSoloToOrg` (ou équivalent) — workspaceId
  préservé ; events solo republiés (compte + contenu) ; manifeste owner =
  identité solo ; idempotence (2e appel = no-op sûr) ; rollback si écriture
  refusée.
- e2e : solo avec données → « Partager cet espace » → dossier choisi → org
  active, workspaceId inchangé, données visibles, owner = moi.
- non-régression : `createOrganization` (org neuve, sans promotion) marche
  toujours pour le flux « Rejoindre » côté owner d'une org fraîche si utilisé.

---

## Lot 3 — Rôle du membre : « rattaché à un consultant » OU « user global »

**Constat.** `src/core/permissions.js` : `isAdmin` (owner/admin) voit tout ;
tout non-admin est scopé par `actorMembership.consultantId` (un `user` sans
`consultantId` ne voit/écrit RIEN). Il n'existe pas de rôle « non-admin qui voit
tout ».

**Exigence (choix de l'owner À L'INVITATION).** L'owner/admin, en générant
l'invitation, choisit l'un des trois :
- **Administrateur** (`role="admin"`) — voit et administre tout (existant).
- **Utilisateur rattaché à un consultant** (`role="user"`, `consultantId=<X>`) —
  vue restreinte aux données du consultant X (existant ; `consultantId` déjà
  signé dans l'invitation — ORG_TRUST_HARDENING_CONTRACT.md).
- **Utilisateur global** (NOUVEAU) — non-admin (ne peut PAS inviter/révoquer/
  modifier la gouvernance ni les réglages d'org), mais voit/écrit les données
  métier sans restriction de consultant.

**Modèle de droits (oracle, `permissions.js`).** Introduire une distinction
explicite et VÉRIFIÉE (portée par l'invitation signée, jamais auto-déclarée) :
- représentation : le « user global » est un `role="user"` avec un marqueur
  `scope="global"` (ou `consultantId=null` + `scope="global"`) — le marqueur DOIT
  être signé dans l'invitation au même titre que `role`/`consultantId`
  (`invitations.js#canonicalPayload`), et repris dans `buildTrustedMembership`
  UNIQUEMENT depuis l'invitation vérifiée (liste blanche — jamais
  `record.membership.*`). Choisir la représentation la plus simple qui ne
  contredit pas la liste blanche existante.
- `evaluate()` : `admin` ⇒ accept ; `user global` ⇒ accept sur les entités
  métier (mêmes règles qu'un admin pour les données, MAIS refus sur la
  gouvernance/réglages) ; `user rattaché` ⇒ scope `consultantId` (inchangé).
- `filterProjectionForRole()` : `user global` voit toute la projection métier ;
  `user rattaché` voit sa tranche (inchangé).
- **Anti-escalade (impératif) :** un `user rattaché` ne peut pas devenir global,
  ni un `user` devenir `admin`, en éditant sa fiche : la portée provient
  EXCLUSIVEMENT de l'invitation signée. Un marqueur `scope` non signé / divergent
  ⇒ traité comme le plus restrictif (rattaché ou rien), JAMAIS global.
- Ne PAS confier de décision de sécurité à un champ non vérifié (rappel des 5
  tours contrariant). « Global » est un privilège : il doit être PROUVÉ par la
  signature de l'owner, sinon refusé.

**Contrainte app.js (mapping ARRÊTÉ — feasibility confirmée).** `app.js`
(ligne 627) porte une visibilité de navigation BINAIRE : `role==="admin"` voit
toute la nav, sinon la plupart des vues sont masquées. Il n'a pas de concept
« non-admin qui voit tout ». Résolution SANS toucher `app.js` :
- `/api/me` présente le **user global** à `app.js` avec **`role:"admin"`**
  (nav métier complète). C'est un choix d'AFFICHAGE : `app.js` est une UI, la
  seule enforcement réelle est `permissions.js` côté backend local (chaque
  écriture passe par `/api/state` → moteur org → `evaluate()`).
- La gouvernance d'organisation (Réglages › Membres › Inviter/Révoquer,
  `local-backend.js` ~1884/1910) lit le **vrai rôle org**
  (`orgEngineRef.membership.role`), PAS `/api/me` : un user global (rôle org
  `user`+`scope:global`) n'y voit donc NI Inviter NI Révoquer. La distinction
  admin vs user-global = « gère les membres de l'org » vs « ne les gère pas » ;
  les deux voient toutes les données métier.
- `permissions.js` DOIT refuser à un user global toute écriture de gouvernance
  (fiches membres/invitations/révocations), même si `app.js` lui montre la nav
  admin. Le rôle org réel (`user`+`scope:global`) et sa portée viennent
  EXCLUSIVEMENT de l'invitation signée — jamais de `/api/me` (qui ment à
  `app.js` pour l'affichage) ni d'une fiche falsifiable.
- Interprétation figée de « n'administre pas » = **ne gère pas les membres de
  l'organisation** (inviter/révoquer/rôles). Éditer les données métier de
  référence (consultants, TJM…) n'est PAS de l'administration au sens de ce
  modèle : un user global le peut (ce sont des données métier).

**Tests.**
- unit (`tests/next/`) : `evaluate`/`filterProjectionForRole` pour les 3 rôles ;
  `user global` voit tout le métier mais REFUS sur gouvernance/réglages ;
  `user rattaché` limité à son consultant.
- sécurité (dans `org-trust-hardening.test.mjs` ou dédié) : une fiche membre qui
  déclare `scope="global"` SANS invitation signée correspondante ⇒ jamais
  admise comme globale (repro type « escalade », CASSÉ→TENU).
- non-régression : les rôles existants (owner/admin/user rattaché) inchangés.

---

## Lot 4 — Invite UI enrichie

**Constat.** L'invite UI (`local-backend.js` ~1938) a un sélecteur de rôle +
bouton « Inviter » → `PiloteoOrg.invite({ role, ttlDays:14 })`. Elle ne passe NI
nom, NI consultant/scope.

**Exigence.** Réglages › Membres › Inviter :
- champ **Nom** (information/contrôle ; email optionnel, purement informatif —
  jamais utilisé pour une décision de sécurité, cf. liste blanche) ;
- sélecteur **Rôle** : Administrateur / Utilisateur ;
- si « Utilisateur » : choix **Rattaché à un consultant** (liste des consultants
  de la projection) OU **Accès global** ;
- génère l'invitation SIGNÉE portant `role` + (`consultantId` OU `scope="global"`)
  + `ttl` ; affiche le code (et idéalement un QR — optionnel, non bloquant).
- `PiloteoOrg.invite` / `inviteMember` acceptent ces paramètres (le pont passe
  déjà `consultantId` — ajouter `scope`/`displayName`).

**Tests.**
- e2e (`org-onboarding*.mjs`) : owner invite un « user rattaché » → le membre
  admis a la vue restreinte ; owner invite un « user global » → vue complète
  non-admin ; le nom apparaît dans la liste des membres.
- non-régression : invitation « admin » et « user rattaché » inchangées.

---

## Contraintes transverses (toutes les lots)
- `app.js`/`server.py` INTACTS. Aucun secret dans le dépôt.
- `npm run test:next` reste vert (435 actuellement) ; e2e Chromium verts.
- Boucle CLAUDE.md §3 : maker → vérificateur → contrariant. Le Lot 3
  (moteur de droits) et le Lot 2 (promotion en place, intégrité des données)
  sont SENSIBLES : contrariant obligatoire avec repro d'attaque
  (escalade de portée, perte/duplication de données, double manifeste).
- Cohérence dev↔prod : la promotion en place doit fonctionner en dossier ET en
  Drive (mobile inclus) ; republication `/app/` + port `piloteo-src` après
  validation.
