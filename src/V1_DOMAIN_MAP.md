# Pilotéo V1 — Carte du domaine (référence d'ingénierie)

> Reconstituée par lecture de `server.py`, `app.js`, `docs/ARCHITECTURE_V1.md`,
> `docs/modele-de-donnees.md`, `seed.json`. Sert de socle **autoritaire** au
> reducer événementiel et au PolicyEngine local-first. Cite les lignes V1 pour
> traçabilité. Ne remplace pas les documents métier.

## 1. Collections de `app_state` (`COLLECTION_KEYS`, `server.py:63-76`)

Liste **exhaustive** des collections synchronisées et leur **clé d'identité** :

| Collection | Clé | UUID client ? | Préfixe création |
|---|---|---|---|
| `consultants` | `id` | non (id court/trigramme) | — |
| `organisations` | `id` | oui | `O-` (`app.js:3455`) |
| `affaires` | `id` | oui | `A-` (`app.js:4960`) |
| `methodes` | `id` | non (compteur) | — |
| `typesTerritoire` | `id` | non | — |
| `domainesIntervention` | `id` | non | — |
| `categoriesFrais` | `id` | non | — |
| `missions` | `id` | oui | `M-` (`app.js:5373`) |
| `factures` | `id` | oui | `F-` (`app.js:5475`) |
| `saisies` | `id` | oui | `S-` (`app.js:1281`) |
| `bordereauxFrais` | **`numero`** | non (numéro construit `FRAIS_<TRI>_<AAAA>_<NNN>`) | `app.js:3764` |
| `notesFrais` | `id` | oui | `NF-` (`app.js:3099`) |

**Piège de nommage à respecter** : la collection `notesFrais` correspond à
l'entité métier **« Frais »** (`modele-de-donnees.md` §9) ; `bordereauxFrais`
correspond au **« Bordereau / note de frais »** (§11). L'inversion code↔métier
est réelle et volontaire.

Non synchronisées (listes figées en dur côté client, non éditables en V1) :
`tempsInternes`, `tempsAbsences` (`app.js:87-101`).

### Formes d'entité (champs principaux)

- **consultants** : `id, nom, trigramme(3), statut(en poste|stagiaire|parti), dateEmbauche, dateDepart|null, tjmBase(€), admin(bool), tempsPartiel[{debut,fin,pct}]`
- **organisations** : `id, nom, type, adresse`
- **affaires** : `id, nom, organisationId→org, nomAbrege, motsCles, pilote→consultant, piloteCommercial→consultant, typeVente, pctReussite(0-100), dateDepot, statut(enum 4), budget(€), jours, frais(€), dateDebut, dateFin, methodes[id], territoires[id], domaines[id], partenaires[{organisationId, role(mandataire|co-traitant|sous-traitant direct|sous-traitant indirect), montant}], repartitionCommerciale[{consultantId, pct}]`
- **methodes / typesTerritoire / domainesIntervention** : `id, label` ; **categoriesFrais** : `id, categorie, label`
- **missions** : `id, affaireId→affaire, nom, consultantId→consultant, statut(en cours|terminée), enveloppe(j), taux(€/j), dateDebut, dateFin, commentaires, projectionManuelle{"AAAA-MM":j}`
- **factures** : `id, affaireId→affaire, numero, formation(bool), montantMissionHT, montantSousTraitanceHT, montantFraisTTC, echeancePrev, dateDepot|null, echeancePaiementPrev, datePaiement|null, payee(bool), statut(enum 4), commentaires`
- **saisies** : `id, date, consultantId→consultant, type(mission|interne|absence), missionId→mission|null, categorie(code)|null, dureeH, pctFact(0-100), commentaire` (+ dérivés `dureeJ/jFact/jNonFact`)
- **bordereauxFrais** : `numero, consultantId→consultant, annee, seq, statut(en saisie|note à payer|payée), datePaiement|null`
- **notesFrais** (=Frais) : `id, date, consultantId→consultant, affaireId→affaire|null, categorieTempsInterne(code)|null (exclusif avec affaireId), categorieFraisId, refacturable(bool), numeroBordereau→bordereau, lignesTVA[{tauxTVA,montantHT,montantTVA}], commentaire` (+ dérivés montantHT/TVA/TTC)

## 2. Rôles

Stockés en base : `user`, `admin` (`server.py:166`). Rôle **pilote** = dérivé,
non stocké : vrai quand `affaire.pilote == consultant_id`. Le futur modèle ajoute
`owner` (gouvernance workspace : membres, stockage, licence) — sans nouveau
pouvoir métier.

`ADMIN_ONLY` (écriture réservée admin, `server.py:77-80`) :
`consultants, organisations, methodes, typesTerritoire, domainesIntervention,
categoriesFrais, factures`.

## 3. `can_change(user, collection, op, old, new, current_state)` (`server.py:377-430`)

Évalué **par entité** sur l'état serveur complet (jamais la vue filtrée). Ordre :

1. `admin` ⇒ **accept** systématique.
2. non-admin + `collection ∈ ADMIN_ONLY` ⇒ **reject** « Réservé à un administrateur ».
3. Règles rôle `user` (`cid = consultant_id`) :

| Collection | op | Condition ⇒ reject | Sinon |
|---|---|---|---|
| `saisies` | delete | toujours (« suppression non autorisée en V1 ») | — |
| `saisies` | add/update | `candidate.consultantId != cid` ou (update et `old.consultantId != cid`) | |
| `saisies` type=mission | add/update | mission absente ou `mission.consultantId != cid` | **accept** |
| `notesFrais` | delete | toujours | — |
| `notesFrais` | add/update | `candidate.consultantId != cid` | |
| `notesFrais` avec affaireId | add/update | `affaireId ∉ related(cid)` | **accept** |
| `bordereauxFrais` | delete | toujours | — |
| `bordereauxFrais` | add/update | `candidate.consultantId != cid` | |
| `bordereauxFrais` | add/update | `new.statut == "payée"` | |
| `bordereauxFrais` | update | transition `(old.statut→new.statut)` ∉ {(en saisie→en saisie),(en saisie→note à payer),(note à payer→note à payer)} | |
| `bordereauxFrais` | update | `new.datePaiement` renseigné | **accept** |
| `affaires` | add | toujours (« création réservée à un administrateur ») | — |
| `affaires`/`missions` | update | affaire concernée absente ou `affaire.pilote != cid` | |
| `affaires` | update | `new.pilote != cid` (changer le pilote) | **accept** |
| autre | — | filet par défaut ⇒ reject | — |

`related(cid)` / `piloted(cid)` = `affair_ids_for_user` (`server.py:292-304`) :
`related` = affaires où `cid` est pilote, piloteCommercial, crédité en
`repartitionCommerciale`, ou consultant d'une mission de l'affaire ; `piloted` =
sous-ensemble où `cid` est strictement `pilote`.

## 4. `filter_state(full, user)` — lecture (`server.py:307-356`)

- **admin** : tout.
- **user** (`cid`) :
  - `consultants` : sa fiche complète ; les autres en forme minimale (sans `tjmBase`, sans `tempsPartiel`).
  - `organisations` : seulement celles référencées par une affaire visible.
  - `affaires` : `id ∈ related`.
  - `methodes, typesTerritoire, domainesIntervention, categoriesFrais` : **intégral**.
  - `missions` : `consultantId == cid` **ou** `affaireId ∈ piloted`.
  - `factures` : `affaireId ∈ piloted` (lecture seule).
  - `saisies` : les siennes **ou** rattachées à une mission d'affaire pilotée.
  - `bordereauxFrais` : les siens.
  - `notesFrais` : les siens **ou** `affaireId ∈ piloted`.

## 5. Synchronisation V1 (`merge_client_state`, `server.py:433-490`)

- Optimistic concurrency par **révision globale monotone** (`revision`, un seul
  compteur), conflit détecté **par entité** via `state_history` (100 révisions).
- Conflit sur une entité **ssi** le client n'est pas à jour **et** cette entité a
  changé côté serveur depuis la base du client. Entités différentes ⇒ fusion.
  Même entité ⇒ conflit, **jamais** de fusion champ par champ.
- Un seul conflit **ou** un seul refus de permission ⇒ **toute la requête est
  rejetée** (rollback), rien n'est persisté. Réponses : `200` ok / `409` conflit
  (+ liste `conflicts` + état rechargé) / `403` permission / `400`/`500`.

## 6. Bootstrap front (`app.js`) — points de couture

- État = 12 `let` de module (une par collection, `app.js:29-133`) + `currentUser`.
  Pas de store observable ; mutations directes.
- `collectState()` (`app.js:528-534`) : agrège les 12 vars → objet (miroir de
  `COLLECTION_KEYS`). **Source d'écriture.**
- `applyRemoteState(state, rerender, markSynced)` (`app.js:554-577`) : répartit un
  objet reçu → 12 vars + `recomputeCounters()`. **Sink de tout état reçu.**
- `syncNow()` (`app.js:730-777`) : **couture réseau** (`PUT /api/state` avec
  `{base_revision: syncRevision, state}`). Point d'insertion naturel d'une file
  d'événements locale.
- Chargement initial : `startApp()`→`loadSessionState()`→`GET /api/state`.
- `newEntityId(prefix)` (`app.js:521-526`) = `prefix + crypto.randomUUID()`.

## 7. Validation & dette V1 à NE PAS reproduire

La V1 **n'a aucune validation structurelle** par champ côté serveur : pas de
schéma, pas de vérif de type, et `json` Python **accepte NaN/Infinity/-Infinity**
(pas de `allow_nan=False`). Deux entités hors-ligne avec le même id s'écrasent
silencieusement à la fusion. Le local-first doit **ajouter** : validation de
forme par entité, refus NaN/Infinity/types incohérents, bornes de taille,
unicité d'id — cf. `docs/next/05` §10 et `08_AI_HANDOFF.md` « Dette V1 ».
