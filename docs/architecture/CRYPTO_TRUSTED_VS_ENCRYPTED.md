# Pilotéo — Confiance de stockage : « Trusted » vs « Encrypted »

Ce document présente, **sans trancher**, les deux postures de confiance possibles
pour le contenu stocké par Pilotéo. La question se pose surtout en **mode
Dossier** (`docs/modes/FOLDER_STORAGE.md` §6), où les données vivent dans un
dossier du système d'information du client, mais elle vaut plus largement pour
tout stockage partagé.

L'objectif n'est pas de recommander une option, mais de **cadrer la démarche** :
évaluer par mode et par contexte client, à l'appui d'une revue de sécurité
dédiée.

---

## 1. Rappel : l'état de la crypto Pilotéo est EXPÉRIMENTAL

Pilotéo dispose déjà de primitives cryptographiques standard, décrites dans
`docs/architecture/02-securite-crypto-identite.md` :

- **Ed25519** — signature d'identité de membre et d'événement ;
- **AES-256-GCM** — chiffrement des payloads (AEAD, IV aléatoire par appel) ;
- **X25519 (ECDH-ES) + HKDF-SHA256** — enveloppe de clé de workspace
  (wrap/unwrap par membre), avec rotation par **epoch** (`keys/epoch-XXXX/`).

Ces primitives sont **réelles** (WebCrypto, `crypto.subtle`, aucune dépendance
npm crypto), mais leur assemblage est **EXPÉRIMENTAL** tant qu'une **revue de
sécurité humaine dédiée** n'a pas eu lieu (gate formalisé dans
`docs/architecture/02-securite-crypto-identite.md` et
`docs/next/05_SECURITE_CRYPTO_IDENTITE.md` §16 : format, distribution de clés,
invitation, rotation, CSP, stockage local des clés, recovery).

Deux conséquences pour cette passe :

- **Ne pas augmenter la complexité crypto.** On n'ajoute ni schéma, ni primitive,
  ni couche de gestion de clés supplémentaire tant que le gate n'est pas franchi.
- **Ne pas supprimer la crypto** existante non plus. L'implémentation et ses
  tests restent en place ; c'est l'**audit** qui manque, pas le code.

Aucune promesse commerciale de chiffrement (« l'éditeur ne peut pas lire vos
données ») ne peut être faite avant cette revue.

---

## 2. Option « Trusted »

Les données sont **lisibles** dans le stockage du client (par exemple JSON en
clair dans le dossier).

**Raisonnement.** Le dossier — ou le SI — est **déjà sous la responsabilité du
client** : son OneDrive/SharePoint d'entreprise, son NAS, son poste, chiffrés au
repos et gouvernés par ses propres politiques. Ajouter un chiffrement applicatif
par-dessus une infrastructure déjà maîtrisée **apporte peu de valeur** et
**complexifie la gestion de clés** (là où le SI n'en demande pas).

**Bénéfices.** Simplicité maximale ; inspection, sauvegarde et restauration
directes ; aucun risque de perte de données par perte de clé ; débogage trivial.

**Limites.** Aucune défense en profondeur : si le dossier **fuit hors** du
périmètre du SI (mauvais partage, poste perdu, sauvegarde égarée), le contenu est
lisible tel quel.

---

## 3. Option « Encrypted »

Les événements sont **chiffrés côté client** avant écriture dans le stockage.

**Raisonnement.** **Défense en profondeur** : le contenu reste protégé même si le
support sort du périmètre maîtrisé.

**Bénéfices.** Confidentialité conservée en cas de fuite du support ; réduction de
la surface de confiance placée dans le fournisseur de synchronisation.

**Limites / coût.** Il faut **assumer la gestion des clés** : dérivation,
**rotation** (par epoch, cf. le kind `key` et `keys/epoch-XXXX/`), distribution
aux membres, et surtout **récupération**. Le risque majeur est la **perte de
données si une clé est perdue** — un chiffrement sans procédure de recovery
éprouvée transforme une clé égarée en données irrécupérables. C'est précisément
ce que le gate de sécurité (§1) doit examiner avant tout engagement.

---

## 4. Tableau coût / bénéfice

| Critère | Trusted | Encrypted |
|---|---|---|
| Confidentialité si le support fuit | Faible (lisible en clair) | Forte (contenu chiffré) |
| Complexité de gestion de clés | Nulle | Élevée (dérivation, rotation, distribution, recovery) |
| Risque de perte de données par perte de clé | Nul | Réel, à couvrir par une procédure de recovery |
| Inspection / sauvegarde / débogage | Directs | Indirects (déchiffrement requis) |
| Valeur ajoutée si SI déjà chiffré au repos | Faible | Marginale à significative selon le modèle de menace |
| Maturité dans Pilotéo aujourd'hui | Immédiate | Expérimentale (gate sécurité non franchi) |

---

## 5. Recommandation de démarche (non de décision)

Ce document **ne tranche pas**. Il recommande une **démarche** :

1. **Évaluer par mode.** Le mode `local` (IndexedDB, mono-poste) et le mode
   `hosted` (backend maîtrisé) posent la question différemment du mode Dossier,
   où le support quitte le plus facilement le périmètre.
2. **Évaluer par contexte client.** Modèle de menace, exigences réglementaires,
   maturité du SI (chiffrement au repos déjà en place ?), tolérance à la perte de
   données, capacité à opérer une gestion de clés. Un même produit peut être
   « Trusted » chez un client et « Encrypted » chez un autre.
3. **Conditionner « Encrypted » au franchissement du gate sécurité** (§1) : pas
   d'engagement de confidentialité, ni d'activation par défaut, avant la revue
   humaine dédiée couvrant notamment la **recovery**.
4. **Ne rien figer dans cette passe** : documenter le choix ouvert, ne pas
   augmenter la complexité crypto, ne pas retirer l'existant.

Aucune promesse commerciale de chiffrement n'est faite ici.
