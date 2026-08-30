# Pilotéo Next — Sécurité, cryptographie et identité

## 1. Modèle de menace

Pilotéo Next protège contre :

- lecture accidentelle ou non autorisée du stockage Drive ;
- vol/copie des blobs Drive sans possession des clés ;
- modification d’un blob distant ;
- utilisateur authentifié tentant une opération métier interdite ;
- utilisateur révoqué tentant de continuer à recevoir les nouvelles données ;
- collision/duplication d’événements ;
- client modifié essayant de contourner l’UI.

Il ne prétend pas protéger contre :

- poste utilisateur totalement compromis ;
- malware avec accès au navigateur déverrouillé ;
- administrateur légitime exfiltrant des données auxquelles il a accès ;
- ancien membre ayant copié les données avant révocation ;
- reverse engineering complet de la PWA ;
- attaque physique avancée sur un terminal.

---

## 2. Principe

```text
Google prouve l’accès à un compte.
Drive contrôle l’accès au stockage.
La crypto protège le contenu.
Pilotéo vérifie les droits métier.
```

Aucun de ces contrôles n’est remplacé par un autre.

---

## 3. Clé de workspace

Chaque workspace Team possède une clé de chiffrement courante appelée `workspace epoch key`.

Exemple :

```text
epoch 1
epoch 2
...
```

Lors d’une révocation, une nouvelle epoch peut être créée.

Les nouveaux événements utilisent la nouvelle clé.

Les anciennes données restent lisibles pour les membres qui possèdent encore les anciennes clés.

---

## 4. Identité de membre

Chaque installation/membre possède une identité cryptographique.

Le choix exact des primitives doit être arrêté après spike de compatibilité et revue sécurité.

Exigences :

- signature ;
- vérification publique ;
- génération locale ;
- clé privée non exportée par défaut ;
- clé publique partageable.

Éviter toute cryptographie inventée à la main.

---

## 5. Chiffrement des événements

Exigences minimales :

- chiffrement authentifié AEAD ;
- nonce unique ;
- clé 256 bits si algorithme correspondant ;
- authentification de l’enveloppe ;
- versionnement du format ;
- refus de tout événement corrompu.

Une implémentation Web Crypto est possible, mais l’API est de bas niveau : une revue de conception est requise.

---

## 6. Stockage des clés locales

Dans une PWA, le stockage secret parfait n’existe pas.

V2 doit :

- stocker les matériaux de clé dans IndexedDB sous forme non exportable lorsque l’API le permet ;
- limiter les copies ;
- ne jamais mettre de clé dans `localStorage` ;
- ne jamais logger les clés ;
- ne jamais inclure une clé privée dans un export standard.

Sur une future app native, Android Keystore/iOS Keychain pourront améliorer ce point.

---

## 7. Enrôlement

Flux conceptuel :

```text
Admin invite Alice
  ↓
Drive autorise le compte Google d’Alice
  ↓
Alice rejoint avec code
  ↓
Alice génère/fournit sa clé publique
  ↓
workspace l’ajoute comme membre
  ↓
clé d’epoch rendue accessible à Alice
```

Le code d’invitation ne doit pas contenir une clé maître réutilisable en clair.

---

## 8. Révocation

Séquence :

1. membership → `revoked`;
2. permission Drive supprimée ;
3. nouvelle epoch de clé ;
4. nouvelle clé distribuée aux membres restants ;
5. nouveaux événements chiffrés avec nouvelle epoch.

Les clients doivent refuser toute nouvelle opération signée par un membre révoqué après le point de révocation connu.

---

## 9. Droits métier

Porter la logique actuelle de `server.py::can_change()` vers `PolicyEngine`.

Ne jamais considérer qu’un événement est autorisé parce qu’il a pu être écrit dans Drive.

Un client hostile peut fabriquer un blob.

Ordre de traitement :

```text
parse envelope
verify signature
decrypt
validate schema
verify membership
verify policy
verify concurrency
apply
```

---

## 10. Validation des données

La cible doit corriger la faiblesse identifiée dans la V1.

Toute commande/événement est validé structurellement avant application.

Exemples :

- nombres finis uniquement ;
- types stricts ;
- enums ;
- dates ;
- ids ;
- bornes simples ;
- références compatibles ;
- payload limité en taille.

Les règles métier existantes restent séparées des validations de structure.

---

## 11. XSS

Le passage local-first rend le XSS encore plus critique, car le navigateur détient les clés.

Conserver et renforcer :

- CSP stricte ;
- aucun `unsafe-inline` ;
- échappement systématique ;
- dépendances minimales ;
- aucune bibliothèque chargée depuis CDN ;
- versionnage/verrouillage des dépendances ;
- intégrité de build.

Un XSS dans Pilotéo peut lire des données déchiffrées du workspace.

---

## 12. Distribution PWA

HTTPS obligatoire.

L’intégrité du code livré devient une frontière de sécurité.

Recommandations :

- build reproductible ;
- release versionnée ;
- cache Service Worker contrôlé ;
- rollback possible ;
- pas de mise à jour silencieuse au milieu d’une session critique ;
- affichage de la version dans l’application.

---

## 13. Identité Google

Google ne doit servir qu’au mode Team.

Mode solo : aucune dépendance Google.

Ne jamais traiter l’adresse email comme secret cryptographique.

Utiliser un identifiant Google stable lorsqu’il est disponible, et conserver l’email comme attribut d’affichage/enrôlement.

---

## 14. Audit

Le journal d’événements fournit déjà :

- acteur ;
- date déclarée ;
- opération ;
- cible ;
- signature.

Ajouter un journal local des événements rejetés/conflits.

Ne pas développer un SIEM.

---

## 15. Sauvegarde

En local :

- export complet chiffré/manual ;
- possibilité de reconstruire depuis le journal.

En Team :

- Drive fournit la réplication distante ;
- l’utilisateur doit néanmoins pouvoir exporter un package de récupération.

Format recommandé :

```text
.piloteobackup
```

contenant :

- manifest ;
- événements chiffrés ;
- métadonnées nécessaires ;
- jamais les clés privées des autres membres.

---

## 16. Revue avant production

Avant de commercialiser la promesse “données chiffrées de bout en bout / l’éditeur ne peut pas les lire”, faire relire :

- format crypto ;
- distribution des clés ;
- invitation ;
- rotation ;
- CSP ;
- stockage local des clés ;
- recovery.

Cette revue est un gate, pas une option cosmétique.
