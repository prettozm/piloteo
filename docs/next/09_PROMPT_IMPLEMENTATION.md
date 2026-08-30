# Prompt de démarrage — Migration Pilotéo Next

À utiliser dans une session agent vierge avec le dépôt Pilotéo V1 et ce dossier de documentation.

---

Tu reprends le dépôt Pilotéo V1 `1.0.0`.

Objectif : faire évoluer progressivement Pilotéo vers l’architecture local-first décrite dans `docs/next/`, sans réécrire le métier et sans big bang.

Lis d’abord, dans cet ordre :

1. `README.md`
2. `docs/ARCHITECTURE_V1.md`
3. `docs/cahier-des-charges.md`
4. `docs/modele-de-donnees.md`
5. `docs/next/01_CDC_LOCAL_FIRST.md`
6. `docs/next/02_ARCHITECTURE_CIBLE.md`
7. `docs/next/03_MIGRATION_V1_VERS_LOCAL_FIRST.md`
8. `docs/next/08_AI_HANDOFF.md`

Puis inspecte `app.js` et `server.py`.

## Règle de travail

Pilotéo fonctionne aujourd’hui. Ne réécris pas ce qui fonctionne.

La première passe porte EXCLUSIVEMENT sur la Phase 1 du plan de migration :

> introduire une couche locale de persistance abstraite utilisant IndexedDB, tout en conservant `server.py` comme source de vérité et sans changer le comportement fonctionnel visible.

### Attendus de cette première passe

- créer une abstraction `LocalStore` claire et minimale ;
- stocker localement le workspace courant / projection reçue du serveur de façon contrôlée ;
- ne pas utiliser `localStorage` pour les données métier ;
- conserver les appels `/api/state` existants ;
- conserver la logique de permissions serveur existante ;
- conserver la synchro V1 existante ;
- ajouter les tests nécessaires ;
- documenter précisément ce qui a été ajouté ;
- ne pas commencer Google OAuth ;
- ne pas commencer Drive ;
- ne pas commencer la crypto ;
- ne pas commencer la licence ;
- ne pas introduire de framework front ;
- ne pas changer le modèle métier ;
- ne pas déplacer massivement `app.js`.

### Gate de sortie

La Phase 1 n’est terminée que si :

1. tous les tests V1 passent ;
2. le comportement utilisateur est identique ;
3. les données reçues peuvent être persistées/rechargées via l’abstraction locale ;
4. `LocalStore` peut ensuite devenir la source de vérité du mode Solo sans refonte ;
5. la documentation de reprise est mise à jour.

À la fin, fournis :

- fichiers modifiés ;
- tests exécutés et résultats ;
- décisions prises ;
- risques restants ;
- proposition précise pour la Phase 2, sans l’implémenter.

Le principe à respecter pendant tout le travail est :

> remplacer l’infrastructure, préserver le métier, répondre au strict nécessaire.
