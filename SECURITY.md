# Politique de sécurité

## Versions supportées

La dernière version mineure publiée reçoit les correctifs de sécurité. Les
versions antérieures ne sont pas maintenues.

## Signaler une vulnérabilité

Merci de **ne pas** ouvrir d'issue publique pour une faille de sécurité.
Utilisez l'onglet **Security → Report a vulnerability** du dépôt (GitHub
Private Vulnerability Reporting), ou contactez le mainteneur en privé.

Merci d'inclure : une description, les étapes de reproduction, l'impact estimé
et, si possible, une proposition de correctif. Nous accusons réception sous
quelques jours ouvrés.

## Périmètre et modèle de menace

Le niveau de sécurité visé, les contrôles présents et les choix assumés (pas de
SSO/MFA, etc.) sont décrits dans [`docs/SECURITY.md`](docs/SECURITY.md). Chaque
instance client est isolée (application, volume, secrets et URL distincts).

## Bonnes pratiques de déploiement

Voir [`docs/DEPLOIEMENT.md`](docs/DEPLOIEMENT.md) : HTTPS obligatoire, secrets
gérés hors du dépôt (secrets Fly / `.env` non versionné), sauvegardes chiffrées
hors-site, mot de passe administrateur fort et unique par client.
