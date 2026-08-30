# Pilotéo Next — Cahier des charges local-first

## 1. Objet

Faire évoluer Pilotéo V1 vers une application professionnelle local-first distribuée sous forme de page web/PWA, sans backend métier Pilotéo obligatoire.

La cible doit permettre :

- de travailler seul, sans compte et sans réseau ;
- de créer une organisation ;
- de rejoindre une organisation sur invitation ;
- de travailler dans plusieurs organisations depuis la même application ;
- de synchroniser les données d’une organisation via le stockage choisi par celle-ci ;
- de conserver les données métier hors de l’infrastructure de l’éditeur ;
- de fonctionner même si l’éditeur Pilotéo ne fournit aucun serveur applicatif ;
- d’activer commercialement un workspace après une période d’essai.

Le périmètre fonctionnel métier existant de Pilotéo reste inchangé sauf décision explicite ultérieure.

---

## 2. Positionnement produit

Pilotéo devient une application **local-first**.

L’application peut être :

- ouverte depuis une URL HTTPS ;
- installée comme PWA ;
- utilisée hors connexion après chargement initial ;
- éventuellement empaquetée plus tard pour un store mobile.

L’hébergement de la page web ne doit contenir aucune donnée métier des clients.

Le stockage d’équipe est apporté par le client lui-même.

Le premier connecteur supporté est Google Drive.

---

## 3. Principes non négociables

1. **Une seule base de code applicative.**
2. **Pas de backend métier requis.**
3. **Les données en clair restent côté utilisateur.**
4. **Les données partagées quittent l’appareil chiffrées.**
5. **Le stockage distant transporte ; Pilotéo décide.**
6. **Les droits métier ne reposent pas uniquement sur les droits Drive.**
7. **Un utilisateur peut appartenir à plusieurs workspaces avec des rôles différents.**
8. **Le mode solo n’exige aucun compte Google.**
9. **Le mode Team utilise Google comme fournisseur d’identité et Drive comme premier transport.**
10. **L’expiration commerciale ne doit jamais rendre les données du client inaccessibles.**
11. **Les fonctions métier existantes ne sont pas réécrites sans nécessité.**
12. **La migration doit être réversible jusqu’à la recette finale.**

---

## 4. Parcours de démarrage

Au premier lancement, l’écran présente trois choix.

### 4.1 Créer un nouvel espace

Libellé utilisateur :

> Créer un espace pour mon entreprise ou mon équipe

Le parcours :

1. connexion Google ;
2. nom de l’organisation ;
3. choix du stockage :
   - Mon Google Drive ;
   - Drive partagé Google Workspace lorsque disponible ;
4. initialisation du workspace ;
5. création de l’identité locale du membre ;
6. attribution du rôle `owner` ;
7. démarrage de l’essai Team de 20 jours ;
8. accès à Pilotéo.

Le créateur peut ensuite inviter des membres.

### 4.2 Rejoindre une équipe

Libellé utilisateur :

> J’ai reçu une invitation

Le parcours :

1. connexion Google ;
2. saisie ou scan du code/lien d’invitation ;
3. validation de l’identité Google attendue ;
4. accès au stockage partagé ;
5. enrôlement cryptographique de l’appareil ;
6. récupération de la clé de workspace ;
7. première synchronisation ;
8. accès aux données selon les droits accordés.

Le stockage Drive ne doit pas être présenté comme une notion métier dans l’usage courant.

### 4.3 Commencer seul

Libellé utilisateur :

> Mes données restent sur cet appareil

Le parcours :

1. création d’un workspace local ;
2. aucun compte requis ;
3. persistance locale ;
4. toutes les fonctions adaptées au mode solo restent disponibles.

Un workspace solo doit pouvoir être converti plus tard en workspace Team sans réimport fonctionnel manuel.

---

## 5. Multi-workspace

Une personne peut utiliser plusieurs espaces dans la même installation.

Exemple :

- ACME — rôle consultant ;
- BetaSoft — rôle admin ;
- activité personnelle — local uniquement.

L’application doit proposer un sélecteur de workspace.

Le rôle n’est jamais global à l’utilisateur.

Modèle conceptuel :

```text
Identity
  └── Membership[]
        ├── workspaceId
        ├── role
        └── status
```

---

## 6. Identité

### 6.1 Mode local

Aucune identité distante obligatoire.

Une identité locale technique est générée pour assurer la cohérence du journal.

### 6.2 Mode Team

Google sert de fournisseur d’identité.

Pilotéo ne stocke ni mot de passe Google ni secret Google.

L’identité Google ne remplace pas l’identité cryptographique du membre.

Le lien est :

```text
identité Google
        +
identité cryptographique locale
        =
membre Pilotéo
```

L’objectif est de permettre ultérieurement d’autres fournisseurs d’identité sans changer le modèle métier.

---

## 7. Membres et rôles

Rôles initiaux :

- `owner`
- `admin`
- `user`

Les droits métier déjà existants doivent être conservés :

- utilisateur : ses temps et frais ;
- pilote : droits sur les affaires qu’il pilote ;
- admin : référentiels et données société ;
- owner : administration du workspace, membres, stockage et licence.

`owner` est un rôle de gouvernance du workspace ; il n’est pas nécessaire de créer de nouveaux pouvoirs métier s’ils ne sont pas utiles.

---

## 8. Invitations

Un owner/admin peut inviter une personne par son adresse Google.

Une invitation contient au minimum :

- `workspaceId`
- `invitationId`
- adresse ou identifiant Google attendu
- rôle proposé
- date de création
- date d’expiration
- nonce aléatoire
- preuve cryptographique d’émission

L’invitation est :

- limitée dans le temps ;
- révocable avant utilisation ;
- considérée consommée après enrôlement réussi.

Le code visible ne doit jamais être une clé maître du workspace en clair.

Le format peut être texte, lien profond ou QR code.

---

## 9. Données locales

La source locale doit être navigateur-native.

V1 cible recommandée :

- IndexedDB pour les données persistantes ;
- mémoire JS pour l’état de travail ;
- Service Worker pour la PWA/offline.

SQLite WASM n’est pas requis pour la première migration.

La couche de persistance doit être abstraite afin de pouvoir changer plus tard sans toucher au métier.

---

## 10. Modèle de synchronisation

La source de vérité partagée n’est pas un snapshot chiffré monolithique.

Pilotéo produit un journal d’événements immuables.

Exemples :

- `saisie.created`
- `saisie.updated`
- `affaire.updated`
- `mission.created`
- `member.added`
- `license.installed`

Chaque événement possède au minimum :

```json
{
  "eventId": "uuid",
  "workspaceId": "uuid",
  "entityType": "saisie",
  "entityId": "uuid",
  "operation": "update",
  "actorId": "uuid",
  "baseVersion": 12,
  "timestamp": "...",
  "payload": {},
  "signature": "..."
}
```

Le payload partagé est chiffré.

Le journal doit être rejouable pour reconstruire l’état local.

---

## 11. Concurrence

Pilotéo ne doit pas introduire un CRDT générique en V2.

Le comportement fonctionnel de la V1 est conservé :

- modifications sur deux entités différentes : fusion ;
- modifications concurrentes sur la même entité : conflit explicite ;
- aucun écrasement silencieux.

La détection peut reposer sur `baseVersion` ou un hash de version d’entité.

Une résolution champ par champ n’est pas requise.

---

## 12. Stockage distant

La logique métier ne connaît qu’un contrat `StorageAdapter`.

Fonctions minimales :

```text
connect()
putImmutable(blob)
get(id)
listChanges(cursor)
readMetadata(id)
share(member)
revoke(member)
health()
```

Premier adaptateur :

`GoogleDriveStorageAdapter`

Adaptateurs futurs possibles sans engagement de réalisation :

- OneDrive ;
- Git ;
- WebDAV ;
- S3 ;
- dossier réseau/local.

---

## 13. Google Drive

Pour une organisation utilisant un compte Google personnel, le workspace peut être placé dans le Drive du créateur.

Pour Google Workspace, un Drive partagé est préféré lorsque disponible afin de réduire la dépendance à une personne physique.

Pilotéo doit supporter les différences d’API entre My Drive et Shared Drive.

La donnée partagée sur Drive est chiffrée avant upload.

Drive ne doit jamais être considéré comme le moteur d’autorisation métier.

---

## 14. Confidentialité

Aucune donnée métier ne doit transiter par un serveur Pilotéo.

Le serveur qui héberge les fichiers statiques de la PWA ne reçoit :

- ni état métier ;
- ni token Drive ;
- ni clé de chiffrement ;
- ni journal d’événements.

Une télémétrie produit éventuelle est hors périmètre initial.

Par défaut : aucune télémétrie.

---

## 15. Chiffrement

Les événements partagés sont chiffrés côté client avec une clé de workspace.

La solution cryptographique doit :

- utiliser des primitives et bibliothèques reconnues ;
- fournir confidentialité + intégrité ;
- permettre une rotation de clé ;
- permettre l’ajout et la révocation d’un membre ;
- ne jamais embarquer de secret éditeur permettant de déchiffrer les workspaces.

Aucun algorithme cryptographique maison.

Une revue spécifique sécurité est obligatoire avant promesse commerciale de chiffrement fort.

---

## 16. Révocation

Quand un membre quitte l’organisation :

1. son accès au stockage est retiré ;
2. son membership devient révoqué ;
3. les nouveaux événements ne doivent plus être lisibles par lui ;
4. une nouvelle époque de clé peut être créée.

Il est accepté qu’un ancien membre ne puisse pas être forcé à oublier des données auxquelles il avait légitimement eu accès avant révocation.

---

## 17. Licence

### 17.1 Solo

Le mode local individuel peut rester gratuit.

Cette décision commerciale doit être configurable mais le système doit la supporter.

### 17.2 Team

Un workspace Team démarre avec 20 jours d’essai.

À expiration sans licence valide :

- consultation autorisée ;
- export autorisé ;
- récupération des données autorisée ;
- création/modification bloquée ;
- nouvelles synchronisations métier en écriture bloquées.

### 17.3 Activation

La licence est attachée au workspace, pas à l’appareil.

Elle est signée par l’éditeur.

Pilotéo embarque seulement la clé publique de vérification.

Aucun serveur d’activation n’est requis.

Un format de licence doit prévoir :

- `workspaceId`
- plan
- nombre maximal de membres
- date d’émission
- date d’expiration éventuelle
- features éventuelles
- signature

---

## 18. PWA

La cible de distribution principale est une PWA HTTPS.

Exigences :

- manifest ;
- service worker ;
- ressources statiques versionnées ;
- fonctionnement hors ligne après premier chargement ;
- politique de mise à jour contrôlée ;
- aucun CDN requis pour les fonctions vitales.

L’ouverture directe en `file://` n’est pas une cible supportée.

---

## 19. Migration depuis la V1 serveur

Un administrateur doit pouvoir exporter l’état canonique de la V1 puis créer un workspace Next à partir de cet état.

La migration doit :

- conserver tous les identifiants existants ;
- conserver toutes les entités métier ;
- créer un événement initial `workspace.imported`;
- produire ensuite un état local identique fonctionnellement ;
- ne pas modifier la base V1 d’origine.

La V1 reste disponible en lecture pendant la période de validation.

---

## 20. Hors périmètre

Ne pas implémenter sans besoin explicite :

- backend SaaS multi-tenant ;
- CRDT complet ;
- blockchain ;
- messagerie temps réel ;
- push temps réel ;
- partage public ;
- pièces jointes ;
- synchronisation P2P ;
- anti-tamper fort ;
- fingerprint matériel ;
- serveur d’activation ;
- paiement intégré ;
- store mobile natif ;
- chiffrement champ par champ distinct ;
- rôles configurables arbitrairement.

---

## 21. Critères de succès

La migration est considérée réussie si :

1. un utilisateur peut travailler seul hors ligne ;
2. un owner peut créer un workspace Team ;
3. un second utilisateur peut rejoindre avec une invitation ;
4. les deux utilisateurs convergent après modifications sur entités distinctes ;
5. un conflit sur la même entité est visible et n’écrase rien ;
6. Drive ne contient aucune donnée métier en clair ;
7. une personne sans droit métier ne peut pas faire accepter une opération interdite ;
8. une révocation bloque les nouvelles données ;
9. un workspace peut être reconstruit depuis son journal ;
10. un état V1 réel peut être migré ;
11. une licence valide est reconnue localement ;
12. l’expiration ne bloque jamais l’export ;
13. Pilotéo fonctionne sans backend métier éditeur.
