// Recipes -- core module. Owns the recipes array, the Firestore listener,
// and the whole recipe editor (renderRecipeEditor / the Parts tree). Split
// out (it had grown past 5,200 lines, then past 3,400 even after that
// first split) into:
//   - recipes-data.js       -- pure data/model/geometry helpers, no DOM
//   - recipes-versions.js   -- Version History modal + preview
//   - recipes-list.js       -- the grid/sidebar list views
//   - recipes-print.js      -- Print view + free-text Description
//   - recipes-excel.js      -- Export Excel
//   - recipes-overview.js   -- Recipe Overview / BOM / costing table
//   - recipes-processes.js  -- Process Steps editor
//   - recipes-lifecycle.js  -- New Trial / Duplicate / delete actions
// renderRecipeEditor and the Parts tree renderers below are deliberately
// left as one large, unsplit block (same reasoning as trials.js's
// renderTrialsList) -- they call each other back and forth on almost
// every edit, so splitting them apart would mean real circular-dependency
// risk between sibling files, not just the safe "sibling → core"
// circularity the files above use.
import {
  escapeHtml, icon, uid, currentUser, mainFeatureView, setMainFeatureView,
  logActivityEvent, diffMainFields, showCloudError, playContentTransition,
  renderSidebar, formatActivityDateTime, recipesCol, projects, metaLists,
  metaItemName, productTypeCode, ingredientMaster, migrateTrialsFromRecipes,
  countryToIso2, guardNavigation,
  readOnlyIngredientTreeHtml, readOnlyProcessesHtml,
  renderMain,
  requestAuthConfirm, DELETE_APPROVER_EMAIL, approverRecipesCol,
  snapshotMainFields, blankProduct, scheduleProjectSave,
  findMaterialByLabel, materialLabel, formatMoq, resizeImageFile, wireModalOverlayClose, getRequirements,
  computePrepareWeight, isValidYieldPct, partPrepareWeight,
  setCompareSeriesPrefilter, moveToTrash
} from './app.js';
import {
  onSnapshot, doc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  blankPart, blankIngredient, blankRecipe, migrateRecipe, saveRecipeToCloud, findProjectForRecipe,
  yearPrefix, recipeDestinationIso2, recipeProductTypeCode, suggestNextRecipeSeq,
  trialNoDisplay, fullCode, recipeDisplayLabel, descriptionListHtml,
  recomputeFromWeights, partTotalWeight, partIngredients, partSubParts, itemWeight,
  allIngredientsInRecipe, collectIngredientsWithPrepareWeight,
  scaleIngredientsInPart, siblingsWeightExcluding, isPartOrDescendant,
  round2, formatWeight
} from './recipes-data.js';
import {
  versionsModalRecipe, openVersionsModal, renderVersionsList,
  pushVersionCheckpoint, scheduleVersionCheckpoint, cancelVersionCheckpoint
} from './recipes-versions.js';
import { renderDescPoints, renderDescPhotos, wireRecipeTranslateButton, renderPrintView } from './recipes-print.js';
import { exportRecipeToExcel } from './recipes-excel.js';
// Circular imports back to the four files split out below -- safe, same
// pattern proven throughout this session's other splits: every cross-call
// happens inside an event handler, never at module-evaluation time.
import { overviewHeaderRowHtml, renderOverview, costingMarginVisible, toggleOverviewSort, toggleCostingMarginVisible } from './recipes-overview.js';
import { renderProcesses } from './recipes-processes.js';
import { confirmAndCreateNewTrial, startTrialSeriesForRecipe, duplicateAsNewRecipe, deleteCurrent } from './recipes-lifecycle.js';
// recipes-excel.js imports costingMarginVisible straight from this file --
// a bare import above doesn't automatically re-export it, so this keeps
// that working.
export { costingMarginVisible };

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
// itself (purely a UI toggle), so it survives renderChildren() re-creating
// the row's DOM (on every add/delete/weight change) the same way
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
          <span class="tree-node-label">Formula Total</span>
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
      <div class="card-title">Components of Portion</div>
      <div class="process-comp-add-row">
        <div class="comp-multiselect" id="portionCompMultiselect">
          <button type="button" class="comp-multiselect-toggle" id="portionCompToggle">— Select parts to add —</button>
          <div class="comp-multiselect-panel" id="portionCompPanel"></div>
        </div>
        <button class="btn btn-sm" type="button" id="btnAddPortionComponent">+ Add</button>
      </div>
      <div style="overflow-x:auto;">
        <table class="process-comp-table">
          <thead>
            <tr>
              <th class="col-no">#</th>
              <th>Component</th>
              <th class="col-wt">Weight in Portion (g)</th>
              <th class="col-pct">% of Portion</th>
              <th class="col-tol">Tolerance (±%)</th>
              <th class="col-range">Range (g)</th>
              <th class="col-del"></th>
            </tr>
          </thead>
          <tbody id="portionComponentsBody"></tbody>
          <tfoot id="portionComponentsFoot">
            <tr>
              <td></td>
              <td>Total</td>
              <td class="col-wt" id="portionComponentsTotalWt"></td>
              <td class="col-pct" id="portionComponentsTotalPct"></td>
              <td></td>
              <td></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="batch-summary" style="margin-top:12px;">
        <div>
          <div class="batch-stat-label" title="Weight change during the final assembly/cook step, applied to the Total above -- e.g. 92% means the finished portion loses some weight">Yield % (final process)</div>
          <div class="batch-scale-row">
            <input type="number" id="f-portionYield" min="0" step="0.01" placeholder="e.g. 92">
          </div>
        </div>
        <div>
          <div class="batch-stat-label" title="Total above × Yield %">Final Weight (g)</div>
          <div class="batch-stat-value" id="portionFinalWeightDisplay">—</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">
        5. Process Steps
      </div>
      <div id="processesListWrap">
        <div class="processes-list" id="processesList"></div>
        <button class="btn btn-sm add-row-btn" id="btnAddProcess">+ Add Process</button>
      </div>

      <div id="printProcessesView" class="print-only compare-steps-col"></div>
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

  document.getElementById('f-portionYield').addEventListener('input', e => {
    r.portionYieldPct = e.target.value;
    renderPortionComponents(r);
    scheduleSave();
  });

  document.getElementById('portionCompToggle').addEventListener('click', () => {
    document.getElementById('portionCompPanel').classList.toggle('open');
  });
  document.getElementById('portionCompMultiselect').addEventListener('focusout', e => {
    if(e.currentTarget.contains(e.relatedTarget)) return;
    document.getElementById('portionCompPanel').classList.remove('open');
  });
  document.getElementById('btnAddPortionComponent').addEventListener('click', () => {
    const checked = [...document.querySelectorAll('#portionCompPanel input[type=checkbox]:checked')];
    if(checked.length === 0) return;
    // Weight always starts at 0 -- typed in by hand afterward, same as
    // every other row's own Weight (see renderPortionComponents).
    const flatParts = flattenPartsWithDepth(r.parts);
    checked.forEach(cb => {
      const entry = flatParts[+cb.value];
      if(!entry) return;
      const name = entry.kind === 'ingredient' ? (entry.ing.name || 'Untitled ingredient') : (entry.part.name || 'Untitled part');
      r.portionComponents.push({ id: uid(), name, weight: 0, tolerancePct: '' });
    });
    document.getElementById('portionCompPanel').classList.remove('open');
    renderPortionComponents(r);
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
    scheduleSave();
  });
  treeRootWtInput.addEventListener('blur', () => {
    refreshDisplays(r);
    treeRootWtInput.value = (r.batchWeight || 0).toFixed(2);
  });
  commitOnEnter(treeRootWtInput);
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
    toggleOverviewSort(key);
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
    toggleCostingMarginVisible();
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

// Shared by the lock banner's own "Unlock to Edit" button and the
// click-anywhere-to-unlock overlay below -- same password re-entry flow
// either way.
function promptUnlockRecipe(r){
  requestAuthConfirm(
    'Confirm Identity to Edit',
    `Enter your password to unlock editing for the recipe "${r.name || 'Untitled recipe'}"`,
    () => {
      setUnlockedRecipeId(r.id);
      setRecipeEditSnapshotBefore(snapshotMainFields(r, RECIPE_DIFF_FIELDS));
      renderMain();
    }
  );
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
    document.getElementById('btnUnlockEdit').addEventListener('click', () => promptUnlockRecipe(r));
    cards.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = true; });
    // A disabled form control never fires click/focus at all (that's what
    // disabled means), so clicking a locked field to edit it previously
    // just did nothing -- this transparent click-catcher sits on top of
    // every card instead, same password-prompt flow as the banner's own
    // button, reachable from anywhere in the form, not just that one
    // button up top.
    const overlay = document.createElement('div');
    overlay.className = 'recipe-lock-overlay';
    overlay.title = 'Click to unlock editing';
    overlay.addEventListener('click', () => promptUnlockRecipe(r));
    cards.appendChild(overlay);
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

// Same expand/collapse memory as manualPartCollapseState above, but
// persisted in localStorage (per-browser, not on the recipe document
// itself -- this is a viewing preference, not recipe data) so it survives
// a reload or reopening the recipe later, not just re-renders within the
// same page load. Keyed by recipe id + each Part's path (ancestor names
// joined by "/", since Parts have no stable id of their own to key by --
// same name-based identification this app already uses elsewhere, e.g.
// findPartByName). manualPartCollapseState (object-reference keyed) stays
// authoritative for the current page load since it can't suffer path
// collisions; this is only consulted as the fallback for a Part manualPart
// CollapseState doesn't know about yet (i.e. the first render after a
// fresh load).
function partCollapseStorageKey(recipeId){ return `forge_partCollapse_${recipeId}`; }
function loadPersistedPartCollapse(recipeId){
  try { return JSON.parse(localStorage.getItem(partCollapseStorageKey(recipeId)) || '{}'); } catch(e){ return {}; }
}
function savePersistedPartCollapse(recipeId, path, collapsed){
  try {
    const all = loadPersistedPartCollapse(recipeId);
    all[path] = collapsed;
    localStorage.setItem(partCollapseStorageKey(recipeId), JSON.stringify(all));
  } catch(e) {}
}

export function renderParts(r){
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
    renderPartNode(r, part, container, r.parts, false);
  });

  updateGrandTotal(r);
  updateTreeRoot(r);
  renderPortionComponents(r);
}

// "Components of Portion" -- a list (r.portionComponents) of Parts/
// Sub-parts/ingredients picked out of the recipe above, same
// pick-then-independently-edit pattern as a Process Step's own Components
// table (recipes-processes.js): "+ Add" just seeds a row's Name from
// whatever was checked, starting Weight at 0 -- every field from then on,
// including Weight, is typed in by hand, with nothing further tying it
// back to that source Part/Ingredient. % of Portion and Range are the only
// computed fields, both derived from the Weight column itself.

// Pressing Enter commits a number field the same way tabbing/clicking away
// does (blur) -- used by every weight/%/Yield field in the ingredient tree
// below, where the derived displays (Prepare WT., % of Recipe, sibling
// rows' own %, Grand Total, Overview) are deferred to blur rather than
// recomputed on every keystroke, so typing a new value doesn't flash
// through whatever % a half-typed number works out to along the way.
// `nextSelector`, when given, also moves focus to whichever matching field
// comes right after this one in the DOM -- spreadsheet-style "Enter moves
// to the cell below" -- e.g. '.ing-wt, .part-wt-display' covers both an
// ingredient row's own Formula WT. and a Part/Sub-part header's, since
// they visually share one column and Enter should walk down through both.
function commitOnEnter(el, nextSelector){
  el.addEventListener('keydown', e => {
    if(e.key !== 'Enter') return;
    el.blur();
    if(!nextSelector) return;
    const all = [...document.querySelectorAll(nextSelector)];
    const next = all[all.indexOf(el) + 1];
    if(next) next.focus();
  });
}

// Every Part (picking one aggregates everything nested inside it -- see
// partTotalWeight below) AND every individual ingredient, at any nesting
// depth, as one flat pre-order list with its depth -- used by the picker
// panel below both to indent as a tree and to address an entry by flat
// index (same order both places build it in, so a checkbox's index always
// lines up with this list). Each Part is followed by its own direct
// ingredients (an empty-name placeholder row skipped), then its Sub-parts,
// matching the ingredient tree's own reading order above.
function flattenPartsWithDepth(parts, depth = 0){
  let out = [];
  (parts || []).forEach(part => {
    out.push({ kind: 'part', part, depth });
    partIngredients(part).forEach(ing => {
      if((ing.name || '').trim() === '') return;
      out.push({ kind: 'ingredient', part, ing, depth: depth + 1 });
    });
    out = out.concat(flattenPartsWithDepth(partSubParts(part), depth + 1));
  });
  return out;
}

// Rounds each weight's share of totalWt to a 2-decimal percentage such
// that the WHOLE set sums to exactly 100.00 -- rounding every row
// independently (plain toFixed(2)) can land a hair off 100% (e.g.
// 100.01%) purely from rounding drift, which reads as a real mismatch even
// though nothing is actually wrong. Standard largest-remainder method:
// floor every row to its own 2-decimal value first (sum <= 100.00 by
// construction), then hand out the few leftover 0.01% increments to
// whichever rows got cut the most by that floor, largest first.
function largestRemainderPercentages(weights, totalWt){
  if(totalWt <= 0) return weights.map(() => 0);
  const units = weights.map(w => (parseFloat(w) || 0) / totalWt * 10000); // hundredths of a percent
  const floors = units.map(u => Math.floor(u));
  let remaining = Math.round(10000 - floors.reduce((s,v)=>s+v,0));
  const order = floors.map((_, i) => i).sort((a,b) => (units[b]-floors[b]) - (units[a]-floors[a]));
  const bump = new Set(order.slice(0, Math.max(0, remaining)));
  return floors.map((f, i) => (f + (bump.has(i) ? 1 : 0)) / 100);
}

function renderPortionComponents(r){
  const body = document.getElementById('portionComponentsBody');
  if(!body) return;

  const yieldInput = document.getElementById('f-portionYield');
  if(yieldInput && document.activeElement !== yieldInput) yieldInput.value = r.portionYieldPct ?? '';
  const effectiveYield = (() => {
    const y = parseFloat(r.portionYieldPct);
    return (isFinite(y) && y > 0) ? y : 100;
  })();

  // Picker panel -- every Part/Sub-part AND every individual ingredient, at
  // any nesting depth, shown as an indented tree matching the ingredient
  // tree above (own name only -- depth/indent already shows the nesting,
  // no need for a breadcrumb). Picking a Part aggregates everything
  // nested inside it (see partTotalWeight below); picking an ingredient
  // adds just that one line. Which checkboxes are ticked lives
  // only on the checkboxes themselves (no shadow Set to keep in sync) --
  // simplest way to guarantee the "+ Add" button always acts on exactly
  // what's visibly checked, even if this whole table gets rebuilt (e.g.
  // Portion Weight changes) while a selection is in progress.
  const panel = document.getElementById('portionCompPanel');
  const toggle = document.getElementById('portionCompToggle');
  if(panel && toggle){
    const flatParts = flattenPartsWithDepth(r.parts);
    panel.innerHTML = flatParts.length ? flatParts.map((entry, idx) => {
      const name = entry.kind === 'ingredient' ? entry.ing.name : (entry.part.name || 'Untitled part');
      return `
      <label class="comp-multiselect-item" style="padding-left:${12 + entry.depth*20}px;">
        <input type="checkbox" value="${idx}">
        <span>${entry.depth > 0 ? '↳ ' : ''}${escapeHtml(name)}</span>
      </label>
    `;
    }).join('') : '<div class="comp-multiselect-empty">No parts yet</div>';
    panel.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', updatePortionToggleLabel);
    });
    updatePortionToggleLabel();
  }

  // Weight is directly editable (see the row loop below) -- purely manual,
  // starting at 0 when a row is added (see "+ Add" above). % of Portion is
  // always a row's share of the CURRENT Weights' own total (always sums to
  // 100%, same idea as a Process Step's own Components table). Final
  // Weight applies the Yield % below to that Total -- the actual finished
  // weight after the last assembly/cook step.
  // Also refreshes every OTHER row's own % cell (see rowRefs below) --
  // % of Portion is each row's share of the CURRENT total, so editing any
  // one row's Weight moves everyone else's % too, not just its own.
  // Rebuilding the % values in place like this (rather than a full
  // body.innerHTML re-render) is what lets typing into a Weight/% field
  // keep its focus/cursor instead of getting reset on every keystroke.
  const rowRefs = []; // { comp, pctInput, updateRange } -- filled in by the row loop below
  function refreshPercentsAndTotals(){
    const totalWt = r.portionComponents.reduce((s,c)=>s+(parseFloat(c.weight)||0),0);
    const pcts = largestRemainderPercentages(r.portionComponents.map(c=>c.weight), totalWt);
    rowRefs.forEach(({ pctInput, updateRange }, i) => {
      if(document.activeElement !== pctInput) pctInput.value = pcts[i].toFixed(2);
      updateRange();
    });
    const totalWtEl = document.getElementById('portionComponentsTotalWt');
    const totalPctEl = document.getElementById('portionComponentsTotalPct');
    const finalWtEl = document.getElementById('portionFinalWeightDisplay');
    if(totalWtEl && totalPctEl){
      const totalPct = pcts.reduce((s,p)=>s+p,0);
      totalWtEl.textContent = formatWeight(totalWt);
      totalPctEl.textContent = totalPct.toFixed(2) + '%';
    }
    if(finalWtEl){
      finalWtEl.textContent = formatWeight(totalWt * effectiveYield / 100);
    }
  }

  body.innerHTML = '';
  if(r.portionComponents.length === 0){
    refreshPercentsAndTotals();
    body.innerHTML = '<tr><td colspan="7"><div class="overview-empty">No components added yet — select a part above and click "+ Add"</div></td></tr>';
    return;
  }
  r.portionComponents.forEach((comp, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-no">${idx+1}</td>
      <td><input type="text" class="comp-name"></td>
      <td class="col-wt"><input type="number" class="comp-wt num-input" step="0.01" min="0"></td>
      <td class="col-pct"><input type="number" class="comp-pct num-input" step="0.01" min="0"></td>
      <td class="col-tol"><input type="number" class="comp-tol num-input" step="0.01" min="0"></td>
      <td class="col-range comp-range"></td>
      <td class="col-del"><button class="icon-btn" title="Delete">${icon('x')}</button></td>
    `;
    const nameInput = tr.querySelector('.comp-name');
    const wtInput2 = tr.querySelector('.comp-wt');
    const tolInput = tr.querySelector('.comp-tol');
    const pctInput = tr.querySelector('.comp-pct');
    const rangeCell = tr.querySelector('.comp-range');
    nameInput.value = comp.name || '';
    if(document.activeElement !== wtInput2) wtInput2.value = (parseFloat(comp.weight) || 0).toFixed(2);
    tolInput.value = comp.tolerancePct ?? '';

    function updateRange(){
      const wt = parseFloat(comp.weight) || 0;
      const tol = parseFloat(tolInput.value) || 0;
      if(tol <= 0){ rangeCell.textContent = '—'; return; }
      const delta = round2(wt * tol / 100);
      rangeCell.textContent = `${(wt-delta).toFixed(2)}-${(wt+delta).toFixed(2)} g`;
    }
    rowRefs.push({ comp, pctInput, updateRange });

    nameInput.addEventListener('input', e => { comp.name = e.target.value; scheduleSave(); });
    // Editing Weight directly does NOT touch syncedSourceWeight -- so this
    // sticks until the linked source (or Portion Weight) actually changes,
    // see the live-resolve pass above.
    wtInput2.addEventListener('input', e => {
      comp.weight = parseFloat(e.target.value) || 0;
      refreshPercentsAndTotals();
      scheduleSave();
    });
    // Reformats to 2 decimals once you leave the field -- left as whatever
    // was typed (e.g. "18", not "18.00") otherwise, since refreshing it on
    // every keystroke would fight the cursor.
    wtInput2.addEventListener('blur', () => { wtInput2.value = (parseFloat(comp.weight) || 0).toFixed(2); });
    // Back-solves Weight from the typed %, holding every OTHER row's own
    // Weight fixed -- pct = w / (w + others), so w = pct * others /
    // (1 - pct) -- same math as an ingredient row's own %-drives-weight
    // field. No solution when this is the only row with any weight
    // (others === 0, already at 100% at any weight) -- left alone, same
    // edge case as that ingredient field too.
    pctInput.addEventListener('input', e => {
      const pct = parseFloat(e.target.value);
      const others = r.portionComponents.reduce((s,c,i2) => i2 === idx ? s : s+(parseFloat(c.weight)||0), 0);
      const f = pct / 100;
      if(others > 0 && isFinite(f) && f >= 0 && f < 1){
        comp.weight = round2(f * others / (1 - f));
        wtInput2.value = comp.weight.toFixed(2);
      }
      refreshPercentsAndTotals();
      scheduleSave();
    });
    pctInput.addEventListener('blur', refreshPercentsAndTotals);
    tolInput.addEventListener('input', e => { comp.tolerancePct = e.target.value; updateRange(); scheduleSave(); });
    tr.querySelector('.icon-btn').addEventListener('click', () => {
      r.portionComponents.splice(idx, 1);
      renderPortionComponents(r);
      scheduleSave();
    });

    body.appendChild(tr);
  });
  refreshPercentsAndTotals();
}

function updatePortionToggleLabel(){
  const toggle = document.getElementById('portionCompToggle');
  if(!toggle) return;
  const n = document.querySelectorAll('#portionCompPanel input[type=checkbox]:checked').length;
  toggle.textContent = n === 0 ? '— Select parts to add —' : `${n} selected`;
  toggle.classList.toggle('has-selection', n > 0);
}

// Renders one Part — and, recursively, every Sub-part nested inside it — as
// a branch of the tree. The exact same function handles a top-level Part
// (siblingsArray = r.parts, isNested = false, since the recipe root holds
// no ingredients of its own, only Parts) and a Sub-part nested inside
// another Part (siblingsArray = parentPart.items, isNested = true) — the
// %/weight math only cares about "everything else at my own level", not
// whether that level happens to be the recipe root or another Part.
// A Part's own children (ingredients AND Sub-parts, interleaved in any
// order) live in `part.items`, one array instead of two -- see
// recipes-data.js's blankIngredient/blankPart/partIngredients/partSubParts.
// `getAncestorMultiplier` is a 0-arg function, not a plain number -- every
// ancestor Part's own Yield can change independently AFTER this row is
// first rendered (any edit anywhere just re-runs partDisplayUpdaters, see
// refreshDisplays), so each level composes a NEW closure over its parent's
// getter and this Part's own `prepYieldPct`, read live on every call,
// rather than a number baked in once at initial render that could go
// stale. Defaults to "no ancestors" (1) for a top-level Part.
// `parentPath` is this Part's ancestors' own names joined by "/" (empty
// for a top-level Part) -- used only to build this Part's own persisted
// collapse-state key (see savePersistedPartCollapse/manualPartCollapseState
// above), since Parts have no stable id of their own.
function renderPartNode(r, part, container, siblingsArray, isNested, getAncestorMultiplier = () => 1, parentPath = ''){
  const partPath = parentPath + '/' + (part.name || 'Untitled');
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
      <div class="part-children tree-children"></div>
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
  // `dragPayload` is the SAME shape (`{ item, sourceArray }`) for a Part or
  // an ingredient -- which one it is reads off `item.kind`, so every drop
  // target below handles both with one code path instead of branching on a
  // separate `type` field.
  dragHandle.addEventListener('dragstart', e => {
    dragPayload = { item: part, sourceArray: siblingsArray };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'part');
    block.classList.add('dragging');
  });
  dragHandle.addEventListener('dragend', () => {
    block.classList.remove('dragging');
    dragPayload = null;
  });

  // Drop TARGET: this Part's title bar, split into three vertical zones so
  // "move up/down as a sibling" and "nest inside" are reachable from the
  // same target: the top slice inserts the dragged item as a sibling
  // BEFORE this Part (in `siblingsArray`), the bottom slice AFTER, and the
  // middle nests it inside this Part's own `items` (at the end). Dropping
  // an ingredient on a TOP-LEVEL Part's header (siblingsArray is r.parts,
  // which only ever holds Parts) always nests it "into" regardless of
  // which third it lands in -- there's no such thing as an ingredient
  // sibling of a top-level Part. A dragged ingredient onto a NESTED Part's
  // header can use all three zones, same as a Part payload, since a nested
  // Part's own siblingsArray (its parent's `items`) legitimately mixes
  // ingredients and Sub-parts.
  function partDropZone(e){
    const rect = headerEl.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / rect.height;
    if(relY < 0.3) return 'before';
    if(relY > 0.7) return 'after';
    return 'into';
  }
  function effectiveDropZone(e, draggedItem){
    if(draggedItem.kind === 'ingredient' && !isNested) return 'into';
    return partDropZone(e);
  }

  headerEl.addEventListener('dragover', e => {
    if(!dragPayload) return;
    const draggedItem = dragPayload.item;
    if(draggedItem === part) return;
    // Dropping a Part onto ITSELF or onto one of ITS OWN descendants would
    // nest it inside itself — check whether the drop TARGET (this `part`)
    // is the dragged Part or reachable by descending from it, not the
    // other way around. Applies to all three zones alike: inserting
    // draggedPart as a sibling of one of its own descendants is exactly as
    // cyclic as nesting it inside one directly.
    if(draggedItem.kind === 'part' && isPartOrDescendant(part, draggedItem)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    headerEl.classList.remove('drop-target', 'drop-before', 'drop-after');
    const zone = effectiveDropZone(e, draggedItem);
    headerEl.classList.add(zone === 'before' ? 'drop-before' : zone === 'after' ? 'drop-after' : 'drop-target');
  });
  headerEl.addEventListener('dragleave', () => {
    headerEl.classList.remove('drop-target', 'drop-before', 'drop-after');
  });
  headerEl.addEventListener('drop', e => {
    e.preventDefault();
    headerEl.classList.remove('drop-target', 'drop-before', 'drop-after');
    if(!dragPayload) return;
    const draggedItem = dragPayload.item;
    if(draggedItem === part){ dragPayload = null; return; }
    if(draggedItem.kind === 'part' && isPartOrDescendant(part, draggedItem)){ dragPayload = null; return; }
    const zone = effectiveDropZone(e, draggedItem);
    const sourceArray = dragPayload.sourceArray;
    const idx = sourceArray.indexOf(draggedItem);
    if(idx === -1){ dragPayload = null; return; }
    sourceArray.splice(idx, 1);
    // Same safety net as deleting the last ingredient by hand — a Part
    // never sits completely empty, always at least one blank row to type
    // into. Only meaningful for an ingredient leaving a Part's own `items`
    // -- never applies to r.parts (a Part leaving the recipe root), which
    // has its own separate "can't delete the last top-level Part" floor.
    if(draggedItem.kind === 'ingredient' && sourceArray.length === 0) sourceArray.push(blankIngredient());
    if(zone === 'into'){
      part.items.push(draggedItem);
    } else {
      // Insert as a sibling of `part` within its own containing array —
      // re-found by reference AFTER the removal above, since if
      // draggedItem came from this very array, `part`'s own index may
      // have shifted down by one.
      let targetIdx = siblingsArray.indexOf(part);
      if(zone === 'after') targetIdx += 1;
      siblingsArray.splice(targetIdx, 0, draggedItem);
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

  const childrenContainer = block.querySelector('.part-children');
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
    scheduleSave();
  });
  partWtInput.addEventListener('blur', () => {
    refreshDisplays(r);
    partWtInput.value = partTotalWeight(part).toFixed(2);
  });
  commitOnEnter(partWtInput, '.ing-wt, .part-wt-display');
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
    const othersWeight = siblingsWeightExcluding(siblingsArray, part);
    const f = targetPct / 100;
    if(othersWeight > 0 && f < 1){
      scalePartTo(f * othersWeight / (1 - f));
    }
    scheduleSave();
  });
  partPctInput.addEventListener('blur', () => {
    refreshDisplays(r);
    partPctInput.value = (part.percent || 0).toFixed(2);
  });
  commitOnEnter(partPctInput, '.ing-pct-display, .part-pct-display');
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
    scheduleSave();
  });
  partYieldInput.addEventListener('blur', () => refreshDisplays(r));
  commitOnEnter(partYieldInput);

  function setCollapsed(collapsed){
    block.classList.toggle('collapsed', collapsed);
    toggleBtn.classList.toggle('open', !collapsed);
    toggleBtn.innerHTML = icon(collapsed ? 'chevron-right' : 'chevron-down');
  }

  toggleBtn.addEventListener('click', () => {
    const next = !block.classList.contains('collapsed');
    setCollapsed(next);
    manualPartCollapseState.set(part, next);
    savePersistedPartCollapse(r.id, partPath, next);
  });

  const hasContent = partIngredients(part).some(i => (i.name || '').trim() !== '') || partSubParts(part).length > 0;
  // manualPartCollapseState (this page load, object-ref keyed) wins when
  // it knows about this exact Part; otherwise fall back to whatever was
  // persisted last time this recipe was open (path-keyed, survives a
  // reload), and only default to "collapsed only if empty" if neither has
  // ever recorded a choice for this Part.
  const persisted = loadPersistedPartCollapse(r.id)[partPath];
  const initialCollapsed = manualPartCollapseState.has(part)
    ? manualPartCollapseState.get(part)
    : (persisted !== undefined ? persisted : !hasContent);
  setCollapsed(initialCollapsed);

  // One item at a time, in `part.items`' own order -- an ingredient
  // (`buildIngredientRow`) or a nested Sub-part (a recursive
  // `renderPartNode` call, same as before) can now sit in any position
  // relative to each other, not "every ingredient, then every Sub-part".
  function renderChildren(){
    childrenContainer.innerHTML = '';
    part.items.forEach((item, idx) => {
      if(item.kind === 'part'){
        renderPartNode(r, item, childrenContainer, part.items, true, getOwnMultiplier, partPath);
      } else {
        buildIngredientRow(item, idx);
      }
    });
    updatePartSubtotal();
  }

  function buildIngredientRow(ing, idx){
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

      ingDragHandle.addEventListener('dragstart', e => {
        dragPayload = { item: ing, sourceArray: part.items };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'ingredient');
        branch.classList.add('dragging');
      });
      ingDragHandle.addEventListener('dragend', () => {
        branch.classList.remove('dragging');
        dragPayload = null;
      });

      // Drop TARGET: reorder relative to this row — top half inserts the
      // dragged item just before it, bottom half just after, into THIS
      // Part's own `items` (removing it from wherever it came from first,
      // same reference-based re-find as the Part header's own drop
      // handler). Accepts either an ingredient OR a Sub-part being dragged
      // here -- a Sub-part landing between two ingredient rows is exactly
      // the interleaving this whole items-array design exists for.
      const rowEl = branch.querySelector('.ing-edit-row');
      rowEl.addEventListener('dragover', e => {
        if(!dragPayload || dragPayload.item === ing) return;
        // A Part being dropped where `part` (this row's own container) is
        // that Part or one of its own descendants would nest it inside
        // itself -- same cyclic-tree guard the Part header's own drop
        // target uses.
        if(dragPayload.item.kind === 'part' && isPartOrDescendant(part, dragPayload.item)) return;
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
        if(!dragPayload) return;
        const draggedItem = dragPayload.item;
        if(draggedItem === ing){ dragPayload = null; return; }
        if(draggedItem.kind === 'part' && isPartOrDescendant(part, draggedItem)){ dragPayload = null; return; }
        const sourceArray = dragPayload.sourceArray;
        const sourceIdx = sourceArray.indexOf(draggedItem);
        if(sourceIdx === -1){ dragPayload = null; return; }
        sourceArray.splice(sourceIdx, 1);
        if(draggedItem.kind === 'ingredient' && sourceArray.length === 0){
          sourceArray.push(blankIngredient());
        }
        // Re-found by reference AFTER the removal above, since if the
        // dragged item came from this same Part, this row's own
        // index may have shifted down by one.
        let targetIdx = part.items.indexOf(ing);
        if(!before) targetIdx += 1;
        part.items.splice(targetIdx, 0, draggedItem);
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
        scheduleSave();
      });
      wtInput.addEventListener('blur', () => {
        refreshDisplays(r);
        wtInput.value = (parseFloat(ing.weight) || 0).toFixed(2);
      });
      commitOnEnter(wtInput, '.ing-wt, .part-wt-display');
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
        const othersWeight = part.items.reduce((s,item) => item === ing ? s : s+itemWeight(item), 0);
        const f = targetPct / 100;
        if(othersWeight > 0 && f < 1){
          ing.weight = round2(f * othersWeight / (1 - f));
          wtInput.value = (parseFloat(ing.weight) || 0).toFixed(2);
        }
        scheduleSave();
      });
      pctDisplay.addEventListener('blur', () => {
        refreshDisplays(r);
        pctDisplay.value = (ing.percent || 0).toFixed(2);
      });
      commitOnEnter(pctDisplay, '.ing-pct-display, .part-pct-display');
      let pctJustFocused = false;
      pctDisplay.addEventListener('mousedown', () => { pctJustFocused = document.activeElement !== pctDisplay; });
      pctDisplay.addEventListener('focus', () => pctDisplay.select());
      pctDisplay.addEventListener('mouseup', e => {
        if(pctJustFocused){ e.preventDefault(); pctJustFocused = false; }
      });

      delBtn.addEventListener('click', () => {
        const delIdx = part.items.indexOf(ing);
        if(delIdx !== -1) part.items.splice(delIdx, 1);
        if(part.items.length === 0) part.items.push(blankIngredient());
        renderChildren();
        refreshDisplays(r);
        renderProcesses(r); // drop the deleted ingredient from the "Add Component" picker
        scheduleSave();
      });

      childrenContainer.appendChild(branch);
  }

  function updatePartSubtotal(){
    const namedCount = partIngredients(part).filter(i => (i.name||'').trim() !== '').length;
    const subCount = partSubParts(part).length;
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

  renderChildren();

  addIngBtn.addEventListener('click', () => {
    if(hasUnresolvedIngredient(part)){
      alert('This part has an ingredient that is not yet in the library. Please select from the library or add it first before adding the next row.');
      return;
    }
    part.items.push(blankIngredient());
    renderChildren();
    refreshDisplays(r);
    scheduleSave();
  });

  addSubpartBtn.addEventListener('click', () => {
    part.items.push(blankPart(''));
    renderParts(r);
    renderProcesses(r); // add the new sub-part's ingredients to the "Add Component" picker
    scheduleSave();
  });

  const deletePartBtn = block.querySelector('.part-header .icon-btn');
  if(!isNested && siblingsArray.length <= 1){
    // A recipe always needs at least one top-level Part to hold anything —
    // Sub-parts nested inside a Part have no such floor, since that Part
    // can always fall back to its own direct ingredients instead.
    deletePartBtn.style.display = 'none';
  } else {
    deletePartBtn.addEventListener('click', () => {
      if(!confirm(`Delete "${part.name || 'this part'}" and everything inside it?`)) return;
      const idx = siblingsArray.indexOf(part);
      if(idx !== -1) siblingsArray.splice(idx, 1);
      renderParts(r);
      renderProcesses(r); // drop the deleted part's ingredients from the "Add Component" picker
      scheduleSave();
    });
  }

  partDisplayUpdaters.push(() => {
    updatePartSubtotal();
    // Direct children of childrenContainer are appended in the exact same
    // order as part.items (see renderChildren above), so childEls[idx]
    // always corresponds to part.items[idx] -- reading DOM elements this
    // way (instead of a flat childrenContainer.querySelectorAll(...), which
    // would also match ingredient rows belonging to a nested Sub-part
    // rendered inside this same container) keeps this update scoped to
    // this Part's own direct ingredient rows, never a descendant Sub-part's
    // -- that Sub-part already refreshes itself via its own
    // partDisplayUpdaters entry.
    const childEls = childrenContainer.children;
    part.items.forEach((item, idx) => {
      if(item.kind === 'part') return;
      const rowEl = childEls[idx];
      if(!rowEl) return;
      const ing = item;
      // Skip the field the user is actively typing into — reformatting it
      // mid-keystroke (e.g. "30" -> "30.00" before they can type "30.5")
      // would fight with their typing. It gets its own precise value on
      // blur instead (see the pctDisplay/wtInput 'blur' handlers above).
      // Weight also needs refreshing here (not just %): scaling this Part
      // from its own header field, or a sibling ingredient's own % field,
      // changes every ingredient's .weight without touching its <input>
      // directly, same reason wtEl needs refreshing here too.
      const pctEl = rowEl.querySelector('.ing-pct-display');
      if(pctEl && document.activeElement !== pctEl) pctEl.value = (ing.percent||0).toFixed(2);
      const wtEl = rowEl.querySelector('.ing-wt');
      if(wtEl && document.activeElement !== wtEl) wtEl.value = (parseFloat(ing.weight)||0).toFixed(2);
      const prepareEl = rowEl.querySelector('.ing-prepare-display');
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

function materialTooltip(m){
  const lines = [
    `EN: ${m.nameEn}`,
    `TH: ${m.nameTh}`,
    m.vendorCode ? `Code: ${m.vendorCode}` : null,
    m.vendorName ? `Vendor: ${m.vendorName}` : null,
    m.manufacturer ? `Manufacturer: ${m.manufacturer}` : null,
    (m.price !== '' && m.price != null) ? `Price/kg: ฿${m.price}${m.priceIsIdea ? ' (Idea Price — not confirmed)' : ''}` : null,
    formatMoq(m.moq) ? `MOQ: ${formatMoq(m.moq)}` : null,
    m.usageNotes ? `Usage: ${m.usageNotes}` : null
  ].filter(Boolean);
  return lines.join('\n');
}

function hasUnresolvedIngredient(part){
  return partIngredients(part).some(i => (i.name || '').trim() !== '' && !i.materialId);
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
