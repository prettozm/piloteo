# Contrat — Durcissement du mode statique (audit P0③ + P1 CSP)

> Corrige deux points de l'audit externe sur l'app publiée en PWA statique
> (GitHub Pages, `PILOTEO_FORCE_SOLO=true`). `app.js` et `server.py` restent
> INTACTS (invariant CLAUDE.md §1) : tout passe par `local-backend.js`,
> `index.html` et les fichiers de config. À faire APRÈS le commit du lot Drive.

## 1. Support ABSENT en solo statique (audit §2/§11)

Constat : en solo, `local-backend.js` fabrique un utilisateur `role="admin"` ;
`app.js` fait `support.hidden = !admin` → le panneau `#support-admin-panel`
(`index.html`, lien `href="/support"`) s'affiche. Sur Pages (statique), `/support`
est un 404 sec, et il n'y a de toute façon ni comptes serveur, ni audit, ni
sauvegardes serveur en solo.

Exigence : en mode **solo statique** (`window.PILOTEO_FORCE_SOLO === true`, ou plus
généralement quand il n'y a pas de backend serveur), le panneau Support doit être
**ABSENT** (retiré du DOM), pas grisé, pas en 404.

Contrainte : NE PAS modifier `app.js`. Le retrait doit se faire depuis
`local-backend.js` (déjà chargé après `app.js`) : au boot en solo statique,
retirer/masquer l'élément `#support-admin-panel` (et tout lien `href="/support"`)
du DOM — idempotent, sans effet sur le mode Serveur V1 (où `local-backend.js`
n'intercepte pas). Si le panneau est (re)rendu par `app.js` après coup, prévoir
un `MutationObserver` borné OU un masquage CSS robuste injecté par `local-backend.js`
(display:none !important sur `#support-admin-panel`) — au choix, le plus simple qui
garantit l'ABSENCE visuelle et l'inaccessibilité du lien.

Test (e2e, statique + Chromium, style `solo-folder.mjs`) : au chargement de l'app
solo statique, `#support-admin-panel` n'est pas visible (offsetParent null ou absent
du DOM) et aucun lien cliquable `href="/support"` n'est présent. Non-régression :
le reste de l'UI et les modes dossier/org non affectés.

## 2. CSP + externalisation des scripts inline (audit §3)

Constat : `app/index.html` n'a pas de `<meta http-equiv="Content-Security-Policy">`,
et porte 2 `<script>` INLINE (`window.PILOTEO_FORCE_SOLO=true;` et
`window.PILOTEO_GOOGLE_CLIENT_ID="…";`). En local-first, un XSS lirait les données
en clair — une CSP `script-src` réduit fortement la surface.

Exigences :
- **Externaliser** les 2 scripts inline vers un fichier `pages-config.js` (servi en
  statique), chargé AVANT les ponts qui lisent ces globals. Contenu :
  `window.PILOTEO_FORCE_SOLO=true; window.PILOTEO_GOOGLE_CLIENT_ID="…";` (client id
  PUBLIC, aucun secret). Le workflow `pages.yml` (injection force-solo) et la
  republication `/app/` produisent/embarquent ce fichier au lieu du script inline.
- **Ajouter une CSP** en `<meta http-equiv="Content-Security-Policy">` dans
  `index.html`, compatible avec GSI + Drive REST + modules ES :
  ```
  default-src 'self';
  script-src 'self' https://accounts.google.com;
  connect-src 'self' https://www.googleapis.com https://accounts.google.com;
  frame-src https://accounts.google.com;
  img-src 'self' data:;
  style-src 'self' 'unsafe-inline';
  base-uri 'self'; object-src 'none'
  ```
  (`style-src 'unsafe-inline'` conservé : de nombreux attributs `style=""` existent,
  pas de refonte CSS demandée. `script-src` SANS `'unsafe-inline'` : d'où
  l'externalisation obligatoire des 2 scripts ci-dessus.)
- Vérifier qu'AUCUN gestionnaire `onclick=`/`on*=` inline ne subsiste dans
  `index.html` (l'audit en a trouvé 0 — confirmer), sinon les router en JS externe.

Test : node/statique — après build, `index.html` contient la balise CSP et ne
contient plus de `<script>…</script>` inline non vide (hors `src=`) ; `pages-config.js`
pose bien les deux globals. e2e : l'app solo démarre toujours (CSP ne casse pas les
modules ES ni le SW) ; le mode Drive reste chargeable (GSI autorisé par la CSP).

> Note d'implémentation (maker) : la republication `/app/` (worktree main) doit
> embarquer EXACTEMENT `pages-config.js` (config runtime versionnée, plus
> d'injection au build) + `index.html` porteur de la balise CSP — les deux
> fichiers vont ensemble, `index.html` charge `pages-config.js` en premier
> script de la page.

## 3. Contraintes
- `app.js`/`server.py` intacts. Client id PUBLIC uniquement. Aucun secret.
- `npm run test:next` reste vert. Non-régression solo/dossier/org/drive/auth.
- Cohérence dev↔prod : le mécanisme de republication `/app/` (worktree main) doit
  embarquer `pages-config.js` et l'`index.html` avec CSP.
