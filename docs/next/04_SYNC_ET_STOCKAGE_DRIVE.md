# Pilotéo Next — Synchronisation et Google Drive

## 1. Rôle de Drive

Google Drive est un transport persistant de blobs.

Il ne doit pas :

- calculer le métier ;
- arbitrer les conflits ;
- connaître les montants en clair ;
- déterminer les droits Pilotéo ;
- contenir une base SQLite partagée monolithique.

---

## 2. Structure distante proposée

```text
Pilotéo - ACME/
  workspace/
    manifest.piloteo

  members/
    <member-id>.piloteo

  events/
    2026-08/
      <event-id>.piloteo
      <event-id>.piloteo

  keys/
    epoch-0001/
      <member-id>.key

  licenses/
    current.license
```

Tous les fichiers contenant du métier sont chiffrés.

Les noms de fichiers doivent éviter les noms de clients, consultants, affaires ou factures.

---

## 3. Immutabilité

Les fichiers `events/*` sont write-once.

Ne jamais les modifier après publication.

Avantages :

- réduit les conflits Drive ;
- simplifie l’idempotence ;
- facilite la reconstruction ;
- facilite l’audit ;
- évite le dernier-écrivain-gagne sur un gros fichier.

---

## 4. Synchronisation

Cycle minimal :

```text
1. charger cursor local
2. demander changements Drive
3. récupérer nouveaux blobs Pilotéo
4. vérifier envelope
5. vérifier signature
6. déchiffrer
7. vérifier politique
8. appliquer/rejeter/conflit
9. sauvegarder cursor
10. publier événements locaux pending
11. refaire un passage court
```

Déclencheurs :

- ouverture du workspace ;
- après modification locale ;
- bouton “Synchroniser” ;
- polling léger lorsque l’application est visible.

Pas de push serveur requis.

---

## 5. Google OAuth

Pour la PWA, utiliser Google Identity Services côté navigateur.

Principe :

- connexion/consentement par interaction utilisateur ;
- access token court ;
- appels Drive en REST/CORS ;
- aucun refresh token stocké par un backend Pilotéo.

Conséquence assumée :

> après expiration du token Google, une nouvelle action utilisateur peut être nécessaire pour reprendre la synchronisation.

Pilotéo continue néanmoins à fonctionner localement.

---

## 6. Scope Drive

Cible prioritaire : scope minimal `drive.file`.

Éviter `drive` complet.

Un spike technique doit vérifier l’UX exacte d’un membre invité avec `drive.file`, notamment :

- accès au dossier partagé ;
- découverte à partir d’un file/folder id reçu dans l’invitation ;
- besoin éventuel d’un passage Picker pour accorder explicitement l’accès à l’application.

Si `drive.file` impose un Picker lors de l’enrôlement, ce Picker fait partie du parcours d’invitation.

Ne pas élargir au scope `drive` uniquement pour éviter un clic utilisateur.

---

## 7. Permissions Drive

Lors d’une invitation Team :

1. l’admin choisit l’identité Google cible ;
2. Drive accorde l’accès nécessaire au workspace ;
3. Pilotéo génère l’invitation métier/crypto.

Drive ACL et Pilotéo membership doivent rester cohérents.

Un retrait d’utilisateur doit faire les deux :

- revoke Drive ;
- revoke Pilotéo.

---

## 8. My Drive

Accepté pour petite structure.

Limite :

- le dossier et/ou certains fichiers dépendent du compte propriétaire ;
- le départ du propriétaire doit être anticipé.

L’interface doit afficher clairement qui porte le stockage.

---

## 9. Shared Drive

Préféré pour Google Workspace.

Exigences API :

- `supportsAllDrives=true` sur les opérations concernées ;
- prise en charge de `driveId`;
- `includeItemsFromAllDrives=true` lorsque nécessaire ;
- support du change token spécifique au Drive partagé.

Le Shared Drive est recommandé car le stockage appartient à l’organisation plutôt qu’à une personne.

---

## 10. Visibilité du dossier

Pilotéo peut ne jamais exposer le dossier Drive dans son interface quotidienne.

En revanche, il ne faut pas promettre qu’un utilisateur disposant d’un accès Drive ne pourra jamais retrouver techniquement ce dossier dans l’interface Google Drive.

La promesse produit correcte est :

> l’utilisateur n’a pas besoin de manipuler le Drive pour utiliser Pilotéo.

---

## 11. `appDataFolder`

Ne pas l’utiliser pour le workspace partagé.

Le dossier d’application Google Drive est privé à l’application/utilisateur et ne peut pas être partagé.

Il peut éventuellement servir à des préférences personnelles, mais ce n’est pas nécessaire pour V2.

---

## 12. Quotas et volumétrie

Le modèle event-per-file est simple mais produit beaucoup de petits fichiers.

Pour 5–20 utilisateurs, cela reste acceptable.

Avant production, bench minimal :

- 10 000 événements ;
- 50 000 événements ;
- temps de première reconstruction ;
- temps de `changes.list`;
- nombre de requêtes ;
- taille moyenne d’événement chiffré.

Ne pas construire une compaction tant que ces mesures ne montrent pas un besoin.

---

## 13. Résilience

Un événement local n’est marqué `published` qu’après confirmation Drive.

En cas d’erreur réseau :

- rester `pending` ;
- informer “Non synchronisé” ;
- ne jamais perdre l’écriture locale.

Un événement distant déjà vu doit être ignoré sans erreur.

---

## 14. Changement de fournisseur

Le workspace doit pouvoir exporter son journal chiffré.

Le `StorageAdapter` permet plus tard :

```text
Google Drive → autre stockage
```

sans toucher au modèle métier.

Ce changement n’est pas à implémenter dans la première version.
