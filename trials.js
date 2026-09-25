// Test Results (trials) -- core module. Owns the trials array itself, the
// Firestore listener, and the main list/edit render pass (mountTrialsView/
// renderTrialsList). Everything else that used to live in this single file
// (it had grown past 2,600 lines, and its own size was directly
// responsible for a production incident -- a stray leftover tag deep in
// renderTrialsList broke the whole app, and was hard to spot precisely
// because the function was so large) has been split into:
//   - trials-data.js    -- pure data/model helpers, no DOM
//   - trials-wizard.js   -- the "Perform Evaluation" wizard overlay
//   - trials-summary.js  -- Summary Test modal, Summary Table, Excel export
//   - trials-share.js    -- Share External Evaluation + guest responses
// renderTrialsList's own body is intentionally left as one large function
// (unedited internally) rather than split further -- see trials-share.js/
// trials-wizard.js/trials-summary.js's own openX() helpers for the only
// changes this split required inside it: three inline state assignments
// became calls into those files' state instead, since an imported `let`
// binding is read-only to importers in ES modules.
import {
  recipes, recipeDisplayLabel, uid, currentUser, escapeHtml, icon, logActivityEvent,
  playContentTransition, projects, findProjectForRecipe, fullCode, formatWeight,
  allIngredientsInRecipe, formatActivityDateTime, PROJECT_STAGES, mainFeatureView,
  recipesLoaded, diffMainFields, requestAuthConfirm, resizeImageFile, formatDateLong,
  trialStringListHtml, trialsCol, showCloudError,
  metaLists, metaItemName, getRequirements, certificateSummaryText, moveToTrash
} from './app.js';
import {
  onSnapshot, doc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  trialLabel, migrateTrial, getTrialProductData, normalizeTrialPhotos, TRIAL_PHOTO_MAX,
  TRIAL_MAX_PRODUCTS, getEvaluationCriteria, getCriteriaNotes, combinedEvaluationEntries,
  jarScoreLabel, jarScoreDisplay, shortEvaluatorName, productNeedsRevision,
  improvementFieldValue, autoImprovementSuggestion, TRIAL_TEST_RESULT_CLASSES,
  TRIAL_TEST_RESULT_OPTIONS, groupTrialsByProject, blankManualTrialProduct,
  scheduleTrialSave, saveTrialToCloud, wireTrialTranslateButton, trialEvalTargets, blankTrial
} from './trials-data.js';
import { renderEvaluationWizard, openEvalWizard } from './trials-wizard.js';
import { renderTrialSummaryModal, openTrialSummaryModal, renderTrialsSummaryTable, exportTrialsSummaryToExcel } from './trials-summary.js';
import {
  renderTrialShareModal, renderShareResponsePreviewModal, openTrialShareModal,
  loadSharePendingCounts, trialSharePendingCounts, deleteTrialShareArtifacts
} from './trials-share.js';

let trials = [];
let trialExpandedIds = new Set();
let trialEditingId = null;
// "List" (the default card-per-test view, with Edit/Perform Evaluation/
// Summary Test/Print/Delete) vs "table" (a read-only, scannable overview
// -- Project / PD / inline Summary Test per row, most-recently-updated
// first -- see renderTrialsSummaryTable). Kept as its own toggle rather
// than replacing the list outright, since the table has none of the
// list's own actions.
let trialsViewMode = 'list';
let unsubscribeTrials = null;
let trialsLoaded = false;
let trialsMigrated = false;
const TRIAL_DIFF_FIELDS = { label: 'Recipes / Products Compared' };
let trialEditSnapshotBefore = null;

function deleteTrialFromCloud(id){
  deleteTrialShareArtifacts(id);
  return deleteDoc(doc(trialsCol, id));
}

/* One-time, idempotent move of each recipe's embedded trialPhotos/
   trialEvaluation into a standalone Trial record linked back by recipeId -
   guarded by trialsMigrated so it only ever runs once per session, and by
   the "does a trial already reference this recipe" check so re-running it
   (e.g. after a reload) can never create duplicates. The old fields are
   left on the recipe untouched (unused, harmless) rather than stripped, so
   this migration can't destroy data if anything about it is ever wrong. */
export function migrateTrialsFromRecipes(){
  if(trialsMigrated || !recipesLoaded || !trialsLoaded) return;
  trialsMigrated = true;
  let migratedAny = false;
  recipes.forEach(r => {
    const hasPhotos = Array.isArray(r.trialPhotos) && r.trialPhotos.length > 0;
    const hasEval = Array.isArray(r.trialEvaluation) && r.trialEvaluation.length > 0;
    if(!hasPhotos && !hasEval) return;
    if(trials.some(t => (t.recipeIds || []).includes(r.id))) return;
    const now = Date.now();
    const t = {
      id: uid(),
      recipeIds: [r.id],
      photos: hasPhotos ? r.trialPhotos : [],
      evaluation: hasEval ? r.trialEvaluation : [],
      createdBy: r.createdBy || '',
      createdAt: r.createdAt || now,
      updatedBy: currentUser?.email || '',
      updatedAt: now
    };
    trials.push(t);
    saveTrialToCloud(t);
    migratedAny = true;
  });
  if(migratedAny && mainFeatureView === 'trials') renderTrialsList();
}

export function mountTrialsView(){
  const main = document.getElementById('mainArea');
  main.classList.remove('main-wide');
  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('flask-conical', 24)} Test Results</div>
    </div>
    <div class="card">
      <div style="display:flex;align-items:center;margin-bottom:16px;">
        <button class="btn btn-primary btn-sm" id="btnAddTrial">+ New Test</button>
        <div class="view-mode-toggle" id="trialsViewToggle">
          <button type="button" class="btn btn-sm view-mode-btn${trialsViewMode === 'list' ? ' active' : ''}" data-mode="list">${icon('list', 14)} List</button>
          <button type="button" class="btn btn-sm view-mode-btn${trialsViewMode === 'table' ? ' active' : ''}" data-mode="table">${icon('file-text', 14)} Summary Table</button>
        </div>
        <button type="button" class="btn btn-sm" id="btnExportTrialsSummary" style="margin-left:8px;${trialsViewMode === 'table' ? '' : 'display:none;'}">${icon('download', 14)} Export Excel</button>
      </div>
      <div id="trialsList"></div>
    </div>
  `;

  document.getElementById('trialsViewToggle').querySelectorAll('.view-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      trialsViewMode = btn.dataset.mode;
      renderTrialsList();
      document.querySelectorAll('#trialsViewToggle .view-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === trialsViewMode));
      const exportBtn = document.getElementById('btnExportTrialsSummary');
      if(exportBtn) exportBtn.style.display = trialsViewMode === 'table' ? '' : 'none';
    });
  });

  document.getElementById('btnExportTrialsSummary').addEventListener('click', () => {
    exportTrialsSummaryToExcel();
  });

  document.getElementById('btnAddTrial').addEventListener('click', () => {
    const t = blankTrial();
    trials.push(t);
    saveTrialToCloud(t);
    logActivityEvent('created', 'trial', trialLabel(t));
    trialEditingId = t.id;
    trialExpandedIds.add(t.id);
    renderTrialsList();
  });

  renderTrialsList();
  loadSharePendingCounts();
  playContentTransition(main);
}

export function renderTrialsList(){
  const container = document.getElementById('trialsList');
  if(!container) return;
  if(trials.length === 0){
    container.innerHTML = '<div class="overview-empty">No test results yet — click "+ New Test" above to start one</div>';
    return;
  }
  // Most recent Tested date first (not last-edited timestamp) -- per user
  // feedback, "recent" here means when the test itself happened
  // (t.testDate, an ISO yyyy-mm-dd string from its own <input type="date">
  // so it already sorts correctly as plain text), not when the record was
  // last saved in Firestore, which can drift out of sync with that (e.g.
  // editing an OLDER test's Note today bumps its updatedAt past a newer
  // test nobody's touched since). Falls back to updatedAt only to break
  // ties between same-date (or both-blank-date) tests.
  const sorted = [...trials].sort((a,b) => (b.testDate || '').localeCompare(a.testDate || '') || (b.updatedAt - a.updatedAt));
  if(trialsViewMode === 'table'){
    renderTrialsSummaryTable(container, sorted);
    renderEvaluationWizard();
    renderTrialSummaryModal();
    renderTrialShareModal();
    renderShareResponsePreviewModal();
    return;
  }
  // Grouped by linked Project (see groupTrialsByProject, shared with the
  // Summary Table's own grouping) -- a header names the group when it has
  // one, tests inside it stay in the caller's own recency order (newest
  // first), same as before this was grouped. Untracked/unlinked tests
  // get no header, same as they always rendered.
  const groups = groupTrialsByProject(sorted);
  container.innerHTML = groups.map(g => {
    const groupProject = g.projectId ? projects.find(pr => pr.id === g.projectId) : null;
    const cardsHtml = g.trials.map(t => {
    const isEditing = t.id === trialEditingId;
    const isExpanded = isEditing || trialExpandedIds.has(t.id);
    // Migrated view used only for building this HTML string below — the
    // wiring block further down re-fetches the raw trial from `trials` and
    // guards each field defensively instead, same split used for Projects'
    // monthlyUpdates (see migrateMonthlyUpdate).
    const mt = migrateTrial(t);
    const linkedProject = mt.linkedProjectId ? projects.find(p => p.id === mt.linkedProjectId) : null;
    // The linked Project's own cover photo (p.image -- the same field the
    // Projects list/detail view itself shows, see .proj-row-photo-btn in
    // projects.js), not its separate Idea/Reference Images gallery, which
    // is inspiration material rather than "the project's own picture".
    const linkedProjectImage = linkedProject?.image || null;
    const linkedRecipes = (t.recipeIds || []).map(id => recipes.find(r => r.id === id)).filter(Boolean);
    const manualProducts = t.manualProducts || [];
    const combinedCount = (t.recipeIds || []).length + manualProducts.length;
    // The linked project's own name is already shown once, above this row,
    // via the .trial-project-group-header (see groupTrialsByProject) -- so
    // each row's own label leads with what's actually different per row:
    // the Tested date and which product(s) were tested that day.
    const productNames = combinedCount
      ? [...linkedRecipes.map(r => recipeDisplayLabel(r)), ...manualProducts.map(mp => mp.name || 'Untitled')]
      : [];
    const activity = [];
    if(t.createdBy) activity.push(`Created by ${escapeHtml(t.createdBy)}${t.createdAt ? ' · ' + escapeHtml(formatActivityDateTime(t.createdAt)) : ''}`);
    if(t.updatedBy && t.updatedAt !== t.createdAt) activity.push(`Last edited by ${escapeHtml(t.updatedBy)}${t.updatedAt ? ' · ' + escapeHtml(formatActivityDateTime(t.updatedAt)) : ''}`);

    const usedRecipeIds = new Set(t.recipeIds || []);
    const availableRecipes = recipes
      .filter(r => !usedRecipeIds.has(r.id))
      .sort((a,b) => (a.name||'').localeCompare(b.name||'', undefined, {sensitivity:'base'}));
    const atMax = combinedCount >= TRIAL_MAX_PRODUCTS;

    // A product's photos live per product now (not 3 shared across the
    // whole trial) — same idea as the read-only product cards below, built
    // once here and dropped into each card. No preset "Before/After
    // frying" categories -- just add up to TRIAL_PHOTO_MAX freely, each
    // with its own editable caption to say whatever it needs to. Reuses
    // the same thumbnail-grid-with-caption markup/CSS classes as Projects'
    // Idea / Reference Images gallery (proj-ref-image-*), just with
    // trial-specific data attributes on the interactive bits.
    const trialPhotosHtml = productId => {
      const pd = getTrialProductData(mt, productId);
      const photos = normalizeTrialPhotos(pd);
      const photosHtml = photos.map(photo => `
        <div class="proj-ref-image-item">
          <div class="proj-ref-image-thumb-wrap">
            <img src="${escapeHtml(photo.dataUrl)}" class="proj-ref-image-thumb" alt="${escapeHtml(photo.caption || 'Product photo')}">
            ${isEditing ? `<button type="button" class="proj-ref-image-remove" data-role="remove-trial-photo" data-product-id="${escapeHtml(productId)}" data-photo-id="${escapeHtml(photo.id)}" title="Remove">${icon('x', 12)}</button>` : ''}
          </div>
          ${isEditing
            ? `<input type="text" class="proj-ref-image-caption-input trial-photo-caption-input" data-product-id="${escapeHtml(productId)}" data-photo-id="${escapeHtml(photo.id)}" value="${escapeHtml(photo.caption || '')}" placeholder="Caption">`
            : (photo.caption ? `<div class="proj-ref-image-caption">${escapeHtml(photo.caption)}</div>` : '')}
        </div>
      `).join('');
      return `
        <div class="trial-photo-slot">
          ${photosHtml ? `<div class="proj-ref-images-grid">${photosHtml}</div>` : ''}
          ${isEditing && photos.length < TRIAL_PHOTO_MAX ? `<input type="file" class="trial-product-photo-input" data-product-id="${escapeHtml(productId)}" accept="image/*">` : ''}
          ${!isEditing && !photos.length ? '<div class="trial-photo-empty">No photo</div>' : ''}
        </div>
      `;
    };

    // Side-by-side product cards (same visual language as Compare Recipes'
    // info-grid) so every product being evaluated is visible at once,
    // instead of a click-to-reveal list — the whole point of a comparison.
    const recipeCardsHtml = (t.recipeIds || []).map(recipeId => {
      const r = recipes.find(x => x.id === recipeId);
      const removeBtn = isEditing ? `<button class="icon-btn" data-role="remove-trial-recipe" data-recipe-id="${escapeHtml(recipeId)}" title="Remove this product" style="margin-top:8px;">${icon('x')} Remove</button>` : '';
      if(!r){
        return `
          <div class="compare-info-col">
            <div class="ci-row" style="color:var(--danger);">Recipe not found (deleted?)</div>
            ${removeBtn}
          </div>
        `;
      }
      const totalWt = allIngredientsInRecipe(r).reduce((s,i) => s + (parseFloat(i.weight) || 0), 0);
      const link = findProjectForRecipe(r.id);
      return `
        <div class="compare-info-col">
          <div class="ci-name">${escapeHtml(recipeDisplayLabel(r))}</div>
          <div class="ci-row"><b>Code:</b> ${escapeHtml(fullCode(r) || '-')}</div>
          <div class="ci-row trial-print-hide-detail"><b>Date:</b> ${escapeHtml(r.date || '-')}</div>
          <div class="ci-row trial-print-hide-detail"><b>Total weight:</b> ${escapeHtml(formatWeight(totalWt))}</div>
          ${link?.project.customerName ? `<div class="ci-row trial-print-hide-detail"><b>Customer:</b> ${escapeHtml(link.project.customerName)}</div>` : ''}
          ${link?.project.destinationCountry ? `<div class="ci-row trial-print-hide-detail"><b>Destination:</b> ${escapeHtml(link.project.destinationCountry)}</div>` : ''}
          ${link?.project.ownerSalesRep ? `<div class="ci-row trial-print-hide-detail"><b>Project Owner:</b> ${escapeHtml(link.project.ownerSalesRep)}</div>` : ''}
          ${link ? `<div class="ci-row trial-print-hide-detail"><b>Stage:</b> ${escapeHtml(link.product.stage || '-')}</div>` : ''}
          ${trialPhotosHtml(r.id)}
          ${removeBtn}
        </div>
      `;
    }).join('');

    // A manually-typed product (not one of this app's Recipes) -- just a
    // name and a Code, both free text, plus its own before/after photos
    // (see trialPhotosHtml below). Date/Total weight/Customer/
    // Destination/Project Owner/Stage were dropped; the trial's own
    // Test Date field above already covers "when", and the rest only
    // made sense for a product that actually has a linked Project.
    const manualFieldRows = [
      ['code', 'Code', null]
    ];
    const manualCardsHtml = manualProducts.map(mp => {
      const removeBtn = isEditing ? `<button class="icon-btn" data-role="remove-trial-manual" data-manual-id="${escapeHtml(mp.id)}" title="Remove this product" style="margin-top:8px;">${icon('x')} Remove</button>` : '';
      // Duplicate copies this card (name, Code, photos) as a starting point
      // for a near-identical variant -- e.g. same product at a different
      // Code -- without retyping everything. Hidden once at the cap, same
      // as +Add above.
      const duplicateBtn = isEditing && !atMax ? `<button class="icon-btn" data-role="duplicate-trial-manual" data-manual-id="${escapeHtml(mp.id)}" title="Duplicate this product" style="margin-top:8px;">${icon('copy')} Duplicate</button>` : '';
      if(isEditing){
        return `
          <div class="compare-info-col" data-manual-id="${escapeHtml(mp.id)}">
            <input type="text" class="tmanual-field ci-name-input" data-field="name" value="${escapeHtml(mp.name)}" placeholder="Product name">
            ${manualFieldRows.map(([field, label, datalist]) => `
              <div class="ci-row"><b>${label}:</b> ${
                datalist === 'select'
                  ? `<select class="tmanual-field" data-field="${field}">
                      <option value="">-</option>
                      ${PROJECT_STAGES.map(s => `<option value="${escapeHtml(s)}" ${mp[field] === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
                    </select>`
                  : `<input type="${field === 'date' ? 'date' : 'text'}" class="tmanual-field" data-field="${field}" value="${escapeHtml(mp[field] || '')}" placeholder="-" ${datalist ? `list="${datalist}"` : ''}>`
              }</div>
            `).join('')}
            ${trialPhotosHtml(mp.id)}
            ${duplicateBtn}
            ${removeBtn}
          </div>
        `;
      }
      return `
        <div class="compare-info-col">
          <div class="ci-name">${escapeHtml(mp.name || 'Untitled')} <span style="font-weight:400;color:var(--text-dim);">(manual)</span></div>
          ${manualFieldRows.map(([field, label]) => mp[field] ? `<div class="ci-row"><b>${label}:</b> ${escapeHtml(mp[field])}</div>` : '').join('')}
          ${trialPhotosHtml(mp.id)}
        </div>
      `;
    }).join('');

    const productCardsHtml = recipeCardsHtml + manualCardsHtml;

    // Leading 220px spacer/column matches the fixed-width "Criteria" column
    // in the evaluation table below, so each product's card lines up with
    // its own score column — same technique used on the Compare Recipes page.
    const productCardsGrid = productCardsHtml
      ? `<div class="compare-info-grid gap-via-margin" style="grid-template-columns:220px repeat(${combinedCount},minmax(0,1fr));"><div class="compare-info-spacer"></div>${productCardsHtml}</div>`
      : '<div class="overview-empty">No products added yet</div>';

    // Each row's score is per-product (columns matching the product cards
    // above) so every sample can be scored against the same criteria in one
    // glance, the same way Compare Recipes lines up ingredients per recipe.
    // Manual products score exactly like linked recipes — same map keyed by
    // the manual product's own id instead of a recipeId (see
    // getTrialProductData). Criteria rows (see getEvaluationCriteria) are
    // per-trial and user-editable now, replacing the old fixed/freeform
    // split -- add, rename, or remove a row from the Sensory Evaluation
    // table and Improvement Guidelines' rows follow, since both read from
    // the same list.
    const evalTargets = [
      // `name`/`code` are additive -- Sensory Evaluation's own header
      // below is the only consumer of either; `label` keeps its existing
      // code-only/name+code shape exactly as Improvement Guidelines'
      // header and every other consumer of evalTargets already expects.
      ...linkedRecipes.map(r => {
        const code = fullCode(r) || recipeDisplayLabel(r);
        return { id: r.id, name: r.name || 'Untitled recipe', code, label: code };
      }),
      // Two manual products can share the same name (e.g. duplicated as a
      // starting point for a variant, or just two samples of "Alfrado" at
      // different Codes) -- appending the Code keeps their evaluation
      // table columns distinguishable instead of both reading "ALFRADO".
      ...manualProducts.map(mp => ({ id: mp.id, name: mp.name || 'Untitled', code: mp.code || '', label: [mp.name || 'Untitled', mp.code].filter(Boolean).join(' ') }))
    ];
    // Sensory Evaluation's own header shows the product name above its
    // code (same convention as Compare Recipes/Trials' own column
    // headers, reusing its compare-th-name/compare-th-code classes) --
    // per request, scoped to this one table; Improvement Guidelines'
    // header just below keeps showing `label` (code-only/name+code) as
    // before.
    const evalHeaderCells = evalTargets.map((p, i) => `<th class="${i > 0 ? 'recipe-boundary' : ''}"><div class="compare-th-name">${escapeHtml(p.name)}</div>${p.code ? `<div class="compare-th-code">${escapeHtml(p.code)}</div>` : ''}</th>`).join('');
    // Improvement Guidelines' own header row (NOT shared with Sensory
    // Evaluation's identical-looking one above, even though both tables
    // otherwise reuse evalTargets/evaluationCriteria). Both the per-sample
    // columns and the trailing Note column are plain free-text fields either
    // way -- but per-sample is meant for the app's own suggested fix for
    // that criteria/sample, while Note is a person's own separate remark,
    // and that distinction wasn't obvious from the column labels alone, so
    // each gets a small caption explaining which is which.
    const improvementHeaderCells = evalTargets.map((p, i) => `<th class="${i > 0 ? 'recipe-boundary' : ''}">${escapeHtml(p.label)}<span class="teval-header-hint">Automatic suggestion (คำแนะนำอัตโนมัติ)</span></th>`).join('');
    const evaluationCriteria = getEvaluationCriteria(mt);
    const sensoryCriteriaNotes = getCriteriaNotes(mt, 'criteriaNotes');
    const fixedCriteriaRowsHtml = evaluationCriteria.map((c, ci) => {
      // Combined per-evaluator notes for this criteria, across every
      // product -- links this column to what's actually typed per-sample
      // in the Perform Evaluation wizard (mine[`${criteriaId}_note`])
      // instead of one hand-typed note only reachable via Edit mode. A
      // note typed the old way (before the wizard had its own per-
      // criteria Note field) is folded in too, attributed to whoever
      // last edited the test, so it's never silently dropped -- same
      // "never destroy data" approach as combinedEvaluationEntries.
      const noteEntries = [];
      evalTargets.forEach(p => {
        const pd = getTrialProductData(mt, p.id);
        if(pd.evaluations && typeof pd.evaluations === 'object'){
          Object.entries(pd.evaluations).forEach(([email, ans]) => {
            const noteVal = ans?.[`${c.id}_note`];
            if(noteVal) noteEntries.push({ who: email, product: p.label, note: noteVal });
          });
        }
      });
      const legacyNote = sensoryCriteriaNotes[c.id];
      if(legacyNote && !noteEntries.some(e => e.note === legacyNote)){
        noteEntries.push({ who: t.updatedBy || 'Unspecified', product: null, note: legacyNote });
      }
      return `
      <tr>
        <td>${isEditing
          ? `<div style="display:flex;align-items:center;gap:6px;">
              <div style="display:flex;flex-direction:column;">
                <button type="button" class="icon-btn" data-role="move-trial-criteria-up" data-criteria-id="${escapeHtml(c.id)}" title="Move up" ${ci === 0 ? 'disabled' : ''}>${icon('chevron-up', 12)}</button>
                <button type="button" class="icon-btn" data-role="move-trial-criteria-down" data-criteria-id="${escapeHtml(c.id)}" title="Move down" ${ci === evaluationCriteria.length - 1 ? 'disabled' : ''}>${icon('chevron-down', 12)}</button>
              </div>
              <input type="text" class="trial-criteria-label-input" data-criteria-id="${escapeHtml(c.id)}" value="${escapeHtml(c.label)}" placeholder="Criteria name">
              <button type="button" class="icon-btn" data-role="remove-trial-criteria" data-criteria-id="${escapeHtml(c.id)}" title="Remove this criteria">${icon('x')}</button>
            </div>`
          : `<b>${escapeHtml(c.label)}</b>`}</td>
        ${evalTargets.map((p, i) => {
          const pd = getTrialProductData(mt, p.id);
          // Sensory Evaluation is filled in through the "Perform
          // Evaluation" wizard now (see renderEvaluationWizard), not
          // inline here -- this table always shows the combined view:
          // every evaluator's own JAR answer, listed together (see
          // combinedEvaluationEntries), not a single shared value anyone
          // could silently overwrite.
          const entries = combinedEvaluationEntries(pd, c.id, t.updatedBy);
          return `<td class="${i > 0 ? 'recipe-boundary' : ''}">${entries.length
            ? entries.map(e => `<div class="teval-overall-entry" title="${escapeHtml(jarScoreLabel(e.value))}">${escapeHtml(jarScoreDisplay(e.value))} <span class="teval-jar-meaning">${escapeHtml(jarScoreLabel(e.value))}</span></div>`).join('')
            : '<span class="overview-empty">-</span>'}</td>`;
        }).join('')}
        <td class="recipe-boundary">${noteEntries.length
          ? noteEntries.map(e => `<div class="teval-overall-entry">${e.product && evalTargets.length > 1 ? `<b>(${escapeHtml(e.product)}):</b> ` : ''}${escapeHtml(e.note)}</div>`).join('')
          : '<span class="overview-empty">-</span>'}</td>
      </tr>
    `;
    }).join('');
    // Picking a name already on file (see Reference Lists' Evaluation
    // Criteria tab) keeps wording consistent across tests instead of
    // everyone retyping their own "Appearance" vs "Appearance (Interior)"
    // -- same idea as Cooking Method's own reference-list quick-fill on
    // the Products page. A topic with Sub-items (e.g. "Taste" -> Sweetness/
    // Salty/Sour) lists each sub under its parent, formatted as "Taste
    // (Sweetness)" -- matching the exact naming convention criteria rows
    // already use -- rather than the bare parent name. Typing a brand-new
    // name in the field below still works exactly as before if it isn't on
    // the list yet.
    const criteriaPickOptionsHtml = [...metaLists.evaluationCriteria]
      .sort((a,b) => metaItemName(a).localeCompare(metaItemName(b), undefined, { sensitivity: 'base', numeric: true }))
      .map(item => {
        const name = metaItemName(item);
        const subs = item.subs || [];
        return subs.length
          ? `<optgroup label="${escapeHtml(name)}">${subs.map(s => `<option value="${escapeHtml(`${name} (${s})`)}">${escapeHtml(s)}</option>`).join('')}</optgroup>`
          : `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
      }).join('');
    const addCriteriaBtnHtml = isEditing ? `
      ${criteriaPickOptionsHtml ? `
      <div class="project-add-row" style="margin-top:8px;">
        <select class="trial-criteria-pick-select">
          <option value="">Pick a Criteria (Reference Lists)...</option>
          ${criteriaPickOptionsHtml}
        </select>
      </div>
      ` : ''}
      <div class="project-add-row" style="margin-top:8px;">
        <input type="text" class="trial-add-criteria-input" list="evaluationCriteriaDatalist" placeholder="Or type a new name...">
        <button type="button" class="btn btn-sm" data-role="add-trial-criteria">+ Add Criteria</button>
      </div>
    ` : '';
    // Test Result is a per-evaluator pick now, same as the Sensory
    // Evaluation criteria above -- filled in as the last step of each
    // product in the "Perform Evaluation" wizard. This table always
    // shows everyone's picks together (see combinedEvaluationEntries),
    // each line colored via the existing accepted/needs-revision/
    // not-accepted classes.
    const testResultRowHtml = `
      <tr>
        <td><b>Test Result</b></td>
        ${evalTargets.map((p, i) => {
          const pd = getTrialProductData(mt, p.id);
          const entries = combinedEvaluationEntries(pd, null, t.updatedBy);
          return `<td class="${i > 0 ? 'recipe-boundary' : ''}">${entries.length
            ? entries.map(e => `<div class="${TRIAL_TEST_RESULT_CLASSES[e.value] || ''}"><b>${escapeHtml(e.value)}</b></div>`).join('')
            // Print (see printing-only) still gets an empty tick list on a
            // product nobody has evaluated yet, so a paper printout has
            // all 3 options for someone outside the system to mark by
            // hand -- disabled (not readonly -- readonly has no effect on
            // radio inputs) since this isn't the editable copy.
            : `<div class="trial-testresult-radios">${TRIAL_TEST_RESULT_OPTIONS.map(o => `
                <label class="trial-testresult-radio-label">
                  <input type="radio" disabled>
                  ${o}
                </label>
              `).join('')}</div>`}</td>`;
        }).join('')}
        <td class="recipe-boundary"></td>
      </tr>
    `;
    // Comments + an optional reference photo are now one shared thing per
    // evaluator covering the whole test (see getMyEvaluatorComment/
    // evaluatorPhotos), not one of each per product -- doesn't fit as a
    // table row keyed by product any more, so it's a standalone block
    // below the table instead (one entry per evaluator who left either),
    // same idea as Test Result above just no longer per-product.
    const evaluatorCommentsHtml = (() => {
      const comments = (t.evaluatorComments && typeof t.evaluatorComments === 'object') ? t.evaluatorComments : {};
      const photosByEmail = (t.evaluatorPhotos && typeof t.evaluatorPhotos === 'object') ? t.evaluatorPhotos : {};
      const emails = [...new Set([...Object.keys(comments), ...Object.keys(photosByEmail)])]
        .filter(email => (comments[email] || '').trim() || (photosByEmail[email] || []).length);
      if(!emails.length) return '';
      return `
        <div class="teval-overall-comments">
          <div class="teval-overall-comments-title">Comments</div>
          ${emails.map(email => `
            <div class="teval-overall-entry">
              <b>${escapeHtml(shortEvaluatorName(email))}:</b> ${escapeHtml((comments[email] || '').trim() || '-')}
              ${(photosByEmail[email] || []).length ? `
                <div class="proj-ref-images-grid" style="margin-top:6px;">
                  ${(photosByEmail[email] || []).map(ph => `
                    <div class="proj-ref-image-item">
                      <div class="proj-ref-image-thumb-wrap">
                        <img src="${escapeHtml(ph.dataUrl)}" class="proj-ref-image-thumb" alt="Reference photo">
                      </div>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      `;
    })();
    // Improvement notes only make sense for a product at least one
    // evaluator flagged Needs Revision -- Accepted/Not accepted from
    // everyone is already a final call, nothing left to improve toward.
    // Locked (readonly, muted) otherwise, including not-yet-evaluated.
    const improvementCriteriaNotes = getCriteriaNotes(mt, 'criteriaImproveNotes');
    // A <textarea>'s own font-size doesn't reliably match a plain div's
    // during print in every browser (some print engines fall back toward
    // native form-control rendering for textareas regardless of CSS), even
    // with the exact same font-size rule applied to both -- this
    // plain-text mirror (real <br> line breaks, not a textarea) is what
    // actually prints, hidden on screen and swapped in for the textarea
    // only in print (see .teval-print-hide-scores/.print-only in
    // style.css), so this Note reads with pixel-identical formatting to
    // Sensory Evaluation's own Note (plain divs there too, never a
    // textarea).
    const printOnlyCriteriaNoteHtml = note => `<div class="teval-criteria-note-print print-only">${escapeHtml(note || '-').replace(/\n/g, '<br>')}</div>`;
    const improvementRowsHtml = evaluationCriteria.map(c => `
      <tr>
        <td><b>${escapeHtml(c.label)}</b></td>
        ${evalTargets.map((p, i) => {
          const pd = getTrialProductData(mt, p.id);
          const needsRevision = productNeedsRevision(pd);
          const stored = improvementFieldValue(pd, c.id);
          const auto = (stored || !needsRevision) ? '' : autoImprovementSuggestion(c, pd);
          const displayValue = stored || auto;
          const isAuto = !stored && !!auto;
          const autoTitle = 'Automatically suggested from this criteria\'s JAR score above — edit to write your own instead';
          return `<td class="${i > 0 ? 'recipe-boundary' : ''}${needsRevision ? '' : ' trial-improve-na'}"><textarea class="teval-improve${isAuto ? ' teval-improve-auto' : ''}" data-product-id="${escapeHtml(p.id)}" data-field="improve_${escapeHtml(c.id)}" ${(isEditing && needsRevision) ? '' : 'readonly'} placeholder="-" title="${needsRevision ? (isAuto ? autoTitle : '') : 'Only needed when Test Result is Needs Revision'}">${escapeHtml(displayValue)}</textarea></td>`;
        }).join('')}
        <td class="recipe-boundary">
          <div class="mu-field-with-translate" style="width:auto;">
            <textarea class="teval-criteria-note" data-bucket="criteriaImproveNotes" data-criteria-id="${escapeHtml(c.id)}" ${isEditing ? '' : 'readonly'} placeholder="-">${escapeHtml(improvementCriteriaNotes[c.id] || '')}</textarea>
            ${isEditing ? `<button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>` : ''}
          </div>
          ${printOnlyCriteriaNoteHtml(improvementCriteriaNotes[c.id])}
        </td>
      </tr>
    `).join('');
    // One decision per product -- separate from Test Result (which is a
    // per-evaluator sensory verdict) -- for whoever reviews the
    // Improvement Guidelines above to say whether this specific sample is
    // still worth carrying forward. Only "Continue" gets a product into
    // the Summary Test / Summary Table (see summarizeTrialProduct) --
    // "Discontinue" and not-yet-decided both stay out, so a page that's
    // meant to be a quick read doesn't keep showing samples nobody's
    // pursuing any more.
    const continueDevRowHtml = `
      <tr>
        <td><b>Continue Development?</b></td>
        ${evalTargets.map((p, i) => {
          const pd = getTrialProductData(mt, p.id);
          const val = pd.continueDevelopment || '';
          return `<td class="${i > 0 ? 'recipe-boundary' : ''}">
            <div class="trial-continue-dev-row">
              <button type="button" class="btn btn-sm trial-continue-dev-btn trial-continue-dev-yes${val === 'continue' ? ' selected' : ''}" data-role="continue-dev" data-product-id="${escapeHtml(p.id)}" data-value="continue" ${isEditing ? '' : 'disabled'}>${icon('check', 12)} Continue</button>
              <button type="button" class="btn btn-sm trial-continue-dev-btn trial-continue-dev-no${val === 'discontinue' ? ' selected' : ''}" data-role="continue-dev" data-product-id="${escapeHtml(p.id)}" data-value="discontinue" ${isEditing ? '' : 'disabled'}>${icon('x', 12)} Discontinue</button>
            </div>
          </td>`;
        }).join('')}
        <td class="recipe-boundary"></td>
      </tr>
    `;

    // 220px leading column mirrors the product-card spacer above so the two
    // grids share the same column ruler — rows are fixed now, so no
    // trailing comment/delete columns are needed any more.
    // +1 trailing col for the Note column both tables now share.
    const trialColgroup = `<colgroup><col style="width:220px;">${'<col>'.repeat(evalTargets.length)}<col style="width:180px;"></colgroup>`;

    return `
      <div class="part-block${isExpanded ? '' : ' collapsed'}" data-trial-id="${escapeHtml(t.id)}">
        <div class="part-header" style="margin-bottom:12px;">
          <button type="button" class="part-toggle-btn${isExpanded ? ' open' : ''}" title="Expand / collapse this test">${icon('chevron-right')}</button>
          ${linkedProjectImage ? `<img src="${escapeHtml(linkedProjectImage)}" class="material-thumb" alt="${escapeHtml(linkedProject.name || 'Linked project')}" title="From linked project: ${escapeHtml(linkedProject.name || 'Untitled project')}">` : ''}
          <div class="trial-row-title-block">
            <span class="trial-row-date">${mt.testDate ? 'Tested ' + escapeHtml(formatDateLong(mt.testDate)) : 'Untitled test'}${combinedCount ? ` · ${combinedCount} product${combinedCount === 1 ? '' : 's'}` : ''}</span>
            <div class="trial-row-products">${productNames.length ? productNames.map(n => `<div>${escapeHtml(n)}</div>`).join('') : 'No products added yet'}</div>
          </div>
          <div class="trial-row-actions">
            ${isEditing ? `<button class="btn btn-sm" data-role="save-trial">${icon('save')} Save</button>` : `<button class="btn btn-sm" data-role="edit-trial">${icon('pencil')} Edit</button>`}
            ${combinedCount > 0 ? `<button class="btn btn-sm" data-role="start-evaluation">${icon('clipboard-check')} Perform Evaluation</button>` : ''}
            ${combinedCount > 0 ? `<button class="btn btn-sm" data-role="open-trial-share">${icon('share-2')} Share External Evaluation${trialSharePendingCounts[t.id] ? `<span class="trial-share-pending-badge" title="${trialSharePendingCounts[t.id]} guest response${trialSharePendingCounts[t.id] === 1 ? '' : 's'} waiting for a decision">${trialSharePendingCounts[t.id]}</span>` : ''}</button>` : ''}
            ${combinedCount > 0 ? `<button class="btn btn-sm" data-role="open-trial-summary">${icon('file-text')} Summary Test</button>` : ''}
            ${isExpanded ? `<button class="btn btn-sm" data-role="print-trial">${icon('printer')} Print</button>` : ''}
            ${isExpanded ? `<button class="btn btn-sm btn-danger" data-role="delete-trial">${icon('x')} Delete</button>` : ''}
          </div>
        </div>
        <div class="part-body">
          <div class="trial-part-title">Part 1</div>
          <div class="trial-header-row">
            <div class="field" style="margin-bottom:0;">
              <label>Project Name</label>
              ${isEditing
                ? `<select class="proj-select trial-linked-project">
                    <option value="">- Select a project -</option>
                    ${[...projects].sort((a,b) => (a.name||'').localeCompare(b.name||'', undefined, {sensitivity:'base'})).map(p => `<option value="${escapeHtml(p.id)}" ${p.id === mt.linkedProjectId ? 'selected' : ''}>${escapeHtml(p.name || 'Untitled project')}</option>`).join('')}
                  </select>`
                : `<input type="text" value="${escapeHtml(linkedProject?.name || '')}" placeholder="-" readonly>`}
            </div>
            <div class="field" style="margin-bottom:0;">
              <label>Customer</label>
              <input type="text" value="${escapeHtml(linkedProject?.customerName || '')}" placeholder="-" readonly title="Comes from the linked project above">
            </div>
          </div>
          ${linkedProject ? (() => {
            const req = getRequirements(linkedProject);
            return `
          <div class="compare-info-col" style="margin-bottom:16px;">
            <div class="trial-project-summary-grid">
              <div class="ci-row"><b>Destination:</b> ${escapeHtml(linkedProject.destinationCountry || '-')}</div>
              <div class="ci-row"><b>Project Owner:</b> ${escapeHtml(linkedProject.ownerSalesRep || '-')}</div>
              <div class="ci-row"><b>Responsible Person (PD):</b> ${escapeHtml(linkedProject.responsiblePerson || '-')}</div>
              <div class="ci-row"><b>Factory:</b> ${escapeHtml(linkedProject.factoryName || '-')}</div>
            </div>
            ${(() => { const certText = certificateSummaryText(req.certificate); return (req.composition || req.recipe || req.cookingCondition.some(g => g.method || g.steps.length) || req.packagingCondition || certText) ? `
            <div class="trial-project-summary-reqs">
              <div class="trial-project-summary-reqs-title">Requirements</div>
              ${req.composition ? `<div><div class="material-detail-notes-label">Composition</div><div class="material-detail-notes">${escapeHtml(req.composition)}</div></div>` : ''}
              ${req.recipe ? `<div><div class="material-detail-notes-label">Recipe</div><div class="material-detail-notes">${escapeHtml(req.recipe)}</div></div>` : ''}
              ${req.cookingCondition.filter(g => g.method || g.steps.length).map(g => `
              <div>
                <div class="material-detail-notes-label">Cooking Guidelines${g.method ? ` — ${escapeHtml(g.method)}` : ''}</div>
                ${g.steps.length ? `<ol class="cooking-steps-list">${g.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
              </div>
              `).join('')}
              ${req.packagingCondition ? `<div><div class="material-detail-notes-label">Packaging condition</div><div class="material-detail-notes">${escapeHtml(req.packagingCondition)}</div></div>` : ''}
              ${certText ? `<div><div class="material-detail-notes-label">Certificate</div><div class="material-detail-notes">${escapeHtml(certText)}</div></div>` : ''}
            </div>
            ` : ''; })()}
          </div>
          `;
          })() : ''}
          <div class="trial-header-row">
            <div class="field" style="margin-bottom:0;">
              <label>Sample Prepared By</label>
              <input type="text" class="trial-sample-prepared-by" list="customerDatalist" value="${escapeHtml(mt.samplePreparedBy)}" placeholder="-" ${isEditing ? '' : 'readonly'}>
            </div>
            <div class="field" style="margin-bottom:0;">
              <label>Test Date</label>
              <input type="date" class="trial-test-date" value="${escapeHtml(mt.testDate)}" ${isEditing ? '' : 'readonly'}>
            </div>
            <div class="field" style="margin-bottom:0;">
              <label>Test Location</label>
              <input type="text" class="trial-test-location" list="customerDatalist" value="${escapeHtml(mt.testLocation)}" placeholder="-" ${isEditing ? '' : 'readonly'}>
            </div>
          </div>
          <div class="field" style="margin-bottom:0;margin-top:12px;">
            <label>Test Participants</label>
            <div class="trial-participants-list">${trialStringListHtml(mt.testParticipants, isEditing, 'trial-participant-input', 'test-participant', 'e.g. Yano-san', 'salesRepDatalist')}</div>
          </div>
          <div class="trial-part2-box">
            <div class="trial-part-title">Part 2</div>
            <div class="field">
              <label>Cooking Method</label>
              <input type="text" class="trial-cooking-method" list="cookingMethodDatalist" value="${escapeHtml(mt.cookingMethod)}" placeholder="e.g. Microwave" ${isEditing ? '' : 'readonly'}>
              <div style="margin-top:8px;">
                ${trialStringListHtml(mt.cookingMethodSteps, isEditing, 'trial-cooking-step-input', 'cooking-step', 'e.g. Deep Fry 170°C, 5 Mins.')}
              </div>
            </div>
            <div class="field">
              <label>Products Being Compared (up to ${TRIAL_MAX_PRODUCTS})</label>
              ${productCardsGrid}
              ${isEditing ? `
                <div class="project-add-row" style="margin-top:12px;">
                  <select class="trial-add-recipe-select" ${atMax ? 'disabled' : ''}>
                    <option value="">${atMax ? `Maximum ${TRIAL_MAX_PRODUCTS} products reached` : (availableRecipes.length ? 'Select a product to add...' : 'No more recipes available')}</option>
                    ${availableRecipes.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(recipeDisplayLabel(r))}</option>`).join('')}
                  </select>
                  <button class="btn btn-sm" data-role="add-trial-recipe" ${atMax ? 'disabled' : ''}>+ Add</button>
                </div>
                <div class="project-add-row" style="margin-top:8px;">
                  <input type="text" class="trial-add-manual-input" placeholder="Or type a product name manually (e.g. a competitor sample)..." maxlength="120" ${atMax ? 'disabled' : ''}>
                  <button class="btn btn-sm" data-role="add-trial-manual" ${atMax ? 'disabled' : ''}>+ Add</button>
                </div>
              ` : ''}
            </div>
            ${activity.length ? `<div class="reflist-item-meta" style="margin:10px 0;">${activity.join(' &nbsp;|&nbsp; ')}</div>` : ''}

            <div class="field">
              <label>Sensory Evaluation</label>
              ${evalTargets.length ? `
              <div style="overflow-x:auto;">
                <table class="compare-table teval-print-hide-scores">
                  ${trialColgroup}
                  <thead><tr><th>Criteria</th>${evalHeaderCells}<th class="recipe-boundary">Note</th></tr></thead>
                  <tbody>${fixedCriteriaRowsHtml}${testResultRowHtml}</tbody>
                </table>
              </div>
              ${evaluatorCommentsHtml}
              ${addCriteriaBtnHtml}
              ` : '<div class="overview-empty">Add a product above first</div>'}
            </div>

            <div class="field">
              <label>Improvement Guidelines</label>
              ${evalTargets.length ? `
              <div style="overflow-x:auto;">
                <table class="compare-table teval-print-hide-scores">
                  ${trialColgroup}
                  <thead><tr><th>Criteria</th>${improvementHeaderCells}<th class="recipe-boundary">Note<span class="teval-header-hint">Enter your own info (ระบุข้อมูลด้วยตัวเอง)</span></th></tr></thead>
                  <tbody>${improvementRowsHtml}${continueDevRowHtml}</tbody>
                </table>
              </div>
              ` : '<div class="overview-empty">Add a product above first</div>'}
            </div>

            <div class="field" style="margin-bottom:0;">
              <label>Note</label>
              <div class="mu-field-with-translate" style="width:auto;">
                <textarea class="trial-part2-note" ${isEditing ? '' : 'readonly'} placeholder="Anything else worth noting">${escapeHtml(mt.note)}</textarea>
                ${isEditing ? `<button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>` : ''}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    }).join('');
    return groupProject ? `<div class="trial-project-group-header">${icon('folder', 14)} ${escapeHtml(groupProject.name || 'Untitled project')}</div>${cardsHtml}` : cardsHtml;
  }).join('');

  container.querySelectorAll('.part-block[data-trial-id]').forEach(block => {
    const id = block.dataset.trialId;
    const t = trials.find(x => x.id === id);
    if(!t) return;
    const isEditing = id === trialEditingId;

    block.querySelector('.part-toggle-btn').addEventListener('click', () => {
      if(trialExpandedIds.has(id)) trialExpandedIds.delete(id);
      else trialExpandedIds.add(id);
      renderTrialsList();
    });

    if(isEditing){
      block.querySelector('[data-role="save-trial"]')?.addEventListener('click', () => {
        trialEditingId = null;
        logActivityEvent('updated', 'trial', trialLabel(t), diffMainFields(trialEditSnapshotBefore, { label: trialLabel(t) }, TRIAL_DIFF_FIELDS));
        trialEditSnapshotBefore = null;
        renderTrialsList();
      });
    }else{
      block.querySelector('[data-role="edit-trial"]')?.addEventListener('click', () => {
        trialEditingId = id;
        trialExpandedIds.add(id);
        trialEditSnapshotBefore = { label: trialLabel(t) };
        renderTrialsList();
      });
    }

    block.querySelector('[data-role="start-evaluation"]')?.addEventListener('click', () => {
      if(!currentUser?.email) return;
      const productIds = trialEvalTargets(t).map(p => p.id);
      if(!productIds.length) return;
      trialExpandedIds.add(id);
      openEvalWizard(id, productIds);
      renderTrialsList();
    });

    block.querySelector('[data-role="open-trial-summary"]')?.addEventListener('click', () => {
      openTrialSummaryModal(id);
      renderTrialsList();
    });

    block.querySelector('[data-role="open-trial-share"]')?.addEventListener('click', async () => {
      await openTrialShareModal(id);
    });

    block.querySelector('[data-role="print-trial"]')?.addEventListener('click', () => {
      block.classList.add('printing-only');
      const cleanup = () => {
        block.classList.remove('printing-only');
        window.removeEventListener('afterprint', cleanup);
      };
      window.addEventListener('afterprint', cleanup);
      window.print();
    });

    block.querySelector('[data-role="delete-trial"]')?.addEventListener('click', () => {
      if(!confirm('Delete this test result? This cannot be undone.')) return;
      requestAuthConfirm(
        'Confirm Identity to Delete',
        'Enter your password to delete this test result.',
        () => {
          const deletedLabel = trialLabel(t);
          trials = trials.filter(x => x.id !== t.id);
          moveToTrash('trials', t.id, t, deletedLabel);
          deleteTrialFromCloud(t.id);
          logActivityEvent('deleted', 'trial', deletedLabel);
          renderTrialsList();
        }
      );
    });

    const combinedCountNow = () => (t.recipeIds || []).length + (t.manualProducts || []).length;

    block.querySelectorAll('[data-role="remove-trial-recipe"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const recipeId = btn.dataset.recipeId;
        t.recipeIds = (t.recipeIds || []).filter(x => x !== recipeId);
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });

    const addRecipeSelect = block.querySelector('.trial-add-recipe-select');
    block.querySelector('[data-role="add-trial-recipe"]')?.addEventListener('click', () => {
      const recipeId = addRecipeSelect.value;
      if(!recipeId || combinedCountNow() >= TRIAL_MAX_PRODUCTS) return;
      if(!Array.isArray(t.recipeIds)) t.recipeIds = [];
      t.recipeIds.push(recipeId);
      scheduleTrialSave(t);
      renderTrialsList();
    });

    block.querySelectorAll('[data-role="duplicate-trial-manual"]').forEach(btn => {
      btn.addEventListener('click', () => {
        if(combinedCountNow() >= TRIAL_MAX_PRODUCTS) return;
        const manualId = btn.dataset.manualId;
        const source = (t.manualProducts || []).find(x => x.id === manualId);
        if(!source) return;
        const copy = { ...source, id: uid() };
        if(!Array.isArray(t.manualProducts)) t.manualProducts = [];
        t.manualProducts.push(copy);
        // Photos live in t.productData keyed by product id -- deep-copy them
        // under the new id (with fresh photo ids too) so editing/removing a
        // photo on one copy never touches the other's.
        const sourcePhotos = normalizeTrialPhotos(getTrialProductData(t, manualId));
        if(sourcePhotos.length){
          getTrialProductData(t, copy.id).photos = sourcePhotos.map(p => ({ ...p, id: uid() }));
        }
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });
    block.querySelectorAll('[data-role="remove-trial-manual"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const manualId = btn.dataset.manualId;
        t.manualProducts = (t.manualProducts || []).filter(x => x.id !== manualId);
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });

    const addManualInput = block.querySelector('.trial-add-manual-input');
    const addManualEntry = () => {
      const name = (addManualInput?.value || '').trim();
      if(!name || combinedCountNow() >= TRIAL_MAX_PRODUCTS) return;
      if(!Array.isArray(t.manualProducts)) t.manualProducts = [];
      t.manualProducts.push(blankManualTrialProduct(name));
      scheduleTrialSave(t);
      renderTrialsList();
    };
    block.querySelector('[data-role="add-trial-manual"]')?.addEventListener('click', addManualEntry);
    addManualInput?.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); addManualEntry(); }
    });

    block.querySelectorAll('[data-manual-id]').forEach(card => {
      const manualId = card.dataset.manualId;
      const mp = (t.manualProducts || []).find(x => x.id === manualId);
      if(!mp) return;
      card.querySelectorAll('.tmanual-field').forEach(input => {
        input.addEventListener('change', e => {
          mp[e.target.dataset.field] = e.target.value.trim();
          scheduleTrialSave(t);
        });
      });
    });

    if(isEditing){
      block.querySelector('.trial-linked-project')?.addEventListener('change', e => {
        t.linkedProjectId = e.target.value;
        scheduleTrialSave(t);
        renderTrialsList(); // Customer field derives from the newly-picked project
      });
      block.querySelector('.trial-sample-prepared-by')?.addEventListener('change', e => { t.samplePreparedBy = e.target.value.trim(); scheduleTrialSave(t); });
      block.querySelector('.trial-test-date')?.addEventListener('change', e => { t.testDate = e.target.value; scheduleTrialSave(t); });
      block.querySelector('.trial-test-location')?.addEventListener('change', e => { t.testLocation = e.target.value.trim(); scheduleTrialSave(t); });

      // Picking a Cooking Method that has Steps on file (see Reference
      // Lists) pulls them in as a starting point — same autofill as
      // Projects' own Cooking Condition field — still a plain editable
      // step list afterward, not locked to whatever the reference list
      // says (see the add/remove/edit wiring below).
      block.querySelector('.trial-cooking-method')?.addEventListener('change', e => {
        t.cookingMethod = e.target.value.trim();
        const match = metaLists.cookingMethods.find(m => metaItemName(m) === t.cookingMethod);
        if(match && (match.steps || []).length){
          t.cookingMethodSteps = [...match.steps];
        }
        scheduleTrialSave(t);
        renderTrialsList();
      });
      block.querySelector('.trial-part2-note')?.addEventListener('change', e => {
        t.note = e.target.value.trim();
        scheduleTrialSave(t);
      });

      // Test Participants and Cooking Method are both a plain numbered list
      // of strings — same add/remove/edit wiring, just different field
      // names and data-roles (see trialStringListHtml).
      [
        { field: 'testParticipants', inputClass: 'trial-participant-input', role: 'test-participant' },
        { field: 'cookingMethodSteps', inputClass: 'trial-cooking-step-input', role: 'cooking-step' }
      ].forEach(({ field, inputClass, role }) => {
        block.querySelector(`[data-role="add-${role}"]`)?.addEventListener('click', () => {
          if(!Array.isArray(t[field])) t[field] = [];
          t[field].push('');
          scheduleTrialSave(t);
          renderTrialsList();
        });
        block.querySelectorAll(`[data-role="remove-${role}"]`).forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx, 10);
            if(!Array.isArray(t[field])) return;
            t[field].splice(idx, 1);
            scheduleTrialSave(t);
            renderTrialsList();
          });
        });
        block.querySelectorAll(`.${inputClass}`).forEach((input, idx) => {
          input.addEventListener('change', () => {
            if(!Array.isArray(t[field])) t[field] = [];
            t[field][idx] = input.value.trim();
            scheduleTrialSave(t);
          });
        });
      });
    }

    block.querySelectorAll('.trial-product-photo-input').forEach(input => {
      input.addEventListener('change', async e => {
        const file = e.target.files[0];
        e.target.value = '';
        if(!file) return;
        const pd = getTrialProductData(t, input.dataset.productId);
        const photos = normalizeTrialPhotos(pd);
        if(photos.length >= TRIAL_PHOTO_MAX) return;
        photos.push({ id: uid(), dataUrl: await resizeImageFile(file, 500), caption: file.name });
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });
    block.querySelectorAll('[data-role="remove-trial-photo"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const pd = getTrialProductData(t, btn.dataset.productId);
        const photos = normalizeTrialPhotos(pd);
        const idx = photos.findIndex(p => p.id === btn.dataset.photoId);
        if(idx !== -1) photos.splice(idx, 1);
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });
    block.querySelectorAll('.trial-photo-caption-input').forEach(input => {
      input.addEventListener('change', () => {
        const pd = getTrialProductData(t, input.dataset.productId);
        const photos = normalizeTrialPhotos(pd);
        const photo = photos.find(p => p.id === input.dataset.photoId);
        if(photo) photo.caption = input.value.trim();
        scheduleTrialSave(t);
      });
    });

    block.querySelectorAll('.teval-improve').forEach(el => {
      el.addEventListener('change', () => {
        const pd = getTrialProductData(t, el.dataset.productId);
        pd[el.dataset.field] = el.value.trim();
        scheduleTrialSave(t);
      });
    });
    block.querySelectorAll('.teval-criteria-note').forEach(el => {
      el.addEventListener('change', () => {
        const notes = getCriteriaNotes(t, el.dataset.bucket);
        notes[el.dataset.criteriaId] = el.value.trim();
        scheduleTrialSave(t);
      });
    });
    block.querySelectorAll('.mu-field-with-translate').forEach(wireTrialTranslateButton);
    block.querySelectorAll('[data-role="continue-dev"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const pd = getTrialProductData(t, btn.dataset.productId);
        pd.continueDevelopment = pd.continueDevelopment === btn.dataset.value ? '' : btn.dataset.value;
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });
    block.querySelectorAll('.trial-criteria-label-input').forEach(input => {
      input.addEventListener('change', () => {
        const criteria = getEvaluationCriteria(t);
        const c = criteria.find(x => x.id === input.dataset.criteriaId);
        if(c) c.label = input.value.trim();
        scheduleTrialSave(t);
        renderTrialsList(); // Improvement Guidelines' read-only label mirrors this right away
      });
    });
    block.querySelectorAll('[data-role="remove-trial-criteria"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const criteria = getEvaluationCriteria(t);
        t.evaluationCriteria = criteria.filter(x => x.id !== btn.dataset.criteriaId);
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });
    // Sensory Evaluation and Improvement Guidelines both read the same
    // ordered list (see getEvaluationCriteria), so reordering a row here
    // reorders both tables' rows at once.
    const moveTrialCriteria = (criteriaId, delta) => {
      const criteria = getEvaluationCriteria(t);
      const idx = criteria.findIndex(x => x.id === criteriaId);
      const target = idx + delta;
      if(idx === -1 || target < 0 || target >= criteria.length) return;
      [criteria[idx], criteria[target]] = [criteria[target], criteria[idx]];
      scheduleTrialSave(t);
      renderTrialsList();
    };
    block.querySelectorAll('[data-role="move-trial-criteria-up"]').forEach(btn => {
      btn.addEventListener('click', () => moveTrialCriteria(btn.dataset.criteriaId, -1));
    });
    block.querySelectorAll('[data-role="move-trial-criteria-down"]').forEach(btn => {
      btn.addEventListener('click', () => moveTrialCriteria(btn.dataset.criteriaId, 1));
    });
    const addCriteriaInput = block.querySelector('.trial-add-criteria-input');
    const addCriteriaEntry = explicitLabel => {
      const label = explicitLabel !== undefined ? explicitLabel : (addCriteriaInput?.value || '').trim();
      getEvaluationCriteria(t).push({ id: uid(), label });
      scheduleTrialSave(t);
      renderTrialsList();
    };
    block.querySelector('[data-role="add-trial-criteria"]')?.addEventListener('click', () => addCriteriaEntry());
    addCriteriaInput?.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); addCriteriaEntry(); }
    });
    // Picking an option adds it immediately (no separate "+ Add" click) --
    // same instant-apply feel as a native <select>, then resets back to the
    // placeholder so it's ready to pick another one right after.
    block.querySelector('.trial-criteria-pick-select')?.addEventListener('change', e => {
      if(!e.target.value) return;
      addCriteriaEntry(e.target.value);
      e.target.value = '';
    });
    // Sensory Evaluation/Test Result are filled in through the "Perform
    // Evaluation" wizard now (see renderEvaluationWizard/wireEvaluationWizard),
    // a separate body-appended overlay rather than inline cells here.
  });

  renderEvaluationWizard();
  renderTrialSummaryModal();
  renderTrialShareModal();
  renderShareResponsePreviewModal();
}

function attachTrialsListener(){
  unsubscribeTrials = onSnapshot(trialsCol, snapshot => {
    trials = snapshot.docs.map(d => d.data());
    trials.forEach(t => {
      if(!Array.isArray(t.photos)) t.photos = [];
      if(!Array.isArray(t.evaluation)) t.evaluation = [];
    });
    trialsLoaded = true;
    migrateTrialsFromRecipes();
    if(mainFeatureView === 'trials') renderTrialsList();
  }, err => {
    console.error('Forge: trials listener error', err);
    showCloudError('Failed to load test results from Firebase: ' + err.message);
  });
}

// Tears down the trials Firestore listener and resets all Trials state to
// empty — called from the shared sign-out handler in app.js, kept here so
// that handler doesn't need write access to bindings this module owns.
export function resetTrialsState(){
  if(unsubscribeTrials){ unsubscribeTrials(); unsubscribeTrials = null; }
  trialsLoaded = false;
  trialsMigrated = false;
  trials = [];
}

export { trials, trialExpandedIds, unsubscribeTrials, attachTrialsListener };
