# Pilotéo — Sécurité V1

## Niveau visé

Application professionnelle interne, petit groupe d'utilisateurs, contenant potentiellement des données commerciales, financières et RH courantes. Le niveau attendu est : empêcher l'accès anonyme, éviter les fuites entre utilisateurs, réduire les erreurs d'administration, conserver une trace utile, protéger les sauvegardes et ne pas introduire d'infrastructure disproportionnée.

Pilotéo n'est pas conçu pour héberger des secrets, des données de santé, des mots de passe tiers ou des données réglementées à haut niveau de sensibilité.

## Contrôles présents

- mot de passe haché PBKDF2-HMAC-SHA256, sel aléatoire, 600 000 itérations par défaut ;
- minimum de 12 caractères pour les mots de passe créés/réinitialisés ;
- cookie de session opaque, `HttpOnly`, `SameSite=Lax`, `Secure` lorsque `PILOTEO_FORCE_HTTPS=1` ;
- session expirant après 12 h par défaut ;
- jeton CSRF distinct exigé sur les actions authentifiées en écriture ;
- 10 échecs de connexion maximum par adresse IP sur 15 minutes ;
- contrôle des permissions côté serveur sur chaque entité modifiée ;
- filtrage des données côté serveur avant envoi au navigateur ;
- pas de stockage métier dans `localStorage` ;
- CSP, interdiction d'iframe, `no-referrer`, `nosniff`, permissions navigateur minimales ;
- aucune police, analytics ou bibliothèque chargée depuis un service tiers ;
- audit des connexions, échecs, gestion des comptes et mises à jour d'état ;
- fichiers SQLite, `.env` et sauvegardes exclus de Git.

## Obligations de déploiement

1. Utiliser HTTPS pour tout usage réel. Passer `PILOTEO_FORCE_HTTPS=1` une fois le TLS opérationnel.
2. Ne jamais exposer directement `data/`, `backups/`, `.env` ou la base SQLite via le serveur web/reverse proxy.
3. Restreindre l'accès réseau à ce qui est nécessaire : réseau entreprise, VPN ou accès authentifié de l'organisation.
4. Protéger le serveur et ses sauvegardes par les droits système habituels ; seuls l'administrateur système et le service Pilotéo doivent y accéder.
5. Copier les sauvegardes hors du serveur principal.
6. Utiliser un dépôt privé si `seed.json` ou les documents de projet contiennent des données qui ne sont pas publiques.
7. Désactiver immédiatement le compte d'une personne qui n'a plus besoin de Pilotéo.

## Ce qui n'est volontairement pas présent

- MFA ;
- SSO Microsoft/Google/LDAP ;
- chiffrement champ par champ ;
- coffre de secrets ;
- WAF ;
- SIEM ;
- rotation automatique de clés applicatives ;
- séparation réseau multi-tiers.

Ces mécanismes peuvent être pertinents dans un autre contexte, mais ne sont pas requis pour la V1 de cinq utilisateurs. Si le SI dispose déjà d'un SSO/MFA ou d'un reverse proxy central, il est préférable de s'y intégrer plutôt que de reproduire ces fonctions dans Pilotéo.

## Incident de sécurité ou de confidentialité

1. Désactiver le compte concerné dans `/support`.
2. Conserver la base et les logs ; ne pas les modifier avant analyse.
3. Vérifier `audit_log` via la console support et, si besoin, directement dans SQLite.
4. Réinitialiser le mot de passe si une compromission de compte est suspectée.
5. Restaurer une sauvegarde uniquement en cas d'altération de données, pas pour effacer les traces.
6. Si une exposition externe réelle est suspectée, suivre le processus sécurité/RGPD de l'entreprise ; Pilotéo ne remplace pas cette gouvernance.
