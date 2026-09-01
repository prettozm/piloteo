# Contrat — Point 2c-A : révocation signée + durcissement issuerId

> Étend la chaîne de confiance des organisations (docs/next/ORG_CONTRACT.md) avec
> une **révocation vérifiable cryptographiquement**, et durcit le binding de
> l'émetteur d'invitation. Lot MOTEUR, testable en node, sans UI ni dossier.

## 1. Fiche de révocation signée

Nouveau type de fiche publiable (kind `"revocation"`) :
```
{ kind:"revocation", workspaceId, revokedMemberId, revokedAt, issuerId, proof }
```
- `proof = sign(issuerPrivateKeyRef, revocationCanonicalBytes({workspaceId, revokedMemberId, revokedAt, issuerId}))`.
- `revocationCanonicalPayload` = sérialisation déterministe `[workspaceId, revokedMemberId, revokedAt, issuerId]` (même style que `invitations.canonicalPayload`).

`export async function createRevocation({ workspaceId, revokedMemberId, issuer, issuerMembership, revokedRole, signer, now })`
- EXIGE `signer` réel + autorité : `issuerMembership.role` doit avoir un rang
  SUFFISANT sur `revokedRole` — owner peut révoquer owner/admin/user ; admin peut
  révoquer un `user` seulement ; un `user` ne révoque personne. Sinon throw.
- Retourne la fiche de révocation ci-dessus (issuerId = memberId de l'émetteur).

`export async function verifyRevocation(revocation, { registry })`
- Vérifie `crypto.verify(clé de issuerId via registry, revocationCanonicalBytes, proof)`,
  que l'émetteur est de confiance ET a le rang suffisant pour révoquer ce membre.
- Rejet explicite sinon (émetteur inconnu/non autorisé, proof invalide).

## 2bis. CORRECTIF SÉCURITÉ (re-revue) — l'autorité d'un révoqué tombe à ZÉRO

La re-revue a démontré deux failles critiques dans l'approche « horodatée » du §2 :
un membre révoqué contrôle et signe lui-même `createdAt`/`revokedAt`, donc la
fenêtre « avant révocation » est **forgeable par la personne qu'elle contraint**
(backdating d'invitation), et un membre révoqué pouvait encore émettre de
**nouvelles révocations** (contrôle de statut lu sur le registre pré-révocation
= code mort). Dans un dossier SANS horloge de confiance, aucune comparaison de
timestamp auto-déclaré n'est saine.

**Règle qui REMPLACE toute logique de timestamp du §2 :**
- Un membre révoqué a une autorité **NULLE** dès l'instant de sa révocation :
  AUCUNE fiche (invitation OU révocation) dont il est l'émetteur n'est admise —
  quelle que soit la date qu'il déclare. On NE compare JAMAIS `createdAt` à
  `revokedAt`.
- Conséquence assumée (à surfacer dans l'UI 2c-C) : révoquer un admin invalide
  aussi les membres que cet admin avait invités (ils perdent leur ancre de
  confiance). Pour les conserver, un owner/admin encore valide doit les
  **ré-inviter** (ré-ancrage). C'est le prix d'un modèle sûr sans horloge fiable.
- La distribution/synchro effective des fiches de révocation reste une garantie
  du lot 2c (comme le manifeste) : org-runtime ne peut agir que sur les fiches
  qu'on lui fournit.

## 2. `buildTrustedMembership` étendu (révocation) — algorithme (RÉVISÉ §2bis)

Signature : `buildTrustedMembership({ manifest, memberRecords, revocations = [] })`
-> `{ registry, membershipStore, trusted, revoked:[{memberId, revokedAt, revokedBy}], rejected }`.

1. **Passe 1 — arbre de confiance des fiches** (BFS existant, INCHANGÉ) : établit
   les clés publiques, rôles et lignée (issuerId + createdAt de l'invitation) de
   chaque membre admis, SANS tenir compte des révocations. Produit un registre
   candidat.
2. **Passe 2 — collecte des révocations valides** : pour chaque fiche de
   révocation, `verifyRevocation` avec le registre candidat de la passe 1
   (émetteur de confiance + rang suffisant + proof valide). Retenir
   `{revokedMemberId -> {revokedAt, revokedBy}}`. Une révocation invalide va dans
   `rejected`.
3. **Passe 3 — re-filtrage** (point fixe) : reconstruire l'ensemble de confiance
   FINAL en n'admettant une fiche que si, sur TOUTE sa lignée jusqu'à la genèse,
   CHAQUE émetteur intermédiaire n'était PAS révoqué au moment où il a émis le
   maillon (`invitation.createdAt < issuer.revokedAt` si l'émetteur est révoqué ;
   un émetteur non révoqué reste valide). Un membre dont un maillon casse est
   retiré de l'ensemble de confiance (cascade). Le membre révoqué lui-même reste
   présent dans le `membershipStore` mais avec `status:"revoked"` (pour que
   `SyncEngine` bloque ses événements) et ne peut plus servir d'émetteur valide.

Invariants :
- Un `owner` révoqué ne peut pas être « re-légitimé » par une fiche publiée
  (genèse immuable = racine ; une révocation de l'owner de genèse, si signée par
  lui-même, est un cas limite : un owner peut révoquer un autre owner mais la
  révocation de l'owner racine par un tiers non-owner est refusée).
- La révocation est **monotone** : une fois un `revokedAt` établi, republier une
  fiche membre pour ce memberId (déjà connu) ne le ré-admet pas (anti-redéfinition
  existant + statut révoqué).

## 3. Durcissement issuerId (recommandation red team)

- `invitations.js#canonicalPayload` inclut désormais `issuerId` (nouveau champ
  optionnel, en fin de tableau pour rétro-compat) ; `createInvitation` accepte
  `issuerId` et le met dans les octets signés. `org-runtime#inviteMember` le
  fournit. `verifyInvitation` recompose avec `invitation.issuerId`. Ainsi le
  binding émetteur↔proof est STRUCTUREL (dans les octets signés), plus seulement
  une conséquence de l'implémentation de `verifyInvitation`.
- NE PAS casser les tests d'invitation existants : quand `issuerId` est absent
  (ancien flux / défaut), `canonicalPayload` se comporte comme avant (ne pas
  ajouter un `undefined` qui changerait les octets — n'ajouter l'élément que s'il
  est fourni, ou documenter clairement le changement de format et adapter les tests).

## 4. Tests exigés (`tests/next/org-revocation.test.mjs` + compléments)
- createRevocation : owner révoque admin OK ; admin révoque user OK ; admin
  révoque owner => throw ; user révoque quiconque => throw.
- verifyRevocation : proof valide d'un émetteur autorisé accepté ; proof bidon /
  émetteur non autorisé / inconnu => rejet.
- buildTrustedMembership + révocation :
  - un admin révoqué => `status:"revoked"` dans le store ; un `SyncEngine` trusted
    alimenté par ce store rejette ses nouveaux événements (`stage:"membership"`).
  - une invitation émise par cet admin APRÈS sa révocation => l'invité n'est PAS
    admis (chaîne cassée) ; une invitation émise AVANT la révocation => l'invité
    reste admis.
  - cascade : admin A (révoqué) a invité B (admin) après sa révocation, B a invité
    C ; ni B ni C ne sont admis.
  - une fiche de révocation forgée (non signée par une autorité) => `rejected`,
    aucun effet.
  - non-régression : sans révocation, comportement identique au lot précédent.
- issuerId : une invitation dont on modifie `issuerId` après signature => rejet
  (le proof ne couvre plus l'issuerId annoncé).

## 5. Contraintes
- Réutiliser crypto-service, memberships, invitations ; ne pas réécrire.
- `npm run test:next` vert (aucune régression). app.js/server.py intacts. Mode
  chiffré SyncEngine inchangé.
