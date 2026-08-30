# 7. Décisions d'architecture et limites assumées

Synthèse transversale ; chaque décision référence le module qui la porte
(l'en-tête du fichier source contient toujours la justification complète —
ce document n'en est qu'un condensé de navigation).

## 7.1 Invariants absolus (`docs/next/08_AI_HANDOFF.md`)

Ces 15 invariants gouvernent tout le lot livré ; ils sont vérifiés
respectés dans le code lu pour cette documentation :

1. Pas de backend métier Pilotéo — respecté : aucun module `src/` n'appelle
   `server.py` ni un service Pilotéo distant.
2. Pas de donnée métier en clair sur Drive — respecté en intention
   (`CryptoService.encryptPayload` avant `putImmutable`) mais **non vérifiable
   en conditions réelles** tant que le réseau Drive n'est pas câblé (§7.3).
3. Pas de mot de passe Pilotéo Team — respecté (identité Ed25519/X25519 +
   Google Identity, jamais de mot de passe applicatif).
4. Mode solo sans Google — respecté (`createLocalWorkspace`).
5. Les droits sont vérifiés sur chaque événement — respecté
   (`SyncEngine#_processIncoming` étape 6, jamais une vérification côté UI
   seule).
6. Une UI masquée n'est jamais une sécurité — respecté structurellement
   (voir 02-securite-crypto-identite.md).
7. Conflit même entité = explicite — respecté (`conflict.js#classify`,
   jamais d'écrasement silencieux).
8. Entités différentes = convergence — respecté (chaque entité indexée
   indépendamment dans la projection).
9. Event log rejouable — respecté (`EventLog#replay`).
10. Projection reconstructible — respecté (même invariant, testé).
11. Export toujours possible — respecté (`LocalStore.exportBackup`,
    `enforcement().export === true` même en licence expirée).
12. Licence par workspace — respecté (`license.workspaceId`, vérifié dans
    `verifyLicense`).
13. Pas de secret éditeur dans le client — respecté : `EDITOR_PUBLIC_KEY_JWK`
    est un placeholder à remplacer par une clé **publique**, jamais privée ;
    `tools/license-gen/` est explicitement hors PWA.
14. Ne pas élargir le scope Drive sans preuve de nécessité — respecté
    (`DRIVE_SCOPE = drive.file`, jamais `drive` complet ; `appDataFolder`
    délibérément écarté).
15. Ne pas introduire CRDT, framework ou backend « pour faire propre » —
    respecté (résolution de conflit par version d'entité + conservation
    explicite, pas de CRDT ; aucun framework front introduit dans `src/`).

## 7.2 Arbitrages pris lors de la lecture du code (à connaître pour la suite)

Ces points ne sont pas des incohérences, mais des choix de conception que
plusieurs modules documentent explicitement en tête de fichier — utile à
rappeler ici pour qui reprendrait le projet sans relire chaque en-tête :

- **`PolicyEngine.evaluate` n'émet jamais `"conflict"`** — la signature
  générale du contrat (`CONTRACTS.md` §7) admet cette valeur, mais ce module
  se limite à `"accept"|"reject"` ; la concurrence est un ressort séparé
  (`events/conflict.js`), appelé plus tard dans le pipeline du `SyncEngine`.
- **`__versions[...]` porte `{version, lastEventId}`**, pas un entier brut —
  extension déclarée du contrat de reducer, nécessaire pour distinguer un
  doublon (même `eventId` rejoué) d'un vrai conflit (deux événements
  distincts au même `baseVersion`).
- **Genesis d'import V1 sous deux formes simultanées** (série de `create`
  standards + marqueur d'audit `workspace.imported` hors reducer) plutôt
  qu'une seule — la mission autorisait explicitement les deux, et la
  combinaison évite de réimplémenter la logique de reducer pour l'audit.
- **Invitations : `proof` retombe sur un hash SHA-256 non-secret sans
  `signer`** — dette explicite en attendant le branchement du vrai
  `CryptoService.sign` dans ce module ; ne doit pas être confondu avec une
  vraie signature d'identité.
- **`filterProjectionForRole` renvoie une vue vide** pour un membership
  absent/révoqué en lecture — la V1 n'a pas de contrat explicite pour ce cas
  précis ; le choix le plus restrictif a été retenu.

## 7.3 Limites assumées — honnêtes, à ne pas masquer

### Google Drive non branché en live

`GoogleDriveStorageAdapter` est un **squelette** : toute méthode réseau lève
`NotWiredError`. Aucun test du dépôt n'exerce un vrai appel Drive. Le spike
technique demandé par `docs/next/04` §6 (comportement exact de `drive.file`
pour un utilisateur invité, besoin d'un Picker) **n'a pas été mené**. Tant
que ce spike et le câblage OAuth ne sont pas faits, les Phases 6/7/10 de la
roadmap ne peuvent pas être closes, et l'invariant 2 (« pas de donnée métier
en clair sur Drive ») reste une **intention testée en isolation**
(`CryptoService` seul), pas une garantie de bout en bout vérifiée sur le
vrai transport.

### Crypto à auditer avant promesse commerciale

`crypto-service.js` implémente des primitives standard WebCrypto
(Ed25519, AES-256-GCM, X25519+HKDF), couvertes par des tests unitaires
(`tests/next/crypto.test.mjs`), mais **pas revues par un humain compétent en
sécurité**. `docs/next/05` §16 fixe ce gate comme condition avant toute
promesse commerciale de « chiffrement de bout en bout, l'éditeur ne peut pas
lire les données ». Ne pas commercialiser cette promesse sans lever ce gate.

### Serveur V1 conservé (réversibilité)

`server.py`, `app.js`, Docker, SQLite serveur sont **intacts** dans ce
dépôt — aucun retrait n'a eu lieu (Phase 10 non entamée). C'est volontaire :
`docs/next/03` §4 pose qu'il n'y a « pas de point de non-retour avant la
Phase 10 ». La V1 reste donc l'implémentation de référence en production tant
que les gates 6/7/10 ne sont pas levés.

### PWA à câbler en Phase 2 (au sens du présent lot)

Les modules `src/` sont des bibliothèques ES pures, testées sous Node — ils
ne sont **pas encore intégrés** dans `app.js`/`index.html`. Aucune UI
n'utilise `WorkspaceRuntime`, `SyncEngine`, `PolicyEngine` ou `LocalStore` à
ce stade. L'intégration (remplacer les mutations directes de `app.js` par des
appels à ces modules, brancher une CSP stricte contre le XSS — `docs/next/05`
§11) reste à faire.

### Anti-fraude licence offline limité

Sans serveur d'activation, l'horloge locale est manipulable, le JavaScript
de la PWA est patchable par un utilisateur expert, et un utilisateur peut
créer un nouveau workspace pour obtenir un nouvel essai
(`tools/license-gen/README.md`, `docs/next/06` §10). C'est une limite
**assumée et documentée**, pas une négligence : ne pas réintroduire un
backend Pilotéo pour la fermer tant qu'elle ne représente pas une fraude
commerciale réelle.

### Clé publique éditeur placeholder

`EDITOR_PUBLIC_KEY_JWK` dans `src/license/license.js` est un placeholder
inerte — toute vérification de licence échoue tant qu'elle n'est pas
remplacée par la sortie réelle de `tools/license-gen/generate-license.mjs`.
À faire avant toute distribution de la PWA à un client réel.

## 7.4 Incohérences repérées entre spec et code livré

Aucune incohérence factuelle significative entre `docs/next/*`,
`src/CONTRACTS.md`/`src/V1_DOMAIN_MAP.md` et le code lu — les en-têtes de
chaque module citent explicitement leur référence normative et documentent
tout écart (voir §7.2 ci-dessus, qui liste les seuls écarts trouvés, tous
volontaires et déjà expliqués dans le code). Deux points mineurs à signaler
pour un futur relecteur :

- `docs/next/03` Phase 9 suggère un écran V1 « Administration → Export
  migration Pilotéo Next » pour produire l'export `piloteo-v1-export` — cet
  écran **n'existe pas** dans `app.js`/`server.py` de ce dépôt.
  `src/migration/v1-import.js` consomme un export déjà produit selon le
  format documenté, sans dépendre de la façon dont il a été généré ; ce n'est
  donc pas bloquant pour les tests, mais l'outil de production de l'export
  V1 reste à écrire si l'on veut exécuter la Phase 9 sur une organisation
  réelle.
- `src/CONTRACTS.md` §7 mentionne `"conflict"` comme valeur possible du
  retour de `PolicyEngine.evaluate`, alors que l'implémentation ne l'émet
  jamais (voir §7.2) — le contrat documente la forme générale admissible,
  l'implémentation fait un choix plus restrictif et l'explique ; à noter si
  un futur appelant du `PolicyEngine` s'attendait à recevoir `"conflict"`
  directement de ce module plutôt que de l'obtenir via `EventLog#replay`.
