# Références techniques externes

Vérifiées le 30 août 2026.

## Google Identity Services

- Token model pour application Web :
  https://developers.google.com/identity/oauth2/web/guides/use-token-model

Le modèle permet à une application navigateur d’obtenir un access token et d’appeler directement les API Google en REST/CORS, sans stocker de refresh token utilisateur sur un backend Pilotéo.

## Google Drive OAuth scopes

- Choix des scopes :
  https://developers.google.com/workspace/drive/api/guides/api-specific-auth

Priorité : `https://www.googleapis.com/auth/drive.file`.

Ce scope est présenté par Google comme non sensible et à accès limité par fichier.

## Google Drive — Shared Drives

- Support des Drive partagés :
  https://developers.google.com/workspace/drive/api/guides/enable-shareddrives

Notamment `supportsAllDrives=true`, `includeItemsFromAllDrives` et `driveId`.

## Google Drive — permissions

- Partage :
  https://developers.google.com/workspace/drive/api/guides/manage-sharing
- Création de permission :
  https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create

## Google Drive — appDataFolder

- Données spécifiques application :
  https://developers.google.com/workspace/drive/api/guides/appdata

Important : l’appDataFolder ne peut pas être partagé ; il ne convient donc pas au workspace Team.

## Web Crypto

- MDN :
  https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API

L’API est largement disponible mais de bas niveau. La conception crypto doit être revue avant promesse de sécurité en production.
