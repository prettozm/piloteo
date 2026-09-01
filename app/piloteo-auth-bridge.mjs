// piloteo-auth-bridge.mjs — pont navigateur du Point 3
// (docs/next/AUTH_SESSION_CONTRACT.md) : session locale à l'appareil.
//
// Décisions/hypothèses :
// - `src/auth/session.js` est un module PUR (aucune E/S, aucun DOM), testable
//   tel quel côté Node (`tests/next/auth-session.test.mjs`). Ce pont ne fait
//   QUE le réexposer sur `window.PiloteoAuth`, EXACTEMENT comme
//   `piloteo-solo-bridge.mjs` réexpose `src/integration/solo-store.js` sur
//   `window.PiloteoNext` : `local-backend.js` est un script CLASSIQUE (pas de
//   modules), le seul point de contact est `window.PiloteoAuth`, posé ici.
//   Ce module est chargé en `<script type="module">` (différé de fait) :
//   `local-backend.js` NE DOIT PAS supposer `window.PiloteoAuth` présent à
//   son propre chargement — il le teste à l'usage (poll court), et se
//   dégrade en fail-open avec avertissement visible si le module n'a
//   vraiment pas chargé (même principe que pour `PiloteoNext`/`PiloteoOrg`).
// - AUCUNE logique de persistance ici : la persistance de `piloteo_session`
//   (IndexedDB `piloteo-solo`) et la machine à états côté application restent
//   dans `local-backend.js` (contrat §2/§3) — ce pont n'expose que les
//   primitives pures.

import {
  hashPin,
  verifyPin,
  newSalt,
  initialSession,
  canAttempt,
  canAttemptCrossChecked,
  registerFailure,
  registerSuccess,
  lock,
} from "./src/auth/session.js";

window.PiloteoAuth = {
  hashPin,
  verifyPin,
  newSalt,
  initialSession,
  canAttempt,
  canAttemptCrossChecked,
  registerFailure,
  registerSuccess,
  lock,
};
