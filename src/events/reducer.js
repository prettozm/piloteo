// events/reducer.js
//
// Décisions/hypothèses (CONTRACTS.md §3, 02_ARCHITECTURE_CIBLE.md §6-9) :
// - La projection est `{ [entityType]: { [identity]: entity }, __versions:
//   { [entityType]: { [identity]: { version, lastEventId } } } }`.
//   `identity` est la valeur portée par `event.entityId` : c'est la
//   responsabilité de l'appelant (`buildEvent`) d'y placer la clé d'identité
//   propre à l'entityType (`numero` pour `bordereauxFrais`, `id` sinon — cf.
//   `identityKey()` dans event-schema.js). Le reducer ne redérive pas
//   l'identité depuis le payload : cela lui permet de traiter un `delete` dont
//   le payload est minimal/absent, sans jamais désynchroniser l'index.
// - `__versions[...]` porte `{version, lastEventId}` et non un simple entier :
//   `lastEventId` est nécessaire à `conflict.js#classify` pour détecter un
//   doublon (rejouer le MÊME eventId ne doit jamais être vu comme un conflit).
//   C'est une extension déclarée du contrat, documentée ici et dans
//   conflict.js, pas un simple entier "version d'entité" au sens strict — elle
//   reste consultable comme telle via `.version`.
// - `reduce` est pur : aucune mutation de `projection` ni de ses objets
//   imbriqués. Seules les branches modifiées (`projection[entityType]`,
//   `projection.__versions[entityType]`) sont clonées ; les autres entityTypes
//   restent partagés par référence (ils sont eux-mêmes immuables une fois
//   produits, donc ce partage est sûr).
// - `reduce` NE VÉRIFIE PAS les conflits/versions : c'est le rôle de
//   `conflict.js#classify`, appelé par l'orchestrateur (event-log/SyncEngine)
//   AVANT de décider d'appliquer l'événement. `reduce` applique aveuglément ce
//   qu'on lui donne — cette séparation est volontaire (contrat §3).
// - `delete` = tombstone : l'entité est marquée `__deleted:true` (avec
//   `__deletedAt`), les champs métier précédents sont conservés tels quels
//   (utile pour audit/annulation), et la version est tout de même incrémentée
//   ("conserve la version").

export function initialProjection() {
  return {};
}

function cloneBucket(bucket) {
  return bucket ? { ...bucket } : {};
}

/**
 * Reducer pur : (projection, event, payload) -> nouvelle projection.
 * `payload` est le payload métier en clair (déjà déchiffré si besoin par
 * l'appelant) ; ignoré structurellement pour `delete` au-delà de la fusion
 * dans le tombstone.
 */
export function reduce(projection, event, payload) {
  if (!event || typeof event !== "object") {
    throw new TypeError("reduce: event invalide");
  }
  const { entityType, entityId, operation, baseVersion, eventId, createdAt } = event;
  if (typeof entityType !== "string" || !entityType) {
    throw new TypeError("reduce: event.entityType requis");
  }
  if (typeof entityId !== "string" || !entityId) {
    throw new TypeError("reduce: event.entityId requis");
  }
  if (typeof baseVersion !== "number" || !Number.isFinite(baseVersion) || !Number.isInteger(baseVersion)) {
    throw new TypeError("reduce: event.baseVersion doit être un entier fini");
  }

  const source = projection && typeof projection === "object" ? projection : {};
  const nextProjection = { ...source };

  const entityBucket = cloneBucket(source[entityType]);
  const versionsRoot = cloneBucket(source.__versions);
  const versionBucket = cloneBucket(versionsRoot[entityType]);

  if (operation === "delete") {
    const previous = entityBucket[entityId];
    entityBucket[entityId] = {
      ...(previous && typeof previous === "object" ? previous : {}),
      __deleted: true,
      __deletedAt: createdAt || null,
    };
  } else if (operation === "create" || operation === "update") {
    entityBucket[entityId] = payload === undefined ? null : payload;
  } else {
    throw new TypeError(`reduce: operation inconnue: ${String(operation)}`);
  }

  versionBucket[entityId] = { version: baseVersion + 1, lastEventId: eventId };
  versionsRoot[entityType] = versionBucket;

  nextProjection[entityType] = entityBucket;
  nextProjection.__versions = versionsRoot;
  return nextProjection;
}
