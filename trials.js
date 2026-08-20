import {
  recipes, recipeDisplayLabel, uid, currentUser, escapeHtml, icon, logActivityEvent,
  playContentTransition, projects, findProjectForRecipe, fullCode, formatWeight,
  allIngredientsInRecipe, formatActivityDateTime, PROJECT_STAGES, mainFeatureView,
  recipesLoaded, diffMainFields, requestAuthConfirm, resizeImageFile, formatDateLong,
  trialStringListHtml, trialsCol, showCloudError,
  metaLists, metaItemName, getRequirements
} from './app.js';
import {
  onSnapshot, setDoc, doc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let trials = [];
let trialExpandedIds = new Set();
let trialEditingId = null;
let unsubscribeTrials = null;
let trialsLoaded = false;
let trialsMigrated = false;
const TRIAL_DIFF_FIELDS = { label: 'Recipes / Products Compared' };
let trialEditSnapshotBefore = null;

const TRIAL_MAX_PRODUCTS = 4;

// A trial has no name of its own — it's a comparison of recipes — so its
// label is just whichever recipes it's comparing, joined together.
function trialLabel(t){
  return (t.recipeIds || []).map(id => recipes.find(r => r.id === id)).filter(Boolean).map(recipeDisplayLabel).join(', ') || 'Untitled test';
}

function blankTrial(){
  return {
    id: uid(),
    recipeIds: [],
    manualProducts: [],
    linkedProjectId: '',
    samplePreparedBy: '',
    testParticipants: [],
    testDate: '',
    cookingMethod: '',
    cookingMethodSteps: [],
    productData: {},
    createdBy: currentUser?.email || '',
    createdAt: Date.now(),
    updatedBy: currentUser?.email || '',
    updatedAt: Date.now()
  };
}
// Old trials only had photos (up to 3, shared across the whole trial) and
// evaluation (freeform criteria rows) — replaced by a fixed test-report
// format (see TRIAL_FIXED_CRITERIA/TRIAL_IMPROVEMENT_CRITERIA) with photos
// and scores per product instead. The old fields are left on the document
// untouched (unused, harmless) rather than migrated/stripped, same
// never-destroy-data approach as migrateTrialsFromRecipes above.
function migrateTrial(t){
  return {
    ...t,
    linkedProjectId: t.linkedProjectId || '',
    samplePreparedBy: t.samplePreparedBy || '',
    testParticipants: Array.isArray(t.testParticipants) ? t.testParticipants : [],
    testDate: t.testDate || '',
    cookingMethod: t.cookingMethod || '',
    cookingMethodSteps: Array.isArray(t.cookingMethodSteps) ? t.cookingMethodSteps : [],
    productData: (t.productData && typeof t.productData === 'object') ? t.productData : {}
  };
}
// Lazily creates the per-product data bucket (photos + fixed scores) keyed
// by product id — works for both a linked recipe's id and a manual
// product's own id, same keying convention the old evaluation.scores map
// already used. Mutates `t` in place so the caller doesn't have to.
function getTrialProductData(t, productId){
  if(!t.productData || typeof t.productData !== 'object') t.productData = {};
  if(!t.productData[productId]) t.productData[productId] = {};
  return t.productData[productId];
}
// A product's photos: one free-form gallery (up to TRIAL_PHOTO_MAX), each
// with an editable caption (defaults to the uploaded file's own name) --
// no fixed "Before/After frying" categories, the caption itself says
// whatever the photo needs it to. Older trials kept a single plain
// data-URL string in a separate beforePhoto/afterPhoto field each; both
// get folded into the one photos array in place the first time it's
// touched, same lazy-migration approach as getTrialProductData itself
// just above. Never drops data even if both legacy slots had something.
const TRIAL_PHOTO_MAX = 4;
function normalizeTrialPhotos(pd){
  if(!Array.isArray(pd.photos)){
    const merged = [];
    for(const legacyField of ['beforePhoto', 'afterPhoto']){
      const legacy = pd[legacyField];
      if(Array.isArray(legacy)) merged.push(...legacy);
      else if(legacy) merged.push({ id: uid(), dataUrl: legacy, caption: '' });
    }
    pd.photos = merged;
  }
  return pd.photos;
}
const TRIAL_FIXED_CRITERIA = [
  { key: 'appearanceExterior', label: 'Appearance (Exterior)' },
  { key: 'appearanceInterior', label: 'Appearance (Interior)' },
  { key: 'odor', label: 'Odor' },
  { key: 'taste', label: 'Taste' },
  { key: 'texture', label: 'Texture' }
];
const TRIAL_IMPROVEMENT_CRITERIA = [
  { key: 'improveAppearanceInterior', label: 'Appearance (Interior)' },
  { key: 'improveOdor', label: 'Odor' },
  { key: 'improveTexture', label: 'Texture' }
];
const TRIAL_TEST_RESULT_OPTIONS = ['Accepted', 'Not accepted'];

// A product being compared that isn't one of this app's own Recipes — a
// competitor sample, a customer's existing product, anything typed in by
// name rather than picked from the list. Same detail fields as a linked
// Recipe's card (see the compare-info-col markup below) but hand-typed
// instead of pulled from the recipe/project record.
function blankManualTrialProduct(name){
  return { id: uid(), name: (name || '').trim(), code: '', date: '', totalWeight: '', customer: '', destination: '', owner: '', stage: '' };
}

function saveTrialToCloud(t){
  return setDoc(doc(trialsCol, t.id), t);
}
function deleteTrialFromCloud(id){
  return deleteDoc(doc(trialsCol, id));
}
function scheduleTrialSave(t){
  t.updatedAt = Date.now();
  t.updatedBy = currentUser?.email || '';
  saveTrialToCloud(t);
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
      <button class="btn btn-primary btn-sm" id="btnAddTrial" style="margin-bottom:16px;">+ New Test</button>
      <div id="trialsList"></div>
    </div>
  `;

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
  playContentTransition(main);
}

export function renderTrialsList(){
  const container = document.getElementById('trialsList');
  if(!container) return;
  if(trials.length === 0){
    container.innerHTML = '<div class="overview-empty">No test results yet — click "+ New Test" above to start one</div>';
    return;
  }
  const sorted = [...trials].sort((a,b) => b.updatedAt - a.updatedAt);
  container.innerHTML = sorted.map(t => {
    const isEditing = t.id === trialEditingId;
    const isExpanded = isEditing || trialExpandedIds.has(t.id);
    // Migrated view used only for building this HTML string below — the
    // wiring block further down re-fetches the raw trial from `trials` and
    // guards each field defensively instead, same split used for Projects'
    // monthlyUpdates (see migrateMonthlyUpdate).
    const mt = migrateTrial(t);
    const linkedProject = mt.linkedProjectId ? projects.find(p => p.id === mt.linkedProjectId) : null;
    const linkedRecipes = (t.recipeIds || []).map(id => recipes.find(r => r.id === id)).filter(Boolean);
    const manualProducts = t.manualProducts || [];
    const combinedCount = (t.recipeIds || []).length + manualProducts.length;
    const productLabel = linkedProject?.name || (combinedCount
      ? [...linkedRecipes.map(r => recipeDisplayLabel(r)), ...manualProducts.map(mp => mp.name || 'Untitled')].join(', ')
      : 'Untitled test');
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
          <div class="ci-row"><b>Date:</b> ${escapeHtml(r.date || '-')}</div>
          <div class="ci-row"><b>Total weight:</b> ${escapeHtml(formatWeight(totalWt))}</div>
          ${link?.project.customerName ? `<div class="ci-row"><b>Customer:</b> ${escapeHtml(link.project.customerName)}</div>` : ''}
          ${link?.project.destinationCountry ? `<div class="ci-row"><b>Destination:</b> ${escapeHtml(link.project.destinationCountry)}</div>` : ''}
          ${link?.project.ownerSalesRep ? `<div class="ci-row"><b>Project Owner:</b> ${escapeHtml(link.project.ownerSalesRep)}</div>` : ''}
          ${link ? `<div class="ci-row"><b>Stage:</b> ${escapeHtml(link.product.stage || '-')}</div>` : ''}
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
    // getTrialProductData). Fixed rows (see TRIAL_FIXED_CRITERIA) replace
    // the old freeform criteria list — the report format this now follows
    // always asks the same handful of questions.
    const evalTargets = [
      ...linkedRecipes.map(r => ({ id: r.id, label: fullCode(r) || recipeDisplayLabel(r) })),
      ...manualProducts.map(mp => ({ id: mp.id, label: mp.name || 'Untitled' }))
    ];
    const evalHeaderCells = evalTargets.map((p, i) => `<th class="${i > 0 ? 'recipe-boundary' : ''}">${escapeHtml(p.label)}</th>`).join('');
    const fixedCriteriaRowsHtml = TRIAL_FIXED_CRITERIA.map(c => `
      <tr>
        <td><b>${escapeHtml(c.label)}</b></td>
        ${evalTargets.map((p, i) => {
          const pd = getTrialProductData(mt, p.id);
          return `<td class="${i > 0 ? 'recipe-boundary' : ''}"><textarea class="teval-fixed" data-product-id="${escapeHtml(p.id)}" data-field="${c.key}" ${isEditing ? '' : 'readonly'} placeholder="-">${escapeHtml(pd[c.key] || '')}</textarea></td>`;
        }).join('')}
      </tr>
    `).join('');
    // Test Result is a dropdown (not free text) so Accepted/Not accepted
    // can be colored — matches the sample report's red "Not accepted" text.
    const testResultRowHtml = `
      <tr>
        <td><b>Test Result</b></td>
        ${evalTargets.map((p, i) => {
          const pd = getTrialProductData(mt, p.id);
          const val = pd.testResult || '';
          const resultClass = val === 'Accepted' ? 'trial-result-accepted' : (val === 'Not accepted' ? 'trial-result-not-accepted' : '');
          return `<td class="${i > 0 ? 'recipe-boundary' : ''} ${resultClass}">${isEditing
            ? `<select class="proj-select teval-testresult" data-product-id="${escapeHtml(p.id)}"><option value="">-</option>${TRIAL_TEST_RESULT_OPTIONS.map(o => `<option value="${o}" ${val === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
            : `<b>${escapeHtml(val || '-')}</b>`}</td>`;
        }).join('')}
      </tr>
    `;
    const improvementRowsHtml = TRIAL_IMPROVEMENT_CRITERIA.map(c => `
      <tr>
        <td><b>${escapeHtml(c.label)}</b></td>
        ${evalTargets.map((p, i) => {
          const pd = getTrialProductData(mt, p.id);
          return `<td class="${i > 0 ? 'recipe-boundary' : ''}"><textarea class="teval-improve" data-product-id="${escapeHtml(p.id)}" data-field="${c.key}" ${isEditing ? '' : 'readonly'} placeholder="-">${escapeHtml(pd[c.key] || '')}</textarea></td>`;
        }).join('')}
      </tr>
    `).join('');

    // 220px leading column mirrors the product-card spacer above so the two
    // grids share the same column ruler — rows are fixed now, so no
    // trailing comment/delete columns are needed any more.
    const trialColgroup = `<colgroup><col style="width:220px;">${'<col>'.repeat(evalTargets.length)}</colgroup>`;

    return `
      <div class="part-block${isExpanded ? '' : ' collapsed'}" data-trial-id="${escapeHtml(t.id)}">
        <div class="part-header" style="margin-bottom:12px;">
          <button type="button" class="part-toggle-btn${isExpanded ? ' open' : ''}" title="Expand / collapse this test">${icon('chevron-right')}</button>
          <span style="font-weight:700;font-size:14px;color:var(--primary-dark);">${escapeHtml(productLabel)}</span>
          <span class="part-header-summary">${combinedCount} product${combinedCount === 1 ? '' : 's'}${mt.testDate ? ' · Tested ' + escapeHtml(formatDateLong(mt.testDate)) : ''}</span>
          ${isEditing ? `<button class="btn btn-sm" data-role="save-trial">${icon('save')} Save</button>` : `<button class="btn btn-sm" data-role="edit-trial">${icon('pencil')} Edit</button>`}
          <button class="btn btn-sm" data-role="print-trial">${icon('printer')} Print</button>
          <button class="btn btn-sm btn-danger" data-role="delete-trial">${icon('x')} Delete</button>
        </div>
        <div class="part-body">
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
            ${(req.composition || req.recipe || req.cookingCondition.method || req.cookingCondition.steps.length || req.packagingCondition) ? `
            <div class="trial-project-summary-reqs">
              <div class="trial-project-summary-reqs-title">Requirements</div>
              ${req.composition ? `<div><div class="material-detail-notes-label">Composition</div><div class="material-detail-notes">${escapeHtml(req.composition)}</div></div>` : ''}
              ${req.recipe ? `<div><div class="material-detail-notes-label">Recipe</div><div class="material-detail-notes">${escapeHtml(req.recipe)}</div></div>` : ''}
              ${(req.cookingCondition.method || req.cookingCondition.steps.length) ? `
              <div>
                <div class="material-detail-notes-label">Cooking Guidelines${req.cookingCondition.method ? ` — ${escapeHtml(req.cookingCondition.method)}` : ''}</div>
                ${req.cookingCondition.steps.length ? `<ol class="cooking-steps-list">${req.cookingCondition.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
              </div>
              ` : ''}
              ${req.packagingCondition ? `<div><div class="material-detail-notes-label">Packaging condition</div><div class="material-detail-notes">${escapeHtml(req.packagingCondition)}</div></div>` : ''}
            </div>
            ` : ''}
          </div>
          `;
          })() : ''}
          <div class="trial-header-row">
            <div class="field" style="margin-bottom:0;">
              <label>Sample Prepared By</label>
              <input type="text" class="trial-sample-prepared-by" list="salesRepDatalist" value="${escapeHtml(mt.samplePreparedBy)}" placeholder="-" ${isEditing ? '' : 'readonly'}>
            </div>
            <div class="field" style="margin-bottom:0;">
              <label>Test Date</label>
              <input type="date" class="trial-test-date" value="${escapeHtml(mt.testDate)}" ${isEditing ? '' : 'readonly'}>
            </div>
          </div>
          <div class="field" style="margin-bottom:0;margin-top:12px;">
            <label>Test Participants</label>
            ${trialStringListHtml(mt.testParticipants, isEditing, 'trial-participant-input', 'test-participant', 'e.g. Yano-san', 'salesRepDatalist')}
          </div>
          <div class="field" style="margin-top:12px;">
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
              <table class="compare-table">
                ${trialColgroup}
                <thead><tr><th>Criteria</th>${evalHeaderCells}</tr></thead>
                <tbody>${fixedCriteriaRowsHtml}${testResultRowHtml}</tbody>
              </table>
            </div>
            ` : '<div class="overview-empty">Add a product above first</div>'}
          </div>

          <div class="field">
            <label>Improvement Guidelines</label>
            ${evalTargets.length ? `
            <div style="overflow-x:auto;">
              <table class="compare-table">
                ${trialColgroup}
                <thead><tr><th>Criteria</th>${evalHeaderCells}</tr></thead>
                <tbody>${improvementRowsHtml}</tbody>
              </table>
            </div>
            ` : '<div class="overview-empty">Add a product above first</div>'}
          </div>
        </div>
      </div>
    `;
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
      block.querySelector('[data-role="save-trial"]').addEventListener('click', () => {
        trialEditingId = null;
        logActivityEvent('updated', 'trial', trialLabel(t), diffMainFields(trialEditSnapshotBefore, { label: trialLabel(t) }, TRIAL_DIFF_FIELDS));
        trialEditSnapshotBefore = null;
        renderTrialsList();
      });
    }else{
      block.querySelector('[data-role="edit-trial"]').addEventListener('click', () => {
        trialEditingId = id;
        trialExpandedIds.add(id);
        trialEditSnapshotBefore = { label: trialLabel(t) };
        renderTrialsList();
      });
    }

    block.querySelector('[data-role="print-trial"]').addEventListener('click', () => {
      block.classList.add('printing-only');
      const cleanup = () => {
        block.classList.remove('printing-only');
        window.removeEventListener('afterprint', cleanup);
      };
      window.addEventListener('afterprint', cleanup);
      window.print();
    });

    block.querySelector('[data-role="delete-trial"]').addEventListener('click', () => {
      if(!confirm('Delete this test result? This cannot be undone.')) return;
      requestAuthConfirm(
        'Confirm Identity to Delete',
        'Enter your password to delete this test result.',
        () => {
          const deletedLabel = trialLabel(t);
          trials = trials.filter(x => x.id !== t.id);
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

    block.querySelectorAll('.teval-fixed, .teval-improve').forEach(el => {
      el.addEventListener('change', () => {
        const pd = getTrialProductData(t, el.dataset.productId);
        pd[el.dataset.field] = el.value.trim();
        scheduleTrialSave(t);
      });
    });
    block.querySelectorAll('.teval-testresult').forEach(el => {
      el.addEventListener('change', () => {
        const pd = getTrialProductData(t, el.dataset.productId);
        pd.testResult = el.value;
        scheduleTrialSave(t);
        renderTrialsList(); // re-render so the accepted/not-accepted color applies right away
      });
    });
  });
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
