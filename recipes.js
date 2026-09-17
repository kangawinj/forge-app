// Recipes -- core module. Owns the recipes array, the Firestore listener,
// and the whole recipe editor (renderRecipeEditor / the Parts tree /
// Process steps & Flowchart / Recipe Overview). Split out (it had grown
// past 5,200 lines) into:
//   - recipes-data.js     -- pure data/model/geometry helpers, no DOM
//   - recipes-versions.js -- Version History modal + preview
//   - recipes-list.js     -- the grid/sidebar list views
//   - recipes-print.js    -- Print view + free-text Description
//   - recipes-excel.js    -- Export Excel
// renderRecipeEditor and the Parts/Process/Overview/Flowchart renderers
// below are deliberately left as one large, unsplit block (same reasoning
// as trials.js's renderTrialsList) -- they call each other back and forth
// on almost every edit, so splitting them apart would mean real
// circular-dependency risk between sibling files, not just the safe
// "sibling → core" circularity the files above use.
import {
  escapeHtml, icon, uid, currentUser, mainFeatureView, setMainFeatureView,
  logActivityEvent, diffMainFields, showCloudError, playContentTransition,
  renderSidebar, formatActivityDateTime, recipesCol, recipeSeriesCol, db, projects, metaLists,
  metaItemName, productTypeCode, ingredientMaster, migrateTrialsFromRecipes,
  countryToIso2, guardNavigation,
  readOnlyIngredientTreeHtml, readOnlyProcessesHtml,
  renderReadOnlyProcessFlowchart, renderMain,
  requestAuthConfirm, DELETE_APPROVER_EMAIL, approverRecipesCol,
  snapshotMainFields, blankProduct, scheduleProjectSave,
  findMaterialByLabel, materialLabel, formatMoq, resizeImageFile, wireModalOverlayClose, getRequirements,
  openMaterialDetail, computePrepareWeight, computeIngredientCost, isValidYieldPct, partPrepareWeight,
  setCompareSeriesPrefilter, moveToTrash
} from './app.js';
import {
  onSnapshot, setDoc, doc, deleteDoc, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  blankPart, blankRecipe, migrateRecipe, saveRecipeToCloud, findProjectForRecipe,
  yearPrefix, recipeDestinationIso2, recipeProductTypeCode, suggestNextRecipeSeq,
  trialNoDisplay, fullCode, recipeDisplayLabel, descriptionListHtml,
  recomputeFromWeights, partTotalWeight, allIngredientsInPart,
  allIngredientsInRecipe, collectIngredientsWithPrepareWeight, findPartByName,
  scaleIngredientsInPart, siblingsWeightExcluding, isPartOrDescendant,
  collectPartsFlat, collectIngredientsFlat, round2, formatWeight,
  DEFAULT_FLOW_NODE_W, nextFlowNodeLabel, blankFlowNode,
  computeFlowNodeText, rectOf, clipToRectEdge, FLOW_ARROWHEAD_DEFS
} from './recipes-data.js';
import {
  versionsModalRecipe, openVersionsModal, renderVersionsList,
  pushVersionCheckpoint, scheduleVersionCheckpoint, cancelVersionCheckpoint
} from './recipes-versions.js';
import { renderDescPoints, renderDescPhotos, wireRecipeTranslateButton } from './recipes-print.js';
import { exportRecipeToExcel } from './recipes-excel.js';

export let recipes = [];
export let currentId = null;
export let unlockedRecipeId = null;
// Debounce-timer handle for scheduleSave/saveNow below -- module-scoped
// here since ES modules don't share `let` bindings; app.js has its own,
// separately-scoped variable of the same name for an unrelated feature,
// which is just a naming coincidence, not a shared timer.
let saveTimer = null;
export let unsubscribeRecipes = null;
export let recipesLoaded = false;

export const RECIPE_DIFF_FIELDS = { name: 'Product Name', code: 'Trial/Reference Code', productType: 'Product Type', recipeSeq: 'Recipe Sequence', date: 'Date', batchWeight: 'Batch Weight', yieldPct: 'Yield %', note: 'Note', devStatus: 'Development Status' };

// Where a recipe is at in its own development lifecycle -- shown as a
// colored dropdown next to the recipe title (see renderRecipeEditor /
// updateDevStatusSelectColor). "In Development" is the default every new
// recipe starts at; the other five are the states a PD can move it to.
const RECIPE_DEV_STATUSES = [
  { value: 'In Development', emoji: '🟡', color: '#a16207', bg: '#fef9c3' },
  { value: 'On Hold', emoji: '⚪', color: '#4b5563', bg: '#f3f4f6' },
  { value: 'Pilot', emoji: '🟣', color: '#7e22ce', bg: '#f3e8ff' },
  { value: 'Approved', emoji: '🟢', color: '#15803d', bg: '#dcfce7' },
  { value: 'Discontinued', emoji: '🔴', color: '#b91c1c', bg: '#fee2e2' },
  { value: 'Needs Improvement', emoji: '🟠', color: '#c2410c', bg: '#ffedd5' }
];
function recipeDevStatusMeta(value){
  return RECIPE_DEV_STATUSES.find(s => s.value === value) || RECIPE_DEV_STATUSES[0];
}
// Recolors the <select> itself to match whichever status is currently
// selected -- same soft-pill look as Projects' .mu-status-badge (no
// border, just background + text color), rather than a plain dropdown.
function updateDevStatusSelectColor(select){
  const meta = recipeDevStatusMeta(select.value);
  select.style.color = meta.color;
  select.style.background = meta.bg;
}

export let recipeEditSnapshotBefore = null;

/* Wires a "pick from the shared list" field (Customer Name, Destination
   Country, Sales Rep). New values can no longer be added by just typing
   them here — that used to silently grow the shared list from free text,
   which the Reference Lists screen is meant to curate deliberately.
   Typing something not already in the list reverts the field and points
   the user at 📇 Reference Lists instead. The trash button just clears
   this recipe's own field. */
// Shared by the on-screen "Project" field's info panel and the print view's
// Product Details card -- both show the exact same linked-project facts and
// Requirements box, just inside a different wrapper.
export function linkedProjectInfoHtml(link){
  if(!link) return '';
  const { project, product } = link;
  // Two lines instead of one long wrapping one -- PD/Factory/Stage on
  // their own line below Customer/Destination/Owner/Factory Sales Rep,
  // rather than however many of them happen to fit before the browser's
  // own wrap point (which could land mid-way through a single field).
  const factsLine1 = [
    project.customerName ? `<b>Customer:</b> ${escapeHtml(project.customerName)}` : '',
    project.destinationCountry ? `<b>Destination:</b> ${escapeHtml(project.destinationCountry)}` : '',
    project.ownerSalesRep ? `<b>Project Owner:</b> ${escapeHtml(project.ownerSalesRep)}` : '',
    project.factorySalesRep ? `<b>Factory Sales Rep:</b> ${escapeHtml(project.factorySalesRep)}` : ''
  ].filter(Boolean);
  const factsLine2 = [
    project.responsiblePerson ? `<b>PD:</b> ${escapeHtml(project.responsiblePerson)}` : '',
    project.factoryName ? `<b>Factory:</b> ${escapeHtml(project.factoryName)}` : '',
    `<b>Stage:</b> ${escapeHtml(product.stage || '-')}`
  ].filter(Boolean);

  // Everything under the Project's own "Requirements" box -- Portion/
  // Inner/Outer Packing and MOQ live as plain top-level project fields,
  // the rest come through getRequirements (handles legacy free-text
  // projects and normalizes Cooking Guidelines into an array of groups,
  // same as projects.js's own read-only Requirements view). Short,
  // single-line facts go in the same compact grid as Trials' linked-
  // project summary (.trial-project-summary-reqs); longer/multi-line
  // ones (Packaging Condition, Composition, Recipe, Cooking Guidelines,
  // Note) get their own labeled block.
  const req = getRequirements(project);
  const flavors = project.flavors || [];
  const formatFlavorPrice = (f, price) => price ? `${escapeHtml(price)} ${escapeHtml(f.priceCurrency || 'THB')} / ${escapeHtml(f.priceUnit || 'kg')}` : '-';
  const productTableHtml = flavors.length ? `
    <div style="grid-column:1/-1;">
    <div class="material-detail-notes-label">Product</div>
    <div class="flavor-table-scroll">
    <table class="flavor-table">
      <thead><tr><th>Product</th><th>Sample Qty</th><th>Sample Request Date</th><th>Target Price</th><th>Actual Price</th><th>Formula / Reference No.</th><th>Note</th></tr></thead>
      <tbody>${flavors.map(f => `
        <tr>
          <td>${escapeHtml(f.name || 'Untitled product')}</td>
          <td>${f.sampleQty ? `${escapeHtml(f.sampleQty)}${f.sampleQtyUnit ? ' ' + escapeHtml(f.sampleQtyUnit) : ''}` : '-'}</td>
          <td>${escapeHtml(f.sampleRequestDate || '-')}</td>
          <td>${formatFlavorPrice(f, f.targetPrice)}</td>
          <td>${formatFlavorPrice(f, f.actualPrice)}</td>
          <td>${escapeHtml(f.formulaRefCode || '-')}</td>
          <td>${escapeHtml(f.note || '-')}</td>
        </tr>
      `).join('')}</tbody>
    </table>
    </div>
    </div>
  ` : '';
  const portionWeight = project.portionWeightQty ? `${escapeHtml(project.portionWeightQty)} ${escapeHtml(project.portionWeightUnit || '')}/${escapeHtml(project.portionPerUnit || '')}` : '';
  const innerPacking = project.innerPackQty ? `${escapeHtml(project.innerPackQty)} ${escapeHtml(project.innerPackWeightUnit || '')}/${escapeHtml(project.innerPackUnit || '')}` : '';
  const outerPacking = project.outerPackQty ? `${escapeHtml(project.outerPackQty)} ${escapeHtml(project.outerPackUnit || '')}/${escapeHtml(project.outerPackContainerUnit || '')}` : '';
  const moq = project.moqQty ? `${escapeHtml(project.moqQty)} ${escapeHtml(project.moqUnit || '')}` : '';

  const shortReqFacts = [
    portionWeight ? `<div class="ci-row"><b>Portion Weight:</b> ${portionWeight}</div>` : '',
    innerPacking ? `<div class="ci-row"><b>Inner Packing:</b> ${innerPacking}</div>` : '',
    outerPacking ? `<div class="ci-row"><b>Outer Packing:</b> ${outerPacking}</div>` : '',
    moq ? `<div class="ci-row"><b>MOQ:</b> ${moq}</div>` : '',
    req.storageCondition ? `<div class="ci-row"><b>Storage Condition:</b> ${escapeHtml(req.storageCondition)}</div>` : '',
    req.shelfLife ? `<div class="ci-row"><b>Shelf Life:</b> ${escapeHtml(req.shelfLife)}</div>` : '',
    req.certificate ? `<div class="ci-row"><b>Certificate:</b> ${escapeHtml(req.certificate)}</div>` : ''
  ].filter(Boolean).join('');

  const longReqBlocks = [
    req.packagingCondition ? `<div><div class="material-detail-notes-label">Packaging Condition</div><div class="material-detail-notes">${escapeHtml(req.packagingCondition)}</div></div>` : '',
    req.composition ? `<div><div class="material-detail-notes-label">Composition</div><div class="material-detail-notes">${escapeHtml(req.composition)}</div></div>` : '',
    req.recipe ? `<div><div class="material-detail-notes-label">Recipe</div><div class="material-detail-notes">${escapeHtml(req.recipe)}</div></div>` : '',
    ...req.cookingCondition.filter(g => g.method || g.steps.length).map(g => `
      <div>
        <div class="material-detail-notes-label">Cooking Guidelines${g.method ? ` — ${escapeHtml(g.method)}` : ''}</div>
        ${g.steps.length ? `<ol class="cooking-steps-list">${g.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
      </div>
    `),
    req.note ? `<div><div class="material-detail-notes-label">Note</div><div class="material-detail-notes">${escapeHtml(req.note)}</div></div>` : ''
  ].filter(Boolean).join('');

  return `
    <div class="ci-row" style="margin-top:6px;">${factsLine1.join(' &nbsp;|&nbsp; ')}</div>
    <div class="ci-row">${factsLine2.join(' &nbsp;|&nbsp; ')}</div>
    ${(productTableHtml || shortReqFacts || longReqBlocks) ? `
    <div class="trial-project-summary-reqs" style="margin-top:8px;">
      <div class="trial-project-summary-reqs-title">Requirements</div>
      ${productTableHtml}
      ${shortReqFacts}
      ${longReqBlocks}
    </div>
    ` : ''}
  `;
}

export function renderLinkedProjectSection(r){
  const select = document.getElementById('f-linkedProject');
  if(!select) return;
  const link = findProjectForRecipe(r.id);
  const sortedProjects = [...projects].sort((a,b) => (a.name||'').localeCompare(b.name||'', undefined, {sensitivity:'base'}));
  select.innerHTML = `<option value="">— Not linked —</option>` +
    sortedProjects.map(p => `<option value="${escapeHtml(p.id)}" ${link && link.project.id === p.id ? 'selected' : ''}>${escapeHtml(p.name || 'Untitled project')}</option>`).join('');

  const infoEl = document.getElementById('linkedProjectInfo');
  infoEl.innerHTML = linkedProjectInfoHtml(link);
}

export function renderProductTypeSelect(r){
  const select = document.getElementById('f-productTypeMain');
  if(!select) return;
  const sortedTypes = [...metaLists.productTypes].sort((a,b) => metaItemName(a).localeCompare(metaItemName(b)));
  select.innerHTML = `<option value="">— Select —</option>` +
    sortedTypes.map(t => `<option value="${escapeHtml(metaItemName(t))}" ${metaItemName(t) === (r.productType || '') ? 'selected' : ''}>${escapeHtml(metaItemName(t))} (${escapeHtml(t.code || productTypeCode(metaItemName(t)))})</option>`).join('');
}

// The Recipe Code row's Product Type segment is a read-only badge, not its
// own picker — it always mirrors whatever's chosen in the Product Type
// field above (see f-productTypeMain), the same way codeYearDisplay mirrors
// the Date field instead of being independently editable.
export function refreshCodeProductTypeBadge(r){
  const badge = document.getElementById('codeProductTypeDisplay');
  if(!badge) return;
  badge.textContent = (r.seriesId ? r.productTypeCode : recipeProductTypeCode(r)) || 'TTT';
}

export function bindComboField(r, fieldKey, inputId, deleteBtnId, metaKey){
  const input = document.getElementById(inputId);
  input.value = r[fieldKey] || '';
  let lastValidValue = r[fieldKey] || '';
  input.addEventListener('input', e => {
    r[fieldKey] = e.target.value;
    scheduleSave();
  });
  input.addEventListener('change', () => {
    const v = input.value.trim();
    const exists = v === '' || metaLists[metaKey].some(item => metaItemName(item) === v);
    if(!exists){
      alert(`"${v}" is not in the list yet. Please add it via Reference Lists first, then pick it here.`);
      input.value = lastValidValue;
      r[fieldKey] = lastValidValue;
      scheduleSave();
      return;
    }
    lastValidValue = v;
  });
  document.getElementById(deleteBtnId).addEventListener('click', () => {
    input.value = '';
    r[fieldKey] = '';
    lastValidValue = '';
    scheduleSave();
  });
}

/* Firestore is the source of truth, but while a recipe is open for editing we
   keep its in-memory object identity stable across snapshot updates — the
   input handlers below mutate that object directly on every keystroke, and
   swapping in a fresh object from an incoming snapshot mid-edit would silently
   drop whatever the user just typed. Every other recipe still refreshes freely. */
export function attachRecipesListener(){
  unsubscribeRecipes = onSnapshot(recipesCol, snapshot => {
    const previousCurrent = recipes.find(r => r.id === currentId);
    const incoming = snapshot.docs.map(d => d.data());
    incoming.forEach(r => { migrateRecipe(r); recomputeFromWeights(r); });

    if(previousCurrent && incoming.some(r => r.id === currentId)){
      recipes = incoming.map(r => r.id === currentId ? previousCurrent : r);
    }else{
      recipes = incoming;
    }

    const firstLoad = !recipesLoaded;
    recipesLoaded = true;
    migrateTrialsFromRecipes();

    if(currentId && !recipes.some(r => r.id === currentId)){
      // the recipe being viewed no longer exists (deleted) -> back to the homepage
      currentId = null;
      unlockedRecipeId = null;
      renderMain();
    }else if(firstLoad || (!currentId && !mainFeatureView)){
      // no recipe is open and no full-page feature view is active (home
      // dashboard is showing) -> safe to re-render on every update, since
      // there's no in-progress edit/selection whose state needs preserving.
      // The mainFeatureView check matters now that Compare/Materials/
      // RefLists/Projects/Trials live in #mainArea too — re-mounting one of
      // those from scratch (like this branch does) would silently wipe out
      // whatever the user had picked/typed there, which used to be
      // impossible when they were separate, always-persistent modals.
      renderMain();
    }

    renderSidebar();
  }, err => {
    console.error('Forge: recipes listener error', err);
    showCloudError('Failed to load recipe data from Firebase: ' + err.message);
  });
}

export function getCurrent(){
  return recipes.find(r => r.id === currentId);
}

export function performSave(r){
  if(!r) return;
  r.updatedAt = Date.now();
  r.updatedBy = currentUser?.email || '';
  saveRecipeToCloud(r);
  renderSidebar();
  if(r.id === currentId){
    updateRecipeTitleDisplay(r); // refresh "Last edited by/at" now that it's current
    const s = document.getElementById('saveStatus');
    if(s){
      s.textContent = 'Saved ' + new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
      s.classList.add('saved');
    }
  }
}

export function scheduleSave(){
  // Captured now (while the edit that triggered this call is still the
  // current recipe) rather than inside the timeout — otherwise switching
  // recipes within the debounce window would save whatever recipe happens
  // to be open 400ms later instead of the one actually edited.
  const r = getCurrent();
  const status = document.getElementById('saveStatus');
  if(status){ status.textContent = 'Saving...'; status.classList.remove('saved'); }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => performSave(r), 400);
  if(r) scheduleVersionCheckpoint(r);
}

// Manual Save button — flushes the pending debounced save immediately,
// cancels this recipe's pending idle auto-checkpoint (redundant now that
// we're checkpointing right here), takes its own Version History
// checkpoint — so clicking Save is enough on its own; there's no separate
// "Save Current as Version" step needed for a plain save to be revertible
// — and locks the recipe back to read-only view, the same way finishing an
// edit and stepping away from it should feel: Save = "I'm done for now."
export function saveNow(){
  const r = getCurrent();
  if(!r) return;
  clearTimeout(saveTimer);
  cancelVersionCheckpoint(r);
  pushVersionCheckpoint(r, 'Saved');
  performSave(r);
  logActivityEvent('updated', 'recipe', r.name || 'Untitled recipe', diffMainFields(recipeEditSnapshotBefore, r, RECIPE_DIFF_FIELDS));
  recipeEditSnapshotBefore = null;
  if(versionsModalRecipe === r) renderVersionsList(r);
  unlockedRecipeId = null;
  renderMain();
}

// Called by createNewRecipe (recipes-list.js) after building a blank
// recipe -- a plain `recipes.push(...)`/`currentId = ...`/
// `unlockedRecipeId = ...` from outside this module isn't possible, ES
// modules can't reassign a sibling module's `let` binding from outside it
// (same reasoning as openRecipe/setUnlockedRecipeId below). Unlike
// openRecipe, always unlocks the new recipe immediately for editing.
export function registerNewRecipe(r){
  recipes.push(r);
  currentId = r.id;
  unlockedRecipeId = r.id;
}

export function refreshCodeCountryBadge(r){
  const row = document.getElementById('codeYearDisplay')?.closest('.code-row');
  const badge = document.getElementById('codeCountryDisplay');
  if(!row || !badge) return;
  const iso = r.seriesId ? (r.countryCode || '') : recipeDestinationIso2(r);
  row.classList.toggle('has-country-badge', !!iso);
  badge.style.display = iso ? '' : 'none';
  badge.textContent = iso;
}

export function updateRecipeTitleDisplay(r){
  const el = document.getElementById('recipeTitleDisplay');
  if(!el) return;
  // Series recipes show the Series code and the Trial number as two
  // visually distinct badges (name / AU26-SAU06 / [Trial T21]) rather than
  // one combined string, since the Trial number is the part that changes
  // Trial-to-Trial and is worth calling out on its own.
  const trialBadge = r.seriesId ? `<span class="rt-trial-badge">Trial T${trialNoDisplay(r.trialNo)}</span>` : '';
  const code = r.seriesId ? (r.seriesKey || '') : fullCode(r);
  el.innerHTML = `${escapeHtml(r.name || 'Untitled recipe')}${code ? `<span class="rt-code">${escapeHtml(code)}</span>` : ''}${trialBadge}`;

  const activityEl = document.getElementById('recipeActivityDisplay');
  if(activityEl){
    const parts = [];
    if(r.createdBy) parts.push(`Created by ${r.createdBy}${r.createdAt ? ' · ' + formatActivityDateTime(r.createdAt) : ''}`);
    if(r.updatedBy) parts.push(`Last edited by ${r.updatedBy}${r.updatedAt ? ' · ' + formatActivityDateTime(r.updatedAt) : ''}`);
    activityEl.textContent = parts.join('   |   ');
  }
}

// Horizontal T19 ── T20 ── T21 ── +T22 stepper on a Series recipe's own
// page — every Trial in the Series, latest last, plus a trailing "+T{next}"
// pill that triggers New Trial directly. Re-rendered on every
// renderRecipeEditor() call (not registered in partDisplayUpdaters or
// similar — this card only exists while a Series recipe is the one open,
// same lifetime as the rest of the header).
function renderTrialHistoryTrack(r){
  const track = document.getElementById('trialHistoryTrack');
  if(!track) return;
  const seriesTrials = recipes.filter(x => x.seriesId === r.seriesId).sort((a,b) => (a.trialNo||0) - (b.trialNo||0));
  const maxTrialNo = Math.max(0, ...seriesTrials.map(x => x.trialNo || 0));
  const nodeHtml = t => `
    <button type="button" class="trial-history-node${t.id === r.id ? ' active' : ''}" data-recipe-id="${escapeHtml(t.id)}">
      T${trialNoDisplay(t.trialNo)}${t.trialNo === maxTrialNo ? '<span class="trial-history-latest">Latest</span>' : ''}
    </button>
  `;
  track.innerHTML = seriesTrials.map(nodeHtml).join('<span class="trial-history-connector"></span>')
    + `<span class="trial-history-connector"></span><button type="button" class="trial-history-node trial-history-add" id="trialHistoryAddBtn">+ T${trialNoDisplay(maxTrialNo+1)}</button>`;
  track.querySelectorAll('.trial-history-node[data-recipe-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.recipeId;
      if(id === r.id) return;
      // Same "opening a different recipe locks it again" behavior as every
      // other recipe-to-recipe navigation in this app (sidebar, Recipes
      // list) — see appendRecipeItemEl/openRecipe.
      guardNavigation(() => {
        openRecipe(id);
        setMainFeatureView(null);
        renderMain();
        renderSidebar();
      });
    });
  });
  document.getElementById('trialHistoryAddBtn')?.addEventListener('click', () => confirmAndCreateNewTrial(r));
}

let dragPayload = null;

// Which Formula-tree ingredient rows currently have their Sub Ingredients
// panel expanded -- keyed by ingredient id, not part of the recipe data
// itself (purely a UI toggle), so it survives renderRows() re-creating the
// row's DOM (on every add/delete/weight change) the same way
// projectExpandedIds/trialExpandedIds survive their own list re-renders.
let ingSubsExpandedIds = new Set();
// Picker over the matched Ingredient Library entry's own Sub Ingredients
// (Type/Size/Unit/Cooking/%Yield, see materials.js) -- each row is a
// clickable button so a specific cut/prep variant can be applied to this
// recipe row (see applySubIngredient below), rather than just displaying
// the full list read-only. A table rather than a plain button list since
// it stays scannable even once an ingredient has many variants on file.
function subIngredientSummary(si){
  const sizeStr = (si.size && si.sizeUnit) ? `${si.size} ${si.sizeUnit}` : (si.size || si.sizeUnit || '');
  return [si.type, sizeStr, si.cooking].filter(Boolean).join(' · ');
}
function ingSubIngredientsHtml(ing, matched){
  const subs = matched?.subIngredients || [];
  if(!subs.length) return '';
  const expanded = ingSubsExpandedIds.has(ing.id);
  return `
    <button type="button" class="ing-subs-toggle" data-role="toggle-ing-subs">${icon(expanded ? 'chevron-up' : 'chevron-down', 12)} Sub Ingredients (${subs.length})</button>
    ${expanded ? `
    <div class="flavor-table-scroll" style="margin-top:4px;">
    <table class="flavor-table">
      <thead><tr><th>Type</th><th>Size</th><th>Unit</th><th>Cooking</th><th>% Yield</th></tr></thead>
      <tbody>${subs.map((si, idx) => `
        <tr data-sub-idx="${idx}" title="Click to use this in the Note field">
          <td>${escapeHtml(si.type || '-')}</td>
          <td>${escapeHtml(si.size || '-')}</td>
          <td>${escapeHtml(si.sizeUnit || '-')}</td>
          <td>${escapeHtml(si.cooking || '-')}</td>
          <td>${si.yieldPct !== '' && si.yieldPct != null ? escapeHtml(si.yieldPct) + '%' : '-'}</td>
        </tr>
      `).join('')}</tbody>
    </table>
    </div>
    ` : ''}
  `;
}
// Renders into subsEl and (re)wires its toggle button + selectable rows --
// called again, recursively, from inside the click handlers themselves,
// since replacing innerHTML drops whatever listeners were on the old ones.
// `onPicked` (optional) fires after a variant is applied -- used to also
// snapshot its %Yield into the row's Prepare Weight fields, which live
// outside this function's own DOM (see the ing-yield/.ing-prepare-display
// wiring in renderRows).
function renderIngSubsToggle(subsEl, ing, matched, noteInput, onPicked){
  subsEl.innerHTML = ingSubIngredientsHtml(ing, matched);
  const btn = subsEl.querySelector('[data-role="toggle-ing-subs"]');
  if(!btn) return;
  btn.addEventListener('click', () => {
    if(ingSubsExpandedIds.has(ing.id)) ingSubsExpandedIds.delete(ing.id); else ingSubsExpandedIds.add(ing.id);
    renderIngSubsToggle(subsEl, ing, matched, noteInput, onPicked);
  });
  const subs = matched?.subIngredients || [];
  subsEl.querySelectorAll('tr[data-sub-idx]').forEach(row => {
    row.addEventListener('click', () => {
      const si = subs[parseInt(row.dataset.subIdx, 10)];
      if(!si) return;
      ing.note = subIngredientSummary(si);
      noteInput.value = ing.note;
      // Snapshot the variant's own %Yield onto this recipe row -- a plain
      // copy, not a live reference, so editing the Library's Sub
      // Ingredients later never changes an already-saved recipe (see
      // subIngredientId, only used to know "this came from the library"
      // for the from-library hint and to detect a variant change).
      ing.subIngredientId = si.id;
      ing.prepYieldPct = (si.yieldPct !== '' && si.yieldPct != null && isFinite(parseFloat(si.yieldPct))) ? parseFloat(si.yieldPct) : 100;
      if(onPicked) onPicked();
      scheduleSave();
      ingSubsExpandedIds.delete(ing.id);
      renderIngSubsToggle(subsEl, ing, matched, noteInput, onPicked);
    });
  });
}

// Recipe Overview table (see renderOverview) — 'wt' also covers % of
// Recipe, since that's just weight expressed as a share of the total and
// so always sorts identically to it; a separate key would just be the same
// order twice. Defaults match the table's original fixed order (heaviest
// ingredient first) so nothing changes on-screen until the user clicks a
// header.
let overviewSortKey = 'wt';
let overviewSortDir = 'desc';
// Costing card's margin/selling-price block (Overhead Multiplier through
// Customer Selling Price) can be hidden with the eye button -- e.g. while
// screen-sharing or printing an informal copy, without needing to actually
// blank the fields out. Persisted per-browser in localStorage (not on the
// recipe itself -- this is a personal viewing preference, not recipe
// data, so it doesn't sync to other users or other devices), so it stays
// hidden across a page reload or leaving/reopening a recipe instead of
// resetting open every time.
const COSTING_MARGIN_VISIBLE_KEY = 'forge_costingMarginVisible';
function loadCostingMarginVisible(){
  try {
    const saved = localStorage.getItem(COSTING_MARGIN_VISIBLE_KEY);
    return saved === null ? true : saved === 'true';
  } catch(e) { return true; }
}
export let costingMarginVisible = loadCostingMarginVisible();
function overviewHeaderRowHtml(){
  const th = (label, cls, key) => {
    const active = overviewSortKey === key;
    const arrow = active ? icon(overviewSortDir === 'asc' ? 'chevron-up' : 'chevron-down', 12) : '';
    return `<th class="${cls || ''} proj-th-sortable${active ? ' active' : ''}"><span class="proj-th-label" data-sort-key="${key}">${label} ${arrow}</span></th>`;
  };
  return `
    <th class="col-no">#</th>
    ${th('Ingredient / Prep', '', 'name')}
    ${th('% of Recipe', 'col-pct', 'wt')}
    ${th('Formula Wt. (g)', 'col-wt', 'wt')}
    ${th('Prepare Wt. (g)', 'col-wt', 'prepareWt')}
    ${th('Cost (฿)', 'col-cost', 'cost')}
  `;
}

export function renderRecipeEditor(r){
  const main = document.getElementById('mainArea');
  main.innerHTML = `
    <div class="main-header">
      <div>
        <div class="recipe-title-display" id="recipeTitleDisplay"></div>
        <div class="save-status saved" id="saveStatus">Ready</div>
        <div class="recipe-activity-display" id="recipeActivityDisplay"></div>
        <div class="dev-status-row">
          <label for="f-devStatus">Development Status:</label>
          <select id="f-devStatus" class="dev-status-select">
            ${RECIPE_DEV_STATUSES.map(s => `<option value="${escapeHtml(s.value)}">${s.emoji} ${escapeHtml(s.value)}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>

    <div class="recipe-header-actions">
      <div class="lock-banner" id="lockBanner"></div>
      <div class="toolbar">
        <div class="hd2-create-wrap">
          <button type="button" class="btn" id="btnRecipeMore">More ${icon('chevron-down', 14)}</button>
          <div class="hd2-create-menu" id="recipeMoreMenu">
            <button type="button" class="navbar-account-menu-item" id="btnDuplicateAsNewRecipe">${icon('copy')} Duplicate as New Recipe</button>
            <button type="button" class="navbar-account-menu-item" id="btnVersions">${icon('clock')} Versions</button>
            <button type="button" class="navbar-account-menu-item" id="btnPreview">${icon('eye')} Preview</button>
            <button type="button" class="navbar-account-menu-item" id="btnPrint">${icon('printer')} Print / PDF</button>
            <button type="button" class="navbar-account-menu-item" id="btnExportExcel">${icon('download')} Export Excel</button>
          </div>
        </div>
      </div>
    </div>

    ${r.seriesId ? `
    <div class="card" id="trialHistoryCard">
      <div class="card-title">Trial History — ${escapeHtml(r.seriesKey || '')}</div>
      <div class="trial-history-row">
        <div class="trial-history-track" id="trialHistoryTrack"></div>
        <div class="trial-history-actions">
          <button class="btn btn-primary" id="btnNewTrial">+ New Trial</button>
          <button class="btn" id="btnCompareTrials">${icon('scale')} Compare Trials</button>
        </div>
      </div>
    </div>
    ` : ''}

    <!-- Fixed, always in the DOM (not print-only) so it's available the
         instant preview-print-mode is toggled on -- see btnPreview's
         wiring below and the .preview-print-mode rules in style.css,
         which mirror @media print's own visibility rules but driven by
         this class instead, so the exact same #printInfoCard/
         #printIngredientTree/etc. content (already populated by
         renderPrintView for the real Print button) can be shown on
         screen too, full-bleed, without actually invoking window.print(). -->
    <button class="print-preview-close" id="btnClosePrintPreview" title="Close Preview">${icon('x', 22)}</button>

    <div id="recipeCards">
    <div class="card">
      <div class="card-title">1. Product Details</div>
      <div class="recipe-fields-edit">
        <div class="grid-2">
          <div class="field">
            <label>Product Name</label>
            <input type="text" id="f-name" placeholder="e.g. Vegan Tartar Sauce">
          </div>
          <div class="field">
            <label>Date</label>
            <input type="date" id="f-date">
          </div>
        </div>
        <div class="grid-2">
          <div class="field">
            <label>Product Type</label>
            <select id="f-productTypeMain" class="proj-select"></select>
          </div>
          <div class="field">
            <label>Recipe Code — CCYY-TTTNN-TNN</label>
            <div class="code-row">
              <span class="code-prefix" id="codeCountryDisplay" style="display:none;" title="Country code auto-filled from the linked Project's Destination Country"></span>
              <span class="code-prefix" id="codeYearDisplay">YY</span>
              <span class="code-sep">-</span>
              <span class="code-prefix" id="codeProductTypeDisplay" title="From the Product Type field above">TTT</span>
              <span class="code-prefix" id="codeRecipeSeqDisplay" title="Recipe sequence number for this product type — assigned automatically">NN</span>
              <span class="code-sep">-</span>
              <span class="code-prefix">T</span>
              ${r.seriesId
                ? `<span class="code-prefix code-trial-display" id="codeTrialDisplay" title="Trial number — assigned automatically by New Trial, part of this recipe's Series">${escapeHtml(trialNoDisplay(r.trialNo))}</span>`
                : `<input type="text" id="f-codeSuffix" class="code-suffix code-suffix-sm" placeholder="01" maxlength="6" title="Trial number for this recipe">`}
            </div>
          </div>
        </div>
        <div class="field">
          <label>Project</label>
          <select id="f-linkedProject" class="proj-select"></select>
        </div>
        <div id="linkedProjectInfo"></div>
        <div class="field">
          <label>Description / Concept</label>
          <div class="desc-points-list" id="descPointsList"></div>
          <button class="btn btn-sm add-row-btn" type="button" id="btnAddDescPoint">+ Add Point</button>
          <div class="desc-photos-label">Photos (up to 3)</div>
          <div class="trial-photos-row" id="descPhotosRow"></div>
          <input type="file" id="descPhotoInput" accept="image/*">
        </div>
        <div class="field">
          <label>Note</label>
          <div class="mu-field-with-translate" style="width:auto;">
            <textarea id="f-note" rows="2" placeholder="Anything else worth noting about this recipe"></textarea>
            <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
          </div>
        </div>
      </div>
      <div id="printInfoCard" class="print-only compare-info-col"></div>
    </div>

    <div class="card">
      <div class="card-title">2. Recipe Overview (all parts combined)</div>
      <div class="overview-block">
        <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr id="overviewHeaderRow">${overviewHeaderRowHtml()}</tr>
          </thead>
          <tbody id="overviewBody"></tbody>
          <tfoot>
            <tr>
              <td></td>
              <td>Formula Total</td>
              <td class="col-pct" id="grandTotalPct"></td>
              <td class="col-wt" id="grandTotalWt"></td>
              <td class="col-wt" id="grandTotalPrepareWt" title="Preparation Total"></td>
              <td class="col-cost" id="grandTotalCost"></td>
            </tr>
          </tfoot>
        </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        3. Costing
        <button type="button" class="icon-btn" id="btnToggleCostingMargin" title="${costingMarginVisible ? 'Hide' : 'Show'} Overhead Multiplier, Margins & Selling Price">${icon(costingMarginVisible ? 'eye' : 'eye-off')}</button>
      </div>
      <div class="overview-block">
        <div class="batch-summary" style="margin-top:0;margin-bottom:0;">
          <div>
            <div class="batch-stat-label">Currency</div>
            <select id="f-pricingCurrency" class="proj-select">
              ${['THB','USD','JPY','CNY','EUR'].map(c => `<option value="${c}">${c}</option>`).join('')}
            </select>
          </div>
          <div></div>
          <div id="exchangeRateFieldWrap" style="display:none;">
            <div class="batch-stat-label">Exchange Rate (1 = ? THB)</div>
            <div class="batch-scale-row">
              <input type="number" id="f-exchangeRate" min="0" step="0.0001" placeholder="e.g. 36.50" style="width:90px;">
            </div>
          </div>
          <div id="exchangeRateDateFieldWrap" style="display:none;">
            <div class="batch-stat-label">Rate Date</div>
            <div class="batch-scale-row">
              <input type="date" id="f-exchangeRateDate">
            </div>
          </div>
          <div>
            <div class="batch-stat-label">Amount per Serving (g)</div>
            <div class="batch-scale-row">
              <input type="number" id="f-servingSize" min="0" step="0.01" placeholder="e.g. 250">
            </div>
          </div>
          <div id="overviewCostPerServingWrap" style="display:none;">
            <div class="batch-stat-label">Cost RM / Serving</div>
            <div class="batch-stat-value" id="overviewCostPerServing">—</div>
          </div>
          <div>
            <div class="batch-stat-label">Cost RM / 100 g</div>
            <div class="batch-stat-value" id="overviewCostPer100">—</div>
          </div>
          <div>
            <div class="batch-stat-label">Cost RM / kg</div>
            <div class="batch-stat-value" id="overviewCostPerKg">—</div>
          </div>
          <div id="costingMarginSection" style="display:${costingMarginVisible ? 'contents' : 'none'};">
          <div>
            <div class="batch-stat-label">Overhead Multiplier</div>
            <div class="batch-scale-row">
              <input type="number" id="f-overheadMultiplier" min="0" step="0.001" placeholder="e.g. 1.625" style="width:70px;">
              <span>×</span>
            </div>
          </div>
          <div></div>
          <div>
            <div class="batch-stat-label" title="Markup on cost (after the Overhead Multiplier above) — e.g. 50% means the selling price is that × 1.5, not ÷ 0.5">Factory Margin (Min% – Max% Markup on Cost)</div>
            <div class="batch-scale-row">
              <input type="number" id="f-factoryMarginMin" min="0" step="0.01" placeholder="e.g. 20" style="width:64px;" title="Markup on cost, not a % of the selling price">
              <span>–</span>
              <input type="number" id="f-factoryMarginMax" min="0" step="0.01" placeholder="e.g. 30" style="width:64px;" title="Markup on cost, not a % of the selling price">
              <span>%</span>
            </div>
          </div>
          <div>
            <div class="batch-stat-label">Factory Selling Price / Serving</div>
            <div class="batch-stat-value" id="overviewFactoryPrice">—</div>
          </div>
          <div>
            <div class="batch-stat-label" title="Markup on the Factory Selling Price above, not a % of the final selling price">Company Margin (Min% – Max% Markup on Factory Price)</div>
            <div class="batch-scale-row">
              <input type="number" id="f-companyMarginMin" min="0" step="0.01" placeholder="e.g. 40" style="width:64px;" title="Markup on the Factory Selling Price, not a % of the selling price">
              <span>–</span>
              <input type="number" id="f-companyMarginMax" min="0" step="0.01" placeholder="e.g. 50" style="width:64px;" title="Markup on the Factory Selling Price, not a % of the selling price">
              <span>%</span>
            </div>
          </div>
          <div>
            <div class="batch-stat-label">Company Selling Price / Serving</div>
            <div class="batch-stat-value" id="overviewCompanyPrice">—</div>
          </div>
          <div>
            <div class="batch-stat-label" title="Markup on the Company Selling Price above, not a % of the final selling price">Customer Margin (Min% – Max% Markup on Company Price)</div>
            <div class="batch-scale-row">
              <input type="number" id="f-customerMarginMin" min="0" step="0.01" placeholder="e.g. 20" style="width:64px;" title="Markup on the Company Selling Price, not a % of the selling price">
              <span>–</span>
              <input type="number" id="f-customerMarginMax" min="0" step="0.01" placeholder="e.g. 30" style="width:64px;" title="Markup on the Company Selling Price, not a % of the selling price">
              <span>%</span>
            </div>
          </div>
          <div>
            <div class="batch-stat-label">Customer Selling Price / Serving</div>
            <div class="batch-stat-value" id="overviewCustomerPrice">—</div>
          </div>
          </div>
        </div>
        <div class="compare-legend" id="costingLegend" style="margin-top:12px;display:${costingMarginVisible ? '' : 'none'};">Costs are calculated from weight × the ingredient's Price/kg in the library (always stored in Thai Baht). "No price set" ingredients are excluded from the total — a "*" marks a total that's a partial estimate because at least one ingredient has no price on file. Picking a Currency other than THB converts every figure above using the Exchange Rate you enter (1 unit of that currency = however many THB, as of the Rate Date) — this app has no live rate feed, so nothing converts until a rate is typed in. The Overhead Multiplier applies to Cost/Serving before any margin — leave it blank to skip (× 1); 1.625 is the reference Overhead value at 25%. Factory/Company/Customer Margin are markup — a 50% margin means Selling Price = Cost × 1.5 (100% = ×2, 0% = ×1), each one marked up on the tier before it, not on the final selling price. Selling Price figures round up to the nearest 0.05 of the selected currency (Cost figures above them don't).</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">4. Components and Process</div>
      <div class="components-process-grid">
      <div class="ingredients-edit-view">
      <div class="ingredient-tree">
        <div class="tree-node tree-root-node">
          <span class="tree-node-label">Formula per Portion</span>
          <span class="tree-node-wt tree-root-wt-wrap">
            <input type="number" class="num-input tree-root-wt-input" id="treeRootWt" step="0.01" min="0" title="Type a total weight (g) to scale the whole recipe proportionally">
            <span class="ing-unit">g</span>
          </span>
          <span class="tree-node-pct">100.00%</span>
        </div>
        <div id="partsContainer" class="tree-children"></div>
        <button class="btn btn-sm add-row-btn" id="btnAddPart">+ Add Part</button>
      </div>
      <div class="batch-summary">
        <div>
          <div class="batch-stat-label">Total Recipe Weight (auto-calculated from all ingredient weights)</div>
          <div class="batch-stat-value" id="batchTotalDisplay">0.00 g</div>
        </div>
        <div>
          <div class="batch-stat-label">Scale Recipe To (g)</div>
          <div class="batch-scale-row">
            <input type="number" id="f-scaleTo" min="0" step="0.01" placeholder="e.g. 1000">
            <button class="btn btn-sm" id="btnScale">Scale</button>
          </div>
        </div>
      </div>
      </div>
      </div>
      <div class="print-only components-process-print-grid">
        <div id="printIngredientTree"></div>
        <div id="printProcessStepsFlow" class="simple-process-col"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        5. Process Steps
        <div class="view-mode-toggle" id="processViewToggle">
          <button type="button" class="btn btn-sm view-mode-btn" data-mode="list">${icon('list', 14)} List</button>
          <button type="button" class="btn btn-sm view-mode-btn" data-mode="flowchart">${icon('git-branch', 14)} Flowchart</button>
        </div>
      </div>
      <div id="processesListWrap">
        <div class="processes-list" id="processesList"></div>
        <button class="btn btn-sm add-row-btn" id="btnAddProcess">+ Add Process</button>
      </div>

      <div class="flow-canvas-wrap process-view-hidden" id="flowchartCanvasWrap">
        <div class="flow-toolbar">
          <button type="button" class="btn btn-sm" id="btnAddFlowNode">${icon('plus', 14)} Add Node</button>
        </div>
        <div class="flow-canvas-scroll" id="flowchartCanvasScroll">
          <div class="flow-canvas" id="flowchartCanvas">
            <svg class="flow-edges-svg" id="flowEdgesSvg"></svg>
            <div class="flow-nodes-layer" id="flowNodesLayer"></div>
          </div>
        </div>
      </div>

      <div id="printProcessesView" class="print-only compare-steps-col"></div>
      <div id="printProcessFlowchart" class="print-only"></div>
    </div>
    </div>

    <div class="danger-zone">
      <button class="btn btn-danger btn-block" id="btnDelete">${icon('trash-2')} Delete Recipe</button>
    </div>
  `;

  document.getElementById('f-name').value = r.name || '';
  const codeSuffixInput = document.getElementById('f-codeSuffix');
  if(codeSuffixInput) codeSuffixInput.value = r.code || '';
  if(r.seriesId){
    // Series recipes: every code segment is frozen (see fullCode) — never
    // recomputed here, never editable, and codeRecipeSeqDisplay/
    // codeYearDisplay/codeProductTypeDisplay/codeCountryDisplay all just
    // mirror the stored values instead of the live-derived helpers below.
    document.getElementById('codeRecipeSeqDisplay').textContent = r.recipeSeq || 'NN';
    document.getElementById('codeYearDisplay').textContent = r.year || 'YY';
  } else {
    // Safety net: a recipe that already has a Product Type but somehow
    // never got a sequence number (shouldn't normally happen, since picking
    // a Type always assigns one — see the change handler below) gets one
    // now rather than showing blank forever, since this field is never
    // manually editable.
    if(r.productType && !r.recipeSeq){
      r.recipeSeq = suggestNextRecipeSeq(recipes, r.productType, r.id);
      scheduleSave();
    }
    document.getElementById('codeRecipeSeqDisplay').textContent = r.recipeSeq || 'NN';
    document.getElementById('codeYearDisplay').textContent = yearPrefix(r.date);
  }
  document.getElementById('f-date').value = r.date || '';
  renderProductTypeSelect(r);
  refreshCodeProductTypeBadge(r);
  renderLinkedProjectSection(r);
  refreshCodeCountryBadge(r);
  document.getElementById('f-linkedProject').addEventListener('change', e => {
    const newProjectId = e.target.value;
    const oldLink = findProjectForRecipe(r.id);
    if(oldLink && oldLink.project.id !== newProjectId){
      oldLink.project.products = oldLink.project.products.filter(x => x.recipeId !== r.id);
      scheduleProjectSave(oldLink.project);
    }
    if(newProjectId && (!oldLink || oldLink.project.id !== newProjectId)){
      const newProject = projects.find(p => p.id === newProjectId);
      if(newProject && !newProject.products.some(x => x.recipeId === r.id)){
        newProject.products.push(blankProduct(r.id));
        scheduleProjectSave(newProject);
      }
    }
    renderLinkedProjectSection(r);
    refreshCodeCountryBadge(r);
    updateRecipeTitleDisplay(r);
  });
  updateRecipeTitleDisplay(r);
  const devStatusSelect = document.getElementById('f-devStatus');
  devStatusSelect.value = r.devStatus || 'In Development';
  updateDevStatusSelectColor(devStatusSelect);
  devStatusSelect.addEventListener('change', e => {
    r.devStatus = e.target.value;
    updateDevStatusSelectColor(devStatusSelect);
    scheduleSave();
  });
  renderDescPoints(r);
  renderDescPhotos(r);
  document.getElementById('f-note').value = r.note || '';
  document.getElementById('f-note').addEventListener('input', e => {
    r.note = e.target.value;
    scheduleSave();
  });
  wireRecipeTranslateButton(document.getElementById('f-note').closest('.mu-field-with-translate'));

  document.getElementById('f-name').addEventListener('input', e => {
    r.name = e.target.value;
    updateRecipeTitleDisplay(r);
    scheduleSave();
  });
  document.getElementById('f-codeSuffix')?.addEventListener('input', e => {
    r.code = e.target.value;
    updateRecipeTitleDisplay(r);
    scheduleSave();
  });
  const productTypeSelect = document.getElementById('f-productTypeMain');
  // Every Trial in a Series must share the same country/year/Product Type/
  // Recipe No. (frozen at Series/Trial creation) -- locking the picker for
  // a Series recipe is what actually guarantees that, rather than just
  // hoping nobody changes it.
  if(productTypeSelect && r.seriesId){
    productTypeSelect.disabled = true;
    productTypeSelect.title = 'Product Type is fixed for a Trial in a Recipe Series';
  }
  productTypeSelect?.addEventListener('change', e => {
    if(r.seriesId) return; // defensive -- the select is disabled above, this should never fire
    r.productType = e.target.value;
    refreshCodeProductTypeBadge(r);
    // Picking a Product Type on a brand-new (Series-less) recipe starts its
    // Trial Series right here — see startTrialSeriesForRecipe. From this
    // point on the recipe IS Series-enabled, so the rest of this handler's
    // own recipeSeq/codeRecipeSeqDisplay updates below would just be
    // immediately overwritten by the frozen value anyway; re-rendering the
    // whole editor is what actually reflects the now-locked picker, the new
    // "+ New Trial" button, and the Trial History card.
    if(r.productType){
      startTrialSeriesForRecipe(r);
      scheduleSave();
      renderRecipeEditor(r);
      return;
    }
    // Re-assign the sequence number for the newly-picked type — whatever
    // number belonged to the old type wouldn't mean anything for this one.
    // Not manually editable, so this is the only place it's ever set.
    r.recipeSeq = r.productType ? suggestNextRecipeSeq(recipes, r.productType, r.id) : '';
    document.getElementById('codeRecipeSeqDisplay').textContent = r.recipeSeq || 'NN';
    updateRecipeTitleDisplay(r);
    scheduleSave();
  });
  document.getElementById('descPhotoInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if(!file || r.descPhotos.length >= 3) return;
    r.descPhotos.push(await resizeImageFile(file, 500));
    renderDescPhotos(r);
    scheduleSave();
  });
  document.getElementById('btnAddDescPoint').addEventListener('click', () => {
    r.description.push('');
    renderDescPoints(r);
    scheduleSave();
  });
  document.getElementById('f-date').addEventListener('input', e => {
    r.date = e.target.value;
    document.getElementById('codeYearDisplay').textContent = yearPrefix(r.date);
    updateRecipeTitleDisplay(r);
    scheduleSave();
  });

  document.getElementById('btnScale').addEventListener('click', () => {
    const target = parseFloat(document.getElementById('f-scaleTo').value) || 0;
    const currentTotal = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
    if(target <= 0){ alert('Please enter a target weight greater than 0'); return; }
    if(currentTotal <= 0){ alert('Please enter at least one ingredient weight before scaling the recipe'); return; }
    const factor = target / currentTotal;
    r.parts.forEach(part => scaleIngredientsInPart(part, factor));
    recomputeFromWeights(r);
    renderParts(r);
    scheduleSave();
  });

  // The tree root's own weight (g) — always 100% of the recipe by
  // definition, so there's no % field to edit, just weight. Typing here
  // scales every top-level Part (and everything nested inside it)
  // proportionally, same math as the "Scale Recipe To" button above, just
  // inline where the total is already shown. A no-op with nothing yet
  // weighed in (0g total) since there's no ratio to scale from.
  const treeRootWtInput = document.getElementById('treeRootWt');
  function scaleRecipeTo(targetWeight){
    const currentTotal = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
    if(targetWeight < 0 || currentTotal <= 0) return;
    const factor = targetWeight / currentTotal;
    r.parts.forEach(part => scaleIngredientsInPart(part, factor));
  }
  treeRootWtInput.addEventListener('input', e => {
    const target = parseFloat(e.target.value);
    if(!isNaN(target)) scaleRecipeTo(target);
    refreshDisplays(r);
    scheduleSave();
  });
  treeRootWtInput.addEventListener('blur', () => {
    treeRootWtInput.value = (r.batchWeight || 0).toFixed(2);
  });
  let treeRootWtJustFocused = false;
  treeRootWtInput.addEventListener('mousedown', () => { treeRootWtJustFocused = document.activeElement !== treeRootWtInput; });
  treeRootWtInput.addEventListener('focus', () => treeRootWtInput.select());
  treeRootWtInput.addEventListener('mouseup', e => { if(treeRootWtJustFocused){ e.preventDefault(); treeRootWtJustFocused = false; } });

  // Recipe Overview column sort — clicking a header toggles asc/desc on
  // that column (starting asc when switching to a different one), same
  // interaction as the Projects table's sortable columns. One delegated
  // listener on the header row rather than one per <th> since the row's
  // own HTML gets replaced (via overviewHeaderRowHtml) on every click to
  // redraw the active arrow.
  document.getElementById('overviewHeaderRow').addEventListener('click', e => {
    const key = e.target.closest('[data-sort-key]')?.dataset.sortKey;
    if(!key) return;
    if(overviewSortKey === key){
      overviewSortDir = overviewSortDir === 'asc' ? 'desc' : 'asc';
    }else{
      overviewSortKey = key;
      overviewSortDir = 'asc';
    }
    document.getElementById('overviewHeaderRow').innerHTML = overviewHeaderRowHtml();
    updateGrandTotal(r);
  });

  // Recipe Overview's Cost / Serving stat (see renderOverview) reads this
  // directly off the input rather than a staged variable, same as the
  // weight/% fields elsewhere in this file -- so it only needs refreshing
  // here, not threaded through every place that already re-runs
  // updateGrandTotal for an unrelated reason.
  document.getElementById('f-servingSize').value = r.servingSizeG ?? '';
  document.getElementById('f-servingSize').addEventListener('input', e => {
    r.servingSizeG = e.target.value === '' ? '' : parseFloat(e.target.value) || 0;
    updateGrandTotal(r);
    scheduleSave();
  });

  // Currency picker + its Exchange Rate/Rate Date -- the rate fields
  // only mean anything once a non-THB currency is picked (THB needs no
  // conversion at all), so they stay hidden until then.
  const currencySelect = document.getElementById('f-pricingCurrency');
  const rateFieldWrap = document.getElementById('exchangeRateFieldWrap');
  const rateDateFieldWrap = document.getElementById('exchangeRateDateFieldWrap');
  currencySelect.value = r.pricingCurrency || 'THB';
  const refreshRateFieldsVisibility = () => {
    const show = currencySelect.value !== 'THB';
    rateFieldWrap.style.display = show ? '' : 'none';
    rateDateFieldWrap.style.display = show ? '' : 'none';
  };
  refreshRateFieldsVisibility();
  currencySelect.addEventListener('change', () => {
    r.pricingCurrency = currencySelect.value;
    refreshRateFieldsVisibility();
    updateGrandTotal(r);
    scheduleSave();
  });
  document.getElementById('f-exchangeRate').value = r.exchangeRate ?? '';
  document.getElementById('f-exchangeRate').addEventListener('input', e => {
    r.exchangeRate = e.target.value === '' ? '' : parseFloat(e.target.value) || 0;
    updateGrandTotal(r);
    scheduleSave();
  });
  document.getElementById('f-exchangeRateDate').value = r.exchangeRateDate || '';
  document.getElementById('f-exchangeRateDate').addEventListener('input', e => {
    r.exchangeRateDate = e.target.value;
    scheduleSave();
  });

  // Factory/Company Selling Price margins -- same "read straight off the
  // input, no staged variable" pattern as servingSizeG above.
  [
    ['f-overheadMultiplier', 'overheadMultiplier'],
    ['f-factoryMarginMin', 'factoryMarginMin'], ['f-factoryMarginMax', 'factoryMarginMax'],
    ['f-companyMarginMin', 'companyMarginMin'], ['f-companyMarginMax', 'companyMarginMax'],
    ['f-customerMarginMin', 'customerMarginMin'], ['f-customerMarginMax', 'customerMarginMax']
  ].forEach(([inputId, field]) => {
    const el = document.getElementById(inputId);
    el.value = r[field] ?? '';
    el.addEventListener('input', e => {
      r[field] = e.target.value === '' ? '' : parseFloat(e.target.value) || 0;
      updateGrandTotal(r);
      scheduleSave();
    });
  });
  // Pure visibility toggle -- straight DOM manipulation instead of a full
  // renderRecipeEditor() re-render, so it can't disturb whatever's mid-edit
  // elsewhere on the page (e.g. a focused input losing its cursor position).
  document.getElementById('btnToggleCostingMargin')?.addEventListener('click', () => {
    costingMarginVisible = !costingMarginVisible;
    try { localStorage.setItem(COSTING_MARGIN_VISIBLE_KEY, String(costingMarginVisible)); } catch(e) {}
    const section = document.getElementById('costingMarginSection');
    if(section) section.style.display = costingMarginVisible ? 'contents' : 'none';
    const legend = document.getElementById('costingLegend');
    if(legend) legend.style.display = costingMarginVisible ? '' : 'none';
    const btn = document.getElementById('btnToggleCostingMargin');
    if(btn){
      btn.innerHTML = icon(costingMarginVisible ? 'eye' : 'eye-off');
      btn.title = `${costingMarginVisible ? 'Hide' : 'Show'} Overhead Multiplier, Margins & Selling Price`;
    }
  });

  renderParts(r);
  renderProcesses(r);
  refreshProcessViewMode(r);
  document.getElementById('processViewToggle').addEventListener('click', e => {
    const btn = e.target.closest('.view-mode-btn');
    if(btn) setProcessViewMode(r, btn.dataset.mode);
  });
  document.getElementById('btnAddFlowNode').addEventListener('click', () => addFlowNode(r));
  document.getElementById('flowEdgesSvg').addEventListener('click', e => {
    if(e.target.classList.contains('flow-edge-hit')) deleteFlowEdge(r, e.target.dataset.edgeId);
  });

  document.getElementById('btnAddPart').addEventListener('click', () => {
    r.parts.push(blankPart(`Part ${r.parts.length+1}`));
    renderParts(r);
    renderProcesses(r); // refresh the "Add Component" picker with the new part
    scheduleSave();
  });

  document.getElementById('btnAddProcess').addEventListener('click', () => {
    // Starts with one blank Step already in place, ready to type into --
    // matches the same "never sits completely empty" convention a Part's
    // ingredients already follow, so there's one less click before typing.
    r.processes.push({ id: uid(), title: '', steps: [''], components: [] });
    renderProcesses(r);
    scheduleSave();
  });

  const recipeMoreBtn = document.getElementById('btnRecipeMore');
  const recipeMoreMenu = document.getElementById('recipeMoreMenu');
  recipeMoreBtn?.addEventListener('click', e => {
    e.stopPropagation();
    recipeMoreMenu.classList.toggle('open');
  });
  document.getElementById('btnVersions').addEventListener('click', () => {
    recipeMoreMenu?.classList.remove('open');
    openVersionsModal(r);
  });
  document.getElementById('btnDuplicateAsNewRecipe').addEventListener('click', () => {
    recipeMoreMenu?.classList.remove('open');
    duplicateAsNewRecipe();
  });
  document.getElementById('btnNewTrial')?.addEventListener('click', () => confirmAndCreateNewTrial(r));
  document.getElementById('btnCompareTrials')?.addEventListener('click', () => {
    setCompareSeriesPrefilter({ seriesId: r.seriesId, seriesKey: r.seriesKey });
    setMainFeatureView('compare');
    renderMain();
    renderSidebar();
  });
  if(r.seriesId) renderTrialHistoryTrack(r);
  document.getElementById('btnDelete').addEventListener('click', () => {
    const deletingId = r.id;
    if(!confirm(`Delete "${r.name || 'Untitled recipe'}"? This cannot be undone.`)) return;
    requestAuthConfirm(
      'Confirm Deletion',
      `Enter the approver's email and password to permanently delete the recipe "${r.name || 'Untitled recipe'}"`,
      () => deleteCurrent(),
      {
        requireEmail: DELETE_APPROVER_EMAIL,
        approverAction: () => moveToTrash('recipes', deletingId, r, r.name || 'Untitled recipe')
          .then(() => deleteDoc(doc(approverRecipesCol, deletingId)))
          .then(() => logActivityEvent('deleted', 'recipe', r.name || 'Untitled recipe'))
      }
    );
  });
  document.getElementById('btnPrint').addEventListener('click', () => {
    document.getElementById('recipeMoreMenu')?.classList.remove('open');
    renderPrintView(r);
    // Browsers default the "Save as PDF" filename to document.title, so set
    // it to "Recipe Product Name Recipe Code Forge" just for the print, then
    // restore the real page title afterwards.
    const originalTitle = document.title;
    const code = fullCode(r);
    const namePart = [r.name || 'Untitled recipe', code].filter(Boolean).join(' ');
    document.title = `Recipe ${namePart} Forge`.replace(/[\\/:*?"<>|]/g, '-');
    const restoreTitle = () => {
      document.title = originalTitle;
      window.removeEventListener('afterprint', restoreTitle);
    };
    window.addEventListener('afterprint', restoreTitle);
    window.print();
  });
  document.getElementById('btnExportExcel').addEventListener('click', async event => {
    document.getElementById('recipeMoreMenu')?.classList.remove('open');
    const button = event.currentTarget;
    if(button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await exportRecipeToExcel(r);
    } catch(error) {
      console.error('Recipe Excel export failed', error);
      alert('Could not export the complete Excel preview. Please try again.\n' + error.message);
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });

  // Full-screen on-screen mirror of what Print / PDF would produce --
  // reuses the exact same #printInfoCard/#printIngredientTree/etc.
  // content (renderPrintView already builds it for the real Print button,
  // whether or not that's been clicked yet this session) and the same
  // print-only visibility rules, just toggled by a class instead of an
  // actual @media print, so there's no window.print() dialog involved.
  document.getElementById('btnPreview').addEventListener('click', () => {
    document.getElementById('recipeMoreMenu')?.classList.remove('open');
    renderPrintView(r);
    document.body.classList.add('preview-print-mode');
    window.scrollTo(0, 0);
  });
  document.getElementById('btnClosePrintPreview').addEventListener('click', () => {
    document.body.classList.remove('preview-print-mode');
  });

  renderLockState(r);
  playContentTransition(main);
}

function renderLockState(r){
  const banner = document.getElementById('lockBanner');
  const cards = document.getElementById('recipeCards');
  const isUnlocked = unlockedRecipeId === r.id;

  if(isUnlocked){
    banner.className = 'lock-banner unlocked';
    banner.innerHTML = `${icon('unlock')} This recipe is unlocked for editing <button class="btn btn-sm btn-primary lock-banner-action" id="btnSaveRecipe">${icon('save')} Save</button>`;
    document.getElementById('btnSaveRecipe').addEventListener('click', saveNow);
  }else{
    banner.className = 'lock-banner locked';
    banner.innerHTML = `${icon('lock')} This recipe is read-only <button class="btn btn-sm btn-primary lock-banner-action" id="btnUnlockEdit">${icon('unlock')} Unlock to Edit</button>`;
    document.getElementById('btnUnlockEdit').addEventListener('click', () => {
      requestAuthConfirm(
        'Confirm Identity to Edit',
        `Enter your password to unlock editing for the recipe "${r.name || 'Untitled recipe'}"`,
        () => {
          setUnlockedRecipeId(r.id);
          setRecipeEditSnapshotBefore(snapshotMainFields(r, RECIPE_DIFF_FIELDS));
          renderMain();
        }
      );
    });
    cards.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = true; });
  }
}

// One entry per rendered Part (at ANY depth — top-level or nested inside
// another Part), pushed by renderPartNode as it builds each block. Rebuilt
// from scratch on every full renderParts(r) call. Using per-part closures
// instead of a flat DOM requery-by-index is what makes live-updating an
// arbitrarily deep tree tractable: each Part already knows exactly which
// DOM nodes are its own (not a descendant Sub-part's), no re-matching needed.
let partDisplayUpdaters = [];

function refreshDisplays(r){
  const totalWeight = recomputeFromWeights(r);
  const batchEl = document.getElementById('batchTotalDisplay');
  if(batchEl) batchEl.textContent = formatWeight(totalWeight);

  partDisplayUpdaters.forEach(fn => fn());

  updateGrandTotal(r);
  updateTreeRoot(r);
}

// The ingredient form IS the tree now (see renderParts/renderRows below) —
// every Part is a branch under this root and every ingredient a leaf under
// its Part, so the only thing the root itself still needs refreshed on
// every edit is its own weight (it's always 100% of itself by definition).
function updateTreeRoot(r){
  const wtEl = document.getElementById('treeRootWt');
  if(wtEl && document.activeElement !== wtEl) wtEl.value = (r.batchWeight || 0).toFixed(2);
}

// Remembers which Parts the user has explicitly expanded/collapsed by
// clicking their toggle arrow, keyed by the Part object itself (stable
// across a renderParts() re-render since drag-and-drop reordering moves
// the same object references around rather than recreating them, and
// resets naturally when a different recipe loads a fresh r.parts tree).
// Without this, every renderParts() call -- including the one that runs
// right after a drag-and-drop reorder -- recomputed each Part's collapsed
// state from scratch (see renderPartNode's setCollapsed(!hasContent) call
// below) and silently re-expanded anything the user had manually
// collapsed.
const manualPartCollapseState = new WeakMap();

function renderParts(r){
  recomputeFromWeights(r);

  const batchEl = document.getElementById('batchTotalDisplay');
  if(batchEl) batchEl.textContent = formatWeight(r.batchWeight);

  partDisplayUpdaters = [];
  const container = document.getElementById('partsContainer');
  container.innerHTML = '';
  if(r.parts.length === 0){
    container.innerHTML = '<div class="overview-empty">No parts yet — click "+ Add Part" below to add the first one</div>';
  }
  r.parts.forEach(part => {
    renderPartNode(r, part, container, { ingredients: null, parts: r.parts });
  });

  updateGrandTotal(r);
  updateTreeRoot(r);
}

// Renders one Part — and, recursively, every Sub-part nested inside it — as
// a branch of the tree. The exact same function handles a top-level Part
// (siblingsCtx = { ingredients: null, parts: r.parts }, since the recipe
// root holds no ingredients of its own) and a Sub-part nested inside
// another Part (siblingsCtx = { ingredients: parentPart.ingredients, parts:
// parentPart.parts }) — the %/weight math only cares about "everything
// else at my own level", not whether that level happens to be the recipe
// root or another Part.
// `getAncestorMultiplier` is a 0-arg function, not a plain number -- every
// ancestor Part's own Yield can change independently AFTER this row is
// first rendered (any edit anywhere just re-runs partDisplayUpdaters, see
// refreshDisplays), so each level composes a NEW closure over its parent's
// getter and this Part's own `prepYieldPct`, read live on every call,
// rather than a number baked in once at initial render that could go
// stale. Defaults to "no ancestors" (1) for a top-level Part.
function renderPartNode(r, part, container, siblingsCtx, getAncestorMultiplier = () => 1){
  const isNested = siblingsCtx.ingredients !== null;
  // This Part's OWN multiplier -- its ancestors' combined Yield effect
  // AND its own Yield -- is what a ROW belonging to THIS Part (its direct
  // ingredients) needs; a row belonging to this Part ITSELF (its own
  // Prepare display) needs just `getAncestorMultiplier()`, since
  // partPrepareWeight(part) already folds in this Part's own Yield.
  const getOwnMultiplier = () => computePrepareWeight(getAncestorMultiplier(), part.prepYieldPct);

  // A nested Sub-part's header uses the exact same column wrappers
  // (.row-handle-col/.row-value-col) as an ingredient row so the two line
  // up as one table — see the shared CSS above renderParts. A top-level
  // Part has no sibling ingredient row to line up with (the recipe root
  // only ever holds Parts), so it keeps its original, wider "section
  // header" layout (verbose "% of recipe" label, fields grouped and
  // right-aligned via margin-left:auto) unchanged.
  const headerInnerHtml = isNested ? `
      <div class="row-handle-col">
        <span class="drag-handle" draggable="true" title="Drag onto another Part's title to move this Part (and everything inside it) there">${icon('grip-vertical', 14)}</span>
        <button type="button" class="part-toggle-btn" title="Expand / collapse this part">${icon('chevron-right')}</button>
      </div>
      <input type="text" class="part-name" placeholder="Part name">
      <span class="part-ing-count"></span>
      <div class="part-yield-chip" title="This Part's own Yield % — an additional prep loss/gain for everything inside it, on top of any of its ingredients' own">
        <span class="part-yield-chip-label">Yield</span>
        <input type="number" class="part-yield-input ing-yield num-input" step="0.01" min="0.01" max="999.99" placeholder="100">
        <span class="ing-unit">%</span>
      </div>
      <div class="row-value-col row-value-prepare" title="This Part's own Prepare (gross) weight = the Prepare weight of everything inside it ÷ (this Part's own Yield ÷ 100) — calculated automatically, not editable directly">
        <span class="row-value-prepare-label">Prepare WT.</span>
        <span class="part-prepare-display ing-prepare-display"></span>
      </div>
      <div class="row-value-col row-value-wt">
        <span class="row-value-wt-label">Formula WT.</span>
        <div class="row-value-inline">
          <input type="number" class="part-wt-display num-input" step="0.01" min="0">
          <span class="ing-unit">g</span>
        </div>
      </div>
      <div class="row-value-col row-value-pct">
        <span class="row-value-pct-label">% of Recipe</span>
        <div class="row-value-inline">
          <input type="number" class="part-pct-display num-input" step="0.01" min="0" max="100" title="Type a % or a weight (g) — scales everything inside this Part proportionally">
          <span class="ing-unit">%</span>
        </div>
      </div>
      <button class="icon-btn" title="Delete this part">${icon('x')}</button>
    ` : `
      <span class="drag-handle" draggable="true" title="Drag onto another Part's title to move this Part (and everything inside it) there">${icon('grip-vertical', 14)}</span>
      <button type="button" class="part-toggle-btn" title="Expand / collapse this part">${icon('chevron-right')}</button>
      <input type="text" class="part-name" placeholder="Part name">
      <span class="part-ing-count"></span>
      <div class="part-yield-chip" title="This Part's own Yield % — an additional prep loss/gain for everything inside it, on top of any of its ingredients' own">
        <span class="part-yield-chip-label">Yield</span>
        <input type="number" class="part-yield-input ing-yield num-input" step="0.01" min="0.01" max="999.99" placeholder="100">
        <span class="ing-unit">%</span>
      </div>
      <div class="row-value-col row-value-prepare" title="This Part's own Prepare (gross) weight = the Prepare weight of everything inside it ÷ (this Part's own Yield ÷ 100) — calculated automatically, not editable directly">
        <span class="row-value-prepare-label">Prepare WT.</span>
        <span class="part-prepare-display ing-prepare-display"></span>
      </div>
      <div class="row-value-col row-value-wt">
        <span class="row-value-wt-label">Formula WT.</span>
        <div class="row-value-inline">
          <input type="number" class="part-wt-display num-input" step="0.01" min="0">
          <span class="ing-unit">g</span>
        </div>
      </div>
      <div class="row-value-col row-value-pct">
        <span class="row-value-pct-label">% of Recipe</span>
        <div class="row-value-inline">
          <input type="number" class="part-pct-display num-input" step="0.01" min="0" max="100" title="Type a % or a weight (g) — scales everything inside this Part proportionally">
          <span class="ing-unit">%</span>
        </div>
      </div>
      <button class="icon-btn" title="Delete this part">${icon('x')}</button>
    `;

  const block = document.createElement('div');
  block.className = 'part-block tree-branch' + (isNested ? ' sub-part-row' : '');
  block.innerHTML = `
    <div class="part-header">${headerInnerHtml}</div>
    <div class="part-body">
      <div class="ing-rows tree-children"></div>
      <div class="sub-parts tree-children"></div>
      <div class="part-body-actions">
        <button class="btn btn-sm add-row-btn" data-role="add-ing"></button>
        <button class="btn btn-sm add-row-btn" data-role="add-subpart"></button>
      </div>
    </div>
  `;

  const nameField = block.querySelector('.part-name');
  const addIngBtn = block.querySelector('[data-role="add-ing"]');
  const addSubpartBtn = block.querySelector('[data-role="add-subpart"]');
  const headerEl = block.querySelector('.part-header');
  const dragHandle = headerEl.querySelector('.drag-handle');

  // Drag SOURCE: picking this Part up. dataTransfer.setData is required for
  // some browsers (Firefox) to allow the drop at all, even though the
  // actual payload travels via the module-level `dragPayload` — a real
  // DataTransfer can't hold live object references, only serializable data.
  dragHandle.addEventListener('dragstart', e => {
    dragPayload = { type: 'part', item: part, sourceArray: siblingsCtx.parts };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'part');
    block.classList.add('dragging');
  });
  dragHandle.addEventListener('dragend', () => {
    block.classList.remove('dragging');
    dragPayload = null;
  });

  // Drop TARGET: this Part's title bar. Dragging an ingredient here always
  // just adds it to this Part's own list (no "before/after" — an
  // ingredient can't be positioned relative to a Part, they're different
  // lists). Dragging a Part is split into three vertical zones so both
  // "move up/down" and "nest inside" are reachable from the same target:
  // the top slice inserts the dragged Part as a sibling BEFORE this one,
  // the bottom slice AFTER, and the middle nests it inside as a Sub-part
  // (the original behavior).
  function partDropZone(e){
    const rect = headerEl.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / rect.height;
    if(relY < 0.3) return 'before';
    if(relY > 0.7) return 'after';
    return 'into';
  }

  headerEl.addEventListener('dragover', e => {
    if(!dragPayload) return;
    // Dropping a Part onto ITSELF or onto one of ITS OWN descendants would
    // nest it inside itself — check whether the drop TARGET (this `part`)
    // is the dragged Part or reachable by descending from it, not the
    // other way around. Applies to all three zones alike: inserting
    // draggedPart as a sibling of one of its own descendants is exactly as
    // cyclic as nesting it inside one directly.
    if(dragPayload.type === 'part' && isPartOrDescendant(part, dragPayload.item)) return;
    if(dragPayload.type === 'ingredient' && dragPayload.sourcePart === part) return; // already here
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    headerEl.classList.remove('drop-target', 'drop-before', 'drop-after');
    if(dragPayload.type === 'part'){
      const zone = partDropZone(e);
      headerEl.classList.add(zone === 'before' ? 'drop-before' : zone === 'after' ? 'drop-after' : 'drop-target');
    } else {
      headerEl.classList.add('drop-target');
    }
  });
  headerEl.addEventListener('dragleave', () => {
    headerEl.classList.remove('drop-target', 'drop-before', 'drop-after');
  });
  headerEl.addEventListener('drop', e => {
    e.preventDefault();
    const zone = (dragPayload && dragPayload.type === 'part') ? partDropZone(e) : 'into';
    headerEl.classList.remove('drop-target', 'drop-before', 'drop-after');
    if(!dragPayload) return;
    if(dragPayload.type === 'part'){
      const draggedPart = dragPayload.item;
      if(isPartOrDescendant(part, draggedPart)){ dragPayload = null; return; }
      const idx = dragPayload.sourceArray.indexOf(draggedPart);
      if(idx === -1){ dragPayload = null; return; }
      dragPayload.sourceArray.splice(idx, 1);
      if(zone === 'into'){
        part.parts.push(draggedPart);
      } else {
        // Insert as a sibling of `part` within its own containing array —
        // re-found by reference AFTER the removal above, since if
        // draggedPart came from this very array, `part`'s own index may
        // have shifted down by one.
        let targetIdx = siblingsCtx.parts.indexOf(part);
        if(zone === 'after') targetIdx += 1;
        siblingsCtx.parts.splice(targetIdx, 0, draggedPart);
      }
    } else if(dragPayload.type === 'ingredient'){
      const draggedIng = dragPayload.item;
      const sourcePart = dragPayload.sourcePart;
      if(sourcePart === part){ dragPayload = null; return; }
      const idx = sourcePart.ingredients.indexOf(draggedIng);
      if(idx === -1){ dragPayload = null; return; }
      sourcePart.ingredients.splice(idx, 1);
      // Same safety net as deleting the last ingredient by hand — a Part
      // never sits completely empty, always at least one blank row to type
      // into, unless it still has Sub-parts of its own.
      if(sourcePart.ingredients.length === 0 && sourcePart.parts.length === 0){
        sourcePart.ingredients.push({ id: uid(), name:'', percent:0, weight:0, note:'' });
      }
      part.ingredients.push(draggedIng);
    }
    dragPayload = null;
    renderParts(r);
    renderProcesses(r); // the moved ingredient/Part changes which Part it's grouped under in the "Add Component" picker
    scheduleSave();
  });

  function partLabel(){
    return (part.name || '').trim() || 'this part';
  }
  function updatePartLabels(){
    addIngBtn.textContent = `+ Add Ingredient (${partLabel()})`;
    addSubpartBtn.textContent = `+ Add Sub-part (${partLabel()})`;
  }
  updatePartLabels();

  nameField.value = part.name || '';
  nameField.addEventListener('input', e => { part.name = e.target.value; updatePartLabels(); renderProcesses(r); scheduleSave(); });

  const body = block.querySelector('.ing-rows');
  const subPartsContainer = block.querySelector('.sub-parts');
  const countEl = block.querySelector('.part-ing-count');
  const partPctInput = block.querySelector('.part-pct-display');
  const partWtInput = block.querySelector('.part-wt-display');
  const partYieldInput = block.querySelector('.part-yield-input');
  const partPrepareDisplay = block.querySelector('.part-prepare-display');
  const toggleBtn = block.querySelector('.part-toggle-btn');

  // Scales everything currently inside this Part — its own ingredients AND
  // every ingredient nested inside its Sub-parts — by the same factor, so
  // weights change but every ratio between them (at every depth) doesn't.
  // Silently a no-op when there's nothing to scale from (empty, or
  // everything inside is still 0g): with no known ratio, there's no
  // defensible way to distribute a new total.
  function scalePartTo(targetWeight){
    const currentWeight = partTotalWeight(part);
    if(targetWeight < 0 || currentWeight <= 0) return;
    const factor = targetWeight / currentWeight;
    scaleIngredientsInPart(part, factor);
  }

  partWtInput.addEventListener('input', e => {
    const target = parseFloat(e.target.value);
    if(!isNaN(target)) scalePartTo(target);
    refreshDisplays(r);
    scheduleSave();
  });
  partWtInput.addEventListener('blur', () => {
    partWtInput.value = partTotalWeight(part).toFixed(2);
  });
  let partWtJustFocused = false;
  partWtInput.addEventListener('mousedown', () => { partWtJustFocused = document.activeElement !== partWtInput; });
  partWtInput.addEventListener('focus', () => partWtInput.select());
  partWtInput.addEventListener('mouseup', e => { if(partWtJustFocused){ e.preventDefault(); partWtJustFocused = false; } });

  // Same back-solve as an ingredient's own % field (see ing-edit-row
  // below), just at whatever level this Part itself lives at: holds every
  // OTHER sibling (ingredient or Part) at this same level fixed, solves for
  // this Part's total, then scales everything inside it to hit it.
  partPctInput.addEventListener('input', e => {
    const targetPct = parseFloat(e.target.value);
    if(isNaN(targetPct) || targetPct < 0) return;
    const othersWeight = siblingsWeightExcluding(siblingsCtx, part);
    const f = targetPct / 100;
    if(othersWeight > 0 && f < 1){
      scalePartTo(f * othersWeight / (1 - f));
    }
    refreshDisplays(r);
    scheduleSave();
  });
  partPctInput.addEventListener('blur', () => {
    partPctInput.value = (part.percent || 0).toFixed(2);
  });
  let partPctJustFocused = false;
  partPctInput.addEventListener('mousedown', () => { partPctJustFocused = document.activeElement !== partPctInput; });
  partPctInput.addEventListener('focus', () => partPctInput.select());
  partPctInput.addEventListener('mouseup', e => { if(partPctJustFocused){ e.preventDefault(); partPctJustFocused = false; } });

  // This Part's own Yield -- an independent prep loss/gain for everything
  // inside it, on top of any of its ingredients' own. refreshDisplays(r)
  // re-runs every registered partDisplayUpdaters entry (see below), which
  // is what makes every ancestor Part's Prepare display -- not just this
  // one's own -- correctly recompute, since partPrepareWeight always
  // recomputes bottom-up from live model state.
  partYieldInput.addEventListener('input', e => {
    const v = e.target.value;
    part.prepYieldPct = v === '' ? null : (parseFloat(v) || null);
    refreshDisplays(r);
    scheduleSave();
  });

  function setCollapsed(collapsed){
    block.classList.toggle('collapsed', collapsed);
    toggleBtn.classList.toggle('open', !collapsed);
    toggleBtn.innerHTML = icon(collapsed ? 'chevron-right' : 'chevron-down');
  }

  toggleBtn.addEventListener('click', () => {
    const next = !block.classList.contains('collapsed');
    setCollapsed(next);
    manualPartCollapseState.set(part, next);
  });

  const hasContent = part.ingredients.some(i => (i.name || '').trim() !== '') || part.parts.length > 0;
  setCollapsed(manualPartCollapseState.has(part) ? manualPartCollapseState.get(part) : !hasContent);

  function renderRows(){
    body.innerHTML = '';
    part.ingredients.forEach((ing, idx) => {
      const branch = document.createElement('div');
      branch.className = 'tree-branch';
      branch.innerHTML = `
        <div class="tree-node tree-ing-node ing-edit-row">
          <div class="row-handle-col">
            <span class="drag-handle" draggable="true" title="Drag onto a Part's title to move this ingredient there">${icon('grip-vertical', 14)}</span>
          </div>
          <div class="ing-name-wrap">
            <input type="text" class="ing-name" placeholder="Search the library or type a new ingredient name" autocomplete="off">
            <div class="ing-suggestions"></div>
          </div>
          <input type="text" class="ing-note" placeholder="Note">
          <div class="row-value-col row-value-prepare" title="Prepare (gross) weight = Formula weight ÷ (this ingredient's own Yield, from the Ingredient Library, ÷ 100) ÷ (every ancestor Part's own Yield ÷ 100) — calculated automatically, not editable per ingredient">
            <span class="ing-prepare-display"></span>
          </div>
          <div class="row-value-col row-value-wt">
            <input type="number" class="ing-wt num-input" step="0.01" min="0">
            <span class="ing-unit">g</span>
          </div>
          <div class="row-value-col">
            <input type="number" class="ing-pct-display num-input" step="0.01" min="0" max="100" title="Type a % or a weight (g) — the other one is calculated automatically">
            <span class="ing-unit">%</span>
          </div>
          <button class="icon-btn" title="Delete">${icon('x')}</button>
          <div class="ing-flow-link-wrap">
            <span class="ing-flow-link-arrow">→</span>
            <select class="ing-flow-link" title="Link this ingredient to a Process Flowchart node"></select>
          </div>
        </div>
        <div class="ing-hint"></div>
        <div class="ing-subs"></div>
      `;
      const ingDragHandle = branch.querySelector('.drag-handle');
      const nameInput = branch.querySelector('.ing-name');
      const suggestBox = branch.querySelector('.ing-suggestions');
      const hintEl = branch.querySelector('.ing-hint');
      const subsEl = branch.querySelector('.ing-subs');
      const pctDisplay = branch.querySelector('.ing-pct-display');
      const wtInput = branch.querySelector('.ing-wt');
      const noteInput = branch.querySelector('.ing-note');
      const delBtn = branch.querySelector('.icon-btn');
      const prepareDisplay = branch.querySelector('.ing-prepare-display');

      // Optional link to a Process Flowchart node (see the Process
      // Flowchart section) — e.g. "this ingredient goes into step B".
      // Hidden entirely (not just left blank) until the recipe actually
      // has at least one flowchart node, so recipes that never touch that
      // feature see zero visual change to this row.
      const flowLinkWrap = branch.querySelector('.ing-flow-link-wrap');
      const flowLinkSelect = branch.querySelector('.ing-flow-link');
      const flowNodes = (r.processFlowchart && r.processFlowchart.nodes) || [];
      flowLinkWrap.classList.toggle('hidden-if-empty', flowNodes.length === 0);
      flowLinkSelect.innerHTML = `<option value="">—</option>` +
        flowNodes.map(n => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.label || '?')}</option>`).join('');
      flowLinkSelect.value = ing.flowNodeId || '';
      flowLinkSelect.addEventListener('change', e => {
        ing.flowNodeId = e.target.value || null;
        scheduleSave();
      });

      ingDragHandle.addEventListener('dragstart', e => {
        dragPayload = { type: 'ingredient', item: ing, sourcePart: part };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'ingredient');
        branch.classList.add('dragging');
      });
      ingDragHandle.addEventListener('dragend', () => {
        branch.classList.remove('dragging');
        dragPayload = null;
      });

      // Drop TARGET: an ingredient row only ever means "reorder relative
      // to this one" — top half of the row inserts the dragged ingredient
      // just before it, bottom half just after. Works the same whether the
      // dragged ingredient started in this same Part (a plain reorder) or
      // a different one (moves it here, landing at this exact position,
      // rather than always at the end the way dropping on a Part's title
      // does).
      const rowEl = branch.querySelector('.ing-edit-row');
      rowEl.addEventListener('dragover', e => {
        if(!dragPayload || dragPayload.type !== 'ingredient' || dragPayload.item === ing) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = rowEl.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        rowEl.classList.toggle('drop-before', before);
        rowEl.classList.toggle('drop-after', !before);
      });
      rowEl.addEventListener('dragleave', () => {
        rowEl.classList.remove('drop-before', 'drop-after');
      });
      rowEl.addEventListener('drop', e => {
        e.preventDefault();
        const rect = rowEl.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        rowEl.classList.remove('drop-before', 'drop-after');
        if(!dragPayload || dragPayload.type !== 'ingredient') return;
        const draggedIng = dragPayload.item;
        if(draggedIng === ing){ dragPayload = null; return; }
        const sourcePart = dragPayload.sourcePart;
        const sourceIdx = sourcePart.ingredients.indexOf(draggedIng);
        if(sourceIdx === -1){ dragPayload = null; return; }
        sourcePart.ingredients.splice(sourceIdx, 1);
        if(sourcePart.ingredients.length === 0 && sourcePart.parts.length === 0){
          sourcePart.ingredients.push({ id: uid(), name:'', percent:0, weight:0, note:'' });
        }
        // Re-found by reference AFTER the removal above, since if the
        // dragged ingredient came from this same Part, this row's own
        // index may have shifted down by one.
        let targetIdx = part.ingredients.indexOf(ing);
        if(!before) targetIdx += 1;
        part.ingredients.splice(targetIdx, 0, draggedIng);
        dragPayload = null;
        renderParts(r);
        renderProcesses(r);
        scheduleSave();
      });

      nameInput.value = ing.name || '';
      pctDisplay.value = (ing.percent||0).toFixed(2);
      wtInput.value = (parseFloat(ing.weight) || 0).toFixed(2);
      noteInput.value = ing.note || '';

      // Prepare (gross) weight = Formula weight ÷ (this ingredient's own
      // Yield ÷ 100) ÷ (every ancestor Part's own Yield ÷ 100) --
      // computePrepareWeight (app.js) already falls back to treating an
      // empty/invalid/non-positive yield as 100%, so this never shows
      // NaN/Infinity. Highlighted only when the effective yield is
      // actually under 100% (i.e. there's real prep loss to flag) -- a
      // >100% yield (rehydration) is a real, supported case but isn't
      // "loss", so it prints in the normal neutral color. There's no
      // manual input for an ingredient's own Yield -- it only ever comes
      // from picking a Sub Ingredient variant in the Ingredient Library
      // (see renderIngSubsToggle below); everything else defaults to 100%.
      function updatePrepareDisplay(){
        // Includes every ancestor Part's own Yield too (getOwnMultiplier),
        // not just this ingredient's own -- so this figure always matches
        // what Recipe Overview/Print/Version Preview already show for the
        // same ingredient.
        const prepareWt = computePrepareWeight(ing.weight, ing.prepYieldPct) * getOwnMultiplier();
        prepareDisplay.textContent = formatWeight(prepareWt);
        const y = parseFloat(ing.prepYieldPct);
        const isLossy = isFinite(y) && y > 0 && y < 100;
        prepareDisplay.parentElement.classList.toggle('row-value-prepare-highlight', isLossy);
      }
      updatePrepareDisplay();

      function syncMaterialLink(){
        const matched = findMaterialByLabel(nameInput.value);
        ing.materialId = matched ? matched.id : null;
        wtInput.disabled = !matched;
        pctDisplay.disabled = !matched;
        nameInput.classList.remove('ing-linked', 'invalid');
        if(matched){
          nameInput.classList.add('ing-linked');
          nameInput.title = materialTooltip(matched);
          hintEl.textContent = matched.vendorCode ? `Code: ${matched.vendorCode}` : '';
          hintEl.className = 'ing-hint ing-hint-code';
        }else{
          nameInput.title = '';
          if(nameInput.value.trim()){
            nameInput.classList.add('invalid');
            hintEl.textContent = 'This ingredient is not in the library — open "Ingredient Library" above to add it before entering a weight';
            hintEl.className = 'ing-hint hint-block';
          }else{
            hintEl.textContent = 'Select an ingredient from the library first before entering a weight';
            hintEl.className = 'ing-hint';
          }
        }
        renderIngSubsToggle(subsEl, ing, matched, noteInput, () => {
          updatePrepareDisplay();
          refreshDisplays(r);
        });
      }
      syncMaterialLink();

      // Custom fuzzy-search dropdown — replaces the old native <datalist>,
      // which only ever did a plain substring match and looked/behaved
      // differently across browsers. Ranked matches (see
      // fuzzyMaterialMatches) so close/similar names surface even with a
      // typo or a partial word, not just an exact substring.
      function renderSuggestions(){
        if(document.activeElement !== nameInput){
          suggestBox.innerHTML = '';
          suggestBox.classList.remove('open');
          return;
        }
        const matches = fuzzyMaterialMatches(nameInput.value, 8);
        if(matches.length === 0){
          suggestBox.innerHTML = '';
          suggestBox.classList.remove('open');
          return;
        }
        suggestBox.innerHTML = matches.map(m => `
          <div class="ing-suggestion-item" data-id="${escapeHtml(m.id)}">
            <span class="ing-suggestion-name">${escapeHtml(materialLabel(m))}</span>
            ${m.brand ? `<span class="ing-suggestion-brand">${escapeHtml(m.brand)}</span>` : ''}
          </div>
        `).join('');
        suggestBox.classList.add('open');
        suggestBox.querySelectorAll('.ing-suggestion-item').forEach(item => {
          // mousedown (not click) fires before the input's blur, so the
          // selection registers before renderSuggestions()'s own blur
          // handler would otherwise have already wiped the list out.
          item.addEventListener('mousedown', e => {
            e.preventDefault();
            const matched = ingredientMaster.find(x => x.id === item.dataset.id);
            if(matched){
              nameInput.value = materialLabel(matched);
              nameInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            suggestBox.innerHTML = '';
            suggestBox.classList.remove('open');
          });
        });
      }

      nameInput.addEventListener('input', e => {
        ing.name = e.target.value;
        syncMaterialLink();
        refreshDisplays(r);
        renderProcesses(r); // keep the "Add Component" picker's ingredient list current
        scheduleSave();
        renderSuggestions();
      });
      nameInput.addEventListener('focus', renderSuggestions);
      nameInput.addEventListener('blur', () => {
        suggestBox.innerHTML = '';
        suggestBox.classList.remove('open');
      });
      noteInput.addEventListener('input', e => { ing.note = e.target.value; scheduleSave(); });

      wtInput.addEventListener('input', e => {
        ing.weight = parseFloat(e.target.value) || 0;
        refreshDisplays(r);
        scheduleSave();
      });
      wtInput.addEventListener('blur', () => {
        wtInput.value = (parseFloat(ing.weight) || 0).toFixed(2);
      });
      // Select the whole number on focus so a click lets you type a new
      // value straight away — Chrome otherwise collapses the selection on
      // mouseup, so the first click's mouseup is suppressed once to let it stick.
      let wtJustFocused = false;
      wtInput.addEventListener('mousedown', () => { wtJustFocused = document.activeElement !== wtInput; });
      wtInput.addEventListener('focus', () => wtInput.select());
      wtInput.addEventListener('mouseup', e => {
        if(wtJustFocused){ e.preventDefault(); wtJustFocused = false; }
      });

      // Typing a % back-solves this ingredient's weight, holding every
      // other ingredient AND every Sub-part in the Part fixed: pct = w /
      // (w + others), so w = pct * others / (1 - pct). others === 0 (the
      // only thing in the Part) has no solution — it's already 100% at any
      // weight — so that case is left alone and just snaps back on blur.
      pctDisplay.addEventListener('input', e => {
        const targetPct = parseFloat(e.target.value);
        if(isNaN(targetPct) || targetPct < 0) return;
        const othersIngWeight = part.ingredients.reduce((s,i,i2) => i2 === idx ? s : s+(parseFloat(i.weight)||0), 0);
        const othersSubPartsWeight = (part.parts||[]).reduce((s,sub)=>s+partTotalWeight(sub),0);
        const othersWeight = othersIngWeight + othersSubPartsWeight;
        const f = targetPct / 100;
        if(othersWeight > 0 && f < 1){
          ing.weight = round2(f * othersWeight / (1 - f));
          wtInput.value = (parseFloat(ing.weight) || 0).toFixed(2);
        }
        refreshDisplays(r);
        scheduleSave();
      });
      pctDisplay.addEventListener('blur', () => {
        pctDisplay.value = (ing.percent || 0).toFixed(2);
      });
      let pctJustFocused = false;
      pctDisplay.addEventListener('mousedown', () => { pctJustFocused = document.activeElement !== pctDisplay; });
      pctDisplay.addEventListener('focus', () => pctDisplay.select());
      pctDisplay.addEventListener('mouseup', e => {
        if(pctJustFocused){ e.preventDefault(); pctJustFocused = false; }
      });

      delBtn.addEventListener('click', () => {
        part.ingredients.splice(idx, 1);
        if(part.ingredients.length === 0 && part.parts.length === 0) part.ingredients.push({ id: uid(), name:'', percent:0, weight:0, note:'' });
        renderRows();
        refreshDisplays(r);
        renderProcesses(r); // drop the deleted ingredient from the "Add Component" picker
        scheduleSave();
      });

      body.appendChild(branch);
    });
    updatePartSubtotal();
  }

  function updatePartSubtotal(){
    const namedCount = part.ingredients.filter(i => (i.name||'').trim() !== '').length;
    const subCount = part.parts.length;
    const label = [];
    if(namedCount) label.push(`${namedCount} ingredient${namedCount === 1 ? '' : 's'}`);
    if(subCount) label.push(`${subCount} sub-part${subCount === 1 ? '' : 's'}`);
    countEl.textContent = label.length ? label.join(' · ') : 'Empty';
    if(document.activeElement !== partPctInput) partPctInput.value = (part.percent || 0).toFixed(2);
    if(document.activeElement !== partWtInput) partWtInput.value = partTotalWeight(part).toFixed(2);
    if(document.activeElement !== partYieldInput) partYieldInput.value = part.prepYieldPct != null ? part.prepYieldPct : '';
    const py = parseFloat(part.prepYieldPct);
    const isLossy = isFinite(py) && py > 0 && py < 100;
    partPrepareDisplay.textContent = formatWeight(partPrepareWeight(part) * getAncestorMultiplier());
    // Toggled on the display span itself (not a .row-value-prepare
    // wrapper) since the top-level Part header has no such wrapper --
    // .part-prepare-display.row-value-prepare-highlight covers both header
    // variants with one rule (see style.css).
    partPrepareDisplay.classList.toggle('row-value-prepare-highlight', isLossy);
    const valid = isValidYieldPct(partYieldInput.value);
    partYieldInput.classList.toggle('invalid', !valid);
    partYieldInput.title = valid ? '' : 'Yield must be between 0.01% and 999.99%';
  }

  renderRows();

  function renderSubParts(){
    subPartsContainer.innerHTML = '';
    part.parts.forEach(sub => renderPartNode(r, sub, subPartsContainer, { ingredients: part.ingredients, parts: part.parts }, getOwnMultiplier));
  }
  renderSubParts();

  addIngBtn.addEventListener('click', () => {
    if(hasUnresolvedIngredient(part)){
      alert('This part has an ingredient that is not yet in the library. Please select from the library or add it first before adding the next row.');
      return;
    }
    part.ingredients.push({ id: uid(), name:'', percent:0, weight:0, note:'' });
    renderRows();
    refreshDisplays(r);
    scheduleSave();
  });

  addSubpartBtn.addEventListener('click', () => {
    part.parts.push(blankPart(''));
    renderParts(r);
    renderProcesses(r); // add the new sub-part's ingredients to the "Add Component" picker
    scheduleSave();
  });

  const deletePartBtn = block.querySelector('.part-header .icon-btn');
  if(!isNested && siblingsCtx.parts.length <= 1){
    // A recipe always needs at least one top-level Part to hold anything —
    // Sub-parts nested inside a Part have no such floor, since that Part
    // can always fall back to its own direct ingredients instead.
    deletePartBtn.style.display = 'none';
  } else {
    deletePartBtn.addEventListener('click', () => {
      if(!confirm(`Delete "${part.name || 'this part'}" and everything inside it?`)) return;
      const idx = siblingsCtx.parts.indexOf(part);
      if(idx !== -1) siblingsCtx.parts.splice(idx, 1);
      renderParts(r);
      renderProcesses(r); // drop the deleted part's ingredients from the "Add Component" picker
      scheduleSave();
    });
  }

  partDisplayUpdaters.push(() => {
    updatePartSubtotal();
    const pctEls = body.querySelectorAll('.ing-pct-display');
    const wtEls = body.querySelectorAll('.ing-wt');
    const prepareEls = body.querySelectorAll('.ing-prepare-display');
    part.ingredients.forEach((ing, idx) => {
      // Skip the field the user is actively typing into — reformatting it
      // mid-keystroke (e.g. "30" -> "30.00" before they can type "30.5")
      // would fight with their typing. It gets its own precise value on
      // blur instead (see the pctDisplay/wtInput 'blur' handlers above).
      // Weight also needs refreshing here (not just %): scaling this Part
      // from its own header field, or a sibling ingredient's own % field,
      // changes every ingredient's weight without ever touching its own
      // <input> directly, so nothing else would ever push that new value in.
      const pctEl = pctEls[idx];
      if(pctEl && document.activeElement !== pctEl) pctEl.value = (ing.percent||0).toFixed(2);
      const wtEl = wtEls[idx];
      if(wtEl && document.activeElement !== wtEl) wtEl.value = (parseFloat(ing.weight)||0).toFixed(2);
      // Prepare weight only ever depends on THIS ingredient's own weight/
      // yield, never on siblings — but Scale Recipe (partWtInput above)
      // changes every ingredient's .weight without touching its <input>
      // directly, same reason wtEl needs refreshing here too.
      const prepareEl = prepareEls[idx];
      if(prepareEl) prepareEl.textContent = formatWeight(computePrepareWeight(ing.weight, ing.prepYieldPct) * getOwnMultiplier());
    });
  });

  container.appendChild(block);
}

function updateGrandTotal(r){
  const allIngredients = allIngredientsInRecipe(r);
  const totalWt = allIngredients.reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
  // % is always weight / totalWeight, so the grand total is exactly 100% by
  // construction whenever there's any weight entered — no rounding drift.
  const totalPct = totalWt > 0 ? 100 : 0;
  const pctEl = document.getElementById('grandTotalPct');
  const wtEl = document.getElementById('grandTotalWt');
  pctEl.textContent = totalPct.toFixed(2) + '%';
  pctEl.className = 'col-pct totals-ok';
  wtEl.textContent = formatWeight(totalWt);

  // Each ingredient instance's own fully-compounded Prepare weight (its own
  // Yield times every ancestor Part's own Yield) -- keyed by object
  // reference since the same name+note key in renderOverview's grouping can
  // now legitimately map to instances living under different Parts with
  // different compounding.
  const prepareWeightByIng = new Map();
  (r.parts || []).forEach(part => collectIngredientsWithPrepareWeight(part).forEach(({ ing, prepareWt }) => prepareWeightByIng.set(ing, prepareWt)));

  renderOverview(allIngredients, prepareWeightByIng);
}

function renderOverview(allIngredients, prepareWeightByIng){
  const body = document.getElementById('overviewBody');
  if(!body) return;
  body.innerHTML = '';

  const costEl = document.getElementById('grandTotalCost');
  const named = allIngredients.filter(i => (i.name||'').trim() !== '');
  if(named.length === 0){
    body.innerHTML = '<tr><td colspan="6"><div class="overview-empty">No ingredient names entered yet</div></td></tr>';
    if(costEl){ costEl.innerHTML = ''; costEl.title = ''; }
    const per100El = document.getElementById('overviewCostPer100');
    const perKgEl = document.getElementById('overviewCostPerKg');
    const perServingWrap = document.getElementById('overviewCostPerServingWrap');
    const factoryPriceEl = document.getElementById('overviewFactoryPrice');
    const companyPriceEl = document.getElementById('overviewCompanyPrice');
    if(per100El) per100El.textContent = '—';
    if(perKgEl) perKgEl.textContent = '—';
    if(perServingWrap) perServingWrap.style.display = 'none';
    if(factoryPriceEl) factoryPriceEl.textContent = '—';
    if(companyPriceEl) companyPriceEl.textContent = '—';
    return;
  }

  // Currency conversion -- picking anything other than THB (which needs
  // none) converts every money figure this function renders using the
  // Exchange Rate typed into f-exchangeRate (1 unit of that currency =
  // however many THB). All internal math above and below still runs in
  // THB throughout (ingredient prices only ever exist in THB, per the
  // Ingredient Library) -- `money()` is purely a display-time formatter,
  // called separately at every place a figure actually gets shown, so
  // rounding/conversion never compounds through the calculation chain.
  // Returns null (never a THB number under a foreign currency's label)
  // when a non-THB currency is picked but no valid rate is set yet.
  const pricingCurrency = document.getElementById('f-pricingCurrency')?.value || 'THB';
  const exchangeRateVal = parseFloat(document.getElementById('f-exchangeRate')?.value);
  const rateAvailable = pricingCurrency === 'THB' || (!isNaN(exchangeRateVal) && exchangeRateVal > 0);
  const rateMissingTitle = 'Enter an Exchange Rate above to show this in ' + pricingCurrency;
  const money = (v, roundUp005) => {
    if(v == null || !rateAvailable) return null;
    let converted = pricingCurrency === 'THB' ? v : (v / exchangeRateVal);
    if(roundUp005) converted = Math.ceil(converted / 0.05) * 0.05;
    return pricingCurrency === 'THB' ? `฿${converted.toFixed(2)}` : `${converted.toFixed(2)} ${pricingCurrency}`;
  };

  // Grouped by name AND Prep (not just name) -- two occurrences of the same
  // ingredient with a different Prep (and therefore, usually, a different
  // Yield) are genuinely different amounts to weigh out, so they show as
  // separate rows rather than being silently averaged/merged into one.
  const groups = new Map();
  named.forEach(i => {
    const key = i.name.trim().toLowerCase() + '|' + (i.note || '').trim().toLowerCase();
    if(!groups.has(key)){
      const material = i.materialId ? ingredientMaster.find(m => m.id === i.materialId) : null;
      // null (not 0) when the matched Ingredient Library entry has no
      // Price/kg on file, so a missing price shows as missing cost below
      // rather than silently costing nothing.
      const pricePerKg = material && material.price !== '' && material.price != null ? parseFloat(material.price) : null;
      groups.set(key, {
        name: i.name.trim(),
        note: i.note || '',
        pct: 0,
        wt: 0,
        // Every ingredient sharing this exact name+Prep key is expected to
        // share the same Yield too (it's the same prep); taken from
        // whichever one is seen first, same as image/vendorName/etc. below.
        prepYieldPct: i.prepYieldPct,
        image: material ? material.image : '',
        vendorName: material ? material.vendorName : '',
        manufacturer: material ? material.manufacturer : '',
        brand: material ? material.brand : '',
        pricePerKg,
        // Kept only so clicking the thumbnail below can open the same
        // Material Detail popup the Ingredient Library page itself uses
        // (see openMaterialDetail in materials.js) -- null when this
        // ingredient isn't actually linked to a library entry.
        material
      });
    }
    const g = groups.get(key);
    g.wt += parseFloat(i.weight) || 0;
    // Accumulated per-instance rather than recomputed once from the summed
    // Formula weight -- two instances sharing this same name+Prep key can
    // now live under different Parts with different compounding, so each
    // needs its own effective Prepare weight added in, not one shared
    // Yield% applied to the combined total.
    g.prepareWt = (g.prepareWt || 0) + (prepareWeightByIng.get(i) ?? computePrepareWeight(i.weight, i.prepYieldPct));
  });

  // % here is always of the whole recipe (not the ingredient's own part),
  // so it's computed straight from weight rather than summing the now
  // per-part ing.percent values. Yield never enters this -- % of Recipe and
  // Formula Wt. stay exactly what they'd be without the feature.
  const totalRecipeWeight = allIngredients.reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
  groups.forEach(g => {
    g.pct = totalRecipeWeight > 0 ? (g.wt / totalRecipeWeight * 100) : 0;
    // Cost is based on Prepare (gross) weight, not Formula weight -- the
    // Price/kg is the as-purchased price, so what's actually bought (and
    // costed) is the gross amount before any prep loss.
    g.cost = computeIngredientCost(g.prepareWt, g.pricePerKg);
  });

  const OVERVIEW_SORT_ACCESSORS = { name: g => g.name.toLowerCase(), wt: g => g.wt, cost: g => g.cost ?? -1, prepareWt: g => g.prepareWt, yield: g => g.prepYieldPct ?? 100 };
  const overviewSortAccessor = OVERVIEW_SORT_ACCESSORS[overviewSortKey] || OVERVIEW_SORT_ACCESSORS.wt;
  const rows = [...groups.values()].sort((a,b) => {
    const av = overviewSortAccessor(a), bv = overviewSortAccessor(b);
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return overviewSortDir === 'asc' ? cmp : -cmp;
  });
  const maxPct = Math.max(...rows.map(g => g.pct), 100);
  // Weight/Cost have no natural 0-100 bound the way % does, so their bars
  // scale against the largest value actually in this recipe (that row's
  // bar fills 100%) rather than against a fixed ceiling.
  const maxWt = Math.max(...rows.map(g => g.wt), 0);
  const maxCost = Math.max(...rows.filter(g => g.cost != null).map(g => g.cost), 0);

  let totalCost = 0;
  let allPriced = true;
  let anyPriced = false;

  // A thin bar under the number itself (not a separate pill beside it) --
  // same idea for all three numeric columns (%/Weight/Cost), each scaled
  // against its own column's own values (see maxPct/maxWt/maxCost above).
  const numCellHtml = (text, barPct) => `
    <div class="overview-num-cell">
      <span>${text}</span>
      ${barPct != null ? `<div class="overview-mini-bar"><div class="overview-mini-bar-fill" style="width:${barPct}%"></div></div>` : ''}
    </div>
  `;

  rows.forEach((g, idx) => {
    const tr = document.createElement('tr');
    const pctBarPct = Math.min(100, (g.pct / maxPct) * 100);
    const wtBarPct = maxWt > 0 ? Math.min(100, (g.wt / maxWt) * 100) : 0;
    const costBarPct = g.cost != null && maxCost > 0 ? Math.min(100, (g.cost / maxCost) * 100) : null;
    if(g.cost != null){ totalCost += g.cost; anyPriced = true; }else{ allPriced = false; }
    const y = parseFloat(g.prepYieldPct);
    const isLossy = isFinite(y) && y > 0 && y < 100;
    tr.innerHTML = `
      <td class="col-no">${idx+1}</td>
      <td>
        <div class="overview-ing-cell">
          ${g.image
            ? `<img src="${escapeHtml(g.image)}" class="overview-thumb${g.material ? ' overview-thumb-clickable' : ''}" alt="${escapeHtml(g.name)}" title="${g.material ? 'Click for ingredient details' : ''}">`
            : `<div class="overview-thumb overview-thumb-empty${g.material ? ' overview-thumb-clickable' : ''}" title="${g.material ? 'Click for ingredient details' : ''}"></div>`}
          <div class="overview-ing-info">
            <span>${escapeHtml(g.name)}</span>
            ${g.note ? `<span class="overview-ing-prep">${escapeHtml(g.note)}</span>` : ''}
            ${(g.brand || g.vendorName || g.manufacturer) ? `<span class="overview-ing-sub">${escapeHtml([g.brand, g.vendorName, g.manufacturer].filter(Boolean).join(' · '))}</span>` : ''}
          </div>
        </div>
      </td>
      <td class="col-pct">${numCellHtml(g.pct.toFixed(2) + '%', pctBarPct)}</td>
      <td class="col-wt">${numCellHtml(formatWeight(g.wt), wtBarPct)}</td>
      <td class="col-wt${isLossy ? ' col-prepare-highlight' : ''}" title="${isLossy ? `Prep Yield: ${y.toFixed(2)}%` : ''}">${formatWeight(g.prepareWt)}</td>
      <td class="col-cost">${numCellHtml(money(g.cost) ?? '—', costBarPct)}</td>
    `;
    // Reuses the exact same Material Detail popup the Ingredient Library
    // page itself opens (see openMaterialDetail in materials.js) -- only
    // wired when this ingredient is actually linked to a library entry
    // (g.material), since there's nothing to show otherwise.
    if(g.material){
      tr.querySelector('.overview-thumb').addEventListener('click', () => openMaterialDetail(g.material));
    }
    body.appendChild(tr);
  });

  // Preparation Total -- sum of every row's own Prepare (gross) weight,
  // shown in its own column right next to Formula Total so the two never
  // get conflated into a single number.
  const prepareTotalEl = document.getElementById('grandTotalPrepareWt');
  if(prepareTotalEl) prepareTotalEl.textContent = formatWeight(rows.reduce((s,g)=>s+g.prepareWt,0));

  const hasCost = totalRecipeWeight > 0 && anyPriced;
  const costSuffix = !allPriced ? '*' : '';
  const missingPriceTitle = allPriced ? '' : 'Some ingredients have no Price/kg on file in the Ingredient Library — this doesn\'t include their cost';

  if(costEl){
    const m = hasCost ? money(totalCost) : null;
    if(m != null){
      costEl.innerHTML = `${m}${costSuffix}`;
      costEl.title = missingPriceTitle;
    }else{
      costEl.innerHTML = totalRecipeWeight > 0 ? '—' : '';
      costEl.title = !hasCost && totalRecipeWeight > 0 ? 'No ingredients have a Price/kg on file in the Ingredient Library yet' : (hasCost ? rateMissingTitle : '');
    }
  }

  // Cost / 100g, Cost / kg, and (once a serving size is entered) Cost /
  // Serving -- moved below the table, out of the cramped Total cell, per
  // the same "* marks a partial estimate" convention as Compare Costing.
  const costPer100 = hasCost ? (totalCost / totalRecipeWeight) * 100 : null;
  const costPerKg = hasCost ? (totalCost / totalRecipeWeight) * 1000 : null;
  const per100El = document.getElementById('overviewCostPer100');
  const perKgEl = document.getElementById('overviewCostPerKg');
  if(per100El){
    const m = money(costPer100);
    per100El.textContent = m != null ? `${m}${costSuffix}` : '—';
    per100El.title = costPer100 != null ? (m != null ? missingPriceTitle : rateMissingTitle) : '';
  }
  if(perKgEl){
    const m = money(costPerKg);
    perKgEl.textContent = m != null ? `${m}${costSuffix}` : '—';
    perKgEl.title = costPerKg != null ? (m != null ? missingPriceTitle : rateMissingTitle) : '';
  }
  const perServingWrap = document.getElementById('overviewCostPerServingWrap');
  const perServingEl = document.getElementById('overviewCostPerServing');
  const servingSize = parseFloat(document.getElementById('f-servingSize')?.value) || 0;
  const costPerServing = (servingSize > 0 && costPer100 != null) ? (costPer100 / 100 * servingSize) : null;
  if(perServingWrap){
    if(costPerServing != null){
      perServingWrap.style.display = '';
      const m = money(costPerServing);
      perServingEl.textContent = m != null ? `${m}${costSuffix}` : '—';
      perServingEl.title = m != null ? missingPriceTitle : rateMissingTitle;
    }else{
      perServingWrap.style.display = 'none';
    }
  }

  // Factory/Company/Customer Margin are markup on the tier before them --
  // Selling Price = Base × (1 + margin/100) (e.g. a 50% margin means
  // Selling Price = Base × 1.5, a 100% margin means × 2). Company Selling
  // Price cascades on top of the Factory price (not off cost directly),
  // and Customer on top of Company -- Min follows Min through the whole
  // chain, Max follows Max, so the overall range reflects the worst-case
  // and best-case ends consistently rather than mixing a low margin on
  // one tier with a high one on another. Factory's own base is
  // Cost/Serving times the Overhead Multiplier (if set; unset behaves as
  // × 1, no adjustment).
  const pct = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  const marginPrice = (base, marginPct) => (base != null && marginPct != null) ? base * (1 + marginPct / 100) : null;
  // Renders a Min–Max Selling Price range, rounding each end UP to the
  // nearest 0.05 of the selected currency for a clean asking price
  // (Cost/100g etc. above stay at their exact, unrounded-up value --
  // this is deliberately only for the three Selling Price figures
  // below). Distinguishes "the margin math itself has nothing to show"
  // from "it does, but there's no Exchange Rate to display it in yet"
  // so the tooltip points at whichever is actually missing.
  const priceRangeStr = (min, max) => {
    if(min == null || max == null) return { text: '—', title: '' };
    const minStr = money(min, true), maxStr = money(max, true);
    if(minStr == null || maxStr == null) return { text: '—', title: rateMissingTitle };
    return { text: `${minStr} – ${maxStr}${costSuffix}`, title: missingPriceTitle };
  };
  const overheadMultiplier = pct(document.getElementById('f-overheadMultiplier')?.value);
  const overheadBase = costPerServing != null ? costPerServing * (overheadMultiplier ?? 1) : null;
  const factoryMarginMin = pct(document.getElementById('f-factoryMarginMin')?.value);
  const factoryMarginMax = pct(document.getElementById('f-factoryMarginMax')?.value);

  const factoryPriceMin = marginPrice(overheadBase, factoryMarginMin);
  const factoryPriceMax = marginPrice(overheadBase, factoryMarginMax);
  const factoryPriceEl = document.getElementById('overviewFactoryPrice');
  if(factoryPriceEl){
    const { text, title } = priceRangeStr(factoryPriceMin, factoryPriceMax);
    factoryPriceEl.textContent = text;
    factoryPriceEl.title = title;
  }

  const companyMarginMin = pct(document.getElementById('f-companyMarginMin')?.value);
  const companyMarginMax = pct(document.getElementById('f-companyMarginMax')?.value);
  const companyPriceMin = marginPrice(factoryPriceMin, companyMarginMin);
  const companyPriceMax = marginPrice(factoryPriceMax, companyMarginMax);
  const companyPriceEl = document.getElementById('overviewCompanyPrice');
  if(companyPriceEl){
    const { text, title } = priceRangeStr(companyPriceMin, companyPriceMax);
    companyPriceEl.textContent = text;
    companyPriceEl.title = title;
  }

  const customerMarginMin = pct(document.getElementById('f-customerMarginMin')?.value);
  const customerMarginMax = pct(document.getElementById('f-customerMarginMax')?.value);
  const customerPriceMin = marginPrice(companyPriceMin, customerMarginMin);
  const customerPriceMax = marginPrice(companyPriceMax, customerMarginMax);
  const customerPriceEl = document.getElementById('overviewCustomerPrice');
  if(customerPriceEl){
    const { text, title } = priceRangeStr(customerPriceMin, customerPriceMax);
    customerPriceEl.textContent = text;
    customerPriceEl.title = title;
  }
}

/* ---------- Process Steps (grouped: a process title + its own numbered steps) ---------- */
function renderProcesses(r){
  const list = document.getElementById('processesList');
  list.innerHTML = '';

  r.processes.forEach((proc, pIdx) => {
    const block = document.createElement('div');
    block.className = 'process-block';
    block.innerHTML = `
      <div class="process-header">
        <div class="step-badge">${pIdx+1}</div>
        <input type="text" class="process-title" placeholder="Process ${pIdx+1} name (e.g. Mixing)">
        <button class="icon-btn" title="Move this process up">${icon('chevron-up')}</button>
        <button class="icon-btn" title="Move this process down">${icon('chevron-down')}</button>
        <button class="icon-btn" title="Delete this process">${icon('x')}</button>
      </div>
      <div class="process-components">
        <div class="process-components-title">Components</div>
        <div class="process-comp-add-row">
          <div class="comp-multiselect">
            <button type="button" class="comp-multiselect-toggle">— Select parts/ingredients to add —</button>
            <div class="comp-multiselect-panel"></div>
          </div>
          <button class="btn btn-sm" type="button" data-role="add-component">+ Add</button>
        </div>
        <div style="overflow-x:auto;">
          <table class="process-comp-table">
            <thead>
              <tr>
                <th class="col-no">#</th>
                <th>Name</th>
                <th class="col-wt">Weight (g)</th>
                <th class="col-tol">Tolerance (±)</th>
                <th class="col-range">Range</th>
                <th class="col-pct">% (auto)</th>
                <th class="col-del"></th>
              </tr>
            </thead>
            <tbody></tbody>
            <tfoot>
              <tr>
                <td></td>
                <td>Total</td>
                <td class="col-wt process-comp-total-wt"></td>
                <td></td>
                <td></td>
                <td class="col-pct process-comp-total-pct"></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div class="process-actual-yield">
        <div class="process-components-title">Actual Yield</div>
        <div class="process-actual-yield-fields">
          <div class="process-yield-photos">
            <div class="trial-photos-row proc-photos-row"></div>
            <label class="btn btn-sm mu-attach-btn proc-photo-add-label">${icon('paperclip', 14)} Add Photo<input type="file" class="proc-photo-input" accept="image/*" style="display:none;"></label>
          </div>
          <div class="process-actual-yield-data">
            <div class="process-actual-yield-weight-row">
              <label>Weight Before (g)<input type="number" class="proc-wt-before num-input" step="0.01" min="0" placeholder="—"></label>
              <label>Weight After (g)<input type="number" class="proc-wt-after num-input" step="0.01" min="0" placeholder="—"></label>
              <div class="process-actual-yield-result">
                <span>Yield</span>
                <span class="proc-actual-yield-display">—</span>
              </div>
            </div>
            <div class="process-qc-groups">
            ${['brix','salt','ph'].map(field => `
              <div class="process-qc-group">
                <span class="process-qc-label">${field === 'brix' ? '°Brix' : field === 'salt' ? '%Salt' : 'pH'}</span>
                <div class="process-qc-reps">
                  <input type="number" class="proc-${field} num-input" data-idx="0" step="0.01" placeholder="Rep 1">
                  <input type="number" class="proc-${field} num-input" data-idx="1" step="0.01" placeholder="Rep 2">
                  <input type="number" class="proc-${field} num-input" data-idx="2" step="0.01" placeholder="Rep 3">
                </div>
                <div class="process-qc-avg"><span>Avg</span><span class="proc-${field}-avg-display">—</span></div>
              </div>
            `).join('')}
            </div>
          </div>
        </div>
      </div>

      <div class="process-steps-list"></div>
      <button class="btn btn-sm add-row-btn" data-role="add-step">+ Add Step</button>
    `;

    const titleInput = block.querySelector('.process-title');
    titleInput.value = proc.title || '';
    titleInput.addEventListener('input', e => { proc.title = e.target.value; scheduleSave(); });

    // Actual Yield -- real measured weight going into/out of this whole
    // Process (e.g. weigh the batch before and after Mixing), distinct from
    // every other Yield figure in this app (those are all planned/
    // theoretical, computed from the recipe's own data): this one is a
    // manual production measurement, so it's just two plain numbers with a
    // read-only Yield% derived from them -- After ÷ Before -- never
    // touching any recipe weight/cost figure elsewhere.
    const wtBeforeInput = block.querySelector('.proc-wt-before');
    const wtAfterInput = block.querySelector('.proc-wt-after');
    const actualYieldDisplay = block.querySelector('.proc-actual-yield-display');
    wtBeforeInput.value = proc.weightBefore != null ? proc.weightBefore : '';
    wtAfterInput.value = proc.weightAfter != null ? proc.weightAfter : '';
    function updateActualYieldDisplay(){
      const before = parseFloat(proc.weightBefore);
      const after = parseFloat(proc.weightAfter);
      if(!isFinite(before) || before <= 0 || !isFinite(after)){
        actualYieldDisplay.textContent = '—';
        return;
      }
      actualYieldDisplay.textContent = (after / before * 100).toFixed(2) + '%';
    }
    updateActualYieldDisplay();
    wtBeforeInput.addEventListener('input', e => {
      proc.weightBefore = e.target.value === '' ? null : (parseFloat(e.target.value) || null);
      updateActualYieldDisplay();
      scheduleSave();
    });
    wtAfterInput.addEventListener('input', e => {
      proc.weightAfter = e.target.value === '' ? null : (parseFloat(e.target.value) || null);
      updateActualYieldDisplay();
      scheduleSave();
    });

    // Up to 2 reference photos for this process's Actual Yield measurement
    // -- same resize-on-upload/thumbnail/remove pattern as the Description
    // photos above, just a smaller cap and its own array so the two photo
    // sets never mix.
    if(!Array.isArray(proc.photos)) proc.photos = [];
    const procPhotosRow = block.querySelector('.proc-photos-row');
    const procPhotoInput = block.querySelector('.proc-photo-input');
    const procPhotoAddLabel = block.querySelector('.proc-photo-add-label');
    function renderProcPhotos(){
      procPhotosRow.innerHTML = proc.photos.map((photo, idx) => `
        <div class="trial-photo-thumb" data-idx="${idx}">
          <img src="${escapeHtml(photo)}" alt="Process photo ${idx+1}">
          <button type="button" title="Remove this photo">${icon('x')}</button>
        </div>
      `).join('');
      procPhotosRow.querySelectorAll('.trial-photo-thumb button').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.closest('.trial-photo-thumb').dataset.idx, 10);
          proc.photos.splice(idx, 1);
          renderProcPhotos();
          scheduleSave();
        });
      });
      if(procPhotoAddLabel) procPhotoAddLabel.style.display = proc.photos.length >= 2 ? 'none' : '';
    }
    renderProcPhotos();
    procPhotoInput.addEventListener('change', async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if(!file || proc.photos.length >= 2) return;
      proc.photos.push(await resizeImageFile(file, 500));
      renderProcPhotos();
      scheduleSave();
    });

    // Quality Control readings -- °Brix, %Salt, pH -- each with up to 3
    // replicate measurements (proc[field] = [rep1, rep2, rep3]) and an
    // average shown alongside, computed from whichever reps actually have a
    // value (blanks skipped rather than treated as 0, so 1 or 2 filled-in
    // reps still average correctly while the recipe's waiting on the rest).
    ['brix','salt','ph'].forEach(field => {
      const repInputs = [...block.querySelectorAll(`.proc-${field}`)];
      const avgDisplay = block.querySelector(`.proc-${field}-avg-display`);
      if(!Array.isArray(proc[field])) proc[field] = [null, null, null];
      repInputs.forEach((input, idx) => {
        input.value = proc[field][idx] != null ? proc[field][idx] : '';
      });
      function updateAvgDisplay(){
        const vals = proc[field].map(v => parseFloat(v)).filter(v => isFinite(v));
        avgDisplay.textContent = vals.length > 0 ? (vals.reduce((s,v)=>s+v,0) / vals.length).toFixed(2) : '—';
      }
      updateAvgDisplay();
      repInputs.forEach((input, idx) => {
        input.addEventListener('input', e => {
          proc[field][idx] = e.target.value === '' ? null : (parseFloat(e.target.value) || null);
          updateAvgDisplay();
          scheduleSave();
        });
      });
    });

    const stepsListEl = block.querySelector('.process-steps-list');

    function renderStepRows(){
      stepsListEl.innerHTML = '';
      proc.steps.forEach((step, idx) => {
        const row = document.createElement('div');
        row.className = 'step-row';
        row.innerHTML = `
          <div class="step-badge">${idx+1}</div>
          <div class="step-body"><textarea placeholder="Describe step ${idx+1}..."></textarea></div>
          <div class="step-controls">
            <button class="icon-btn" title="Move up">${icon('chevron-up')}</button>
            <button class="icon-btn" title="Move down">${icon('chevron-down')}</button>
            <button class="icon-btn" title="Delete">${icon('x')}</button>
          </div>
        `;
        const ta = row.querySelector('textarea');
        ta.value = step;
        ta.addEventListener('input', e => { proc.steps[idx] = e.target.value; scheduleSave(); });

        const [upBtn, downBtn, delBtn] = row.querySelectorAll('.icon-btn');
        upBtn.addEventListener('click', () => {
          if(idx === 0) return;
          [proc.steps[idx-1], proc.steps[idx]] = [proc.steps[idx], proc.steps[idx-1]];
          renderStepRows(); scheduleSave();
        });
        downBtn.addEventListener('click', () => {
          if(idx === proc.steps.length-1) return;
          [proc.steps[idx+1], proc.steps[idx]] = [proc.steps[idx], proc.steps[idx+1]];
          renderStepRows(); scheduleSave();
        });
        delBtn.addEventListener('click', () => {
          proc.steps.splice(idx,1);
          renderStepRows(); scheduleSave();
        });

        stepsListEl.appendChild(row);
      });
    }
    renderStepRows();

    block.querySelector('[data-role="add-step"]').addEventListener('click', () => {
      proc.steps.push('');
      renderStepRows();
      scheduleSave();
    });

    // --- Components (snapshot a Part or an existing ingredient into a
    //     reference table for this process: weight, ± tolerance, %).
    //     Name/weight/tolerance are copied in once and then fully editable —
    //     they don't stay linked to the source, so editing them later never
    //     touches the recipe's real ingredients/parts. % is the exception:
    //     it's always auto-computed from this table's own weights, so the
    //     components in a process always sum to 100%. ---
    if(!Array.isArray(proc.components)) proc.components = [];
    const compToggle = block.querySelector('.comp-multiselect-toggle');
    const compPanel = block.querySelector('.comp-multiselect-panel');
    const compBody = block.querySelector('.process-comp-table tbody');
    const compFoot = block.querySelector('.process-comp-table tfoot');
    const totalWtEl = block.querySelector('.process-comp-total-wt');
    const totalPctEl = block.querySelector('.process-comp-total-pct');

    // Flat index into these two arrays (not a "partIdx.ingredientIdx" path)
    // is what lets the checklist address a Part or ingredient at ANY
    // nesting depth — see collectPartsFlat/collectIngredientsFlat.
    // Recomputed fresh on every render, and the "Add" handler below
    // re-derives the exact same two arrays, so the flat index it reads
    // back always lines up with what's currently checked.
    const flatParts = collectPartsFlat(r.parts, '');
    const flatIngredients = collectIngredientsFlat(r.parts, '');

    // Several items can be checked off before a single "+ Add" snapshots
    // all of them at once — cleared after every Add (and whenever the
    // process list re-renders) rather than persisted, since it's just a
    // staging pick-list, not part of the recipe data itself.
    const selectedKeys = new Set();

    function updateToggleLabel(){
      const n = selectedKeys.size;
      compToggle.textContent = n === 0 ? '— Select parts/ingredients to add —' : `${n} selected`;
      compToggle.classList.toggle('has-selection', n > 0);
    }

    function itemRow(value, label){
      return `
        <label class="comp-multiselect-item">
          <input type="checkbox" value="${escapeHtml(value)}">
          <span>${escapeHtml(label)}</span>
        </label>
      `;
    }
    const partItems = flatParts.map((entry, idx) => itemRow(`part:${idx}`, entry.label)).join('');
    const ingItems = flatIngredients.map((entry, idx) => itemRow(`ing:${idx}`, entry.label)).join('');
    compPanel.innerHTML = (partItems || ingItems) ? `
      ${partItems ? `<div class="comp-multiselect-group-label">Parts</div>${partItems}` : ''}
      ${ingItems ? `<div class="comp-multiselect-group-label">Ingredients</div>${ingItems}` : ''}
    ` : '<div class="comp-multiselect-empty">Nothing to add yet</div>';

    compPanel.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.checked = selectedKeys.has(cb.value);
      cb.addEventListener('change', () => {
        if(cb.checked) selectedKeys.add(cb.value); else selectedKeys.delete(cb.value);
        updateToggleLabel();
      });
    });

    compToggle.addEventListener('click', () => {
      compPanel.classList.toggle('open');
    });
    // Closes the panel once focus moves somewhere outside this widget —
    // a listener scoped to the widget itself (via focusout's bubbling +
    // relatedTarget) rather than a document-level one, so it doesn't need
    // manual cleanup and can't pile up across the repeated re-renders
    // renderProcesses() goes through on every edit.
    block.querySelector('.comp-multiselect').addEventListener('focusout', e => {
      if(e.currentTarget.contains(e.relatedTarget)) return;
      compPanel.classList.remove('open');
    });

    function renderComponentRows(){
      compBody.innerHTML = '';
      if(proc.components.length === 0){
        compBody.innerHTML = '<tr><td colspan="7"><div class="overview-empty">No components added yet</div></td></tr>';
        if(compFoot) compFoot.style.display = 'none';
        return;
      }
      if(compFoot) compFoot.style.display = '';
      const pctDisplays = [];

      function recalcAllPercents(){
        const totalWt = proc.components.reduce((s,c)=>s+(parseFloat(c.weight)||0),0);
        proc.components.forEach((c, i) => {
          c.percent = totalWt > 0 ? round2((parseFloat(c.weight)||0)/totalWt*100) : 0;
          if(pctDisplays[i]) pctDisplays[i].textContent = c.percent.toFixed(2) + '%';
        });
        if(totalWtEl) totalWtEl.textContent = formatWeight(totalWt);
        if(totalPctEl){
          const totalPct = proc.components.reduce((s,c)=>s+(parseFloat(c.percent)||0),0);
          totalPctEl.textContent = totalPct.toFixed(2) + '%';
        }
      }

      proc.components.forEach((comp, cIdx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="col-no">${cIdx+1}</td>
          <td><input type="text" class="comp-name"></td>
          <td class="col-wt"><input type="number" class="comp-wt num-input" step="0.01"></td>
          <td class="col-tol"><input type="number" class="comp-tol num-input" step="0.01" min="0"></td>
          <td class="col-range comp-range"></td>
          <td class="col-pct"><span class="comp-pct-display" title="Calculated automatically from weight"></span></td>
          <td class="col-del"><button class="icon-btn" title="Delete">${icon('x')}</button></td>
        `;
        const nameInput = tr.querySelector('.comp-name');
        const wtInput = tr.querySelector('.comp-wt');
        const tolInput = tr.querySelector('.comp-tol');
        const rangeCell = tr.querySelector('.comp-range');
        const pctDisplay = tr.querySelector('.comp-pct-display');
        pctDisplays.push(pctDisplay);
        nameInput.value = comp.name || '';
        wtInput.value = comp.weight ?? 0;
        tolInput.value = comp.tolerance ?? 0;

        function updateRange(){
          const wt = parseFloat(wtInput.value) || 0;
          const tol = parseFloat(tolInput.value) || 0;
          rangeCell.textContent = `${(wt-tol).toFixed(2)}-${(wt+tol).toFixed(2)} g`;
        }
        updateRange();

        nameInput.addEventListener('input', e => { comp.name = e.target.value; scheduleSave(); });
        wtInput.addEventListener('input', e => { comp.weight = parseFloat(e.target.value) || 0; updateRange(); recalcAllPercents(); scheduleSave(); });
        tolInput.addEventListener('input', e => { comp.tolerance = parseFloat(e.target.value) || 0; updateRange(); scheduleSave(); });
        tr.querySelector('.icon-btn').addEventListener('click', () => {
          proc.components.splice(cIdx, 1);
          renderComponentRows();
          scheduleSave();
        });

        compBody.appendChild(tr);

        // If this Component is a whole Part (not a single ingredient),
        // show what's actually inside it -- read-only, one row per
        // ingredient with its own Weight/% (the ingredient's own stored
        // weight/percent -- % of the whole recipe, same figures already
        // shown in the Recipe Overview table and the printed ingredient
        // table, not a separately-computed %-of-this-part) lined up under
        // the same Weight/% columns as the main row above, so "Vegan
        // Tartar Sauce" as one lumped-together 500g Component still lets
        // you see at a glance what that 500g is actually made of, without
        // duplicating the main ingredient tree's own editable fields here.
        const matchedPart = findPartByName(r.parts, (comp.name || '').trim());
        const innerIngredients = matchedPart
          ? allIngredientsInPart(matchedPart).filter(i => (i.name||'').trim() !== '')
          : [];
        innerIngredients.forEach(ing => {
          const subTr = document.createElement('tr');
          subTr.className = 'comp-sublist-row';
          subTr.innerHTML = `
            <td></td>
            <td class="comp-sublist-name">${escapeHtml(ing.name)}</td>
            <td class="col-wt comp-sublist-num">${formatWeight(parseFloat(ing.weight) || 0)}</td>
            <td class="col-tol"></td>
            <td class="col-range"></td>
            <td class="col-pct comp-sublist-num">${(parseFloat(ing.percent) || 0).toFixed(2)}%</td>
            <td class="col-del"></td>
          `;
          compBody.appendChild(subTr);
        });
      });

      recalcAllPercents();
    }
    renderComponentRows();

    block.querySelector('[data-role="add-component"]').addEventListener('click', () => {
      if(selectedKeys.size === 0) return;
      selectedKeys.forEach(val => {
        const [kind, a] = val.split(':');
        let name, weight;
        if(kind === 'part'){
          const entry = flatParts[+a];
          if(!entry) return;
          name = entry.part.name || 'Untitled part';
          weight = partTotalWeight(entry.part);
        } else {
          const entry = flatIngredients[+a];
          if(!entry) return;
          name = entry.ing.name;
          weight = parseFloat(entry.ing.weight) || 0;
        }
        proc.components.push({ name, weight: round2(weight), tolerance: 0, percent: 0 });
      });
      selectedKeys.clear();
      compPanel.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
      updateToggleLabel();
      compPanel.classList.remove('open');
      renderComponentRows();
      scheduleSave();
    });

    const [moveUpBtn, moveDownBtn, deleteProcessBtn] = block.querySelectorAll('.process-header .icon-btn');
    moveUpBtn.addEventListener('click', () => {
      if(pIdx === 0) return;
      [r.processes[pIdx-1], r.processes[pIdx]] = [r.processes[pIdx], r.processes[pIdx-1]];
      renderProcesses(r);
      scheduleSave();
    });
    moveDownBtn.addEventListener('click', () => {
      if(pIdx === r.processes.length-1) return;
      [r.processes[pIdx+1], r.processes[pIdx]] = [r.processes[pIdx], r.processes[pIdx+1]];
      renderProcesses(r);
      scheduleSave();
    });
    deleteProcessBtn.addEventListener('click', () => {
      const deletedProc = r.processes[pIdx];
      r.processes.splice(pIdx, 1);
      if(r.processes.length === 0) r.processes.push({ id: uid(), title: '', steps: [''], components: [] });
      // Any Process Flowchart node currently live-linked to this Process
      // (see computeFlowNodeText) gets detached rather than losing its
      // content silently — its last-shown text is frozen as an ordinary
      // free-typed node instead.
      (r.processFlowchart.nodes || []).forEach(node => {
        if(node.linkedProcessId === deletedProc.id){
          node.text = computeFlowNodeText({ linkedProcessId: deletedProc.id, text: node.text }, [deletedProc]);
          node.linkedProcessId = null;
        }
      });
      renderProcesses(r);
      scheduleSave();
    });

    list.appendChild(block);
  });

  renderSimpleProcessPreview(r);
}

// A plain, non-editable "title, then each step stacked with a ↓ arrow
// between them" preview — the simple two-column Ingredient|Process layout
// the user's own reference spreadsheet uses, shown live in section 3 next
// to the ingredient tree. Read-only: the actual editing still happens in
// section 4's List view (or the Flowchart view) — this just mirrors
// whatever's there right now, refreshed on every renderProcesses(r) call
// so it never goes stale. No connector arrows between separate Process
// entries, only between a Process's own consecutive steps, matching the
// reference layout's visually distinct titled groups.
function renderSimpleProcessPreview(r){
  const el = document.getElementById('simpleProcessPreview');
  if(!el) return;
  const list = (r.processes || []).filter(p =>
    (p.title||'').trim() !== '' || (p.steps||[]).some(s => (s||'').trim() !== '')
  );
  if(list.length === 0){
    el.innerHTML = '<div class="overview-empty">No process steps yet</div>';
    return;
  }
  el.innerHTML = list.map(p => {
    const steps = (p.steps || []).filter(s => (s||'').trim() !== '');
    return `
      <div class="simple-process-block">
        <div class="simple-process-title">${escapeHtml(p.title || 'Untitled process')}</div>
        ${steps.map((s, idx) => `
          ${idx > 0 ? '<div class="simple-process-arrow">↓</div>' : ''}
          <div class="simple-process-step">${escapeHtml(s)}</div>
        `).join('')}
      </div>
    `;
  }).join('');
}

/* ---------- Process Flowchart (freeform alternative to the numbered Steps
   list — one shared canvas per recipe, not per Process entry) ----------
   The first freeform/draggable-node/connector-line UI in this app; there's
   no existing precedent to extend, so the drag and edge-drawing mechanics
   below are built from scratch. Everything else (data shape, save-on-edit,
   full-rebuild render style) follows the same conventions as the rest of
   the file. */

// Module-level "what's currently being manipulated" state, same discipline
// as dragPayload above: always reset to null on every exit path (success
// or cancel) of its gesture, never left dangling.
let flowNodeDrag = null; // { r, node, el, startClientX, startClientY, startX, startY }
let flowEdgeDraw = null; // { r, fromNode, fromEl, currentClientX, currentClientY }

function addFlowNode(r){
  const scrollEl = document.getElementById('flowchartCanvasScroll');
  let x = 40, y = 40;
  if(scrollEl){
    // Drops the new node inside whatever part of the canvas is currently
    // scrolled into view, cascading slightly on repeated clicks so new
    // nodes don't stack exactly on top of each other.
    const count = r.processFlowchart.nodes.length;
    x = scrollEl.scrollLeft + 40 + (count % 5) * 24;
    y = scrollEl.scrollTop + 40 + (count % 5) * 24;
  }
  r.processFlowchart.nodes.push(blankFlowNode(nextFlowNodeLabel(r.processFlowchart.nodes), x, y));
  renderProcessFlowchart(r);
  renderParts(r); // refreshes every ingredient row's link-selector options
  scheduleSave();
}

// Recursive (mirrors migratePart's own recursion) so a node deleted while
// linked from an ingredient nested inside a Sub-part still gets cleared.
function clearFlowLinksToNode(parts, nodeId){
  (parts || []).forEach(part => {
    (part.ingredients || []).forEach(ing => {
      if(ing.flowNodeId === nodeId) ing.flowNodeId = null;
    });
    clearFlowLinksToNode(part.parts, nodeId);
  });
}

function deleteFlowNode(r, nodeId){
  const idx = r.processFlowchart.nodes.findIndex(n => n.id === nodeId);
  if(idx === -1) return;
  r.processFlowchart.nodes.splice(idx, 1);
  r.processFlowchart.edges = r.processFlowchart.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
  clearFlowLinksToNode(r.parts, nodeId);
  renderProcessFlowchart(r);
  renderParts(r);
  scheduleSave();
}

function addFlowEdge(r, fromId, toId){
  if(!fromId || !toId || fromId === toId) return;
  const exists = r.processFlowchart.edges.some(e => e.from === fromId && e.to === toId);
  if(exists) return;
  r.processFlowchart.edges.push({ id: uid(), from: fromId, to: toId });
}

function deleteFlowEdge(r, edgeId){
  const idx = r.processFlowchart.edges.findIndex(e => e.id === edgeId);
  if(idx === -1) return;
  r.processFlowchart.edges.splice(idx, 1);
  redrawFlowEdges(r);
  scheduleSave();
}

// Recomputes every edge's SVG path from the CURRENT rendered node
// positions (so a dragged node's edges always follow it, with no separate
// "commit" step) — cheap enough to just redo all of them on every move
// rather than tracking which edges touch the node being dragged. Pass
// `ghost` (the in-progress flowEdgeDraw state) while a new edge is being
// drawn, to also show a dashed preview line following the pointer.
function redrawFlowEdges(r, ghost){
  const svg = document.getElementById('flowEdgesSvg');
  const layer = document.getElementById('flowNodesLayer');
  if(!svg || !layer) return;
  let html = FLOW_ARROWHEAD_DEFS;
  (r.processFlowchart.edges || []).forEach(edge => {
    const fromEl = layer.querySelector(`[data-node-id="${edge.from}"]`);
    const toEl = layer.querySelector(`[data-node-id="${edge.to}"]`);
    if(!fromEl || !toEl) return; // defensive: a dangling edge shouldn't be possible, but never crash on one
    const fromRect = rectOf(fromEl), toRect = rectOf(toEl);
    const fromCenter = { x: fromRect.x + fromRect.w/2, y: fromRect.y + fromRect.h/2 };
    const toCenter = { x: toRect.x + toRect.w/2, y: toRect.y + toRect.h/2 };
    const start = clipToRectEdge(fromRect, toCenter);
    const end = clipToRectEdge(toRect, fromCenter);
    // Two overlapping paths per edge: a wide invisible one first (an easy
    // click target, via CSS pointer-events:stroke) then the thin visible
    // line on top — a CSS ":hover + selector" rule alone highlights the
    // visible line on hover, no JS hover wiring needed.
    html += `<path class="flow-edge-hit" data-edge-id="${edge.id}" d="M${start.x},${start.y} L${end.x},${end.y}"></path>`;
    html += `<path class="flow-edge-line" d="M${start.x},${start.y} L${end.x},${end.y}" marker-end="url(#flowArrowhead)"></path>`;
  });
  if(ghost){
    const scrollEl = document.getElementById('flowchartCanvasScroll');
    const scrollRect = scrollEl.getBoundingClientRect();
    const endX = ghost.currentClientX - scrollRect.left + scrollEl.scrollLeft;
    const endY = ghost.currentClientY - scrollRect.top + scrollEl.scrollTop;
    const start = clipToRectEdge(rectOf(ghost.fromEl), { x: endX, y: endY });
    html += `<path class="flow-ghost-edge" d="M${start.x},${start.y} L${endX},${endY}"></path>`;
  }
  svg.innerHTML = html;
}

// Grows the canvas surface to fit every node + margin. Coordinates never
// go negative (see onFlowPointerMove) so growth is always one-directional
// (right/down) — the surface only re-tightens back down on the next full
// renderProcessFlowchart() rebuild, not instantly as a node is dragged
// back toward the origin.
function resizeFlowCanvasToFitNodes(){
  const canvas = document.getElementById('flowchartCanvas');
  const scrollEl = document.getElementById('flowchartCanvasScroll');
  if(!canvas || !scrollEl) return;
  let maxRight = 0, maxBottom = 0;
  canvas.querySelectorAll('.flow-node').forEach(el => {
    maxRight = Math.max(maxRight, el.offsetLeft + el.offsetWidth);
    maxBottom = Math.max(maxBottom, el.offsetTop + el.offsetHeight);
  });
  canvas.style.width = Math.max(maxRight + 200, scrollEl.clientWidth) + 'px';
  canvas.style.height = Math.max(maxBottom + 200, 400) + 'px';
}

// Full rebuild of the nodes layer + edges — deliberately lazy: bails out
// unless Flowchart view is genuinely visible right now. offsetWidth/
// offsetHeight all read 0 on elements inside a display:none ancestor, so
// building this eagerly while List view is active would silently draw
// every node collapsed at 0x0. refreshProcessViewMode always flips
// visibility BEFORE calling this, so by the time it runs the container is
// real and measurable.
function renderProcessFlowchart(r){
  const layer = document.getElementById('flowNodesLayer');
  if(!layer || r.processViewMode !== 'flowchart') return;

  layer.innerHTML = '';
  (r.processFlowchart.nodes || []).forEach(node => {
    const el = document.createElement('div');
    el.className = 'flow-node';
    el.dataset.nodeId = node.id;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    el.style.width = (node.w || DEFAULT_FLOW_NODE_W) + 'px';
    el.innerHTML = `
      <div class="flow-connector-dot top"></div>
      <div class="flow-connector-dot right"></div>
      <div class="flow-connector-dot bottom"></div>
      <div class="flow-connector-dot left"></div>
      <div class="flow-node-strip">
        ${icon('move', 12)}
        <input type="text" class="flow-node-label" maxlength="6">
        <button type="button" class="icon-btn" title="Delete this node">${icon('x')}</button>
      </div>
      <select class="flow-node-link" title="Link this node to a Process from the List view — its text then stays in sync with that Process's title/steps"></select>
      <textarea class="flow-node-text" rows="1" placeholder="Step / group name..."></textarea>
    `;
    // Appended before any scrollHeight-dependent measurement below — a
    // detached element (not yet in the document) can't report real layout.
    layer.appendChild(el);

    const labelInput = el.querySelector('.flow-node-label');
    labelInput.value = node.label || '';
    labelInput.addEventListener('input', e => {
      node.label = e.target.value;
      renderParts(r); // keeps every ingredient row's link-selector option text in sync
      scheduleSave();
    });

    const textArea = el.querySelector('.flow-node-text');
    function autoGrowFlowTextarea(){
      textArea.style.height = 'auto';
      textArea.style.height = textArea.scrollHeight + 'px';
    }
    // Reflects the node's current linked/unlinked state: linked shows the
    // live-derived text read-only (edit the actual Process in List view
    // instead — editing it here would just be silently overwritten the
    // next render), unlinked is a normal free-typed field.
    function refreshTextAreaFromLinkState(){
      textArea.value = computeFlowNodeText(node, r.processes);
      textArea.disabled = !!node.linkedProcessId;
      autoGrowFlowTextarea();
    }
    refreshTextAreaFromLinkState();
    textArea.addEventListener('input', e => {
      node.text = e.target.value;
      autoGrowFlowTextarea();
      resizeFlowCanvasToFitNodes();
      redrawFlowEdges(r);
      scheduleSave();
    });

    const linkSelect = el.querySelector('.flow-node-link');
    linkSelect.innerHTML = `<option value="">— Free text —</option>` +
      (r.processes || []).map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.title || 'Untitled process')}</option>`).join('');
    linkSelect.value = node.linkedProcessId || '';
    linkSelect.addEventListener('change', e => {
      node.linkedProcessId = e.target.value || null;
      refreshTextAreaFromLinkState();
      resizeFlowCanvasToFitNodes();
      redrawFlowEdges(r);
      scheduleSave();
    });

    el.querySelector('.flow-node-strip').addEventListener('pointerdown', e => {
      if(e.target.closest('.flow-node-label, .icon-btn')) return;
      startFlowNodeDrag(r, node, el, e);
    });
    el.querySelectorAll('.flow-connector-dot').forEach(dot => {
      dot.addEventListener('pointerdown', e => {
        e.stopPropagation(); // don't also start a node-drag from the same pointerdown
        startFlowEdgeDraw(r, node, el, e);
      });
    });
    el.querySelector('.icon-btn').addEventListener('click', () => deleteFlowNode(r, node.id));
  });

  resizeFlowCanvasToFitNodes();
  redrawFlowEdges(r);
}

function startFlowNodeDrag(r, node, el, e){
  flowNodeDrag = { r, node, el, startClientX: e.clientX, startClientY: e.clientY, startX: node.x, startY: node.y };
  el.classList.add('dragging');
}

function startFlowEdgeDraw(r, node, el, e){
  flowEdgeDraw = { r, fromNode: node, fromEl: el, currentClientX: e.clientX, currentClientY: e.clientY };
}

function onFlowPointerMove(e){
  if(flowNodeDrag){
    const d = flowNodeDrag;
    d.node.x = Math.max(0, Math.round(d.startX + (e.clientX - d.startClientX)));
    d.node.y = Math.max(0, Math.round(d.startY + (e.clientY - d.startClientY)));
    d.el.style.left = d.node.x + 'px';
    d.el.style.top = d.node.y + 'px';
    resizeFlowCanvasToFitNodes();
    redrawFlowEdges(d.r);
  } else if(flowEdgeDraw){
    flowEdgeDraw.currentClientX = e.clientX;
    flowEdgeDraw.currentClientY = e.clientY;
    redrawFlowEdges(flowEdgeDraw.r, flowEdgeDraw);
  }
}
function onFlowPointerUp(e){
  if(flowNodeDrag){
    flowNodeDrag.el.classList.remove('dragging');
    flowNodeDrag = null;
    scheduleSave();
  } else if(flowEdgeDraw){
    const { r, fromNode } = flowEdgeDraw;
    const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.flow-node');
    flowEdgeDraw = null; // cleared before branching, so it can never leak on an early return
    const toId = targetEl?.dataset.nodeId;
    if(toId && toId !== fromNode.id) addFlowEdge(r, fromNode.id, toId);
    redrawFlowEdges(r);
    scheduleSave();
  }
}
document.addEventListener('pointermove', onFlowPointerMove);
document.addEventListener('pointerup', onFlowPointerUp);

function setProcessViewMode(r, mode){
  r.processViewMode = mode;
  refreshProcessViewMode(r);
  scheduleSave();
}

function refreshProcessViewMode(r){
  const listWrap = document.getElementById('processesListWrap');
  const flowWrap = document.getElementById('flowchartCanvasWrap');
  const toggleWrap = document.getElementById('processViewToggle');
  if(!listWrap || !flowWrap) return;
  const isFlow = r.processViewMode === 'flowchart';
  listWrap.classList.toggle('process-view-hidden', isFlow);
  flowWrap.classList.toggle('process-view-hidden', !isFlow);
  if(toggleWrap){
    toggleWrap.querySelectorAll('.view-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === r.processViewMode);
    });
  }
  if(isFlow) renderProcessFlowchart(r); // container is now genuinely visible — safe to measure/build
}

/* ---------- Recipe actions ---------- */

/* ---------- Recipe Series / Trials ----------
   A "Trial" is just a regular recipe document, enriched with 8 identity
   fields (see blankRecipe/migrateRecipe above) that group it under a
   Recipe Series (a separate recipeSeries/{seriesId} doc holding the
   collision-safe Trial-number counter, since Firestore transactions can
   only read a specific document reference, never a query). Versions
   (edit-history snapshots) and Test Results (the separate `trials`
   collection, referencing recipes by their own r.id) are both completely
   untouched by any of this -- see snapshotRecipeCore's whitelist above and
   trials.js, respectively. */

// Deep-clones a source recipe into a new Trial/Recipe document, applying
// the same copy/don't-copy split every "branch off this recipe" action in
// this app needs (New Trial and Duplicate as New Recipe both call this,
// only their `overrides` differ) -- identity fields (seriesId/seriesKey/
// countryCode/year/productTypeCode/recipeSeq/trialNo/sourceTrialId) always
// come from `overrides`, never from the source's own live values, so a
// Trial can never silently drift from its Series' frozen identity.
function buildTrialClone(r, newId, overrides){
  const clone = JSON.parse(JSON.stringify(r));
  clone.id = newId;
  // Never carried forward: each Trial/new Recipe gets its own edit history,
  // its own (initially empty) free-text legacy code, and no inherited
  // photos/audit trail from the source.
  clone.versions = [];
  clone.code = '';
  clone.descPhotos = [];
  clone.legacyRecipeCode = '';
  clone.createdBy = currentUser?.email || '';
  clone.createdAt = Date.now();
  clone.updatedBy = currentUser?.email || '';
  clone.updatedAt = Date.now();
  // Identity — always frozen from the Series, per overrides.
  clone.seriesId = overrides.seriesId;
  clone.seriesKey = overrides.seriesKey;
  clone.countryCode = overrides.countryCode;
  clone.year = overrides.year;
  clone.productTypeCode = overrides.productTypeCode;
  clone.recipeSeq = overrides.recipeSeqOverride;
  clone.trialNo = overrides.trialNo;
  clone.sourceTrialId = overrides.sourceTrialId;
  return clone;
}

// The atomic "+ New Trial" write. Firestore transactions can only tx.get()
// a specific document reference (never run a query), so "the next Trial
// number in this Series" has to come from a dedicated counter document
// (recipeSeries.maxTrialNo) that this transaction reads AND increments in
// the same atomic step -- two concurrent calls both read the current
// value, but Firestore serializes the writes and auto-retries whichever
// transaction loses the race, so its retried read picks up the winner's
// new maxTrialNo. This is deliberately NOT the same pattern
// suggestNextRecipeSeq (above) uses for Recipe No. -- that one scans the
// in-memory `recipes` array with no lock, which is fine for the low-stakes
// "two people duplicate into the same Product Type at the same instant"
// case but not for a number this feature explicitly requires to never
// collide.
async function createNewTrial(r){
  const newId = uid();
  const seriesRef = doc(recipeSeriesCol, r.seriesId);
  const newRecipeRef = doc(recipesCol, newId);
  return runTransaction(db, async (tx) => {
    const seriesSnap = await tx.get(seriesRef);
    if(!seriesSnap.exists()) throw new Error('SERIES_NOT_FOUND');
    const nextTrialNo = (seriesSnap.data().maxTrialNo || 0) + 1;
    const clone = buildTrialClone(r, newId, {
      trialNo: nextTrialNo,
      sourceTrialId: r.id,
      seriesId: r.seriesId,
      seriesKey: r.seriesKey,
      countryCode: r.countryCode,
      year: r.year,
      productTypeCode: r.productTypeCode,
      recipeSeqOverride: r.recipeSeq
    });
    tx.update(seriesRef, { maxTrialNo: nextTrialNo });
    tx.set(newRecipeRef, clone);
    return clone;
  });
}

// Double-click guard shared by every call site (just the Trial History
// card's "+ T22" pill and the toolbar's "+ New Trial" button today).
let newTrialInFlight = false;

async function handleNewTrialClick(r){
  if(newTrialInFlight || !r.seriesId) return;
  newTrialInFlight = true;
  const btn = document.getElementById('btnNewTrial');
  const originalLabel = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; btn.textContent = 'Creating...'; }
  try{
    const newTrial = await createNewTrial(r);
    recipes.push(newTrial);
    openRecipe(newTrial.id);
    setUnlockedRecipeId(newTrial.id);
    logActivityEvent('created', 'recipe', newTrial.name || 'Untitled recipe');
    renderSidebar();
    renderMain();
    alert(`Created Trial T${trialNoDisplay(newTrial.trialNo)} in ${newTrial.seriesKey}.`);
  } catch(err){
    console.error('Forge: New Trial failed', err);
    alert('Could not create the new Trial. Please try again.' + (err && err.message === 'SERIES_NOT_FOUND' ? ' (This recipe\'s Series record is missing.)' : ''));
  } finally {
    newTrialInFlight = false;
    if(btn){ btn.disabled = false; btn.textContent = originalLabel || '+ New Trial'; }
  }
}

// Shows Source Trial + a best-effort expected new number (the true number
// can only be guaranteed once the transaction actually commits — see
// createNewTrial) before creating anything, per spec.
function confirmAndCreateNewTrial(r){
  if(!r.seriesId) return;
  const seriesTrials = recipes.filter(x => x.seriesId === r.seriesId);
  const bestGuessNext = Math.max(0, ...seriesTrials.map(x => x.trialNo || 0)) + 1;
  const ok = confirm(
    `Create a new Trial in ${r.seriesKey}?\n\n` +
    `Source: Trial T${trialNoDisplay(r.trialNo)}\n` +
    `New Trial (expected): T${trialNoDisplay(bestGuessNext)}\n\n` +
    `Ingredients, process steps, yield, and the linked project will be copied.\n` +
    `Versions, Test Results, and trial photos will NOT be copied.`
  );
  if(ok) handleNewTrialClick(r);
}

// Moved to the recipe editor's "More" menu as "Duplicate as New Recipe" —
// unlike New Trial, this always mints a BRAND NEW Series (fresh random
// seriesId, maxTrialNo starting at 1), so two simultaneous clicks can never
// collide with each other and no transaction is needed here (nothing
// shared to contend over). Still reuses the same existing
// suggestNextRecipeSeq race-condition-accepted pattern for the Recipe No.
// itself, exactly as this function always has.
function duplicateAsNewRecipe(){
  const r = getCurrent();
  if(!r) return;
  const newId = uid();
  const newSeq = suggestNextRecipeSeq(recipes, r.productType, r.id);
  const seriesRef = doc(recipeSeriesCol, uid());
  // If the source is itself already Series-enabled, carry its frozen
  // country/year/type forward (a duplicate of a Trial stays under the same
  // country/product-type family); otherwise derive them once, live, from
  // the source recipe exactly as fullCode() would today, then freeze them.
  const countryCode = r.seriesId ? r.countryCode : (recipeDestinationIso2(r) || '');
  const year = r.seriesId ? r.year : yearPrefix(r.date);
  const prodTypeCode = r.seriesId ? r.productTypeCode : recipeProductTypeCode(r);
  const seriesKey = `${countryCode}${year}-${prodTypeCode}${newSeq}`;
  const seriesDoc = {
    id: seriesRef.id, seriesKey, countryCode, year, productTypeCode: prodTypeCode,
    productType: r.productType || '', recipeSeq: newSeq, maxTrialNo: 1,
    firstTrialId: newId, createdAt: Date.now(), createdBy: currentUser?.email || ''
  };
  const copy = buildTrialClone(r, newId, {
    trialNo: 1, sourceTrialId: null, seriesId: seriesRef.id, seriesKey,
    countryCode, year, productTypeCode: prodTypeCode, recipeSeqOverride: newSeq
  });
  copy.name = (r.name || 'Untitled recipe') + ' (Copy)';
  recipes.push(copy);
  // The Project link isn't stored on the recipe itself (see
  // findProjectForRecipe) — it's the Project's own products list pointing
  // back at a recipeId — so duplicating the recipe object alone never
  // carried it over. Add the copy as a fresh product entry (its own stage/
  // log, not the original's progress) on that same Project.
  const oldLink = findProjectForRecipe(r.id);
  if(oldLink && !oldLink.project.products.some(x => x.recipeId === copy.id)){
    oldLink.project.products.push(blankProduct(copy.id));
    scheduleProjectSave(oldLink.project);
  }
  setDoc(seriesRef, seriesDoc);
  openRecipe(copy.id);
  setUnlockedRecipeId(copy.id);
  saveRecipeToCloud(copy);
  logActivityEvent('created', 'recipe', copy.name || 'Untitled recipe');
  renderSidebar();
  renderMain();
}

// A plain "+ New Recipe" starts Series-less (see blankRecipe) so Product
// Type stays pickable — a Series recipe has that picker locked (see the
// f-productTypeMain change handler above), which would permanently freeze
// it at "not chosen yet" if a Series existed before the first pick. This
// mints the Series in place (no new document, unlike duplicateAsNewRecipe)
// the moment a Series-less recipe's Product Type is picked for the first
// time, so a brand-new recipe reaches "+ New Trial" without ever needing a
// separate Duplicate step. Same derivation as duplicateAsNewRecipe, just
// freezing the current recipe's own live values instead of a clone's.
function startTrialSeriesForRecipe(r){
  if(r.seriesId) return;
  const newSeq = suggestNextRecipeSeq(recipes, r.productType, r.id);
  const countryCode = recipeDestinationIso2(r) || '';
  const year = yearPrefix(r.date);
  const prodTypeCode = recipeProductTypeCode(r);
  const seriesKey = `${countryCode}${year}-${prodTypeCode}${newSeq}`;
  const seriesRef = doc(recipeSeriesCol, uid());
  const seriesDoc = {
    id: seriesRef.id, seriesKey, countryCode, year, productTypeCode: prodTypeCode,
    productType: r.productType || '', recipeSeq: newSeq, maxTrialNo: 1,
    firstTrialId: r.id, createdAt: Date.now(), createdBy: currentUser?.email || ''
  };
  r.seriesId = seriesRef.id;
  r.seriesKey = seriesKey;
  r.countryCode = countryCode;
  r.year = year;
  r.productTypeCode = prodTypeCode;
  r.recipeSeq = newSeq;
  r.trialNo = 1;
  r.sourceTrialId = null;
  setDoc(seriesRef, seriesDoc);
}

/* Called after the approver's credentials have already been verified and the
   recipe already deleted from Firestore (via approverAction) — this just
   updates local state and the UI to match. */
function deleteCurrent(){
  const r = getCurrent();
  if(!r) return;
  const deletedId = r.id;
  removeRecipe(deletedId);
  closeRecipe();
  renderSidebar();
  renderMain();
}

function materialTooltip(m){
  const lines = [
    `EN: ${m.nameEn}`,
    `TH: ${m.nameTh}`,
    m.vendorCode ? `Code: ${m.vendorCode}` : null,
    m.vendorName ? `Vendor: ${m.vendorName}` : null,
    m.manufacturer ? `Manufacturer: ${m.manufacturer}` : null,
    (m.price !== '' && m.price != null) ? `Price/kg: ฿${m.price}` : null,
    formatMoq(m.moq) ? `MOQ: ${formatMoq(m.moq)}` : null,
    m.usageNotes ? `Usage: ${m.usageNotes}` : null
  ].filter(Boolean);
  return lines.join('\n');
}

function hasUnresolvedIngredient(part){
  return part.ingredients.some(i => (i.name || '').trim() !== '' && !i.materialId);
}

function isSubsequence(query, text){
  let qi = 0;
  for(let i = 0; i < text.length && qi < query.length; i++){
    if(text[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

function fuzzyMaterialMatches(query, limit){
  const q = (query || '').trim().toLowerCase();
  if(!q) return [];
  const scored = ingredientMaster.map(m => {
    const label = materialLabel(m).toLowerCase();
    let score = 0;
    if(label.startsWith(q)) score = 3;
    else if(label.includes(q)) score = 2;
    else if(isSubsequence(q, label)) score = 1;
    return { m, score, label };
  }).filter(x => x.score > 0);
  scored.sort((a,b) => b.score - a.score || a.label.localeCompare(b.label));
  return scored.slice(0, limit || 8).map(x => x.m);
}


// Tears down the recipes Firestore listener and resets its load-state to
// empty — called from the shared sign-out handler in app.js, kept here so
// that handler doesn't need write access to bindings this module owns
// (same pattern as resetMaterialsState/resetTrialsState/resetRefListsState/resetProjectsState).
export function resetRecipesState(){
  if(unsubscribeRecipes){ unsubscribeRecipes(); unsubscribeRecipes = null; }
  recipesLoaded = false;
  recipes = [];
  currentId = null;
  unlockedRecipeId = null;
}

// Small exported setters for the places app.js's own code needs to change
// Recipes-owned state from outside this module (a plain `currentId = ...`/
// `unlockedRecipeId = ...` assignment from app.js isn't possible — ES
// modules can't reassign a sibling module's `let` binding from outside it).
export function openRecipe(id){
  if(id !== currentId) unlockedRecipeId = null;
  currentId = id;
}
export function closeRecipe(){
  currentId = null;
  unlockedRecipeId = null;
}
export function setRecipeEditSnapshotBefore(v){
  recipeEditSnapshotBefore = v;
}
// Duplicate Recipe unlocks the copy for immediate editing (unlike normal
// navigation, which locks every recipe until explicitly unlocked) — so this
// needs to set unlockedRecipeId to the new id directly, not via openRecipe's
// "null unless same id" rule.
export function setUnlockedRecipeId(id){
  unlockedRecipeId = id;
}
export function removeRecipe(id){
  recipes = recipes.filter(x => x.id !== id);
}
