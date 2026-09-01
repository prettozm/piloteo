# Pilotéo — Architecture V1

## 1. Intention

La V1 vise un cabinet d'environ cinq utilisateurs. Le besoin n'est pas de construire une plateforme générique mais de rendre le prototype existant réellement utilisable à plusieurs, avec un niveau professionnel raisonnable : identité réelle, isolation des données, persistance, synchronisation, sauvegarde et support.

## 2. Composants

```text
Navigateur utilisateur
        │ HTTPS
        ▼
Reverse proxy de l'entreprise
        │ HTTP local / réseau privé
        ▼
server.py  ─────► SQLite (data/piloteo.sqlite3)
   │                   │
   ├── sert index.html │
   ├── auth / droits   ├── app_state
   ├── synchro         ├── state_history
   ├── audit           ├── users / sessions
   └── sauvegarde      └── audit_log
        │
        ▼
backups/*.sqlite3
```

Une seule instance applicative est attendue. SQLite en mode WAL est adapté à ce volume et évite de déployer un SGBD supplémentaire sans besoin réel.

## 3. Où vit le métier

- `index.html` : interface, calculs, règles de cohérence, écrans, formulaires et visualisations déjà validés dans le prototype.
- `server.py` : sécurité et infrastructure uniquement : authentification, autorisation, stockage, synchronisation, audit, sauvegarde.
- `seed.json` : jeu initial utilisé seulement quand la base n'existe pas encore.

Cette séparation est volontairement imparfaite mais proportionnée. Une future API CRUD normalisée ne sera utile que si la taille, les intégrations ou la concurrence d'écriture l'imposent.

## 4. Persistance

La base SQLite ne normalise pas encore les quatorze entités métier. Elle conserve l'état fonctionnel complet en JSON dans `app_state`, avec :

- `revision` : version monotone de l'état ;
- `state_history` : historique court utilisé pour détecter les conflits ;
- transaction `BEGIN IMMEDIATE` pour sérialiser une écriture ;
- WAL pour permettre lecture et écriture avec un petit nombre d'utilisateurs.

Ce choix évite une migration risquée de toute la logique métier dès la première mise en production. Le document `modele-de-donnees.md` reste la base d'une future normalisation si elle devient nécessaire.

## 5. Synchronisation

Le navigateur :

1. charge l'état autorisé et sa `revision` ;
2. garde l'état en mémoire, jamais en `localStorage` ;
3. après une modification, envoie l'état visible avec sa `base_revision` ;
4. le serveur calcule les différences depuis cette révision ;
5. si une autre personne a modifié une **autre** donnée, les deux modifications sont fusionnées ;
6. si la même donnée a changé des deux côtés, le serveur répond `409 Conflict` ; le navigateur recharge la version serveur et demande implicitement de refaire la saisie ;
7. sans modification locale, le navigateur vérifie toutes les 10 secondes si une révision plus récente existe.

L'indicateur de la barre latérale affiche `Synchronisé`, `Synchronisation…`, `Non synchronisé`, `Modification refusée` ou `Conflit rechargé`.

Une fermeture de page avec une modification non synchronisée déclenche l'avertissement natif du navigateur.

## 6. Périmètres de lecture

### Administrateur

Reçoit l'état complet et accède aux vues société, aux référentiels, aux consultants, aux frais et à la facturation.

### Utilisateur standard

Le serveur ne lui envoie que :

- sa fiche consultant complète ;
- les autres consultants sous forme minimale nécessaire à l'affichage des noms, sans leur TJM ;
- les affaires où il est pilote, pilote commercial, contributeur commercial ou consultant d'une mission ;
- ses missions ;
- toutes les missions d'une affaire qu'il pilote ;
- ses propres temps et frais ;
- les temps/frais nécessaires au calcul d'une affaire qu'il pilote ;
- les factures des affaires qu'il pilote ;
- les organisations liées à ces affaires ;
- les référentiels nécessaires aux formulaires.

Les pages société et administration sont aussi masquées côté interface, mais **la sécurité ne dépend pas de ce masquage**.

## 7. Périmètres d'écriture

| Donnée | Utilisateur | Pilote de l'affaire | Administrateur |
|---|---:|---:|---:|
| Ses temps | oui | oui pour lui-même | oui |
| Ses frais | oui | oui pour lui-même | oui |
| Demander paiement de sa note de frais | oui | oui | oui |
| Marquer une note payée | non | non | oui |
| Affaire existante | non | oui, si pilote | oui |
| Créer une affaire | non | non | oui |
| Missions d'une affaire | non | oui, si pilote | oui |
| Factures | non | lecture sur affaires pilotées | oui |
| Organisations / consultants / référentiels | non | non | oui |

Le serveur vérifie ces règles à chaque différence reçue. Une modification fabriquée manuellement dans le navigateur est donc refusée de la même manière qu'une modification via l'interface.

## 8. Identifiants concurrents

Les nouvelles saisies, frais, organisations, affaires, missions et factures utilisent désormais des identifiants incluant un UUID côté navigateur. Cela évite que deux utilisateurs créent simultanément le même `A19`, `M12`, etc.

Les identifiants historiques restent valides et ne sont pas migrés.

## 9. Limites assumées de V1

- une seule instance serveur ;
- pas de fonctionnement hors ligne durable ;
- conflit sur la même ligne : priorité à la sécurité, la modification locale conflictuelle n'est pas fusionnée champ par champ ;
- droits définis par deux rôles (`user`, `admin`) plus le rôle métier de pilote déduit de l'affaire ;
- pas de SSO/LDAP/OIDC ;
- pas de pièces jointes ;
- pas de chiffrement applicatif de la base : protection attendue via le disque/volume et les politiques du serveur.

Aucune de ces limites ne doit être levée sans besoin observé.
