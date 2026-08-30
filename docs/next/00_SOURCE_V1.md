# Pilotéo V1 — Source observée pour cette migration

Base : archive `piloteo-claude-piloteo-audit-robustify-5b1zlc.zip`  
Version : `1.0.0`

Constats utilisés pour construire ce dossier :

- `app.js` contient l’essentiel du métier et de l’UI ;
- `server.py` porte auth, sessions, filtrage, autorisation, SQLite, synchronisation, audit et sauvegardes ;
- l’état V1 est stocké comme JSON complet dans SQLite (`app_state`) avec `state_history` ;
- la synchro V1 est optimiste avec conflit explicite sur une même entité ;
- les nouvelles entités utilisent déjà des identifiants UUID côté client ;
- les droits actuels sont centralisés dans la logique serveur et doivent être portés dans un `PolicyEngine`;
- l’application n’a aucune dépendance npm en runtime ;
- les documents métier `cahier-des-charges.md` et `modele-de-donnees.md` restent les références fonctionnelles.

Ce dossier ne remplace pas ces documents métier.
