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
//     2. Causalité explicite (P0.1) — SI l'événement porte `parentEventId`
//        (présent, éventuellement `null`) : il doit descendre EXACTEMENT de
//        l'état courant, c.-à-d. `event.parentEventId === current.lastEventId`
//        (avec `null === null` pour une création sur entité inconnue). Sinon
//        -> "conflict". C'est la correction du défaut d'audit : `baseVersion`
//        seul laissait un descendant d'une branche PERDANTE (même `baseVersion`
//        que le gagnant, mais issu d'un autre parent) devenir état officiel.
//        `parentEventId` identifie l'ascendance réelle, pas seulement un numéro
//        de version que deux branches concurrentes peuvent partager.
//        Les événements historiques SANS `parentEventId` conservent l'ancien
//        comportement (compat ascendante : règle 3 seule).
//     3. `event.baseVersion !== version courante` -> "conflict" (jamais
//        écrasé, jamais rejoué silencieusement — cf. §3 et §7). Conservée en
//        ceinture-et-bretelles même quand `parentEventId` est présent (un
//        `parentEventId` correct implique déjà la bonne `baseVersion`, mais on
//        refuse tout de même une enveloppe incohérente).
//     4. sinon -> "apply". Une création initiale (aucune entité existante,
//        `version courante = 0`, `parentEventId` null/absent) passe ces règles
//        normalement dès que `event.baseVersion === 0`, sans cas particulier.
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
  // Règle 2 — causalité explicite (P0.1). N'agit que si l'événement DÉCLARE un
  // parent (clé présente, `null` inclus) : un descendant doit référencer l'état
  // courant exact, sinon il descend d'une autre branche => conflit.
  if (Object.prototype.hasOwnProperty.call(event, "parentEventId")) {
    const declaredParent = event.parentEventId ?? null;
    if (declaredParent !== current.lastEventId) {
      return "conflict";
    }
  }
  if (event.baseVersion !== current.version) {
    return "conflict";
  }
  return "apply";
}
