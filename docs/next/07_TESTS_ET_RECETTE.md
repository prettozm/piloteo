# Pilotéo Next — Tests et recette

## 1. Philosophie

La migration n’est acceptée que si elle conserve le métier existant et prouve les nouveaux invariants local-first.

---

## 2. Tests existants

Conserver autant que possible les scénarios V1 :

- droits ;
- filtrage ;
- synchronisation ;
- concurrence ;
- XSS ;
- exports ;
- règles fonctionnelles.

Les tests HTTP disparaîtront progressivement ; leurs intentions doivent être réécrites au niveau des nouveaux composants.

---

## 3. Tests `LocalStore`

- création workspace ;
- fermeture/réouverture ;
- isolation de deux workspaces ;
- corruption d’un store ;
- export/import ;
- migration de schéma IndexedDB.

---

## 4. Tests EventLog

- événement unique ;
- doublon ;
- replay ;
- suppression de projection puis rebuild ;
- ordre de réception différent ;
- événement inconnu ;
- schema version incompatible.

Invariant :

> même journal valide = même projection.

---

## 5. Tests droits

Reprendre la matrice V1.

Cas minimum :

- user modifie ses temps ;
- user ne modifie pas consultant tiers ;
- pilote modifie affaire pilotée ;
- pilote ne modifie pas affaire non pilotée ;
- admin modifie référentiel ;
- acteur révoqué rejeté ;
- événement signé valide mais métier interdit rejeté.

---

## 6. Tests validation structurelle

Obligatoires :

- `NaN`;
- `Infinity`;
- chaîne à la place d’un nombre ;
- objet à la place d’une date ;
- enum inconnu ;
- payload géant ;
- référence inexistante ;
- identifiant workspace étranger.

Aucun événement invalide ne doit contaminer la projection.

---

## 7. Tests concurrence

### Entités différentes

Alice et Bob partent du même état.

Alice modifie A.

Bob modifie B.

Après synchro :

- Alice voit A+B ;
- Bob voit A+B.

### Même entité

Alice et Bob modifient A sur même version.

Une modification est acceptée.

L’autre devient conflit.

Aucun écrasement silencieux.

---

## 8. Tests crypto

- ciphertext non lisible ;
- mauvais tag → rejet ;
- mauvais nonce/clé → rejet ;
- signature invalide → rejet ;
- événement modifié → rejet ;
- mauvaise epoch → traitement explicite ;
- clé révoquée ne lit pas nouvelle epoch.

Ne pas valider seulement le “happy path”.

---

## 9. Tests Drive

Matrice :

- My Drive Gmail ;
- My Drive Workspace ;
- Shared Drive Workspace ;
- compte sans accès ;
- accès retiré ;
- token expiré ;
- offline ;
- retry ;
- duplication upload ;
- invitation avec mauvaise identité Google.

Tester explicitement `drive.file` et le parcours Picker éventuel.

---

## 10. Tests PWA

- première visite online ;
- installation ;
- ouverture offline ;
- nouvelle version disponible ;
- refresh ;
- cache ancien ;
- IndexedDB conservé après mise à jour ;
- mode navigation privée non supporté clairement signalé si nécessaire.

---

## 11. Tests licence

- trial J0 ;
- J19 ;
- J20 ;
- J21 ;
- licence valide ;
- mauvaise signature ;
- mauvais workspace ;
- expirée ;
- perpétuelle ;
- limite membres ;
- expiration → export fonctionne.

---

## 12. Test migration V1

Pour chaque collection :

- nombre d’entités ;
- ids ;
- relations ;
- champs ;
- sommes de contrôle.

Comparer :

```text
V1 export
vs
projection Next après import
```

Les indicateurs métier critiques doivent aussi produire les mêmes résultats.

---

## 13. Recette humaine minimale

Deux utilisateurs, deux navigateurs/profils.

1. owner crée ACME ;
2. invite user ;
3. user rejoint ;
4. owner crée une affaire ;
5. user saisit du temps ;
6. owner voit la saisie ;
7. les deux passent offline ;
8. chacun modifie une entité différente ;
9. retour online → convergence ;
10. conflit volontaire sur même mission ;
11. révocation user ;
12. user ne reçoit pas nouvelle donnée ;
13. export complet ;
14. reconstruction sur navigateur vierge ;
15. installation licence ;
16. simulation expiration.

---

## 14. Performance

Bench de référence :

- 5 utilisateurs / 5 000 événements ;
- 20 utilisateurs / 50 000 événements.

Mesurer :

- démarrage chaud ;
- premier rebuild ;
- sync incrémentale ;
- IndexedDB ;
- appels Drive ;
- taille stockage.

N’optimiser qu’après mesure.

---

## 15. Définition de Done de la migration

La migration n’est Done que si :

- tous les tests fonctionnels métier restent verts ;
- les nouveaux tests local-first sont verts ;
- un export V1 réel migre ;
- zéro donnée métier en clair sur Drive ;
- zéro backend métier requis ;
- documentation à jour ;
- un autre développeur/IA peut reprendre à partir de `08_AI_HANDOFF.md`.
