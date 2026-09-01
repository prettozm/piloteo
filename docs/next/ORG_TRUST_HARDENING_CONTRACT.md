# Contrat — Durcissement de la chaîne de confiance (anti-usurpation d'invitation)

> Corrige une faille SÉRIEUSE trouvée par le contrariant : dans le modèle
> « dossier de confiance » (fiches membres SIGNÉES mais PUBLIQUES, non chiffrées),
> une invitation consommée est lisible par quiconque a accès au dossier. Comme
> `memberId` est un UUID aléatoire NON lié à la clé, et comme l'ordre d'admission
> dépendait d'un champ non signé (`createdTime` Drive), un tiers peut **rejouer**
> l'invitation avec SA clé sous le `memberId` d'un membre légitime et se faire
> admettre `admin` à sa place (usurpation + DoS ciblé). Le owner reste protégé
> (épinglé dans le manifeste genesis write-once) ; **tout membre invité est exposé.**
> Repro : `attack-driveorg2-escalation.mjs`. Mode-agnostique (dossier ET Drive),
> mais Drive l'amplifie (collision de nom + tri `createdTime`).

`app.js`/`server.py` intacts. Cœur du correctif : `src/workspace/org-runtime.js#buildTrustedMembership`.

## 1. Principe : admission DÉTERMINISTE, refus des conflits, jamais de métadonnée non signée

`buildTrustedMembership` (et tout ce qui décide d'admettre une fiche) NE DOIT
JAMAIS trancher une décision de SÉCURITÉ sur un champ non signé / contrôlable par
un écrivain du dossier (notamment `createdTime`, l'ordre de listing, l'ordre des
fichiers). Règles d'admission :

1. **Owner genesis** : toujours admis avec le rôle `owner` **depuis le manifeste
   write-once** ; aucune fiche membre candidate ne peut le redéfinir (déjà le cas —
   conserver et vérifier).
2. **`memberId` contesté ⇒ personne** : si ≥ 2 fiches membres candidates portent le
   MÊME `memberId` avec des `publicKeyJwk` DIFFÉRENTES, n'en admettre AUCUNE
   (sauf l'owner genesis résolu par le manifeste). Les deux vont dans `rejected`
   avec une raison explicite (`memberId contesté (clés divergentes)`), JAMAIS un
   « premier par createdTime gagne ». → l'attaquant ne peut pas prendre le slot
   d'un membre ; au pire il le bloque (DoS détecté et récupérable).
3. **Invitation à usage unique, non rejouable** : un `invitationId` ne peut être
   consommé que par UNE seule identité `(memberId, publicKeyJwk)`. Si le MÊME
   `invitationId` est revendiqué par des fiches d'identités DIFFÉRENTES, n'admettre
   AUCUNE de ces fiches contestées (`rejected`: `invitation rejouée (consommée par
   des identités divergentes)`). Jamais d'arbitrage par `createdTime`.
4. **Détermination stable** : quand un départage NON sécuritaire est nécessaire
   (ex. deux fiches STRICTEMENT identiques — même memberId, même clé, même contenu
   canonique — simple doublon inerte), dédupliquer par contenu canonique signé,
   pas par métadonnée. Un vrai doublon idempotent (même clé, même payload) n'est
   PAS un conflit → admettre une fois.
5. **Observabilité** : toute fiche rejetée pour conflit apparaît dans `rejected`
   avec sa raison ; jamais de disparition silencieuse (déjà exigé pour le DoS r1).

## 2. Révocations (même traitement)
Appliquer la même règle aux fiches de révocation : une révocation dont l'émetteur
ou la cible est contestée par des candidats divergents, ou dont l'`revocationId`
est revendiqué par des contenus divergents, ne doit pas pouvoir (a) faire
disparaître une vraie révocation, ni (b) injecter une fausse révocation admise via
un ordre `createdTime`. Contesté ⇒ rejeté/observable, jamais « premier gagne ».

## 3. Ce que le correctif NE prétend PAS résoudre (à documenter honnêtement)
- Un écrivain hostile du dossier peut toujours **bloquer** (DoS) un membre invité
  en déposant une fiche contestante — c'est un **choix assumé** (DoS détectable et
  récupérable : le owner ré-invite avec une invitation fraîche, la fiche hostile
  est retirée via les permissions du dossier) PRÉFÉRABLE à une usurpation
  silencieuse. Le modèle « dossier de confiance » suppose de toute façon que les
  écrivains du dossier sont des membres de confiance (CLAUDE.md §4).
- Renforcement FUTUR possible (hors de ce lot, à documenter) : lier l'invitation à
  la clé/`memberId` du destinataire dès l'émission (flux d'invitation en deux temps :
  l'invité communique son `memberId`/clé, l'owner émet une invitation liée) —
  éliminerait même le DoS résiduel. Non requis ici.

## 4. Tests (obligatoires)
`tests/next/org-trust-hardening.test.mjs` (node:test) — mode-agnostique (sur
l'`InMemoryStorageAdapter`/FolderStorageAdapter ET via les candidats Drive) :
1. **Repro contrariant neutralisée** : owner invite Bob (admin), Bob accepte ; une
   fiche hostile réutilise le `memberId` de Bob avec une AUTRE clé → après
   `buildTrustedMembership`, `getPublicKey(bobId)` n'est JAMAIS la clé hostile ;
   le rôle `admin` n'est jamais attribué à la clé hostile. (Idéalement Bob reste
   admis ; au minimum le slot va en conflit — mais AUCUNE admission de l'attaquant.)
2. **Invitation rejouée** : une même invitation consommée par deux identités
   distinctes (memberId ≠) → aucune des deux contestées n'obtient le rôle par
   ordre `createdTime` ; conflit observable.
3. **Owner intouchable** : une fiche hostile réutilisant `ownerMemberId` → ignorée,
   l'owner reste owner (manifeste).
4. **Non-régression** : une invitation consommée UNE fois par UNE identité → membre
   admis normalement (le cas nominal ne casse pas). Doublon idempotent strict
   (même clé, même contenu) → admis une fois, pas un conflit.
5. **Révocation** : une fiche de révocation hostile divergente ne fait pas
   disparaître une vraie révocation ni n'en injecte une admise par createdTime.
La régression durable de tous ces scénarios (usurpation d'invitation, DoS memberId,
empoisonnement membership, usurpation `consultantId`, genèse forgée) vit dans
`tests/next/org-trust-hardening.test.mjs` (cas 1–14, « vert = sécurisé ») ; les
scripts de repro scratch à la racine ne sont pas versionnés (`.gitignore`).
`npm run test:next` reste vert,
non-régression Point 2 (org-runtime, org-revocation, org-engine, org-folder),
Point 4 (drive-*), onboarding Drive (drive-onboarding, org-onboarding-drive).

## 5. Contraintes
- `app.js`/`server.py` intacts. Cœur en `org-runtime.js#buildTrustedMembership`
  (et éventuellement le tri utilisé par les candidats, pour ne pas fonder une
  décision de sécurité sur `createdTime`). Ne pas changer le format d'identité
  (`memberId` reste un UUID — la sécurité vient de l'admission déterministe, pas
  d'un changement d'identité qui casserait l'existant).
- Réutiliser la vérification de signature/chaîne existante ; n'ajouter QUE la
  logique de détection de conflit + refus déterministe + observabilité.
