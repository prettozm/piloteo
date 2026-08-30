# Cahier des charges — Pilotéo

*V4 / V1 exploitable — 29 août 2026 : conserve le périmètre fonctionnel V3 et ajoute le socle multi-utilisateur professionnel minimal (authentification, permissions serveur, persistance partagée, synchronisation, sauvegardes, audit et support administrateur).*

*Outil de suivi des affaires, du commercial, des temps et de la facturation — Cabinet Démo*

Ce document décrit Pilotéo tel qu'il existe aujourd'hui. Il ne fait pas référence à l'historique des demandes qui a mené jusqu'ici : il constitue une référence autonome, à mettre à jour à mesure que l'outil évolue. Le détail technique des données (tables, champs, relations) fait l'objet d'un document séparé, [« Pilotéo — Modèle de données »](modele-de-donnees.md), pensé aussi comme une sauvegarde de la structure de l'outil, indépendante de la page web elle-même.

## 1. Objectif de l'outil

- Permettre à chaque consultant de saisir et suivre son temps, en distinguant temps facturable et non facturable (missions, temps internes, absences).
- Suivre, pour chaque affaire, la consommation en jours et en euros par rapport au budget vendu — missions, frais et sous-traitance confondus.
- Suivre le bilan de production d'un consultant (jours facturables, TJM vendu/réel, missions) sur une période donnée, et le même bilan agrégé à l'échelle du cabinet.
- Projeter les temps restant à faire, par mission et sur les prochains mois, avec un calcul automatique ajustable à la main.
- Gérer les frais professionnels des consultants de bout en bout : saisie (avec TVA), affectation à une affaire ou à un temps interne, distinction refacturable/non refacturable au client, regroupement en notes de frais, cycle de remboursement.
- Suivre le pipeline commercial du cabinet et de chaque consultant : offres déposées, taux de transformation, performance par pilote commercial, potentiel pondéré des offres en décision.
- Suivre la facturation de chaque affaire : échéancier de dépôt et de paiement, statut de chaque facture, alertes de retard et d'écart avec le budget vendu.
- Donner à chaque pilote une vision synthétique de ses propres affaires et alertes (« Mon Pilotage »), et au cabinet une vision consolidée de ses frais, de sa facturation, de son commercial et de ses consultants (effectifs, statuts, TJM).

## 2. Architecture, hébergement et sauvegarde

Pilotéo V1 est une application web à **une seule instance serveur**. L'interface métier reste dans `index.html`; un serveur Python standard (`server.py`) apporte l'authentification, les permissions, la persistance SQLite, la synchronisation, l'audit et les sauvegardes.

- Les données métier réelles sont stockées dans `data/piloteo.sqlite3`, pas dans le navigateur.
- Le navigateur ne conserve l'état que temporairement en mémoire et synchronise automatiquement après une modification.
- Toutes les 10 secondes, un navigateur sans modification locale vérifie si une révision plus récente existe.
- Des modifications concurrentes sur des données différentes sont fusionnées ; une modification concurrente de la même donnée déclenche un conflit explicite et recharge la version serveur plutôt qu'un écrasement silencieux.
- SQLite fonctionne en mode WAL, suffisant pour le volume attendu (environ cinq utilisateurs et légère extension).
- Une sauvegarde cohérente est créée automatiquement au maximum une fois par jour et peut être déclenchée manuellement par un administrateur. Le dossier de sauvegarde doit être répliqué hors du serveur principal pour protéger réellement d'une panne disque.

#### Accès et confidentialité

- Usage réel uniquement derrière HTTPS (`PILOTEO_FORCE_HTTPS=1`).
- Aucun appel à Google Fonts, analytics ou autre ressource tierce depuis l'application.
- Les fichiers de données du serveur ne sont pas publiés : seules l'interface, la console support et les API prévues sont servies.
- Les données non autorisées sont filtrées **avant** d'être envoyées au navigateur. Le masquage des menus n'est qu'une mesure d'ergonomie.

## 3. Identification et rôles

Chaque personne dispose d'un compte nominatif avec identifiant et mot de passe. Les mots de passe sont hachés côté serveur ; la session est portée par un cookie `HttpOnly` et protégée par un jeton CSRF pour les écritures.

### Utilisateur standard

Accès à son espace personnel et aux données qui le concernent : ses temps, ses frais, les affaires où il est pilote/pilote commercial/contributeur, et les missions auxquelles il est affecté. Les informations d'autres consultants ne sont envoyées qu'au minimum nécessaire à l'affichage des noms ; leur TJM n'est pas exposé.

### Pilote d'affaire

Le rôle reste dérivé du champ `pilote` de l'affaire. Le pilote reçoit les éléments nécessaires au calcul et au suivi de cette affaire et peut modifier l'affaire existante ainsi que ses missions. La création d'une nouvelle affaire reste réservée à l'administrateur en V1.

### Administrateur

Accès au cabinet entier, aux consultants, organisations, référentiels, frais, facturation et à la console `/support`. Cette console permet de créer/désactiver les comptes, réinitialiser un mot de passe, accorder le rôle administrateur, déclencher une sauvegarde et consulter le journal d'audit.

La fonction « Voir sa page » est conservée pour le support. Même en consultant temporairement l'interface d'un autre consultant, les actions restent authentifiées et auditées sous le compte administrateur réel.

Les permissions sont contrôlées à chaque synchronisation côté serveur. Une modification fabriquée manuellement dans le navigateur ne contourne donc pas les droits.

## 4. Modèle de données — vue d'ensemble

Pilotéo repose sur une quinzaine d'entités : Consultants, Organisations, Affaires (avec leurs Partenaires et leur Répartition commerciale), Missions, Saisies de temps, Frais (avec leurs lignes de TVA et leurs Notes de frais / bordereaux de remboursement), Factures, et plusieurs listes de référence éditables (Méthodes, Types de territoire, Domaines d'intervention, Sous-catégories de frais, Temps internes, Temps d'absence). Le détail complet — champs, types, relations, règles de calcul — fait l'objet du document séparé [« Pilotéo — Modèle de données »](modele-de-donnees.md), pensé pour rester lisible indépendamment du code de l'outil.

## 5. Navigation et pages

### 5.1 Rubrique « Moi »

#### Vue rapide

Tableau de bord personnel du consultant connecté : affaires et missions en cours qui le concernent, indicateurs de production (jours facturables, TJM vendu/réel, taux de charge, commercial gagné dans l'année), histogramme « Ma production de missions » (missions non facturable, missions facturable saisi et missions facturable projeté, empilés en jours — toujours en jours, un jour non facturable n'ayant pas d'équivalent en euros dans l'outil).

- À chaque arrivée sur la page, une fenêtre s'affiche en bas de l'écran s'il existe au moins une alerte de facturation ou de pilotage d'affaire non corrigée sur le périmètre du consultant connecté, avec le décompte de chacune et un lien direct vers « Mon Pilotage ».

#### Mon Pilotage

Tableau de bord des affaires pilotées par le consultant connecté :

- Mes affaires — même tableau que sur Vue rapide (mêmes colonnes, même bandeau RAF jours/€, même clic vers la fiche affaire).
- Mes alertes de facturation — même système à 4 boutons que Cabinet Démo > Facturation (affaires non échéancées / affaires partiellement échéancées / factures non déposées / factures en souffrance, sélection unique), réduit aux seules affaires dont le consultant connecté est pilote.
- Alertes sur mon pilotage d'affaire — 5 catégories à sélection unique (incohérences budgétaires, absence de caractéristiques, missions non créées, missions à rééchéancer, affaire à rééchéancer — détail en section 6), réduites au même périmètre, avec un détail simplifié en liste (nom de l'affaire ou de la mission, client) et un bouton « Compléter/corriger » vers la fiche affaire concernée.

#### Mon commercial

Réplique personnelle du suivi commercial société (voir 5.2), filtrée et pondérée par la part de répartition commerciale du consultant sur chaque affaire — distingue explicitement les offres qu'il pilote de celles où il n'est que contributeur crédité. Mêmes indicateurs et graphiques que la vue société (répartition gagné/perdu/en décision, évolution par année, taux de transformation par type de vente), sans le graphique « par pilote commercial » ni le bloc « Pipeline en attente », propres à la vue société.

#### Mes temps

Saisie et consultation des temps du consultant connecté (missions, temps internes, absences), avec bascule vue du mois / vue de l'année, export CSV, histogramme de répartition complète des temps et camembert de répartition annuelle, et le tableau de suivi mensuel détaillé (une ligne par affaire/mission/temps interne/absence).

#### Mes frais

Saisie et suivi des frais professionnels du consultant connecté :

- Chaque frais est affecté soit à une affaire, soit à un temps interne — jamais les deux — via un choix « Affecté à » ; les temps d'absence ne sont volontairement jamais proposés. La case « Refacturable » n'a de sens que pour un frais affecté à une affaire (c'est ce qui l'impute sur son budget « Frais Cabinet ») : masquée et sans effet pour un frais interne.
- Chaque frais porte par ailleurs une date, une sous-catégorie, et un détail HT/TVA pouvant cumuler jusqu'à 4 taux de TVA différents sur une même note (ex. un repas à 10 % et des boissons alcoolisées à 20 %) — montants HT, TVA et TTC calculés automatiquement.
- Deux donuts « Frais non refacturables », toujours à l'année : répartition par grande catégorie de frais, et répartition par affaire (regroupées en une seule part « Affaires ») et par grand groupe de temps interne.
- Chaque consultant dispose d'un trigramme (2 premières lettres du prénom + 1re lettre du nom, calculé automatiquement à sa création, avec gestion des doublons).
- Les frais saisis se regroupent automatiquement sur une note de frais numérotée `FRAIS_<trigramme>_<année>_<n° séquentiel>`, incrémentée par consultant et par année.
- Cycle de vie de la note : « en saisie » (le consultant peut encore y ajouter des frais) → « note à payer » (dès qu'il clique sur « Demander le paiement ») → « payée » (action du cabinet, avec date de paiement). Le statut affiché de chaque frais (saisi / à payer / remboursé) en découle automatiquement.

### 5.2 Rubrique « Cabinet Démo »

#### Vue rapide

Vue consolidée du cabinet, filtrée par année : indicateurs clés (effectifs, ETP, production, taux de charge global, % non facturable), histogramme de production mensuelle — avec une couche optionnelle « Potentiel commercial » superposable (le pipeline commercial pondéré par le % de réussite de chaque offre, lissé sur sa période prévisionnelle) —, histogramme de répartition complète des temps, camembert de répartition annuelle, tableau Effectifs, tableau Production par affaire, tableau de suivi des temps agrégé.

#### Portefeuille

Panneau « Alertes Affaires », au-dessus du tableau des affaires : même principe à 5 boutons à sélection unique et même détail simplifié en liste que « Alertes sur mon pilotage d'affaire » (Mon Pilotage), mais portant sur toutes les affaires du cabinet, tous consultants confondus, dont le statut est « en commercialisation » ou « en production » (ni terminées, ni perdues).

Portefeuille complet du cabinet (recherche par mots-clés, filtre par statut, export CSV) et fiche détaillée par affaire :

- Caractéristiques : organisation cliente, nom abrégé, mots-clés, pilote et pilote commercial, type de vente, % de réussite, dates prévisionnelles, méthodes / types de territoire / domaines d'intervention, jusqu'à 5 partenaires (organisation, rôle parmi mandataire / co-traitant / sous-traitant direct / sous-traitant indirect, montant à payer pour les sous-traitants indirects). Tous les champs sont obligatoires à l'enregistrement, sauf mots-clés, frais Cabinet et partenaires — un message précise le premier champ manquant et ouvre l'onglet concerné.
- **Cohérence budgétaire :** le budget vendu de l'affaire (« Prestations Cabinet ») doit en principe se répartir entre trois lignes — le budget des missions (jours × TJM), les frais engagés refacturables (« Frais Cabinet », comparés en TTC) et la sous-traitance à payer aux partenaires « sous-traitant indirect ». Un indicateur visuel (vert / orange / rouge) compare en permanence la somme de ces trois lignes au budget vendu, complété par une jauge dédiée au pourcentage de frais non refacturables rapporté au montant des missions.
- Missions de l'affaire : une ligne par mission (consultant, statut, enveloppe en jours, TJM, dates bornées par celles de l'affaire), avec détail des temps saisis et export CSV. Tous les champs de saisie sont obligatoires sauf les commentaires.
- Factures de l'affaire : une ligne par facture (numéro, statut avec badge de retard le cas échéant, échéance, total HT, total TTC), bouton « + Nouvelle facture », export CSV.
- Bouton « Voir les frais » sur la carte Frais : liste tous les frais de l'affaire (refacturables et non), tous consultants confondus.

#### Suivi commercial

Vue société du pipeline commercial, filtrée par année de dépôt des offres :

- Indicateurs : offres déposées, répartition gagné/perdu/en décision (nombre, montant, jours), montant gagné, taux de transformation, plus deux tuiles « Pipeline — toutes années » et « Pipeline pondéré — toutes années », indépendantes de l'année sélectionnée (photo instantanée de toutes les offres encore en commercialisation).
- Graphiques : répartition gagné/perdu/en décision (donut, togglable nombre/montant), évolution par année de dépôt, taux de transformation par type de vente (barres groupées sur les 3 dernières années), répartition et performance par pilote commercial.
- Tableau détaillé des offres de l'année sélectionnée, export CSV.

#### Facturation

Page dédiée au suivi de toutes les factures du cabinet, filtrée par année :

- **Indicateurs :** total facturé (HT et TTC) et total en attente/prévisionnel (HT et TTC), filtrés sur l'échéance prévisionnelle de facturation de l'année sélectionnée ; total payé (HT et TTC), filtré différemment — sur la date de paiement effective des factures, pour refléter des encaissements réels — de sorte qu'une facture échéancée une année mais payée l'année suivante compte dans le total payé de l'année de paiement, et non dans celui de son échéance.
- Histogramme « Facturation » empilé par mois (missions, frais refacturables, et une 3ᵉ couche optionnelle « sous-traitance à régler »), sur la même base que les indicateurs facturés.
- Panneau « Alertes de facturation » listant les 4 types d'alerte (voir section 6), chacune cliquable vers la fiche de l'affaire concernée.
- Tableau de toutes les factures du cabinet (affaire et client, responsable, numéro, statut, échéances, montants HT/TTC), export CSV.
- Chaque facture se crée et se modifie depuis une fenêtre à 3 onglets : Saisie (numéro, case « Formation » qui exonère de TVA, montants HT/TTC des 3 lignes possibles — mission, frais, sous-traitance refacturée), Suivi (échéances, bouton « Marquer déposée », case « Facture payée » — cochable et décochable, la décocher déclenchant une confirmation avant de repasser la facture au statut « facturée » —, bouton « Annuler la facture »), Notes (commentaires libres).

#### Clients et Partenaires

Liste des organisations du cabinet, avec un statut dérivé automatiquement (jamais saisi à la main) et cumulable : « cliente » dès qu'une affaire lui est rattachée au statut en production ou terminée, « prospect » si elle n'a que des affaires en commercialisation ou perdues (ou aucune affaire), « partenaire » dès qu'elle apparaît dans la sous-table Partenaires d'une affaire, quel que soit son rôle. La colonne Affaires est ventilée entre ces trois catégories, avec un accès direct à chacune.

#### Consultants

Page dédiée à la gestion des consultants du cabinet : création et modification (nom, statut en poste/stagiaire/parti, dates d'arrivée/de départ, TJM objectif, temps partiel par période, droit administrateur), trigramme en lecture seule, ETP de l'année, export CSV, et un bouton « Voir sa page » par ligne (voir section 3).

#### Frais

Vue exhaustive des frais du cabinet, tous consultants confondus, filtrée par année : histogramme mensuel empilé refacturable/non refacturable (TTC), deux donuts « Frais non refacturables » (par grande catégorie, et par affaire/temps interne) à droite de l'histogramme, tableau détaillé de tous les frais (colonnes de taux et montant de TVA séparées, à l'écran comme à l'export CSV), panneau « Notes de frais » avec ligne de total et clic sur une note pour ouvrir son détail (liste de ses frais, action « Marquer comme payée » accessible depuis le tableau comme depuis le détail).

### 5.3 Rubrique « Administration »

#### Tables & réglages

Listes de référence éditables par un administrateur, utilisées comme caractéristiques cochables sur les affaires ou comme sous-catégories de frais : Méthodes, Types de territoire, Domaines d'intervention, Sous-catégories de frais (regroupées par catégorie parente). Un identifiant stable est conservé sur chaque affaire ou frais caractérisé, pour qu'un renommage ultérieur n'invalide pas les données déjà saisies.

## 6. Règles de cohérence et alertes

- **Budget de l'affaire :** un indicateur visuel (vert / orange / rouge) compare en permanence missions + frais refacturables + sous-traitance au budget vendu — non bloquant, la saisie reste possible même en cas de dépassement.
- **Dates des missions :** les dates prévisionnelles d'une mission ne peuvent pas sortir de la fourchette définie par les dates prévisionnelles de l'affaire — règle bloquante, contrairement aux alertes budgétaires.
- **Dépassement de l'enveloppe facturable d'une mission :** si une saisie de temps fait dépasser l'enveloppe restante, le surplus bascule automatiquement en temps non facturable (message informatif, pas de choix à faire). Au-delà de 20 % de dépassement cumulé, un badge rouge s'affiche sur la mission partout où elle apparaît.
- **Champs obligatoires :** les modules de saisie Affaire et Mission bloquent l'enregistrement tant qu'un champ requis n'est pas renseigné (exceptions détaillées en section 5.2) — règle bloquante, contrairement aux alertes budgétaires.
- **Statuts dérivés jamais désynchronisés :** le statut d'un frais (saisi / à payer / remboursé) découle toujours de celui de sa note de frais, et le statut d'une organisation (cliente / prospect / partenaire) découle toujours des affaires qui lui sont rattachées — aucun des deux n'est un champ saisi à la main.

#### Les 4 alertes de facturation

Calculées sur les affaires au statut « en production » ou « terminée » uniquement, remontées sur la page Facturation (à l'échelle du cabinet) et sur Mon Pilotage (réduites aux affaires du consultant connecté) :

- **Retard de dépôt —** une facture encore « prévisionnelle » dont l'échéance de facturation est dépassée. Badge « J+N ».
- **Retard de paiement —** une facture « facturée » non payée dont l'échéance de paiement est dépassée (ou, à défaut d'échéance renseignée, 30 jours après le dépôt). Badge « J+N ».
- **Écart de facturation —** le total des factures non annulées d'une affaire ne correspond pas à son budget vendu.
- **Facturation non planifiée —** une affaire facturable sans aucune facture, même prévisionnelle.

#### Les 5 alertes de pilotage d'affaire

Calculées sur les affaires (et missions) dont le consultant est pilote, remontées sur Mon Pilotage (réduites au consultant connecté) et sur Portefeuille (Cabinet Démo > Affaires, toutes affaires du cabinet en commercialisation ou en production, ni terminées ni perdues) :

- **Incohérences budgétaires —** missions + frais + sous-traitance ≠ budget vendu (même calcul que le panneau « Cohérence budgétaire » de la fiche affaire), hors affaires perdues.
- **Absence de caractéristiques —** méthode, type de territoire ou domaine d'intervention non renseigné.
- **Missions non créées —** jours vendus de l'affaire pas totalement couverts par des missions créées (affaires en production uniquement — ne s'applique pas à celles encore en commercialisation).
- **Missions à rééchéancer —** mission encore « en cours » dont l'échéance est dépassée.
- **Affaire à rééchéancer —** affaire encore active (en commercialisation ou en production) dont l'échéance est dépassée.

## 7. Visualisations

- **Ma production de missions (Vue rapide, Moi) —** histogramme empilé mensuel en jours, missions non facturable / facturable saisi / facturable projeté (hachuré) ; toujours en jours, pas de bascule €.
- **Production facturable (Vue rapide, Cabinet Démo) —** histogramme empilé mensuel, réalisé + prévisionnel, bascule jours/€ ; une couche optionnelle « Potentiel commercial » (pipeline pondéré) peut se superposer.
- **Répartition complète des temps (Mes temps et Vue rapide Cabinet Démo) —** histogramme empilé mensuel en jours (missions facturable/non facturable, temps internes, absences).
- **Répartition des temps — vue annuelle (Mes temps et Vue rapide Cabinet Démo) —** camembert à 8 catégories (production facturable/non facturable, 5 regroupements de temps internes, autres).
- **Frais non refacturables (Mes frais et Cabinet Démo > Frais) —** deux donuts à l'année : répartition par grande catégorie, et par affaire (regroupée en une seule part) / grand groupe de temps interne.
- **Taux de charge (Vue rapide Moi et Cabinet Démo) —** jauge circulaire, verte jusqu'à 100 %, orange jusqu'à 120 %, rouge au-delà.
- **TJM (Vue rapide, Moi) —** barre positionnant le TJM vendu et le TJM réel de part et d'autre du TJM objectif, colorée selon l'écart.
- **Répartition gagné / perdu / en décision (Suivi commercial et Mon commercial) —** camembert togglable nombre/montant.
- **Évolution par année de dépôt (Suivi commercial et Mon commercial) —** histogramme empilé, une barre par année.
- **Taux de transformation par type de vente —** barres groupées sur les 3 dernières années (Suivi commercial) ; une seule barre par type sur l'année sélectionnée (Mon commercial).
- **Répartition et performance par pilote commercial (Suivi commercial) —** barres classées par montant déposé, taux de réussite affiché en regard.
- **Facturation (Cabinet Démo > Facturation) —** histogramme empilé par mois : missions, frais refacturables, et une 3ᵉ couche optionnelle sous-traitance à régler.
- **Frais par mois (Cabinet Démo > Frais) —** histogramme empilé refacturable / non refacturable, en TTC.
- **Jauges de cohérence budgétaire (fiche affaire) —** missions / frais / sous-traitance vs budget vendu, complétées par une jauge dédiée au pourcentage de frais non refacturables rapporté au montant des missions (dégradé jaune → rouge foncé, curseur positionné au pourcentage exact).

## 8. Fonctionnalités transversales

- Tri et filtre par colonne sur l'ensemble des tableaux de l'outil, avec totaux en pied de tableau.
- De nombreux tableaux (Portefeuille, Consultants, Clients et Partenaires, Notes de frais...) sont cliquables ligne par ligne, pour ouvrir directement la fiche ou le détail concerné.
- Pagination générique : tout tableau de plus de 10 lignes propose un choix d'affichage (10 / 25 / 50 lignes ou Tout) avec navigation page à page ; le pied de tableau continue de totaliser l'ensemble des lignes filtrées, pas seulement la page affichée.
- Recherche par mots-clés sur le portefeuille d'affaires.
- Export CSV disponible sur la quasi-totalité des tableaux (ouverture native dans Excel).
- Identité visuelle du cabinet : palette de couleurs du cabinet (vert, ocre, jaune, plus une échelle de couleurs dédiée aux graphiques), logo affiché dans la barre latérale, aucune adaptation au thème sombre du navigateur (choix assumé, fond toujours clair).

## 9. Développements identifiés mais non commencés

#### Table Contacts

Envisagée dès le cahier des charges initial (contacts nominatifs rattachés à une organisation, avec un lien vers les partenaires d'affaire) mais jamais construite — mise de côté explicitement, pas abandonnée. À reconfirmer avec le cabinet avant de la construire.

#### Autres pistes identifiées en cours de route

- Rendre administrables les listes « Temps internes » et « Temps des absences » (aujourd'hui figées dans le code), sur le même principe que les autres listes de référence déjà administrables.
- Calcul automatique d'un TJM moyen par affaire (aujourd'hui seul un TJM moyen agrégé à l'échelle du cabinet existe).
- Graphique « Suivi des jours de production facturable » à fenêtre glissante de 12 mois, par consultant, sur la vue société.
- Étendre la recherche par mots-clés à la page Suivi commercial (aujourd'hui limitée au portefeuille des affaires).
- Aligner le graphique « Taux de transformation par type de vente » de « Mon commercial » sur la version à 3 ans de la page société, si cette évolution est jugée utile au niveau individuel.
- Champ logo sur la fiche organisation.
- Réflexion à mener sur l'application effective des rôles (administrateur/pilote) comme de véritables permissions techniques, si l'outil devait s'ouvrir à un cercle d'utilisateurs plus large que le cabinet actuel.
