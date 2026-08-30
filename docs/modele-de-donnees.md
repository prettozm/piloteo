# Pilotéo — Modèle de données

*Document technique de référence — arrêté au 29 août 2026 (met à jour la version du 28 août : nouveau champ `categorieTempsInterne` sur Frais, permettant l'affectation à un temps interne en plus d'une affaire ; correction du cycle de statut d'une Facture — décocher « payée » n'est plus irréversible ; et précision sur la base de calcul du « Total payé » de la page Facturation)*

*Sauvegarde de la structure de l'outil, indépendante de la page web elle-même*

Ce document liste, entité par entité, l'ensemble des champs, types et relations tels qu'ils existent réellement dans le code de Pilotéo aujourd'hui. Il ne décrit pas les écrans ni les usages (voir le [« Cahier des charges — Pilotéo V3 »](cahier-des-charges.md) pour cela) : il décrit la donnée elle-même — ce qui est stocké, sous quelle forme, et comment une entité se relie aux autres.

Son rôle est d'être une sauvegarde de la structure : si la page devait être reconstruite, réécrite dans un autre outil, ou si l'étape d'une vraie base de données (section 14) devait un jour être franchie, ce document permet de repartir de la structure exacte de données déjà validée avec le cabinet, sans devoir la retrouver en relisant le code.

## 1. Vue d'ensemble des entités

Quatorze entités portent l'ensemble des données de Pilotéo. Les identifiants entre parenthèses sont ceux utilisés comme clés dans le code.

- **Consultant** — un membre du cabinet.
- **Organisation** — un client, prospect ou partenaire.
- **Affaire** — une mission commerciale vendue à une organisation, avec un budget.
- **Partenaire d'affaire** — sous-table de l'affaire, une ligne par organisation partenaire sur cette affaire.
- **Répartition commerciale** — sous-table de l'affaire, partage du crédit commercial entre consultants.
- **Mission** — une ligne de production sur une affaire, portée par un consultant.
- **Saisie de temps** — une ligne de temps passé, rattachée à une mission ou à un code interne/absence.
- **Frais** — une dépense professionnelle saisie par un consultant.
- **Ligne de TVA** — sous-table du frais, un taux de TVA parmi 1 à 4 sur la même dépense.
- **Bordereau de frais (note de frais)** — regroupe les frais d'un consultant en vue de leur remboursement.
- **Facture** — une facture émise sur une affaire, avec son échéancier de dépôt et de paiement.
- **Méthode, Type de territoire, Domaine d'intervention** — listes de référence cochées sur une affaire.
- **Sous-catégorie de frais** — liste de référence, rattachée à une catégorie parente, cochée sur un frais.
- **Temps interne, Temps d'absence** — listes de référence fixes, utilisées comme code sur une saisie de temps.

## 2. Consultant

| Champ | Type | Signification |
|---|---|---|
| `id` | texte | Identifiant unique du consultant. Attribué à la création (voir trigramme ci-dessous). |
| `nom` | texte | Nom complet affiché (ex. « Robin Blanchet »). |
| `trigramme` | texte | 3 lettres : les 2 premières du prénom + la 1re du nom, en majuscules, calculé automatiquement à la création (fonction `computeTrigramme`). En cas de doublon, une variante est générée. Lecture seule ensuite — utilisé dans la numérotation des notes de frais. |
| `statut` | texte | « en poste », « stagiaire » ou « parti ». |
| `dateEmbauche` | date (AAAA-MM-JJ) | Date d'arrivée au cabinet. |
| `dateDepart` | date ou null | Date de départ, vide si toujours présent. |
| `tjmBase` | nombre (€) | TJM objectif du consultant, utilisé comme référence dans les indicateurs de production (TJM vendu/réel). |
| `admin` | booléen | Droit administrateur. Indépendant du fait d'être pilote sur une affaire — voir `Affaire.pilote`, qui donne des droits sans être un champ du consultant. |
| `tempsPartiel` | liste de `{ debut, fin, pct }` | Périodes de temps partiel : debut/fin en date (fin peut être null = en cours), pct = pourcentage travaillé (ex. 80). Sert au calcul de l'ETP réel sur une période. Vide et ignorée si statut = « stagiaire » (voir note). |

> *Un consultant « stagiaire » n'a pas de temps partiel saisi : il est compté forfaitairement à 25 % de présence dans le calcul de l'ETP, quelle que soit sa présence réelle.*

## 3. Organisation

| Champ | Type | Signification |
|---|---|---|
| `id` | texte | Identifiant unique. |
| `nom` | texte | Raison sociale. |
| `type` | texte | Libre (ex. « Collectivité », « Services de l'État », « ESS », « Entreprises »). |
| `adresse` | texte | Champ libre, non affiché à ce jour dans les tableaux. |

Le statut d'une organisation (cliente / prospect / partenaire) n'est jamais stocké sur l'objet : il est recalculé à chaque affichage à partir des affaires qui la référencent. Une organisation est « cliente » dès qu'une affaire à son nom est « en production » ou « terminée » ; « prospect » si elle n'a que des affaires « en commercialisation » ou « perdue » (ou aucune affaire) ; « partenaire » dès qu'elle apparaît dans la sous-table Partenaires d'une affaire, quel que soit son rôle. Les trois statuts sont cumulables.

## 4. Affaire

| Champ | Type | Signification |
|---|---|---|
| `id` | texte | Identifiant unique. |
| `nom` | texte | Nom complet de l'affaire. |
| `organisationId` | référence → Organisation | Organisation cliente. |
| `nomAbrege` | texte | Nom court affiché dans les listes et graphiques. |
| `motsCles` | texte | Mots-clés libres (ex. « #collectivité #accessibilité »), utilisés pour la recherche du portefeuille. |
| `pilote` | référence → Consultant | Consultant pilote de l'affaire — donne accès à sa fiche complète. |
| `piloteCommercial` | référence → Consultant | Pilote commercial (peut être le même que pilote) — crédité par défaut de 100 % du commercial si la répartition (section 6) est vide. |
| `typeVente` | texte | Ex. « Appel d'offres », « Appel à projet », « Gré à gré », « Bon de commande ». |
| `pctReussite` | nombre (0–100) | % de réussite estimé — préréglages Très Fort 80 % / Fort 60 % / Moyen 40 % / Faible 20 % / Très Faible 10 %. Utilisé pour pondérer le pipeline commercial. |
| `dateDepot` | date | Date de dépôt de l'offre — sert de référence pour rattacher l'offre à une année dans le suivi commercial. |
| `statut` | texte | « en commercialisation », « en production », « terminée » ou « perdue ». |
| `budget` | nombre (€) | Budget vendu total (« Prestations Cabinet ») — référence de la cohérence budgétaire (section 6 du cahier des charges) et des alertes de facturation et de pilotage (voir Facture). |
| `jours` | nombre | Volume de jours vendus, informatif (le budget effectif des missions se recalcule depuis les missions elles-mêmes). |
| `frais` | nombre (€) | Enveloppe « Frais Cabinet » — la part du budget vendu réservée aux frais refacturables. Comparée en continu aux frais réellement engagés et marqués refacturables (voir Frais), dans le calcul de cohérence budgétaire. |
| `dateDebut` / `dateFin` | date | Fenêtre prévisionnelle de l'affaire — borne les dates possibles des missions qui lui sont rattachées. |
| `methodes` | liste d'ids → Méthode | Méthodes cochées sur l'affaire. |
| `territoires` | liste d'ids → Type de territoire | Types de territoire cochés. |
| `domaines` | liste d'ids → Domaine d'intervention | Domaines cochés. |
| `partenaires` | liste de Partenaire d'affaire | Voir section 5. |
| `repartitionCommerciale` | liste de Répartition commerciale | Voir section 6. |

## 5. Partenaire d'affaire (sous-table de l'Affaire)

| Champ | Type | Signification |
|---|---|---|
| `organisationId` | référence → Organisation | Organisation partenaire. |
| `role` | texte (4 valeurs) | « mandataire », « co-traitant », « sous-traitant direct » ou « sous-traitant indirect » (constante `ROLES_PARTENAIRE`). |
| `montant` | nombre (€) | Montant à payer à ce partenaire — utilisé dans la cohérence budgétaire uniquement pour les partenaires « sous-traitant indirect » (imputé sur le budget vendu de l'affaire, au même titre que les missions et les frais refacturables). Distinct du montant de sous-traitance refacturé au client sur une Facture (section 12). |

## 6. Répartition commerciale (sous-table de l'Affaire)

| Champ | Type | Signification |
|---|---|---|
| `consultantId` | référence → Consultant | Le consultant crédité. |
| `pct` | nombre (%) | Sa part du crédit commercial. Non bloquant si la somme des lignes ne fait pas 100 % (message informatif seulement, jamais vérifié à l'enregistrement de l'affaire). |

Sert uniquement à créditer proportionnellement chaque consultant dans le suivi commercial (montants et jours déposés/gagnés, taux de transformation) — pas à réserver de futures missions. Si la sous-table est vide, le pilote commercial (section 4) est crédité de la totalité par défaut.

## 7. Mission

| Champ | Type | Signification |
|---|---|---|
| `id` | texte | Identifiant unique. |
| `affaireId` | référence → Affaire | Affaire dont dépend la mission. |
| `nom` | texte | Nom de la mission. |
| `consultantId` | référence → Consultant | Consultant en charge. |
| `statut` | texte | « en cours » ou « terminée ». |
| `enveloppe` | nombre (jours) | Jours vendus sur cette mission. |
| `taux` | nombre (€/jour) | TJM négocié sur cette mission — pré-rempli depuis le TJM objectif du consultant à la création, mais jamais réécrasé automatiquement en modification (le taux négocié est protégé). |
| `dateDebut` / `dateFin` | date | Fenêtre de la mission — doit rester incluse dans celle de l'affaire (règle bloquante). |
| `commentaires` | texte | Libre. |
| `projectionManuelle` | objet `{ "AAAA-MM": jours }` | Surcharge manuelle, mois par mois, de la projection automatique du reste à faire — modifiable uniquement tant qu'il reste au moins 6 mois avant la fin de la mission. |

## 8. Saisie de temps

| Champ | Type | Signification |
|---|---|---|
| `id` | nombre | Identifiant unique. |
| `date` | date | Jour de la saisie. |
| `consultantId` | référence → Consultant | Consultant qui a saisi. |
| `type` | texte (3 valeurs) | « mission », « interne » ou « absence ». |
| `missionId` | référence → Mission, ou null | Renseigné seulement si type = « mission ». |
| `categorie` | code → Temps interne ou Temps d'absence, ou null | Renseigné seulement si type = « interne » ou « absence ». |
| `dureeH` | nombre (heures) | Durée saisie, en heures (base 8h = 1 jour). |
| `pctFact` | nombre (0–100) | % de la durée facturable. Forcé à 0 pour interne/absence. |
| `commentaire` | texte | Libre, optionnel. |
| `dureeJ, jFact, jNonFact` | nombres (dérivés) | Calculés une fois à l'ingestion des données (dureeH/8, et sa répartition facturable/non facturable) — champs de commodité pour l'affichage, pas resaisis par l'utilisateur. |

Règle de dépassement : si une saisie de type « mission » fait dépasser l'enveloppe restante de la mission, le surplus bascule automatiquement `pctFact` à 0 sur la part excédentaire (non bloquant, message informatif). Au-delà de 20 % de dépassement cumulé sur la mission, un badge rouge s'affiche partout où elle apparaît.

## 9. Frais

| Champ | Type | Signification |
|---|---|---|
| `id` | nombre | Identifiant unique. |
| `date` | date | Date de la dépense. |
| `consultantId` | référence → Consultant | Consultant ayant engagé la dépense. |
| `affaireId` | référence → Affaire, ou null | Affaire à laquelle la dépense se rattache — renseigné uniquement si le frais est affecté à une affaire (voir `categorieTempsInterne` ci-dessous : les deux champs sont mutuellement exclusifs, l'un des deux est toujours renseigné). |
| `categorieTempsInterne` | code → Temps interne, ou null | Temps interne auquel la dépense se rattache — renseigné uniquement si le frais n'est pas affecté à une affaire. Jamais un temps d'absence (exclu du choix proposé à la saisie). |
| `categorieFraisId` | référence → Sous-catégorie de frais | Voir section 12. |
| `refacturable` | booléen | N'a de sens que pour un frais affecté à une affaire : si vrai, le montant TTC s'impute sur la ligne « Frais Cabinet » du budget de l'affaire (cohérence budgétaire) ; si faux, reste hors budget affaire. Toujours faux pour un frais affecté à un temps interne. |
| `numeroBordereau` | référence → Bordereau de frais | Note de frais à laquelle ce frais est rattaché (voir section 11). |
| `lignesTVA` | liste de Ligne de TVA | 1 à 4 lignes — voir section 10. |
| `commentaire` | texte | Libre. |

Champs dérivés jamais stockés : `montantHT`, `montantTVA` et `montantTTC` (somme des `lignesTVA`) ; le statut affiché (« saisi » / « à payer » / « remboursé ») découle uniquement du statut du bordereau parent — jamais stocké sur le frais lui-même, pour exclure toute désynchronisation entre un frais et sa note.

## 10. Ligne de TVA (sous-table du Frais)

| Champ | Type | Signification |
|---|---|---|
| `tauxTVA` | nombre (%) | Un des 5 taux en vigueur en France : 20, 10, 5,5, 2,1 ou 0 (constante `TAUX_TVA`). |
| `montantHT` | nombre (€) | Montant hors taxes de cette ligne. |
| `montantTVA` | nombre (€, dérivé) | = `montantHT × tauxTVA / 100`, calculé automatiquement à la saisie. |

Exemple réel du jeu de données : un repas au restaurant peut porter une ligne à 10 % sur le repas et une seconde ligne à 20 % sur les boissons alcoolisées — d'où jusqu'à 4 lignes possibles sur une même dépense.

## 11. Bordereau de frais (note de frais)

| Champ | Type | Signification |
|---|---|---|
| `numero` | texte | Format `FRAIS_<trigramme>_<année>_<n° séquentiel sur 3 chiffres>`, ex. « FRAIS_RBL_2026_002 ». Incrémenté par consultant et par année (champ seq). |
| `consultantId` | référence → Consultant | Titulaire de la note. |
| `annee` | nombre | Année de la note. |
| `seq` | nombre | Rang de la note pour ce consultant sur cette année (sert à composer numero). |
| `statut` | texte (3 valeurs) | « en saisie » → « note à payer » → « payée ». |
| `datePaiement` | date ou null | Renseignée uniquement au passage à « payée » (action du cabinet). |

Cycle de vie : un seul bordereau « en saisie » à la fois par consultant et par année — tout nouveau frais rejoint ce bordereau ouvert. Le consultant le fait passer à « note à payer » depuis « Mes frais » ; un administrateur le fait passer à « payée » avec la date du jour depuis Cabinet Démo > Frais (directement depuis le tableau « Notes de frais », ou depuis le détail d'une note), ce qui fait passer automatiquement tous ses frais en statut affiché « remboursé ». Un nouveau frais saisi après clôture ouvre le bordereau suivant.

## 12. Facture

| Champ | Type | Signification |
|---|---|---|
| `id` | texte | Identifiant unique. |
| `affaireId` | référence → Affaire | L'affaire facturée — une affaire peut porter plusieurs factures. |
| `numero` | texte | Numéro de facture, saisi à la main (référence du logiciel de facturation externe — l'outil ne fait pas foi pour la numérotation légale). Facultatif tant que la facture est « prévisionnelle » ; un avertissement non bloquant s'affiche si on la dépose sans numéro renseigné. |
| `formation` | booléen | Case « Formation » — coché = 0 % de TVA sur les lignes mission et sous-traitance ; décoché = 20 %. Seul levier de TVA de ce module (contrairement aux Frais, qui autorisent les 5 taux français). |
| `montantMissionHT` | nombre (€) | Ligne « budget mission », HT. Montant TTC dérivé = `montantMissionHT × (1 + taux/100)`. |
| `montantSousTraitanceHT` | nombre (€) | Ligne « sous-traitance refacturée » au client, HT, mêmes règles de TVA que la mission. Distincte du montant que le cabinet paie lui-même au sous-traitant (champ `montant` de Partenaire d'affaire, section 5). |
| `montantFraisTTC` | nombre (€) | Ligne « frais », saisie directement en TTC (pas de détail HT/TVA à ce niveau, contrairement aux notes de frais). |
| `echeancePrev` | date | Échéance prévisionnelle de facturation (de dépôt) — base de calcul du sélecteur d'année et des tuiles « Total facturé » et « En attente/prévisionnel » de la page Facturation. |
| `dateDepot` | date ou null | Date réelle de dépôt — renseignée automatiquement au passage au statut « facturée ». |
| `echeancePaiementPrev` | date | Échéance prévisionnelle de paiement. |
| `datePaiement` | date ou null | Date réelle de paiement — renseignée automatiquement au passage au statut « payée », et effacée si ce statut est annulé. Base de calcul de la tuile « Total payé » de la page Facturation (voir note ci-dessous). |
| `payee` | booléen | Synchronisé avec le statut « payée ». |
| `statut` | texte (4 valeurs) | « prévisionnelle » → « facturée » → « payée », ou « annulée » — voir cycle ci-dessous. |
| `commentaires` | texte | Libre (onglet Notes). |

#### Cycle de statut

- prévisionnelle → facturée : action « Marquer déposée » — fixe la date de dépôt à aujourd'hui.
- facturée → payée : case « Facture payée » — fixe la date de paiement à aujourd'hui.
- payée → facturée : décocher la case « Facture payée » déclenche une confirmation (« Êtes-vous sûr de vouloir annuler le statut « payée » de cette facture ? ») ; une fois confirmée, le statut repasse à « facturée » et la date de paiement est effacée. Le paiement n'est donc pas irréversible depuis cette case.
- prévisionnelle ou facturée → annulée : action « Annuler la facture », état terminal — une facture déjà payée ne peut plus être annulée depuis l'interface.

Champs dérivés jamais stockés : `factureTotalHT = montantMissionHT + montantSousTraitanceHT` (les frais n'ont pas de « HT » dans ce total) ; `factureTotalTTC = missionTTC + montantFraisTTC + sousTraitanceTTC`.

> *Sur la page Facturation, les tuiles « Total facturé » et « En attente/prévisionnel » filtrent les factures de l'année sélectionnée sur `echeancePrev` (échéance prévisionnelle), tandis que la tuile « Total payé » filtre sur `datePaiement` (date de paiement effective) — une facture échéancée une année mais payée l'année suivante compte donc dans le total payé de l'année de paiement, et non dans celui de son échéance. Le sélecteur d'année de la page inclut à la fois les années présentes dans `echeancePrev` et celles présentes dans `datePaiement` pour les factures payées, afin qu'une telle année reste sélectionnable même sans aucune facture échéancée dessus.*

> *5 alertes calculées à partir de cette table et de l'Affaire (détaillées dans le cahier des charges, section 6) : les 4 alertes de facturation (retard de dépôt, retard de paiement, écart entre l'échéancier de facturation d'une affaire et son budget vendu, affaire facturable sans aucune facture échéancée), calculées sur les affaires « en production » ou « terminée » ; et, à part, les 5 alertes de pilotage d'affaire (incohérences budgétaires, absence de caractéristiques, missions non créées, missions ou affaire à rééchéancer), calculées sur les affaires « en commercialisation » ou « en production ».*

## 13. Listes de référence

Éditables par un administrateur depuis Administration > Tables & réglages, à l'exception des Temps internes et Temps d'absence, qui sont une liste fixe dans le code.

#### Méthode, Type de territoire, Domaine d'intervention

| Champ | Type | Signification |
|---|---|---|
| `id` | texte | Identifiant stable (« ME1 », « TE1 », « DO1 », …), conservé sur les affaires qui la cochent même si le libellé est renommé ensuite. |
| `label` | texte | Libellé affiché. |

#### Sous-catégorie de frais

| Champ | Type | Signification |
|---|---|---|
| `id` | texte | Identifiant stable (« CF1 », « CF2 », …, compteur `nextCategorieFraisId`). |
| `categorie` | texte | Catégorie parente (ex. « Déplacement », « Hébergement », « Restauration », « Achats », « Communication et Marketing », « Frais administratifs »). Sert à regrouper les sous-catégories par optgroup dans le formulaire de saisie. |
| `label` | texte | Libellé de la sous-catégorie (ex. « Train TER », « Voiture IKA »). |

#### Temps interne, Temps d'absence

| Champ | Type | Signification |
|---|---|---|
| `code` | texte | Identifiant fixe (ex. « ADM », « FORM », « CONG », « MAL »), non modifiable depuis l'interface. |
| `label` | texte | Libellé affiché. |

## 14. Persistance V1 et évolution possible

La V1 dispose désormais d'une vraie persistance partagée, mais sans normaliser immédiatement les quatorze entités dans quatorze tables SQL. L'état métier complet est conservé dans SQLite sous forme JSON versionnée (`app_state`), complété par un historique court (`state_history`) utilisé pour la synchronisation optimiste.

Ce choix est volontaire : la structure fonctionnelle du prototype est riche et déjà validée, tandis que l'usage attendu reste d'environ cinq personnes. Le passage direct à un modèle SQL entièrement normalisé aurait augmenté le risque et la quantité de code sans améliorer le besoin immédiat.

Les identifiants et relations décrits dans ce document restent néanmoins la **référence métier**. Ils continuent d'être utilisés dans le JSON, et les nouveaux objets créés côté navigateur utilisent des identifiants uniques pour éviter les collisions lors de saisies simultanées.

Une migration ultérieure vers des tables relationnelles dédiées (SQLite normalisé ou PostgreSQL) devient pertinente seulement si un besoin réel apparaît : plusieurs dizaines d'utilisateurs actifs, plusieurs instances serveur, intégrations SI, requêtes/reporting directement sur la base, volume important ou conflits d'écriture fréquents. Dans ce cas, les entités et clés étrangères décrites dans ce document constituent toujours le schéma de départ.
