# Pilotéo Next — Licence et essai

## 1. Objectif

Permettre un modèle commercial sans réintroduire un backend Pilotéo.

La licence est vérifiée localement.

Elle porte sur un workspace.

---

## 2. Règles

### Local

Configuration recommandée :

- workspace local 1 utilisateur : gratuit.

La mécanique doit cependant permettre ultérieurement un changement de politique.

### Team

- essai : 20 jours ;
- essai attaché au workspace ;
- toutes fonctions Team disponibles pendant l’essai ;
- bannière avant expiration ;
- lecture/export après expiration ;
- écriture bloquée après expiration.

---

## 3. Début d’essai

Créé lors de `workspace.created`.

Dans un workspace Team, conserver aussi un ancrage distant créé lors de l’initialisation Drive.

Ne pas promettre une protection anti-fraude absolue sans serveur.

La protection vise l’usage professionnel normal, pas un attaquant qui modifie le code de la PWA.

---

## 4. Format de licence

Payload conceptuel :

```json
{
  "format": "piloteo-license-v1",
  "licenseId": "uuid",
  "workspaceId": "uuid",
  "plan": "TEAM",
  "maxMembers": 20,
  "issuedAt": "2026-09-01T00:00:00Z",
  "notBefore": "2026-09-01T00:00:00Z",
  "expiresAt": "2027-09-01T00:00:00Z",
  "features": [],
  "signature": "..."
}
```

Pour licence perpétuelle :

`expiresAt = null`

---

## 5. Signature

L’éditeur conserve hors application :

- clé privée de signature.

Pilotéo embarque :

- clé publique de vérification.

Aucun secret de génération de licence dans la PWA.

Le format signé doit être canonique afin qu’une même licence ait un message déterministe.

---

## 6. Installation

L’owner :

> Administration → Licence → Activer

Méthodes V1 :

- coller une clé ;
- importer un fichier licence.

La licence valide est enregistrée dans le workspace et répliquée pour les autres membres.

Ils n’ont rien à saisir.

---

## 7. Membres

`maxMembers` est vérifié sur les memberships actifs.

Un dépassement ne supprime aucun membre ni donnée.

Comportement recommandé :

- blocage de l’ajout du membre suivant ;
- message expliquant la limite ;
- fonctions existantes inchangées.

---

## 8. Expiration

À expiration :

Autorisé :

- ouvrir ;
- consulter ;
- rechercher ;
- exporter ;
- sauvegarder ;
- accéder à la licence.

Bloqué :

- nouvelles commandes métier ;
- nouvelles modifications ;
- nouvelle invitation.

Les données locales et distantes ne sont jamais supprimées.

---

## 9. Renouvellement

Une nouvelle licence remplace la précédente si :

- signature valide ;
- workspace identique ;
- fenêtre de validité acceptable.

Garder l’historique minimal des licences installées pour support.

---

## 10. Limites assumées

Sans serveur d’activation :

- l’horloge locale est manipulable ;
- le JavaScript peut être patché par un utilisateur expert ;
- un utilisateur peut créer un nouveau workspace pour obtenir un nouvel essai.

Ne pas réintroduire un backend uniquement pour empêcher ces cas tant qu’ils ne représentent pas une fraude commerciale réelle.

---

## 11. Générateur de licence

L’outil de génération ne fait pas partie de la PWA publique.

Il peut être :

- script CLI local éditeur ;
- petite application interne ;
- workflow CI manuel sécurisé.

Entrées :

```text
workspaceId
plan
maxMembers
expiresAt
```

Sortie :

```text
license key / license file
```

Le générateur doit être documenté et sauvegardé séparément.
