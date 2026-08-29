# Pilotéo V1.0.0 — lot de mise en usage professionnel

## Ajouté

- serveur Python mono-instance sans dépendance applicative externe ;
- base SQLite persistante en WAL ;
- comptes nominatifs et authentification par mot de passe ;
- sessions `HttpOnly`, CSRF, limitation des tentatives de connexion ;
- filtrage des données et permissions d'écriture côté serveur ;
- synchronisation automatique, révisions et détection des conflits ;
- identifiants uniques pour les créations concurrentes ;
- indicateur de synchronisation dans l'interface ;
- console administrateur `/support` ;
- création/désactivation de comptes et réinitialisation de mot de passe ;
- journal d'audit ;
- sauvegardes automatiques et manuelles ;
- script de restauration avec contrôle d'intégrité ;
- Dockerfile, Compose et exemple de reverse proxy HTTPS ;
- documentation architecture, sécurité, exploitation et reprise IA ;
- tests automatiques des principaux périmètres de sécurité.

## Modifié

- l'écran de choix d'un consultant devient un écran de connexion ;
- les pages société/administration sont masquées aux comptes standards ;
- le champ historique `Consultant.admin` n'est plus une autorité de sécurité ; l'attribution du rôle admin se fait dans Support ;
- les ressources Google Fonts ont été supprimées pour ne charger aucun tiers ;
- le bundle navigateur ne contient plus le jeu de données métier : celui-ci est chargé depuis le serveur après authentification.

## Délibérément non fait

- SSO/MFA ;
- PostgreSQL ;
- API CRUD normalisée par entité ;
- framework front ;
- microservices ;
- fonctionnement offline ;
- changement autonome / récupération de mot de passe ;
- notifications email ;
- permissions très granulaires.

Ces éléments ne doivent être ajoutés que s'ils deviennent des besoins réels.
