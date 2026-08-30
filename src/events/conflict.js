// events/conflict.js
//
// Décisions/hypothèses (CONTRACTS.md §3, 02_ARCHITECTURE_CIBLE.md §7) :
// - `classify(currentEntityVersion, event) -> "apply"|"duplicate"|"conflict"`.
// - `currentEntityVersion` peut être :
//     * `undefined`/`null`            -> entité inconnue, version 0 implicite ;
//     * un nombre                     -> version brute (rétro-compat simple) ;
//     * `{ version, lastEventId }`    -> forme produite par reducer.js, qui
//       ajoute `lastEventId` (le eventId ayant amené l'entité à cette version)
//       pour permettre une détection de doublon fiable même quand deux
//       événements distincts partagent le même `baseVersion` (un vrai conflit
//       n'a jamais le même eventId qu'un événement déjà appliqué).
// - Règles, dans cet ordre :
//     1. `event.eventId === currentEntityVersion.lastEventId` -> "duplicate"
//        (rejouer l'événement qui a produit l'état courant est un no-op idempotent).
//     2. `event.baseVersion !== version courante` -> "conflict" (jamais
//        écrasé, jamais rejoué silencieusement — cf. §3 et §7).
//     3. sinon -> "apply". Une création initiale (aucune entité existante,
//        `version courante = 0`) passe cette règle normalement dès que
//        `event.baseVersion === 0`, sans cas particulier : c'est le sens de
//        « hors création initiale » dans le contrat — la création n'est pas
//        exemptée de la règle, elle la satisfait naturellement.
// - Ce module ne connaît ni le reducer, ni le event-log : il est pur et ne
//   fait aucune E/S, testable isolément.

function normalize(currentEntityVersion) {
  if (currentEntityVersion === undefined || currentEntityVersion === null) {
    return { version: 0, lastEventId: null };
  }
  if (typeof currentEntityVersion === "number") {
    return { version: currentEntityVersion, lastEventId: null };
  }
  const version =
    typeof currentEntityVersion.version === "number" && Number.isFinite(currentEntityVersion.version)
      ? currentEntityVersion.version
      : 0;
  const lastEventId =
    typeof currentEntityVersion.lastEventId === "string" ? currentEntityVersion.lastEventId : null;
  return { version, lastEventId };
}

export function classify(currentEntityVersion, event) {
  if (!event || typeof event.eventId !== "string" || typeof event.baseVersion !== "number") {
    throw new TypeError("classify: event doit porter eventId (string) et baseVersion (number)");
  }
  const current = normalize(currentEntityVersion);

  if (current.lastEventId !== null && current.lastEventId === event.eventId) {
    return "duplicate";
  }
  if (event.baseVersion !== current.version) {
    return "conflict";
  }
  return "apply";
}
