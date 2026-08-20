import {
  escapeHtml, icon, uid, currentUser, mainFeatureView, setMainFeatureView,
  logActivityEvent, diffMainFields, showCloudError, playContentTransition,
  renderSidebar, formatActivityDateTime, recipesCol, projects, metaLists,
  metaItemName, productTypeCode, ingredientMaster, migrateTrialsFromRecipes,
  countryToIso2, guardNavigation, recomputeFromWeights,
  readOnlyIngredientTreeHtml, readOnlyProcessesHtml,
  renderReadOnlyProcessFlowchart, allIngredientsInRecipe, formatWeight,
  renderMain
} from './app.js';
import {
  onSnapshot, setDoc, doc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export let recipes = [];
export let currentId = null;
export let unlockedRecipeId = null;

/* ---------- Version History (snapshot & restore the recipe's formulation) ---------- */
export let versionsModalRecipe = null;

/* Only the BOM-relevant fields are snapshotted — trial photos are excluded
   to keep each version small (photos alone could approach Firestore's 1MB
   doc limit across a few saved versions). */
export function snapshotRecipeCore(r){
  return {
    name: r.name,
    code: r.code,
    date: r.date,
    description: JSON.parse(JSON.stringify(r.description)),
    batchWeight: r.batchWeight,
    parts: JSON.parse(JSON.stringify(r.parts)),
    processes: JSON.parse(JSON.stringify(r.processes)),
    processFlowchart: r.processFlowchart ? JSON.parse(JSON.stringify(r.processFlowchart)) : { nodes: [], edges: [] },
    processViewMode: r.processViewMode || 'list',
    yieldPct: r.yieldPct
  };
}

export function openVersionsModal(r){
  versionsModalRecipe = r;
  document.getElementById('versionLabelInput').value = '';
  renderVersionsList(r);
  document.getElementById('versionsModalOverlay').classList.add('open');
}

export function closeVersionsModal(){
  document.getElementById('versionsModalOverlay').classList.remove('open');
}

export function renderVersionsList(r){
  const listEl = document.getElementById('versionsList');
  if(!Array.isArray(r.versions) || r.versions.length === 0){
    listEl.innerHTML = '<div class="overview-empty">No versions saved yet</div>';
    return;
  }
  const sorted = [...r.versions].sort((a,b) => b.savedAt - a.savedAt);
  listEl.innerHTML = sorted.map(v => `
    <div class="version-item" data-id="${escapeHtml(v.id)}">
      <div>
        <div class="version-item-label">${escapeHtml(v.label || 'Untitled version')}</div>
        <div class="version-item-date">${escapeHtml(new Date(v.savedAt).toLocaleString())}</div>
      </div>
      <div class="version-item-actions">
        <button class="btn btn-sm" data-role="preview-version">Preview</button>
        <button class="btn btn-sm" data-role="restore-version">Restore</button>
        <button class="icon-btn" data-role="delete-version" title="Delete this version">${icon('x')}</button>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('[data-role="preview-version"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.version-item').dataset.id;
      const v = r.versions.find(x => x.id === id);
      if(v) openVersionPreview(r, v);
    });
  });
  listEl.querySelectorAll('[data-role="restore-version"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.version-item').dataset.id;
      const v = r.versions.find(x => x.id === id);
      if(v) restoreVersion(r, v);
    });
  });
  listEl.querySelectorAll('[data-role="delete-version"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.version-item').dataset.id;
      r.versions = r.versions.filter(x => x.id !== id);
      renderVersionsList(r);
      scheduleSave();
    });
  });
}

// Shared by the Versions list's own Restore button and the Preview modal's
// Restore button, so restoring a version behaves identically regardless of
// which one the user reached it from.
export function restoreVersion(r, v){
  if(!confirm(`Restore version "${v.label || 'Untitled version'}"? This overwrites the recipe's current name, description, ingredients, process steps/components, and yield (trial photos are not affected).`)) return;
  Object.assign(r, JSON.parse(JSON.stringify(v.snapshot)));
  migrateRecipe(r);
  closeVersionPreview();
  closeVersionsModal();
  renderMain();
  scheduleSave();
}

export let versionPreviewContext = null;

// Read-only look at a saved version before committing to Restore — reuses
// the same tree/process markup as the live editor and the print view, just
// fed from the version's frozen snapshot instead of the live recipe.
export function openVersionPreview(r, v){
  versionPreviewContext = { recipe: r, version: v };
  const snap = v.snapshot || {};
  const totalWt = allIngredientsInRecipe(snap).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);

  const snapFlowchart = snap.processFlowchart || { nodes: [], edges: [] };
  const isFlowMode = snap.processViewMode === 'flowchart' && snapFlowchart.nodes.length > 0;

  document.getElementById('versionPreviewTitle').textContent = v.label || 'Untitled version';
  document.getElementById('versionPreviewContent').innerHTML = `
    <div class="reflist-item-meta" style="margin-bottom:12px;">Saved ${escapeHtml(new Date(v.savedAt).toLocaleString())}</div>
    <div class="compare-info-col">
      <div class="ci-name">${escapeHtml(snap.name || 'Untitled recipe')}</div>
      <div class="ci-row"><b>Code:</b> ${escapeHtml(snap.code || '-')}</div>
      <div class="ci-row"><b>Date:</b> ${escapeHtml(snap.date || '-')}</div>
      <div class="ci-row"><b>Total weight:</b> ${formatWeight(totalWt)}</div>
      ${descriptionListHtml(snap)}
    </div>
    <div class="overview-title" style="margin-top:16px;">Ingredients</div>
    ${readOnlyIngredientTreeHtml(snap.parts, totalWt, snapFlowchart.nodes)}
    <div class="overview-title" style="margin-top:16px;">Process Steps</div>
    ${isFlowMode ? '<div id="versionPreviewFlowchart"></div>' : `<div class="compare-steps-col">${readOnlyProcessesHtml(snap.processes)}</div>`}
  `;
  document.getElementById('versionPreviewModalOverlay').classList.add('open');
  if(isFlowMode){
    renderReadOnlyProcessFlowchart(document.getElementById('versionPreviewFlowchart'), snapFlowchart, snap.processes);
  }
}

export function closeVersionPreview(){
  document.getElementById('versionPreviewModalOverlay').classList.remove('open');
  versionPreviewContext = null;
}

export function initVersionPreviewModal(){
  document.getElementById('btnCloseVersionPreviewModal').addEventListener('click', closeVersionPreview);
  document.getElementById('btnCloseVersionPreviewModal2').addEventListener('click', closeVersionPreview);
  document.getElementById('versionPreviewModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'versionPreviewModalOverlay') closeVersionPreview();
  });
  document.getElementById('btnRestoreFromPreview').addEventListener('click', () => {
    if(!versionPreviewContext) return;
    restoreVersion(versionPreviewContext.recipe, versionPreviewContext.version);
  });
}

export function initVersionsModal(){
  document.getElementById('btnCloseVersionsModal').addEventListener('click', closeVersionsModal);
  document.getElementById('versionsModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'versionsModalOverlay') closeVersionsModal();
  });
  document.getElementById('btnSaveVersion').addEventListener('click', () => {
    const r = versionsModalRecipe;
    if(!r) return;
    const label = document.getElementById('versionLabelInput').value.trim();
    pushVersionCheckpoint(r, label);
    document.getElementById('versionLabelInput').value = '';
    renderVersionsList(r);
    scheduleSave();
  });
}

export let unsubscribeRecipes = null;
export let recipesLoaded = false;

export const RECIPE_DIFF_FIELDS = { name: 'Product Name', code: 'Trial/Reference Code', productType: 'Product Type', recipeSeq: 'Recipe Sequence', date: 'Date', batchWeight: 'Batch Weight', yieldPct: 'Yield %' };

export let recipeEditSnapshotBefore = null;

/* Wires a "pick from the shared list" field (Customer Name, Destination
   Country, Sales Rep). New values can no longer be added by just typing
   them here — that used to silently grow the shared list from free text,
   which the Reference Lists screen is meant to curate deliberately.
   Typing something not already in the list reverts the field and points
   the user at 📇 Reference Lists instead. The trash button just clears
   this recipe's own field. */
/* A recipe's link to a Project isn't a field on the recipe itself - it's
   read from whichever Project (if any) has a product entry whose recipeId
   matches, so the Project's own products list stays the single source of
   truth instead of two places that could drift out of sync. */
export function findProjectForRecipe(recipeId){
  for(const proj of projects){
    const prod = (proj.products || []).find(x => x.recipeId === recipeId);
    if(prod) return { project: proj, product: prod };
  }
  return null;
}

export function renderLinkedProjectSection(r){
  const select = document.getElementById('f-linkedProject');
  if(!select) return;
  const link = findProjectForRecipe(r.id);
  const sortedProjects = [...projects].sort((a,b) => (a.name||'').localeCompare(b.name||'', undefined, {sensitivity:'base'}));
  select.innerHTML = `<option value="">— Not linked —</option>` +
    sortedProjects.map(p => `<option value="${escapeHtml(p.id)}" ${link && link.project.id === p.id ? 'selected' : ''}>${escapeHtml(p.name || 'Untitled project')}</option>`).join('');

  const infoEl = document.getElementById('linkedProjectInfo');
  if(!link){
    infoEl.innerHTML = '';
    return;
  }
  const { project, product } = link;
  const facts = [
    project.customerName ? `<b>Customer:</b> ${escapeHtml(project.customerName)}` : '',
    project.destinationCountry ? `<b>Destination:</b> ${escapeHtml(project.destinationCountry)}` : '',
    project.ownerSalesRep ? `<b>Project Owner:</b> ${escapeHtml(project.ownerSalesRep)}` : '',
    project.factoryName ? `<b>Factory:</b> ${escapeHtml(project.factoryName)}` : '',
    `<b>Stage:</b> ${escapeHtml(product.stage || '-')}`
  ].filter(Boolean);
  infoEl.innerHTML = `<div class="ci-row" style="margin-top:6px;">${facts.join(' &nbsp;|&nbsp; ')}</div>`;
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
  badge.textContent = recipeProductTypeCode(r) || 'TTT';
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

export const PART_COUNT = 4;

export function blankPart(name){
  return { name, ingredients: [ { name:"", percent:0, weight:0, note:"" } ], parts: [] };
}

export function blankRecipe(){
  return {
    id: uid(),
    name: "",
    code: "",
    productType: "",
    recipeSeq: "",
    date: new Date().toISOString().slice(0,10),
    customerName: "",
    destinationCountry: "",
    salesRep: "",
    description: [],
    descPhotos: [],
    batchWeight: 1000,
    parts: [],
    processes: [ { id: uid(), title: "", steps: [], components: [] } ],
    processFlowchart: { nodes: [], edges: [] },
    processViewMode: 'list',
    yieldPct: '',
    versions: [],
    createdBy: currentUser?.email || '',
    createdAt: Date.now(),
    updatedBy: currentUser?.email || '',
    updatedAt: Date.now()
  };
}

export function migrateRecipe(r){
  if(!Array.isArray(r.parts)){
    const oldIngredients = Array.isArray(r.ingredients) && r.ingredients.length ? r.ingredients : [{ name:"", percent:0, weight:0, note:"" }];
    r.parts = [ { name:"Part 1", ingredients: oldIngredients } ];
    for(let i = r.parts.length; i < PART_COUNT; i++){
      r.parts.push(blankPart(`Part ${i+1}`));
    }
    delete r.ingredients;
  }
  // Recursive so it also normalizes Sub-parts nested arbitrarily deep
  // inside a Part — older saved recipes never had Sub-parts at all, so
  // `p.parts` simply won't exist on them yet; this backfills it as empty.
  function migratePart(p){
    if(!Array.isArray(p.ingredients) || p.ingredients.length === 0){
      p.ingredients = [{ name:"", percent:0, weight:0, note:"" }];
    }
    p.ingredients.forEach(ing => { if(ing.flowNodeId === undefined) ing.flowNodeId = null; });
    const oldPartName = /^ส่วนที่ (\d+)$/.exec(p.name || '');
    if(oldPartName) p.name = `Part ${oldPartName[1]}`;
    if(!Array.isArray(p.parts)) p.parts = [];
    p.parts.forEach(migratePart);
  }
  r.parts.forEach(migratePart);

  if(!Array.isArray(r.processes)){
    const oldSteps = Array.isArray(r.steps) ? r.steps.filter(s => (s||'').trim() !== '') : [];
    r.processes = [ { id: uid(), title: "", steps: oldSteps } ];
    delete r.steps;
  }
  if(r.processes.length === 0){
    r.processes.push({ id: uid(), title: "", steps: [], components: [] });
  }
  r.processes.forEach(p => {
    // Backfilled so Process Flowchart nodes can live-link to a specific
    // Process by a stable id — an array index would break the moment
    // Processes get reordered or one before it is deleted.
    if(!p.id) p.id = uid();
    // A Process is valid with just a title and no steps yet — no longer
    // force a blank placeholder step just to have something to render.
    if(!Array.isArray(p.steps)) p.steps = [];
    if(!Array.isArray(p.components)) p.components = [];
  });

  if(!r.processFlowchart || typeof r.processFlowchart !== 'object'){
    r.processFlowchart = { nodes: [], edges: [] };
  }
  if(!Array.isArray(r.processFlowchart.nodes)) r.processFlowchart.nodes = [];
  if(!Array.isArray(r.processFlowchart.edges)) r.processFlowchart.edges = [];
  // Normalizes any missing/garbage value to 'list' too, not just undefined.
  if(r.processViewMode !== 'flowchart') r.processViewMode = 'list';

  // Description used to be a single free-text field — upgrade it to a list
  // of separate points (characteristics, selling points, etc.).
  if(!Array.isArray(r.description)){
    r.description = (r.description || '').trim() ? [r.description] : [];
  }
  if(!Array.isArray(r.descPhotos)) r.descPhotos = [];
  if(r.customerName === undefined) r.customerName = '';
  if(r.destinationCountry === undefined) r.destinationCountry = '';
  if(r.salesRep === undefined) r.salesRep = '';

  if(r.yieldPct === undefined || r.yieldPct === null) r.yieldPct = '';
  if(!Array.isArray(r.versions)) r.versions = [];

  // Older recipes saved before activity tracking existed won't have these —
  // leave them blank rather than guessing a creator/date that isn't real.
  if(r.createdBy === undefined) r.createdBy = '';
  if(r.createdAt === undefined) r.createdAt = null;
  if(r.updatedBy === undefined) r.updatedBy = '';

  return r;
}

export function saveRecipeToCloud(r){
  return setDoc(doc(recipesCol, r.id), r);
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

// Shared by every path that should leave a Version History entry (manual
// Save, the 1-minute idle auto-checkpoint, and "Save Current as Version" in
// the modal) — same snapshot shape, same 5-version cap, one place to change.
export function pushVersionCheckpoint(r, label){
  if(!Array.isArray(r.versions)) r.versions = [];
  r.versions.push({ id: uid(), label, savedAt: Date.now(), snapshot: snapshotRecipeCore(r) });
  if(r.versions.length > 5) r.versions = r.versions.slice(r.versions.length - 5);
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

// Idle auto-checkpoint: if a recipe has an edit sitting for 60s with no
// manual Save click, snapshot it into Version History so that auto-save is
// always revertible, then arms again on the next edit — so a long
// uninterrupted editing session still gets a checkpoint roughly once a
// minute, not just once total.
export function scheduleVersionCheckpoint(r){
  let entry = versionCheckpointTimers.get(r.id);
  if(!entry){
    entry = { timer: null, dirty: false };
    versionCheckpointTimers.set(r.id, entry);
  }
  entry.dirty = true;
  if(entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if(!entry.dirty) return;
    entry.dirty = false;
    autoCheckpointVersion(r);
  }, 60000);
}

export function cancelVersionCheckpoint(r){
  const entry = versionCheckpointTimers.get(r.id);
  if(!entry) return;
  clearTimeout(entry.timer);
  entry.timer = null;
  entry.dirty = false;
}

export function autoCheckpointVersion(r){
  pushVersionCheckpoint(r, 'Auto-saved (unsaved for 1 min)');
  performSave(r);
  if(versionsModalRecipe === r) renderVersionsList(r);
}

// Shared by the compact sidebar list (shown while a recipe is open) and the
// full-page Recipes view (shown from the "Recipes" tab) — same cards, same
// click-to-open behavior, just mounted into whichever container is visible
// right now so the two never have to duplicate this logic separately.
export function renderRecipeCards(container, query){
  if(!container) return;
  const q = (query || '').trim().toLowerCase();
  const sorted = [...recipes].sort((a,b)=>b.updatedAt-a.updatedAt);
  container.innerHTML = '';
  sorted.filter(r => !q || (r.name||'Untitled').toLowerCase().includes(q))
    .forEach(r => {
      const div = document.createElement('div');
      div.className = 'recipe-item' + (r.id === currentId ? ' active' : '');
      const allIngredients = allIngredientsInRecipe(r);
      // % is always weight / totalWeight, so it's exactly 100% by
      // construction whenever there's any weight at all (ing.percent is now
      // per-part, so it can't be summed directly to check this).
      const hasWeight = allIngredients.some(i => (parseFloat(i.weight)||0) > 0);
      const totalPct = hasWeight ? 100 : 0;
      const codeDisplay = fullCode(r);
      div.innerHTML = `
        <div class="r-name">${escapeHtml(recipeDisplayLabel(r))}</div>
        <div class="r-meta">${codeDisplay ? escapeHtml(codeDisplay)+' · ' : ''}${totalPct.toFixed(1)}% · ${allIngredients.length} ingredients</div>
      `;
      div.addEventListener('click', () => guardNavigation(() => {
        if(r.id !== currentId) unlockedRecipeId = null;
        currentId = r.id;
        setMainFeatureView(null);
        renderMain();
        renderSidebar();
      }));
      container.appendChild(div);
    });
}

export function createNewRecipe(){
  const r = blankRecipe();
  recipes.push(r);
  currentId = r.id;
  unlockedRecipeId = r.id;
  setMainFeatureView(null);
  saveRecipeToCloud(r);
  logActivityEvent('created', 'recipe', r.name || 'Untitled recipe');
  renderSidebar();
  renderMain();
}


export function mountRecipesListView(){
  const main = document.getElementById('mainArea');
  main.classList.remove('main-wide');
  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('file-text', 24)} Recipes</div>
    </div>
    <div class="card">
      <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
        <button class="btn btn-primary" id="btnNewFromRecipesList">+ New Recipe</button>
        <button class="btn" id="btnCompareFromRecipesList">${icon('scale')} Compare Recipes</button>
      </div>
      <div class="search-box" style="margin:0 0 16px;">
        <input type="text" id="recipesListSearchInput" placeholder="Search product name...">
      </div>
      <div class="recipe-list" id="recipesListGrid"></div>
    </div>
  `;

  document.getElementById('btnNewFromRecipesList').addEventListener('click', createNewRecipe);
  document.getElementById('btnCompareFromRecipesList').addEventListener('click', () => {
    setMainFeatureView('compare');
    renderMain();
    renderSidebar();
  });
  document.getElementById('recipesListSearchInput').addEventListener('input', renderRecipesListGrid);

  renderRecipesListGrid();
  playContentTransition(main);
}
export function renderRecipesListGrid(){
  renderRecipeCards(document.getElementById('recipesListGrid'), document.getElementById('recipesListSearchInput')?.value);
}

// r.date is always "YYYY-MM-DD" (a <input type="date"> value), so the year
// is always its first 4 characters — the code format only keeps the last 2.
export function yearPrefix(dateStr){
  return dateStr && dateStr.length >= 4 ? dateStr.slice(2, 4) : 'YY';
}

export function recipeDestinationIso2(r){
  const link = findProjectForRecipe(r.id);
  return link ? countryToIso2(link.project.destinationCountry) : '';
}

// Looked up fresh from Reference Lists > Product Types each time (rather
// than duplicated onto the recipe) so a renamed type's code — always
// recalculated from its new name, see productTypeCode — stays correct
// everywhere it's referenced instead of going stale.
export function recipeProductTypeCode(r){
  const item = metaLists.productTypes.find(x => metaItemName(x) === (r.productType || ''));
  return item ? (item.code || productTypeCode(metaItemName(item))) : '';
}

// Auto-assigned recipe sequence number (see codeRecipeSeqDisplay, not
// manually editable) — one past the highest number already used by this
// product type. Deliberately max-based rather than count-based: a raw
// count of same-type recipes collides with an in-use number as soon as one
// same-type recipe is deleted (e.g. type has 01/02/03, delete 02 → a
// count-based calc for the next new one gives 03 again, colliding with the
// existing 03; max-based correctly gives 04).
export function suggestNextRecipeSeq(productTypeName, excludeId){
  const maxSeq = recipes
    .filter(x => x.id !== excludeId && (x.productType || '') === productTypeName)
    .reduce((max, x) => Math.max(max, parseInt(x.recipeSeq, 10) || 0), 0);
  return String(maxSeq + 1).padStart(2, '0');
}

export function fullCode(r){
  const yy = yearPrefix(r.date);
  const typeCode = recipeProductTypeCode(r);
  const seq = (r.recipeSeq || '').trim();
  const trial = (r.code || '').trim();
  if(yy === 'YY' && !typeCode && !seq && !trial) return '';
  const iso = recipeDestinationIso2(r);
  return (iso || '') + yy + '-' + (typeCode || 'XXX') + (seq || 'XX') + '-T' + (trial || 'XX');
}

/* Product name with the last 2 characters of the recipe code suffix appended,
   e.g. "Vegan Tartar Sauce - 19" — used anywhere recipes are picked/labeled
   so near-duplicate names stay distinguishable at a glance. */
export function recipeDisplayLabel(r){
  const name = r.name || 'Untitled recipe';
  const suffix = (r.code || '').trim();
  return suffix ? `${name} - ${suffix}` : name;
}

/* Shared by the Compare Recipes info card and the print info card — renders
   the Description/Concept points (an array) as a small bullet list. */
export function descriptionListHtml(r){
  const points = (r.description || []).filter(p => (p||'').trim() !== '');
  if(points.length === 0) return '<div class="ci-row"><b>Description:</b> -</div>';
  return `
    <div class="ci-row"><b>Description:</b></div>
    <ol class="ci-desc-list">${points.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ol>
  `;
}

export function refreshCodeCountryBadge(r){
  const row = document.getElementById('codeYearDisplay')?.closest('.code-row');
  const badge = document.getElementById('codeCountryDisplay');
  if(!row || !badge) return;
  const iso = recipeDestinationIso2(r);
  row.classList.toggle('has-country-badge', !!iso);
  badge.style.display = iso ? '' : 'none';
  badge.textContent = iso;
}

export function updateRecipeTitleDisplay(r){
  const el = document.getElementById('recipeTitleDisplay');
  if(!el) return;
  const code = fullCode(r);
  el.innerHTML = `${escapeHtml(r.name || 'Untitled recipe')}${code ? `<span class="rt-code">${escapeHtml(code)}</span>` : ''}`;

  const activityEl = document.getElementById('recipeActivityDisplay');
  if(activityEl){
    const parts = [];
    if(r.createdBy) parts.push(`Created by ${r.createdBy}${r.createdAt ? ' · ' + formatActivityDateTime(r.createdAt) : ''}`);
    if(r.updatedBy) parts.push(`Last edited by ${r.updatedBy}${r.updatedAt ? ' · ' + formatActivityDateTime(r.updatedAt) : ''}`);
    activityEl.textContent = parts.join('   |   ');
  }
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
