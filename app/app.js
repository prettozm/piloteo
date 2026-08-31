(function(){
  "use strict";

  // Échappement HTML — appliqué à TOUTE donnée métier interpolée dans un innerHTML ou un attribut
  // (commentaires, noms, libellés, adresses, mots-clés saisis par les utilisateurs). Indispensable :
  // le contenu remonte du serveur tel qu'il a été saisi, sans assainissement, et est réinjecté ici en
  // HTML brut — sans cet échappement, un commentaire malveillant devient du code exécuté (XSS stocké).
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

  // Filet global : toute exception non interceptée dans un gestionnaire d'événement (ex. une donnée
  // devenue incohérente après un changement de périmètre) laisserait sinon l'interface muette. On
  // signale l'incident à l'utilisateur plutôt que de laisser un bouton « sans effet ».
  window.addEventListener("error", e => { console.error(e.error || e.message); try{ toast("Une erreur est survenue — rechargez la page si l'affichage est incohérent."); }catch(_){} });
  window.addEventListener("unhandledrejection", e => { console.error(e.reason); });

  /* ================= Données ================= */
  const MOIS = ["Janv","Févr","Mars","Avr","Mai","Juin","Juil","Août","Sept","Oct","Nov","Déc"];
  const today = new Date();
  const CURRENT_YEAR = today.getFullYear();

  // Exemples de cas gérés par le jeu de données : un consultant passe à 80% en
  // cours d'année (temps partiel par période) ; un autre arrive en cours d'année
  // (prorata d'ETP à l'arrivée) ; un stagiaire (statut à part, ~25% de présence) ;
  // un consultant parti sur une année passée (présence entièrement contenue dans
  // une année révolue, panorama Société différent d'une année à l'autre).
  // trigramme : 2 premières lettres du prénom + 1ʳᵉ lettre du nom (ex. « Prénom
  // Nom » → PRN), calculé une fois à la création du consultant puis figé (comme
  // id) — sert de base aux numéros de notes de frais (voir bordereauxFrais plus bas).
  let consultants = [];
  let nextConsultantIdSuffix = 1;

  let organisations = [];
  let nextOrgId = 9;

  let affaires = [];
  let nextAffaireId = 19;

  // --- Listes de référence éditables (Tables & réglages) — cochées sur chaque affaire depuis
  // le module de saisie. Un identifiant stable (pas seulement le libellé) est conservé sur
  // l'affaire, pour qu'un renommage ultérieur dans Tables & réglages n'invalide pas les affaires
  // déjà caractérisées ; une suppression laisse simplement l'affaire sans cette caractéristique.
  let methodes = [];
  let nextMethodeId = 13;

  let typesTerritoire = [];
  let nextTerritoireId = 7;

  let domainesIntervention = [];
  let nextDomaineId = 5;

  // Catégories / sous-catégories de frais (liste fournie par l'utilisateur — fichier frais.xlsx).
  // Chaque sous-catégorie porte sa catégorie parente ; le formulaire de saisie regroupe les
  // sous-catégories par catégorie (<optgroup>).
  let categoriesFrais = [];
  let nextCategorieFraisId = 22;
  // Taux de TVA en vigueur en France.
  const TAUX_TVA = [
    { taux:20,   label:"20 % (taux normal)" },
    { taux:10,   label:"10 % (taux intermédiaire)" },
    { taux:5.5,  label:"5,5 % (taux réduit)" },
    { taux:2.1,  label:"2,1 % (taux particulier)" },
    { taux:0,    label:"0 % (exonéré / non applicable)" },
  ];

  // NB : l'exemple de dépassement d'enveloppe (bascule auto en non facturable) est porté par
  // M8 (Enquête usagers, ATD) — voir les saisies plus bas.
  let missions = [];
  let nextMissionId = 12;

  // --- Facturation ---------------------------------------------------------
  // Une affaire peut porter plusieurs factures. Le numéro est saisi à la main (il provient du
  // logiciel de facturation du cabinet, hors Pilotéo), optionnel tant que la facture reste
  // "prévisionnelle". TVA à 20% par défaut, 0% si la case "formation" est cochée — les seuls deux
  // taux utilisés ici (contrairement au module Frais qui gère les 5 taux français).
  // Jeu de données couvrant toutes les situations utiles aux 4 alertes (voir facturesAlertes()) :
  //  - A1 (en production, budget 42000€) : F1 prévisionnelle en retard de dépôt, F2 facturée non
  //    payée en retard de paiement, F3 payée (cycle complet), F4 annulée (et exemple "formation").
  //    Somme des factures non annulées ≠ budget de l'affaire → écart de facturation.
  //  - A2 (en production, budget 24000€, sous-traitance 3500€) : F5/F6, échéancier cohérent avec
  //    le budget vendu (aucune alerte).
  //  - A10 (en production, budget 35000€) : F7 payée, F8 prévisionnelle à échéance future (numéro
  //    pas encore renseigné) — échéancier cohérent, aucune alerte.
  //  - A4 (terminée) : aucune facture — déclenche l'alerte "facturation non planifiée".
  let factures = [];
  let nextFactureId = 9;

  const tempsInternes = [
    { code:"AO",   label:"Commercial AO, AAP" },
    { code:"PRO",  label:"Commercial Pro actif, direct" },
    { code:"FORM", label:"Formation" },
    { code:"ADM",  label:"Administratif / Gestion" },
    { code:"REU",  label:"Réunions Internes" },
    { code:"PART", label:"Partenariats" },
    { code:"OUT",  label:"Outillages" },
    { code:"VEI",  label:"Veille, Méthodologies" },
    { code:"RD",   label:"R&D" },
  ];
  const tempsAbsences = [
    { code:"MAL", label:"Maladies, Maternité" },
    { code:"CONG", label:"Congés" },
  ];

  function d(days){ const dt=new Date(today); dt.setDate(dt.getDate()-days); return dt.toISOString().slice(0,10); }
  function dm(mois, jour){ return `${CURRENT_YEAR}-${String(mois).padStart(2,"0")}-${String(jour).padStart(2,"0")}`; }
  function dm1(mois, jour){ return `${CURRENT_YEAR-1}-${String(mois).padStart(2,"0")}-${String(jour).padStart(2,"0")}`; }

  // Saisies — historique étoffé sur l'année en cours (Janvier à Août) pour illustrer les tableaux,
  // jauges et graphiques avec un volume réaliste. M1 garde volontairement son dépassement (voir plus haut) ;
  // les autres missions restent sous leur enveloppe.
  let saisies = [];
  let nextSaisieId = 1;

  // Bordereaux de frais — regroupent les frais d'un consultant en vue de leur remboursement.
  // Numéro FRAIS_<trigramme>_<année>_<n° séquentiel sur 3 chiffres, par consultant et par année>.
  // Cycle de vie : « en saisie » (tant que le consultant y ajoute des frais) → « note à payer »
  // (dès qu'il demande le paiement) → « payée » (une fois le remboursement effectué, avec date).
  // Un seul bordereau « en saisie » par consultant et par année à la fois (voir getOrCreateOpenBordereau) ;
  // une fois fermé (demande de paiement), tout nouveau frais saisi ouvre le bordereau suivant.
  let bordereauxFrais = [];

  // Frais saisis par les consultants, rattachés à une affaire, une sous-catégorie (voir
  // categoriesFrais plus haut) et un bordereau (numeroBordereau, voir bordereauxFrais ci-dessus).
  // Chaque frais porte un détail lignesTVA (un ou plusieurs { tauxTVA, montantHT, montantTVA } —
  // une note de restaurant, par exemple, peut cumuler un taux sur le repas et un autre sur les
  // boissons alcoolisées) ; montantHT, montantTVA et montantTTC sont la somme de ces lignes
  // (aggregateLignesTVA). refacturable : si vrai, le montant TTC vient s'imputer sur l'enveloppe
  // « Frais Cabinet » de l'affaire (cohérence budgétaire) ; si faux, il reste hors budget affaire.
  // Le statut affiché d'un frais (saisi / à payer / remboursé) n'est pas stocké : il est dérivé du
  // statut de son bordereau (fraisStatut), pour ne jamais pouvoir se désynchroniser de la note.
  let notesFrais = [];
  let nextNoteFraisId = 1;

  let currentUser = null;
  // Identifiant du consultant "administrateur" réellement connecté pendant qu'on consulte la page
  // d'un autre consultant (bouton "Voir sa page", depuis Cabinet > Consultants) — null hors de ce mode.
  let adminViewingAs = null;

  /* ================= Aides ================= */
  const euro = n => n.toLocaleString("fr-FR",{maximumFractionDigits:0}) + " €";
  const euroCents = n => n.toLocaleString("fr-FR",{minimumFractionDigits:2,maximumFractionDigits:2}) + " €";
  const jr = n => n.toLocaleString("fr-FR",{maximumFractionDigits:1}) + " j";
  const euroCompact = n => n>=1000 ? `${(n/1000).toLocaleString("fr-FR",{maximumFractionDigits:0})}k €` : `${Math.round(n)} €`;
  const initials = id => id.slice(0,2);
  // Agrège les lignes HT/TVA d'un frais (une note peut cumuler plusieurs taux, ex. restaurant) en
  // montantHT / montantVA / montantTTC au niveau de la note — utilisé aussi bien pour le jeu de
  // données de démo que pour la sauvegarde d'un nouveau frais (saveFrais). Déclarée en `function`
  // (hoisted) pour rester utilisable dès l'initialisation de notesFrais, plus haut dans le fichier.
  function aggregateLignesTVA(lignes){
    const montantHT = +lignes.reduce((s,l)=>s+l.montantHT,0).toFixed(2);
    const montantTVA = +lignes.reduce((s,l)=>s+l.montantTVA,0).toFixed(2);
    return { montantHT, montantTVA, montantTTC: +(montantHT+montantTVA).toFixed(2) };
  }
  function tvaTauxListLabel(lignesTVA){
    return (lignesTVA||[]).map(l=>`${l.tauxTVA.toLocaleString("fr-FR")} %`).join(" + ");
  }
  function dateFR(iso){
    if(!iso) return "—";
    const [y,m,d] = iso.split("-");
    return `${d}/${m}/${y}`;
  }
  // Libellé du "type de temps" d'une saisie : nom de la mission, ou libellé de la catégorie interne/absence.
  function saisieTypeLabel(s){
    if(s.type==="mission"){
      const m = missions.find(mm=>mm.id===s.missionId);
      const a = m ? affaires.find(aa=>aa.id===m.affaireId) : null;
      return a ? a.nom : "—";
    }
    if(s.type==="interne") return tempsInternes.find(c=>c.code===s.categorie)?.label ?? s.categorie;
    return tempsAbsences.find(c=>c.code===s.categorie)?.label ?? s.categorie;
  }
  // Nom de la mission, affiché en complément du nom de l'affaire (uniquement pour les saisies de type mission).
  function saisieMissionName(s){
    if(s.type!=="mission") return "";
    return missions.find(m=>m.id===s.missionId)?.nom ?? "";
  }

  function orgName(id){ return organisations.find(o=>o.id===id)?.nom ?? "—"; }
  function consultantName(id){ return consultants.find(c=>c.id===id)?.nom ?? id; }
  function consultantStatutPill(s){
    const map = { "en poste":"good", "stagiaire":"warn", "parti":"neutral" };
    return `<span class="pill ${map[s]||"neutral"}">${s}</span>`;
  }
  const etpFmt = n => n.toLocaleString("fr-FR",{minimumFractionDigits:2,maximumFractionDigits:2}) + " ETP";

  /* ================= Effectifs & ETP ================= */
  // Un consultant compte dans l'effectif d'une année s'il a été présent au moins un jour sur cette
  // année (même logique de fenêtre de présence que le calcul d'ETP) — pas seulement s'il est encore
  // en poste aujourd'hui. Un consultant "parti" avant l'année, ou pas encore arrivé, ne compte pas.
  function consultantPresentSurAnnee(c, year){
    const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
    const presStart = c.dateEmbauche > yStart ? c.dateEmbauche : yStart;
    const presEnd = (c.dateDepart && c.dateDepart < yEnd) ? c.dateDepart : yEnd;
    return presStart <= presEnd;
  }

  // Jours calendaires entre deux dates ISO, bornes incluses.
  function joursEntre(debutISO, finISO){
    const d1 = new Date(debutISO+"T00:00:00");
    const d2 = new Date(finISO+"T00:00:00");
    return Math.max(0, Math.round((d2-d1)/86400000) + 1);
  }

  // ETP d'un consultant sur une année civile donnée :
  // ETP = (nombre de jours dans l'entreprise sur l'année, 365 pour une année complète) × % de temps / 365.
  // Le % de temps est géré par période (tempsPartiel), 100% par défaut hors période déclarée.
  // Les stagiaires sont un statut à part : compté forfaitairement à 25% de présence sur toute leur
  // période, quelle que soit leur quotité (valeur RH/production conventionnelle, pas une vraie quotité).
  function computeConsultantETP(c, year){
    const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
    const presStart = c.dateEmbauche > yStart ? c.dateEmbauche : yStart;
    const presEnd = (c.dateDepart && c.dateDepart < yEnd) ? c.dateDepart : yEnd;
    if(presStart > presEnd) return 0;
    const joursPresence = joursEntre(presStart, presEnd);

    if(c.statut === "stagiaire"){
      return +((joursPresence * 0.25) / 365).toFixed(3);
    }

    const periodes = (c.tempsPartiel||[]).slice().sort((a,b)=>a.debut.localeCompare(b.debut));
    let joursPonderes = 0, joursCouverts = 0;
    periodes.forEach(p=>{
      const pDebut = p.debut > presStart ? p.debut : presStart;
      const pFin = (p.fin && p.fin < presEnd) ? p.fin : presEnd;
      if(pDebut > pFin) return;
      const j = joursEntre(pDebut, pFin);
      joursCouverts += j;
      joursPonderes += j * (p.pct/100);
    });
    joursPonderes += (joursPresence - joursCouverts); // reste de la présence, à 100%
    return +(joursPonderes/365).toFixed(3);
  }

  /* ================= Tri et filtre génériques des tableaux ================= */
  // Chaque tableau appelle renderSortFilterTable(tableId, rows, columns, rowHTML, opts) au lieu
  // de construire son <thead>/<tbody> à la main. columns: [{key,label,get(row),numeric,sortable,filterable}]
  const tableUIState = {};
  function getTableUI(id){
    if(!tableUIState[id]) tableUIState[id] = { sortKey:null, sortDir:1, filters:{}, page:1, pageSize:10 };
    return tableUIState[id];
  }
  const TABLE_REG = {}; // tableId -> { rerender, rows, columns } — alimenté à chaque rendu

  // Nombre de lignes par page proposés dans le sélecteur — 10 par défaut, comme demandé, avec la
  // possibilité de voir plus (ou tout) sans avoir à re-cliquer 10 fois sur "Suivant".
  const TABLE_PAGE_SIZES = [10, 25, 50];

  function renderSortFilterTable(tableId, rows, columns, rowHTML, opts){
    opts = opts || {};
    const state = getTableUI(tableId);
    TABLE_REG[tableId] = { rerender: opts.rerender, rows, columns };
    const table = document.getElementById(tableId);
    const anyFilterActive = Object.values(state.filters).some(f=>f);
    if(rows.length===0 && !anyFilterActive){
      table.innerHTML = `<tbody><tr><td class="empty-note">${opts.emptyMsg||"Aucune donnée."}</td></tr></tbody>`;
      renderTablePagination(tableId, 0, state, columns.length);
      return;
    }
    let display = rows;
    columns.forEach(col=>{
      if(col.filterable){
        const f = state.filters[col.key];
        if(f) display = display.filter(r=>f.has(String(col.get(r))));
      }
    });
    if(state.sortKey){
      const col = columns.find(c=>c.key===state.sortKey);
      if(col){
        display = display.slice().sort((a,b)=>{
          let va = col.get(a), vb = col.get(b);
          if(typeof va === "string"){ va = va.toLowerCase(); vb = String(vb).toLowerCase(); }
          if(va<vb) return -1*state.sortDir;
          if(va>vb) return 1*state.sortDir;
          return 0;
        });
      }
    }
    const ths = columns.map(col=>{
      const cls = [];
      if(col.numeric) cls.push("num");
      if(col.sep) cls.push("col-sep-left");
      let attrs = "";
      let arrow = "";
      if(col.sortable!==false){
        cls.push("th-sortable");
        attrs = ` data-table="${tableId}" data-sort-key="${col.key}"`;
        if(state.sortKey===col.key) arrow = `<span class="sort-arrow">${state.sortDir===1?"▲":"▼"}</span>`;
      }
      const active = col.filterable && state.filters[col.key] ? " active" : "";
      const filterBtn = col.filterable
        ? `<button type="button" class="col-filter-btn${active}" data-table="${tableId}" data-key="${col.key}" title="Filtrer : ${col.label}"><svg width="9" height="9" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M0.5 1H9.5L6 5.2V9L4 8V5.2L0.5 1Z" fill="currentColor"/></svg></button>`
        : "";
      const widthAttr = col.width ? ` style="width:${col.width};"` : "";
      return `<th class="${cls.join(' ')}"${attrs}${widthAttr}>${col.label}${arrow}${filterBtn}</th>`;
    }).join("");

    // Pagination : la ligne de total (opts.tfoot) continue de porter sur tout "display" (toutes les
    // pages confondues) — seules les lignes du <tbody> sont limitées à la page courante.
    const totalRows = display.length;
    const pageSize = state.pageSize==="all" ? Math.max(totalRows,1) : state.pageSize;
    const totalPages = Math.max(1, Math.ceil(totalRows/pageSize));
    if(state.page>totalPages) state.page = totalPages;
    if(state.page<1) state.page = 1;
    const pageDisplay = state.pageSize==="all" ? display : display.slice((state.page-1)*pageSize, state.page*pageSize);

    const bodyRows = pageDisplay.length
      ? pageDisplay.map(rowHTML).join("")
      : `<tr><td colspan="${columns.length}" class="empty-note">Aucune ligne pour ce filtre.</td></tr>`;
    const tfoot = typeof opts.tfoot === "function" ? (display.length ? opts.tfoot(display) : "") : (opts.tfoot||"");
    table.innerHTML = `<thead><tr>${ths}${opts.extraHeadCols||""}</tr>${opts.extraHeadRow||""}</thead><tbody>${bodyRows}</tbody>${tfoot}`;
    if(opts.afterRender) opts.afterRender(table);
    renderTablePagination(tableId, totalRows, state, columns.length);
  }

  // Barre "Lignes par page" + navigation, affichée juste sous le tableau (élément persistant,
  // recréé une seule fois puis mis à jour à chaque rendu — jamais dupliqué). Masquée dès que le
  // tableau tient sur une seule page au plus petit format proposé (10 lignes) : pas de contrôle
  // inutile sur les petits tableaux (Consultants, Effectifs...).
  function renderTablePagination(tableId, totalRows, state, colCount){
    const table = document.getElementById(tableId);
    if(!table) return;
    const pagId = tableId+"-pagination";
    let el = document.getElementById(pagId);
    if(totalRows<=TABLE_PAGE_SIZES[0]){
      if(el) el.remove();
      return;
    }
    if(!el){
      el = document.createElement("div");
      el.className = "table-pagination";
      el.id = pagId;
      table.insertAdjacentElement("afterend", el);
    }
    const pageSize = state.pageSize==="all" ? totalRows : state.pageSize;
    const totalPages = Math.max(1, Math.ceil(totalRows/pageSize));
    const startIdx = totalRows ? (state.page-1)*pageSize+1 : 0;
    const endIdx = Math.min(totalRows, state.page*pageSize);
    const sizeOptions = TABLE_PAGE_SIZES.map(n=>`<option value="${n}" ${state.pageSize===n?"selected":""}>${n}</option>`).join("")
      + `<option value="all" ${state.pageSize==="all"?"selected":""}>Tout</option>`;
    el.innerHTML = `
      <div class="tp-size">
        <label for="${pagId}-select">Lignes par page</label>
        <select id="${pagId}-select" class="tp-pagesize" data-table="${tableId}">${sizeOptions}</select>
      </div>
      <div class="tp-nav">
        <span class="tp-info">${startIdx}–${endIdx} sur ${totalRows}</span>
        <button type="button" class="tp-btn" data-table="${tableId}" data-page-action="prev" ${state.page<=1?"disabled":""} aria-label="Page précédente">‹</button>
        <span class="tp-page">Page ${state.page} / ${totalPages}</span>
        <button type="button" class="tp-btn" data-table="${tableId}" data-page-action="next" ${state.page>=totalPages?"disabled":""} aria-label="Page suivante">›</button>
      </div>`;
  }
  document.addEventListener("click", (e)=>{
    const btn = e.target.closest(".tp-btn");
    if(!btn || btn.disabled) return;
    const tableId = btn.dataset.table;
    const state = getTableUI(tableId);
    state.page = (state.page||1) + (btn.dataset.pageAction==="next" ? 1 : -1);
    const reg = TABLE_REG[tableId];
    if(reg) reg.rerender();
  });
  document.addEventListener("change", (e)=>{
    const sel = e.target.closest(".tp-pagesize");
    if(!sel) return;
    const tableId = sel.dataset.table;
    const state = getTableUI(tableId);
    state.pageSize = sel.value==="all" ? "all" : parseInt(sel.value,10);
    state.page = 1;
    const reg = TABLE_REG[tableId];
    if(reg) reg.rerender();
  });

  function closeColumnFilterPopover(){
    const el = document.getElementById("col-filter-popover");
    if(el) el.remove();
  }
  function openColumnFilterPopover(btn){
    closeColumnFilterPopover();
    const tableId = btn.dataset.table, key = btn.dataset.key;
    const reg = TABLE_REG[tableId];
    if(!reg) return;
    const col = reg.columns.find(c=>c.key===key);
    const state = getTableUI(tableId);
    const values = Array.from(new Set(reg.rows.map(r=>String(col.get(r))))).sort((a,b)=>a.localeCompare(b,"fr"));
    const active = state.filters[key]; // Set actif, ou undefined/null = pas de filtre (tout coché)
    const pop = document.createElement("div");
    pop.className = "col-filter-popover";
    pop.id = "col-filter-popover";
    pop.innerHTML = `
      <div class="cfp-actions">
        <button type="button" data-act="all">Tout cocher</button>
        <button type="button" data-act="none">Tout décocher</button>
      </div>
      <div class="cfp-list">
        ${values.map(v=>`<label><input type="checkbox" value="${esc(v)}" ${(!active || active.has(v)) ? "checked":""}> ${esc(v)||"—"}</label>`).join("")}
      </div>`;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.top = (window.scrollY + r.bottom + 4) + "px";
    pop.style.left = (window.scrollX + Math.min(r.left, window.innerWidth-260)) + "px";

    const applyFromCheckboxes = ()=>{
      const all = Array.from(pop.querySelectorAll('input[type="checkbox"]'));
      const checked = all.filter(c=>c.checked).map(c=>c.value);
      state.filters[key] = checked.length===all.length ? null : new Set(checked);
      state.page = 1;
      reg.rerender();
    };
    pop.querySelectorAll('input[type="checkbox"]').forEach(cb=>cb.addEventListener("change", applyFromCheckboxes));
    pop.querySelector('[data-act="all"]').addEventListener("click", ()=>{
      pop.querySelectorAll('input[type="checkbox"]').forEach(cb=>cb.checked=true);
      state.filters[key] = null;
      state.page = 1;
      reg.rerender();
    });
    pop.querySelector('[data-act="none"]').addEventListener("click", ()=>{
      pop.querySelectorAll('input[type="checkbox"]').forEach(cb=>cb.checked=false);
      state.filters[key] = new Set();
      state.page = 1;
      reg.rerender();
    });
  }
  document.addEventListener("click", (e)=>{
    const filterBtn = e.target.closest(".col-filter-btn");
    if(filterBtn){ e.stopPropagation(); openColumnFilterPopover(filterBtn); return; }
    if(e.target.closest(".col-filter-popover")) return;
    closeColumnFilterPopover();
    const th = e.target.closest("th[data-sort-key]");
    if(th){
      const tableId = th.dataset.table, key = th.dataset.sortKey;
      const state = getTableUI(tableId);
      if(state.sortKey===key) state.sortDir *= -1; else { state.sortKey = key; state.sortDir = 1; }
      state.page = 1;
      const reg = TABLE_REG[tableId];
      if(reg) reg.rerender();
    }
  });

  // Saisie manuelle d'une case de projection mensuelle (mission.projectionManuelle["YYYY-MM"]).
  // Vider le champ revient au calcul automatique pour ce mois. La ligne (et donc la table entière,
  // pour que le reste-à-faire non fixé se reventile bien) est re-rendue après chaque modification.
  document.addEventListener("change", (e)=>{
    const input = e.target.closest(".proj-input");
    if(!input) return;
    const m = missions.find(mm=>mm.id===input.dataset.mission);
    if(!m) return;
    if(!m.projectionManuelle) m.projectionManuelle = {};
    const raw = input.value.trim();
    if(raw===""){
      delete m.projectionManuelle[input.dataset.mois];
    } else {
      m.projectionManuelle[input.dataset.mois] = Math.max(0, parseFloat(raw)||0);
    }
    const table = input.closest("table.data");
    if(table && table.id==="table-mes-missions") renderMesMissions();
    else if(table && table.id==="table-missions-affaire") renderAffaireDetail();
  });
  document.addEventListener("keydown", (e)=>{
    if(e.key==="Enter" && e.target.closest(".proj-input")) e.target.blur();
  });

  // Barre de progression des jours facturables consommés par rapport au volume vendu/à l'enveloppe.
  // Vert jusqu'à 100%, orange entre 100 et 120%, rouge au-delà (même seuil que le badge de dépassement mission).
  function joursBarHTML(consomme, total, opts){
    opts = opts || {};
    const pct = total>0 ? (consomme/total*100) : 0;
    const level = pct>120 ? "danger" : (pct>100 ? "warn" : "good");
    const widthPct = Math.min(100, pct);
    const mini = opts.mini ? " jbar-mini" : "";
    const label = opts.label || "Jours facturables";
    return `<div class="jbar-wrap${mini}">
      ${opts.mini ? "" : `<div class="jbar-label"><span>${label}</span><span class="jbar-nums">${jr(consomme)} / ${jr(total)} (${Math.round(pct)}%)</span></div>`}
      <div class="jbar-track" title="${label} : ${jr(consomme)} / ${jr(total)} (${Math.round(pct)}%)">
        <div class="jbar-fill ${level}" style="width:${widthPct}%;"></div>
      </div>
    </div>`;
  }

  // Jours facturables déjà consommés sur une mission (avant une nouvelle saisie)
  function joursFactConsommes(missionId){
    return saisies.filter(s=>s.type==="mission" && s.missionId===missionId)
      .reduce((sum,s)=>sum+s.jFact,0);
  }
  function joursTotalConsommes(missionId){
    return saisies.filter(s=>s.type==="mission" && s.missionId===missionId)
      .reduce((sum,s)=>sum+s.dureeJ,0);
  }
  function joursNonFactConsommes(missionId){
    return saisies.filter(s=>s.type==="mission" && s.missionId===missionId)
      .reduce((sum,s)=>sum+s.jNonFact,0);
  }

  function missionStatusBadge(mission){
    const totalJ = joursTotalConsommes(mission.id);
    const overrunPct = mission.enveloppe > 0 ? ((totalJ - mission.enveloppe)/mission.enveloppe)*100 : 0;
    if(overrunPct >= 20){
      const excedent = +(totalJ - mission.enveloppe).toFixed(1);
      return `<span class="badge-overrun">⚠ Enveloppe dépassée de ${excedent}j</span>`;
    }
    return "";
  }

  function toast(msg){
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._h);
    toast._h = setTimeout(()=>t.classList.remove("show"), 2600);
  }

  /* ================= Authentification & synchronisation V1 ================= */
  let appSessionUser = null;
  let appCsrfToken = null;
  let syncRevision = 0;
  let lastSyncedState = "";
  let syncTimer = null;
  let syncInFlight = false;
  let syncRetryTimer = null;
  let syncDirty = false;
  let applyingRemote = false;
  let syncPolling = null;

  function newEntityId(prefix){
    const rnd = (globalThis.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${rnd}`;
  }

  function collectState(){
    return {
      consultants, organisations, affaires, methodes, typesTerritoire,
      domainesIntervention, categoriesFrais, missions, factures, saisies,
      bordereauxFrais, notesFrais
    };
  }

  function maxSuffix(list, prefix){
    return list.reduce((m,x)=>{
      const id=String(x.id||"");
      const hit=id.match(new RegExp(`^${prefix}(\\d+)$`));
      return hit ? Math.max(m,+hit[1]) : m;
    },0);
  }
  function recomputeCounters(){
    nextOrgId = maxSuffix(organisations,"O") + 1;
    nextAffaireId = maxSuffix(affaires,"A") + 1;
    nextMethodeId = maxSuffix(methodes,"ME") + 1;
    nextTerritoireId = maxSuffix(typesTerritoire,"TE") + 1;
    nextDomaineId = maxSuffix(domainesIntervention,"DO") + 1;
    nextCategorieFraisId = maxSuffix(categoriesFrais,"CF") + 1;
    nextMissionId = maxSuffix(missions,"M") + 1;
    nextFactureId = maxSuffix(factures,"F") + 1;
  }

  function applyRemoteState(state, rerender=true, markSynced=true){
    if(!state) return;
    applyingRemote = true;
    consultants = state.consultants || [];
    organisations = state.organisations || [];
    affaires = state.affaires || [];
    methodes = state.methodes || [];
    typesTerritoire = state.typesTerritoire || [];
    domainesIntervention = state.domainesIntervention || [];
    categoriesFrais = state.categoriesFrais || [];
    missions = state.missions || [];
    factures = state.factures || [];
    saisies = state.saisies || [];
    bordereauxFrais = state.bordereauxFrais || [];
    notesFrais = state.notesFrais || [];
    recomputeCounters();
    if(markSynced){
      lastSyncedState = JSON.stringify(collectState());
      syncDirty = false;
      setSyncStatus("Synchronisé", "ok");
    }
    applyingRemote = false;
    if(rerender && currentUser) renderAll();
  }

  function setSyncStatus(label, kind="ok"){
    const el=document.getElementById("sync-status");
    if(!el) return;
    el.textContent=label;
    el.className = `sync-state ${kind==="ok"?"":kind}`;
  }

  async function api(path, options={}){
    const headers = {"Accept":"application/json", ...(options.headers||{})};
    if(options.body && typeof options.body !== "string"){
      headers["Content-Type"]="application/json";
      options.body=JSON.stringify(options.body);
    }
    if(appCsrfToken && options.method && !["GET","HEAD"].includes(options.method.toUpperCase())) headers["X-CSRF-Token"]=appCsrfToken;
    const res=await fetch(path,{credentials:"same-origin",...options,headers});
    let data={};
    try{ data=await res.json(); }catch(e){}
    if(!res.ok){ const err=new Error(data.error||`Erreur HTTP ${res.status}`); err.status=res.status; err.data=data; throw err; }
    return data;
  }

  function renderIdentify(error=""){
    document.getElementById("identify-screen").style.display="flex";
    document.getElementById("main-shell").hidden=true;
    const sub=document.querySelector("#identify-screen .id-sub");
    if(sub) sub.textContent="Accès professionnel sécurisé";
    const list=document.getElementById("id-list");
    list.innerHTML=`<form class="login-form" id="login-form">
      <div><label for="login-user">Identifiant</label><input id="login-user" name="username" autocomplete="username" required></div>
      <div><label for="login-password">Mot de passe</label><input id="login-password" name="password" type="password" autocomplete="current-password" required></div>
      <div class="login-error" id="login-error">${error||""}</div>
      <button class="btn primary" type="submit">Se connecter</button>
    </form>`;
    document.getElementById("login-form").addEventListener("submit", async e=>{
      e.preventDefault();
      const username=document.getElementById("login-user").value.trim();
      const password=document.getElementById("login-password").value;
      const err=document.getElementById("login-error");
      err.textContent="Connexion…";
      try{
        const data=await api("/api/login",{method:"POST",body:{username,password}});
        appSessionUser=data.user; appCsrfToken=data.user.csrf_token;
        await loadSessionState();
      }catch(ex){ err.textContent=ex.message||"Connexion impossible"; }
    });
  }

  function applyPermissions(){
    const admin=appSessionUser && appSessionUser.role==="admin";
    ["societe","affaires","commercial","facturation","organisations","consultants","frais","admin"].forEach(v=>{
      const b=document.querySelector(`.nav-item[data-view="${v}"]`); if(b) b.hidden=!admin;
    });
    const labels=document.querySelectorAll("nav .nav-label");
    if(labels[1]) labels[1].hidden=!admin;
    if(labels[2]) labels[2].hidden=!admin;
    const support=document.getElementById("support-admin-panel"); if(support) support.hidden=!admin;
    document.getElementById("switch-user").textContent="Se déconnecter";
  }

  async function loadSessionState(){
    const payload=await api("/api/state");
    syncRevision=payload.revision;
    applyRemoteState(payload.state,false);
    currentUser=appSessionUser.consultant_id;
    if(!consultants.some(c=>String(c.id)===String(currentUser))) throw new Error("Compte non rattaché à un consultant Pilotéo");
    applyPermissions();
    boot();
    startSyncEngine();
  }

  async function startApp(){
    try{
      const me=await api("/api/me");
      appSessionUser=me.user; appCsrfToken=me.user.csrf_token;
      await loadSessionState();
    }catch(ex){
      if(ex.status===401) renderIdentify(); else renderIdentify(ex.message||"Application indisponible");
    }
  }

  const SYNC_KEYS = {consultants:"id",organisations:"id",affaires:"id",methodes:"id",typesTerritoire:"id",domainesIntervention:"id",categoriesFrais:"id",missions:"id",factures:"id",saisies:"id",bordereauxFrais:"numero",notesFrais:"id"};
  function mergeLocalDelta(baseState, localState, remoteState){
    const out=JSON.parse(JSON.stringify(remoteState));
    Object.entries(SYNC_KEYS).forEach(([collection,key])=>{
      const base=new Map((baseState[collection]||[]).map(x=>[String(x[key]),x]));
      const local=new Map((localState[collection]||[]).map(x=>[String(x[key]),x]));
      const remote=new Map((out[collection]||[]).map(x=>[String(x[key]),x]));
      new Set([...base.keys(),...local.keys()]).forEach(id=>{
        const b=base.get(id), l=local.get(id);
        if(b===undefined && l!==undefined) remote.set(id,l);
        else if(b!==undefined && l===undefined) remote.delete(id);
        else if(JSON.stringify(b)!==JSON.stringify(l)) remote.set(id,l);
      });
      out[collection]=Array.from(remote.values());
    });
    return out;
  }

  // Bannière persistante (non un toast fugace) pour les incidents de synchronisation qui exigent une
  // action ou une relecture de l'utilisateur — conflit de version, modification refusée, session
  // expirée. Créée à la volée et réutilisée ; reste affichée jusqu'à fermeture explicite.
  let syncBannerEl = null;
  function showSyncBanner(message, kind="error"){
    if(!syncBannerEl){
      syncBannerEl = document.createElement("div");
      syncBannerEl.id = "sync-banner";
      syncBannerEl.setAttribute("role", "alert");
      syncBannerEl.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:20px;z-index:9999;max-width:min(680px,92vw);display:flex;gap:12px;align-items:flex-start;padding:13px 16px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);font-size:.9rem;line-height:1.35;";
      const txt = document.createElement("span");
      txt.id = "sync-banner-text";
      txt.style.cssText = "flex:1;";
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "✕";
      close.setAttribute("aria-label", "Fermer");
      close.style.cssText = "background:none;border:none;cursor:pointer;font-size:1rem;line-height:1;color:inherit;padding:0 2px;";
      close.addEventListener("click", hideSyncBanner);
      syncBannerEl.appendChild(txt);
      syncBannerEl.appendChild(close);
      document.body.appendChild(syncBannerEl);
    }
    syncBannerEl.style.background = kind==="warn" ? "#8a6d1f" : "#8f2f1a";
    syncBannerEl.style.color = "#fff";
    document.getElementById("sync-banner-text").textContent = message;
    syncBannerEl.hidden = false;
  }
  function hideSyncBanner(){ if(syncBannerEl) syncBannerEl.hidden = true; }

  // Session expirée / non authentifiée pendant l'utilisation : on arrête proprement le moteur de
  // synchro (timers + polling) et on ramène à l'écran de connexion en avertissant explicitement que
  // les dernières modifications ne sont pas encore enregistrées — plutôt que de recharger la page en
  // silence (ce qui masquerait la perte) ou de boucler indéfiniment sur des PUT voués à échouer.
  function handleSessionExpired(){
    clearTimeout(syncTimer);
    clearTimeout(syncRetryTimer);
    if(syncPolling){ clearInterval(syncPolling); syncPolling = null; }
    appSessionUser = null;
    setSyncStatus("Session expirée", "error");
    renderIdentify("Votre session a expiré. Reconnectez-vous — vos dernières modifications ne sont pas encore enregistrées.");
  }

  function scheduleSync(delay=450){
    if(!appSessionUser || applyingRemote) return;
    // Ne PAS sérialiser l'état complet ici (fonction appelée à chaque clic/frappe) : on marque
    // simplement « à synchroniser » et on planifie. C'est syncNow(), débouncé, qui sérialise une
    // seule fois et détermine s'il y a réellement quelque chose à envoyer.
    if(!syncDirty){ syncDirty=true; setSyncStatus("À synchroniser","pending"); }
    clearTimeout(syncTimer);
    syncTimer=setTimeout(syncNow,delay);
  }

  async function syncNow(){
    if(!appSessionUser || applyingRemote) return;
    const state=collectState();
    const raw=JSON.stringify(state);
    const sentState=JSON.parse(raw);
    if(raw===lastSyncedState){ syncDirty=false; setSyncStatus("Synchronisé","ok"); return; }
    syncDirty=true;
    if(syncInFlight){ scheduleSync(700); return; }
    syncInFlight=true; setSyncStatus("Synchronisation…","pending");
    try{
      const data=await api("/api/state",{method:"PUT",body:{base_revision:syncRevision,state}});
      syncRevision=data.revision;
      const localAfter=collectState();
      const localAfterRaw=JSON.stringify(localAfter);
      if(localAfterRaw===raw){
        applyRemoteState(data.state,false,true);
      }else{
        const merged=mergeLocalDelta(sentState,JSON.parse(localAfterRaw),data.state);
        applyRemoteState(merged,false,false);
        lastSyncedState=JSON.stringify(data.state);
        syncDirty=true;
        setSyncStatus("À synchroniser","pending");
        scheduleSync(80);
      }
      if(currentUser) renderAll();
      clearTimeout(syncRetryTimer);
    }catch(ex){
      if(ex.status===401){
        handleSessionExpired();
      }else if(ex.status===409 && ex.data && ex.data.state){
        syncRevision=ex.data.revision;
        applyRemoteState(ex.data.state,false);
        if(currentUser) renderAll();
        setSyncStatus("Conflit rechargé","error");
        const quoi = (ex.data.conflicts && ex.data.conflicts.length)
          ? ` (élément${ex.data.conflicts.length>1?"s":""} concerné${ex.data.conflicts.length>1?"s":""} : ${ex.data.conflicts.join(", ")})`
          : "";
        showSyncBanner(`Une donnée a aussi été modifiée ailleurs${quoi}. La version du serveur a été rechargée — vérifiez, puis ressaisissez votre modification si nécessaire.`, "warn");
      }else if(ex.status===403){
        setSyncStatus("Modification refusée","error");
        showSyncBanner(ex.message||"Modification non autorisée. La version du serveur a été rechargée — votre changement n'a pas été enregistré.", "error");
        try{ const latest=await api("/api/state"); syncRevision=latest.revision; applyRemoteState(latest.state,true); }catch(_e){}
      }else{
        syncDirty=true; setSyncStatus("Non synchronisé","error");
        clearTimeout(syncRetryTimer); syncRetryTimer=setTimeout(syncNow,5000);
      }
    }finally{ syncInFlight=false; }
  }

  async function pollRemote(){
    if(!appSessionUser || syncDirty || syncInFlight) return;
    try{
      const data=await api(`/api/state?if_revision=${syncRevision}`);
      if(data.changed){ syncRevision=data.revision; applyRemoteState(data.state,true); }
    }catch(ex){ if(ex.status===401) handleSessionExpired(); }
  }

  function startSyncEngine(){
    if(syncPolling) clearInterval(syncPolling);
    syncPolling=setInterval(pollRemote,10000);
    document.addEventListener("click", ()=>scheduleSync(250), true);
    document.addEventListener("change", ()=>scheduleSync(300), true);
    document.addEventListener("input", ()=>scheduleSync(650), true);
    window.addEventListener("beforeunload", e=>{
      const raw=JSON.stringify(collectState());
      if(raw!==lastSyncedState){ e.preventDefault(); e.returnValue=""; }
    });
  }

  /* ================= Rendu Ma page ================= */
  const STATUTS_AFFAIRE = ["en commercialisation","en production","terminée","perdue"];
  let filtreStatuts = new Set(["en commercialisation","en production"]);

  function renderFiltreStatuts(){
    const wrap = document.getElementById("filtre-statut-affaires");
    wrap.innerHTML = STATUTS_AFFAIRE.map(s=>`<button class="chip ${filtreStatuts.has(s)?"on":""}" data-s="${s}">${s}</button>`).join("");
    wrap.querySelectorAll(".chip").forEach(chip=>{
      chip.addEventListener("click", ()=>{
        const s = chip.dataset.s;
        if(filtreStatuts.has(s)) filtreStatuts.delete(s); else filtreStatuts.add(s);
        renderFiltreStatuts();
        renderMesAffaires();
      });
    });
  }

  // Horizon de projection : 6 prochains mois calendaires (mois courant inclus).
  const PROJECTION_MOIS = 6;
  // 6 prochains mois calendaires à partir d'aujourd'hui (ex: si on est en août -> août, sept, oct, nov, déc, janv)
  function prochainsMoisLabels(){
    const out = [];
    for(let i=0;i<PROJECTION_MOIS;i++){
      const dt = new Date(today.getFullYear(), today.getMonth()+i, 1);
      out.push(MOIS[dt.getMonth()] + " " + String(dt.getFullYear()).slice(2));
    }
    return out;
  }
  // Clé "YYYY-MM" du mois courant + décalage (0 = mois en cours).
  function moisCle(offset){
    const dt = new Date(today.getFullYear(), today.getMonth()+offset, 1);
    return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}`;
  }
  // Nombre de mois restants (mois courant inclus) jusqu'à une date de fin
  function moisRestantsJusqua(dateFinStr){
    const fin = new Date(dateFinStr+"T00:00:00");
    const diff = (fin.getFullYear()-today.getFullYear())*12 + (fin.getMonth()-today.getMonth()) + 1;
    return Math.max(1, diff);
  }

  function projHeadHTML(){
    return prochainsMoisLabels().map(l=>`<th class="num compact">${l}</th>`).join("");
  }

  // --- Projection au niveau mission (éditable par le pilote de la mission) ---
  // Une case peut être fixée manuellement (mission.projectionManuelle["YYYY-MM"] = jours) ; le reste du RAF
  // (RAF - somme des mois fixés) est alors reventilé uniformément sur tous les mois non fixés, jusqu'à la fin
  // réelle de la mission (pas seulement sur les mois affichés, si la mission dépasse l'horizon visible).
  // Non éditable si la mission a moins de PROJECTION_MOIS mois devant elle : pas assez de marge pour que la
  // redistribution manuelle ait un sens.
  // Valeur projetée d'une mission pour le mois à l'offset donné (0 = mois en cours, peut dépasser
  // PROJECTION_MOIS — utilisé par l'histogramme société qui regarde plus loin que les 6 mois éditables).
  function missionProjectionValeurAt(m, rafJ, offset){
    const mr = moisRestantsJusqua(m.dateFin);
    if(offset>=mr) return null;
    const overrides = m.projectionManuelle || {};
    let manualSum = 0, manualCount = 0;
    Object.keys(overrides).forEach(k=>{ manualSum += overrides[k]; manualCount++; });
    const autoMonthsCount = Math.max(0, mr - manualCount);
    const autoValue = autoMonthsCount>0 ? Math.max(0, rafJ - manualSum) / autoMonthsCount : 0;
    if(offset<PROJECTION_MOIS){
      const key = moisCle(offset);
      if(Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
    }
    return autoValue;
  }
  function missionProjectionValeurs(m, rafJ){
    const mr = moisRestantsJusqua(m.dateFin);
    const overrides = m.projectionManuelle || {};
    const out = [];
    for(let i=0;i<PROJECTION_MOIS;i++){
      if(i>=mr){ out.push({ value:null, manual:false, moisKey:null }); continue; }
      const key = moisCle(i);
      const manual = Object.prototype.hasOwnProperty.call(overrides, key);
      out.push({ value: missionProjectionValeurAt(m, rafJ, i), manual, moisKey: manual?key:null });
    }
    return out;
  }
  function missionProjCellsHTML(actif, m, rafJ){
    if(!actif) return `<td class="num compact row-muted">—</td>`.repeat(PROJECTION_MOIS);
    const editable = moisRestantsJusqua(m.dateFin) >= PROJECTION_MOIS;
    return missionProjectionValeurs(m, rafJ).map(v=>{
      if(v.value===null) return `<td class="num compact"><span class="row-muted">—</span></td>`;
      const disp = +v.value.toFixed(1);
      if(!editable) return `<td class="num compact">${jr(disp).replace(" j","")}</td>`;
      return `<td class="num compact proj-cell${v.manual?" proj-manual":""}">
          <input type="number" step="0.5" min="0" class="proj-input" data-mission="${m.id}" data-mois="${v.moisKey}" value="${disp}" title="${v.manual?"Valeur saisie manuellement — laisser vide pour revenir au calcul automatique":"Calculé automatiquement — modifiable"}">
        </td>`;
    }).join("");
  }
  // Total par mois des colonnes de projection (niveau mission, respecte les valeurs manuelles).
  function missionProjSumsHTML(rows, getActif, getRafJ){
    const sums = new Array(PROJECTION_MOIS).fill(0), has = new Array(PROJECTION_MOIS).fill(false);
    rows.forEach(r=>{
      if(!getActif(r)) return;
      missionProjectionValeurs(r, getRafJ(r)).forEach((v,i)=>{ if(v.value!==null){ sums[i]+=v.value; has[i]=true; } });
    });
    return sums.map((v,i)=> `<td class="num compact">${has[i] ? jr(+v.toFixed(1)).replace(" j","") : `<span class="row-muted">—</span>`}</td>`).join("");
  }

  // Cœur commun à "Mes affaires" (Ma page) et à sa reprise sur "Mon Pilotage" — même colonnes, même
  // rendu de ligne ; seuls l'id de tableau et l'état du filtre à chips (indépendant sur chaque page,
  // même principe que les autres filtres dupliqués de l'outil) diffèrent entre les deux appelants.
  function renderMesAffairesTable(tableId, filtreSet, rerender){
    const mine = affaires.filter(a=>a.pilote===currentUser && filtreSet.has(a.statut)).map(a=>{
      const consommeJ = missions.filter(m=>m.affaireId===a.id).reduce((s,m)=>s+joursFactConsommes(m.id),0);
      const rafJ = Math.max(0, a.jours - consommeJ);
      const rafEur = rafJ * (a.budget / a.jours);
      return { ...a, _consommeJ:consommeJ, _rafJ:rafJ, _rafEur:rafEur };
    });
    const columns = [
      { key:"nom", label:"Affaire", get:a=>a.nom },
      { key:"statut", label:"Statut", get:a=>a.statut },
      { key:"jours", label:"Jours vendus", numeric:true, get:a=>a.jours },
      { key:"budget", label:"Budget", numeric:true, get:a=>a.budget },
      { key:"rafJ", label:"RAF jours", numeric:true, sep:true, get:a=>a._rafJ },
      { key:"rafEur", label:"RAF €", numeric:true, get:a=>a._rafEur },
    ];
    const rowHTML = a => `<tr class="row-clickable" data-id="${a.id}" style="cursor:pointer;">
        <td class="affaire-name">${esc(a.nom)}<span class="sub">${esc(orgName(a.organisationId))}</span>${joursBarHTML(a._consommeJ, a.jours, {mini:true})}</td>
        <td>${statutPill(a.statut)}</td>
        <td class="num">${jr(a.jours)}</td>
        <td class="num">${euro(a.budget)}</td>
        <td class="num col-sep-left">${jr(a._rafJ)}</td>
        <td class="num">${euro(a._rafEur)}</td>
      </tr>`;
    renderSortFilterTable(tableId, mine, columns, rowHTML, {
      rerender,
      emptyMsg: "Aucune affaire pilotée pour ce filtre.",
      afterRender: table => table.querySelectorAll("tr[data-id]").forEach(tr=>{
        tr.addEventListener("click", ()=>openAffaireDetail(tr.dataset.id));
      }),
      tfoot: display => {
        const n = display.length;
        return `<tfoot><tr>
          <td colspan="2">Total (${n} affaire${n>1?"s":""})</td>
          <td class="num">${jr(display.reduce((s,a)=>s+a.jours,0))}</td>
          <td class="num">${euro(display.reduce((s,a)=>s+a.budget,0))}</td>
          <td class="num col-sep-left">${jr(display.reduce((s,a)=>s+a._rafJ,0))}</td>
          <td class="num">${euro(display.reduce((s,a)=>s+a._rafEur,0))}</td>
        </tr></tfoot>`;
      },
    });
  }
  function renderMesAffaires(){
    renderMesAffairesTable("table-mes-affaires", filtreStatuts, renderMesAffaires);
  }

  // Reprise de "Mes affaires" sur "Mon Pilotage" (Moi) — même tableau, filtre à chips indépendant.
  let filtreStatutsPilotage = new Set(["en commercialisation","en production"]);
  function renderFiltreStatutsPilotage(){
    const wrap = document.getElementById("filtre-statut-affaires-pilotage");
    if(!wrap) return;
    wrap.innerHTML = STATUTS_AFFAIRE.map(s=>`<button class="chip ${filtreStatutsPilotage.has(s)?"on":""}" data-s="${s}">${s}</button>`).join("");
    wrap.querySelectorAll(".chip").forEach(chip=>{
      chip.addEventListener("click", ()=>{
        const s = chip.dataset.s;
        if(filtreStatutsPilotage.has(s)) filtreStatutsPilotage.delete(s); else filtreStatutsPilotage.add(s);
        renderFiltreStatutsPilotage();
        renderMesAffairesPilotage();
      });
    });
  }
  function renderMesAffairesPilotage(){
    renderMesAffairesTable("table-mes-affaires-pilotage", filtreStatutsPilotage, renderMesAffairesPilotage);
  }

  function statutPill(s){
    // "en cours" (statut de mission) et "en production" (statut d'affaire, ex-"en cours") partagent
    // la même couleur : ce sont deux échelles de statut différentes (mission vs affaire) qui se
    // trouvent toutes deux avoir un état "actif" en cours d'exécution.
    const map = { "en cours":"good", "en production":"good", "en commercialisation":"warn", "terminée":"neutral", "perdue":"danger" };
    return `<span class="pill ${map[s]||"neutral"}">${s}</span>`;
  }

  function renderMesMissions(){
    const mine = missions.filter(m=>m.consultantId===currentUser && m.statut==="en cours").map(m=>{
      const affaire = affaires.find(a=>a.id===m.affaireId);
      const consommeJ = joursFactConsommes(m.id);
      const rafJ = Math.max(0, m.enveloppe - consommeJ);
      const rafEur = rafJ * m.taux;
      return { ...m, _affaire:affaire, _consommeJ:consommeJ, _rafJ:rafJ, _rafEur:rafEur };
    }).filter(m=>m._affaire); // écarte une mission dont l'affaire n'est pas (ou plus) dans le périmètre visible
    const columns = [
      { key:"nom", label:"Mission", width:"22%", get:m=>m.nom },
      { key:"pilote", label:"Pilote", filterable:true, get:m=>consultantName(m._affaire.pilote) },
      { key:"statut", label:"Statut", width:"6%", get:m=>m.statut },
      { key:"enveloppe", label:"Jours prévus", numeric:true, get:m=>m.enveloppe },
      { key:"budget", label:"Budget", numeric:true, get:m=>m.enveloppe*m.taux },
      { key:"rafJ", label:"RAF jours", numeric:true, sep:true, get:m=>m._rafJ },
      { key:"rafEur", label:"RAF €", numeric:true, get:m=>m._rafEur },
    ];
    const rowHTML = m => `<tr>
        <td class="affaire-name row-clickable" data-mission="${esc(m.id)}" style="cursor:pointer;" title="Voir les temps affectés à cette mission"><span class="eyebrow">${esc(orgName(m._affaire.organisationId))}</span>${esc(m._affaire.nom)}<span class="sub">${esc(m.nom)}</span>${joursBarHTML(m._consommeJ, m.enveloppe, {mini:true})}</td>
        <td>${esc(consultantName(m._affaire.pilote))}</td>
        <td>${statutPill(m.statut)} ${missionStatusBadge(m)}</td>
        <td class="num">${jr(m.enveloppe)}</td>
        <td class="num">${euro(m.enveloppe*m.taux)}</td>
        <td class="num col-sep-left">${jr(m._rafJ)}</td>
        <td class="num">${euro(m._rafEur)}</td>
        ${missionProjCellsHTML(m._affaire.statut==="en production", m, m._rafJ)}
      </tr>`;
    renderSortFilterTable("table-mes-missions", mine, columns, rowHTML, {
      rerender: renderMesMissions,
      emptyMsg: "Aucune mission en cours.",
      extraHeadCols: `<th class="num compact" colspan="${PROJECTION_MOIS}" style="text-align:center;">Projection (jours/mois) — modifiable si 6 mois ou plus restants</th>`,
      extraHeadRow: `<tr><td colspan="5"></td><td colspan="2" class="col-sep-left"></td>${projHeadHTML()}</tr>`,
      afterRender: table => table.querySelectorAll("td[data-mission]").forEach(td=>{
        td.addEventListener("click", ()=>openDetailTempsMission(td.dataset.mission, "mapage"));
      }),
      tfoot: display => {
        const n = display.length;
        return `<tfoot><tr>
          <td colspan="3">Total (${n} mission${n>1?"s":""})</td>
          <td class="num">${jr(display.reduce((s,m)=>s+m.enveloppe,0))}</td>
          <td class="num">${euro(display.reduce((s,m)=>s+m.enveloppe*m.taux,0))}</td>
          <td class="num col-sep-left">${jr(display.reduce((s,m)=>s+m._rafJ,0))}</td>
          <td class="num">${euro(display.reduce((s,m)=>s+m._rafEur,0))}</td>
          ${missionProjSumsHTML(display, m=>m._affaire.statut==="en production", m=>m._rafJ)}
        </tr></tfoot>`;
      },
    });
  }

  // Remplit un <select> d'années. `years` est déjà calculé (source propre à chaque vue) ; le helper
  // garantit la présence de CURRENT_YEAR en tête, ajoute une année supplémentaire optionnelle
  // (opts.extraYear, ex. CURRENT_YEAR+1), puis fixe la valeur sélectionnée : soit forcée à
  // CURRENT_YEAR (opts.forceCurrent), soit la valeur précédente si toujours disponible. `onChange`
  // est branché tel quel sur sel.onchange.
  function populateAnneeSelect(sel, years, onChange, opts){
    opts = opts || {};
    const prevValue = sel.value;
    if(!years.includes(String(CURRENT_YEAR))) years.unshift(String(CURRENT_YEAR));
    if(opts.extraYear && !years.includes(opts.extraYear)) years.unshift(opts.extraYear);
    sel.innerHTML = years.map(y=>`<option value="${y}">${y}</option>`).join("");
    sel.value = opts.forceCurrent ? String(CURRENT_YEAR) : (years.includes(prevValue) ? prevValue : String(CURRENT_YEAR));
    sel.onchange = onChange;
  }

  function renderSelectAnnee(){
    const sel = document.getElementById("select-annee");
    const years = Array.from(new Set(saisies.map(s=>s.date.slice(0,4)))).sort().reverse();
    populateAnneeSelect(sel, years, ()=>{
      renderSuiviTemps();
      renderRepartitionChart("chart-repartition-moi", "hatch-repartition-moi", sel.value, currentUser);
      renderDonutChart("chart-donut-moi", sel.value, currentUser);
    }, { forceCurrent:true });
  }

  // Helpers partagés UNIQUEMENT par renderSuiviTemps et renderSuiviTempsSociete : la ligne mensuelle,
  // la ligne de sous-total, et la table complète (thead mois / tbody / tfoot sous-totaux). Noms
  // préfixés « suivi » pour ne pas entrer en collision avec les nombreuses fonctions locales rowHTML
  // du fichier (signatures différentes). Chaque fonction appelante garde sa propre préparation de données.
  function suiviRowHTML(label, arr, cls){
    const total = arr.reduce((a,b)=>a+b,0);
    return `<tr class="${cls==='total'?'row-affaire-total':''}">
        <td style="${cls==='sub'?'padding-left:24px;color:var(--text-muted);':cls==='total'?'font-weight:600;':''}">${esc(label)}</td>
        ${arr.map(v=>`<td class="num">${v? jr(v).replace(' j','') : "–"}</td>`).join("")}
        <td class="num" style="font-weight:600;">${jr(total)}</td>
      </tr>`;
  }
  function suiviSubtotRow(label, arr){
    const total = arr.reduce((a,b)=>a+b,0);
    return `<tr><td>${esc(label)}</td>${arr.map(v=>`<td class="num">${v?jr(v).replace(' j',''):"–"}</td>`).join("")}<td class="num">${jr(total)}</td></tr>`;
  }
  function renderSuiviTempsTable(tableId, rows, missionFact, missionNonFact, interne, absence, year){
    const colTotals = new Array(12).fill(0);
    [missionFact,missionNonFact,interne,absence].forEach(arr=>arr.forEach((v,i)=>colTotals[i]+=v));

    const table = document.getElementById(tableId);
    table.innerHTML = `
      <thead><tr><th>Type de temps</th>${MOIS.map(m=>`<th class="num">${m}</th>`).join("")}<th class="num">Total</th></tr></thead>
      <tbody>${rows.length? rows.join("") : `<tr><td colspan="14" class="empty-note">Aucune saisie sur ${year}.</td></tr>`}</tbody>
      <tfoot>
        ${suiviSubtotRow("Sous-total — missions facturable", missionFact)}
        ${suiviSubtotRow("Sous-total — missions non facturable", missionNonFact)}
        ${suiviSubtotRow("Sous-total — temps internes", interne)}
        ${suiviSubtotRow("Sous-total — absences", absence)}
        <tr class="row-grand-total"><td>Total</td>${colTotals.map(v=>`<td class="num">${v?jr(v).replace(' j',''):"–"}</td>`).join("")}<td class="num">${jr(colTotals.reduce((a,b)=>a+b,0))}</td></tr>
      </tfoot>`;
  }

  function renderSuiviTemps(){
    const year = document.getElementById("select-annee").value;
    const mine = saisies.filter(s=>s.consultantId===currentUser && s.date.slice(0,4)===year);

    // lignes: affaires en cours sur lesquelles le consultant est mobilisé (toutes ses missions, même sans
    // saisie, regroupées et sommées par affaire) puis temps internes puis absences (toutes les catégories,
    // saisies ou non).
    const myMissionsAll = missions.filter(m=>m.consultantId===currentUser);
    const affaireIdsMobilise = new Set(myMissionsAll.map(m=>m.affaireId));
    const affairesMobilisees = affaires.filter(a=>affaireIdsMobilise.has(a.id) && a.statut==="en production");

    let rows = [];
    let subtot = { missionFact:new Array(12).fill(0), missionNonFact:new Array(12).fill(0), interne:new Array(12).fill(0), absence:new Array(12).fill(0) };

    affairesMobilisees.forEach(a=>{
      const missionIds = myMissionsAll.filter(m=>m.affaireId===a.id).map(m=>m.id);
      const fact = new Array(12).fill(0), nonFact = new Array(12).fill(0);
      mine.filter(s=>s.type==="mission" && missionIds.includes(s.missionId)).forEach(s=>{
        const mo = +s.date.slice(5,7)-1;
        fact[mo]+=s.jFact; nonFact[mo]+=s.jNonFact;
      });
      rows.push(suiviRowHTML(a.nom, fact.map((v,i)=>v+nonFact[i]), "total"));
      rows.push(suiviRowHTML("Facturable", fact, "sub"));
      rows.push(suiviRowHTML("Non facturable", nonFact, "sub"));
      for(let i=0;i<12;i++){ subtot.missionFact[i]+=fact[i]; subtot.missionNonFact[i]+=nonFact[i]; }
    });

    tempsInternes.forEach(cat=>{
      const arr = new Array(12).fill(0);
      mine.filter(s=>s.type==="interne" && s.categorie===cat.code).forEach(s=>{ arr[+s.date.slice(5,7)-1]+=s.dureeJ; });
      rows.push(suiviRowHTML(cat.label, arr, "")); for(let i=0;i<12;i++) subtot.interne[i]+=arr[i];
    });
    tempsAbsences.forEach(cat=>{
      const arr = new Array(12).fill(0);
      mine.filter(s=>s.type==="absence" && s.categorie===cat.code).forEach(s=>{ arr[+s.date.slice(5,7)-1]+=s.dureeJ; });
      rows.push(suiviRowHTML(cat.label, arr, "")); for(let i=0;i<12;i++) subtot.absence[i]+=arr[i];
    });

    renderSuiviTempsTable("table-suivi-temps", rows, subtot.missionFact, subtot.missionNonFact, subtot.interne, subtot.absence, year);
  }

  // Statut de couleur d'un TJM (vendu ou réel) par rapport à l'objectif — mêmes seuils/couleurs que la
  // jauge de taux de charge de la même page (vert = au moins l'objectif, orange puis rouge en-dessous).
  function tjmStatusColor(value, objectif){
    const delta = objectif>0 ? (value-objectif)/objectif : 0;
    if(delta>=0) return "var(--brand-green)";
    if(delta>=-0.1) return "#e9b350";
    return "#ef7a63";
  }
  // Barre TJM divergente : l'objectif est un repère fixe au centre, le TJM vendu (rond) et le TJM réel
  // (losange) se placent à gauche ou à droite selon leur écart à l'objectif, colorés selon ce même
  // écart. L'échelle s'ajuste au plus grand des deux écarts (avec un plancher pour rester lisible même
  // quand vendu/réel sont très proches de l'objectif). Les valeurs exactes sont rappelées juste
  // en-dessous du graphique (comme la jauge de taux de charge), qui reste donc lisible même compact.
  function tjmDivergingBarSVG(objectif, vendu, reel){
    const W=200, H=46, cx=100, trackY=23, half=78;
    const deltas = [vendu, reel].filter(v=>v!=null).map(v=>Math.abs(v-objectif));
    const maxDelta = Math.max(objectif*0.08, 20, ...deltas, 1) * 1.35;
    const pos = v => Math.max(cx-half, Math.min(cx+half, cx + ((v-objectif)/maxDelta)*half));

    let marks = `<line x1="${cx-half}" y1="${trackY}" x2="${cx+half}" y2="${trackY}" stroke="var(--hero-text-muted)" stroke-width="1" opacity=".4"/>
      <line x1="${cx}" y1="${trackY-13}" x2="${cx}" y2="${trackY+13}" stroke="var(--hero-text)" stroke-width="2" stroke-linecap="round"/>`;
    if(vendu!=null){
      const x = pos(vendu);
      marks += `<circle cx="${x.toFixed(1)}" cy="${trackY-7}" r="5.5" fill="${tjmStatusColor(vendu,objectif)}" stroke="var(--hero-bg)" stroke-width="1.5"/>`;
    }
    if(reel!=null){
      const x = pos(reel), r = 5.2;
      marks += `<rect x="${(x-r).toFixed(1)}" y="${(trackY+7-r).toFixed(1)}" width="${r*2}" height="${r*2}" transform="rotate(45 ${x.toFixed(1)} ${trackY+7})" fill="${tjmStatusColor(reel,objectif)}" stroke="var(--hero-bg)" stroke-width="1.5"/>`;
    }
    const ariaVendu = vendu!=null ? `${Math.round(vendu)} €` : "non calculable";
    const ariaReel = reel!=null ? `${Math.round(reel)} €` : "non calculable";
    return `<svg viewBox="0 0 ${W} ${H}" class="tjm-bar-svg" role="img" aria-label="TJM objectif ${Math.round(objectif)} €, vendu ${ariaVendu}, réel ${ariaReel}">${marks}</svg>`;
  }

  function renderKpis(){
    const wrap = document.getElementById("mapage-kpis");
    const year = String(CURRENT_YEAR);
    const c = consultants.find(x=>x.id===currentUser);
    const stats = computeConsultantAnnee(c, year);
    const etp = computeConsultantETP(c, year);

    const mine = saisies.filter(s=>s.consultantId===currentUser && s.date.slice(0,4)===year);
    const jNonFactMission = mine.filter(s=>s.type==="mission").reduce((s,x)=>s+x.jNonFact,0);
    const jVendusMissions = missions.filter(m=>m.consultantId===currentUser).reduce((s,m)=>s+m.enveloppe,0);
    const tauxNonFact = jVendusMissions>0 ? Math.round((jNonFactMission/jVendusMissions)*100) : 0;

    const gaugeLevel = stats.tauxCharge>120 ? "danger" : (stats.tauxCharge>100 ? "warn" : "good");
    const gaugeColorVar = { good:"var(--brand-green)", warn:"#e9b350", danger:"#ef7a63" }[gaugeLevel];
    const statutLabel = c.statut==="stagiaire" ? "Stagiaire" : (c.statut==="en poste" ? "En poste" : c.statut);

    const tjmVenduTxt = stats.tjmVendu!=null ? euro(Math.round(stats.tjmVendu)) : "—";
    const tjmReelTxt = stats.tjmReel!=null ? euro(Math.round(stats.tjmReel)) : "—";
    const tjmVenduColor = stats.tjmVendu!=null ? tjmStatusColor(stats.tjmVendu, c.tjmBase) : "var(--hero-text-muted)";
    const tjmReelColor = stats.tjmReel!=null ? tjmStatusColor(stats.tjmReel, c.tjmBase) : "var(--hero-text-muted)";

    wrap.innerHTML = `
      <div class="kpi kpi-hero kpi-combo">
        <div class="kpi-label">Effectif</div>
        <div class="kpi-combo-row">
          <div class="kpi-combo-item"><div class="kpi-combo-value">${statutLabel}</div><div class="kpi-combo-sub">statut</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${etp.toLocaleString("fr-FR",{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div class="kpi-combo-sub">ETP ${year}</div></div>
        </div>
      </div>
      <div class="kpi kpi-hero kpi-combo">
        <div class="kpi-label">Production ${year}</div>
        <div class="kpi-combo-row">
          <div class="kpi-combo-item"><div class="kpi-combo-value">${euro(stats.production)}</div><div class="kpi-combo-sub">produits</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${jr(stats.jFact)}</div><div class="kpi-combo-sub">facturables</div></div>
        </div>
      </div>
      <div class="kpi kpi-hero"><div class="kpi-label">Commercial gagné ${year}</div><div class="kpi-value">${euro(commercialGagneMontant(currentUser, year))}</div></div>
      <div class="kpi kpi-hero"><div class="kpi-label">Affaires en production</div><div class="kpi-value">${stats.nbAffairesEnCours}</div></div>
      <div class="kpi kpi-hero"><div class="kpi-label">% non facturable (missions)</div><div class="kpi-value">${tauxNonFact}<small>%</small></div></div>
      <div class="kpi kpi-hero kpi-gauge">
        <div class="kpi-label">Taux de charge ${year}</div>
        <div class="gauge-wrap">
          <div class="gauge" style="--pct:${Math.min(100,stats.tauxCharge)};--gauge-color:${gaugeColorVar};">
            <div class="gauge-value">${stats.tauxCharge}%</div>
          </div>
          <div class="gauge-note">${jr(stats.jFact)} facturables<br>/ ${jr(stats.jDispo)} saisis (hors absences)</div>
        </div>
      </div>
      <div class="kpi kpi-hero kpi-gauge">
        <div class="kpi-label">TJM — objectif ${euro(c.tjmBase)}</div>
        ${tjmDivergingBarSVG(c.tjmBase, stats.tjmVendu, stats.tjmReel)}
        <div class="gauge-note"><span style="color:${tjmVenduColor};">●</span> Vendu ${tjmVenduTxt} &nbsp; <span style="color:${tjmReelColor};">◆</span> Réel ${tjmReelTxt}</div>
      </div>
    `;
  }

  /* ================= Modal saisie ================= */
  function openSaisie(){
    document.getElementById("f-date").value = today.toISOString().slice(0,10);
    // Présélection « temps interne » si le consultant n'a aucune mission en cours (nouvel arrivant,
    // stagiaire) : le sélecteur de mission serait vide et « Enregistrer » resterait sans effet.
    const aUneMission = missions.some(m=>m.consultantId===currentUser && m.statut==="en cours");
    document.getElementById("f-type").value = aUneMission ? "mission" : "interne";
    document.getElementById("f-duree").value = 7;
    document.getElementById("f-pct").value = 100;
    document.getElementById("f-comment").value = "";
    document.getElementById("alert-depassement").classList.remove("show");
    populateMissionSelect();
    onTypeChange();
    document.getElementById("modal-saisie").hidden = false;
  }
  function closeSaisie(){ document.getElementById("modal-saisie").hidden = true; }

  function populateMissionSelect(){
    const sel = document.getElementById("f-mission");
    const mine = missions.filter(m=>m.consultantId===currentUser && m.statut==="en cours");
    sel.innerHTML = mine.map(m=>`<option value="${esc(m.id)}">${esc(m.nom)} (${esc(affaires.find(a=>a.id===m.affaireId)?.nom ?? "—")})</option>`).join("");
  }
  function populateCategorieSelect(){
    const sel = document.getElementById("f-categorie");
    const type = document.getElementById("f-type").value;
    const list = type==="interne" ? tempsInternes : tempsAbsences;
    sel.innerHTML = list.map(c=>`<option value="${c.code}">${c.label}</option>`).join("");
  }
  function onTypeChange(){
    const type = document.getElementById("f-type").value;
    document.getElementById("wrap-mission").hidden = type!=="mission";
    document.getElementById("wrap-categorie").hidden = type==="mission";
    document.getElementById("wrap-pct").style.display = type==="mission" ? "" : "none";
    if(type!=="mission") populateCategorieSelect();
    document.getElementById("alert-depassement").classList.remove("show");
  }

  function saveSaisie(){
    const type = document.getElementById("f-type").value;
    const date = document.getElementById("f-date").value;
    const dureeH = parseFloat(document.getElementById("f-duree").value) || 0;
    const dureeJ = +(dureeH/8).toFixed(2);
    let pctFact = type==="mission" ? Math.max(0,Math.min(100, parseFloat(document.getElementById("f-pct").value)||0)) : 0;
    let missionId = null, categorie = null;
    let alertMsg = null;

    if(type==="mission"){
      missionId = document.getElementById("f-mission").value;
      const mission = missions.find(m=>m.id===missionId);
      if(!mission){
        toast("Aucune mission ne vous est affectée — choisissez « temps interne » ou « absence », ou contactez le pilote de l'affaire.");
        return;
      }
      const dejaFact = joursFactConsommes(missionId);
      const restant = mission.enveloppe - dejaFact;
      const jFactDemandes = +(dureeJ*(pctFact/100)).toFixed(2);
      if(jFactDemandes > Math.max(0,restant) + 1e-9){
        const excedent = +(jFactDemandes - Math.max(0,restant)).toFixed(2);
        pctFact = restant>0 ? +((restant/dureeJ)*100).toFixed(1) : 0;
        alertMsg = "Attention, le temps saisi est supérieur à l'enveloppe accordée sur la mission. Le surplus est basculé en non facturable.";
      }
    } else {
      categorie = document.getElementById("f-categorie").value;
    }

    const jFact = +(dureeJ*(pctFact/100)).toFixed(2);
    const jNonFact = +(dureeJ - jFact).toFixed(2);
    const commentaire = (document.getElementById("f-comment").value || "").trim();

    saisies.push({ id:newEntityId("S"), date, consultantId:currentUser, type, missionId, categorie, dureeH, pctFact, dureeJ, jFact, jNonFact, commentaire });

    if(alertMsg){
      const a = document.getElementById("alert-depassement");
      a.querySelector("span").textContent = alertMsg;
      a.classList.add("show");
      toast("Temps enregistré — dépassement d'enveloppe basculé en non facturable");
      renderAll();
      return; // laisse voir le message avant fermeture
    }
    toast("Temps enregistré");
    closeSaisie();
    renderAll();
  }

  /* ================= Export CSV ================= */
  // Neutralise l'injection de formules (CSV injection) : une cellule commençant par = + - @ (ou une
  // tabulation / retour chariot) serait interprétée comme une formule à l'ouverture dans Excel /
  // LibreOffice. On la préfixe d'une apostrophe pour la forcer en texte, puis on double les guillemets.
  function csvCell(v){
    let s = String(v ?? "");
    if(/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g,'""')}"`;
  }
  async function exportCSV(rows, filename){
    const csv = rows.map(r => r.map(csvCell).join(";")).join("\n");
    const data = "﻿" + csv;
    const blob = new Blob([data], {type:"text/csv;charset=utf-8;"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  const EXPORTERS = {
    "mes-affaires"(){
          const rows=[["Affaire","Organisation","Statut","Jours vendus","Budget","RAF jours","RAF euros"]];
          affaires.filter(a=>a.pilote===currentUser && filtreStatuts.has(a.statut)).forEach(a=>{
            const consommeJ = missions.filter(m=>m.affaireId===a.id).reduce((s,m)=>s+joursFactConsommes(m.id),0);
            const rafJ = Math.max(0,a.jours-consommeJ);
            rows.push([a.nom,orgName(a.organisationId),a.statut,a.jours,a.budget,rafJ,+(rafJ*(a.budget/a.jours)).toFixed(0)]);
          });
          exportCSV(rows,"mes-affaires.csv");
    },
    "mes-missions"(){
          const rows=[["Mission","Affaire","Statut","Jours prévus","Budget","RAF jours","RAF euros"]];
          missions.filter(m=>m.consultantId===currentUser && m.statut==="en cours").forEach(m=>{
            const rafJ = Math.max(0,m.enveloppe-joursFactConsommes(m.id));
            rows.push([m.nom, affaires.find(a=>a.id===m.affaireId).nom, m.statut, m.enveloppe, m.enveloppe*m.taux, rafJ, +(rafJ*m.taux).toFixed(0)]);
          });
          exportCSV(rows,"mes-missions.csv");
    },
    "suivi-temps"(){
          const year = document.getElementById("select-annee").value;
          const rows=[["Date","Type","Détail","Durée (j)","Jours facturables","Jours non facturables"]];
          saisies.filter(s=>s.consultantId===currentUser && s.date.slice(0,4)===year).forEach(s=>{
            const detail = s.type==="mission" ? missions.find(m=>m.id===s.missionId)?.nom
              : s.type==="interne" ? tempsInternes.find(c=>c.code===s.categorie)?.label
              : tempsAbsences.find(c=>c.code===s.categorie)?.label;
            rows.push([s.date, s.type, detail, s.dureeJ, s.jFact, s.jNonFact]);
          });
          exportCSV(rows, `suivi-temps-${year}.csv`);
    },
    "mes-temps"(){
          const isMois = mesTempsMode === "mois";
          const monthKey = today.toISOString().slice(0,7);
          const rows=[["Date","Type de temps","Durée (j)","Commentaires","Jours facturables","Jours non facturables"]];
          saisies.filter(s=>s.consultantId===currentUser && (isMois ? s.date.slice(0,7)===monthKey : s.date.slice(0,4)===mesTempsYear))
            .slice().sort((a,b)=>b.date.localeCompare(a.date))
            .forEach(s=>{
              rows.push([s.date, saisieTypeLabel(s), s.dureeJ, s.commentaire||"", s.jFact, s.jNonFact]);
            });
          exportCSV(rows, `mes-temps-${isMois ? monthKey : mesTempsYear}.csv`);
    },
    "mes-frais"(){
          const isMois = mesFraisMode === "mois";
          const monthKey = today.toISOString().slice(0,7);
          const rows=[["Date","Affaire / Interne","Sous-catégorie","Catégorie","Refacturable","Montant HT","Taux TVA","Montant TVA","Montant TTC","Statut","Note de frais","Commentaires"]];
          notesFrais.filter(n=>n.consultantId===currentUser && (isMois ? n.date.slice(0,7)===monthKey : n.date.slice(0,4)===mesFraisYear))
            .slice().sort((a,b)=>b.date.localeCompare(a.date))
            .forEach(n=>{
              const cat = categorieFraisById(n.categorieFraisId);
              rows.push([n.date, fraisCibleLabel(n), cat?cat.label:"", cat?cat.categorie:"", n.affaireId ? (n.refacturable?"Oui":"Non") : "—",
                n.montantHT, tvaTauxListLabel(n.lignesTVA), n.montantTVA, n.montantTTC, fraisStatut(n), n.numeroBordereau, n.commentaire||""]);
            });
          exportCSV(rows, `mes-frais-${isMois ? monthKey : mesFraisYear}.csv`);
    },
    "portefeuille"(){
          const rows=[["Affaire","Organisation","Statut","Pilote","Pilote commercial","Date début prévue","Date fin prévue","Budget","Jours vendus","RAF jours","Méthodes","Types de territoire","Domaines d'intervention","Mots-clés"]];
          affaires.filter(a=>filtrePortefeuille.has(a.statut)).forEach(a=>{
            const consommeJ = missions.filter(m=>m.affaireId===a.id).reduce((s,m)=>s+joursFactConsommes(m.id),0);
            const rafJ = Math.max(0, a.jours - consommeJ);
            rows.push([a.nom, orgName(a.organisationId), a.statut, consultantName(a.pilote), consultantName(a.piloteCommercial),
              a.dateDebut, a.dateFin, a.budget, a.jours, rafJ,
              caracLabels(a.methodes, methodes).join(" / "),
              caracLabels(a.territoires, typesTerritoire).join(" / "),
              caracLabels(a.domaines, domainesIntervention).join(" / "),
              a.motsCles||""]);
          });
          exportCSV(rows, "portefeuille-affaires.csv");
    },
    "missions-affaire"(){
          const a = affaires.find(x=>x.id===currentAffaireDetailId);
          const rows=[["Mission","Consultant","Statut","Enveloppe (j)","Budget","Consommé facturable (j)","RAF (j)"]];
          missions.filter(m=>m.affaireId===a.id).forEach(m=>{
            const cons = joursFactConsommes(m.id);
            rows.push([m.nom, consultantName(m.consultantId), m.statut, m.enveloppe, m.enveloppe*m.taux, cons, Math.max(0,m.enveloppe-cons)]);
          });
          exportCSV(rows, `missions-${a.nomAbrege}.csv`);
    },
    "effectifs"(){
          const year = document.getElementById("select-annee-societe").value;
          const rows=[["Consultant","Statut","Embauche","TJM objectif","TJM vendu","TJM réel","Affaires en production","Jours facturables","Taux de charge %","Production"]];
          consultants.forEach(c=>{
            const s = computeConsultantAnnee(c, year);
            rows.push([c.nom, c.statut, c.dateEmbauche, c.tjmBase,
              s.tjmVendu!==null ? Math.round(s.tjmVendu) : "",
              s.tjmReel!==null ? Math.round(s.tjmReel) : "",
              s.nbAffairesEnCours, s.jFact, s.tauxCharge, +s.production.toFixed(0)]);
          });
          exportCSV(rows, `effectifs-${year}.csv`);
    },
    "ca-affaires"(){
          const year = document.getElementById("select-annee-societe").value;
          const rows=[["Affaire","Client","Statut","Pilote","Budget vendu","Production réalisée","% réalisé"]];
          affaires.forEach(a=>{
            const ca = caRealiseAffaire(a.id, year);
            const pct = a.budget>0 ? Math.round((ca/a.budget)*100) : 0;
            rows.push([a.nom, orgName(a.organisationId), a.statut, consultantName(a.pilote), a.budget, +ca.toFixed(0), pct]);
          });
          exportCSV(rows, `production-par-affaire-${year}.csv`);
    },
    "suivi-temps-societe"(){
          const year = document.getElementById("select-annee-societe").value;
          const rows=[["Date","Consultant","Type","Détail","Durée (j)","Jours facturables","Jours non facturables"]];
          saisies.filter(s=>s.date.slice(0,4)===year).forEach(s=>{
            const detail = s.type==="mission" ? missions.find(m=>m.id===s.missionId)?.nom
              : s.type==="interne" ? tempsInternes.find(c=>c.code===s.categorie)?.label
              : tempsAbsences.find(c=>c.code===s.categorie)?.label;
            rows.push([s.date, consultantName(s.consultantId), s.type, detail, s.dureeJ, s.jFact, s.jNonFact]);
          });
          exportCSV(rows, `suivi-temps-societe-${year}.csv`);
    },
    "detail-temps"(){
          if(detailTempsMode === "affaire"){
            const a = affaires.find(x=>x.id===detailTempsAffaireId);
            const missionIds = new Set(missions.filter(m=>m.affaireId===a.id).map(m=>m.id));
            const rows=[["Date","Consultant","Mission","Durée (j)","Commentaires","Jours facturables","Jours non facturables"]];
            saisies.filter(s=>s.type==="mission" && missionIds.has(s.missionId))
              .slice().sort((a,b)=>b.date.localeCompare(a.date))
              .forEach(s=>{
                rows.push([s.date, consultantName(s.consultantId), saisieMissionName(s), s.dureeJ, s.commentaire||"", s.jFact, s.jNonFact]);
              });
            exportCSV(rows, `detail-temps-${a.nomAbrege}.csv`);
          } else if(detailTempsMode === "mission"){
            const m = missions.find(x=>x.id===detailTempsMissionId);
            const rows=[["Date","Consultant","Durée (j)","Commentaires","Jours facturables","Jours non facturables"]];
            saisies.filter(s=>s.type==="mission" && s.missionId===m.id)
              .slice().sort((a,b)=>b.date.localeCompare(a.date))
              .forEach(s=>{
                rows.push([s.date, consultantName(s.consultantId), s.dureeJ, s.commentaire||"", s.jFact, s.jNonFact]);
              });
            exportCSV(rows, `detail-temps-${m.nom}.csv`);
          } else {
            const year = detailTempsYear;
            const isAll = detailTempsScope === "all";
            const rows=[[...(isAll?["Date","Consultant"]:["Date"]),"Type de temps","Durée (j)","Commentaires","Jours facturables","Jours non facturables"]];
            saisies.filter(s=>s.date.slice(0,4)===year && (isAll || s.consultantId===detailTempsScope))
              .slice().sort((a,b)=>b.date.localeCompare(a.date))
              .forEach(s=>{
                rows.push([...(isAll?[s.date, consultantName(s.consultantId)]:[s.date]), saisieTypeLabel(s), s.dureeJ, s.commentaire||"", s.jFact, s.jNonFact]);
              });
            exportCSV(rows, `detail-temps-${isAll?"societe":detailTempsScope}-${year}.csv`);
          }
    },
    "consultants"(){
          const year = String(CURRENT_YEAR);
          const rows=[["Consultant","Trigramme","Statut","Arrivée","Départ","TJM objectif","Temps partiel",`ETP ${year}`]];
          consultants.forEach(c=>{
            const etp = computeConsultantETP(c, year);
            const partiel = c.statut==="stagiaire" ? "25% (forfait stagiaire)"
              : (c.tempsPartiel&&c.tempsPartiel.length) ? c.tempsPartiel.map(p=>`${p.pct}% du ${p.debut}${p.fin?` au ${p.fin}`:" (en cours)"}`).join(" | ")
              : "Temps plein";
            rows.push([c.nom, c.trigramme||"", c.statut, c.dateEmbauche, c.dateDepart||"", c.tjmBase, partiel, etp]);
          });
          exportCSV(rows, `consultants.csv`);
    },
    "bordereaux"(){
          const rows=[["Numéro","Consultant","Année","Nb frais","Montant TTC","Statut","Date de paiement"]];
          bordereauxFrais.slice().sort((a,b)=>b.numero.localeCompare(a.numero)).forEach(b=>{
            const frais = notesFrais.filter(n=>n.numeroBordereau===b.numero);
            rows.push([b.numero, consultantName(b.consultantId), b.annee, frais.length, frais.reduce((s,n)=>s+n.montantTTC,0), b.statut, b.datePaiement||""]);
          });
          exportCSV(rows, `notes-de-frais.csv`);
    },
    "frais-societe"(){
          const year = document.getElementById("select-annee-frais").value;
          // Taux et montant de TVA sur des colonnes numériques séparées pour chacune des 4 lignes
          // possibles (une note peut cumuler plusieurs taux, ex. restaurant) — exploitable tel quel
          // par le comptable, contrairement à l'affichage à l'écran qui fusionne taux et montant.
          const rows=[["Date","Consultant","Affaire / Interne","Sous-catégorie","Catégorie","Refacturable","Montant HT",
            "Taux TVA 1","Montant TVA 1","Taux TVA 2","Montant TVA 2","Taux TVA 3","Montant TVA 3","Taux TVA 4","Montant TVA 4",
            "Montant TTC","Statut","Note de frais","Commentaires"]];
          notesFrais.filter(n=>n.date.slice(0,4)===year).slice().sort((a,b)=>b.date.localeCompare(a.date)).forEach(n=>{
            const cat = categorieFraisById(n.categorieFraisId);
            rows.push([n.date, consultantName(n.consultantId), fraisCibleLabel(n), cat?cat.label:"", cat?cat.categorie:"", n.affaireId ? (n.refacturable?"Oui":"Non") : "—",
              n.montantHT,
              fraisLigneTauxCSV(n,0), fraisLigneMontantTVACSV(n,0),
              fraisLigneTauxCSV(n,1), fraisLigneMontantTVACSV(n,1),
              fraisLigneTauxCSV(n,2), fraisLigneMontantTVACSV(n,2),
              fraisLigneTauxCSV(n,3), fraisLigneMontantTVACSV(n,3),
              n.montantTTC, fraisStatut(n), n.numeroBordereau, n.commentaire||""]);
          });
          exportCSV(rows, `frais-societe-${year}.csv`);
    },
    "commercial-societe"(){
          const year = document.getElementById("select-annee-commercial").value;
          const rows=[["Organisation","Affaire","Date de dépôt","Montant","Jours","% de réussite","Statut","Type de vente","Pilote commercial"]];
          affairesDeposeesAnnee(year).slice().sort((a,b)=>b.dateDepot.localeCompare(a.dateDepot)).forEach(a=>{
            rows.push([orgName(a.organisationId), a.nom, a.dateDepot, a.budget, a.jours, a.pctReussite, a.statut, a.typeVente, consultantName(a.piloteCommercial)]);
          });
          exportCSV(rows, `suivi-commercial-${year}.csv`);
    },
    "commercial-moi"(){
          const year = document.getElementById("select-annee-commercial-moi").value;
          const rows=[["Organisation","Affaire","Date de dépôt","Statut","Mon rôle","Ma part (%)","Montant total de l'offre","Montant ventilé","Jours ventilés","% de réussite"]];
          affairesDeposeesAnnee(year).filter(a=>creditConsultantSurAffaire(a,currentUser)>0)
            .slice().sort((a,b)=>b.dateDepot.localeCompare(a.dateDepot)).forEach(a=>{
              const part = creditConsultantSurAffaire(a,currentUser);
              const role = roleConsultantSurAffaire(a,currentUser);
              rows.push([orgName(a.organisationId), a.nom, a.dateDepot, a.statut, role==="pilote"?"Pilote":"Contributeur", Math.round(part*100), a.budget, Math.round(budgetMissionsPrevisionnel(a)*part), +((a.jours||0)*part).toFixed(2), a.pctReussite]);
            });
          exportCSV(rows, `mon-commercial-${currentUser}-${year}.csv`);
    },
    "factures-affaire"(){
          const a = affaires.find(x=>x.id===currentAffaireDetailId);
          const rows=[["Numéro","Statut","Formation","Échéance prévisionnelle","Dépôt","Échéance paiement","Payée","Date de paiement","Montant mission HT","Montant frais TTC","Montant sous-traitance HT","Total HT","Total TTC","Commentaires"]];
          facturesAffaire(a.id).forEach(f=>{
            rows.push([f.numero||"", f.statut, f.formation?"Oui":"Non", f.echeancePrev||"", f.dateDepot||"", f.echeancePaiementPrev||"",
              f.payee?"Oui":"Non", f.datePaiement||"", f.montantMissionHT, f.montantFraisTTC, f.montantSousTraitanceHT,
              +factureTotalHT(f).toFixed(2), +factureTotalTTC(f).toFixed(2), f.commentaires||""]);
          });
          exportCSV(rows, `factures-${a.nomAbrege}.csv`);
    },
    "factures-societe"(){
          const year = document.getElementById("select-annee-facturation").value;
          const rows=[["Affaire","Numéro","Statut","Formation","Échéance prévisionnelle","Dépôt","Échéance paiement","Payée","Date de paiement","Montant mission HT","Montant frais TTC","Montant sous-traitance HT","Total HT","Total TTC","Commentaires"]];
          factures.filter(f=>(f.echeancePrev||"").slice(0,4)===year).forEach(f=>{
            rows.push([affaires.find(a=>a.id===f.affaireId)?.nom || "", f.numero||"", f.statut, f.formation?"Oui":"Non", f.echeancePrev||"", f.dateDepot||"",
              f.echeancePaiementPrev||"", f.payee?"Oui":"Non", f.datePaiement||"", f.montantMissionHT, f.montantFraisTTC, f.montantSousTraitanceHT,
              +factureTotalHT(f).toFixed(2), +factureTotalTTC(f).toFixed(2), f.commentaires||""]);
          });
          exportCSV(rows, `factures-societe-${year}.csv`);
    },
  };
  function wireExports(){
    document.querySelectorAll("[data-export]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const fn = EXPORTERS[btn.dataset.export];
        if(fn) fn();
      });
    });
  }

  /* ================= Navigation ================= */
  let currentView = "mapage";
  let currentAffaireDetailId = null;

  function showView(name){
    currentView = name;
    document.querySelectorAll("main.content > section").forEach(sec=>{
      sec.hidden = sec.id !== "view-" + name;
    });
    document.querySelectorAll(".nav-item[data-view]").forEach(btn=>{
      btn.classList.toggle("active", btn.dataset.view === name);
    });
    if(name==="organisations") renderOrganisations();
    if(name==="affaires"){ renderAlertesAffairesCabinet(); renderPortefeuille(); }
    if(name==="societe"){ renderSelectAnneeSociete(); renderSociete(); }
    if(name==="consultants") renderConsultants();
    if(name==="frais"){ renderSelectAnneeFrais(); renderFraisSociete(); renderAdminBordereaux(); }
    if(name==="facturation"){ renderSelectAnneeFacturation(); renderFacturation(); }
    if(name==="admin") renderListesReference();
    if(name==="detail-temps") renderDetailTemps();
    if(name==="mestemps"){
      renderSelectAnneeMesTemps(); wireMesTempsToggle(); renderMesTemps(); renderSelectAnnee(); renderSuiviTemps();
      renderRepartitionChart("chart-repartition-moi", "hatch-repartition-moi", document.getElementById("select-annee").value, currentUser);
      renderDonutChart("chart-donut-moi", document.getElementById("select-annee").value, currentUser);
    }
    if(name==="mesfrais"){ renderSelectAnneeMesFrais(); wireMesFraisToggle(); renderMesFrais(); renderMesBordereaux(); }
    if(name==="commercial"){ renderSelectAnneeCommercial(); renderCommercialSociete(); }
    if(name==="commercial-moi"){ renderSelectAnneeCommercialMoi(); renderCommercialMoi(); }
    if(name==="pilotage"){ renderFiltreStatutsPilotage(); renderMesAffairesPilotage(); renderMesAlertesFacturation(); renderMesAlertesPilotageAffaire(); }
    if(name==="mapage") checkMesAlertesBanner();
  }

  function openAffaireDetail(affaireId){
    currentAffaireDetailId = affaireId;
    showView("affaire-detail");
    renderAffaireDetail();
  }

  /* ================= Société ================= */
  // Jours facturables / taux de charge / production / TJM d'un consultant sur une année donnée.
  // Production = jours facturables produits × taux négocié de mission (valeur produite, indépendante de la date de facturation).
  // TJM vendu = production € / jours facturables produits ; TJM réel = production € / jours passés sur des missions (fact. + non fact.).
  function computeConsultantAnnee(c, year){
    const s = saisies.filter(x=>x.consultantId===c.id && x.date.slice(0,4)===year);
    const jFact = s.reduce((sum,x)=>sum+x.jFact,0);
    const jTotalSaisi = s.reduce((sum,x)=>sum+x.dureeJ,0);
    const jAbsences = s.filter(x=>x.type==="absence").reduce((sum,x)=>sum+x.dureeJ,0);
    const jDispo = Math.max(0, jTotalSaisi - jAbsences);
    const tauxCharge = jDispo>0 ? Math.round((jFact/jDispo)*100) : 0;
    const missionSaisies = s.filter(x=>x.type==="mission");
    const joursMission = missionSaisies.reduce((sum,x)=>sum+x.dureeJ,0);
    const production = missionSaisies.reduce((sum,x)=>{
      const m = missions.find(mm=>mm.id===x.missionId);
      return sum + (m ? x.jFact*m.taux : 0);
    },0);
    const tjmVendu = jFact>0 ? production/jFact : null;
    const tjmReel = joursMission>0 ? production/joursMission : null;
    // Affaires en production sur lesquelles le consultant est impliqué — comme pilote de l'affaire,
    // ou simplement en exécutant l'une de ses missions (pilote ou non).
    const nbAffairesEnCours = affaires.filter(a=>
      a.statut==="en production" &&
      (a.pilote===c.id || missions.some(m=>m.affaireId===a.id && m.consultantId===c.id && m.statut==="en cours"))
    ).length;
    return { jFact, jDispo, tauxCharge, joursMission, production, tjmVendu, tjmReel, nbAffairesEnCours };
  }
  // Production réalisée (jours facturables × taux négocié) sur une affaire, pour une année donnée.
  function caRealiseAffaire(affaireId, year){
    const missionIds = new Set(missions.filter(m=>m.affaireId===affaireId).map(m=>m.id));
    return saisies.filter(s=>s.type==="mission" && missionIds.has(s.missionId) && s.date.slice(0,4)===year)
      .reduce((sum,s)=>{
        const m = missions.find(mm=>mm.id===s.missionId);
        return sum + (m ? s.jFact*m.taux : 0);
      },0);
  }

  // À partir de septembre, l'année suivante devient sélectionnable sur la page Société (visibilité
  // anticipée du prévisionnel de l'année à venir, même sans aucune saisie réelle dessus).
  function anneeSuivanteActivable(moisIndex){ return moisIndex >= 8; }

  function renderSelectAnneeSociete(){
    const sel = document.getElementById("select-annee-societe");
    const years = Array.from(new Set(saisies.map(s=>s.date.slice(0,4)))).sort().reverse();
    populateAnneeSelect(sel, years, renderSociete, { extraYear: anneeSuivanteActivable(today.getMonth()) ? String(CURRENT_YEAR+1) : null });
  }

  // --- Histogramme "Production facturable — vue mensuelle" (Société ET Ma page) ---
  // Pour chaque mois de l'année sélectionnée, deux composantes cumulables :
  //  - réalisé  : saisies réellement enregistrées ce mois-là (quel que soit le mois — une saisie
  //               peut exceptionnellement être postée un peu en avance sur "aujourd'hui")
  //  - prévisionnel : uniquement pour les mois postérieurs au mois courant, part du RAF des missions
  //               en cours encore à produire (même logique que les cases éditables des tableaux de
  //               missions, étendue au-delà de l'horizon des 6 mois visibles)
  // Un mois peut donc cumuler les deux (ex. le mois courant, ou un mois où une saisie a été postée
  // en avance) — le graphique empile alors les deux segments. Cette décomposition garantit que les
  // totaux du graphique se recoupent exactement avec les tuiles KPI et « Production par affaire »
  // ci-dessus (qui, elles, agrègent toutes les saisies réelles de l'année sans egard au mois courant).
  // consultantId : null pour la vue société (toutes les missions/saisies), ou un id de consultant
  // pour restreindre à ses seules saisies et aux missions dont il est le pilote (vue « Ma page »).
  // Étale linéairement, jour calendaire par jour calendaire, le montant et les jours pondérés
  // (budget/jours de l'affaire × % de réussite) de chaque affaire encore "en commercialisation"
  // sur sa fenêtre prévisionnelle [dateDebut, dateFin], puis agrège la part de chaque mois de
  // l'année demandée. Société uniquement : le pipeline n'est pas encore staffé, donc pas de
  // ventilation par consultant possible (même principe que "par pilote commercial", omis de
  // Mon commercial, et que le Pipeline en attente, non dupliqué sur les pages personnelles).
  // Comparaisons et calculs de durée en dates ISO "YYYY-MM-DD" (comparables lexicographiquement),
  // pour éviter tout décalage de fuseau horaire lié à l'instanciation d'objets Date à partir de
  // composants calendaires (piège classique — joursEntre() ci-dessus s'en protège déjà en fixant
  // l'heure à T00:00:00 ; on reste ici en pur ISO string pour ne pas avoir à y penser).
  function dernierJourMois(year, moIndex){
    const joursParMois = [31, ((+year%4===0 && +year%100!==0) || +year%400===0) ? 29 : 28, 31,30,31,30,31,31,30,31,30,31];
    return joursParMois[moIndex];
  }
  function pipelinePondereMensuel(year){
    const list = affaires.filter(a=>a.statut==="en commercialisation" && a.dateDebut && a.dateFin && a.dateFin>=a.dateDebut);
    const out = Array.from({length:12}, ()=>({ j:0, e:0 }));
    list.forEach(a=>{
      const totalDays = joursEntre(a.dateDebut, a.dateFin);
      if(totalDays<=0) return;
      const montantPondere = (a.budget||0) * (a.pctReussite||0)/100;
      const joursPondere = (a.jours||0) * (a.pctReussite||0)/100;
      const eParJour = montantPondere/totalDays, jParJour = joursPondere/totalDays;
      for(let mo=0; mo<12; mo++){
        const moStart = `${year}-${String(mo+1).padStart(2,"0")}-01`;
        const moEnd = `${year}-${String(mo+1).padStart(2,"0")}-${String(dernierJourMois(year,mo)).padStart(2,"0")}`;
        const start = a.dateDebut > moStart ? a.dateDebut : moStart;
        const end = a.dateFin < moEnd ? a.dateFin : moEnd;
        if(end >= start){
          const days = joursEntre(start, end);
          out[mo].j += jParJour*days;
          out[mo].e += eParJour*days;
        }
      }
    });
    return out;
  }

  function productionMensuelle(year, consultantId){
    const missionsEnCours = missions.filter(m=>m.statut==="en cours" && (!consultantId || m.consultantId===consultantId));
    const pipeline = consultantId ? null : pipelinePondereMensuel(year);
    const out = [];
    for(let mo=0; mo<12; mo++){
      const offset = (+year - today.getFullYear())*12 + (mo - today.getMonth());
      const futur = offset > 0;
      const monthKey = `${year}-${String(mo+1).padStart(2,"0")}`;
      let realJ = 0, realE = 0, nonFactJ = 0;
      saisies.filter(s=>s.type==="mission" && s.date.slice(0,7)===monthKey && (!consultantId || s.consultantId===consultantId)).forEach(s=>{
        const m = missions.find(mm=>mm.id===s.missionId);
        realJ += s.jFact;
        realE += m ? s.jFact*m.taux : 0;
        nonFactJ += s.jNonFact; // pas d'équivalent € : un jour non facturable n'a jamais de valeur de production.
      });
      let prevJ = 0, prevE = 0;
      if(futur){
        missionsEnCours.forEach(m=>{
          const rafJ = Math.max(0, m.enveloppe - joursFactConsommes(m.id));
          const v = missionProjectionValeurAt(m, rafJ, offset);
          if(v!==null){ prevJ += v; prevE += v*m.taux; }
        });
      }
      let pipeJ = 0, pipeE = 0;
      if(futur && pipeline){ pipeJ = pipeline[mo].j; pipeE = pipeline[mo].e; }
      out.push({ mois:mo, label:MOIS[mo], realJ, realE, prevJ, prevE, nonFactJ, pipeJ, pipeE, jours:realJ+prevJ, eur:realE+prevE, futur });
    }
    return out;
  }

  // --- Histogramme "Répartition complète des temps" (Société et Mes temps) ---
  // Empilé, en jours uniquement, 5 catégories (cahier des charges §7.2) : missions facturable
  // projeté (mois à venir, mêmes projections que l'histogramme de production), missions facturable
  // saisi, missions non facturable, temps internes (les 9 catégories fusionnées en une seule), et
  // absences. consultantId : null pour la vue société, ou un id de consultant pour restreindre à
  // ses seules saisies et à ses missions (vue « Mes temps », entre « Mes saisies » et « Suivi de mes
  // temps » — déplacé depuis « Ma page »).
  function repartitionMensuelle(year, consultantId){
    const missionsEnCours = missions.filter(m=>m.statut==="en cours" && (!consultantId || m.consultantId===consultantId));
    const out = [];
    for(let mo=0; mo<12; mo++){
      const offset = (+year - today.getFullYear())*12 + (mo - today.getMonth());
      const futur = offset > 0;
      const monthKey = `${year}-${String(mo+1).padStart(2,"0")}`;
      const moisSaisies = saisies.filter(s=>s.date.slice(0,7)===monthKey && (!consultantId || s.consultantId===consultantId));
      const factSaisi = moisSaisies.filter(s=>s.type==="mission").reduce((s,x)=>s+x.jFact,0);
      const nonFact = moisSaisies.filter(s=>s.type==="mission").reduce((s,x)=>s+x.jNonFact,0);
      const interne = moisSaisies.filter(s=>s.type==="interne").reduce((s,x)=>s+x.dureeJ,0);
      const absence = moisSaisies.filter(s=>s.type==="absence").reduce((s,x)=>s+x.dureeJ,0);
      let factProjete = 0;
      if(futur){
        missionsEnCours.forEach(m=>{
          const rafJ = Math.max(0, m.enveloppe - joursFactConsommes(m.id));
          const v = missionProjectionValeurAt(m, rafJ, offset);
          if(v!==null) factProjete += v;
        });
      }
      out.push({ mois:mo, label:MOIS[mo], factSaisi, factProjete, nonFact, interne, absence, futur });
    }
    return out;
  }

  // Ordre d'empilement du bas vers le haut, et couleurs, revus à la demande de l'utilisateur
  // (plus vives, réordonnées, gris conservé tel quel car jugé lisible en daltonisme) : absences
  // (rouge) → temps internes (jaune, même teinte que les bandeaux de titre) → missions non
  // facturable (gris) → missions facturable saisi (vert) → missions facturable projeté (hachuré
  // vert/beige, au sommet).
  const REPARTITION_CATS = [
    { key:"absence",     label:"Absences",                       kind:"solid", color:"var(--chart-red)" },
    { key:"interne",     label:"Temps internes",                 kind:"solid", color:"var(--panel-head-bg)" },
    { key:"nonFact",     label:"Missions non facturable",        kind:"solid", color:"var(--chart-grey)" },
    { key:"factSaisi",   label:"Missions facturable — saisi",    kind:"solid", color:"var(--brand-green-dark)" },
    { key:"factProjete", label:"Missions facturable — projeté",  kind:"hatch", color:null },
  ];

  // « Ma production de missions » (Ma page) : même principe d'empilement que REPARTITION_CATS
  // ci-dessus, réduit aux 3 catégories qui concernent une mission (pas d'absences ni de temps
  // internes ici — déjà couverts par « Répartition complète des temps » sur Mes temps). En jours
  // uniquement, comme REPARTITION_CATS : un jour non facturable n'a pas d'équivalent en €, la
  // logique de prévisionnel (RAF projeté, hachuré) ne s'applique qu'à la part facturable.
  const PRODUCTION_MISSIONS_CATS = [
    { key:"nonFactJ", label:"Missions non facturable",        kind:"solid", color:"var(--chart-grey)" },
    { key:"realJ",    label:"Missions facturable — saisi",    kind:"solid", color:"var(--brand-green-dark)" },
    { key:"prevJ",    label:"Missions facturable — projeté",  kind:"hatch", color:null },
  ];

  function renderRepartitionBarChart(hostId, patternId, data, year, cats, ariaLabel){
    cats = cats || REPARTITION_CATS;
    ariaLabel = ariaLabel || `Répartition complète des temps ${year}`;
    const host = document.getElementById(hostId);
    if(!host) return;
    const totals = data.map(d=>cats.reduce((s,c)=>s+d[c.key],0));
    const maxRaw = Math.max(0, ...totals);
    const max = maxRaw>0 ? maxRaw*1.15 : 1;

    const W=440, H=240, mL=40, mR=8, mT=12, mB=28;
    const plotW = W-mL-mR, plotH = H-mT-mB;
    const n = data.length;
    const barGap = 5;
    const barW = (plotW - barGap*(n-1))/n;
    const segGapPx = 2;

    let gridLines = "";
    const gridSteps = 4;
    for(let i=0;i<=gridSteps;i++){
      const v = max*i/gridSteps;
      const y = mT+plotH-(v/max)*plotH;
      const label = v.toLocaleString("fr-FR", { maximumFractionDigits: max<10 ? 1 : 0 });
      gridLines += `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${W-mR}" y2="${y.toFixed(1)}" class="chart-grid"/>`;
      gridLines += `<text x="${mL-8}" y="${(y+3).toFixed(1)}" class="chart-axis-label" text-anchor="end">${label}</text>`;
    }

    let bars = "";
    data.forEach((d,i)=>{
      const x = mL + i*(barW+barGap);
      const baseY = mT+plotH;
      // hauteurs de chaque segment visible (>0.3px), du bas vers le haut
      const heights = cats.map(c=>{
        const v = d[c.key];
        return max>0 ? (v/max)*plotH : 0;
      });
      const visible = heights.map(h=>h>0.3);
      const lastVisibleIdx = visible.lastIndexOf(true);

      let cursorY = baseY;
      let segs = "";
      heights.forEach((h,ci)=>{
        if(!visible[ci]) return;
        const isTop = ci===lastVisibleIdx;
        const gapAbove = ci===0 ? 0 : segGapPx;
        const hAdj = Math.max(0, h - gapAbove);
        const y = cursorY - gapAbove - hAdj;
        const cat = cats[ci];
        const fill = cat.kind==="hatch" ? `url(#${patternId})` : cat.color;
        const tip = `${cat.label} : ${jr(Math.round(d[cat.key]*10)/10)}`;
        segs += `<path d="${roundedTopBarPath(x, y, barW, hAdj, isTop?4:0)}" fill="${fill}" data-tip="${esc(tip)}"/>`;
        cursorY = y;
      });

      bars += `
        <g>
          ${segs}
          <text x="${(x+barW/2).toFixed(1)}" y="${H-mB+18}" class="chart-axis-label" text-anchor="middle">${d.label}</text>
        </g>`;
    });

    const legend = cats.map(c=>{
      const swatchStyle = c.kind==="hatch"
        ? `background-image:repeating-linear-gradient(45deg, var(--brand-green-dark) 0 2px, var(--chart-beige) 2px 6px);`
        : `background:${c.color};`;
      return `<div class="chart-summary-item"><span class="chart-swatch" style="${swatchStyle}"></span>${c.label}</div>`;
    }).join("");

    host.innerHTML = `
      <div class="chart-summary chart-legend-wrap">${legend}</div>
      <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="${ariaLabel}">
        <defs>
          <pattern id="${patternId}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--chart-beige)"/>
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--brand-green-dark)" stroke-width="2.5"/>
          </pattern>
        </defs>
        ${gridLines}
        ${bars}
      </svg>
    `;
    wireChartTooltips(host);
  }

  function renderRepartitionChart(hostId, patternId, year, consultantId){
    renderRepartitionBarChart(hostId, patternId, repartitionMensuelle(year, consultantId), year);
  }

  // --- Graphique de répartition des temps (camembert/donut) — Société et Mes temps (déplacé depuis Ma page) ---
  // À l'année, sur les temps saisis à ce jour (pas de projection ici), absences exclues (cahier
  // des charges §7.2). 8 catégories : Production facturable / non facturable (missions), puis les
  // 9 catégories de temps internes regroupées en 5 groupes (+ « Autres » par défaut pour toute
  // catégorie qui ne serait dans aucun des 5 groupes ci-dessous — vide avec le jeu de catégories
  // actuel, mais prévu pour rester correct si de nouvelles catégories sont créées).
  const REPARTITION_GROUPES_INTERNES = [
    { key:"commercial",  label:"Commercial",                                   codes:["AO","PRO","PART"], color:"var(--chart-yellow-3)" },
    { key:"admin",       label:"Administratif / Gestion",                      codes:["ADM"],             color:"var(--chart-yellow-5)" },
    { key:"outillages",  label:"Outillages, Veille/Méthodologies, Formation",  codes:["OUT","VEI","FORM"],color:"var(--chart-yellow-2)" },
    { key:"reunions",    label:"Réunions internes",                            codes:["REU"],             color:"var(--chart-yellow-4)" },
    { key:"rd",          label:"R&D",                                          codes:["RD"],              color:"var(--chart-yellow-6)" },
  ];
  const REPARTITION_CODES_CONNUS = REPARTITION_GROUPES_INTERNES.flatMap(g=>g.codes);

  function repartitionAnnuelle(year, consultantId){
    const annee = saisies.filter(s=>s.date.slice(0,4)===year && (!consultantId || s.consultantId===consultantId));
    const missionsS = annee.filter(s=>s.type==="mission");
    const factFacturable = missionsS.reduce((s,x)=>s+x.jFact,0);
    const factNonFacturable = missionsS.reduce((s,x)=>s+x.jNonFact,0);

    const internes = annee.filter(s=>s.type==="interne");
    const groupes = REPARTITION_GROUPES_INTERNES.map(g=>({
      label: g.label, color: g.color,
      value: internes.filter(s=>g.codes.includes(s.categorie)).reduce((s,x)=>s+x.dureeJ,0),
    }));
    const autres = internes.filter(s=>!REPARTITION_CODES_CONNUS.includes(s.categorie)).reduce((s,x)=>s+x.dureeJ,0);

    return [
      { label:"Production facturable",     color:"var(--brand-green-dark)", value:factFacturable },
      { label:"Production non facturable", color:"var(--chart-grey)",       value:factNonFacturable },
      ...groupes,
      { label:"Autres",                    color:"var(--chart-yellow-1)",   value:autres },
    ].filter(d=>d.value>0.05);
  }

  function polarPoint(cx, cy, r, angleDeg){
    const rad = (angleDeg-90) * Math.PI/180;
    return { x: cx + r*Math.cos(rad), y: cy + r*Math.sin(rad) };
  }

  function donutSlicePath(cx, cy, rOuter, rInner, startDeg, endDeg){
    const largeArc = (endDeg-startDeg) > 180 ? 1 : 0;
    const o1 = polarPoint(cx, cy, rOuter, startDeg);
    const o2 = polarPoint(cx, cy, rOuter, endDeg);
    const i1 = polarPoint(cx, cy, rInner, endDeg);
    const i2 = polarPoint(cx, cy, rInner, startDeg);
    return `M${o1.x.toFixed(2)},${o1.y.toFixed(2)} A${rOuter},${rOuter} 0 ${largeArc} 1 ${o2.x.toFixed(2)},${o2.y.toFixed(2)} L${i1.x.toFixed(2)},${i1.y.toFixed(2)} A${rInner},${rInner} 0 ${largeArc} 0 ${i2.x.toFixed(2)},${i2.y.toFixed(2)} Z`;
  }

  // Cœur de tracé commun aux trois donuts (renderDonutChart, renderFraisDonutChart,
  // renderCommercialDonutChart) : mêmes dimensions, mêmes secteurs, même légende, même infobulle.
  // L'appelant prépare `data` ([{label,value,color}]) puis fournit via opts les seules parties qui
  // varient : le texte d'infobulle par secteur (opts.tip(d)), le total central (opts.centerTotal(total)),
  // le sous-titre central (opts.centerCaption), le message "vide" (opts.emptyLabel) et l'aria-label
  // du <svg> (opts.ariaLabel). Les valeurs déjà destinées à esc() (caption/ariaLabel des frais) sont
  // passées pré-échappées, comme dans le code d'origine.
  function drawDonut(host, data, opts){
    const total = data.reduce((s,d)=>s+d.value,0);

    const W=260, H=260, cx=130, cy=130, rOuter=104, rInner=58;
    const gapDeg = total>0 ? 1.4 : 0;

    let slices = "";
    if(total>0){
      let angle = 0;
      data.forEach(d=>{
        const sweep = (d.value/total)*360;
        const start = angle + gapDeg/2;
        const end = angle + sweep - gapDeg/2;
        if(end>start){
          const tip = opts.tip(d);
          slices += `<path d="${donutSlicePath(cx,cy,rOuter,rInner,start,end)}" fill="${d.color}" data-tip="${esc(tip)}"></path>`;
        }
        angle += sweep;
      });
    }

    const centerLabel = total>0
      ? `<text x="${cx}" y="${cy-4}" text-anchor="middle" class="chart-donut-total">${opts.centerTotal(total)}</text>
         <text x="${cx}" y="${cy+16}" text-anchor="middle" class="chart-donut-caption">${opts.centerCaption}</text>`
      : `<text x="${cx}" y="${cy}" text-anchor="middle" class="chart-donut-caption">${opts.emptyLabel}</text>`;

    const legend = data.map(d=>{
      const pct = total>0 ? Math.round((d.value/total)*100) : 0;
      return `<div class="chart-summary-item"><span class="chart-swatch" style="background:${d.color};"></span>${d.label} <strong>${pct}%</strong></div>`;
    }).join("");

    host.innerHTML = `
      <div class="chart-donut-wrap">
        <svg viewBox="0 0 ${W} ${H}" class="chart-svg chart-donut-svg" role="img" aria-label="${opts.ariaLabel}">
          ${slices}
          ${centerLabel}
        </svg>
        <div class="chart-summary chart-legend-wrap chart-donut-legend">${legend}</div>
      </div>
    `;
    wireChartTooltips(host);
  }

  function renderDonutChart(hostId, year, consultantId){
    const host = document.getElementById(hostId);
    if(!host) return;
    const data = repartitionAnnuelle(year, consultantId);
    drawDonut(host, data, {
      tip: d=>`${d.label} : ${jr(Math.round(d.value*10)/10)}`,
      centerTotal: total=>jr(Math.round(total*10)/10),
      centerCaption: `saisis ${year}`,
      emptyLabel: "Aucune donnée",
      ariaLabel: `Répartition des temps ${year}`,
    });
  }

  // Donut générique pour les répartitions de frais (montants en euros, pas en jours) — même anatomie
  // que renderDonutChart ci-dessus (secteurs, total central, légende), réutilisé pour les deux donuts
  // « Frais non refacturables » (Mes frais et Cabinet > Frais, voir plus bas).
  function renderFraisDonutChart(hostId, data, opts){
    const host = document.getElementById(hostId);
    if(!host) return;
    opts = opts || {};
    drawDonut(host, data, {
      tip: d=>`${d.label} : ${euroCents(d.value)}`,
      centerTotal: total=>euroCompact(total),
      centerCaption: esc(opts.caption||""),
      emptyLabel: "Aucun frais non refacturable",
      ariaLabel: esc(opts.ariaLabel||"Répartition des frais non refacturables"),
    });
  }

  // --- Infobulle personnalisée pour les graphiques (remplace les <title> natifs, peu fiables
  // et trop lents à apparaître) — un seul texte concis par segment/part survolé(e), suit la souris.
  let chartTooltipEl = null;
  function ensureChartTooltip(){
    if(!chartTooltipEl){
      chartTooltipEl = document.createElement("div");
      chartTooltipEl.className = "chart-tooltip";
      document.body.appendChild(chartTooltipEl);
    }
    return chartTooltipEl;
  }
  function positionChartTooltip(evt){
    if(!chartTooltipEl || !chartTooltipEl.classList.contains("show")) return;
    const pad = 14;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    const r = chartTooltipEl.getBoundingClientRect();
    if(x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
    if(y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
    chartTooltipEl.style.left = x + "px";
    chartTooltipEl.style.top = y + "px";
  }
  function showChartTooltip(evt, text){
    const el = ensureChartTooltip();
    el.textContent = text;
    el.classList.add("show");
    positionChartTooltip(evt);
  }
  function hideChartTooltip(){
    if(chartTooltipEl) chartTooltipEl.classList.remove("show");
  }
  // attache l'infobulle à chaque élément [data-tip] trouvé dans le graphique tout juste rendu
  function wireChartTooltips(host){
    hideChartTooltip();
    host.querySelectorAll("[data-tip]").forEach(el=>{
      el.addEventListener("mouseenter", e=>showChartTooltip(e, el.dataset.tip));
      el.addEventListener("mousemove", positionChartTooltip);
      el.addEventListener("mouseleave", hideChartTooltip);
    });
  }

  // état du sélecteur Jours/€ du graphique Société, persistant tant que la page reste ouverte — plus
  // de bascule côté Ma page depuis que « Ma production de missions » empile aussi le non facturable
  // (sans équivalent €, ce graphique reste désormais toujours en jours, voir renderProductionChartMoi).
  let productionChartMetric = "jours";
  // affichage ou non de la 3ᵉ couche "Pipeline pondéré" (Société uniquement) — hypothétique, donc
  // masquable à la demande de l'utilisateur ; affichée par défaut. Persistant tant que la page reste ouverte.
  let showPipelineLayer = true;

  // chemin SVG d'un rectangle à coins arrondis en haut seulement, ancré à la base
  function roundedTopBarPath(x, y, w, h, r){
    if(h<=0) return "";
    const rr = Math.max(0, Math.min(r, h, w/2));
    return `M${x},${y+h} L${x},${y+rr} Q${x},${y} ${x+rr},${y} L${x+w-rr},${y} Q${x+w},${y} ${x+w},${y+rr} L${x+w},${y+h} Z`;
  }

  // Rendu générique de l'histogramme empilé réalisé/prévisionnel — réutilisé par la vue Société
  // (toutes les missions) et la vue Ma page (missions du seul consultant connecté). Une 3ᵉ couche
  // optionnelle, "Pipeline pondéré", s'empile au sommet (Société uniquement, pipelinePatternId
  // fourni) : elle représente l'estimation de charge complémentaire si les affaires encore en
  // commercialisation se concrétisent, étalée sur leur fenêtre prévisionnelle (dateDebut→dateFin).
  function renderProductionBarChart(hostId, patternId, data, metric, year, pipelinePatternId){
    const host = document.getElementById(hostId);
    if(!host) return;
    const values = data.map(d=>{
      const base = metric==="jours" ? d.jours : d.eur;
      const pipe = pipelinePatternId ? (metric==="jours" ? (d.pipeJ||0) : (d.pipeE||0)) : 0;
      return base + pipe;
    });
    const maxRaw = Math.max(0, ...values);
    const max = maxRaw>0 ? maxRaw*1.15 : 1;

    const W=440, H=240, mL=48, mR=8, mT=12, mB=28;
    const plotW = W-mL-mR, plotH = H-mT-mB;
    const n = data.length;
    const barGap = 5;
    const barW = (plotW - barGap*(n-1))/n;

    let gridLines = "";
    const gridSteps = 4;
    for(let i=0;i<=gridSteps;i++){
      const v = max*i/gridSteps;
      const y = mT+plotH-(v/max)*plotH;
      const label = metric==="jours"
        ? v.toLocaleString("fr-FR", { maximumFractionDigits: max<10 ? 1 : 0 })
        : euroCompact(v);
      gridLines += `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${W-mR}" y2="${y.toFixed(1)}" class="chart-grid"/>`;
      gridLines += `<text x="${mL-8}" y="${(y+3).toFixed(1)}" class="chart-axis-label" text-anchor="end">${label}</text>`;
    }

    let bars = "";
    data.forEach((d,i)=>{
      const realV = metric==="jours" ? d.realJ : d.realE;
      const prevV = metric==="jours" ? d.prevJ : d.prevE;
      const pipeV = pipelinePatternId ? (metric==="jours" ? (d.pipeJ||0) : (d.pipeE||0)) : 0;
      const realH = max>0 ? (realV/max)*plotH : 0;
      const prevHraw = max>0 ? (prevV/max)*plotH : 0;
      const segGap1 = (realH>1 && prevHraw>1) ? 2 : 0;
      const prevH = Math.max(0, prevHraw - segGap1);
      const pipeHraw = max>0 ? (pipeV/max)*plotH : 0;
      const belowH = realH + segGap1 + prevH;
      const segGap2 = (belowH>1 && pipeHraw>1) ? 2 : 0;
      const pipeH = Math.max(0, pipeHraw - segGap2);
      const x = mL + i*(barW+barGap);
      const baseY = mT+plotH;
      const realY = baseY - realH;
      const prevY = realY - segGap1 - prevH;
      const pipeY = baseY - belowH - segGap2 - pipeH;

      let segs = "";
      if(realH>0.3){
        const rTop = (prevH>0.3 || pipeH>0.3) ? 0 : 4;
        const tipReal = `Réalisé : ${jr(Math.round(d.realJ*10)/10)} · ${euro(Math.round(d.realE))}`;
        segs += `<path d="${roundedTopBarPath(x, realY, barW, realH, rTop)}" fill="var(--brand-green)" data-tip="${esc(tipReal)}"/>`;
      }
      if(prevH>0.3){
        const rTop = pipeH>0.3 ? 0 : 4;
        const tipPrev = `Prévisionnel : ${jr(Math.round(d.prevJ*10)/10)} · ${euro(Math.round(d.prevE))}`;
        segs += `<path d="${roundedTopBarPath(x, prevY, barW, prevH, rTop)}" fill="url(#${patternId})" data-tip="${esc(tipPrev)}"/>`;
      }
      if(pipeH>0.3){
        const tipPipe = `Pipeline pondéré : ${jr(Math.round(d.pipeJ*10)/10)} · ${euro(Math.round(d.pipeE))}`;
        segs += `<path d="${roundedTopBarPath(x, pipeY, barW, pipeH, 4)}" fill="url(#${pipelinePatternId})" data-tip="${esc(tipPipe)}"/>`;
      }
      bars += `
        <g>
          ${segs}
          <text x="${(x+barW/2).toFixed(1)}" y="${H-mB+18}" class="chart-axis-label" text-anchor="middle">${d.label}</text>
        </g>`;
    });

    const sum = key => data.reduce((s,d)=>s+d[key],0);
    const totRealJ = sum("realJ"), totRealE = sum("realE");
    const totPrevJ = sum("prevJ"), totPrevE = sum("prevE");
    const totPipeJ = sum("pipeJ"), totPipeE = sum("pipeE");
    const fmtTot = (j,e) => metric==="jours" ? jr(Math.round(j*10)/10) : euro(Math.round(e));

    const pipeDefs = pipelinePatternId ? `
          <pattern id="${pipelinePatternId}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--panel-head-bg)" opacity=".55"/>
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--ocre-deep)" stroke-width="2"/>
          </pattern>` : "";
    const pipeSummary = pipelinePatternId ? `
        <div class="chart-summary-item"><span class="chart-swatch chart-swatch-pipeline"></span>Pipeline pondéré : <strong>${fmtTot(totPipeJ, totPipeE)}</strong></div>` : "";

    host.innerHTML = `
      <div class="chart-summary">
        <div class="chart-summary-item"><span class="chart-swatch chart-swatch-realise"></span>Réalisé ${year} : <strong>${fmtTot(totRealJ, totRealE)}</strong></div>
        <div class="chart-summary-item"><span class="chart-swatch chart-swatch-prevision"></span>Prévisionnel ${year} : <strong>${fmtTot(totPrevJ, totPrevE)}</strong></div>${pipeSummary}
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Production facturable mensuelle ${year}">
        <defs>
          <pattern id="${patternId}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--brand-green)" opacity=".28"/>
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--accent-strong)" stroke-width="2"/>
          </pattern>${pipeDefs}
        </defs>
        ${gridLines}
        ${bars}
      </svg>
    `;
    wireChartTooltips(host);
  }

  function renderProductionChart(year){
    renderProductionBarChart("chart-production-societe", "hatch-prevision-societe", productionMensuelle(year, null), productionChartMetric, year, showPipelineLayer ? "hatch-pipeline-societe" : null);
  }

  // « Ma production de missions » : facturable (saisi + projeté, logique de prévisionnel inchangée)
  // et non facturable, empilés — en jours uniquement (voir PRODUCTION_MISSIONS_CATS ci-dessus).
  function renderProductionChartMoi(year){
    renderRepartitionBarChart("chart-production-moi", "hatch-prevision-moi", productionMensuelle(year, currentUser), year, PRODUCTION_MISSIONS_CATS, `Ma production de missions ${year}`);
  }

  function wireProductionChartToggle(){
    const wrap = document.getElementById("chart-metric-toggle");
    if(!wrap || wrap.dataset.wired) return;
    wrap.dataset.wired = "1";
    wrap.querySelectorAll(".chip").forEach(chip=>{
      chip.addEventListener("click", ()=>{
        productionChartMetric = chip.dataset.metric;
        wrap.querySelectorAll(".chip").forEach(c=>c.classList.toggle("on", c===chip));
        renderProductionChart(document.getElementById("select-annee-societe").value);
      });
    });
  }

  // Bouton unique (case à cocher visuelle) qui affiche ou masque la 3ᵉ couche "Pipeline pondéré",
  // par nature hypothétique — l'utilisateur doit pouvoir la retirer d'un clic.
  function wireProductionPipelineToggle(){
    const btn = document.getElementById("chart-pipeline-toggle");
    if(!btn || btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", ()=>{
      showPipelineLayer = !showPipelineLayer;
      btn.classList.toggle("on", showPipelineLayer);
      renderProductionChart(document.getElementById("select-annee-societe").value);
    });
  }

  function renderSelectAnneeMoiChart(){
    const sel = document.getElementById("select-annee-moi-chart");
    const years = Array.from(new Set(saisies.filter(s=>s.consultantId===currentUser).map(s=>s.date.slice(0,4)))).sort().reverse();
    populateAnneeSelect(sel, years, ()=>{
      renderProductionChartMoi(sel.value);
    }, { extraYear: anneeSuivanteActivable(today.getMonth()) ? String(CURRENT_YEAR+1) : null });
  }

  function renderSociete(){
    const year = document.getElementById("select-annee-societe").value;

    const actifs = consultants.filter(c=>consultantPresentSurAnnee(c, year));
    const etpTotal = consultants.reduce((s,c)=>s+computeConsultantETP(c, year),0);
    const saisiesYear = saisies.filter(s=>s.date.slice(0,4)===year);
    const jFactTotal = saisiesYear.reduce((s,x)=>s+x.jFact,0);
    const caTotal = saisiesYear.filter(s=>s.type==="mission").reduce((sum,s)=>{
      const m = missions.find(mm=>mm.id===s.missionId);
      return sum + (m ? s.jFact*m.taux : 0);
    },0);
    const jTotalSaisi = saisiesYear.reduce((s,x)=>s+x.dureeJ,0);
    const jAbsencesTotal = saisiesYear.filter(s=>s.type==="absence").reduce((s,x)=>s+x.dureeJ,0);
    const jDispoTotal = Math.max(0, jTotalSaisi - jAbsencesTotal);
    const tauxChargeGlobal = jDispoTotal>0 ? Math.round((jFactTotal/jDispoTotal)*100) : 0;
    const gaugeLevel = tauxChargeGlobal>120 ? "danger" : (tauxChargeGlobal>100 ? "warn" : "good");
    const gaugeColorVar = { good:"var(--brand-green)", warn:"#e9b350", danger:"#ef7a63" }[gaugeLevel];
    const jNonFactMissionTotal = saisiesYear.filter(s=>s.type==="mission").reduce((s,x)=>s+x.jNonFact,0);
    const jVendusMissionsTotal = missions.reduce((s,m)=>s+m.enveloppe,0);
    const tauxNonFactTotal = jVendusMissionsTotal>0 ? Math.round((jNonFactMissionTotal/jVendusMissionsTotal)*100) : 0;
    const tjmMoyen = jFactTotal>0 ? caTotal/jFactTotal : 0;

    document.getElementById("societe-kpis").innerHTML = `
      <div class="kpi kpi-hero kpi-combo">
        <div class="kpi-label">Effectifs</div>
        <div class="kpi-combo-row">
          <div class="kpi-combo-item"><div class="kpi-combo-value">${actifs.length}</div><div class="kpi-combo-sub">personne${actifs.length>1?"s":""} ${year}</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${etpTotal.toLocaleString("fr-FR",{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div class="kpi-combo-sub">ETP ${year}</div></div>
        </div>
      </div>
      <div class="kpi kpi-hero kpi-combo">
        <div class="kpi-label">Production ${year}</div>
        <div class="kpi-combo-row">
          <div class="kpi-combo-item"><div class="kpi-combo-value">${euro(caTotal)}</div><div class="kpi-combo-sub">produits</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${jr(jFactTotal)}</div><div class="kpi-combo-sub">facturables</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${euro(Math.round(tjmMoyen))}</div><div class="kpi-combo-sub">TJM moyen</div></div>
        </div>
      </div>
      <div class="kpi kpi-hero"><div class="kpi-label">% non facturable (missions)</div><div class="kpi-value">${tauxNonFactTotal}<small>%</small></div></div>
      <div class="kpi kpi-hero kpi-gauge">
        <div class="kpi-label">Taux de charge global ${year}</div>
        <div class="gauge-wrap">
          <div class="gauge" style="--pct:${Math.min(100,tauxChargeGlobal)};--gauge-color:${gaugeColorVar};">
            <div class="gauge-value">${tauxChargeGlobal}%</div>
          </div>
          <div class="gauge-note">${jr(jFactTotal)} facturables<br>/ ${jr(jDispoTotal)} saisis (hors absences)</div>
        </div>
      </div>
    `;

    // ----- Effectifs ----- (n'affiche que les consultants présents sur l'année sélectionnée —
    // même règle que la tuile "Effectifs" ci-dessus ; historique complet dans Cabinet > Consultants)
    const consList = consultants.filter(c=>consultantPresentSurAnnee(c, year)).map(c=>({ ...c, _stats: computeConsultantAnnee(c, year), _etp: computeConsultantETP(c, year) }));
    const consCols = [
      { key:"nom", label:"Consultant", get:c=>c.nom },
      { key:"statut", label:"Statut", filterable:true, get:c=>c.statut },
      { key:"etp", label:`ETP ${year}`, numeric:true, get:c=>c._etp },
      { key:"tjmObjectif", label:"TJM objectif", numeric:true, get:c=>c.tjmBase },
      { key:"tjmVendu", label:"TJM vendu", numeric:true, get:c=>c._stats.tjmVendu ?? -1 },
      { key:"tjmReel", label:"TJM réel", numeric:true, get:c=>c._stats.tjmReel ?? -1 },
      { key:"affaires", label:"Affaires en production", numeric:true, get:c=>c._stats.nbAffairesEnCours },
      { key:"jfact", label:`Jours facturables ${year}`, numeric:true, get:c=>c._stats.jFact },
      { key:"charge", label:`Taux de charge ${year}`, numeric:true, get:c=>c._stats.tauxCharge },
      { key:"production", label:`Production ${year}`, numeric:true, get:c=>c._stats.production },
    ];
    const consRowHTML = c => `<tr>
        <td class="affaire-name">${esc(c.nom)}${c.admin?`<span class="sub">Administrateur</span>`:""}</td>
        <td>${consultantStatutPill(c.statut)}</td>
        <td class="num">${etpFmt(c._etp)}</td>
        <td class="num">${euro(c.tjmBase)}</td>
        <td class="num">${c._stats.tjmVendu!==null ? euro(Math.round(c._stats.tjmVendu)) : "—"}</td>
        <td class="num">${c._stats.tjmReel!==null ? euro(Math.round(c._stats.tjmReel)) : "—"}</td>
        <td class="num">${c._stats.nbAffairesEnCours}</td>
        <td class="num">${jr(c._stats.jFact)}</td>
        <td class="num">${c._stats.tauxCharge}%</td>
        <td class="num">${euro(c._stats.production)}</td>
      </tr>`;
    renderSortFilterTable("table-effectifs", consList, consCols, consRowHTML, {
      rerender: renderSociete,
      emptyMsg: "Aucun consultant.",
      tfoot: display => {
        const sumProd = display.reduce((s,c)=>s+c._stats.production,0);
        const sumJFact = display.reduce((s,c)=>s+c._stats.jFact,0);
        const sumJoursMission = display.reduce((s,c)=>s+c._stats.joursMission,0);
        const sumEtp = display.reduce((s,c)=>s+c._etp,0);
        const tjmVenduMoyen = sumJFact>0 ? euro(Math.round(sumProd/sumJFact)) : "—";
        const tjmReelMoyen = sumJoursMission>0 ? euro(Math.round(sumProd/sumJoursMission)) : "—";
        return `<tfoot><tr>
          <td colspan="2">Total (${display.length} consultant${display.length>1?"s":""})</td>
          <td class="num">${etpFmt(sumEtp)}</td>
          <td class="num">—</td>
          <td class="num">${tjmVenduMoyen}</td>
          <td class="num">${tjmReelMoyen}</td>
          <td class="num">${display.reduce((s,c)=>s+c._stats.nbAffairesEnCours,0)}</td>
          <td class="num">${jr(sumJFact)}</td>
          <td class="num">—</td>
          <td class="num">${euro(sumProd)}</td>
        </tr></tfoot>`;
      },
    });

    // ----- Production par affaire -----
    const affList = affaires.map(a=>{
      const ca = caRealiseAffaire(a.id, year);
      const pct = a.budget>0 ? Math.round((ca/a.budget)*100) : 0;
      return { ...a, _ca:ca, _pct:pct };
    });
    const affCols = [
      { key:"nom", label:"Affaire", get:a=>a.nom },
      { key:"client", label:"Client", filterable:true, get:a=>orgName(a.organisationId) },
      { key:"statut", label:"Statut", filterable:true, get:a=>a.statut },
      { key:"pilote", label:"Pilote", filterable:true, get:a=>consultantName(a.pilote) },
      { key:"budget", label:"Budget vendu", numeric:true, get:a=>a.budget },
      { key:"ca", label:`Production réalisée ${year}`, numeric:true, get:a=>a._ca },
      { key:"pct", label:"% réalisé", numeric:true, get:a=>a._pct },
    ];
    const affRowHTML = a => `<tr class="row-clickable" data-id="${a.id}" style="cursor:pointer;">
        <td class="affaire-name">${esc(a.nom)}</td>
        <td>${esc(orgName(a.organisationId))}</td>
        <td>${statutPill(a.statut)}</td>
        <td>${esc(consultantName(a.pilote))}</td>
        <td class="num">${euro(a.budget)}</td>
        <td class="num">${euro(a._ca)}</td>
        <td class="num">${a._pct}%</td>
      </tr>`;
    renderSortFilterTable("table-ca-affaires", affList, affCols, affRowHTML, {
      rerender: renderSociete,
      emptyMsg: "Aucune affaire.",
      afterRender: table => table.querySelectorAll("tr[data-id]").forEach(tr=>{
        tr.addEventListener("click", ()=>openAffaireDetail(tr.dataset.id));
      }),
      tfoot: display => {
        const sumBudget = display.reduce((s,a)=>s+a.budget,0);
        const sumCa = display.reduce((s,a)=>s+a._ca,0);
        const pct = sumBudget>0 ? Math.round((sumCa/sumBudget)*100) : 0;
        return `<tfoot><tr>
          <td colspan="4">Total (${display.length} affaire${display.length>1?"s":""})</td>
          <td class="num">${euro(sumBudget)}</td>
          <td class="num">${euro(sumCa)}</td>
          <td class="num">${pct}%</td>
        </tr></tfoot>`;
      },
    });

    // ----- Production facturable — vue mensuelle (histogramme) -----
    wireProductionChartToggle();
    wireProductionPipelineToggle();
    renderProductionChart(year);

    // ----- Répartition complète des temps — vue mensuelle (histogramme) -----
    renderRepartitionChart("chart-repartition-societe", "hatch-repartition-societe", year, null);

    // ----- Répartition des temps — vue annuelle (camembert) -----
    renderDonutChart("chart-donut-societe", year, null);

    // ----- Suivi des temps (agrégé société) -----
    renderSuiviTempsSociete(year);
  }

  /* ================= Frais (cabinet) ================= */
  // Un frais est affecté soit à une affaire (affaireId), soit à un temps interne
  // (categorieTempsInterne, un code de tempsInternes — jamais une absence, exclue du choix) : les
  // deux champs sont mutuellement exclusifs, l'un des deux est toujours renseigné. "Refacturable"
  // n'a de sens que pour un frais affecté à une affaire (c'est ce qui l'impute sur son budget Frais
  // Cabinet) : toujours false pour un frais interne.
  function fraisCibleLabel(n){
    if(n.affaireId) return affaires.find(a=>a.id===n.affaireId)?.nom || "—";
    if(n.categorieTempsInterne) return `Interne — ${tempsInternes.find(t=>t.code===n.categorieTempsInterne)?.label || n.categorieTempsInterne}`;
    return "—";
  }
  // Taux et montant d'une ligne de TVA (n° 0-indexé) d'une note de frais, sur la page Frais du
  // cabinet — une note peut cumuler jusqu'à MAX_LIGNES_FRAIS taux différents (ex. restaurant).
  // Deux colonnes distinctes (taux / montant), aussi bien à l'écran que dans l'export CSV, pour
  // rester exploitables telles quelles par le comptable.
  function fraisLigneTauxCell(n, idx){
    const l = (n.lignesTVA||[])[idx];
    return l ? `${l.tauxTVA.toLocaleString("fr-FR")} %` : "—";
  }
  function fraisLigneMontantTVACell(n, idx){
    const l = (n.lignesTVA||[])[idx];
    return l ? euroCents(l.montantTVA) : "—";
  }
  // Équivalents pour l'export CSV : valeurs numériques brutes (pas de "%"/"€"), vides quand la note
  // n'a pas de ligne à cet index — exploitable directement par un tableur.
  function fraisLigneTauxCSV(n, idx){
    const l = (n.lignesTVA||[])[idx];
    return l ? l.tauxTVA : "";
  }
  function fraisLigneMontantTVACSV(n, idx){
    const l = (n.lignesTVA||[])[idx];
    return l ? l.montantTVA : "";
  }

  // Totaux mensuels des frais (montant TTC), pour une année donnée, refacturable vs non refacturable.
  function fraisMensuel(year){
    const out = MOIS.map(label => ({ label, refTTC:0, nonRefTTC:0 }));
    notesFrais.filter(n=>n.date.slice(0,4)===year).forEach(n=>{
      const mo = +n.date.slice(5,7) - 1;
      if(n.refacturable) out[mo].refTTC += n.montantTTC; else out[mo].nonRefTTC += n.montantTTC;
    });
    return out;
  }

  // Histogramme empilé "Frais par mois" — refacturable (vert cabinet) / non refacturable (gris-bleu,
  // même couleur que "non facturable" ailleurs dans l'outil, pour rester cohérent visuellement).
  function renderFraisBarChart(hostId, data, year){
    const host = document.getElementById(hostId);
    if(!host) return;
    const totals = data.map(d=>d.refTTC + d.nonRefTTC);
    const maxRaw = Math.max(0, ...totals);
    const max = maxRaw>0 ? maxRaw*1.15 : 1;

    // W proche de la largeur réellement affichée (ce graphique vit désormais toujours dans une colonne
    // à moitié de page, sur Cabinet > Frais) : les libellés d'axe restent lisibles à taille normale
    // (ils sont en unités du viewBox, donc minuscules à l'écran si W est bien plus grand que le rendu
    // réel). H choisi pour que le graphique s'arrête sensiblement à la hauteur de la légende « R&D »
    // du donut voisin, plutôt que de s'étirer jusqu'en bas du panneau des 2 donuts.
    const W=520, H=495, mL=56, mR=8, mT=12, mB=28;
    const plotW = W-mL-mR, plotH = H-mT-mB;
    const n = data.length;
    const barGap = 6;
    const barW = (plotW - barGap*(n-1))/n;

    let gridLines = "";
    const gridSteps = 4;
    for(let i=0;i<=gridSteps;i++){
      const v = max*i/gridSteps;
      const y = mT+plotH-(v/max)*plotH;
      gridLines += `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${W-mR}" y2="${y.toFixed(1)}" class="chart-grid"/>`;
      gridLines += `<text x="${mL-8}" y="${(y+3).toFixed(1)}" class="chart-axis-label" text-anchor="end">${euroCompact(v)}</text>`;
    }

    let bars = "";
    data.forEach((d,i)=>{
      const refH = max>0 ? (d.refTTC/max)*plotH : 0;
      const nonRefHraw = max>0 ? (d.nonRefTTC/max)*plotH : 0;
      const segGap = (refH>1 && nonRefHraw>1) ? 2 : 0;
      const nonRefH = Math.max(0, nonRefHraw - segGap);
      const x = mL + i*(barW+barGap);
      const baseY = mT+plotH;
      const refY = baseY - refH;
      const nonRefY = refY - segGap - nonRefH;

      let segs = "";
      if(refH>0.3){
        const rTop = nonRefH>0.3 ? 0 : 4;
        const tip = `Refacturable : ${euroCents(d.refTTC)}`;
        segs += `<path d="${roundedTopBarPath(x, refY, barW, refH, rTop)}" fill="var(--brand-green)" data-tip="${esc(tip)}"/>`;
      }
      if(nonRefH>0.3){
        const tip = `Non refacturable : ${euroCents(d.nonRefTTC)}`;
        segs += `<path d="${roundedTopBarPath(x, nonRefY, barW, nonRefH, 4)}" fill="var(--chart-grey)" data-tip="${esc(tip)}"/>`;
      }
      bars += `
        <g>
          ${segs}
          <text x="${(x+barW/2).toFixed(1)}" y="${H-mB+18}" class="chart-axis-label" text-anchor="middle">${d.label}</text>
        </g>`;
    });

    const totalRef = data.reduce((s,d)=>s+d.refTTC,0);
    const totalNonRef = data.reduce((s,d)=>s+d.nonRefTTC,0);

    host.innerHTML = `
      <div class="chart-summary">
        <div class="chart-summary-item"><span class="chart-swatch" style="background:var(--brand-green);"></span>Refacturable ${year} : <strong>${euroCents(totalRef)}</strong></div>
        <div class="chart-summary-item"><span class="chart-swatch" style="background:var(--chart-grey);"></span>Non refacturable ${year} : <strong>${euroCents(totalNonRef)}</strong></div>
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Frais mensuels ${year}, refacturable et non refacturable">
        ${gridLines}
        ${bars}
      </svg>
    `;
    wireChartTooltips(host);
  }

  // --- Répartition des frais NON refacturables (donuts "Mes frais" et Cabinet > Frais) ---
  // Donut « par grande catégorie » : regroupe categoriesFrais par sa colonne categorie (6 valeurs
  // fixes) — couleurs affectées dans l'ordre de définition des catégories, jamais recalculées selon
  // les montants (une catégorie garde toujours la même couleur, qu'elle soit petite ou grande).
  const FRAIS_CATEGORIE_COLORS = {
    "Hébergement":                "var(--chart-yellow-2)",
    "Restauration":               "var(--chart-yellow-4)",
    "Déplacement":                "var(--brand-green-dark)",
    "Achats":                     "var(--chart-grey)",
    "Communication et Marketing": "var(--brand-ocre)",
    "Frais administratifs":       "var(--chart-yellow-6)",
  };
  const FRAIS_GRANDES_CATEGORIES = Array.from(new Set(categoriesFrais.map(c=>c.categorie)));

  function fraisNonRefCategorieData(rows){
    const nonRef = rows.filter(n=>!n.refacturable);
    return FRAIS_GRANDES_CATEGORIES.map(cat=>({
      label: cat,
      color: FRAIS_CATEGORIE_COLORS[cat] || "var(--chart-grey)",
      value: nonRef.filter(n=>categorieFraisById(n.categorieFraisId)?.categorie===cat).reduce((s,n)=>s+n.montantTTC,0),
    })).filter(d=>d.value>0.005);
  }

  // Donut « par affaires et temps interne » : un frais est soit affecté à une affaire, soit à un temps
  // interne (fraisCibleLabel, jamais les deux) — le donut cumule donc deux dimensions dans les mêmes
  // secteurs. Toutes les affaires sont regroupées dans une seule part « Affaires » (vert, comme la
  // production facturable ailleurs dans l'outil) plutôt que détaillées une par une : le nombre
  // d'affaires concernées est une liste ouverte, le détail par affaire alourdirait vite le donut.
  // Temps internes en jaune, mêmes 5 groupes et mêmes couleurs que le donut de répartition des temps
  // (REPARTITION_GROUPES_INTERNES) — c'est ce que "garde les grandes catégories de temps internes" désigne.
  function fraisNonRefCibleData(rows){
    const nonRef = rows.filter(n=>!n.refacturable);

    const totalAffaires = nonRef.filter(n=>n.affaireId).reduce((s,n)=>s+n.montantTTC,0);
    const affaireData = totalAffaires>0.005 ? [{ label:"Affaires", color:"var(--brand-green-dark)", value:totalAffaires }] : [];

    const interneData = REPARTITION_GROUPES_INTERNES.map(g=>({
      label: g.label, color: g.color,
      value: nonRef.filter(n=>n.categorieTempsInterne && g.codes.includes(n.categorieTempsInterne)).reduce((s,n)=>s+n.montantTTC,0),
    })).filter(d=>d.value>0.005);

    return [...affaireData, ...interneData];
  }

  function renderSelectAnneeFrais(){
    const sel = document.getElementById("select-annee-frais");
    const years = Array.from(new Set(notesFrais.map(n=>n.date.slice(0,4)))).sort().reverse();
    populateAnneeSelect(sel, years, renderFraisSociete);
  }

  // Vue "Frais" du cabinet (Cabinet > Frais) : tous les frais de tous les consultants, sur une année
  // donnée — indépendante de "Mes frais" (un seul consultant) et de "Voir les frais" (une seule affaire).
  function renderFraisSociete(){
    const year = document.getElementById("select-annee-frais").value;
    renderFraisBarChart("chart-frais-mensuel", fraisMensuel(year), year);

    const rows = notesFrais.filter(n=>n.date.slice(0,4)===year).slice().sort((a,b)=>b.date.localeCompare(a.date));

    document.getElementById("frais-donut-annee").textContent = year;
    renderFraisDonutChart("chart-frais-donut-categorie", fraisNonRefCategorieData(rows), { caption:year, ariaLabel:`Frais non refacturables ${year} par grande catégorie, cabinet` });
    renderFraisDonutChart("chart-frais-donut-cible", fraisNonRefCibleData(rows), { caption:year, ariaLabel:`Frais non refacturables ${year} par affaire et temps interne, cabinet` });

    const columns = [
      { key:"date", label:"Date", get:r=>r.date },
      { key:"consultant", label:"Consultant", filterable:true, get:r=>consultantName(r.consultantId) },
      { key:"affaire", label:"Affaire / Interne", filterable:true, get:r=>fraisCibleLabel(r) },
      { key:"categorie", label:"Sous-catégorie", filterable:true, get:r=>categorieFraisLabel(r.categorieFraisId) },
      { key:"refacturable", label:"Refacturable", filterable:true, get:r=>r.affaireId ? (r.refacturable?"Oui":"Non") : "—" },
      { key:"ht", label:"Montant HT", numeric:true, get:r=>r.montantHT },
      { key:"taux1", label:"Taux TVA 1", numeric:true, get:r=>fraisLigneTauxCell(r,0) },
      { key:"tva1", label:"Montant TVA 1", numeric:true, get:r=>fraisLigneMontantTVACell(r,0) },
      { key:"taux2", label:"Taux TVA 2", numeric:true, get:r=>fraisLigneTauxCell(r,1) },
      { key:"tva2", label:"Montant TVA 2", numeric:true, get:r=>fraisLigneMontantTVACell(r,1) },
      { key:"taux3", label:"Taux TVA 3", numeric:true, get:r=>fraisLigneTauxCell(r,2) },
      { key:"tva3", label:"Montant TVA 3", numeric:true, get:r=>fraisLigneMontantTVACell(r,2) },
      { key:"taux4", label:"Taux TVA 4", numeric:true, get:r=>fraisLigneTauxCell(r,3) },
      { key:"tva4", label:"Montant TVA 4", numeric:true, get:r=>fraisLigneMontantTVACell(r,3) },
      { key:"ttc", label:"Montant TTC", numeric:true, get:r=>r.montantTTC },
      { key:"statut", label:"Statut", filterable:true, get:r=>fraisStatut(r) },
      { key:"commentaire", label:"Commentaires", sortable:false, get:r=>r.commentaire||"" },
    ];
    const rowHTML = r => {
      const cat = categorieFraisById(r.categorieFraisId);
      return `<tr>
        <td>${dateFR(r.date)}</td>
        <td>${esc(consultantName(r.consultantId))}</td>
        <td>${esc(fraisCibleLabel(r))}</td>
        <td class="affaire-name">${cat ? esc(cat.label) : "—"}${cat ? `<span class="sub">${esc(cat.categorie)}</span>` : ""}</td>
        <td>${r.affaireId ? (r.refacturable ? "Oui" : "Non") : "—"}</td>
        <td class="num">${euroCents(r.montantHT)}</td>
        <td class="num">${fraisLigneTauxCell(r,0)}</td>
        <td class="num">${fraisLigneMontantTVACell(r,0)}</td>
        <td class="num">${fraisLigneTauxCell(r,1)}</td>
        <td class="num">${fraisLigneMontantTVACell(r,1)}</td>
        <td class="num">${fraisLigneTauxCell(r,2)}</td>
        <td class="num">${fraisLigneMontantTVACell(r,2)}</td>
        <td class="num">${fraisLigneTauxCell(r,3)}</td>
        <td class="num">${fraisLigneMontantTVACell(r,3)}</td>
        <td class="num">${euroCents(r.montantTTC)}</td>
        <td>${fraisStatutPill(fraisStatut(r))}<span style="display:block;font-size:.72rem;color:var(--text-muted);font-family:var(--font-mono);margin-top:3px;">${esc(r.numeroBordereau)}</span></td>
        <td style="color:var(--text-muted);">${r.commentaire ? esc(r.commentaire) : "—"}</td>
      </tr>`;
    };
    renderSortFilterTable("table-frais-societe", rows, columns, rowHTML, {
      rerender: renderFraisSociete,
      emptyMsg: "Aucun frais saisi sur cette année.",
      tfoot: display => `<tfoot><tr>
          <td colspan="5">Total (${display.length} frais)</td>
          <td class="num">${euroCents(display.reduce((s,r)=>s+r.montantHT,0))}</td>
          <td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>
          <td class="num">${euroCents(display.reduce((s,r)=>s+r.montantTTC,0))}</td>
          <td></td><td></td>
        </tr></tfoot>`,
    });
  }

  function renderSuiviTempsSociete(year){
    const all = saisies.filter(s=>s.date.slice(0,4)===year);

    const fact = new Array(12).fill(0), nonFact = new Array(12).fill(0);
    all.filter(s=>s.type==="mission").forEach(s=>{
      const mo = +s.date.slice(5,7)-1;
      fact[mo]+=s.jFact; nonFact[mo]+=s.jNonFact;
    });

    let rows = [];

    rows.push(suiviRowHTML("Missions", fact.map((v,i)=>v+nonFact[i]), "total"));
    rows.push(suiviRowHTML("Facturable", fact, "sub"));
    rows.push(suiviRowHTML("Non facturable", nonFact, "sub"));

    const subtot = { interne:new Array(12).fill(0), absence:new Array(12).fill(0) };
    tempsInternes.forEach(cat=>{
      const arr = new Array(12).fill(0);
      all.filter(s=>s.type==="interne" && s.categorie===cat.code).forEach(s=>{ arr[+s.date.slice(5,7)-1]+=s.dureeJ; });
      rows.push(suiviRowHTML(cat.label, arr, "")); for(let i=0;i<12;i++) subtot.interne[i]+=arr[i];
    });
    tempsAbsences.forEach(cat=>{
      const arr = new Array(12).fill(0);
      all.filter(s=>s.type==="absence" && s.categorie===cat.code).forEach(s=>{ arr[+s.date.slice(5,7)-1]+=s.dureeJ; });
      rows.push(suiviRowHTML(cat.label, arr, "")); for(let i=0;i<12;i++) subtot.absence[i]+=arr[i];
    });

    renderSuiviTempsTable("table-suivi-temps-societe", rows, fact, nonFact, subtot.interne, subtot.absence, year);
  }

  /* ================= Détail des temps ================= */
  // mode "annee" : scope = un id de consultant (vue individuelle) ou "all" (vue société) ; borné à une année.
  // mode "affaire" : toutes les saisies des missions d'une affaire donnée, toutes années confondues
  // (une affaire peut être à cheval sur deux années — pas de sens à couper par année ici).
  // mode "mission" : toutes les saisies d'une seule mission, toutes années confondues (même
  // raisonnement que pour une affaire).
  let detailTempsMode = "annee";
  let detailTempsScope = null;
  let detailTempsYear = null;
  let detailTempsAffaireId = null;
  let detailTempsMissionId = null;
  let detailTempsReturnView = "mapage";

  function openDetailTemps(scope, year, returnView){
    detailTempsMode = "annee";
    detailTempsScope = scope;
    detailTempsYear = year;
    detailTempsReturnView = returnView;
    showView("detail-temps");
  }

  function openDetailTempsAffaire(affaireId){
    detailTempsMode = "affaire";
    detailTempsAffaireId = affaireId;
    detailTempsReturnView = "affaire-detail";
    showView("detail-temps");
  }

  function openDetailTempsMission(missionId, returnView){
    detailTempsMode = "mission";
    detailTempsMissionId = missionId;
    detailTempsReturnView = returnView || "mapage";
    showView("detail-temps");
  }

  function renderDetailTemps(){
    if(detailTempsMode === "affaire") return renderDetailTempsAffaire();
    if(detailTempsMode === "mission") return renderDetailTempsMission();

    const year = detailTempsYear;
    const scope = detailTempsScope;
    const isAll = scope === "all";

    document.getElementById("detail-temps-titre").textContent = isAll ? "Détail des temps — société" : `Détail des temps — ${consultantName(scope)}`;
    document.getElementById("detail-temps-sub").textContent = `Toutes les saisies de l'année ${year}.`;

    let rows = saisies.filter(s=>s.date.slice(0,4)===year && (isAll || s.consultantId===scope));
    rows = rows.slice().sort((a,b)=> b.date.localeCompare(a.date)); // plus récent d'abord par défaut

    const columns = [
      { key:"date", label:"Date", get:r=>r.date },
      ...(isAll ? [{ key:"consultant", label:"Consultant", filterable:true, get:r=>consultantName(r.consultantId) }] : []),
      { key:"type", label:"Type de temps", filterable:true, get:r=>saisieTypeLabel(r) },
      { key:"duree", label:"Durée", numeric:true, get:r=>r.dureeJ },
      { key:"commentaire", label:"Commentaires", sortable:false, get:r=>r.commentaire||"" },
      { key:"factJ", label:"Facturable", numeric:true, filterable:true, get:r=>r.jFact },
      { key:"nonFactJ", label:"Non facturable", numeric:true, filterable:true, get:r=>r.jNonFact },
    ];
    const rowHTML = r => `<tr>
        <td>${dateFR(r.date)}</td>
        ${isAll ? `<td>${esc(consultantName(r.consultantId))}</td>` : ""}
        <td class="affaire-name">${esc(saisieTypeLabel(r))}${r.type==="mission" ? `<span class="sub">${esc(saisieMissionName(r))}</span>` : ""}</td>
        <td class="num">${jr(r.dureeJ)}</td>
        <td style="color:var(--text-muted);">${r.commentaire ? esc(r.commentaire) : "—"}</td>
        <td class="num">${r.jFact ? jr(r.jFact) : "–"}</td>
        <td class="num">${r.jNonFact ? jr(r.jNonFact) : "–"}</td>
      </tr>`;
    renderSortFilterTable("table-detail-temps", rows, columns, rowHTML, {
      rerender: renderDetailTemps,
      emptyMsg: `Aucune saisie sur ${year}.`,
      tfoot: display => `<tfoot><tr>
          <td colspan="${isAll?3:2}">Total (${display.length} saisie${display.length>1?"s":""})</td>
          <td class="num">${jr(display.reduce((s,r)=>s+r.dureeJ,0))}</td>
          <td></td>
          <td class="num">${jr(display.reduce((s,r)=>s+r.jFact,0))}</td>
          <td class="num">${jr(display.reduce((s,r)=>s+r.jNonFact,0))}</td>
        </tr></tfoot>`,
    });
  }

  function renderDetailTempsAffaire(){
    const a = affaires.find(x=>x.id===detailTempsAffaireId);
    if(!a) return;
    document.getElementById("detail-temps-titre").textContent = `Détail des temps — ${a.nom}`;
    document.getElementById("detail-temps-sub").textContent = "Toutes les saisies de l'affaire, toutes années confondues.";

    const missionIds = new Set(missions.filter(m=>m.affaireId===a.id).map(m=>m.id));
    let rows = saisies.filter(s=>s.type==="mission" && missionIds.has(s.missionId));
    rows = rows.slice().sort((a,b)=> b.date.localeCompare(a.date)); // plus récent d'abord par défaut

    const columns = [
      { key:"date", label:"Date", get:r=>r.date },
      { key:"consultant", label:"Consultant", filterable:true, get:r=>consultantName(r.consultantId) },
      { key:"mission", label:"Mission", filterable:true, get:r=>saisieMissionName(r) },
      { key:"duree", label:"Durée", numeric:true, get:r=>r.dureeJ },
      { key:"commentaire", label:"Commentaires", sortable:false, get:r=>r.commentaire||"" },
      { key:"factJ", label:"Facturable", numeric:true, filterable:true, get:r=>r.jFact },
      { key:"nonFactJ", label:"Non facturable", numeric:true, filterable:true, get:r=>r.jNonFact },
    ];
    const rowHTML = r => `<tr>
        <td>${dateFR(r.date)}</td>
        <td>${esc(consultantName(r.consultantId))}</td>
        <td class="affaire-name">${esc(saisieMissionName(r))}</td>
        <td class="num">${jr(r.dureeJ)}</td>
        <td style="color:var(--text-muted);">${r.commentaire ? esc(r.commentaire) : "—"}</td>
        <td class="num">${r.jFact ? jr(r.jFact) : "–"}</td>
        <td class="num">${r.jNonFact ? jr(r.jNonFact) : "–"}</td>
      </tr>`;
    renderSortFilterTable("table-detail-temps", rows, columns, rowHTML, {
      rerender: renderDetailTemps,
      emptyMsg: "Aucune saisie sur cette affaire.",
      tfoot: display => `<tfoot><tr>
          <td colspan="3">Total (${display.length} saisie${display.length>1?"s":""})</td>
          <td class="num">${jr(display.reduce((s,r)=>s+r.dureeJ,0))}</td>
          <td></td>
          <td class="num">${jr(display.reduce((s,r)=>s+r.jFact,0))}</td>
          <td class="num">${jr(display.reduce((s,r)=>s+r.jNonFact,0))}</td>
        </tr></tfoot>`,
    });
  }

  function renderDetailTempsMission(){
    const m = missions.find(x=>x.id===detailTempsMissionId);
    if(!m) return;
    const a = affaires.find(x=>x.id===m.affaireId);
    document.getElementById("detail-temps-titre").textContent = `Détail des temps — ${m.nom}`;
    document.getElementById("detail-temps-sub").textContent = `${a ? a.nom+" · " : ""}Toutes les saisies de la mission, toutes années confondues.`;

    let rows = saisies.filter(s=>s.type==="mission" && s.missionId===m.id);
    rows = rows.slice().sort((a,b)=> b.date.localeCompare(a.date)); // plus récent d'abord par défaut

    const columns = [
      { key:"date", label:"Date", get:r=>r.date },
      { key:"consultant", label:"Consultant", filterable:true, get:r=>consultantName(r.consultantId) },
      { key:"duree", label:"Durée", numeric:true, get:r=>r.dureeJ },
      { key:"commentaire", label:"Commentaires", sortable:false, get:r=>r.commentaire||"" },
      { key:"factJ", label:"Facturable", numeric:true, filterable:true, get:r=>r.jFact },
      { key:"nonFactJ", label:"Non facturable", numeric:true, filterable:true, get:r=>r.jNonFact },
    ];
    const rowHTML = r => `<tr>
        <td>${dateFR(r.date)}</td>
        <td>${esc(consultantName(r.consultantId))}</td>
        <td class="num">${jr(r.dureeJ)}</td>
        <td style="color:var(--text-muted);">${r.commentaire ? esc(r.commentaire) : "—"}</td>
        <td class="num">${r.jFact ? jr(r.jFact) : "–"}</td>
        <td class="num">${r.jNonFact ? jr(r.jNonFact) : "–"}</td>
      </tr>`;
    renderSortFilterTable("table-detail-temps", rows, columns, rowHTML, {
      rerender: renderDetailTemps,
      emptyMsg: "Aucune saisie sur cette mission.",
      tfoot: display => `<tfoot><tr>
          <td colspan="2">Total (${display.length} saisie${display.length>1?"s":""})</td>
          <td class="num">${jr(display.reduce((s,r)=>s+r.dureeJ,0))}</td>
          <td></td>
          <td class="num">${jr(display.reduce((s,r)=>s+r.jFact,0))}</td>
          <td class="num">${jr(display.reduce((s,r)=>s+r.jNonFact,0))}</td>
        </tr></tfoot>`,
    });
  }

  /* ================= Mes temps ================= */
  // Page dédiée (rubrique Moi) : saisir un temps, et voir juste en dessous la liste de toutes ses
  // saisies individuelles — vue « Mois » (mois en cours) par défaut, bascule possible en « Année ».
  let mesTempsMode = "mois";
  let mesTempsYear = String(CURRENT_YEAR);

  function wireMesTempsToggle(){
    const wrap = document.getElementById("mestemps-toggle");
    if(!wrap || wrap.dataset.wired) return;
    wrap.dataset.wired = "1";
    wrap.querySelectorAll(".chip").forEach(chip=>{
      chip.addEventListener("click", ()=>{
        mesTempsMode = chip.dataset.mode;
        wrap.querySelectorAll(".chip").forEach(c=>c.classList.toggle("on", c===chip));
        document.getElementById("select-annee-mestemps").hidden = mesTempsMode !== "annee";
        renderMesTemps();
      });
    });
  }
  function renderSelectAnneeMesTemps(){
    const sel = document.getElementById("select-annee-mestemps");
    const years = Array.from(new Set(saisies.filter(s=>s.consultantId===currentUser).map(s=>s.date.slice(0,4)))).sort().reverse();
    populateAnneeSelect(sel, years, ()=>{ mesTempsYear = sel.value; renderMesTemps(); });
    mesTempsYear = sel.value;
  }
  function renderMesTemps(){
    const isMois = mesTempsMode === "mois";
    let rows;
    if(isMois){
      const monthKey = today.toISOString().slice(0,7);
      rows = saisies.filter(s=>s.consultantId===currentUser && s.date.slice(0,7)===monthKey);
      document.getElementById("mestemps-sub").textContent = `Saisies de ${MOIS[today.getMonth()]} ${CURRENT_YEAR} — bascule en vue annuelle si besoin.`;
    } else {
      rows = saisies.filter(s=>s.consultantId===currentUser && s.date.slice(0,4)===mesTempsYear);
      document.getElementById("mestemps-sub").textContent = `Toutes les saisies de l'année ${mesTempsYear}.`;
    }
    rows = rows.slice().sort((a,b)=> b.date.localeCompare(a.date)); // plus récent d'abord par défaut

    const columns = [
      { key:"date", label:"Date", get:r=>r.date },
      { key:"type", label:"Type de temps", filterable:true, get:r=>saisieTypeLabel(r) },
      { key:"duree", label:"Durée", numeric:true, get:r=>r.dureeJ },
      { key:"commentaire", label:"Commentaires", sortable:false, get:r=>r.commentaire||"" },
      { key:"factJ", label:"Facturable", numeric:true, filterable:true, get:r=>r.jFact },
      { key:"nonFactJ", label:"Non facturable", numeric:true, filterable:true, get:r=>r.jNonFact },
    ];
    const rowHTML = r => `<tr>
        <td>${dateFR(r.date)}</td>
        <td class="affaire-name">${esc(saisieTypeLabel(r))}${r.type==="mission" ? `<span class="sub">${esc(saisieMissionName(r))}</span>` : ""}</td>
        <td class="num">${jr(r.dureeJ)}</td>
        <td style="color:var(--text-muted);">${r.commentaire ? esc(r.commentaire) : "—"}</td>
        <td class="num">${r.jFact ? jr(r.jFact) : "–"}</td>
        <td class="num">${r.jNonFact ? jr(r.jNonFact) : "–"}</td>
      </tr>`;
    renderSortFilterTable("table-mestemps", rows, columns, rowHTML, {
      rerender: renderMesTemps,
      emptyMsg: isMois ? "Aucune saisie ce mois-ci." : "Aucune saisie sur cette année.",
      tfoot: display => `<tfoot><tr>
          <td colspan="2">Total (${display.length} saisie${display.length>1?"s":""})</td>
          <td class="num">${jr(display.reduce((s,r)=>s+r.dureeJ,0))}</td>
          <td></td>
          <td class="num">${jr(display.reduce((s,r)=>s+r.jFact,0))}</td>
          <td class="num">${jr(display.reduce((s,r)=>s+r.jNonFact,0))}</td>
        </tr></tfoot>`,
    });
  }

  /* ================= Mes frais ================= */
  // Page dédiée (rubrique Moi) : saisir un frais, et voir juste en dessous la liste de toutes ses
  // notes de frais individuelles — même logique de vue Mois / Année que « Mes temps ».
  let mesFraisMode = "mois";
  let mesFraisYear = String(CURRENT_YEAR);

  function categorieFraisById(id){ return categoriesFrais.find(c=>c.id===id); }
  function categorieFraisLabel(id){
    const c = categorieFraisById(id);
    return c ? c.label : "—";
  }

  // Liste des notes de frais (bordereaux) du consultant connecté, toutes années confondues, plus
  // récente d'abord — avec le bouton « Demander le paiement » sur celle actuellement ouverte.
  function renderMesBordereaux(){
    const mine = bordereauxFrais.filter(b=>b.consultantId===currentUser).slice().sort((a,b)=>b.numero.localeCompare(a.numero));
    const columns = [
      { key:"numero", label:"Numéro", get:b=>b.numero },
      { key:"annee", label:"Année", get:b=>b.annee },
      { key:"nb", label:"Frais", numeric:true, get:b=>notesFrais.filter(n=>n.numeroBordereau===b.numero).length },
      { key:"ttc", label:"Montant TTC", numeric:true, get:b=>notesFrais.filter(n=>n.numeroBordereau===b.numero).reduce((s,n)=>s+n.montantTTC,0) },
      { key:"statut", label:"Statut", filterable:true, get:b=>b.statut },
      { key:"paiement", label:"Date de paiement", get:b=>b.datePaiement||"" },
    ];
    const rowHTML = b => {
      const frais = notesFrais.filter(n=>n.numeroBordereau===b.numero);
      const ttc = frais.reduce((s,n)=>s+n.montantTTC,0);
      const action = b.statut==="en saisie"
        ? `<button type="button" class="btn-voir" data-demander="${esc(b.numero)}" ${frais.length?"":"disabled"}>Demander le paiement</button>`
        : "—";
      return `<tr>
        <td style="font-family:var(--font-mono);">${esc(b.numero)}</td>
        <td>${b.annee}</td>
        <td class="num">${frais.length}</td>
        <td class="num">${euroCents(ttc)}</td>
        <td>${bordereauStatutPill(b.statut)}</td>
        <td>${b.datePaiement ? dateFR(b.datePaiement) : "—"}</td>
        <td>${action}</td>
      </tr>`;
    };
    renderSortFilterTable("table-mes-bordereaux", mine, columns, rowHTML, {
      rerender: renderMesBordereaux,
      emptyMsg: "Aucune note de frais pour l'instant — elle apparaît dès votre premier frais saisi.",
      extraHeadCols: `<th></th>`,
      afterRender: table => table.querySelectorAll("[data-demander]").forEach(btn=>{
        btn.addEventListener("click", ()=>{
          demanderPaiementBordereau(btn.dataset.demander);
          toast("Paiement demandé — la note passe en « note à payer »");
          renderMesBordereaux();
          renderMesFrais();
        });
      }),
    });
  }

  function wireMesFraisToggle(){
    const wrap = document.getElementById("mesfrais-toggle");
    if(!wrap || wrap.dataset.wired) return;
    wrap.dataset.wired = "1";
    wrap.querySelectorAll(".chip").forEach(chip=>{
      chip.addEventListener("click", ()=>{
        mesFraisMode = chip.dataset.mode;
        wrap.querySelectorAll(".chip").forEach(c=>c.classList.toggle("on", c===chip));
        document.getElementById("select-annee-mesfrais").hidden = mesFraisMode !== "annee";
        renderMesFrais();
      });
    });
  }
  function renderSelectAnneeMesFrais(){
    const sel = document.getElementById("select-annee-mesfrais");
    const years = Array.from(new Set(notesFrais.filter(n=>n.consultantId===currentUser).map(n=>n.date.slice(0,4)))).sort().reverse();
    populateAnneeSelect(sel, years, ()=>{ mesFraisYear = sel.value; renderMesFrais(); });
    mesFraisYear = sel.value;
  }
  function renderMesFrais(){
    const isMois = mesFraisMode === "mois";
    let rows;
    if(isMois){
      const monthKey = today.toISOString().slice(0,7);
      rows = notesFrais.filter(n=>n.consultantId===currentUser && n.date.slice(0,7)===monthKey);
      document.getElementById("mesfrais-sub").textContent = `Frais de ${MOIS[today.getMonth()]} ${CURRENT_YEAR} — bascule en vue annuelle si besoin.`;
    } else {
      rows = notesFrais.filter(n=>n.consultantId===currentUser && n.date.slice(0,4)===mesFraisYear);
      document.getElementById("mesfrais-sub").textContent = `Tous les frais de l'année ${mesFraisYear}.`;
    }
    rows = rows.slice().sort((a,b)=> b.date.localeCompare(a.date)); // plus récent d'abord par défaut

    // Les donuts restent toujours à l'année (indépendants de la bascule Mois/Année du tableau
    // ci-dessous) : une vue mensuelle serait trop pauvre pour être lisible.
    const rowsAnneeDonuts = notesFrais.filter(n=>n.consultantId===currentUser && n.date.slice(0,4)===mesFraisYear);
    renderMesFraisDonuts(rowsAnneeDonuts, mesFraisYear);

    const columns = [
      { key:"date", label:"Date", get:r=>r.date },
      { key:"affaire", label:"Affaire / Interne", filterable:true, get:r=>fraisCibleLabel(r) },
      { key:"categorie", label:"Sous-catégorie", filterable:true, get:r=>categorieFraisLabel(r.categorieFraisId) },
      { key:"refacturable", label:"Refacturable", filterable:true, get:r=>r.affaireId ? (r.refacturable?"Oui":"Non") : "—" },
      { key:"ht", label:"Montant HT", numeric:true, get:r=>r.montantHT },
      { key:"tva", label:"TVA", numeric:true, filterable:true, get:r=>tvaTauxListLabel(r.lignesTVA) },
      { key:"ttc", label:"Montant TTC", numeric:true, get:r=>r.montantTTC },
      { key:"statut", label:"Statut", filterable:true, get:r=>fraisStatut(r) },
      { key:"commentaire", label:"Commentaires", sortable:false, get:r=>r.commentaire||"" },
    ];
    const rowHTML = r => {
      const cat = categorieFraisById(r.categorieFraisId);
      return `<tr>
        <td>${dateFR(r.date)}</td>
        <td>${esc(fraisCibleLabel(r))}</td>
        <td class="affaire-name">${cat ? esc(cat.label) : "—"}${cat ? `<span class="sub">${esc(cat.categorie)}</span>` : ""}</td>
        <td>${r.affaireId ? (r.refacturable ? "Oui" : "Non") : "—"}</td>
        <td class="num">${euroCents(r.montantHT)}</td>
        <td class="num">${tvaTauxListLabel(r.lignesTVA)}</td>
        <td class="num">${euroCents(r.montantTTC)}</td>
        <td>${fraisStatutPill(fraisStatut(r))}<span style="display:block;font-size:.72rem;color:var(--text-muted);font-family:var(--font-mono);margin-top:3px;">${esc(r.numeroBordereau)}</span></td>
        <td style="color:var(--text-muted);">${r.commentaire ? esc(r.commentaire) : "—"}</td>
      </tr>`;
    };
    renderSortFilterTable("table-mesfrais", rows, columns, rowHTML, {
      rerender: renderMesFrais,
      emptyMsg: isMois ? "Aucun frais saisi ce mois-ci." : "Aucun frais saisi sur cette année.",
      tfoot: display => `<tfoot><tr>
          <td colspan="4">Total (${display.length} frais)</td>
          <td class="num">${euroCents(display.reduce((s,r)=>s+r.montantHT,0))}</td>
          <td></td>
          <td class="num">${euroCents(display.reduce((s,r)=>s+r.montantTTC,0))}</td>
          <td></td>
          <td></td>
        </tr></tfoot>`,
    });
  }

  // Donuts "Mes frais" — répartition des frais non refacturables du consultant connecté, sur la même
  // période (mois ou année) que le tableau "Mes frais" ci-dessous.
  function renderMesFraisDonuts(rows, caption){
    document.getElementById("mesfrais-donut-annee-cat").textContent = caption;
    document.getElementById("mesfrais-donut-annee-cible").textContent = caption;
    renderFraisDonutChart("chart-mesfrais-donut-categorie", fraisNonRefCategorieData(rows), { caption, ariaLabel:"Mes frais non refacturables par grande catégorie" });
    renderFraisDonutChart("chart-mesfrais-donut-cible", fraisNonRefCibleData(rows), { caption, ariaLabel:"Mes frais non refacturables par affaire et temps interne" });
  }

  function populateAffaireSelectFrais(){
    const sel = document.getElementById("fr-affaire");
    const mine = affaires.filter(a=>a.statut==="en production" &&
      (a.pilote===currentUser || missions.some(m=>m.affaireId===a.id && m.consultantId===currentUser)));
    sel.innerHTML = mine.map(a=>`<option value="${esc(a.id)}">${esc(a.nom)}</option>`).join("");
  }
  // Temps interne concerné par le frais — tout tempsInternes est proposé, jamais une absence
  // (tempsAbsences) : on ne peut pas rattacher un frais à un congé ou un arrêt maladie.
  function populateInterneSelectFrais(){
    const sel = document.getElementById("fr-interne");
    sel.innerHTML = tempsInternes.map(t=>`<option value="${t.code}">${t.label}</option>`).join("");
  }
  // Bascule affaire / temps interne dans le module de saisie de frais : seul le champ pertinent est
  // affiché, et la case "Refacturable" (qui n'a de sens que pour une affaire) est masquée sinon.
  function onFraisTypeChange(){
    const type = document.getElementById("fr-type").value;
    document.getElementById("wrap-fr-affaire").hidden = type !== "affaire";
    document.getElementById("wrap-fr-interne").hidden = type !== "interne";
    document.getElementById("wrap-fr-refacturable").hidden = type !== "affaire";
  }
  function populateCategorieSelectFrais(){
    const sel = document.getElementById("fr-categorie");
    const groups = [];
    categoriesFrais.forEach(c=>{
      let g = groups.find(g=>g.categorie===c.categorie);
      if(!g){ g = { categorie:c.categorie, items:[] }; groups.push(g); }
      g.items.push(c);
    });
    sel.innerHTML = groups.map(g=>
      `<optgroup label="${esc(g.categorie)}">${g.items.map(c=>`<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("")}</optgroup>`
    ).join("");
  }
  // Lignes HT/TVA du frais en cours de saisie — une note peut en cumuler plusieurs (ex. un
  // restaurant qui facture le repas à 10 % et les boissons alcoolisées à 20 %). Même principe
  // d'édition que les partenaires d'affaire (tableau en mémoire, ré-affiché à chaque changement).
  const MAX_LIGNES_FRAIS = 4;
  let editingLignesFrais = [];

  function fraisLigneRowHTML(l, i){
    return `<div class="frligne-row" data-idx="${i}">
        <div class="field">
          <label>Montant HT (€)</label>
          <input type="number" class="fl-ht" data-idx="${i}" min="0" step="0.01" value="${l.montantHT}">
        </div>
        <div class="field">
          <label>Taux de TVA</label>
          <select class="fl-taux" data-idx="${i}">
            ${TAUX_TVA.map(t=>`<option value="${t.taux}" ${l.tauxTVA===t.taux?"selected":""}>${t.label}</option>`).join("")}
          </select>
        </div>
        ${editingLignesFrais.length>1 ? `<button type="button" class="btn ghost fl-remove" data-idx="${i}" style="height:38px;" title="Supprimer cette ligne">✕</button>` : ""}
      </div>`;
  }
  function renderFraisLignesEditor(){
    const wrap = document.getElementById("fr-lignes-list");
    wrap.innerHTML = editingLignesFrais.map(fraisLigneRowHTML).join("");
    wrap.querySelectorAll(".fl-ht").forEach(inp=>{
      inp.addEventListener("input", e=>{
        editingLignesFrais[+e.target.dataset.idx].montantHT = parseFloat(e.target.value) || 0;
        recomputeFraisTVA();
      });
    });
    wrap.querySelectorAll(".fl-taux").forEach(sel=>{
      sel.addEventListener("change", e=>{
        editingLignesFrais[+e.target.dataset.idx].tauxTVA = parseFloat(e.target.value) || 0;
        recomputeFraisTVA();
      });
    });
    wrap.querySelectorAll(".fl-remove").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        editingLignesFrais.splice(+btn.dataset.idx, 1);
        renderFraisLignesEditor();
        updateFraisLignesAddButton();
        recomputeFraisTVA();
      });
    });
    updateFraisLignesAddButton();
  }
  function updateFraisLignesAddButton(){
    document.getElementById("fr-lignes-add").hidden = editingLignesFrais.length >= MAX_LIGNES_FRAIS;
  }
  function recomputeFraisTVA(){
    const agg = aggregateLignesTVA(editingLignesFrais.map(l=>({ ...l, montantTVA:+(l.montantHT*l.tauxTVA/100).toFixed(2) })));
    document.getElementById("fr-montant-tva").textContent = euroCents(agg.montantTVA);
    document.getElementById("fr-montant-ttc").textContent = euroCents(agg.montantTTC);
  }
  function openFrais(){
    document.getElementById("fr-date").value = today.toISOString().slice(0,10);
    document.getElementById("fr-type").value = "affaire";
    populateAffaireSelectFrais();
    populateInterneSelectFrais();
    populateCategorieSelectFrais();
    onFraisTypeChange();
    document.getElementById("fr-refacturable").checked = false;
    document.getElementById("fr-comment").value = "";
    editingLignesFrais = [{ tauxTVA:20, montantHT:0 }];
    renderFraisLignesEditor();
    recomputeFraisTVA();
    document.getElementById("modal-frais").hidden = false;
  }
  function saveFrais(){
    const date = document.getElementById("fr-date").value;
    const fraisType = document.getElementById("fr-type").value;
    const affaireId = fraisType==="affaire" ? document.getElementById("fr-affaire").value : null;
    const categorieTempsInterne = fraisType==="interne" ? document.getElementById("fr-interne").value : null;
    const categorieFraisId = document.getElementById("fr-categorie").value;
    const refacturable = fraisType==="affaire" ? document.getElementById("fr-refacturable").checked : false;
    const commentaire = (document.getElementById("fr-comment").value || "").trim();

    const lignesTVA = editingLignesFrais
      .filter(l=>l.montantHT>0)
      .map(l=>({ tauxTVA:l.tauxTVA, montantHT:+l.montantHT.toFixed(2), montantTVA:+(l.montantHT*l.tauxTVA/100).toFixed(2) }));

    const cibleManquante = fraisType==="affaire" ? !affaireId : !categorieTempsInterne;
    if(!date || cibleManquante || !categorieFraisId || !lignesTVA.length){
      toast(`Merci de renseigner la date, ${fraisType==="affaire" ? "l'affaire" : "le temps interne"}, la sous-catégorie et au moins un montant HT.`);
      return;
    }

    const bordereau = getOrCreateOpenBordereau(currentUser);
    notesFrais.push({ id:newEntityId("NF"), date, consultantId:currentUser, affaireId, categorieTempsInterne, categorieFraisId, refacturable, numeroBordereau:bordereau.numero, lignesTVA, ...aggregateLignesTVA(lignesTVA), commentaire });

    toast("Frais enregistré");
    closeModal("modal-frais");
    renderAll();
  }

  /* ================= Organisations ================= */
  // Une organisation peut cumuler plusieurs rôles selon les affaires où elle apparaît :
  // - cliente sur une affaire dont le statut a abouti (en production / terminée) ;
  // - prospect sur une affaire encore en commercialisation, ou perdue (le statut de démarchage
  //   n'a pas débouché sur un vrai client) ;
  // - partenaire dès qu'elle figure dans la sous-table Partenaires d'une affaire, quel que soit
  //   son rôle (mandataire, co-traitant, sous-traitant direct ou indirect).
  // Une organisation sans aucune affaire dans ces trois catégories reste « prospect » par défaut
  // (nouvelle organisation pas encore démarchée).
  function orgAffairesClient(orgId){
    return affaires.filter(a=>a.organisationId===orgId && (a.statut==="en production" || a.statut==="terminée"));
  }
  function orgAffairesProspect(orgId){
    return affaires.filter(a=>a.organisationId===orgId && (a.statut==="en commercialisation" || a.statut==="perdue"));
  }
  function orgAffairesPartenaire(orgId){
    return affaires.filter(a=>(a.partenaires||[]).some(p=>p.organisationId===orgId));
  }
  function orgStatutPills(counts){
    const pills = [];
    if(counts.client) pills.push(`<span class="pill good">cliente</span>`);
    if(counts.partenaire) pills.push(`<span class="pill warn">partenaire</span>`);
    if(counts.prospect || (!counts.client && !counts.partenaire)) pills.push(`<span class="pill neutral">prospect</span>`);
    return pills.join(" ");
  }
  // Résumé textuel du statut (pour le filtre de colonne, qui compare des valeurs exactes —
  // les combinaisons possibles apparaissent chacune comme une valeur filtrable à part entière).
  function orgStatutKey(counts){
    const roles = [];
    if(counts.client) roles.push("cliente");
    if(counts.partenaire) roles.push("partenaire");
    if(counts.prospect || !roles.length) roles.push("prospect");
    return roles.join(" + ");
  }

  function renderOrganisations(){
    const list = organisations.map(o=>{
      const affClient = orgAffairesClient(o.id);
      const affProspect = orgAffairesProspect(o.id);
      const affPartenaire = orgAffairesPartenaire(o.id);
      const counts = { client:affClient.length, prospect:affProspect.length, partenaire:affPartenaire.length };
      return { ...o, _affClient:affClient, _affProspect:affProspect, _affPartenaire:affPartenaire, _statutKey:orgStatutKey(counts) };
    });
    const voirBtn = (org, role, n) =>
      `<button type="button" class="btn-voir" data-org="${org.id}" data-role="${role}" ${n?"":"disabled"}>Voir</button>`;
    const columns = [
      { key:"nom", label:"Organisation", get:o=>o.nom },
      { key:"type", label:"Type", filterable:true, get:o=>o.type },
      { key:"statut", label:"Statut", filterable:true, get:o=>o._statutKey },
      { key:"affClient", label:"Affaires client", numeric:true, get:o=>o._affClient.length },
      { key:"affProspect", label:"Affaires prospect", numeric:true, get:o=>o._affProspect.length },
      { key:"affPartenaire", label:"Affaires partenaire", numeric:true, get:o=>o._affPartenaire.length },
    ];
    const rowHTML = o => `<tr class="row-clickable" data-id="${o.id}" style="cursor:pointer;">
        <td class="affaire-name">${esc(o.nom)}<span class="sub">${esc(o.adresse||"")}</span></td>
        <td>${o.type}</td>
        <td>${orgStatutPills({client:o._affClient.length, prospect:o._affProspect.length, partenaire:o._affPartenaire.length})}</td>
        <td class="num"><div class="num-voir">${o._affClient.length}${voirBtn(o,"client",o._affClient.length)}</div></td>
        <td class="num"><div class="num-voir">${o._affProspect.length}${voirBtn(o,"prospect",o._affProspect.length)}</div></td>
        <td class="num"><div class="num-voir">${o._affPartenaire.length}${voirBtn(o,"partenaire",o._affPartenaire.length)}</div></td>
      </tr>`;
    renderSortFilterTable("table-organisations", list, columns, rowHTML, {
      rerender: renderOrganisations,
      emptyMsg: "Aucune organisation.",
      afterRender: table => {
        table.querySelectorAll(".btn-voir").forEach(btn=>{
          btn.addEventListener("click", (e)=>{
            e.stopPropagation();
            if(btn.disabled) return;
            openOrgAffairesList(btn.dataset.org, btn.dataset.role);
          });
        });
        table.querySelectorAll("tr[data-id]").forEach(tr=>{
          tr.addEventListener("click", ()=>openModifierOrg(tr.dataset.id));
        });
      },
      tfoot: display => `<tfoot><tr>
          <td colspan="3">Total (${display.length} organisation${display.length>1?"s":""})</td>
          <td class="num">${display.reduce((s,o)=>s+o._affClient.length,0)}</td>
          <td class="num">${display.reduce((s,o)=>s+o._affProspect.length,0)}</td>
          <td class="num">${display.reduce((s,o)=>s+o._affPartenaire.length,0)}</td>
        </tr></tfoot>`,
    });
  }

  // Ouvre la fenêtre listant les affaires d'une organisation pour un rôle donné (client /
  // prospect / partenaire), avec le même format de tableau que la page Affaires (portefeuille).
  // Cliquer sur une ligne ferme cette fenêtre et ouvre directement la fiche de l'affaire.
  function openOrgAffairesList(orgId, role){
    const org = organisations.find(o=>o.id===orgId);
    if(!org) return;
    const byRole = {
      client:     { list: orgAffairesClient(orgId),     label: "Affaires client" },
      prospect:   { list: orgAffairesProspect(orgId),   label: "Affaires prospect" },
      partenaire: { list: orgAffairesPartenaire(orgId), label: "Affaires partenaire" },
    };
    const picked = byRole[role];
    if(!picked) return;
    document.getElementById("modal-org-affaires-title").textContent = `${picked.label} — ${org.nom}`;
    const list = picked.list.map(affaireWithCalc);
    renderSortFilterTable("table-org-affaires", list, affairesTableColumns(), affaireRowHTML, {
      rerender: ()=>openOrgAffairesList(orgId, role),
      emptyMsg: "Aucune affaire.",
      afterRender: table => table.querySelectorAll("tr[data-id]").forEach(tr=>{
        tr.addEventListener("click", ()=>{
          closeModal("modal-org-affaires");
          openAffaireDetail(tr.dataset.id);
        });
      }),
      tfoot: affairesTfoot,
    });
    openModal("modal-org-affaires");
  }

  // Ouvre la fenêtre listant tous les frais saisis sur une affaire (tous consultants confondus,
  // refacturables et non refacturables mélangés) — accessible depuis le bouton « Voir les frais »
  // de la carte Frais du panneau Cohérence budgétaire.
  function openAffaireFraisList(affaireId){
    const a = affaires.find(x=>x.id===affaireId);
    if(!a) return;
    document.getElementById("modal-affaire-frais-title").textContent = `Frais — ${a.nom}`;

    function render(){
      const rows = notesFrais.filter(n=>n.affaireId===affaireId).slice().sort((x,y)=>y.date.localeCompare(x.date));
      const refTTC = rows.filter(r=>r.refacturable).reduce((s,r)=>s+r.montantTTC,0);
      const nonRefTTC = rows.filter(r=>!r.refacturable).reduce((s,r)=>s+r.montantTTC,0);
      document.getElementById("affaire-frais-sub").textContent =
        `${rows.length} frais — ${euroCents(refTTC)} refacturables (TTC) / ${euroCents(nonRefTTC)} non refacturables (TTC).`;

      const columns = [
        { key:"date", label:"Date", get:r=>r.date },
        { key:"consultant", label:"Consultant", filterable:true, get:r=>consultantName(r.consultantId) },
        { key:"categorie", label:"Sous-catégorie", filterable:true, get:r=>categorieFraisLabel(r.categorieFraisId) },
        { key:"refacturable", label:"Refacturable", filterable:true, get:r=>r.refacturable ? "Oui" : "Non" },
        { key:"ht", label:"Montant HT", numeric:true, get:r=>r.montantHT },
        { key:"tva", label:"TVA", numeric:true, filterable:true, get:r=>tvaTauxListLabel(r.lignesTVA) },
        { key:"ttc", label:"Montant TTC", numeric:true, get:r=>r.montantTTC },
        { key:"statut", label:"Statut", filterable:true, get:r=>fraisStatut(r) },
        { key:"commentaire", label:"Commentaires", sortable:false, get:r=>r.commentaire||"" },
      ];
      const rowHTML = r => {
        const cat = categorieFraisById(r.categorieFraisId);
        return `<tr>
          <td>${dateFR(r.date)}</td>
          <td>${esc(consultantName(r.consultantId))}</td>
          <td class="affaire-name">${cat ? esc(cat.label) : "—"}${cat ? `<span class="sub">${esc(cat.categorie)}</span>` : ""}</td>
          <td>${r.refacturable ? "Oui" : "Non"}</td>
          <td class="num">${euroCents(r.montantHT)}</td>
          <td class="num">${tvaTauxListLabel(r.lignesTVA)}</td>
          <td class="num">${euroCents(r.montantTTC)}</td>
          <td>${fraisStatutPill(fraisStatut(r))}<span style="display:block;font-size:.72rem;color:var(--text-muted);font-family:var(--font-mono);margin-top:3px;">${esc(r.numeroBordereau)}</span></td>
          <td style="color:var(--text-muted);">${r.commentaire ? esc(r.commentaire) : "—"}</td>
        </tr>`;
      };
      renderSortFilterTable("table-affaire-frais", rows, columns, rowHTML, {
        rerender: render,
        emptyMsg: "Aucun frais saisi sur cette affaire.",
        tfoot: display => `<tfoot><tr>
            <td colspan="4">Total (${display.length} frais)</td>
            <td class="num">${euroCents(display.reduce((s,r)=>s+r.montantHT,0))}</td>
            <td></td>
            <td class="num">${euroCents(display.reduce((s,r)=>s+r.montantTTC,0))}</td>
            <td></td>
            <td></td>
          </tr></tfoot>`,
      });
    }
    render();
    openModal("modal-affaire-frais");
  }

  // Ouvre le détail d'une note de frais (bordereau) — liste tous les frais qui la composent, tous
  // affectés au même consultant, avec le même statut (dérivé du bordereau, voir fraisStatut) ; c'est
  // pourquoi la colonne Statut n'a pas besoin d'être répétée ligne par ligne comme dans « Voir les
  // frais » d'une affaire, elle est déjà donnée une fois dans le sous-titre. Accessible en cliquant
  // sur une ligne de la table « Notes de frais » de Cabinet > Frais ; l'action « Marquer comme payée »
  // y est reprise, identique à celle du tableau, pour rester utilisable depuis le détail directement.
  function openBordereauDetail(numero){
    const b = bordereauByNumero(numero);
    if(!b) return;
    document.getElementById("modal-bordereau-title").textContent = `Note de frais — ${b.numero}`;

    function render(){
      const rows = notesFrais.filter(n=>n.numeroBordereau===numero).slice().sort((x,y)=>y.date.localeCompare(x.date));
      const ttc = rows.reduce((s,n)=>s+n.montantTTC,0);
      document.getElementById("bordereau-sub").innerHTML =
        `${esc(consultantName(b.consultantId))} — ${bordereauStatutPill(b.statut)} — ${rows.length} frais, ${euroCents(ttc)} TTC${b.datePaiement ? ` — payée le ${dateFR(b.datePaiement)}` : ""}`;

      const columns = [
        { key:"date", label:"Date", get:r=>r.date },
        { key:"affaire", label:"Affaire / Interne", filterable:true, get:r=>fraisCibleLabel(r) },
        { key:"categorie", label:"Sous-catégorie", filterable:true, get:r=>categorieFraisLabel(r.categorieFraisId) },
        { key:"refacturable", label:"Refacturable", filterable:true, get:r=>r.affaireId ? (r.refacturable ? "Oui" : "Non") : "—" },
        { key:"ht", label:"Montant HT", numeric:true, get:r=>r.montantHT },
        { key:"tva", label:"TVA", numeric:true, filterable:true, get:r=>tvaTauxListLabel(r.lignesTVA) },
        { key:"ttc", label:"Montant TTC", numeric:true, get:r=>r.montantTTC },
        { key:"commentaire", label:"Commentaires", sortable:false, get:r=>r.commentaire||"" },
      ];
      const rowHTML = r => {
        const cat = categorieFraisById(r.categorieFraisId);
        return `<tr>
          <td>${dateFR(r.date)}</td>
          <td>${esc(fraisCibleLabel(r))}</td>
          <td class="affaire-name">${cat ? esc(cat.label) : "—"}${cat ? `<span class="sub">${esc(cat.categorie)}</span>` : ""}</td>
          <td>${r.affaireId ? (r.refacturable ? "Oui" : "Non") : "—"}</td>
          <td class="num">${euroCents(r.montantHT)}</td>
          <td class="num">${tvaTauxListLabel(r.lignesTVA)}</td>
          <td class="num">${euroCents(r.montantTTC)}</td>
          <td style="color:var(--text-muted);">${r.commentaire ? esc(r.commentaire) : "—"}</td>
        </tr>`;
      };
      renderSortFilterTable("table-bordereau-frais", rows, columns, rowHTML, {
        rerender: render,
        emptyMsg: "Aucun frais sur cette note.",
        tfoot: display => `<tfoot><tr>
            <td colspan="4">Total (${display.length} frais)</td>
            <td class="num">${euroCents(display.reduce((s,r)=>s+r.montantHT,0))}</td>
            <td></td>
            <td class="num">${euroCents(display.reduce((s,r)=>s+r.montantTTC,0))}</td>
            <td></td>
          </tr></tfoot>`,
      });

      const btnPayer = document.getElementById("btn-bordereau-payer");
      btnPayer.hidden = b.statut!=="note à payer";
      btnPayer.onclick = ()=>{
        marquerBordereauPaye(b.numero);
        toast("Note marquée payée");
        render();
        renderAdminBordereaux();
      };
    }
    render();
    openModal("modal-bordereau");
  }

  // Combobox de recherche générique : remplace un <select> par un champ texte filtrant une liste
  // déroulante, pour rester utilisable quand la liste sous-jacente grossit (ex. l'organisation
  // d'une affaire, une fois qu'on a une centaine de clients). getItems() est appelé à chaque
  // ouverture de la liste plutôt que figé une fois pour toutes, pour refléter les ajouts/renommages
  // (ex. une organisation créée entre-temps depuis la fiche Organisations).
  function initCombobox(inputId, hiddenId, listId, getItems, getLabel, getId){
    const input = document.getElementById(inputId);
    const hidden = document.getElementById(hiddenId);
    const list = document.getElementById(listId);
    let filtered = [];
    let activeIdx = -1;

    function currentLabel(){
      const item = getItems().find(x=>getId(x)===hidden.value);
      return item ? getLabel(item) : "";
    }
    function updateActive(){
      list.querySelectorAll(".combobox-item").forEach((el,i)=>el.classList.toggle("active", i===activeIdx));
      const activeEl = list.querySelector(".combobox-item.active");
      if(activeEl) activeEl.scrollIntoView({block:"nearest"});
    }
    function openList(query){
      const q = query.trim().toLowerCase();
      filtered = getItems().filter(x=>getLabel(x).toLowerCase().includes(q));
      activeIdx = filtered.findIndex(x=>getId(x)===hidden.value);
      list.innerHTML = filtered.length
        ? filtered.map((x,i)=>`<div class="combobox-item${i===activeIdx?" active":""}" data-idx="${i}">${esc(getLabel(x))}</div>`).join("")
        : `<div class="combobox-empty">Aucun résultat</div>`;
      list.hidden = false;
    }
    function closeList(){ list.hidden = true; activeIdx = -1; }
    function select(item){
      hidden.value = getId(item);
      input.value = getLabel(item);
      closeList();
    }
    input.addEventListener("focus", ()=>openList(""));
    input.addEventListener("input", ()=>openList(input.value));
    input.addEventListener("keydown", e=>{
      if(list.hidden){
        if(e.key==="ArrowDown" || e.key==="ArrowUp"){ e.preventDefault(); openList(""); }
        return;
      }
      if(e.key==="ArrowDown"){ e.preventDefault(); activeIdx = Math.min(filtered.length-1, activeIdx+1); updateActive(); }
      else if(e.key==="ArrowUp"){ e.preventDefault(); activeIdx = Math.max(0, activeIdx-1); updateActive(); }
      else if(e.key==="Enter"){ if(filtered[activeIdx]){ e.preventDefault(); select(filtered[activeIdx]); } }
      else if(e.key==="Escape"){ closeList(); input.value = currentLabel(); }
    });
    // mousedown (pas click) : se déclenche avant le blur du champ texte, pour que la sélection
    // s'applique avant que le blur ne referme la liste et ne réinitialise le texte saisi.
    list.addEventListener("mousedown", e=>{
      const el = e.target.closest(".combobox-item");
      if(!el) return;
      e.preventDefault();
      const item = filtered[+el.dataset.idx];
      if(item) select(item);
    });
    input.addEventListener("blur", ()=>{ closeList(); input.value = currentLabel(); });

    return {
      setValue(id){ hidden.value = id || ""; input.value = currentLabel(); },
      refresh(){ input.value = currentLabel(); },
    };
  }

  let orgCombobox = null;
  function populateOrgSelect(){
    if(!orgCombobox){
      orgCombobox = initCombobox("a-org-search", "a-org", "a-org-list", ()=>organisations, o=>o.nom, o=>o.id);
    } else {
      orgCombobox.refresh();
    }
  }
  function populateConsultantSelects(){
    const optsPilotes = consultants.filter(c=>c.statut==="en poste").map(c=>`<option value="${esc(c.id)}">${esc(c.nom)}</option>`).join("");
    const optsExecutants = consultants.filter(c=>c.statut!=="parti").map(c=>`<option value="${esc(c.id)}">${esc(c.nom)}${c.statut==="stagiaire"?" (stagiaire)":""}</option>`).join("");
    document.getElementById("a-pilote-comm").innerHTML = optsPilotes;
    document.getElementById("a-pilote").innerHTML = optsPilotes;
    document.getElementById("m-consultant").innerHTML = optsExecutants;
  }

  function openModal(id){ document.getElementById(id).hidden = false; }
  function closeModal(id){ document.getElementById(id).hidden = true; }

  let currentEditOrgId = null;
  function openNouvelleOrg(){
    currentEditOrgId = null;
    document.getElementById("modal-org-title").textContent = "Nouvelle organisation";
    document.getElementById("o-nom").value = "";
    document.getElementById("o-adresse").value = "";
    document.getElementById("o-type").value = "Collectivité";
    openModal("modal-org");
  }
  function openModifierOrg(orgId){
    const o = organisations.find(x=>x.id===orgId);
    if(!o) return;
    currentEditOrgId = orgId;
    document.getElementById("modal-org-title").textContent = "Modifier l'organisation";
    document.getElementById("o-nom").value = o.nom;
    document.getElementById("o-adresse").value = o.adresse || "";
    document.getElementById("o-type").value = o.type;
    openModal("modal-org");
  }
  function saveOrg(){
    const nom = document.getElementById("o-nom").value.trim();
    if(!nom){ toast("Le nom de l'organisation est obligatoire"); return; }
    const adresse = document.getElementById("o-adresse").value.trim();
    const type = document.getElementById("o-type").value;
    if(currentEditOrgId){
      const o = organisations.find(x=>x.id===currentEditOrgId);
      Object.assign(o, { nom, adresse, type });
      toast("Organisation mise à jour");
    } else {
      organisations.push({ id:newEntityId("O"), nom, adresse, type });
      toast("Organisation créée");
    }
    closeModal("modal-org");
    renderOrganisations();
    populateOrgSelect();
  }

  /* ================= Consultants (Cabinet > Consultants) ================= */
  let currentEditConsultantId = null;
  let editingPartiel = [];

  function partielRowHTML(p, i){
    return `<div class="partiel-row" data-idx="${i}" style="display:flex;gap:10px;align-items:flex-end;margin-bottom:8px;">
        <div class="field" style="flex:1;"><label>Début</label><input type="date" class="cp-debut" value="${p.debut||""}"></div>
        <div class="field" style="flex:1;"><label>Fin (vide = en cours)</label><input type="date" class="cp-fin" value="${p.fin||""}"></div>
        <div class="field" style="width:90px;"><label>% temps</label><input type="number" class="cp-pct" min="1" max="100" step="5" value="${p.pct}"></div>
        <button type="button" class="btn ghost cp-remove" style="height:38px;" title="Supprimer cette période">✕</button>
      </div>`;
  }
  function renderPartielEditor(){
    const wrap = document.getElementById("c-partiel-list");
    wrap.innerHTML = editingPartiel.length
      ? editingPartiel.map(partielRowHTML).join("")
      : `<div style="font-size:.82rem;color:var(--text-muted);">Aucune période — temps plein sur toute la présence.</div>`;
    wrap.querySelectorAll(".partiel-row").forEach(row=>{
      const idx = +row.dataset.idx;
      row.querySelector(".cp-debut").addEventListener("change", e=>{ editingPartiel[idx].debut = e.target.value; });
      row.querySelector(".cp-fin").addEventListener("change", e=>{ editingPartiel[idx].fin = e.target.value || null; });
      row.querySelector(".cp-pct").addEventListener("change", e=>{ editingPartiel[idx].pct = +e.target.value; });
      row.querySelector(".cp-remove").addEventListener("click", ()=>{ editingPartiel.splice(idx,1); renderPartielEditor(); });
    });
  }
  function updateConsultantFormVisibility(){
    const statut = document.getElementById("c-statut").value;
    document.getElementById("c-partiel-wrap").hidden = statut==="stagiaire";
    document.getElementById("c-stagiaire-note").hidden = statut!=="stagiaire";
  }

  // Trigramme réglementaire : 2 premières lettres du prénom + 1ʳᵉ lettre du nom (accents retirés),
  // rendu unique en cas d'homonymie (2ᵉ « Prénom Nom » → PRN2, etc.) — utilisé dans les numéros de
  // notes de frais (FRAIS_<trigramme>_<année>_<n°>).
  function computeTrigramme(nom){
    const strip = s => (s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[^A-Z]/g,"");
    const parts = (nom||"").trim().split(/\s+/).filter(Boolean);
    const prenom = strip(parts[0]);
    const famille = strip(parts.slice(1).join(""));
    let base = ((prenom.slice(0,2)||"XX") + (famille.slice(0,1)||"X")).slice(0,3);
    base = (base+"XXX").slice(0,3);
    let trig = base, n = 2;
    while(consultants.some(c=>c.trigramme===trig)){ trig = base.slice(0,2) + (n++); }
    return trig;
  }
  function makeConsultantId(nom){
    const parts = nom.trim().split(/\s+/).filter(Boolean);
    let base = ((parts[0]?.[0]||"X") + (parts[1]||parts[0]||"XX").slice(0,2)).toUpperCase().replace(/[^A-ZÀ-Ÿ]/g,"X");
    base = (base+"XXX").slice(0,3);
    let id = base, n = 1;
    while(consultants.some(c=>c.id===id)){ id = base.slice(0,2) + (n++); }
    return id;
  }

  function openNouveauConsultant(){
    currentEditConsultantId = null;
    editingPartiel = [];
    document.getElementById("modal-consultant-title").textContent = "Nouveau consultant";
    document.getElementById("c-nom").value = "";
    document.getElementById("c-statut").value = "en poste";
    document.getElementById("c-tjm").value = 550;
    document.getElementById("c-embauche").value = `${CURRENT_YEAR}-01-01`;
    document.getElementById("c-depart").value = "";
    document.getElementById("c-admin").checked = false;
    document.getElementById("alert-consultant-dates").classList.remove("show");
    document.getElementById("alert-consultant-partiel").classList.remove("show");
    renderPartielEditor();
    updateConsultantFormVisibility();
    openModal("modal-consultant");
  }
  function openModifierConsultant(id){
    const c = consultants.find(x=>x.id===id);
    if(!c) return;
    currentEditConsultantId = id;
    editingPartiel = (c.tempsPartiel||[]).map(p=>({...p}));
    document.getElementById("modal-consultant-title").textContent = "Modifier le consultant";
    document.getElementById("c-nom").value = c.nom;
    document.getElementById("c-statut").value = c.statut;
    document.getElementById("c-tjm").value = c.tjmBase;
    document.getElementById("c-embauche").value = c.dateEmbauche;
    document.getElementById("c-depart").value = c.dateDepart || "";
    document.getElementById("c-admin").checked = !!c.admin;
    document.getElementById("alert-consultant-dates").classList.remove("show");
    document.getElementById("alert-consultant-partiel").classList.remove("show");
    renderPartielEditor();
    updateConsultantFormVisibility();
    openModal("modal-consultant");
  }
  function saveConsultant(){
    const nom = document.getElementById("c-nom").value.trim();
    if(!nom){ toast("Le nom du consultant est obligatoire"); return; }
    const statut = document.getElementById("c-statut").value;
    const tjmBase = +document.getElementById("c-tjm").value || 0;
    const dateEmbauche = document.getElementById("c-embauche").value;
    if(!dateEmbauche){ toast("La date d'arrivée est obligatoire"); return; }
    const dateDepart = document.getElementById("c-depart").value || null;
    const admin = document.getElementById("c-admin").checked;

    const datesAlert = document.getElementById("alert-consultant-dates");
    const partielAlert = document.getElementById("alert-consultant-partiel");
    datesAlert.classList.remove("show");
    partielAlert.classList.remove("show");

    if((statut==="stagiaire" || statut==="parti") && !dateDepart){
      datesAlert.querySelector("span").textContent = "Merci de renseigner une date de départ pour un statut « stagiaire » ou « parti ».";
      datesAlert.classList.add("show");
      return;
    }
    if(dateDepart && dateDepart < dateEmbauche){
      datesAlert.querySelector("span").textContent = "La date de départ ne peut pas être antérieure à la date d'arrivée.";
      datesAlert.classList.add("show");
      return;
    }

    let tempsPartiel = [];
    if(statut !== "stagiaire"){
      for(const p of editingPartiel){
        if(!p.debut || !p.pct || p.pct<=0 || p.pct>100 || (p.fin && p.fin<p.debut)){
          partielAlert.querySelector("span").textContent = "Une période de temps partiel est incomplète ou invalide (dates, % entre 1 et 100).";
          partielAlert.classList.add("show");
          return;
        }
      }
      const sorted = editingPartiel.slice().sort((a,b)=>a.debut.localeCompare(b.debut));
      for(let i=1;i<sorted.length;i++){
        const prevFin = sorted[i-1].fin || "9999-12-31";
        if(sorted[i].debut <= prevFin){
          partielAlert.querySelector("span").textContent = "Les périodes de temps partiel ne doivent pas se chevaucher.";
          partielAlert.classList.add("show");
          return;
        }
      }
      tempsPartiel = sorted;
    }

    if(currentEditConsultantId){
      const c = consultants.find(x=>x.id===currentEditConsultantId);
      Object.assign(c, { nom, statut, tjmBase, dateEmbauche, dateDepart, admin, tempsPartiel });
      toast("Consultant mis à jour");
    } else {
      const id = makeConsultantId(nom);
      const trigramme = computeTrigramme(nom);
      consultants.push({ id, nom, trigramme, statut, tjmBase, dateEmbauche, dateDepart, admin, tempsPartiel });
      toast("Consultant créé");
    }
    closeModal("modal-consultant");
    renderConsultants();
    // Note : ne PAS appeler renderIdentify() ici — il réaffiche l'écran de connexion et masque
    // toute l'application alors que la session reste valide (reliquat du prototype, où cette fonction
    // reconstruisait la liste de sélection d'utilisateur). La liste des consultants suffit.
    populateConsultantSelects();
    if(currentView==="societe") renderSociete();
  }

  function renderConsultants(){
    const year = String(CURRENT_YEAR);
    const list = consultants.map(c=>({ ...c, _etp: computeConsultantETP(c, year) }));
    const cols = [
      { key:"nom", label:"Consultant", get:c=>c.nom },
      { key:"trigramme", label:"Trigramme", get:c=>c.trigramme||"" },
      { key:"statut", label:"Statut", filterable:true, get:c=>c.statut },
      { key:"embauche", label:"Arrivée", get:c=>c.dateEmbauche },
      { key:"depart", label:"Départ", get:c=>c.dateDepart||"" },
      { key:"tjm", label:"TJM objectif", numeric:true, get:c=>c.tjmBase },
      { key:"partiel", label:"Temps partiel", numeric:true, get:c=>(c.tempsPartiel||[]).length },
      { key:"etp", label:`ETP ${year}`, numeric:true, get:c=>c._etp },
    ];
    const rowHTML = c => `<tr class="row-clickable" data-id="${c.id}" style="cursor:pointer;">
        <td class="affaire-name">${esc(c.nom)}${c.admin?`<span class="sub">Administrateur</span>`:""}</td>
        <td style="font-family:var(--font-mono);">${c.trigramme?esc(c.trigramme):"—"}</td>
        <td>${consultantStatutPill(c.statut)}</td>
        <td>${dateFR(c.dateEmbauche)}</td>
        <td>${c.dateDepart ? dateFR(c.dateDepart) : "—"}</td>
        <td class="num">${euro(c.tjmBase)}</td>
        <td>${c.statut==="stagiaire" ? "25% (forfait stagiaire)" : ((c.tempsPartiel&&c.tempsPartiel.length) ? c.tempsPartiel.map(p=>`${p.pct}% du ${dateFR(p.debut)}${p.fin?` au ${dateFR(p.fin)}`:" (en cours)"}`).join("<br>") : "Temps plein")}</td>
        <td class="num">${etpFmt(c._etp)}</td>
        <td><button type="button" class="btn-voir" data-voir="${c.id}">Voir sa page</button></td>
      </tr>`;
    renderSortFilterTable("table-consultants", list, cols, rowHTML, {
      rerender: renderConsultants,
      emptyMsg: "Aucun consultant.",
      extraHeadCols: `<th></th>`,
      afterRender: table => {
        table.querySelectorAll("tr[data-id]").forEach(tr=>{
          tr.addEventListener("click", ()=>openModifierConsultant(tr.dataset.id));
        });
        table.querySelectorAll("[data-voir]").forEach(btn=>{
          btn.addEventListener("click", e=>{
            e.stopPropagation();
            voirPageConsultant(btn.dataset.voir);
          });
        });
      },
      tfoot: display => `<tfoot><tr>
          <td colspan="7">Total (${display.length} consultant${display.length>1?"s":""})</td>
          <td class="num">${etpFmt(display.reduce((s,c)=>s+c._etp,0))}</td>
          <td></td>
        </tr></tfoot>`,
    });
  }

  // Vue d'ensemble (Cabinet > Frais) de toutes les notes de frais, tous consultants confondus,
  // avec l'action « Marquer comme payée » sur celles au statut « note à payer ».
  function renderAdminBordereaux(){
    const list = bordereauxFrais.slice().sort((a,b)=>b.numero.localeCompare(a.numero));
    const columns = [
      { key:"numero", label:"Numéro", get:b=>b.numero },
      { key:"consultant", label:"Consultant", filterable:true, get:b=>consultantName(b.consultantId) },
      { key:"annee", label:"Année", get:b=>b.annee },
      { key:"nb", label:"Frais", numeric:true, get:b=>notesFrais.filter(n=>n.numeroBordereau===b.numero).length },
      { key:"ttc", label:"Montant TTC", numeric:true, get:b=>notesFrais.filter(n=>n.numeroBordereau===b.numero).reduce((s,n)=>s+n.montantTTC,0) },
      { key:"statut", label:"Statut", filterable:true, get:b=>b.statut },
      { key:"paiement", label:"Date de paiement", get:b=>b.datePaiement||"" },
    ];
    const rowHTML = b => {
      const frais = notesFrais.filter(n=>n.numeroBordereau===b.numero);
      const ttc = frais.reduce((s,n)=>s+n.montantTTC,0);
      const action = b.statut==="note à payer"
        ? `<button type="button" class="btn-voir" data-payer="${esc(b.numero)}">Marquer comme payée</button>`
        : "—";
      return `<tr class="row-clickable" data-id="${esc(b.numero)}" style="cursor:pointer;">
        <td style="font-family:var(--font-mono);">${esc(b.numero)}</td>
        <td>${esc(consultantName(b.consultantId))}</td>
        <td>${b.annee}</td>
        <td class="num">${frais.length}</td>
        <td class="num">${euroCents(ttc)}</td>
        <td>${bordereauStatutPill(b.statut)}</td>
        <td>${b.datePaiement ? dateFR(b.datePaiement) : "—"}</td>
        <td>${action}</td>
      </tr>`;
    };
    renderSortFilterTable("table-admin-bordereaux", list, columns, rowHTML, {
      rerender: renderAdminBordereaux,
      emptyMsg: "Aucune note de frais pour l'instant.",
      extraHeadCols: `<th></th>`,
      afterRender: table => {
        table.querySelectorAll("tr[data-id]").forEach(tr=>{
          tr.addEventListener("click", ()=>openBordereauDetail(tr.dataset.id));
        });
        table.querySelectorAll("[data-payer]").forEach(btn=>{
          btn.addEventListener("click", e=>{
            e.stopPropagation();
            marquerBordereauPaye(btn.dataset.payer);
            toast("Note marquée payée");
            renderAdminBordereaux();
          });
        });
      },
      tfoot: display => `<tfoot><tr>
          <td colspan="3">Total (${display.length} note${display.length>1?"s":""} de frais)</td>
          <td class="num">${display.reduce((s,b)=>s+notesFrais.filter(n=>n.numeroBordereau===b.numero).length,0)}</td>
          <td class="num">${euroCents(display.reduce((s,b)=>s+notesFrais.filter(n=>n.numeroBordereau===b.numero).reduce((s2,n)=>s2+n.montantTTC,0),0))}</td>
          <td></td>
          <td></td>
          <td></td>
        </tr></tfoot>`,
    });
  }

  /* ================= Portefeuille (affaires) ================= */
  let filtrePortefeuille = new Set(["en commercialisation","en production"]);
  let rechercheAffaires = "";

  function renderFiltrePortefeuille(){
    const wrap = document.getElementById("filtre-statut-portefeuille");
    wrap.innerHTML = STATUTS_AFFAIRE.map(s=>`<button class="chip ${filtrePortefeuille.has(s)?"on":""}" data-s="${s}">${s}</button>`).join("");
    wrap.querySelectorAll(".chip").forEach(chip=>{
      chip.addEventListener("click", ()=>{
        const s = chip.dataset.s;
        if(filtrePortefeuille.has(s)) filtrePortefeuille.delete(s); else filtrePortefeuille.add(s);
        renderFiltrePortefeuille();
        renderPortefeuille();
      });
    });
  }

  function missionsBudgetSum(affaireId){
    return missions.filter(m=>m.affaireId===affaireId).reduce((s,m)=>s+m.enveloppe*m.taux,0);
  }
  function missionsJoursSum(affaireId){
    return missions.filter(m=>m.affaireId===affaireId).reduce((s,m)=>s+m.enveloppe,0);
  }
  // Montant total à payer aux sous-traitants indirects de l'affaire (seul rôle partenaire
  // représentant une charge à décaisser par le cabinet — les autres rôles ne rentrent pas
  // dans le budget à décomposer).
  function sousTraitanceSum(affaire){
    return (affaire.partenaires||[]).filter(p=>p.role==="sous-traitant indirect").reduce((s,p)=>s+(p.montant||0),0);
  }
  // Frais réellement saisis sur l'affaire (notesFrais), toujours en montant TTC dans la cohérence
  // budgétaire (contrairement aux missions, qui restent en HT — un frais engagé coûte au cabinet
  // sa TVA incluse). Seuls les frais marqués « refacturables » viennent s'imputer sur l'enveloppe
  // « Frais Cabinet » de l'affaire ; les frais non refacturables restent hors budget affaire (charge
  // non recouvrée auprès du client).
  function fraisRefacturablesSum(affaireId){
    return notesFrais.filter(n=>n.affaireId===affaireId && n.refacturable).reduce((s,n)=>s+n.montantTTC,0);
  }
  function fraisNonRefacturablesSum(affaireId){
    return notesFrais.filter(n=>n.affaireId===affaireId && !n.refacturable).reduce((s,n)=>s+n.montantTTC,0);
  }

  /* ================= Bordereaux de frais (remboursement) ================= */
  function bordereauNumero(trigramme, annee, seq){
    return `FRAIS_${trigramme}_${annee}_${String(seq).padStart(3,"0")}`;
  }
  function bordereauByNumero(numero){
    return bordereauxFrais.find(b=>b.numero===numero);
  }
  // Renvoie le bordereau « en saisie » du consultant pour l'année en cours, ou en crée un nouveau
  // (numéro suivant de sa séquence annuelle) si aucun n'est ouvert — c'est sur ce bordereau que
  // s'accroche tout nouveau frais saisi (saveFrais), jusqu'à ce que le consultant demande le
  // paiement (demanderPaiementBordereau), qui ferme le bordereau ; le frais suivant en rouvre un.
  function getOrCreateOpenBordereau(consultantId){
    let b = bordereauxFrais.find(x=>x.consultantId===consultantId && x.annee===CURRENT_YEAR && x.statut==="en saisie");
    if(b) return b;
    const c = consultants.find(x=>x.id===consultantId);
    const trigramme = c?.trigramme || "XXX";
    const seq = bordereauxFrais.filter(x=>x.consultantId===consultantId && x.annee===CURRENT_YEAR).length + 1;
    b = { numero: bordereauNumero(trigramme, CURRENT_YEAR, seq), consultantId, annee:CURRENT_YEAR, seq, statut:"en saisie", datePaiement:null };
    bordereauxFrais.push(b);
    return b;
  }
  // Demande de paiement (action du consultant, depuis « Mes frais ») : ferme le bordereau ouvert et
  // fait passer tous ses frais en « à payer » (dérivé, voir fraisStatut).
  function demanderPaiementBordereau(numero){
    const b = bordereauByNumero(numero);
    if(!b || b.statut!=="en saisie") return;
    b.statut = "note à payer";
  }
  // Marque le bordereau payé (action côté cabinet, depuis Cabinet > Frais) : date de paiement du
  // jour, tous ses frais passent en « remboursé ».
  function marquerBordereauPaye(numero){
    const b = bordereauByNumero(numero);
    if(!b || b.statut!=="note à payer") return;
    b.statut = "payée";
    b.datePaiement = today.toISOString().slice(0,10);
  }
  const BORDEREAU_TO_FRAIS_STATUT = { "en saisie":"saisi", "note à payer":"à payer", "payée":"remboursé" };
  function fraisStatut(n){
    const b = bordereauByNumero(n.numeroBordereau);
    return b ? (BORDEREAU_TO_FRAIS_STATUT[b.statut] || "saisi") : "saisi";
  }
  function bordereauStatutPill(s){
    const map = { "en saisie":"neutral", "note à payer":"warn", "payée":"good" };
    return `<span class="pill ${map[s]||"neutral"}">${s}</span>`;
  }
  function fraisStatutPill(s){
    const map = { "saisi":"neutral", "à payer":"warn", "remboursé":"good" };
    return `<span class="pill ${map[s]||"neutral"}">${s}</span>`;
  }

  // Le budget vendu (affaire.budget) est censé se répartir intégralement entre le budget des
  // missions, les frais optionnels et, le cas échéant, la sous-traitance à payer. La cohérence
  // compare donc la somme de ces trois lignes au budget vendu.
  function coherenceInfo(affaire){
    const missionsSum = missionsBudgetSum(affaire.id);
    const frais = affaire.frais || 0;
    const sousTraitance = sousTraitanceSum(affaire);
    const sum = missionsSum + frais + sousTraitance;
    const ref = affaire.budget;
    let level = "good", label = "Réparti = budget vendu", short = "cohérent";
    if(sum > ref + 1e-6){ level="danger"; label = "Missions + frais + sous-traitance au-delà du budget vendu"; short = "dépassement"; }
    else if(sum < ref - 1e-6){ level="warn"; label = "Budget pas encore totalement réparti"; short = "à répartir"; }
    return { sum, ref, level, label, short, missionsSum, frais, sousTraitance };
  }

  // --- Facturation : calculs et alertes ------------------------------------
  function factureTVA(f){ return f.formation ? 0 : 20; }
  function factureMontantMissionTTC(f){ return f.montantMissionHT * (1 + factureTVA(f)/100); }
  function factureMontantSousTraitanceTTC(f){ return f.montantSousTraitanceHT * (1 + factureTVA(f)/100); }
  function factureTotalHT(f){ return f.montantMissionHT + f.montantSousTraitanceHT; } // frais sans détail HT, affiché à part
  function factureTotalTTC(f){ return factureMontantMissionTTC(f) + f.montantFraisTTC + factureMontantSousTraitanceTTC(f); }
  function factureStatutPill(s){
    const map = { "prévisionnelle":"neutral", "facturée":"warn", "payée":"good", "annulée":"danger" };
    return `<span class="pill ${map[s]||"neutral"}">${s}</span>`;
  }
  function facturesAffaire(affaireId){ return factures.filter(f=>f.affaireId===affaireId); }
  function addDaysISO(iso, n){
    const d = new Date(iso+"T00:00:00");
    d.setDate(d.getDate()+n);
    return d.toISOString().slice(0,10);
  }
  // Périmètre des 2 alertes de cohérence/planification (3 et 4) : affaires arrivées au stade de
  // facturation possible — en production ou terminées, pas les affaires encore en commercialisation
  // ni les perdues.
  function affairesFacturables(){
    return affaires.filter(a=>a.statut==="en production" || a.statut==="terminée");
  }
  // 4 types d'alertes de facturation (5 situations demandées par l'utilisateur, dont 2 fusionnées —
  // voir le journal de retours) :
  //  1. Retard de dépôt : facture prévisionnelle dont l'échéance prévisionnelle est dépassée (J+XX).
  //  2. Retard de paiement : facture facturée non payée dont l'échéance de paiement (ou, à défaut,
  //     dépôt + 30 jours) est dépassée (J+XX).
  //  3. Écart de facturation : somme des factures (hors annulées) ≠ budget vendu de l'affaire.
  //  4. Facturation non planifiée : affaire en production/terminée sans aucune facture.
  function facturesAlertes(){
    const todayISO = today.toISOString().slice(0,10);
    const alertes = [];
    factures.forEach(f=>{
      if(f.statut==="prévisionnelle" && f.echeancePrev && f.echeancePrev < todayISO){
        const retard = joursEntre(f.echeancePrev, todayISO) - 1;
        alertes.push({ level:"danger", type:"retard-depot", affaireId:f.affaireId, factureId:f.id, retard,
          label:`Facture ${f.numero||"(numéro non renseigné)"} non déposée : échéance dépassée de J+${retard}`,
          detail:`Échéance prévisionnelle : ${dateFR(f.echeancePrev)}` });
      }
      if(f.statut==="facturée" && !f.payee){
        const seuil = f.echeancePaiementPrev || (f.dateDepot ? addDaysISO(f.dateDepot, 30) : null);
        if(seuil && todayISO > seuil){
          const retard = joursEntre(seuil, todayISO) - 1;
          alertes.push({ level:"warn", type:"retard-paiement", affaireId:f.affaireId, factureId:f.id, retard,
            label:`Facture ${f.numero||"(numéro non renseigné)"} facturée mais non payée : échéance de paiement dépassée de J+${retard}`,
            detail:`Déposée le ${dateFR(f.dateDepot)}` });
        }
      }
    });
    affairesFacturables().forEach(a=>{
      const list = facturesAffaire(a.id).filter(f=>f.statut!=="annulée");
      if(list.length===0){
        alertes.push({ level:"warn", type:"non-planifiee", affaireId:a.id, factureId:null,
          label:"Aucune facture échéancée sur cette affaire", detail:"" });
        return;
      }
      const sum = list.reduce((s,f)=>s+factureTotalHT(f)+f.montantFraisTTC,0);
      if(Math.abs(sum - a.budget) > 1e-6){
        alertes.push({ level:"warn", type:"ecart", affaireId:a.id, factureId:null,
          label:`Écart entre l'échéancier de facturation (${euro(sum)}) et le budget vendu de l'affaire (${euro(a.budget)})`,
          detail:"" });
      }
    });
    return alertes;
  }

  // --- Répartition commerciale (Cabinet > Suivi commercial, Mon commercial) ---
  // Assiette prévisionnelle du budget "missions" d'une affaire, hors frais et sous-traitance —
  // c'est cette portion, et uniquement elle, qui se répartit entre consultants (affaire.repartitionCommerciale).
  // Prévisionnelle car calculée dès le dépôt de l'offre, avant même que des missions existent
  // (missionsBudgetSum(affaire.id) resterait à 0 tant que l'affaire n'est pas staffée).
  function budgetMissionsPrevisionnel(affaire){
    return Math.max(0, (affaire.budget||0) - (affaire.frais||0) - sousTraitanceSum(affaire));
  }
  // Répartition effective : celle saisie sur l'affaire si elle existe (lignes avec un consultant et
  // un % > 0), sinon 100% pour le pilote commercial par défaut — le pilote commercial reste donc
  // toujours le responsable désigné, la répartition n'étant qu'un partage optionnel de son crédit.
  function repartitionEffective(affaire){
    const rep = (affaire.repartitionCommerciale||[]).filter(r=>r.consultantId && r.pct>0);
    return rep.length ? rep : [{ consultantId: affaire.piloteCommercial, pct:100 }];
  }
  // Part (0 à 1) du budget missions de l'affaire créditée à ce consultant, pour le suivi commercial.
  function creditConsultantSurAffaire(affaire, consultantId){
    const r = repartitionEffective(affaire).find(x=>x.consultantId===consultantId);
    return r ? r.pct/100 : 0;
  }
  // Rôle d'un consultant crédité sur une affaire, pour scorer sa performance commerciale distinctement
  // selon qu'il a piloté l'offre ou seulement contribué : "pilote" s'il est le pilote commercial désigné
  // de l'affaire, "contributeur" s'il n'apparaît que dans la répartition sans en être le pilote, null s'il
  // n'est pas crédité du tout. Le montant ventilé (creditConsultantSurAffaire × budgetMissionsPrevisionnel)
  // s'applique de la même façon dans les deux cas — seul le regroupement des stats diffère.
  function roleConsultantSurAffaire(affaire, consultantId){
    if(creditConsultantSurAffaire(affaire, consultantId) <= 0) return null;
    return affaire.piloteCommercial === consultantId ? "pilote" : "contributeur";
  }

  /* ================= Suivi commercial (Cabinet > Suivi commercial, Mon commercial) =================
     Indicateurs clés + tableau détaillé + graphiques (répartition gagné/perdu/en décision, évolution
     par année, taux de transformation par type de vente, performance par pilote commercial — ce
     dernier société uniquement) + pipeline en attente (société uniquement), tous filtrés par année de
     dépôt de l'offre (pas par statut actuel — une offre déposée en 2026 reste dans le suivi 2026 même
     si elle est entre-temps gagnée ou perdue), sauf le graphique "évolution par année" et le pipeline
     en attente, volontairement indépendants de l'année (le second est une photo à l'instant présent).
     Reste à construire : le tableau des contacts. */
  function affairesDeposeesAnnee(year){
    return affaires.filter(a=>a.dateDepot && a.dateDepot.slice(0,4)===year);
  }
  function anneesDepot(){
    return Array.from(new Set(affaires.filter(a=>a.dateDepot).map(a=>a.dateDepot.slice(0,4)))).sort().reverse();
  }
  // Pipeline en attente (société uniquement, cf. cahier des charges V2 section 7.3) : photo à
  // l'instant présent de toutes les affaires en commercialisation, tous millésimes de dépôt confondus
  // — donc volontairement PAS basé sur affairesDeposeesAnnee(year), à la différence de tout le reste
  // de cette page.
  function pipelineEnAttente(){
    const list = affaires.filter(a=>a.statut==="en commercialisation");
    const nb = list.length;
    const montant = list.reduce((s,a)=>s+(a.budget||0),0);
    const jours = list.reduce((s,a)=>s+(a.jours||0),0);
    const montantPondere = list.reduce((s,a)=>s+(a.budget||0)*(a.pctReussite||0)/100,0);
    const joursPondere = list.reduce((s,a)=>s+(a.jours||0)*(a.pctReussite||0)/100,0);
    return { nb, montant, jours, montantPondere, joursPondere };
  }
  function commercialIndicateurs(list){
    const nb = list.length;
    const montant = list.reduce((s,a)=>s+(a.budget||0),0);
    const jours = list.reduce((s,a)=>s+(a.jours||0),0);
    // "Gagnées" = l'affaire a été remportée, que la mission soit désormais en production (statut
    // "en production" dans le cycle de vie de l'affaire) ou déjà terminée — à distinguer du statut
    // "en commercialisation" (offre encore en décision, ci-dessous "enCoursDecision") et de "perdue".
    const gagnees = list.filter(a=>a.statut==="en production" || a.statut==="terminée");
    const perdues = list.filter(a=>a.statut==="perdue");
    const enCoursDecision = list.filter(a=>a.statut==="en commercialisation");
    const tauxTransfo = (gagnees.length + perdues.length) ? gagnees.length/(gagnees.length+perdues.length) : null;
    const potentielPondere = enCoursDecision.reduce((s,a)=>s+(a.budget||0)*(a.pctReussite||0)/100, 0);
    const montantGagne = gagnees.reduce((s,a)=>s+(a.budget||0),0);
    const joursGagnes = gagnees.reduce((s,a)=>s+(a.jours||0),0);
    const montantPerdu = perdues.reduce((s,a)=>s+(a.budget||0),0);
    const montantEnDecision = enCoursDecision.reduce((s,a)=>s+(a.budget||0),0);
    return { nb, montant, jours, gagnees, perdues, enCoursDecision, tauxTransfo, potentielPondere, montantGagne, joursGagnes, montantPerdu, montantEnDecision };
  }
  const pctOrDash = n => n===null ? "—" : Math.round(n*100)+"%";
  // Équivalent de commercialIndicateurs mais ventilé pour un seul consultant (montants crédités selon
  // sa part de répartition sur chaque affaire, pas 100% de l'affaire) — sert au donut et à l'histogramme
  // d'évolution de "Mon commercial", en réutilisant les mêmes fonctions de rendu que pour la société.
  function commercialIndicateursMoi(list, consultantId){
    const part = a=>creditConsultantSurAffaire(a, consultantId);
    const gagnees = list.filter(a=>a.statut==="en production" || a.statut==="terminée");
    const perdues = list.filter(a=>a.statut==="perdue");
    const enCoursDecision = list.filter(a=>a.statut==="en commercialisation");
    const montantGagne = gagnees.reduce((s,a)=>s+budgetMissionsPrevisionnel(a)*part(a),0);
    const montantPerdu = perdues.reduce((s,a)=>s+budgetMissionsPrevisionnel(a)*part(a),0);
    const montantEnDecision = enCoursDecision.reduce((s,a)=>s+budgetMissionsPrevisionnel(a)*part(a),0);
    return { gagnees, perdues, enCoursDecision, montantGagne, montantPerdu, montantEnDecision };
  }

  /* ----- Graphiques du suivi commercial (société et "Mon commercial") -----
     Couleurs alignées sur les statuts déjà utilisés ailleurs dans l'outil (pastilles de statut,
     camembert de répartition des temps) : vert = gagné, jaune/ocre = encore en décision, rouge = perdu. */
  const COMMERCIAL_STATUT_COLOR = { gagne:"var(--brand-green)", enDecision:"var(--chart-yellow-3)", perdu:"var(--chart-red)" };

  // Donut Gagné / Perdu / En décision, basculable nombre ↔ montant. k peut venir de
  // commercialIndicateurs (société) ou commercialIndicateursMoi (personnel) — même forme de retour.
  let commercialDonutMetric = "nb";
  let commercialDonutMetricMoi = "nb";
  function commercialDonutData(k, metric){
    const val = (nb, montant) => metric==="montant" ? montant : nb;
    return [
      { label:"Gagné",       value: val(k.gagnees.length, k.montantGagne),       color: COMMERCIAL_STATUT_COLOR.gagne },
      { label:"En décision", value: val(k.enCoursDecision.length, k.montantEnDecision), color: COMMERCIAL_STATUT_COLOR.enDecision },
      { label:"Perdu",       value: val(k.perdues.length, k.montantPerdu),       color: COMMERCIAL_STATUT_COLOR.perdu },
    ];
  }
  function renderCommercialDonutChart(hostId, k, metric){
    const host = document.getElementById(hostId);
    if(!host) return;
    const data = commercialDonutData(k, metric);
    const fmt = metric==="montant" ? euro : (n=>Math.round(n).toLocaleString("fr-FR"));
    drawDonut(host, data, {
      tip: d=>`${d.label} : ${fmt(d.value)}${metric==="nb" ? " offre"+(d.value>1?"s":"") : ""}`,
      centerTotal: total=>fmt(total),
      centerCaption: metric==="nb"?"offres déposées":"déposés",
      emptyLabel: "Aucune donnée",
      ariaLabel: "Répartition gagné / perdu / en décision",
    });
  }
  function wireCommercialDonutToggle(wrapId, onToggle){
    const wrap = document.getElementById(wrapId);
    if(!wrap || wrap.dataset.wired) return;
    wrap.dataset.wired = "1";
    wrap.querySelectorAll(".chip").forEach(chip=>{
      chip.addEventListener("click", ()=>{
        wrap.querySelectorAll(".chip").forEach(c=>c.classList.toggle("on", c===chip));
        onToggle(chip.dataset.metric);
      });
    });
  }

  // Évolution par année de dépôt — toutes les années confondues (indépendant du sélecteur d'année de
  // la page, qui ne filtre que les indicateurs et le tableau) : une barre empilée gagné/perdu/en
  // décision par année, en montant €. consultantId optionnel : ventile les montants sur sa part.
  function commercialEvolutionAnnuelle(consultantId){
    const years = anneesDepot().slice().sort();
    const part = consultantId ? (a=>creditConsultantSurAffaire(a, consultantId)) : (()=>1);
    const montantDe = a => consultantId ? budgetMissionsPrevisionnel(a)*part(a) : (a.budget||0);
    return years.map(y=>{
      let list = affairesDeposeesAnnee(y);
      if(consultantId) list = list.filter(a=>creditConsultantSurAffaire(a, consultantId) > 0);
      const gagnees = list.filter(a=>a.statut==="en production" || a.statut==="terminée");
      const perdues = list.filter(a=>a.statut==="perdue");
      const enDecision = list.filter(a=>a.statut==="en commercialisation");
      return {
        label: y,
        gagne: gagnees.reduce((s,a)=>s+montantDe(a),0),
        perdu: perdues.reduce((s,a)=>s+montantDe(a),0),
        enDecision: enDecision.reduce((s,a)=>s+montantDe(a),0),
      };
    });
  }
  const COMMERCIAL_EVOL_CATS = [
    { key:"perdu",      label:"Perdu",       color: COMMERCIAL_STATUT_COLOR.perdu },
    { key:"enDecision", label:"En décision", color: COMMERCIAL_STATUT_COLOR.enDecision },
    { key:"gagne",      label:"Gagné",       color: COMMERCIAL_STATUT_COLOR.gagne },
  ];
  function renderCommercialEvolutionChart(hostId, data){
    const host = document.getElementById(hostId);
    if(!host) return;
    if(!data.length){ host.innerHTML = `<div class="chart-summary" style="color:var(--text-muted);">Aucune offre déposée pour l'instant.</div>`; return; }
    const totals = data.map(d=>COMMERCIAL_EVOL_CATS.reduce((s,c)=>s+d[c.key],0));
    const maxRaw = Math.max(0, ...totals);
    const max = maxRaw>0 ? maxRaw*1.15 : 1;
    const W=440, H=240, mL=52, mR=8, mT=12, mB=28;
    const plotW = W-mL-mR, plotH = H-mT-mB;
    const n = data.length;
    const barGap = n>1 ? Math.max(8, plotW/n*0.3) : 20;
    const barW = (plotW - barGap*(n-1))/n;
    const segGapPx = 2;

    let gridLines = "";
    const gridSteps = 4;
    for(let i=0;i<=gridSteps;i++){
      const v = max*i/gridSteps;
      const y = mT+plotH-(v/max)*plotH;
      gridLines += `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${W-mR}" y2="${y.toFixed(1)}" class="chart-grid"/>`;
      gridLines += `<text x="${mL-8}" y="${(y+3).toFixed(1)}" class="chart-axis-label" text-anchor="end">${euroCompact(v)}</text>`;
    }
    let bars = "";
    data.forEach((d,i)=>{
      const x = mL + i*(barW+barGap);
      const baseY = mT+plotH;
      const heights = COMMERCIAL_EVOL_CATS.map(c=> max>0 ? (d[c.key]/max)*plotH : 0);
      const visible = heights.map(h=>h>0.3);
      const lastVisibleIdx = visible.lastIndexOf(true);
      let cursorY = baseY, segs = "";
      heights.forEach((h,ci)=>{
        if(!visible[ci]) return;
        const isTop = ci===lastVisibleIdx;
        const gapAbove = ci===0 ? 0 : segGapPx;
        const hAdj = Math.max(0, h-gapAbove);
        const y = cursorY - gapAbove - hAdj;
        const cat = COMMERCIAL_EVOL_CATS[ci];
        const tip = `${d.label} — ${cat.label} : ${euro(d[cat.key])}`;
        segs += `<path d="${roundedTopBarPath(x,y,barW,hAdj,isTop?4:0)}" fill="${cat.color}" data-tip="${esc(tip)}"/>`;
        cursorY = y;
      });
      bars += `<g>${segs}<text x="${(x+barW/2).toFixed(1)}" y="${H-mB+18}" class="chart-axis-label" text-anchor="middle">${d.label}</text></g>`;
    });
    const legend = COMMERCIAL_EVOL_CATS.map(c=>`<div class="chart-summary-item"><span class="chart-swatch" style="background:${c.color};"></span>${c.label}</div>`).join("");
    host.innerHTML = `
      <div class="chart-summary chart-legend-wrap">${legend}</div>
      <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Évolution par année de dépôt">
        ${gridLines}
        ${bars}
      </svg>
    `;
    wireChartTooltips(host);
  }

  // Graphique en barres générique à une série, avec une info secondaire affichée au-dessus de chaque
  // barre (le volume déposé à côté du taux de transformation, ou le taux de réussite à côté du
  // montant crédité) — réutilisé pour "par type de vente" et "par pilote commercial".
  function renderCommercialBarChart(hostId, data, opts){
    const host = document.getElementById(hostId);
    if(!host) return;
    const { color="var(--brand-green)", formatAxis=v=>v, ariaLabel="", fixedMax=null } = opts||{};
    if(!data.length){ host.innerHTML = `<div class="chart-summary" style="color:var(--text-muted);">Aucune donnée.</div>`; return; }
    const maxRaw = Math.max(0, ...data.map(d=>d.value));
    const max = fixedMax!=null ? fixedMax : (maxRaw>0 ? maxRaw*1.25 : 1);
    const W=440, H=240, mL=48, mR=8, mT=24, mB=28;
    const plotW = W-mL-mR, plotH = H-mT-mB;
    const n = data.length;
    const barGap = n>1 ? Math.max(8, plotW/n*0.25) : 30;
    const barW = (plotW - barGap*(n-1))/n;

    let gridLines = "";
    const gridSteps = 4;
    for(let i=0;i<=gridSteps;i++){
      const v = max*i/gridSteps;
      const y = mT+plotH-(v/max)*plotH;
      gridLines += `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${W-mR}" y2="${y.toFixed(1)}" class="chart-grid"/>`;
      gridLines += `<text x="${mL-8}" y="${(y+3).toFixed(1)}" class="chart-axis-label" text-anchor="end">${formatAxis(v)}</text>`;
    }
    let bars = "";
    data.forEach((d,i)=>{
      const x = mL + i*(barW+barGap);
      const h = max>0 ? Math.max(0,(d.value/max)*plotH) : 0;
      const y = mT+plotH-h;
      const tip = d.tip || `${d.label} : ${formatAxis(d.value)}`;
      bars += `<g>
        <path d="${roundedTopBarPath(x,y,barW,h,4)}" fill="${color}" data-tip="${esc(tip)}"/>
        ${d.sub!=null ? `<text x="${(x+barW/2).toFixed(1)}" y="${(y-6).toFixed(1)}" class="chart-axis-label" text-anchor="middle">${esc(d.sub)}</text>` : ""}
        <text x="${(x+barW/2).toFixed(1)}" y="${H-mB+18}" class="chart-axis-label" text-anchor="middle">${esc(d.label)}</text>
      </g>`;
    });
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="${ariaLabel}">${gridLines}${bars}</svg>`;
    wireChartTooltips(host);
  }

  // Taux de transformation par type de vente, sur les offres du lot fourni dont la décision est prise
  // (gagnées + perdues) — celles encore en décision ne comptent pas dans le taux, comme pour le taux
  // de transformation global. Le montant déposé (toutes offres du type, décision prise ou non)
  // s'affiche au-dessus de chaque barre. consultantId optionnel : montant ventilé sur sa part.
  function commercialParTypeVente(list, consultantId){
    const types = Array.from(new Set(list.map(a=>a.typeVente))).filter(Boolean).sort();
    const montantDe = consultantId
      ? (a=>budgetMissionsPrevisionnel(a)*creditConsultantSurAffaire(a, consultantId))
      : (a=>a.budget||0);
    return types.map(t=>{
      const sub = list.filter(a=>a.typeVente===t);
      const gagnees = sub.filter(a=>a.statut==="en production" || a.statut==="terminée").length;
      const perdues = sub.filter(a=>a.statut==="perdue").length;
      const taux = (gagnees+perdues) ? gagnees/(gagnees+perdues) : null;
      const montant = sub.reduce((s,a)=>s+montantDe(a),0);
      const tip = `${t} : ${taux!==null ? Math.round(taux*100)+"%" : "taux non calculable"} (${sub.length} offre${sub.length>1?"s":""}, ${euro(montant)}${consultantId?" ventilés":" déposés"})`;
      return { label:t, value: taux!==null ? Math.round(taux*100) : 0, sub: euroCompact(montant), tip };
    });
  }

  // Variante société du graphique ci-dessus : un groupe de barres par type de vente, une barre par
  // année parmi les 3 dernières années de dépôt — volontairement indépendant du sélecteur d'année de
  // la page (comme "Évolution par année"), pour visualiser la tendance du taux de transformation de
  // chaque type de vente dans le temps plutôt qu'un seul instantané annuel.
  const TYPES_VENTE = ["Appel d'offres", "Appel à projet", "Gré à gré", "Bon de commande"];
  const TAUX_ANNEE_COLORS = ["var(--brand-green-tint)", "var(--brand-green)", "var(--brand-green-dark)"];
  function commercialTauxTypeVenteAnnuel(){
    const years = [String(CURRENT_YEAR-2), String(CURRENT_YEAR-1), String(CURRENT_YEAR)];
    return TYPES_VENTE.map(t=>({
      label: t,
      bars: years.map(y=>{
        const sub = affairesDeposeesAnnee(y).filter(a=>a.typeVente===t);
        const gagnees = sub.filter(a=>a.statut==="en production" || a.statut==="terminée").length;
        const perdues = sub.filter(a=>a.statut==="perdue").length;
        const taux = (gagnees+perdues) ? gagnees/(gagnees+perdues) : null;
        const tip = taux!==null
          ? `${t} ${y} : ${Math.round(taux*100)}% (${gagnees+perdues} offre${gagnees+perdues>1?"s":""} décidée${gagnees+perdues>1?"s":""})`
          : `${t} ${y} : aucune offre déposée`;
        return { year:y, value: taux!==null ? Math.round(taux*100) : 0, hasDecision: taux!==null, tip };
      }),
    }));
  }
  function renderCommercialGroupedBarChart(hostId, groups){
    const host = document.getElementById(hostId);
    if(!host) return;
    const years = groups[0] ? groups[0].bars.map(b=>b.year) : [];
    const W=440, H=240, mL=40, mR=8, mT=12, mB=28;
    const plotW = W-mL-mR, plotH = H-mT-mB;
    const max = 100; // taux en %, échelle toujours 0-100
    const n = groups.length;
    const groupGap = Math.max(10, plotW/n*0.18);
    const groupW = (plotW - groupGap*(n-1))/n;
    const barGapIn = 2;
    const nb = years.length || 1;
    const barW = (groupW - barGapIn*(nb-1))/nb;

    let gridLines = "";
    const gridSteps = 4;
    for(let i=0;i<=gridSteps;i++){
      const v = max*i/gridSteps;
      const y = mT+plotH-(v/max)*plotH;
      gridLines += `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${W-mR}" y2="${y.toFixed(1)}" class="chart-grid"/>`;
      gridLines += `<text x="${mL-8}" y="${(y+3).toFixed(1)}" class="chart-axis-label" text-anchor="end">${Math.round(v)}%</text>`;
    }
    let bars = "";
    groups.forEach((g,gi)=>{
      const gx = mL + gi*(groupW+groupGap);
      g.bars.forEach((b,bi)=>{
        const x = gx + bi*(barW+barGapIn);
        // hauteur plancher de 3px pour une année réellement décidée (y compris un taux de 0 %), afin
        // qu'un « 0 % réel » reste visible et distinct d'une année sans aucune offre déposée (barre
        // totalement absente) — sans ce plancher, les deux se confondraient en un espace vide.
        const h = b.hasDecision ? Math.max(3,(b.value/max)*plotH) : 0;
        const y = mT+plotH-h;
        const color = TAUX_ANNEE_COLORS[bi] || TAUX_ANNEE_COLORS[TAUX_ANNEE_COLORS.length-1];
        bars += `<path d="${roundedTopBarPath(x,y,barW,h,3)}" fill="${color}" data-tip="${esc(b.tip)}"/>`;
      });
      bars += `<text x="${(gx+groupW/2).toFixed(1)}" y="${H-mB+18}" class="chart-axis-label" text-anchor="middle">${g.label}</text>`;
    });
    const legend = years.map((y,i)=>`<div class="chart-summary-item"><span class="chart-swatch" style="background:${TAUX_ANNEE_COLORS[i]||TAUX_ANNEE_COLORS[TAUX_ANNEE_COLORS.length-1]};"></span>${y}</div>`).join("");
    host.innerHTML = `
      <div class="chart-summary chart-legend-wrap">${legend}</div>
      <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Taux de transformation par type de vente, 3 dernières années">
        ${gridLines}
        ${bars}
      </svg>
    `;
    wireChartTooltips(host);
  }

  // Répartition et performance par pilote commercial (société uniquement — n'a pas de sens filtré à
  // un seul consultant) : montant déposé crédité au prorata de la répartition commerciale (donc pas
  // seulement le pilote désigné — tout consultant crédité, comme sur "Mon commercial"), classé du
  // plus grand au plus petit montant. Le taux de réussite de chaque consultant s'affiche au-dessus.
  function commercialParPilote(list){
    const ids = new Set();
    list.forEach(a=>repartitionEffective(a).forEach(r=>{ if(r.consultantId) ids.add(r.consultantId); }));
    return Array.from(ids).map(cid=>{
      const mine = list.filter(a=>creditConsultantSurAffaire(a, cid) > 0);
      const part = a=>creditConsultantSurAffaire(a, cid);
      const gagnees = mine.filter(a=>a.statut==="en production" || a.statut==="terminée").length;
      const perdues = mine.filter(a=>a.statut==="perdue").length;
      const taux = (gagnees+perdues) ? gagnees/(gagnees+perdues) : null;
      const montant = mine.reduce((s,a)=>s+budgetMissionsPrevisionnel(a)*part(a),0);
      const tip = `${consultantName(cid)} : ${euro(montant)} déposés (crédité), taux de réussite ${pctOrDash(taux)}`;
      return { label: consultantName(cid), value: montant, sub: pctOrDash(taux), tip };
    }).sort((a,b)=>b.value-a.value);
  }

  function renderSelectAnneeCommercial(){
    const sel = document.getElementById("select-annee-commercial");
    populateAnneeSelect(sel, anneesDepot(), renderCommercialSociete);
  }
  function renderCommercialSociete(){
    const pipeline = pipelineEnAttente();
    const year = document.getElementById("select-annee-commercial").value;
    const list = affairesDeposeesAnnee(year);
    const k = commercialIndicateurs(list);
    document.getElementById("commercial-kpis").innerHTML = `
      <div class="kpi kpi-hero kpi-combo">
        <div class="kpi-label">Offres déposées ${year}</div>
        <div class="kpi-combo-row">
          <div class="kpi-combo-item"><div class="kpi-combo-value">${k.nb}</div><div class="kpi-combo-sub">offre${k.nb>1?"s":""}</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${euro(k.montant)}</div><div class="kpi-combo-sub">déposés</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${jr(k.jours)}</div><div class="kpi-combo-sub">déposés</div></div>
        </div>
      </div>
      <div class="kpi kpi-hero kpi-combo">
        <div class="kpi-label">Répartition des offres</div>
        <div class="kpi-combo-row">
          <div class="kpi-combo-item"><div class="kpi-combo-value">${k.gagnees.length}</div><div class="kpi-combo-sub">gagnées</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${k.perdues.length}</div><div class="kpi-combo-sub">perdues</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${k.enCoursDecision.length}</div><div class="kpi-combo-sub">en décision</div></div>
        </div>
      </div>
      <div class="kpi kpi-hero kpi-combo">
        <div class="kpi-label">Montant gagné</div>
        <div class="kpi-combo-row">
          <div class="kpi-combo-item"><div class="kpi-combo-value">${euro(k.montantGagne)}</div><div class="kpi-combo-sub">gagnés</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${jr(k.joursGagnes)}</div><div class="kpi-combo-sub">gagnés</div></div>
        </div>
      </div>
      <div class="kpi kpi-hero"><div class="kpi-label">Taux de transformation</div><div class="kpi-value">${pctOrDash(k.tauxTransfo)}</div></div>
      <div class="kpi kpi-pipeline kpi-combo">
        <div class="kpi-label">Pipeline — toutes années</div>
        <div class="kpi-combo-row">
          <div class="kpi-combo-item"><div class="kpi-combo-value">${pipeline.nb}</div><div class="kpi-combo-sub">offre${pipeline.nb>1?"s":""}</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${euro(pipeline.montant)}</div><div class="kpi-combo-sub">brut</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${jr(pipeline.jours)}</div><div class="kpi-combo-sub">bruts</div></div>
        </div>
      </div>
      <div class="kpi kpi-pipeline kpi-combo">
        <div class="kpi-label">Pipeline pondéré — toutes années</div>
        <div class="kpi-combo-row">
          <div class="kpi-combo-item"><div class="kpi-combo-value">${euro(pipeline.montantPondere)}</div><div class="kpi-combo-sub">pondérés</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${jr(pipeline.joursPondere)}</div><div class="kpi-combo-sub">pondérés</div></div>
        </div>
      </div>
    `;

    wireCommercialDonutToggle("chart-commercial-donut-toggle", metric=>{
      commercialDonutMetric = metric;
      renderCommercialDonutChart("chart-commercial-donut", k, commercialDonutMetric);
    });
    renderCommercialDonutChart("chart-commercial-donut", k, commercialDonutMetric);
    renderCommercialEvolutionChart("chart-commercial-evolution", commercialEvolutionAnnuelle(null));
    renderCommercialGroupedBarChart("chart-commercial-typevente", commercialTauxTypeVenteAnnuel());
    renderCommercialBarChart("chart-commercial-pilote", commercialParPilote(list), {
      color:"var(--brand-ocre)", formatAxis:euroCompact,
      ariaLabel:"Répartition et performance par pilote commercial",
    });

    const rows = list.slice().sort((a,b)=>b.dateDepot.localeCompare(a.dateDepot));
    const columns = [
      { key:"organisation", label:"Organisation", filterable:true, get:r=>orgName(r.organisationId) },
      { key:"nom", label:"Affaire", get:r=>r.nom },
      { key:"depot", label:"Date de dépôt", get:r=>r.dateDepot },
      { key:"montant", label:"Montant", numeric:true, get:r=>r.budget },
      { key:"jours", label:"Jours", numeric:true, get:r=>r.jours },
      { key:"reussite", label:"% de réussite", numeric:true, get:r=>r.pctReussite },
      { key:"statut", label:"Statut", filterable:true, get:r=>r.statut },
      { key:"typevente", label:"Type de vente", filterable:true, get:r=>r.typeVente },
      { key:"pilotecomm", label:"Pilote commercial", filterable:true, get:r=>consultantName(r.piloteCommercial) },
    ];
    const rowHTML = r => `<tr class="row-clickable" data-id="${r.id}" style="cursor:pointer;">
        <td>${esc(orgName(r.organisationId))}</td>
        <td class="affaire-name">${esc(r.nom)}</td>
        <td>${dateFR(r.dateDepot)}</td>
        <td class="num">${euro(r.budget)}</td>
        <td class="num">${jr(r.jours)}</td>
        <td class="num">${r.pctReussite}%</td>
        <td>${statutPill(r.statut)}</td>
        <td>${esc(r.typeVente)}</td>
        <td>${esc(consultantName(r.piloteCommercial))}</td>
      </tr>`;
    renderSortFilterTable("table-commercial-societe", rows, columns, rowHTML, {
      rerender: renderCommercialSociete,
      emptyMsg: "Aucune offre déposée sur cette année.",
      afterRender: table => table.querySelectorAll("tr[data-id]").forEach(tr=>{
        tr.addEventListener("click", ()=>openAffaireDetail(tr.dataset.id));
      }),
      tfoot: display => `<tfoot><tr>
          <td colspan="3">Total (${display.length} offre${display.length>1?"s":""})</td>
          <td class="num">${euro(display.reduce((s,r)=>s+r.budget,0))}</td>
          <td class="num">${jr(display.reduce((s,r)=>s+r.jours,0))}</td>
          <td></td><td></td><td></td><td></td>
        </tr></tfoot>`,
    });
  }

  function renderSelectAnneeCommercialMoi(){
    const sel = document.getElementById("select-annee-commercial-moi");
    populateAnneeSelect(sel, anneesDepot(), renderCommercialMoi);
  }
  // Stats "en commercialisation" (décision pas encore prise) / "gagnées" (en production ou terminée)
  // d'un lot d'affaires, avec leur montant ventilé selon la part du consultant sur chacune — sert à
  // scorer sa performance commerciale, pilotées et contributions comptées séparément (voir
  // renderCommercialMoi).
  function bucketStatsPondere(list, consultantId){
    const part = a=>creditConsultantSurAffaire(a, consultantId);
    const enCours = list.filter(a=>a.statut==="en commercialisation");
    const gagnees = list.filter(a=>a.statut==="en production" || a.statut==="terminée");
    return {
      nbEnCours: enCours.length,
      montantEnCours: enCours.reduce((s,a)=>s+budgetMissionsPrevisionnel(a)*part(a),0),
      nbGagnees: gagnees.length,
      montantGagne: gagnees.reduce((s,a)=>s+budgetMissionsPrevisionnel(a)*part(a),0),
    };
  }
  // Montant commercial gagné du consultant sur l'année, offres pilotées et en contribution confondues
  // (même calcul que la tuile « Total gagné — pilotées + contribution » de Mon commercial : pas besoin
  // de séparer les deux buckets ici, bucketStatsPondere() ventile déjà chaque affaire selon la part du
  // consultant quel que soit son rôle). Utilisé par la tuile « Commercial gagné » de Ma page.
  function commercialGagneMontant(consultantId, year){
    const mine = affairesDeposeesAnnee(year).filter(a=>creditConsultantSurAffaire(a, consultantId) > 0);
    return bucketStatsPondere(mine, consultantId).montantGagne;
  }
  function commercialKpiTile(label, stats){
    return `<div class="kpi kpi-hero kpi-combo">
        <div class="kpi-label">${label}</div>
        <div class="kpi-combo-row">
          <div class="kpi-combo-item"><div class="kpi-combo-value">${stats.nbEnCours}</div><div class="kpi-combo-sub">en commercialisation</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${euro(stats.montantEnCours)}</div><div class="kpi-combo-sub">ventilés</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${stats.nbGagnees}</div><div class="kpi-combo-sub">gagnées (en production ou terminée)</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${euro(stats.montantGagne)}</div><div class="kpi-combo-sub">ventilés</div></div>
        </div>
      </div>`;
  }
  // "Mon commercial" : performance commerciale du consultant connecté, scorée séparément selon qu'il
  // pilote l'offre (affaire.piloteCommercial) ou qu'il n'y contribue que par une part de répartition
  // (voir roleConsultantSurAffaire) — les montants attribués sont, dans les deux cas, le montant
  // ventilé selon sa part sur le budget missions prévisionnel de l'affaire, jamais 100% de l'affaire.
  function renderCommercialMoi(){
    const year = document.getElementById("select-annee-commercial-moi").value;
    const mine = affairesDeposeesAnnee(year).filter(a=>creditConsultantSurAffaire(a, currentUser) > 0);
    const pilotees = mine.filter(a=>roleConsultantSurAffaire(a, currentUser)==="pilote");
    const contrib = mine.filter(a=>roleConsultantSurAffaire(a, currentUser)==="contributeur");
    const sp = bucketStatsPondere(pilotees, currentUser);
    const sc = bucketStatsPondere(contrib, currentUser);
    // Total gagné, pilotées + contribution confondues — le score commercial global du consultant,
    // uniquement sur les offres gagnées (pas de total "en cours" demandé).
    const totalGagnees = { nb: sp.nbGagnees + sc.nbGagnees, montant: sp.montantGagne + sc.montantGagne };

    document.getElementById("commercial-moi-kpis").innerHTML =
      commercialKpiTile("Offres pilotées", sp) +
      commercialKpiTile("Offres en contribution", sc) +
      `<div class="kpi kpi-hero kpi-combo">
        <div class="kpi-label">Total gagné — pilotées + contribution</div>
        <div class="kpi-combo-row">
          <div class="kpi-combo-item"><div class="kpi-combo-value">${totalGagnees.nb}</div><div class="kpi-combo-sub">offre${totalGagnees.nb>1?"s":""} gagnées</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${euro(totalGagnees.montant)}</div><div class="kpi-combo-sub">ventilés</div></div>
        </div>
      </div>`;

    const kMoi = commercialIndicateursMoi(mine, currentUser);
    wireCommercialDonutToggle("chart-commercial-moi-donut-toggle", metric=>{
      commercialDonutMetricMoi = metric;
      renderCommercialDonutChart("chart-commercial-moi-donut", kMoi, commercialDonutMetricMoi);
    });
    renderCommercialDonutChart("chart-commercial-moi-donut", kMoi, commercialDonutMetricMoi);
    renderCommercialEvolutionChart("chart-commercial-moi-evolution", commercialEvolutionAnnuelle(currentUser));
    renderCommercialBarChart("chart-commercial-moi-typevente", commercialParTypeVente(mine, currentUser), {
      color:"var(--brand-green)", formatAxis:v=>Math.round(v)+"%", fixedMax:100,
      ariaLabel:"Taux de transformation par type de vente",
    });

    const rows = mine.slice().sort((a,b)=>b.dateDepot.localeCompare(a.dateDepot));
    const columns = [
      { key:"organisation", label:"Organisation", filterable:true, get:r=>orgName(r.organisationId) },
      { key:"nom", label:"Affaire", get:r=>r.nom },
      { key:"depot", label:"Date de dépôt", get:r=>r.dateDepot },
      { key:"statut", label:"Statut", filterable:true, get:r=>r.statut },
      { key:"role", label:"Mon rôle", filterable:true, get:r=>roleConsultantSurAffaire(r,currentUser)==="pilote"?"Pilote":"Contributeur" },
      { key:"part", label:"Ma part", numeric:true, get:r=>Math.round(creditConsultantSurAffaire(r,currentUser)*100) },
      { key:"montanttotal", label:"Montant total de l'offre", numeric:true, get:r=>r.budget },
      { key:"montant", label:"Montant ventilé", numeric:true, get:r=>budgetMissionsPrevisionnel(r)*creditConsultantSurAffaire(r,currentUser) },
      { key:"jours", label:"Jours ventilés", numeric:true, get:r=>(r.jours||0)*creditConsultantSurAffaire(r,currentUser) },
      { key:"reussite", label:"% de réussite", numeric:true, get:r=>r.pctReussite },
    ];
    const rowHTML = r => {
      const part = creditConsultantSurAffaire(r, currentUser);
      const role = roleConsultantSurAffaire(r, currentUser);
      return `<tr class="row-clickable" data-id="${r.id}" style="cursor:pointer;">
        <td>${esc(orgName(r.organisationId))}</td>
        <td class="affaire-name">${esc(r.nom)}</td>
        <td>${dateFR(r.dateDepot)}</td>
        <td>${statutPill(r.statut)}</td>
        <td><span class="pill ${role==="pilote"?"good":"neutral"}">${role==="pilote"?"Pilote":"Contributeur"}</span></td>
        <td class="num">${Math.round(part*100)}%</td>
        <td class="num">${euro(r.budget)}</td>
        <td class="num">${euro(budgetMissionsPrevisionnel(r)*part)}</td>
        <td class="num">${jr((r.jours||0)*part)}</td>
        <td class="num">${r.pctReussite}%</td>
      </tr>`;
    };
    renderSortFilterTable("table-commercial-moi", rows, columns, rowHTML, {
      rerender: renderCommercialMoi,
      emptyMsg: "Aucune offre déposée sur cette année où vous êtes crédité.",
      afterRender: table => table.querySelectorAll("tr[data-id]").forEach(tr=>{
        tr.addEventListener("click", ()=>openAffaireDetail(tr.dataset.id));
      }),
      tfoot: display => `<tfoot><tr>
          <td colspan="5">Total (${display.length} offre${display.length>1?"s":""})</td>
          <td></td>
          <td class="num">${euro(display.reduce((s,r)=>s+r.budget,0))}</td>
          <td class="num">${euro(display.reduce((s,r)=>s+budgetMissionsPrevisionnel(r)*creditConsultantSurAffaire(r,currentUser),0))}</td>
          <td class="num">${jr(display.reduce((s,r)=>s+(r.jours||0)*creditConsultantSurAffaire(r,currentUser),0))}</td>
          <td></td>
        </tr></tfoot>`,
    });
  }

  /* ================= Listes de référence éditables (Tables & réglages) ================= */
  // Générique : gère l'affichage (chips + croix de suppression) et l'ajout pour les 3 listes
  // (méthodes, types de territoire, domaines d'intervention), qui partagent toutes la même forme
  // { id, label } et le même comportement (pas de renommage pour l'instant — supprimer puis
  // rajouter — pas de confirmation de suppression, comme le reste de l'application).
  function renderRefList(hostId, list, onChange){
    const host = document.getElementById(hostId);
    host.innerHTML = list.length
      ? list.map(item=>`<span class="chip reflist-chip">${esc(item.label)}<button type="button" class="reflist-remove" data-id="${esc(item.id)}" title="Supprimer">✕</button></span>`).join("")
      : `<span style="font-size:.82rem;color:var(--text-muted);">Aucun élément pour l'instant.</span>`;
    host.querySelectorAll(".reflist-remove").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const idx = list.findIndex(x=>x.id===btn.dataset.id);
        if(idx>-1) list.splice(idx,1);
        renderRefList(hostId, list, onChange);
        if(onChange) onChange();
      });
    });
  }
  function wireRefListAdd(inputId, btnId, hostId, list, prefix, getNextId, onChange){
    const btn = document.getElementById(btnId);
    if(btn.dataset.wired) return;
    btn.dataset.wired = "1";
    const input = document.getElementById(inputId);
    const add = ()=>{
      const val = input.value.trim();
      if(!val) return;
      list.push({ id: prefix+getNextId(), label: val });
      input.value = "";
      renderRefList(hostId, list, onChange);
      if(onChange) onChange();
    };
    btn.addEventListener("click", add);
    input.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); add(); } });
  }
  function renderListesReference(){
    renderRefList("liste-methodes", methodes);
    renderRefList("liste-territoires", typesTerritoire);
    renderRefList("liste-domaines", domainesIntervention);
    renderCategoriesFrais();
  }
  function wireListesReference(){
    wireRefListAdd("input-nouvelle-methode", "btn-ajouter-methode", "liste-methodes", methodes, "ME", ()=>nextMethodeId++);
    wireRefListAdd("input-nouveau-territoire", "btn-ajouter-territoire", "liste-territoires", typesTerritoire, "TE", ()=>nextTerritoireId++);
    wireRefListAdd("input-nouveau-domaine", "btn-ajouter-domaine", "liste-domaines", domainesIntervention, "DO", ()=>nextDomaineId++);
    wireCategoriesFraisAdd();
  }

  // Sous-catégories de frais : même principe que les 3 listes ci-dessus (pas de renommage, pas de
  // confirmation de suppression) mais à deux niveaux (catégorie > sous-catégorie), donc affichage et
  // ajout dédiés plutôt que la version générique renderRefList/wireRefListAdd.
  function renderCategoriesFrais(){
    const host = document.getElementById("liste-categories-frais");
    if(!host) return;
    const groups = [];
    categoriesFrais.forEach(c=>{
      let g = groups.find(g=>g.categorie===c.categorie);
      if(!g){ g = { categorie:c.categorie, items:[] }; groups.push(g); }
      g.items.push(c);
    });
    host.innerHTML = groups.length
      ? groups.map(g=>`
          <div class="catfrais-group">
            <div class="catfrais-group-label">${esc(g.categorie)}</div>
            <div class="chip-filter">
              ${g.items.map(c=>`<span class="chip reflist-chip">${esc(c.label)}<button type="button" class="reflist-remove" data-id="${esc(c.id)}" title="Supprimer">✕</button></span>`).join("")}
            </div>
          </div>`).join("")
      : `<span style="font-size:.82rem;color:var(--text-muted);">Aucune sous-catégorie pour l'instant.</span>`;
    host.querySelectorAll(".reflist-remove").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const idx = categoriesFrais.findIndex(x=>x.id===btn.dataset.id);
        if(idx>-1) categoriesFrais.splice(idx,1);
        renderCategoriesFrais();
        renderDatalistCategoriesFrais();
      });
    });
    renderDatalistCategoriesFrais();
  }
  function renderDatalistCategoriesFrais(){
    const dl = document.getElementById("datalist-categories-frais");
    if(!dl) return;
    const cats = Array.from(new Set(categoriesFrais.map(c=>c.categorie)));
    dl.innerHTML = cats.map(c=>`<option value="${esc(c)}">`).join("");
  }
  function wireCategoriesFraisAdd(){
    const btn = document.getElementById("btn-ajouter-souscategorie-frais");
    if(btn.dataset.wired) return;
    btn.dataset.wired = "1";
    const catInput = document.getElementById("input-nouvelle-categorie-frais");
    const subInput = document.getElementById("input-nouvelle-souscategorie-frais");
    const add = ()=>{
      const categorie = catInput.value.trim();
      const label = subInput.value.trim();
      if(!categorie || !label) return;
      categoriesFrais.push({ id:"CF"+(nextCategorieFraisId++), categorie, label });
      catInput.value = ""; subInput.value = "";
      renderCategoriesFrais();
      catInput.focus();
    };
    btn.addEventListener("click", add);
    [catInput, subInput].forEach(inp=>inp.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); add(); } }));
  }

  // Sélecteurs à cocher (chips) des 3 caractéristiques, dans le module de saisie d'affaire.
  let selectedMethodes = new Set();
  let selectedTerritoires = new Set();
  let selectedDomaines = new Set();
  function renderAffaireCaracPicker(hostId, list, selectedSet){
    const host = document.getElementById(hostId);
    host.innerHTML = list.length
      ? list.map(item=>`<button type="button" class="chip${selectedSet.has(item.id)?" on":""}" data-id="${esc(item.id)}">${esc(item.label)}</button>`).join("")
      : `<span style="font-size:.82rem;color:var(--text-muted);">Aucun élément défini — à ajouter dans Tables &amp; réglages.</span>`;
    host.querySelectorAll(".chip").forEach(chip=>{
      chip.addEventListener("click", ()=>{
        const id = chip.dataset.id;
        if(selectedSet.has(id)) selectedSet.delete(id); else selectedSet.add(id);
        chip.classList.toggle("on");
      });
    });
  }
  function renderAffaireCaracPickers(){
    renderAffaireCaracPicker("a-methodes-picker", methodes, selectedMethodes);
    renderAffaireCaracPicker("a-territoires-picker", typesTerritoire, selectedTerritoires);
    renderAffaireCaracPicker("a-domaines-picker", domainesIntervention, selectedDomaines);
  }
  // Libellés valides (ignore silencieusement un id devenu orphelin si l'élément a été supprimé
  // depuis Tables & réglages) pour un ensemble d'ids caractérisant une affaire.
  function caracLabels(ids, list){
    return (ids||[]).map(id=>list.find(x=>x.id===id)).filter(Boolean).map(x=>x.label);
  }

  // Colonnes + rendu de ligne du tableau "affaires", partagés entre le portefeuille (page
  // Affaires) et les listes "Voir" par rôle sur la fiche Organisation, pour un rendu identique
  // partout (même demande explicite de l'utilisateur pour ces listes).
  function affaireWithCalc(a){
    const consommeJ = missions.filter(m=>m.affaireId===a.id).reduce((s,m)=>s+joursFactConsommes(m.id),0);
    const rafJ = Math.max(0, a.jours - consommeJ);
    return { ...a, _coherence:coherenceInfo(a), _consommeJ:consommeJ, _rafJ:rafJ };
  }
  function affairesTableColumns(){
    return [
      { key:"nom", label:"Affaire", get:a=>a.nom },
      { key:"statut", label:"Statut", get:a=>a.statut },
      { key:"pilote", label:"Pilote", filterable:true, get:a=>consultantName(a.pilote) },
      { key:"dates", label:"Dates prévues", get:a=>a.dateDebut },
      { key:"budget", label:"Budget", numeric:true, get:a=>a.budget },
      { key:"jours", label:"Jours", numeric:true, get:a=>a.jours },
      { key:"rafJ", label:"RAF jours", numeric:true, sep:true, get:a=>a._rafJ },
      { key:"coherence", label:"Cohérence", filterable:true, get:a=>a._coherence.short },
    ];
  }
  function affaireRowHTML(a){
    return `<tr class="row-clickable" data-id="${a.id}" style="cursor:pointer;">
        <td class="affaire-name">${esc(a.nom)}<span class="sub">${esc(orgName(a.organisationId))}${a.motsCles?" · "+esc(a.motsCles):""}</span>${joursBarHTML(a._consommeJ, a.jours, {mini:true})}</td>
        <td>${statutPill(a.statut)}</td>
        <td>${esc(consultantName(a.pilote))}</td>
        <td>${dateFR(a.dateDebut)} → ${dateFR(a.dateFin)}</td>
        <td class="num">${euro(a.budget)}</td>
        <td class="num">${jr(a.jours)}</td>
        <td class="num col-sep-left">${jr(a._rafJ)}</td>
        <td><span class="pill ${a._coherence.level}" title="${a._coherence.label}"><span class="dot-ind ${a._coherence.level}" style="background:currentColor;"></span>${a._coherence.short}</span></td>
      </tr>`;
  }
  function affairesTfoot(display){
    return `<tfoot><tr>
        <td colspan="4">Total (${display.length} affaire${display.length>1?"s":""})</td>
        <td class="num">${euro(display.reduce((s,a)=>s+a.budget,0))}</td>
        <td class="num">${jr(display.reduce((s,a)=>s+a.jours,0))}</td>
        <td class="num col-sep-left">${jr(display.reduce((s,a)=>s+a._rafJ,0))}</td>
        <td></td>
      </tr></tfoot>`;
  }
  function renderPortefeuille(){
    const q = rechercheAffaires.trim().toLowerCase();
    const list = affaires.filter(a=>{
      if(!filtrePortefeuille.has(a.statut)) return false;
      if(!q) return true;
      const hay = (a.nom+" "+orgName(a.organisationId)+" "+(a.motsCles||"")).toLowerCase();
      return hay.includes(q);
    }).map(affaireWithCalc);
    renderSortFilterTable("table-portefeuille", list, affairesTableColumns(), affaireRowHTML, {
      rerender: renderPortefeuille,
      emptyMsg: "Aucune affaire pour ce filtre / cette recherche.",
      afterRender: table => table.querySelectorAll("tr[data-id]").forEach(tr=>{
        tr.addEventListener("click", ()=>openAffaireDetail(tr.dataset.id));
      }),
      tfoot: affairesTfoot,
    });
  }

  // --- Partenaires de l'affaire (jusqu'à 5, choisis parmi les organisations) ---
  const ROLES_PARTENAIRE = ["mandataire", "co-traitant", "sous-traitant direct", "sous-traitant indirect"];
  const MAX_PARTENAIRES = 5;
  let editingPartenaires = [];

  function partenaireRowHTML(p, i){
    return `<div class="partenaire-row" data-idx="${i}">
        <div class="partenaire-row-main">
          <div class="field combobox-wrap">
            <label>Organisation</label>
            <input type="text" id="pp-org-search-${i}" autocomplete="off" placeholder="Rechercher...">
            <input type="hidden" id="pp-org-id-${i}">
            <div class="combobox-list" id="pp-org-list-${i}" hidden></div>
          </div>
          <button type="button" class="btn ghost pp-remove" data-idx="${i}" style="height:38px;" title="Supprimer ce partenaire">✕</button>
        </div>
        <div class="partenaire-row-sub">
          <div class="field pp-role-field">
            <label>Rôle</label>
            <select class="pp-role" data-idx="${i}">
              ${ROLES_PARTENAIRE.map(r=>`<option value="${r}" ${p.role===r?"selected":""}>${r.charAt(0).toUpperCase()+r.slice(1)}</option>`).join("")}
            </select>
          </div>
          <div class="field pp-montant-wrap" data-idx="${i}" ${p.role==="sous-traitant indirect" ? "" : "hidden"}>
            <label>Montant à payer (€)</label>
            <input type="number" class="pp-montant" data-idx="${i}" min="0" step="100" value="${p.montant||0}">
          </div>
        </div>
      </div>`;
  }
  // Relit les champs du DOM (organisation, rôle, montant) vers editingPartenaires, avant toute
  // opération qui reconstruit la liste (ajout/suppression) ou avant l'enregistrement de l'affaire —
  // les sélections faites via la combobox de chaque ligne ne sont sinon pas répercutées dans le tableau.
  function syncPartenairesFromDOM(){
    document.querySelectorAll("#a-partenaires-list .partenaire-row").forEach(row=>{
      const i = +row.dataset.idx;
      if(!editingPartenaires[i]) return;
      const orgId = document.getElementById(`pp-org-id-${i}`);
      const role = row.querySelector(".pp-role");
      const montant = row.querySelector(".pp-montant");
      if(orgId) editingPartenaires[i].organisationId = orgId.value;
      if(role) editingPartenaires[i].role = role.value;
      if(montant) editingPartenaires[i].montant = +montant.value || 0;
    });
  }
  function renderPartenairesEditor(){
    const wrap = document.getElementById("a-partenaires-list");
    wrap.innerHTML = editingPartenaires.length
      ? editingPartenaires.map(partenaireRowHTML).join("")
      : `<div style="font-size:.82rem;color:var(--text-muted);">Aucun partenaire pour l'instant.</div>`;
    editingPartenaires.forEach((p,i)=>{
      const combo = initCombobox(`pp-org-search-${i}`, `pp-org-id-${i}`, `pp-org-list-${i}`, ()=>organisations, o=>o.nom, o=>o.id);
      combo.setValue(p.organisationId || "");
    });
    wrap.querySelectorAll(".pp-role").forEach(sel=>{
      sel.addEventListener("change", e=>{
        const i = +e.target.dataset.idx;
        editingPartenaires[i].role = e.target.value;
        const montantWrap = wrap.querySelector(`.pp-montant-wrap[data-idx="${i}"]`);
        if(montantWrap) montantWrap.hidden = e.target.value !== "sous-traitant indirect";
      });
    });
    wrap.querySelectorAll(".pp-remove").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        syncPartenairesFromDOM();
        editingPartenaires.splice(+btn.dataset.idx, 1);
        renderPartenairesEditor();
        updatePartenairesAddButton();
      });
    });
  }
  function updatePartenairesAddButton(){
    const btn = document.getElementById("a-partenaires-add");
    const atMax = editingPartenaires.length >= MAX_PARTENAIRES;
    btn.hidden = atMax;
  }

  // --- Répartition commerciale de l'affaire (onglet Commercial) — partage optionnel, entre
  // consultants, du budget missions prévisionnel (voir budgetMissionsPrevisionnel/repartitionEffective
  // plus haut). Éditeur calqué sur celui des partenaires (mêmes styles .partenaire-row).
  let editingRepartition = [];
  function repartitionRowHTML(r, i){
    return `<div class="partenaire-row" data-idx="${i}">
        <div class="partenaire-row-main">
          <div class="field"><label>Consultant</label><select class="rc-consultant" data-idx="${i}"></select></div>
          <div class="field" style="max-width:150px;"><label>% du budget missions</label><input type="number" class="rc-pct" data-idx="${i}" min="0" max="100" step="5" value="${r.pct||0}"></div>
          <button type="button" class="btn ghost rc-remove" data-idx="${i}" style="height:38px;" title="Retirer ce consultant">✕</button>
        </div>
      </div>`;
  }
  function syncRepartitionFromDOM(){
    document.querySelectorAll("#a-repartition-list .partenaire-row").forEach(row=>{
      const i = +row.dataset.idx;
      if(!editingRepartition[i]) return;
      const sel = row.querySelector(".rc-consultant");
      const pct = row.querySelector(".rc-pct");
      if(sel) editingRepartition[i].consultantId = sel.value;
      if(pct) editingRepartition[i].pct = +pct.value || 0;
    });
  }
  function updateRepartitionTotal(){
    const el = document.getElementById("a-repartition-total");
    if(!el) return;
    if(!editingRepartition.length){ el.textContent = ""; return; }
    const total = editingRepartition.reduce((s,r)=>s+(r.pct||0),0);
    const off = Math.abs(total-100) > 1e-6;
    el.textContent = `Total réparti : ${total} %` + (off ? " — devrait faire 100 % (non bloquant)" : "");
    el.style.color = off ? "var(--status-warn-text)" : "var(--text-muted)";
  }
  function renderRepartitionEditor(){
    const wrap = document.getElementById("a-repartition-list");
    wrap.innerHTML = editingRepartition.length
      ? editingRepartition.map(repartitionRowHTML).join("")
      : `<div style="font-size:.82rem;color:var(--text-muted);">Aucune répartition saisie — le pilote commercial est crédité de la totalité.</div>`;
    editingRepartition.forEach((r,i)=>{
      const sel = wrap.querySelector(`.rc-consultant[data-idx="${i}"]`);
      sel.innerHTML = consultants.filter(c=>c.statut==="en poste").map(c=>`<option value="${esc(c.id)}">${esc(c.nom)}</option>`).join("");
      sel.value = r.consultantId || "";
    });
    wrap.querySelectorAll(".rc-consultant, .rc-pct").forEach(el=>{
      ["input","change"].forEach(evt=>el.addEventListener(evt, ()=>{ syncRepartitionFromDOM(); updateRepartitionTotal(); }));
    });
    wrap.querySelectorAll(".rc-remove").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        syncRepartitionFromDOM();
        editingRepartition.splice(+btn.dataset.idx, 1);
        renderRepartitionEditor();
      });
    });
    updateRepartitionTotal();
  }

  let currentEditAffaireId = null;
  // Onglets du module de saisie d'affaire (Informations générales / Budget & dates /
  // Caractéristiques / Partenaires / Commercial) — un seul panneau visible à la fois, l'onglet cliqué
  // devient actif. resetAffaireTabs() ramène toujours sur le premier onglet à l'ouverture,
  // que ce soit une création ou une modification.
  function switchAffaireTab(name){
    document.querySelectorAll("#a-tabs .modal-tab").forEach(btn=>{
      btn.classList.toggle("active", btn.dataset.tab===name);
    });
    document.querySelectorAll("#modal-affaire .modal-tabpanel").forEach(panel=>{
      panel.hidden = panel.dataset.tabpanel !== name;
    });
  }
  function resetAffaireTabs(){
    switchAffaireTab("general");
  }
  function openNouvelleAffaire(){
    currentEditAffaireId = null;
    resetAffaireTabs();
    clearFieldErrors("#modal-affaire");
    document.getElementById("modal-affaire-title").textContent = "Nouvelle affaire";
    populateOrgSelect();
    orgCombobox.setValue(organisations[0] ? organisations[0].id : "");
    populateConsultantSelects();
    document.getElementById("a-nom").value = "";
    document.getElementById("a-abrege").value = "";
    document.getElementById("a-motscles").value = "";
    document.getElementById("a-pilote-comm").value = currentUser;
    document.getElementById("a-pilote").value = currentUser;
    document.getElementById("a-statut").value = "en commercialisation";
    document.getElementById("a-depot").value = today.toISOString().slice(0,10);
    document.getElementById("a-budget").value = 20000;
    document.getElementById("a-jours").value = 30;
    document.getElementById("a-frais").value = 0;
    document.getElementById("a-debut").value = today.toISOString().slice(0,10);
    document.getElementById("a-fin").value = today.toISOString().slice(0,10);
    selectedMethodes = new Set();
    selectedTerritoires = new Set();
    selectedDomaines = new Set();
    renderAffaireCaracPickers();
    editingPartenaires = [];
    renderPartenairesEditor();
    updatePartenairesAddButton();
    editingRepartition = [];
    renderRepartitionEditor();
    openModal("modal-affaire");
  }
  function openModifierAffaire(affaireId){
    const a = affaires.find(x=>x.id===affaireId);
    if(!a) return;
    currentEditAffaireId = affaireId;
    resetAffaireTabs();
    clearFieldErrors("#modal-affaire");
    document.getElementById("modal-affaire-title").textContent = "Modifier l'affaire";
    populateOrgSelect();
    orgCombobox.setValue(a.organisationId);
    populateConsultantSelects();
    document.getElementById("a-nom").value = a.nom;
    document.getElementById("a-abrege").value = a.nomAbrege || "";
    document.getElementById("a-motscles").value = a.motsCles || "";
    document.getElementById("a-pilote-comm").value = a.piloteCommercial;
    document.getElementById("a-pilote").value = a.pilote;
    document.getElementById("a-typevente").value = a.typeVente;
    document.getElementById("a-reussite").value = a.pctReussite;
    document.getElementById("a-statut").value = a.statut;
    document.getElementById("a-depot").value = a.dateDepot;
    document.getElementById("a-budget").value = a.budget;
    document.getElementById("a-jours").value = a.jours;
    document.getElementById("a-frais").value = a.frais;
    document.getElementById("a-debut").value = a.dateDebut;
    document.getElementById("a-fin").value = a.dateFin;
    selectedMethodes = new Set(a.methodes||[]);
    selectedTerritoires = new Set(a.territoires||[]);
    selectedDomaines = new Set(a.domaines||[]);
    renderAffaireCaracPickers();
    editingPartenaires = (a.partenaires||[]).map(p=>({ ...p }));
    renderPartenairesEditor();
    updatePartenairesAddButton();
    editingRepartition = (a.repartitionCommerciale||[]).map(r=>({ ...r }));
    renderRepartitionEditor();
    openModal("modal-affaire");
  }
  // Validation des champs obligatoires (module de saisie d'affaire) — tous les champs sont
  // obligatoires sauf mots-clés, frais Cabinet, et partenaires (et, pour la répartition
  // commerciale, qui reste facultative : sans saisie, le pilote commercial est crédité de la
  // totalité, comportement volontairement conservé). clearFieldErrors()/markFieldError() sont
  // génériques et réutilisées pour le module de saisie de mission.
  function clearFieldErrors(scopeSel){
    document.querySelectorAll(scopeSel+" .field-error").forEach(el=>el.classList.remove("field-error"));
  }
  function markFieldError(id){
    const el = document.getElementById(id);
    if(!el) return;
    const holder = el.closest(".field") || el;
    holder.classList.add("field-error");
    const focusable = ["INPUT","SELECT","TEXTAREA"].includes(el.tagName);
    if(focusable) el.focus(); else holder.scrollIntoView({block:"center"});
  }
  function firstMissingAffaireField(){
    const checks = [
      { tab:"general", id:"a-nom", label:"Nom de l'affaire", empty:()=>!document.getElementById("a-nom").value.trim() },
      { tab:"general", id:"a-org-search", label:"Organisation", empty:()=>!document.getElementById("a-org").value },
      { tab:"general", id:"a-abrege", label:"Nom abrégé", empty:()=>!document.getElementById("a-abrege").value.trim() },
      { tab:"general", id:"a-pilote", label:"Pilote de l'affaire", empty:()=>!document.getElementById("a-pilote").value },
      { tab:"budget", id:"a-budget", label:"Prestations Cabinet (€)", empty:()=>!(+document.getElementById("a-budget").value > 0) },
      { tab:"budget", id:"a-jours", label:"Nombre de jours vendus", empty:()=>!(+document.getElementById("a-jours").value > 0) },
      { tab:"budget", id:"a-debut", label:"Date prévisionnelle de début", empty:()=>!document.getElementById("a-debut").value },
      { tab:"budget", id:"a-fin", label:"Date prévisionnelle de fin", empty:()=>!document.getElementById("a-fin").value },
      { tab:"carac", id:"a-methodes-picker", label:"Méthodes", empty:()=>selectedMethodes.size===0 },
      { tab:"carac", id:"a-territoires-picker", label:"Types de territoire", empty:()=>selectedTerritoires.size===0 },
      { tab:"carac", id:"a-domaines-picker", label:"Domaines d'intervention", empty:()=>selectedDomaines.size===0 },
      { tab:"commercial", id:"a-pilote-comm", label:"Pilote commercial", empty:()=>!document.getElementById("a-pilote-comm").value },
      { tab:"commercial", id:"a-depot", label:"Date de dépôt de l'offre", empty:()=>!document.getElementById("a-depot").value },
    ];
    return checks.find(c=>c.empty()) || null;
  }
  function saveAffaire(){
    clearFieldErrors("#modal-affaire");
    const missing = firstMissingAffaireField();
    if(missing){
      switchAffaireTab(missing.tab);
      markFieldError(missing.id);
      toast(`Le champ « ${missing.label} » est obligatoire`);
      return;
    }
    const nom = document.getElementById("a-nom").value.trim();
    const dateDebut = document.getElementById("a-debut").value;
    const dateFin = document.getElementById("a-fin").value;
    if(dateFin < dateDebut){ toast("La date de fin ne peut pas précéder la date de début"); return; }
    syncPartenairesFromDOM();
    const partenaires = editingPartenaires.filter(p=>p.organisationId);
    syncRepartitionFromDOM();
    const repartitionCommerciale = editingRepartition.filter(r=>r.consultantId);
    const fields = {
      nom,
      organisationId: document.getElementById("a-org").value,
      nomAbrege: document.getElementById("a-abrege").value.trim() || nom,
      motsCles: document.getElementById("a-motscles").value.trim(),
      piloteCommercial: document.getElementById("a-pilote-comm").value,
      pilote: document.getElementById("a-pilote").value,
      typeVente: document.getElementById("a-typevente").value,
      pctReussite: +document.getElementById("a-reussite").value,
      dateDepot: document.getElementById("a-depot").value,
      statut: document.getElementById("a-statut").value,
      budget: +document.getElementById("a-budget").value || 0,
      jours: +document.getElementById("a-jours").value || 0,
      frais: +document.getElementById("a-frais").value || 0,
      dateDebut, dateFin,
      methodes: Array.from(selectedMethodes),
      territoires: Array.from(selectedTerritoires),
      domaines: Array.from(selectedDomaines),
      partenaires,
      repartitionCommerciale,
    };
    if(currentEditAffaireId){
      const a = affaires.find(x=>x.id===currentEditAffaireId);
      Object.assign(a, fields);
      toast("Affaire mise à jour");
    } else {
      affaires.push({ id:newEntityId("A"), ...fields });
      toast("Affaire créée");
    }
    closeModal("modal-affaire");
    renderPortefeuille();
    renderAll();
  }

  /* ================= Détail affaire & missions ================= */
  function renderAffaireDetail(){
    const a = affaires.find(x=>x.id===currentAffaireDetailId);
    if(!a) return;
    document.getElementById("detail-affaire-nom").textContent = a.nom;
    document.getElementById("detail-affaire-sub").textContent =
      `${orgName(a.organisationId)} — pilote ${consultantName(a.pilote)} · pilote commercial ${consultantName(a.piloteCommercial)} · dates prévues ${dateFR(a.dateDebut)} → ${dateFR(a.dateFin)}`;

    const c = coherenceInfo(a);
    const consommeJ = missions.filter(m=>m.affaireId===a.id).reduce((s,m)=>s+joursFactConsommes(m.id),0);
    const rafJ = Math.max(0, a.jours - consommeJ);
    const partenairesList = a.partenaires || [];
    const sousTraitants = partenairesList.filter(p=>p.role==="sous-traitant indirect");
    const sousTraitanceTotal = c.sousTraitance;

    document.getElementById("detail-affaire-kpis").innerHTML = `
      <div class="kpi"><div class="kpi-label">Statut</div><div class="kpi-value" style="font-size:1rem;">${statutPill(a.statut)}</div></div>
      <div class="kpi"><div class="kpi-label">Dates prévues</div><div class="kpi-value" style="font-size:1rem;">${dateFR(a.dateDebut)} → ${dateFR(a.dateFin)}</div></div>
      <div class="kpi"><div class="kpi-label">Budget vendu</div><div class="kpi-value">${euro(a.budget)}</div></div>
      <div class="kpi"><div class="kpi-label">Jours vendus</div><div class="kpi-value">${jr(a.jours)}</div></div>
      <div class="kpi"><div class="kpi-label">Reste à faire</div><div class="kpi-value">${jr(rafJ)}<small> / ${euro(rafJ*(a.budget/(a.jours||1)))}</small></div></div>
      ${sousTraitants.length ? `<div class="kpi"><div class="kpi-label">Sous-traitance à payer</div><div class="kpi-value">${euro(sousTraitanceTotal)}</div></div>` : ""}
      <div class="kpi" style="grid-column:1 / -1;display:flex;flex-direction:column;justify-content:center;">${joursBarHTML(consommeJ, a.jours, {label:"Jours facturables produits"})}</div>
    `;

    // Enveloppe théorique laissée aux missions une fois frais et sous-traitance mis de côté —
    // c'est cette part du budget vendu que les missions individuelles doivent se répartir.
    const enveloppeMissions = c.ref - c.frais - c.sousTraitance;
    const missionsRestant = enveloppeMissions - c.missionsSum;
    const missionsPct = enveloppeMissions > 0 ? (c.missionsSum/enveloppeMissions*100) : (c.missionsSum>0 ? 100 : 0);
    const missionsLevel = missionsRestant < -1e-6 ? "danger" : (missionsRestant > 1e-6 ? "warn" : "good");
    const missionsLegendDroite = missionsRestant > 1e-6 ? `${euro(missionsRestant)} à affecter`
      : missionsRestant < -1e-6 ? `Dépassement de ${euro(-missionsRestant)}` : "Entièrement affecté";

    // Frais réellement engagés (notesFrais), toujours en TTC ici : seule la part refacturable vient
    // se greffer sur l'enveloppe « Frais Cabinet » (c.frais) — même logique de jauge que les missions
    // ci-dessus. La part non refacturable est affichée à part, comme hors budget de l'affaire.
    const fraisConsomme = fraisRefacturablesSum(a.id);
    const fraisNonRef = fraisNonRefacturablesSum(a.id);
    const fraisRestant = c.frais - fraisConsomme;
    const fraisPct = c.frais > 0 ? (fraisConsomme/c.frais*100) : (fraisConsomme>0 ? 100 : 0);
    const fraisLevel = fraisRestant < -1e-6 ? "danger" : (fraisRestant > 1e-6 ? "warn" : "good");
    const fraisLegendDroite = fraisRestant > 1e-6 ? `${euro(fraisRestant)} à affecter`
      : fraisRestant < -1e-6 ? `Dépassement de ${euro(-fraisRestant)}` : "Entièrement affecté";
    const fraisAffaireCount = notesFrais.filter(n=>n.affaireId===a.id).length;

    // Jauge "% frais non refacturables / montant des missions" : 0 % tout en bas, 10 % et plus tout en
    // haut (échelle volontairement plafonnée à 10 % — au-delà, la valeur exacte reste affichée à côté
    // du curseur, qui lui se contente d'aller au maximum). Sans mission valorisée sur l'affaire, le
    // ratio n'a pas de sens : curseur au maximum si des frais non refacturables existent quand même
    // (situation à signaler), sinon tout en bas.
    const fraisNonRefMissionsPct = c.missionsSum > 1e-6 ? (fraisNonRef/c.missionsSum*100) : (fraisNonRef > 1e-6 ? Infinity : 0);
    const fraisNonRefGaugePos = Number.isFinite(fraisNonRefMissionsPct) ? Math.min(100, Math.max(0, fraisNonRefMissionsPct/10*100)) : 100;
    const fraisNonRefGaugeLabel = Number.isFinite(fraisNonRefMissionsPct)
      ? `${fraisNonRefMissionsPct.toLocaleString("fr-FR",{minimumFractionDigits:1,maximumFractionDigits:1})} %`
      : "—";
    const fraisNonRefGaugeTitle = c.missionsSum > 1e-6
      ? `Frais non refacturables (${euro(fraisNonRef)}) / montant des missions (${euro(c.missionsSum)})`
      : "Aucune mission valorisée sur cette affaire";

    document.getElementById("detail-coherence").innerHTML = `
      <div class="bc-status">
        <span class="dot-ind ${c.level}"></span>
        <div>
          <div class="bc-status-label">${c.label}</div>
          <div class="bc-status-sub">Budget vendu (prestations cabinet) : ${euro(c.ref)}</div>
        </div>
      </div>
      <div class="bc-grid">
        <div class="bc-card">
          <div class="bc-card-head">
            <span class="bc-card-label">Missions</span>
            <span class="bc-card-value">${euro(c.missionsSum)}<small> / ${euro(enveloppeMissions)}</small></span>
          </div>
          <div class="jbar-track" title="Missions affectées : ${euro(c.missionsSum)} / ${euro(enveloppeMissions)}">
            <div class="jbar-fill ${missionsLevel}" style="width:${Math.min(100,Math.max(0,missionsPct))}%;"></div>
          </div>
          <div class="bc-card-legend"><span>${euro(c.missionsSum)} affectés</span><span>${missionsLegendDroite}</span></div>
        </div>
        <div class="bc-card">
          <div class="bc-card-frais-row">
            <div class="bc-card-frais-main">
              <div class="bc-card-head">
                <span class="bc-card-label">Frais (TTC)</span>
                <span class="bc-card-value">${euro(fraisConsomme)}<small> / ${euro(c.frais)}</small></span>
              </div>
              <div class="jbar-track" title="Frais refacturables engagés (TTC) : ${euro(fraisConsomme)} / ${euro(c.frais)}">
                <div class="jbar-fill ${fraisLevel}" style="width:${Math.min(100,Math.max(0,fraisPct))}%;"></div>
              </div>
              <div class="bc-card-legend"><span>${euro(fraisConsomme)} refacturables</span><span>${fraisLegendDroite}</span></div>
              ${fraisNonRef>1e-6 ? `<div class="bc-card-note">+ ${euro(fraisNonRef)} non refacturables TTC (hors budget affaire)</div>` : ""}
              <div style="margin-top:10px;">
                <button type="button" class="btn-voir" id="btn-voir-frais-affaire" ${fraisAffaireCount ? "" : "disabled"}>Voir les frais${fraisAffaireCount ? ` (${fraisAffaireCount})` : ""}</button>
              </div>
            </div>
            <div class="bc-frais-gauge" title="${esc(fraisNonRefGaugeTitle)}">
              <div class="bc-frais-gauge-title">% frais non refacturables / montant des missions</div>
              <div class="bc-frais-gauge-body">
                <div class="bc-frais-gauge-scale"><span>10 %+</span><span>0 %</span></div>
                <div class="bc-frais-gauge-track">
                  <div class="bc-frais-gauge-cursor" style="bottom:${fraisNonRefGaugePos}%;">
                    <span class="bc-frais-gauge-cursor-arrow"></span>
                    <span class="bc-frais-gauge-cursor-value">${fraisNonRefGaugeLabel}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="bc-card bc-card-flat">
          <div class="bc-card-head"><span class="bc-card-label">Sous-traitance</span></div>
          <div class="bc-card-value">${euro(c.sousTraitance)}</div>
          <div class="bc-card-note">${sousTraitants.length ? `À payer à ${sousTraitants.length} partenaire${sousTraitants.length>1?"s":""}` : "Aucun sous-traitant indirect"}</div>
        </div>
      </div>`;
    const btnVoirFrais = document.getElementById("btn-voir-frais-affaire");
    if(btnVoirFrais) btnVoirFrais.addEventListener("click", ()=>openAffaireFraisList(a.id));

    const caracChips = labels => labels.length
      ? labels.map(l=>`<span class="chip" style="cursor:default;">${esc(l)}</span>`).join("")
      : `<span style="font-size:.82rem;color:var(--text-muted);">—</span>`;
    document.getElementById("detail-caracteristiques").innerHTML = `
      <div class="carac-group"><div class="kpi-label">Méthodes</div><div class="chip-filter">${caracChips(caracLabels(a.methodes, methodes))}</div></div>
      <div class="carac-group"><div class="kpi-label">Types de territoire</div><div class="chip-filter">${caracChips(caracLabels(a.territoires, typesTerritoire))}</div></div>
      <div class="carac-group"><div class="kpi-label">Domaines d'intervention</div><div class="chip-filter">${caracChips(caracLabels(a.domaines, domainesIntervention))}</div></div>
    `;

    const panelPartenaires = document.getElementById("panel-detail-partenaires");
    panelPartenaires.hidden = partenairesList.length === 0;
    if(partenairesList.length){
      const roleLabel = r => r.charAt(0).toUpperCase()+r.slice(1);
      const rows = partenairesList.map(p=>`
        <tr>
          <td>${esc(orgName(p.organisationId))}</td>
          <td><span class="pill ${p.role==="sous-traitant indirect" ? "warn" : "neutral"}">${esc(roleLabel(p.role))}</span></td>
          <td class="num">${p.role==="sous-traitant indirect" ? euro(p.montant||0) : "—"}</td>
        </tr>`).join("");
      document.getElementById("detail-partenaires").innerHTML = `
        <table class="table-partenaires">
          <thead><tr><th>Organisation</th><th>Rôle</th><th style="text-align:right;">Montant à payer</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    const missionsRows = missions.filter(m=>m.affaireId===a.id).map(m=>{
      const cons = joursFactConsommes(m.id);
      const nonFact = joursNonFactConsommes(m.id);
      const raf = Math.max(0, m.enveloppe - cons);
      return { ...m, _cons:cons, _nonFact:nonFact, _raf:raf };
    });
    const missionCols = [
      { key:"nom", label:"Mission", get:m=>m.nom },
      { key:"statut", label:"Statut", filterable:true, get:m=>m.statut },
      { key:"enveloppe", label:"Enveloppe", numeric:true, get:m=>m.enveloppe },
      { key:"budget", label:"Budget", numeric:true, get:m=>m.enveloppe*m.taux },
      { key:"cons", label:"Consommé (fact.)", numeric:true, get:m=>m._cons },
      { key:"nonFact", label:"Non facturable", numeric:true, get:m=>m._nonFact },
      { key:"raf", label:"RAF", numeric:true, sep:true, get:m=>m._raf },
    ];
    const missionRowHTML = m => `<tr class="row-clickable" data-id="${m.id}" style="cursor:pointer;">
        <td class="affaire-name">${esc(m.nom)}<span class="sub">${esc(consultantName(m.consultantId))} · ${dateFR(m.dateDebut)} → ${dateFR(m.dateFin)}</span>${joursBarHTML(m._cons, m.enveloppe, {mini:true})}</td>
        <td>${statutPill(m.statut)} ${missionStatusBadge(m)}</td>
        <td class="num">${jr(m.enveloppe)}</td>
        <td class="num">${euro(m.enveloppe*m.taux)}</td>
        <td class="num">${jr(m._cons)}</td>
        <td class="num">${m._nonFact>1e-9 ? jr(m._nonFact) : "—"}</td>
        <td class="num col-sep-left">${jr(m._raf)}</td>
        ${missionProjCellsHTML(m.statut==="en cours", m, m._raf)}
      </tr>`;
    renderSortFilterTable("table-missions-affaire", missionsRows, missionCols, missionRowHTML, {
      rerender: renderAffaireDetail,
      emptyMsg: "Aucune mission sur cette affaire pour l'instant.",
      extraHeadCols: `<th class="num compact" colspan="${PROJECTION_MOIS}" style="text-align:center;">Projection (jours/mois) — modifiable si 6 mois ou plus restants</th>`,
      extraHeadRow: `<tr><td colspan="6"></td><td colspan="1" class="col-sep-left"></td>${projHeadHTML()}</tr>`,
      afterRender: table => table.querySelectorAll("tr[data-id]").forEach(tr=>{
        tr.addEventListener("click", (e)=>{
          if(e.target.closest(".proj-input")) return; // ne pas ouvrir la fiche mission depuis le champ de projection
          openModifierMission(tr.dataset.id);
        });
      }),
      tfoot: display => {
        const n = display.length;
        const sumEnv = display.reduce((s,m)=>s+m.enveloppe,0);
        const sumBudget = display.reduce((s,m)=>s+m.enveloppe*m.taux,0);
        const sumCons = display.reduce((s,m)=>s+m._cons,0);
        const sumNonFact = display.reduce((s,m)=>s+m._nonFact,0);
        const sumRaf = display.reduce((s,m)=>s+m._raf,0);
        return `<tfoot><tr>
          <td colspan="2">Total (${n} mission${n>1?"s":""})</td>
          <td class="num">${jr(sumEnv)}</td>
          <td class="num">${euro(sumBudget)}</td>
          <td class="num">${jr(sumCons)}</td>
          <td class="num">${sumNonFact>1e-9 ? jr(sumNonFact) : "—"}</td>
          <td class="num col-sep-left">${jr(sumRaf)}</td>
          ${missionProjSumsHTML(display, m=>m.statut==="en cours", m=>m._raf)}
        </tr></tfoot>`;
      },
    });

    renderFacturesAffaire(a.id);
  }

  // Panneau "Factures de l'affaire" (fiche affaire) — même mécanique de tableau que les missions.
  // Filtre à cocher (comme filtreStatuts/filtrePortefeuille) pour la table « Factures de
  // l'affaire » — annulée masquée par défaut (statut d'exception), les 3 autres visibles.
  const STATUTS_FACTURE = ["prévisionnelle","facturée","payée","annulée"];
  let filtreStatutsFactures = new Set(["prévisionnelle","facturée","payée"]);
  function renderFiltreStatutsFactures(affaireId){
    const wrap = document.getElementById("filtre-statut-factures-affaire");
    if(!wrap) return;
    wrap.innerHTML = STATUTS_FACTURE.map(s=>`<button type="button" class="chip ${filtreStatutsFactures.has(s)?"on":""}" data-s="${s}">${s}</button>`).join("");
    wrap.querySelectorAll(".chip").forEach(chip=>{
      chip.addEventListener("click", ()=>{
        const s = chip.dataset.s;
        if(filtreStatutsFactures.has(s)) filtreStatutsFactures.delete(s); else filtreStatutsFactures.add(s);
        renderFacturesAffaire(affaireId);
      });
    });
  }
  // J+N d'une facture non déposée par rapport à son échéance prévisionnelle (à partir de J+1) —
  // même calcul que l'alerte « retard-depot » de facturesAlertes(), porté ici sur la cellule
  // Échéance prévisionnelle plutôt que sur la cellule Statut.
  function factureRetardDepot(f){
    const todayISO = today.toISOString().slice(0,10);
    if(f.statut!=="prévisionnelle" || !f.echeancePrev || f.echeancePrev>=todayISO) return null;
    return joursEntre(f.echeancePrev, todayISO) - 1;
  }
  // J+N d'une facture facturée non payée par rapport à son échéance de paiement (ou, à défaut,
  // dépôt + 30 jours) — même seuil que l'alerte « retard-paiement » de facturesAlertes(), porté
  // ici sur la cellule Date de paiement plutôt que sur la cellule Statut ; n'apparaît qu'à partir
  // de J+30 lorsqu'aucune échéance de paiement explicite n'a été saisie.
  function factureRetardPaiement(f){
    if(f.statut!=="facturée" || f.payee) return null;
    const todayISO = today.toISOString().slice(0,10);
    const seuil = f.echeancePaiementPrev || (f.dateDepot ? addDaysISO(f.dateDepot, 30) : null);
    if(!seuil || todayISO<=seuil) return null;
    return joursEntre(seuil, todayISO) - 1;
  }
  function renderFacturesAffaire(affaireId){
    const table = document.getElementById("table-factures-affaire");
    if(!table) return;
    renderFiltreStatutsFactures(affaireId);
    const rows = facturesAffaire(affaireId).filter(f=>filtreStatutsFactures.has(f.statut));
    const columns = [
      { key:"numero", label:"Numéro", get:f=>f.numero||"—" },
      { key:"statut", label:"Statut", filterable:true, get:f=>f.statut },
      { key:"echeance", label:"Échéance prévisionnelle", get:f=>f.echeancePrev },
      { key:"depot", label:"Dépôt", get:f=>f.dateDepot||"" },
      { key:"paiement", label:"Date de paiement", get:f=>f.datePaiement||"" },
      { key:"ht", label:"Total HT", numeric:true, get:f=>factureTotalHT(f) },
      { key:"ttc", label:"Total TTC", numeric:true, get:f=>factureTotalTTC(f) },
    ];
    const rowHTML = f => {
      const retardDepot = factureRetardDepot(f);
      const retardPaiement = factureRetardPaiement(f);
      const celluleDepot = f.dateDepot ? dateFR(f.dateDepot) : "—";
      let cellulePaiement;
      if(f.statut==="payée") cellulePaiement = dateFR(f.datePaiement);
      else if(f.statut==="facturée") cellulePaiement = `non réglée${retardPaiement!==null ? ` <span class="badge-overrun">⚠ J+${retardPaiement}</span>` : ""}`;
      else cellulePaiement = "—";
      return `<tr class="row-clickable" data-id="${f.id}" style="cursor:pointer;">
        <td class="affaire-name">${esc(f.numero)||"—"}${f.formation ? `<span class="sub">Formation — sans TVA</span>` : ""}</td>
        <td>${factureStatutPill(f.statut)}</td>
        <td>${dateFR(f.echeancePrev)}${retardDepot!==null ? ` <span class="badge-overrun">⚠ J+${retardDepot}</span>` : ""}</td>
        <td>${celluleDepot}</td>
        <td>${cellulePaiement}</td>
        <td class="num">${euroCents(factureTotalHT(f))}</td>
        <td class="num">${euroCents(factureTotalTTC(f))}</td>
      </tr>`;
    };
    renderSortFilterTable("table-factures-affaire", rows, columns, rowHTML, {
      rerender: ()=>renderFacturesAffaire(affaireId),
      emptyMsg: "Aucune facture sur cette affaire pour ce filtre.",
      afterRender: t => t.querySelectorAll("tr[data-id]").forEach(tr=>{
        tr.addEventListener("click", ()=>openModifierFacture(tr.dataset.id));
      }),
      tfoot: display => {
        const actives = display.filter(f=>f.statut!=="annulée");
        return `<tfoot><tr>
          <td colspan="5">Total (${display.length} facture${display.length>1?"s":""} affichée${display.length>1?"s":""}, hors annulées)</td>
          <td class="num">${euroCents(actives.reduce((s,f)=>s+factureTotalHT(f),0))}</td>
          <td class="num">${euroCents(actives.reduce((s,f)=>s+factureTotalTTC(f),0))}</td>
        </tr></tfoot>`;
      },
    });
  }

  let currentEditMissionId = null;
  function openNouvelleMission(){
    currentEditMissionId = null;
    clearFieldErrors("#modal-mission");
    document.getElementById("modal-mission-title").textContent = "Nouvelle mission";
    populateConsultantSelects();
    const a = affaires.find(x=>x.id===currentAffaireDetailId);
    document.getElementById("m-nom").value = "";
    document.getElementById("m-statut").value = "en cours";
    document.getElementById("m-enveloppe").value = 10;
    document.getElementById("m-taux").value = 600;
    document.getElementById("m-comment").value = "";
    document.getElementById("m-debut").value = a.dateDebut;
    document.getElementById("m-fin").value = a.dateFin;
    document.getElementById("m-debut").min = a.dateDebut; document.getElementById("m-debut").max = a.dateFin;
    document.getElementById("m-fin").min = a.dateDebut; document.getElementById("m-fin").max = a.dateFin;
    document.getElementById("alert-mission-dates").classList.remove("show");
    document.getElementById("alert-mission-jours").classList.remove("show");
    document.getElementById("alert-mission-budget").classList.remove("show");
    document.getElementById("m-consultant").onchange = ()=>{
      const cons = consultants.find(x=>x.id===document.getElementById("m-consultant").value);
      if(cons) document.getElementById("m-taux").value = cons.tjmBase;
    };
    document.getElementById("m-consultant").dispatchEvent(new Event("change"));
    openModal("modal-mission");
  }
  function openModifierMission(missionId){
    const m = missions.find(x=>x.id===missionId);
    if(!m) return;
    const a = affaires.find(x=>x.id===m.affaireId);
    currentEditMissionId = missionId;
    clearFieldErrors("#modal-mission");
    document.getElementById("modal-mission-title").textContent = "Modifier la mission";
    populateConsultantSelects();
    document.getElementById("m-nom").value = m.nom;
    document.getElementById("m-consultant").value = m.consultantId;
    document.getElementById("m-statut").value = m.statut;
    document.getElementById("m-enveloppe").value = m.enveloppe;
    document.getElementById("m-taux").value = m.taux;
    document.getElementById("m-comment").value = m.commentaires || "";
    document.getElementById("m-debut").value = m.dateDebut;
    document.getElementById("m-fin").value = m.dateFin;
    document.getElementById("m-debut").min = a.dateDebut; document.getElementById("m-debut").max = a.dateFin;
    document.getElementById("m-fin").min = a.dateDebut; document.getElementById("m-fin").max = a.dateFin;
    document.getElementById("alert-mission-dates").classList.remove("show");
    document.getElementById("alert-mission-jours").classList.remove("show");
    document.getElementById("alert-mission-budget").classList.remove("show");
    document.getElementById("m-consultant").onchange = null; // en édition, on ne réécrase pas le taux déjà négocié
    openModal("modal-mission");
  }
  // Champs obligatoires du module de saisie de mission : tout sauf les commentaires.
  function firstMissingMissionField(){
    const checks = [
      { id:"m-nom", label:"Nom de la mission", empty:()=>!document.getElementById("m-nom").value.trim() },
      { id:"m-consultant", label:"Consultant", empty:()=>!document.getElementById("m-consultant").value },
      { id:"m-enveloppe", label:"Enveloppe temps facturable (jours)", empty:()=>!(+document.getElementById("m-enveloppe").value > 0) },
      { id:"m-taux", label:"Taux journalier (€)", empty:()=>!(+document.getElementById("m-taux").value > 0) },
      { id:"m-debut", label:"Date prévisionnelle de début", empty:()=>!document.getElementById("m-debut").value },
      { id:"m-fin", label:"Date prévisionnelle de fin", empty:()=>!document.getElementById("m-fin").value },
    ];
    return checks.find(c=>c.empty()) || null;
  }
  function saveMission(){
    clearFieldErrors("#modal-mission");
    const missing = firstMissingMissionField();
    if(missing){
      markFieldError(missing.id);
      toast(`Le champ « ${missing.label} » est obligatoire`);
      return;
    }
    const a = affaires.find(x=>x.id===currentAffaireDetailId);
    const nom = document.getElementById("m-nom").value.trim();
    const dateDebut = document.getElementById("m-debut").value;
    const dateFin = document.getElementById("m-fin").value;
    const dAlert = document.getElementById("alert-mission-dates");
    if(dateDebut < a.dateDebut || dateFin > a.dateFin || dateFin < dateDebut){
      dAlert.querySelector("span").textContent =
        `Les dates de la mission doivent rester comprises entre le ${a.dateDebut} et le ${a.dateFin} (dates prévisionnelles de l'affaire).`;
      dAlert.classList.add("show");
      return; // contrainte bloquante
    }
    dAlert.classList.remove("show");

    const enveloppe = +document.getElementById("m-enveloppe").value || 0;
    const taux = +document.getElementById("m-taux").value || 0;
    const existant = currentEditMissionId ? missions.find(x=>x.id===currentEditMissionId) : null;

    const jAlert = document.getElementById("alert-mission-jours");
    const sumJoursSansCetteMission = missionsJoursSum(a.id) - (existant ? existant.enveloppe : 0);
    const futurJours = sumJoursSansCetteMission + enveloppe;
    if(futurJours > a.jours + 1e-9){
      jAlert.querySelector("span").textContent =
        `Enregistrement refusé : la somme des jours des missions (${futurJours} j) dépasserait les jours vendus de l'affaire (${a.jours} j).`;
      jAlert.classList.add("show");
      return; // contrainte bloquante
    }
    jAlert.classList.remove("show");

    const sumSansCetteMission = missionsBudgetSum(a.id) - (existant ? existant.enveloppe*existant.taux : 0);
    const futurSum = sumSansCetteMission + enveloppe*taux;
    const bAlert = document.getElementById("alert-mission-budget");
    if(futurSum > a.budget + 1e-6){
      bAlert.querySelector("span").textContent =
        `Attention, la somme des missions (${euro(futurSum)}) dépasse le budget vendu de l'affaire (${euro(a.budget)}). Enregistrement possible malgré tout.`;
      bAlert.classList.add("show");
    } else bAlert.classList.remove("show");

    const fields = {
      nom,
      consultantId: document.getElementById("m-consultant").value,
      statut: document.getElementById("m-statut").value,
      enveloppe, taux,
      dateDebut, dateFin, commentaires: document.getElementById("m-comment").value.trim(),
    };
    if(existant){
      Object.assign(existant, fields);
      toast("Mission mise à jour");
    } else {
      missions.push({ id:newEntityId("M"), affaireId:a.id, ...fields, projectionManuelle:{} });
      toast("Mission créée");
    }
    renderAffaireDetail();
    renderAll();
    if(!bAlert.classList.contains("show")) closeModal("modal-mission");
  }

  /* ================= Facturation : modale de saisie/suivi ================= */
  function switchFactureTab(name){
    document.querySelectorAll("#f-tabs .modal-tab").forEach(btn=>{
      btn.classList.toggle("active", btn.dataset.tab===name);
    });
    document.querySelectorAll("#modal-facture .modal-tabpanel").forEach(panel=>{
      panel.hidden = panel.dataset.tabpanel !== name;
    });
  }
  // Recalcule la ligne récapitulative (TVA / totaux) à partir des champs actuellement saisis dans
  // la modale — appelé à chaque frappe et à l'ouverture, pour un aperçu toujours à jour.
  function updateFactureRecap(){
    const formation = document.getElementById("f-formation").checked;
    const tva = formation ? 0 : 20;
    const missionHT = +document.getElementById("f-mission-ht").value || 0;
    const fraisTTC = +document.getElementById("f-frais-ttc").value || 0;
    const sousTraitanceHT = +document.getElementById("f-soustraitance-ht").value || 0;
    const totalHT = missionHT + sousTraitanceHT;
    const totalTTC = missionHT*(1+tva/100) + fraisTTC + sousTraitanceHT*(1+tva/100);
    document.getElementById("f-recap").textContent =
      `TVA ${tva}% — Total HT (mission + sous-traitance) : ${euroCents(totalHT)} · Total TTC : ${euroCents(totalTTC)}`;
  }
  let currentEditFactureId = null;
  function factureFormAffaireId(){
    const f = currentEditFactureId ? factures.find(x=>x.id===currentEditFactureId) : null;
    return f ? f.affaireId : currentAffaireDetailId;
  }
  function refreshFactureSuiviTab(f){
    document.getElementById("f-statut-pill").innerHTML = factureStatutPill(f.statut);
    document.getElementById("f-echeance-prev").value = f.echeancePrev || "";
    document.getElementById("f-echeance-paiement").value = f.echeancePaiementPrev || "";
    const depotWrap = document.getElementById("f-depot-wrap");
    depotWrap.hidden = !f.dateDepot;
    document.getElementById("f-depot-value").textContent = f.dateDepot ? dateFR(f.dateDepot) : "—";
    document.getElementById("f-btn-deposer").hidden = f.statut !== "prévisionnelle";
    const payeeWrap = document.getElementById("f-payee-wrap");
    payeeWrap.hidden = !(f.statut==="facturée" || f.statut==="payée");
    document.getElementById("f-payee").checked = f.payee;
    document.getElementById("f-payee").disabled = false; // reste modifiable même une fois payée, pour permettre la correction d'une erreur (confirmation demandée dans toggleFacturePayee)
    const dpWrap = document.getElementById("f-datepaiement-wrap");
    dpWrap.hidden = !f.datePaiement;
    document.getElementById("f-datepaiement-value").textContent = f.datePaiement ? dateFR(f.datePaiement) : "—";
    document.getElementById("f-btn-annuler").hidden = !(f.statut==="prévisionnelle" || f.statut==="facturée");
    document.getElementById("alert-facture-numero").classList.remove("show");
  }
  function openNouvelleFacture(affaireId){
    currentEditFactureId = null;
    switchFactureTab("saisie");
    document.getElementById("modal-facture-title").textContent = "Nouvelle facture";
    document.getElementById("f-numero").value = "";
    document.getElementById("f-formation").checked = false;
    document.getElementById("f-mission-ht").value = 0;
    document.getElementById("f-frais-ttc").value = 0;
    document.getElementById("f-soustraitance-ht").value = 0;
    document.getElementById("fact-comment").value = "";
    updateFactureRecap();
    refreshFactureSuiviTab({ statut:"prévisionnelle", echeancePrev:"", echeancePaiementPrev:"", dateDepot:null, payee:false, datePaiement:null });
    document.getElementById("f-echeance-prev").value = affaireId ? (affaires.find(a=>a.id===affaireId)?.dateFin || "") : "";
    openModal("modal-facture");
    modalFactureAffaireId = affaireId;
  }
  let modalFactureAffaireId = null;
  function openModifierFacture(factureId){
    const f = factures.find(x=>x.id===factureId);
    if(!f) return;
    currentEditFactureId = factureId;
    modalFactureAffaireId = f.affaireId;
    switchFactureTab("saisie");
    document.getElementById("modal-facture-title").textContent = "Modifier la facture";
    document.getElementById("f-numero").value = f.numero || "";
    document.getElementById("f-formation").checked = f.formation;
    document.getElementById("f-mission-ht").value = f.montantMissionHT;
    document.getElementById("f-frais-ttc").value = f.montantFraisTTC;
    document.getElementById("f-soustraitance-ht").value = f.montantSousTraitanceHT;
    document.getElementById("fact-comment").value = f.commentaires || "";
    updateFactureRecap();
    refreshFactureSuiviTab(f);
    openModal("modal-facture");
  }
  function saveFacture(){
    const fields = {
      numero: document.getElementById("f-numero").value.trim(),
      formation: document.getElementById("f-formation").checked,
      montantMissionHT: +document.getElementById("f-mission-ht").value || 0,
      montantFraisTTC: +document.getElementById("f-frais-ttc").value || 0,
      montantSousTraitanceHT: +document.getElementById("f-soustraitance-ht").value || 0,
      echeancePrev: document.getElementById("f-echeance-prev").value,
      echeancePaiementPrev: document.getElementById("f-echeance-paiement").value,
      commentaires: document.getElementById("fact-comment").value.trim(),
    };
    if(currentEditFactureId){
      Object.assign(factures.find(x=>x.id===currentEditFactureId), fields);
      toast("Facture mise à jour");
    } else {
      factures.push({ id:newEntityId("F"), affaireId: modalFactureAffaireId, dateDepot:null, payee:false, datePaiement:null,
        statut:"prévisionnelle", ...fields });
      toast("Facture créée");
    }
    closeModal("modal-facture");
    refreshFacturationViews();
  }
  // Dépôt / paiement / annulation : cascade simple sur le champ édité, sans modale supplémentaire —
  // même style d'interaction que marquerBordereauPaye() sur les notes de frais.
  function marquerFactureDeposee(){
    const f = currentEditFactureId ? factures.find(x=>x.id===currentEditFactureId) : null;
    if(!f || f.statut!=="prévisionnelle") return;
    const numero = document.getElementById("f-numero").value.trim();
    if(!numero){
      const al = document.getElementById("alert-facture-numero");
      al.querySelector("span").textContent = "Le numéro de facture n'est pas renseigné — dépôt enregistré malgré tout, pensez à le compléter dès qu'il sera connu.";
      al.classList.add("show");
    }
    f.numero = numero;
    f.montantMissionHT = +document.getElementById("f-mission-ht").value || 0;
    f.montantFraisTTC = +document.getElementById("f-frais-ttc").value || 0;
    f.montantSousTraitanceHT = +document.getElementById("f-soustraitance-ht").value || 0;
    f.formation = document.getElementById("f-formation").checked;
    f.echeancePrev = document.getElementById("f-echeance-prev").value;
    f.echeancePaiementPrev = document.getElementById("f-echeance-paiement").value;
    f.commentaires = document.getElementById("fact-comment").value.trim();
    f.dateDepot = today.toISOString().slice(0,10);
    f.statut = "facturée";
    refreshFactureSuiviTab(f);
    toast("Facture marquée déposée");
    refreshFacturationViews();
  }
  function toggleFacturePayee(){
    const f = currentEditFactureId ? factures.find(x=>x.id===currentEditFactureId) : null;
    if(!f || !(f.statut==="facturée" || f.statut==="payée")) return;
    const checked = document.getElementById("f-payee").checked;
    if(checked){
      f.payee = true;
      f.datePaiement = today.toISOString().slice(0,10);
      f.statut = "payée";
      refreshFactureSuiviTab(f);
      toast("Facture marquée payée");
      refreshFacturationViews();
    } else {
      // Décocher revient sur une facture déjà marquée payée : demande de confirmation avant
      // d'annuler le statut, pour éviter un dé-pointage accidentel tout en permettant de
      // corriger une erreur de saisie.
      const ok = confirm(`Êtes-vous sûr de vouloir annuler le statut « payée » de cette facture${f.numero ? " " + f.numero : ""} ?`);
      if(!ok){ document.getElementById("f-payee").checked = true; return; }
      f.payee = false;
      f.datePaiement = null;
      f.statut = "facturée";
      refreshFactureSuiviTab(f);
      toast("Statut « payée » annulé");
      refreshFacturationViews();
    }
  }
  function annulerFacture(){
    const f = currentEditFactureId ? factures.find(x=>x.id===currentEditFactureId) : null;
    if(!f || !(f.statut==="prévisionnelle" || f.statut==="facturée")) return;
    f.statut = "annulée";
    refreshFactureSuiviTab(f);
    toast("Facture annulée");
    refreshFacturationViews();
  }
  // Re-rend les vues facturation potentiellement affichées après une modification (fiche affaire
  // et/ou page cabinet "Facturation"), sans forcer de navigation.
  function refreshFacturationViews(){
    if(currentAffaireDetailId) renderFacturesAffaire(currentAffaireDetailId);
    if(currentView==="facturation") renderFacturation();
    if(currentView==="pilotage") renderMesAlertesFacturation();
  }

  /* ================= Facturation : page Cabinet ================= */
  // Même filtre à chips que sur « Factures de l'affaire » (STATUTS_FACTURE), état séparé car
  // page distincte — annulée masquée par défaut ici aussi.
  let filtreStatutsFacturationSociete = new Set(["prévisionnelle","facturée","payée"]);
  function renderFiltreStatutsFacturationSociete(){
    const wrap = document.getElementById("filtre-statut-facturation-societe");
    if(!wrap) return;
    wrap.innerHTML = STATUTS_FACTURE.map(s=>`<button type="button" class="chip ${filtreStatutsFacturationSociete.has(s)?"on":""}" data-s="${s}">${s}</button>`).join("");
    wrap.querySelectorAll(".chip").forEach(chip=>{
      chip.addEventListener("click", ()=>{
        const s = chip.dataset.s;
        if(filtreStatutsFacturationSociete.has(s)) filtreStatutsFacturationSociete.delete(s); else filtreStatutsFacturationSociete.add(s);
        renderFacturation();
      });
    });
  }
  function renderSelectAnneeFacturation(){
    const sel = document.getElementById("select-annee-facturation");
    // Inclut aussi les années de paiement effectif (datePaiement) : une facture échéancée en année
    // N-1 mais payée en année N doit pouvoir être vue via "Total payé N" même si aucune autre facture
    // n'a d'échéance prévisionnelle cette année-là.
    const years = Array.from(new Set([
      ...factures.filter(f=>f.echeancePrev).map(f=>f.echeancePrev.slice(0,4)),
      ...factures.filter(f=>f.statut==="payée" && f.datePaiement).map(f=>f.datePaiement.slice(0,4)),
    ])).sort().reverse();
    populateAnneeSelect(sel, years, renderFacturation);
  }

  // Totaux mensuels des factures effectivement émises (missions HT / frais refacturables TTC /
  // sous-traitance à régler HT), groupés par mois de dépôt réel (date d'émission) — seules les
  // factures "facturée" ou "payée" comptent (une prévisionnelle n'est pas encore émise, une annulée
  // ne compte plus), sur l'année choisie.
  function facturationMensuelle(year){
    const out = MOIS.map(label => ({ label, missionHT:0, fraisTTC:0, sousTraitanceHT:0 }));
    factures.filter(f=>(f.statut==="facturée" || f.statut==="payée") && f.dateDepot && f.dateDepot.slice(0,4)===year).forEach(f=>{
      const mo = +f.dateDepot.slice(5,7) - 1;
      out[mo].missionHT += f.montantMissionHT;
      out[mo].fraisTTC += f.montantFraisTTC;
      out[mo].sousTraitanceHT += f.montantSousTraitanceHT;
    });
    return out;
  }

  // Bouton unique (case à cocher visuelle, même principe que "Potentiel commercial" sur l'histogramme
  // de production) qui affiche ou masque la 3ᵉ couche "Sous-traitance à régler" — masquée par défaut
  // car ce ne sont pas des recettes qui restent au cabinet.
  let showSousTraitanceFacturation = false;
  function wireFacturationSousTraitanceToggle(){
    const btn = document.getElementById("chart-soustraitance-facturation-toggle");
    if(!btn || btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", ()=>{
      showSousTraitanceFacturation = !showSousTraitanceFacturation;
      btn.classList.toggle("on", showSousTraitanceFacturation);
      renderFacturation();
    });
  }

  // Histogramme empilé "Facturation" — missions (HT, vert) et frais refacturables (TTC, doré) toujours
  // affichés ; sous-traitance à régler (HT) en 3ᵉ couche hachurée optionnelle. Le total en tête reprend
  // les mêmes catégories que les couches affichées (donc varie selon l'état du bouton).
  function renderFacturationBarChart(hostId, data, year, showSousTraitance){
    const host = document.getElementById(hostId);
    if(!host) return;
    const totals = data.map(d=>d.missionHT + d.fraisTTC + (showSousTraitance ? d.sousTraitanceHT : 0));
    const maxRaw = Math.max(0, ...totals);
    const max = maxRaw>0 ? maxRaw*1.15 : 1;

    const W=880, H=240, mL=56, mR=8, mT=12, mB=28;
    const plotW = W-mL-mR, plotH = H-mT-mB;
    const n = data.length;
    const barGap = 6;
    const barW = (plotW - barGap*(n-1))/n;

    let gridLines = "";
    const gridSteps = 4;
    for(let i=0;i<=gridSteps;i++){
      const v = max*i/gridSteps;
      const y = mT+plotH-(v/max)*plotH;
      gridLines += `<line x1="${mL}" y1="${y.toFixed(1)}" x2="${W-mR}" y2="${y.toFixed(1)}" class="chart-grid"/>`;
      gridLines += `<text x="${mL-8}" y="${(y+3).toFixed(1)}" class="chart-axis-label" text-anchor="end">${euroCompact(v)}</text>`;
    }

    let bars = "";
    data.forEach((d,i)=>{
      const missionH = max>0 ? (d.missionHT/max)*plotH : 0;
      const fraisHraw = max>0 ? (d.fraisTTC/max)*plotH : 0;
      const segGap1 = (missionH>1 && fraisHraw>1) ? 2 : 0;
      const fraisH = Math.max(0, fraisHraw - segGap1);
      const sousTHraw = showSousTraitance && max>0 ? (d.sousTraitanceHT/max)*plotH : 0;
      const belowH = missionH + segGap1 + fraisH;
      const segGap2 = (belowH>1 && sousTHraw>1) ? 2 : 0;
      const sousTH = Math.max(0, sousTHraw - segGap2);
      const x = mL + i*(barW+barGap);
      const baseY = mT+plotH;
      const missionY = baseY - missionH;
      const fraisY = missionY - segGap1 - fraisH;
      const sousTY = baseY - belowH - segGap2 - sousTH;

      let segs = "";
      if(missionH>0.3){
        const rTop = (fraisH>0.3 || sousTH>0.3) ? 0 : 4;
        const tip = `Missions (HT) : ${euroCents(d.missionHT)}`;
        segs += `<path d="${roundedTopBarPath(x, missionY, barW, missionH, rTop)}" fill="var(--brand-green)" data-tip="${esc(tip)}"/>`;
      }
      if(fraisH>0.3){
        const rTop = sousTH>0.3 ? 0 : 4;
        const tip = `Frais refacturables (TTC) : ${euroCents(d.fraisTTC)}`;
        segs += `<path d="${roundedTopBarPath(x, fraisY, barW, fraisH, rTop)}" fill="var(--chart-beige)" data-tip="${esc(tip)}"/>`;
      }
      if(sousTH>0.3){
        const tip = `Sous-traitance à régler (HT) : ${euroCents(d.sousTraitanceHT)}`;
        segs += `<path d="${roundedTopBarPath(x, sousTY, barW, sousTH, 4)}" fill="url(#hatch-soustraitance-facturation)" data-tip="${esc(tip)}"/>`;
      }
      bars += `
        <g>
          ${segs}
          <text x="${(x+barW/2).toFixed(1)}" y="${H-mB+18}" class="chart-axis-label" text-anchor="middle">${d.label}</text>
        </g>`;
    });

    const totalMission = data.reduce((s,d)=>s+d.missionHT,0);
    const totalFrais = data.reduce((s,d)=>s+d.fraisTTC,0);
    const totalSousT = data.reduce((s,d)=>s+d.sousTraitanceHT,0);
    const totalGeneral = totalMission + totalFrais + (showSousTraitance ? totalSousT : 0);

    const sousTSummary = showSousTraitance
      ? `<div class="chart-summary-item"><span class="chart-swatch chart-swatch-soustraitance-facturation"></span>Sous-traitance à régler (HT) : <strong>${euroCents(totalSousT)}</strong></div>`
      : "";

    host.innerHTML = `
      <div class="chart-total-label">Total facturé ${year}${showSousTraitance ? " (missions + frais + sous-traitance)" : " (missions + frais)"}</div>
      <div class="chart-total-value">${euroCents(totalGeneral)}</div>
      <div class="chart-summary">
        <div class="chart-summary-item"><span class="chart-swatch" style="background:var(--brand-green);"></span>Missions (HT) : <strong>${euroCents(totalMission)}</strong></div>
        <div class="chart-summary-item"><span class="chart-swatch" style="background:var(--chart-beige);"></span>Frais refacturables (TTC) : <strong>${euroCents(totalFrais)}</strong></div>${sousTSummary}
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Facturation mensuelle ${year}, missions et frais refacturables${showSousTraitance ? ", sous-traitance à régler incluse" : ""}">
        <defs>
          <pattern id="hatch-soustraitance-facturation" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--panel-head-bg)" opacity=".55"/>
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--ocre-deep)" stroke-width="2"/>
          </pattern>
        </defs>
        ${gridLines}
        ${bars}
      </svg>
    `;
    wireChartTooltips(host);
  }

  // Colonnes et rendu de ligne communs à tous les tableaux "à la Toutes les factures" (page société
  // et, désormais, détail des alertes de facturation) — voir facturationTableRowHTML pour la gestion
  // des lignes "factices" (affaire sans aucune facture, utilisées pour l'alerte "non-planifiee").
  function facturationTableColumns(){
    return [
      { key:"affaire", label:"Affaire", filterable:true, get:f=>affaires.find(a=>a.id===f.affaireId)?.nom || "—" },
      { key:"responsable", label:"Responsable", filterable:true, get:f=>consultantName(affaires.find(a=>a.id===f.affaireId)?.pilote) },
      { key:"numero", label:"Numéro", get:f=>f.numero||"—" },
      { key:"statut", label:"Statut", filterable:true, get:f=>f.statut || "aucune facture" },
      { key:"echeance", label:"Échéance prévisionnelle", get:f=>f.echeancePrev||"" },
      { key:"depot", label:"Dépôt", get:f=>f.dateDepot||"" },
      { key:"paiement", label:"Date de paiement", get:f=>f.datePaiement||"" },
      { key:"ht", label:"Total HT", numeric:true, get:f=>factureTotalHT(f) },
      { key:"ttc", label:"Total TTC", numeric:true, get:f=>factureTotalTTC(f) },
    ];
  }
  function facturationTableRowHTML(f){
    const a = affaires.find(x=>x.id===f.affaireId);
    if(f._pseudo){
      // Affaire sans aucune facture (alerte "Affaires non échéancées") : même gabarit de ligne,
      // colonnes propres à la facture vides, pour rester cliquable vers la fiche affaire.
      return `<tr>
        <td class="affaire-name row-clickable" data-affaire="${esc(f.affaireId)}" style="cursor:pointer;">${a ? esc(a.nom) : "—"}<span class="sub">${a ? esc(orgName(a.organisationId)) : "—"}</span></td>
        <td>${a ? esc(consultantName(a.pilote)) : "—"}</td>
        <td>—</td>
        <td><span class="pill neutral">aucune facture</span></td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td class="num">—</td>
        <td class="num">—</td>
      </tr>`;
    }
    const retardDepot = factureRetardDepot(f);
    const retardPaiement = factureRetardPaiement(f);
    const celluleDepot = f.dateDepot ? dateFR(f.dateDepot) : "—";
    let cellulePaiement;
    if(f.statut==="payée") cellulePaiement = dateFR(f.datePaiement);
    else if(f.statut==="facturée") cellulePaiement = `non réglée${retardPaiement!==null ? ` <span class="badge-overrun">⚠ J+${retardPaiement}</span>` : ""}`;
    else cellulePaiement = "—";
    return `<tr>
      <td class="affaire-name row-clickable" data-affaire="${esc(f.affaireId)}" style="cursor:pointer;">${a ? esc(a.nom) : "—"}<span class="sub">${a ? esc(orgName(a.organisationId)) : "—"}</span></td>
      <td>${a ? esc(consultantName(a.pilote)) : "—"}</td>
      <td>${esc(f.numero)||"—"}</td>
      <td>${factureStatutPill(f.statut)}</td>
      <td>${dateFR(f.echeancePrev)}${retardDepot!==null ? ` <span class="badge-overrun">⚠ J+${retardDepot}</span>` : ""}</td>
      <td>${celluleDepot}</td>
      <td>${cellulePaiement}</td>
      <td class="num">${euroCents(factureTotalHT(f))}</td>
      <td class="num">${euroCents(factureTotalTTC(f))}</td>
    </tr>`;
  }
  function facturationTableTfoot(noun){
    return display => {
      const actives = display.filter(f=>!f._pseudo && f.statut!=="annulée");
      return `<tfoot><tr>
        <td colspan="7">Total (${display.length} ${noun}${display.length>1?"s":""}${noun==="facture"?", hors annulées":""})</td>
        <td class="num">${euroCents(actives.reduce((s,f)=>s+factureTotalHT(f),0))}</td>
        <td class="num">${euroCents(actives.reduce((s,f)=>s+factureTotalTTC(f),0))}</td>
      </tr></tfoot>`;
    };
  }
  function wireFacturationRowClicks(t){
    t.querySelectorAll(".row-clickable[data-affaire]").forEach(td=>{
      td.addEventListener("click", ()=>openAffaireDetail(td.dataset.affaire));
    });
  }

  // 4 catégories d'alertes de facturation, boutons à sélection unique (STATUTS_FACTURE réutilise déjà
  // les 4 types calculés par facturesAlertes() : retard-depot, retard-paiement, ecart, non-planifiee).
  const FACTURATION_ALERTE_TYPES = [
    { type:"non-planifiee", label:"Affaires non échéancées" },
    { type:"ecart", label:"Affaires partiellement échéancées" },
    { type:"retard-depot", label:"Factures non déposées" },
    { type:"retard-paiement", label:"Factures en souffrance" },
  ];
  // État de sélection (un seul type actif à la fois), indépendant entre la page Cabinet > Facturation
  // ("societe", toutes les affaires) et sa reprise sur Mon Pilotage ("moi", affaires pilotées par le
  // consultant connecté uniquement) — même principe que les autres états dupliqués de l'outil.
  const facturationAlertesSelection = { societe:null, moi:null };
  // Rend les 4 boutons (avec leur compteur) et, à droite, le détail de la catégorie sélectionnée —
  // sur la même base de tableau que "Toutes les factures" (facturationTableColumns/RowHTML), avec des
  // lignes factices pour les affaires sans aucune facture ("Affaires non échéancées"). `key` distingue
  // l'état de sélection ("societe"/"moi"), `ids` donne les 4 id DOM (boutons/empty/tableWrap/table) et
  // `getAlertes` fournit la liste d'alertes déjà réduite au périmètre voulu (tout le cabinet, ou une
  // seule personne).
  function renderFacturationAlertesUI(key, ids, getAlertes){
    const alertes = getAlertes();
    const boutons = document.getElementById(ids.boutons);
    boutons.innerHTML = FACTURATION_ALERTE_TYPES.map(t=>{
      const list = alertes.filter(a=>a.type===t.type);
      const level = list[0]?.level || "warn";
      return `<button type="button" class="fact-alert-btn ${facturationAlertesSelection[key]===t.type?"on":""}" data-type="${t.type}">
        <span class="fab-count"><span class="dot-ind ${level}"></span>${list.length}</span>
        <span class="fab-label">${t.label}</span>
      </button>`;
    }).join("");
    boutons.querySelectorAll(".fact-alert-btn").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const type = btn.dataset.type;
        facturationAlertesSelection[key] = (facturationAlertesSelection[key]===type) ? null : type;
        renderFacturationAlertesUI(key, ids, getAlertes);
      });
    });

    const emptyBox = document.getElementById(ids.empty);
    const tableWrap = document.getElementById(ids.tableWrap);
    const sel = facturationAlertesSelection[key];
    if(!sel){
      emptyBox.hidden = false;
      emptyBox.textContent = "Sélectionnez une catégorie d'alerte pour afficher le détail.";
      tableWrap.hidden = true;
      document.getElementById(ids.table).innerHTML = "";
      return;
    }
    const concernees = alertes.filter(a=>a.type===sel);
    let rows, noun;
    if(sel==="retard-depot" || sel==="retard-paiement"){
      const idsFacture = new Set(concernees.map(a=>a.factureId));
      rows = factures.filter(f=>idsFacture.has(f.id));
      noun = "facture";
    } else if(sel==="non-planifiee"){
      rows = concernees.map(a=>({ id:"pseudo-"+a.affaireId, affaireId:a.affaireId, _pseudo:true,
        montantMissionHT:0, montantFraisTTC:0, montantSousTraitanceHT:0 }));
      noun = "affaire";
    } else { // "ecart" : toutes les factures (hors annulées) des affaires en écart, pour revoir l'échéancier
      const affaireIds = new Set(concernees.map(a=>a.affaireId));
      rows = factures.filter(f=>affaireIds.has(f.affaireId) && f.statut!=="annulée");
      noun = "facture";
    }
    if(!rows.length){
      emptyBox.hidden = false;
      emptyBox.textContent = "Aucun élément pour cette catégorie.";
      tableWrap.hidden = true;
      document.getElementById(ids.table).innerHTML = "";
      return;
    }
    emptyBox.hidden = true;
    tableWrap.hidden = false;
    renderSortFilterTable(ids.table, rows, facturationTableColumns(), facturationTableRowHTML, {
      rerender: ()=>renderFacturationAlertesUI(key, ids, getAlertes),
      emptyMsg: "Aucun élément pour cette catégorie.",
      afterRender: wireFacturationRowClicks,
      tfoot: facturationTableTfoot(noun),
    });
  }
  function renderFacturationAlertes(){
    renderFacturationAlertesUI("societe", {
      boutons:"facturation-alertes-boutons", empty:"facturation-alertes-empty",
      tableWrap:"facturation-alertes-table-wrap", table:"table-facturation-alertes",
    }, facturesAlertes);
  }
  // Reprise de "Alertes de facturation" sur Mon Pilotage (Moi) — mêmes 4 catégories, même détail,
  // mais réduits aux seules affaires dont le consultant connecté est le pilote (responsable). Aussi
  // utilisée par checkMesAlertesBanner() (rappel en bas de « Ma page ») pour son propre compteur.
  function mesAlertesFacturation(){
    return facturesAlertes().filter(al=>affaires.find(a=>a.id===al.affaireId)?.pilote===currentUser);
  }
  function renderMesAlertesFacturation(){
    renderFacturationAlertesUI("moi", {
      boutons:"mes-alertes-facturation-boutons", empty:"mes-alertes-facturation-empty",
      tableWrap:"mes-alertes-facturation-table-wrap", table:"table-mes-alertes-facturation",
    }, mesAlertesFacturation);
  }

  /* ================= Alertes de pilotage d'affaire (Mon Pilotage + Cabinet > Affaires) ========= */
  // 5 catégories, indépendantes des alertes de facturation — qualité/complétude du pilotage des
  // affaires (budget réparti, caractéristiques renseignées, missions créées et à jour, échéances
  // tenues). Chaque alerte porte soit sur une affaire (missionId:null), soit sur une mission précise
  // (missionId renseigné, cas "missions-a-reecheancer"). Cœur générique paramétré par l'ensemble
  // d'affaires à couvrir (scopeAffaires) — permet de réutiliser exactement la même logique pour
  // « Mes affaires » (Mon Pilotage, un seul consultant) et « Alertes Affaires » (Cabinet > Affaires,
  // toutes les affaires du cabinet).
  function pilotageAffaireAlertesPourAffaires(scopeAffaires){
    const scopeIds = new Set(scopeAffaires.map(a=>a.id));
    const todayISO = today.toISOString().slice(0,10);
    const alertes = [];
    // 1. Incohérences budgétaires : missions + frais + sous-traitance ≠ budget vendu (réutilise
    //    coherenceInfo(), déjà utilisée sur le panneau "Cohérence budgétaire" de la fiche affaire).
    scopeAffaires.forEach(a=>{
      const c = coherenceInfo(a);
      if(c.level!=="good"){
        alertes.push({ type:"incoherence-budgetaire", affaireId:a.id, missionId:null, level:c.level, label:c.label });
      }
    });
    // 2. Absence de caractéristiques : au moins une des 3 listes (méthodes/territoires/domaines) vide.
    scopeAffaires.forEach(a=>{
      if((a.methodes||[]).length===0 || (a.territoires||[]).length===0 || (a.domaines||[]).length===0){
        alertes.push({ type:"absence-caracteristiques", affaireId:a.id, missionId:null, level:"warn",
          label:"Méthodes, type de territoire ou domaine d'intervention non renseigné" });
      }
    });
    // 3. Missions non créées : jours vendus de l'affaire pas totalement couverts par des missions
    //    créées — sur le même périmètre que les alertes de facturation "à échéancer" (en production
    //    ou terminée : avant, l'affaire n'est pas encore gagnée), croisé avec le périmètre demandé.
    affairesFacturables().filter(a=>scopeIds.has(a.id)).forEach(a=>{
      if(missionsJoursSum(a.id) < a.jours - 1e-6){
        alertes.push({ type:"missions-non-creees", affaireId:a.id, missionId:null, level:"warn",
          label:"Jours vendus pas totalement couverts par des missions créées" });
      }
    });
    // 4. Missions à rééchéancer : mission encore "en cours" dont l'échéance est dépassée.
    missions.filter(m=>m.statut==="en cours" && m.dateFin && m.dateFin<todayISO).forEach(m=>{
      if(scopeIds.has(m.affaireId)){
        alertes.push({ type:"missions-a-reecheancer", affaireId:m.affaireId, missionId:m.id, level:"warn",
          label:"Mission toujours en cours, échéance dépassée" });
      }
    });
    // 5. Affaire à rééchéancer : affaire encore active (en commercialisation ou en production, donc
    //    ni terminée ni perdue) dont l'échéance est dépassée.
    scopeAffaires.filter(a=>a.statut==="en commercialisation" || a.statut==="en production").forEach(a=>{
      if(a.dateFin && a.dateFin<todayISO){
        alertes.push({ type:"affaire-a-reecheancer", affaireId:a.id, missionId:null, level:"warn",
          label:"Affaire toujours active, échéance dépassée" });
      }
    });
    return alertes;
  }
  // « Mes affaires » (Mon Pilotage) : affaires pilotées par le consultant connecté, hors perdues
  // (qui n'ont plus vocation à être complétées).
  function alertesPilotageAffaire(consultantId){
    return pilotageAffaireAlertesPourAffaires(affaires.filter(a=>a.pilote===consultantId && a.statut!=="perdue"));
  }
  // « Alertes Affaires » (Cabinet > Affaires) : toutes les affaires du cabinet, tous consultants
  // confondus, ni terminées ni perdues (les affaires perdues n'ont plus vocation à être complétées).
  // Rappel : l'alerte "missions-non-creees" ne s'applique de toute façon qu'aux affaires "en
  // production" (via affairesFacturables()) — une affaire "en commercialisation" n'a normalement pas
  // encore de missions créées, ce n'est donc jamais signalé comme une anomalie pour ce statut.
  function alertesAffairesCabinet(){
    return pilotageAffaireAlertesPourAffaires(affaires.filter(a=>a.statut!=="terminée" && a.statut!=="perdue"));
  }
  const PILOTAGE_ALERTE_TYPES = [
    { type:"incoherence-budgetaire", label:"Incohérences budgétaires" },
    { type:"absence-caracteristiques", label:"Absence de caractéristiques" },
    { type:"missions-non-creees", label:"Missions non créées" },
    { type:"missions-a-reecheancer", label:"Missions à rééchéancer" },
    { type:"affaire-a-reecheancer", label:"Affaire à rééchéancer" },
  ];
  const pilotageAlertesSelection = { moi:null, cabinet:null };
  // Détail volontairement simplifié (pas un tableau complet comme pour la facturation) : juste
  // l'affaire (ou la mission) concernée, avec son client, et un bouton qui ouvre la fiche affaire.
  // Cœur générique, réutilisé par « Alertes sur mon pilotage d'affaire » (Mon Pilotage) et
  // « Alertes Affaires » (Cabinet > Affaires).
  function renderPilotageAlertesUI(key, ids, getAlertes){
    const alertes = getAlertes();
    const boutons = document.getElementById(ids.boutons);
    boutons.innerHTML = PILOTAGE_ALERTE_TYPES.map(t=>{
      const list = alertes.filter(a=>a.type===t.type);
      const level = list[0]?.level || "warn";
      return `<button type="button" class="fact-alert-btn ${pilotageAlertesSelection[key]===t.type?"on":""}" data-type="${t.type}">
        <span class="fab-count"><span class="dot-ind ${level}"></span>${list.length}</span>
        <span class="fab-label">${t.label}</span>
      </button>`;
    }).join("");
    boutons.querySelectorAll(".fact-alert-btn").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const type = btn.dataset.type;
        pilotageAlertesSelection[key] = (pilotageAlertesSelection[key]===type) ? null : type;
        renderPilotageAlertesUI(key, ids, getAlertes);
      });
    });

    const emptyBox = document.getElementById(ids.empty);
    const listWrap = document.getElementById(ids.listWrap);
    const sel = pilotageAlertesSelection[key];
    if(!sel){
      emptyBox.hidden = false;
      emptyBox.textContent = "Sélectionnez une catégorie d'alerte pour afficher le détail.";
      listWrap.hidden = true;
      listWrap.innerHTML = "";
      return;
    }
    const concernees = alertes.filter(a=>a.type===sel);
    if(!concernees.length){
      emptyBox.hidden = false;
      emptyBox.textContent = "Aucun élément pour cette catégorie.";
      listWrap.hidden = true;
      listWrap.innerHTML = "";
      return;
    }
    emptyBox.hidden = true;
    listWrap.hidden = false;
    listWrap.innerHTML = concernees.map(al=>{
      const a = affaires.find(x=>x.id===al.affaireId);
      const m = al.missionId ? missions.find(x=>x.id===al.missionId) : null;
      const titre = esc(m ? m.nom : (a ? a.nom : "—"));
      const sousTitre = esc(m ? `${a ? a.nom : "—"} — ${a ? orgName(a.organisationId) : "—"}` : (a ? orgName(a.organisationId) : "—"));
      return `<div class="pilotage-alerte-item">
        <div class="pai-main">
          <div class="pai-title">${titre}</div>
          <div class="pai-sub">${sousTitre}</div>
        </div>
        <button type="button" class="btn ghost" data-affaire="${al.affaireId}">Compléter/corriger</button>
      </div>`;
    }).join("");
    listWrap.querySelectorAll("[data-affaire]").forEach(btn=>{
      btn.addEventListener("click", ()=>openAffaireDetail(btn.dataset.affaire));
    });
  }
  function renderMesAlertesPilotageAffaire(){
    renderPilotageAlertesUI("moi", {
      boutons:"pilotage-alertes-boutons", empty:"pilotage-alertes-empty", listWrap:"pilotage-alertes-list-wrap",
    }, ()=>alertesPilotageAffaire(currentUser));
  }
  function renderAlertesAffairesCabinet(){
    renderPilotageAlertesUI("cabinet", {
      boutons:"alertes-affaires-boutons", empty:"alertes-affaires-empty", listWrap:"alertes-affaires-list-wrap",
    }, alertesAffairesCabinet);
  }

  // Rappel affiché en bas de l'écran à chaque arrivée sur « Ma page » (chargement de l'app ou clic
  // sur « Vue rapide » dans le menu Moi) quand le consultant connecté a au moins une alerte de
  // facturation ou de pilotage d'affaire à traiter — reprend les mêmes compteurs que les 2 panneaux
  // « Mon Pilotage » (mesAlertesFacturation / alertesPilotageAffaire), sans dupliquer leur logique.
  // Non bloquant (fermable) et se réaffiche à chaque arrivée sur la page, plutôt que mémorisé une
  // fois pour toutes — tant qu'il reste des alertes à corriger, le rappel a sa raison d'être.
  function checkMesAlertesBanner(){
    const banner = document.getElementById("mes-alertes-banner");
    const nbFact = mesAlertesFacturation().length;
    const nbPilotage = alertesPilotageAffaire(currentUser).length;
    if(nbFact + nbPilotage === 0){
      banner.hidden = true;
      banner.classList.remove("show");
      return;
    }
    document.getElementById("mes-alertes-banner-text").textContent =
      `${nbFact} alerte${nbFact>1?"s":""} de facturation et ${nbPilotage} alerte${nbPilotage>1?"s":""} de pilotage d'affaire. Merci de corriger dans Mon Pilotage.`;
    banner.hidden = false;
    requestAnimationFrame(()=>banner.classList.add("show"));
  }
  function hideMesAlertesBanner(){
    const banner = document.getElementById("mes-alertes-banner");
    banner.classList.remove("show");
    setTimeout(()=>{ banner.hidden = true; }, 250);
  }

  function renderFacturation(){
    const year = document.getElementById("select-annee-facturation").value;
    const factYear = factures.filter(f=>(f.echeancePrev||"").slice(0,4)===year);
    const facturees = factYear.filter(f=>f.statut==="facturée" || f.statut==="payée");
    // "Total payé" doit refléter des encaissements réels : on filtre ici sur la date de paiement
    // effective (datePaiement), pas sur l'échéance prévisionnelle comme les deux autres tuiles — une
    // facture déposée (et échéancée) en année N-1 mais payée en année N apparaît donc bien dans le
    // total payé de l'année N, et pas dans celui de l'année N-1.
    const payees = factures.filter(f=>f.statut==="payée" && (f.datePaiement||"").slice(0,4)===year);
    const enAttente = factYear.filter(f=>f.statut==="prévisionnelle");

    const kpiHTTC = (label, rows) => `
      <div class="kpi kpi-combo">
        <div class="kpi-label">${label}</div>
        <div class="kpi-combo-row">
          <div class="kpi-combo-item"><div class="kpi-combo-value">${euro(rows.reduce((s,f)=>s+factureTotalHT(f),0))}</div><div class="kpi-combo-sub">HT</div></div>
          <div class="kpi-combo-item"><div class="kpi-combo-value">${euro(rows.reduce((s,f)=>s+factureTotalTTC(f),0))}</div><div class="kpi-combo-sub">TTC</div></div>
        </div>
      </div>`;
    document.getElementById("facturation-kpis").innerHTML = `
      ${kpiHTTC(`Total facturé ${year}`, facturees)}
      ${kpiHTTC(`Total payé ${year}`, payees)}
      ${kpiHTTC(`En attente / prévisionnel ${year}`, enAttente)}
    `;

    wireFacturationSousTraitanceToggle();
    renderFacturationBarChart("chart-facturation-mensuelle", facturationMensuelle(year), year, showSousTraitanceFacturation);

    renderFacturationAlertes();

    renderFiltreStatutsFacturationSociete();
    // Même base de tableau (colonnes, filtre à chips, badges J+) que « Factures de l'affaire »
    // (renderFacturesAffaire) — reprise ici telle quelle, avec la colonne Affaire en plus puisque
    // cette page couvre tout le cabinet.
    const rows = factYear.filter(f=>filtreStatutsFacturationSociete.has(f.statut));
    renderSortFilterTable("table-facturation-societe", rows, facturationTableColumns(), facturationTableRowHTML, {
      rerender: renderFacturation,
      emptyMsg: "Aucune facture échéancée sur cette année.",
      afterRender: wireFacturationRowClicks,
      tfoot: facturationTableTfoot("facture"),
    });
  }

  /* ================= Boot ================= */
  function renderAll(){
    renderFiltreStatuts();
    renderMesAffaires();
    renderMesMissions();
    renderSelectAnneeMoiChart();
    renderProductionChartMoi(document.getElementById("select-annee-moi-chart").value);
    renderKpis();
    if(currentView==="organisations") renderOrganisations();
    if(currentView==="affaires"){ renderAlertesAffairesCabinet(); renderPortefeuille(); }
    if(currentView==="affaire-detail") renderAffaireDetail();
    if(currentView==="societe") renderSociete();
    if(currentView==="consultants") renderConsultants();
    if(currentView==="frais"){ renderFraisSociete(); renderAdminBordereaux(); }
    if(currentView==="facturation") renderFacturation();
    if(currentView==="admin") renderListesReference();
    if(currentView==="mestemps"){
      renderMesTemps(); renderSelectAnnee(); renderSuiviTemps();
      renderRepartitionChart("chart-repartition-moi", "hatch-repartition-moi", document.getElementById("select-annee").value, currentUser);
      renderDonutChart("chart-donut-moi", document.getElementById("select-annee").value, currentUser);
    }
    if(currentView==="mesfrais"){ renderMesFrais(); renderMesBordereaux(); }
    if(currentView==="commercial") renderCommercialSociete();
    if(currentView==="commercial-moi") renderCommercialMoi();
    if(currentView==="pilotage"){ renderFiltreStatutsPilotage(); renderMesAffairesPilotage(); renderMesAlertesFacturation(); renderMesAlertesPilotageAffaire(); }
  }

  function boot(){
    const c = consultants.find(x=>x.id===currentUser);
    document.getElementById("identify-screen").style.display = "none";
    document.getElementById("main-shell").hidden = false;
    document.getElementById("mapage-title").textContent = `Bonjour ${c.nom.split(" ")[0]}`;
    document.getElementById("whoami-avatar").textContent = initials(c.id);
    document.getElementById("whoami-name").textContent = c.nom;
    document.getElementById("whoami-role").textContent = (appSessionUser && appSessionUser.role==="admin") ? "Administrateur" : (c.statut==="stagiaire" ? "Stagiaire" : "Consultant");
    renderAll();
    // Toujours de retour sur « Ma page » à l'arrivée (login, ou « Voir sa page » ci-dessous) — passer
    // par showView() plutôt que de se fier au seul état HTML par défaut déclenche au passage le rappel
    // d'alertes (checkMesAlertesBanner, voir la branche "mapage" de showView).
    showView("mapage");
  }

  // "Voir sa page" (depuis Cabinet > Consultants) : bascule temporairement l'identité connectée sur
  // le consultant choisi, pour parcourir Ma page / Mes temps / Mes frais exactement comme lui — sans
  // toucher à la session authentifiée (un rechargement de page restaure l'administrateur réel). Un bandeau reste
  // affiché tant que ce mode est actif, avec un retour explicite vers Cabinet > Consultants.
  function voirPageConsultant(id){
    if(id === currentUser) return;
    adminViewingAs = currentUser;
    currentUser = id;
    updateViewAsBanner();
    boot();
  }
  function updateViewAsBanner(){
    const banner = document.getElementById("viewas-banner");
    if(adminViewingAs){
      banner.hidden = false;
      document.getElementById("viewas-name").textContent = consultantName(currentUser);
    } else {
      banner.hidden = true;
    }
  }

  document.getElementById("open-saisie").addEventListener("click", openSaisie);
  document.getElementById("open-saisie-mestemps").addEventListener("click", openSaisie);
  document.getElementById("close-saisie").addEventListener("click", closeSaisie);
  document.getElementById("cancel-saisie").addEventListener("click", closeSaisie);
  document.getElementById("save-saisie").addEventListener("click", saveSaisie);
  document.getElementById("f-type").addEventListener("change", onTypeChange);
  document.getElementById("open-frais").addEventListener("click", openFrais);
  document.getElementById("save-frais").addEventListener("click", saveFrais);
  document.getElementById("fr-type").addEventListener("change", onFraisTypeChange);
  document.getElementById("fr-lignes-add").addEventListener("click", ()=>{
    if(editingLignesFrais.length >= MAX_LIGNES_FRAIS) return;
    editingLignesFrais.push({ tauxTVA:20, montantHT:0 });
    renderFraisLignesEditor();
    recomputeFraisTVA();
  });
  document.getElementById("switch-user").addEventListener("click", async ()=>{
    try{ await api("/api/logout",{method:"POST"}); }catch(e){}
    location.reload();
  });
  document.getElementById("mes-alertes-banner-close").addEventListener("click", hideMesAlertesBanner);
  document.getElementById("mes-alertes-banner-go").addEventListener("click", ()=>{
    hideMesAlertesBanner();
    showView("pilotage");
  });
  document.getElementById("viewas-retour").addEventListener("click", ()=>{
    currentUser = adminViewingAs;
    adminViewingAs = null;
    updateViewAsBanner();
    boot();
    showView("consultants");
  });
  document.getElementById("modal-saisie").addEventListener("click", (e)=>{ if(e.target.id==="modal-saisie") closeSaisie(); });
  wireExports();

  // Navigation
  document.querySelectorAll(".nav-item[data-view]:not([disabled])").forEach(btn=>{
    btn.addEventListener("click", ()=>showView(btn.dataset.view));
  });
  document.getElementById("retour-affaires").addEventListener("click", ()=>showView("affaires"));
  document.getElementById("retour-detail-temps").addEventListener("click", ()=>showView(detailTempsReturnView));
  document.getElementById("btn-detail-temps-moi").addEventListener("click", ()=>{
    openDetailTemps(currentUser, document.getElementById("select-annee").value, "mestemps");
  });
  document.getElementById("btn-detail-temps-societe").addEventListener("click", ()=>{
    openDetailTemps("all", document.getElementById("select-annee-societe").value, "societe");
  });
  document.getElementById("btn-detail-temps-affaire").addEventListener("click", ()=>{
    openDetailTempsAffaire(currentAffaireDetailId);
  });

  // Organisations
  document.getElementById("open-nouvelle-org").addEventListener("click", openNouvelleOrg);
  document.getElementById("save-org").addEventListener("click", saveOrg);

  // Consultants (Cabinet > Consultants)
  document.getElementById("open-nouveau-consultant").addEventListener("click", openNouveauConsultant);
  document.getElementById("save-consultant").addEventListener("click", saveConsultant);
  document.getElementById("c-statut").addEventListener("change", updateConsultantFormVisibility);
  document.getElementById("c-partiel-add").addEventListener("click", ()=>{
    editingPartiel.push({ debut: document.getElementById("c-embauche").value || `${CURRENT_YEAR}-01-01`, fin:null, pct:80 });
    renderPartielEditor();
  });
  // Listes de référence éditables (Tables & réglages) — méthodes, types de territoire, domaines
  wireListesReference();

  // Affaires / portefeuille
  document.getElementById("open-nouvelle-affaire").addEventListener("click", openNouvelleAffaire);
  document.getElementById("open-modifier-affaire").addEventListener("click", ()=>openModifierAffaire(currentAffaireDetailId));
  document.getElementById("save-affaire").addEventListener("click", saveAffaire);
  document.getElementById("recherche-affaires").addEventListener("input", (e)=>{
    rechercheAffaires = e.target.value; renderPortefeuille();
  });
  document.getElementById("a-partenaires-add").addEventListener("click", ()=>{
    if(editingPartenaires.length >= MAX_PARTENAIRES) return;
    syncPartenairesFromDOM();
    editingPartenaires.push({ organisationId:"", role:"co-traitant", montant:0 });
    renderPartenairesEditor();
    updatePartenairesAddButton();
  });
  document.getElementById("a-repartition-add").addEventListener("click", ()=>{
    syncRepartitionFromDOM();
    editingRepartition.push({ consultantId:"", pct:0 });
    renderRepartitionEditor();
  });
  document.querySelectorAll("#a-tabs .modal-tab").forEach(btn=>{
    btn.addEventListener("click", ()=>switchAffaireTab(btn.dataset.tab));
  });

  // Missions (depuis le détail affaire)
  document.getElementById("open-nouvelle-mission").addEventListener("click", openNouvelleMission);
  document.getElementById("save-mission").addEventListener("click", saveMission);

  // Factures (depuis le détail affaire et depuis Cabinet > Facturation)
  document.querySelectorAll("#f-tabs .modal-tab").forEach(btn=>{
    btn.addEventListener("click", ()=>switchFactureTab(btn.dataset.tab));
  });
  document.getElementById("open-nouvelle-facture").addEventListener("click", ()=>openNouvelleFacture(currentAffaireDetailId));
  document.getElementById("save-facture").addEventListener("click", saveFacture);
  document.getElementById("f-btn-deposer").addEventListener("click", marquerFactureDeposee);
  document.getElementById("f-payee").addEventListener("change", toggleFacturePayee);
  document.getElementById("f-btn-annuler").addEventListener("click", annulerFacture);
  ["f-formation","f-mission-ht","f-frais-ttc","f-soustraitance-ht"].forEach(id=>{
    const el = document.getElementById(id);
    el.addEventListener("input", updateFactureRecap);
    el.addEventListener("change", updateFactureRecap);
  });

  // Fermeture générique des modales (bouton ✕, Annuler, clic sur le fond)
  document.querySelectorAll("[data-close]").forEach(el=>{
    el.addEventListener("click", ()=>closeModal(el.dataset.close));
  });
  document.querySelectorAll(".modal-backdrop[id]").forEach(bd=>{
    bd.addEventListener("click", (e)=>{ if(e.target===bd) closeModal(bd.id); });
  });

  renderFiltrePortefeuille();

  startApp();
})();
