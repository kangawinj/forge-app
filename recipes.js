import {
  escapeHtml, icon, uid, currentUser, mainFeatureView, setMainFeatureView,
  logActivityEvent, diffMainFields, showCloudError, playContentTransition,
  renderSidebar, formatActivityDateTime, recipesCol, projects, metaLists,
  metaItemName, productTypeCode, ingredientMaster, migrateTrialsFromRecipes,
  countryToIso2, guardNavigation,
  readOnlyIngredientTreeHtml, readOnlyProcessesHtml,
  renderReadOnlyProcessFlowchart, renderMain,
  requestAuthConfirm, DELETE_APPROVER_EMAIL, approverRecipesCol,
  snapshotMainFields, blankProduct, scheduleProjectSave,
  findMaterialByLabel, materialLabel, formatMoq, resizeImageFile
} from './app.js';
import {
  onSnapshot, setDoc, doc, deleteDoc
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

let dragPayload = null;

export function renderRecipeEditor(r){
  const main = document.getElementById('mainArea');
  main.innerHTML = `
    <div class="main-header">
      <div>
        <div class="recipe-title-display" id="recipeTitleDisplay"></div>
        <div class="save-status saved" id="saveStatus">Ready</div>
        <div class="recipe-activity-display" id="recipeActivityDisplay"></div>
      </div>
    </div>

    <div class="recipe-header-actions">
      <div class="lock-banner" id="lockBanner"></div>
      <div class="toolbar">
        <button class="btn" id="btnVersions">${icon('clock')} Versions</button>
        <button class="btn" id="btnDuplicate">${icon('copy')} Duplicate</button>
        <button class="btn" id="btnPrint">${icon('printer')} Print / PDF</button>
        <button class="btn" id="btnExportExcel">${icon('download')} Export Excel</button>
      </div>
    </div>

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
        <div class="field">
          <label>Project</label>
          <select id="f-linkedProject" class="proj-select"></select>
          <div id="linkedProjectInfo"></div>
        </div>
        <div class="field">
          <label>Product Type</label>
          <select id="f-productTypeMain" class="proj-select"></select>
        </div>
        <div class="grid-2">
          <div class="field">
            <label>Description / Concept</label>
            <div class="desc-points-list" id="descPointsList"></div>
            <button class="btn btn-sm add-row-btn" type="button" id="btnAddDescPoint">+ Add Point</button>
            <div class="desc-photos-label">Photos (up to 3)</div>
            <div class="trial-photos-row" id="descPhotosRow"></div>
            <input type="file" id="descPhotoInput" accept="image/*">
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
              <input type="text" id="f-codeSuffix" class="code-suffix code-suffix-sm" placeholder="01" maxlength="6" title="Trial number for this recipe">
            </div>
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
            <tr>
              <th class="col-no">#</th>
              <th>Ingredient</th>
              <th class="col-pct">% of Recipe</th>
              <th class="col-wt">Total Weight (g)</th>
            </tr>
          </thead>
          <tbody id="overviewBody"></tbody>
          <tfoot>
            <tr>
              <td></td>
              <td>Total</td>
              <td class="col-pct" id="grandTotalPct"></td>
              <td class="col-wt" id="grandTotalWt"></td>
            </tr>
          </tfoot>
        </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">3. Components and Process</div>
      <div class="components-process-grid">
      <div class="ingredients-edit-view">
      <button class="btn btn-sm material-lib-btn" id="btnOpenMaterialLib">${icon('book-open')} Ingredient Library (select existing / add new)</button>
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
        <div>
          <div class="batch-stat-label">Expected Yield (%) — production loss, e.g. cooking/trim</div>
          <div class="batch-scale-row">
            <input type="number" id="f-yieldPct" min="0" max="100" step="0.01" placeholder="e.g. 95" class="unit-input">
            <span class="unit-suffix">%</span>
          </div>
        </div>
        <div>
          <div class="batch-stat-label">Adjusted Output Weight (after yield loss)</div>
          <div class="batch-stat-value" id="yieldAdjustedDisplay">—</div>
        </div>
      </div>
      <div class="ingredient-tree">
        <div class="tree-node tree-root-node">
          <span class="tree-node-label">Formula per Portion</span>
          <span class="tree-node-pct">100.00%</span>
          <span class="tree-node-wt tree-root-wt-wrap">
            <input type="number" class="num-input tree-root-wt-input" id="treeRootWt" step="0.01" min="0" title="Type a total weight (g) to scale the whole recipe proportionally">
            <span class="ing-unit">g</span>
          </span>
        </div>
        <div id="partsContainer" class="tree-children"></div>
        <button class="btn btn-sm add-row-btn" id="btnAddPart">+ Add Part</button>
      </div>
      </div>
      <div class="simple-process-col">
        <div class="simple-process-col-title">Process</div>
        <div id="simpleProcessPreview"></div>
      </div>
      </div>
      <div id="printIngredientTree" class="print-only"></div>
    </div>

    <div class="card">
      <div class="card-title">
        4. Process Steps
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
  document.getElementById('f-codeSuffix').value = r.code || '';
  // Safety net: a recipe that already has a Product Type but somehow never
  // got a sequence number (shouldn't normally happen, since picking a Type
  // always assigns one — see the change handler below) gets one now rather
  // than showing blank forever, since this field is never manually editable.
  if(r.productType && !r.recipeSeq){
    r.recipeSeq = suggestNextRecipeSeq(r.productType, r.id);
    scheduleSave();
  }
  document.getElementById('codeRecipeSeqDisplay').textContent = r.recipeSeq || 'NN';
  document.getElementById('codeYearDisplay').textContent = yearPrefix(r.date);
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
  renderDescPoints(r);
  renderDescPhotos(r);

  document.getElementById('f-name').addEventListener('input', e => {
    r.name = e.target.value;
    updateRecipeTitleDisplay(r);
    scheduleSave();
  });
  document.getElementById('f-codeSuffix').addEventListener('input', e => {
    r.code = e.target.value;
    updateRecipeTitleDisplay(r);
    scheduleSave();
  });
  document.getElementById('f-productTypeMain').addEventListener('change', e => {
    r.productType = e.target.value;
    refreshCodeProductTypeBadge(r);
    // Re-assign the sequence number for the newly-picked type — whatever
    // number belonged to the old type wouldn't mean anything for this one.
    // Not manually editable, so this is the only place it's ever set.
    r.recipeSeq = r.productType ? suggestNextRecipeSeq(r.productType, r.id) : '';
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

  document.getElementById('btnOpenMaterialLib').addEventListener('click', () => {
    setMainFeatureView('materials');
    renderMain();
    renderSidebar();
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

  document.getElementById('f-yieldPct').value = r.yieldPct ?? '';
  document.getElementById('f-yieldPct').addEventListener('input', e => {
    r.yieldPct = e.target.value === '' ? '' : parseFloat(e.target.value) || 0;
    updateYieldDisplay(r);
    scheduleSave();
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
    r.processes.push({ id: uid(), title: '', steps: [], components: [] });
    renderProcesses(r);
    scheduleSave();
  });

  document.getElementById('btnVersions').addEventListener('click', () => openVersionsModal(r));
  document.getElementById('btnDuplicate').addEventListener('click', duplicateCurrent);
  document.getElementById('btnDelete').addEventListener('click', () => {
    const deletingId = r.id;
    if(!confirm(`Delete "${r.name || 'Untitled recipe'}"? This cannot be undone.`)) return;
    requestAuthConfirm(
      'Confirm Deletion',
      `Enter the approver's email and password to permanently delete the recipe "${r.name || 'Untitled recipe'}"`,
      () => deleteCurrent(),
      {
        requireEmail: DELETE_APPROVER_EMAIL,
        approverAction: () => deleteDoc(doc(approverRecipesCol, deletingId))
          .then(() => logActivityEvent('deleted', 'recipe', r.name || 'Untitled recipe'))
      }
    );
  });
  document.getElementById('btnPrint').addEventListener('click', () => {
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

  document.getElementById('btnExportExcel').addEventListener('click', () => exportRecipeToExcel(r));

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
    cards.querySelectorAll('input, textarea, button').forEach(el => { el.disabled = true; });
  }
}

export function recomputeFromWeights(r){
  // recomputePartPercents(part) assigns .percent to `part`'s own CHILDREN,
  // not to `part` itself — for a nested Sub-part that assignment happens
  // one level up, in its parent's own call. Top-level Parts have no such
  // parent (the recipe root isn't a Part), so their own .percent has to be
  // assigned explicitly here, the same way, against the recipe total.
  const partTotals = (r.parts || []).map(part => recomputePartPercents(part));
  const totalWeight = partTotals.reduce((s,w)=>s+w,0);
  (r.parts || []).forEach((part, idx) => {
    part.percent = totalWeight > 0 ? round2(partTotals[idx] / totalWeight * 100) : 0;
  });
  r.batchWeight = round2(totalWeight);
  return totalWeight;
}

// Recursively totals one Part (its own ingredients' weights + every
// Sub-part's own recursive total), then assigns each direct child (each
// ingredient's .percent, each Sub-part's own .percent) its share of that
// total — then recurses so every Sub-part does the same for its own
// children. Returns the Part's own total weight.
function recomputePartPercents(part){
  const ingWeights = (part.ingredients || []).map(i => parseFloat(i.weight) || 0);
  const subTotals = (part.parts || []).map(sub => recomputePartPercents(sub));
  const total = ingWeights.reduce((s,w)=>s+w,0) + subTotals.reduce((s,w)=>s+w,0);
  (part.ingredients || []).forEach((ing, idx) => {
    ing.percent = total > 0 ? round2(ingWeights[idx] / total * 100) : 0;
  });
  (part.parts || []).forEach((sub, idx) => {
    sub.percent = total > 0 ? round2(subTotals[idx] / total * 100) : 0;
  });
  return round2(total);
}

// A Part's own weight, recursively summing its direct ingredients plus
// every Sub-part's own recursive total.
export function partTotalWeight(part){
  const direct = (part.ingredients || []).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
  const nested = (part.parts || []).reduce((s,sub)=>s+partTotalWeight(sub),0);
  return direct + nested;
}

// Every ingredient under a Part, including ones nested inside its
// Sub-parts — used anywhere that just needs "the full ingredient list"
// (Compare Recipes, Print, Recipe Overview, Ingredient Library usage,
// Trial totals) without needing to also show the nesting itself.
export function allIngredientsInPart(part){
  return [...(part.ingredients || []), ...(part.parts || []).flatMap(allIngredientsInPart)];
}
export function allIngredientsInRecipe(r){
  return (r.parts || []).flatMap(allIngredientsInPart);
}

// Same idea as allIngredientsInPart, but keeps each ingredient's Part path
// (e.g. "Part 1 > Sauce Sub-part") instead of flattening it away — the
// export sheet needs to show which Part/Sub-part an ingredient belongs to,
// which allIngredientsInPart's callers never needed.
function flattenPartForExcel(part, pathPrefix){
  const path = pathPrefix ? `${pathPrefix} > ${part.name || 'Untitled part'}` : (part.name || 'Untitled part');
  const rows = (part.ingredients || []).map(ing => ({
    part: path,
    name: ing.name || '',
    percent: ing.percent === '' || ing.percent == null ? '' : Number(ing.percent),
    weight: ing.weight === '' || ing.weight == null ? '' : Number(ing.weight),
    note: ing.note || ''
  }));
  return [...rows, ...(part.parts || []).flatMap(sub => flattenPartForExcel(sub, path))];
}
// Top-level entry point — r.parts has no shared parent of its own, so each
// top-level Part starts its own path fresh rather than being wrapped in a
// fake parent (which would wrongly prepend "Untitled part" to every row).
function flattenRecipePartsForExcel(parts){
  return (parts || []).flatMap(part => flattenPartForExcel(part, ''));
}

// Exports the current recipe as a 3-sheet .xlsx workbook (Overview,
// Ingredients, Process) via SheetJS (loaded as a plain global — see the
// <script> tag right before the main module script). Excel/XLSX rather
// than CSV specifically because a real workbook keeps Thai characters
// correct without a manual BOM/encoding workaround and can hold more than
// one sheet.
function exportRecipeToExcel(r){
  if(typeof XLSX === 'undefined'){
    alert('Could not load the Excel export library — check your internet connection and try again.');
    return;
  }
  const link = findProjectForRecipe(r.id);
  const overviewRows = [
    ['Product Name', r.name || 'Untitled recipe'],
    ['Recipe Code', fullCode(r) || '-'],
    ['Date', r.date || '-'],
    ['Product Type', r.productType || '-'],
    ['Batch Weight (g)', r.batchWeight || ''],
    ['Yield %', r.yieldPct || ''],
    ['Project', link ? (link.project.name || 'Untitled project') : '-'],
    ['Customer', link ? (link.project.customerName || '-') : '-'],
    ['Destination', link ? (link.project.destinationCountry || '-') : '-'],
    ['Stage', link ? (link.product.stage || '-') : '-'],
    ['Created By', r.createdBy || '-'],
    ['Created At', formatActivityDateTime(r.createdAt) || '-'],
    ['Last Edited By', r.updatedBy || '-'],
    ['Last Edited At', formatActivityDateTime(r.updatedAt) || '-'],
    [],
    ['Description / Concept'],
    ...(r.description || []).map(pt => [pt])
  ];
  const ingredientRows = flattenRecipePartsForExcel(r.parts)
    .map(row => ({ Part: row.part, Ingredient: row.name, '%': row.percent, 'Weight (g)': row.weight, Note: row.note }));
  const processRows = (r.processes || []).flatMap((proc, pIdx) =>
    (proc.steps && proc.steps.length ? proc.steps : ['']).map((step, sIdx) => ({
      'Process #': pIdx + 1,
      'Process Name': proc.title || `Process ${pIdx + 1}`,
      'Step #': sIdx + 1,
      'Step': step || ''
    }))
  );

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(overviewRows), 'Overview');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ingredientRows), 'Ingredients');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(processRows), 'Process');

  const filenameBase = [r.name || 'Untitled recipe', fullCode(r)].filter(Boolean).join(' ').replace(/[\\/:*?"<>|]/g, '-');
  XLSX.writeFile(wb, `${filenameBase}.xlsx`);
}

// Scales every ingredient under a Part (including ones nested inside its
// Sub-parts) by the same factor, so weights change but every ratio between
// them — and so every %-of-parent at every level — doesn't.
function scaleIngredientsInPart(part, factor){
  (part.ingredients || []).forEach(ing => { ing.weight = round2((parseFloat(ing.weight)||0) * factor); });
  (part.parts || []).forEach(sub => scaleIngredientsInPart(sub, factor));
}

// "Everything else at this Part's own level" — siblingsCtx.ingredients is
// the sibling ingredients array (null for a top-level Part, since the
// recipe root holds no ingredients directly), siblingsCtx.parts is the
// sibling Parts array `part` itself lives in (r.parts for top-level,
// or parentPart.parts when nested). Used to back-solve a Part's weight
// from a typed %, the same way an ingredient's own % field already does
// one level down.
function siblingsWeightExcluding(siblingsCtx, part){
  const ingWeight = (siblingsCtx.ingredients || []).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
  const partsWeight = (siblingsCtx.parts || []).filter(p => p !== part).reduce((s,p)=>s+partTotalWeight(p),0);
  return ingWeight + partsWeight;
}

// Dragging a Part onto itself, or onto one of its own Sub-parts, would
// nest it inside itself — an impossible/cyclic tree. Used to reject that
// drop before it happens (see renderPartNode's drag-handle wiring).
function isPartOrDescendant(candidate, part){
  if(candidate === part) return true;
  return (part.parts || []).some(sub => isPartOrDescendant(candidate, sub));
}

// Every Part, at any depth, as one flat list — used by Process Steps'
// "Add Component" picker so a single flat <option> index can address a
// Part or ingredient at any nesting depth instead of needing a multi-level
// path. `label` is a breadcrumb ("Filling › Spicy Sauce") so a nested
// Sub-part or its ingredients still read unambiguously in the dropdown.
function collectPartsFlat(parts, prefix){
  let out = [];
  (parts || []).forEach((part, idx) => {
    const label = prefix + (part.name || `Part ${idx+1}`);
    out.push({ part, label });
    out = out.concat(collectPartsFlat(part.parts, label + ' › '));
  });
  return out;
}
function collectIngredientsFlat(parts, prefix){
  let out = [];
  (parts || []).forEach((part, idx) => {
    const label = prefix + (part.name || `Part ${idx+1}`);
    (part.ingredients || []).filter(i => (i.name||'').trim() !== '').forEach(ing => {
      out.push({ ing, label: `${label} › ${ing.name}` });
    });
    out = out.concat(collectIngredientsFlat(part.parts, label + ' › '));
  });
  return out;
}

function round2(n){ return Math.round(n * 100) / 100; }

/* Read-only weight displays (totals/subtotals) get a thousands separator for
   readability at larger batch sizes — editable Weight (g) <input> fields
   stay plain numbers since type="number" inputs can't contain commas. */
export function formatWeight(n){
  return (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' g';
}

function updateYieldDisplay(r){
  const el = document.getElementById('yieldAdjustedDisplay');
  if(!el) return;
  const yieldPct = parseFloat(r.yieldPct);
  if(!yieldPct || yieldPct <= 0){ el.textContent = '—'; return; }
  el.textContent = formatWeight((r.batchWeight||0) * yieldPct / 100);
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
  updateYieldDisplay(r);

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

function renderParts(r){
  recomputeFromWeights(r);

  const batchEl = document.getElementById('batchTotalDisplay');
  if(batchEl) batchEl.textContent = formatWeight(r.batchWeight);
  updateYieldDisplay(r);

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
function renderPartNode(r, part, container, siblingsCtx){
  const isNested = siblingsCtx.ingredients !== null;

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
      <div class="row-value-col">
        <input type="number" class="part-pct-display num-input" step="0.01" min="0" max="100" title="Type a % or a weight (g) — scales everything inside this Part proportionally">
        <span class="ing-unit">%</span>
      </div>
      <div class="row-value-col row-value-wt">
        <input type="number" class="part-wt-display num-input" step="0.01" min="0">
        <span class="ing-unit">g</span>
      </div>
      <button class="icon-btn" title="Delete this part">${icon('x')}</button>
    ` : `
      <span class="drag-handle" draggable="true" title="Drag onto another Part's title to move this Part (and everything inside it) there">${icon('grip-vertical', 14)}</span>
      <button type="button" class="part-toggle-btn" title="Expand / collapse this part">${icon('chevron-right')}</button>
      <input type="text" class="part-name" placeholder="Part name">
      <div class="part-header-fields">
        <input type="number" class="part-pct-display num-input" step="0.01" min="0" max="100" title="Type a % or a weight (g) — scales everything inside this Part proportionally">
        <span>% of recipe</span>
        <input type="number" class="part-wt-display num-input" step="0.01" min="0">
        <span>g</span>
        <span class="part-ing-count"></span>
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
        sourcePart.ingredients.push({ name:'', percent:0, weight:0, note:'' });
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

  function setCollapsed(collapsed){
    block.classList.toggle('collapsed', collapsed);
    toggleBtn.classList.toggle('open', !collapsed);
    toggleBtn.innerHTML = icon(collapsed ? 'chevron-right' : 'chevron-down');
  }

  toggleBtn.addEventListener('click', () => {
    setCollapsed(!block.classList.contains('collapsed'));
  });

  const hasContent = part.ingredients.some(i => (i.name || '').trim() !== '') || part.parts.length > 0;
  setCollapsed(!hasContent);

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
          <div class="row-value-col">
            <input type="number" class="ing-pct-display num-input" step="0.01" min="0" max="100" title="Type a % or a weight (g) — the other one is calculated automatically">
            <span class="ing-unit">%</span>
          </div>
          <div class="row-value-col row-value-wt">
            <input type="number" class="ing-wt num-input" step="0.01" min="0">
            <span class="ing-unit">g</span>
          </div>
          <button class="icon-btn" title="Delete">${icon('x')}</button>
          <div class="ing-flow-link-wrap">
            <span class="ing-flow-link-arrow">→</span>
            <select class="ing-flow-link" title="Link this ingredient to a Process Flowchart node"></select>
          </div>
        </div>
        <div class="ing-hint"></div>
      `;
      const ingDragHandle = branch.querySelector('.drag-handle');
      const nameInput = branch.querySelector('.ing-name');
      const suggestBox = branch.querySelector('.ing-suggestions');
      const hintEl = branch.querySelector('.ing-hint');
      const pctDisplay = branch.querySelector('.ing-pct-display');
      const wtInput = branch.querySelector('.ing-wt');
      const noteInput = branch.querySelector('.ing-note');
      const delBtn = branch.querySelector('.icon-btn');

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
          sourcePart.ingredients.push({ name:'', percent:0, weight:0, note:'' });
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

      function syncMaterialLink(resetWeightIfUnlinked){
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
          if(resetWeightIfUnlinked && (parseFloat(ing.weight) || 0) !== 0){
            ing.weight = 0;
            wtInput.value = (0).toFixed(2);
            pctDisplay.value = (0).toFixed(2);
          }
        }
      }
      syncMaterialLink(false);

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
        syncMaterialLink(true);
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
        if(part.ingredients.length === 0 && part.parts.length === 0) part.ingredients.push({ name:'', percent:0, weight:0, note:'' });
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
  }

  renderRows();

  function renderSubParts(){
    subPartsContainer.innerHTML = '';
    part.parts.forEach(sub => renderPartNode(r, sub, subPartsContainer, { ingredients: part.ingredients, parts: part.parts }));
  }
  renderSubParts();

  addIngBtn.addEventListener('click', () => {
    if(hasUnresolvedIngredient(part)){
      alert('This part has an ingredient that is not yet in the library. Please select from the library or add it first before adding the next row.');
      return;
    }
    part.ingredients.push({ name:'', percent:0, weight:0, note:'' });
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

  renderOverview(allIngredients);
}

function renderOverview(allIngredients){
  const body = document.getElementById('overviewBody');
  if(!body) return;
  body.innerHTML = '';

  const named = allIngredients.filter(i => (i.name||'').trim() !== '');
  if(named.length === 0){
    body.innerHTML = '<tr><td colspan="4"><div class="overview-empty">No ingredient names entered yet</div></td></tr>';
    return;
  }

  const groups = new Map();
  named.forEach(i => {
    const key = i.name.trim().toLowerCase();
    if(!groups.has(key)){
      const material = i.materialId ? ingredientMaster.find(m => m.id === i.materialId) : null;
      groups.set(key, {
        name: i.name.trim(),
        pct: 0,
        wt: 0,
        image: material ? material.image : '',
        vendorName: material ? material.vendorName : '',
        manufacturer: material ? material.manufacturer : ''
      });
    }
    const g = groups.get(key);
    g.wt += parseFloat(i.weight) || 0;
  });

  // % here is always of the whole recipe (not the ingredient's own part),
  // so it's computed straight from weight rather than summing the now
  // per-part ing.percent values.
  const totalRecipeWeight = allIngredients.reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
  groups.forEach(g => { g.pct = totalRecipeWeight > 0 ? (g.wt / totalRecipeWeight * 100) : 0; });

  const rows = [...groups.values()].sort((a,b) => b.pct - a.pct);
  const maxPct = Math.max(...rows.map(g => g.pct), 100);

  rows.forEach((g, idx) => {
    const tr = document.createElement('tr');
    const barPct = Math.min(100, (g.pct / maxPct) * 100);
    tr.innerHTML = `
      <td class="col-no">${idx+1}</td>
      <td>
        <div class="overview-ing-cell">
          ${g.image ? `<img src="${escapeHtml(g.image)}" class="overview-thumb" alt="${escapeHtml(g.name)}">` : '<div class="overview-thumb overview-thumb-empty"></div>'}
          <div class="overview-ing-info">
            <span>${escapeHtml(g.name)}</span>
            ${(g.vendorName || g.manufacturer) ? `<span class="overview-ing-sub">${escapeHtml([g.vendorName, g.manufacturer].filter(Boolean).join(' · '))}</span>` : ''}
          </div>
        </div>
      </td>
      <td class="col-pct">
        <div class="overview-bar-wrap">
          <div class="overview-bar-track"><div class="overview-bar-fill" style="width:${barPct}%"></div></div>
          <span>${g.pct.toFixed(2)}%</span>
        </div>
      </td>
      <td class="col-wt">${formatWeight(g.wt)}</td>
    `;
    body.appendChild(tr);
  });
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

      <div class="process-steps-list"></div>
      <button class="btn btn-sm add-row-btn" data-role="add-step">+ Add Step</button>
    `;

    const titleInput = block.querySelector('.process-title');
    titleInput.value = proc.title || '';
    titleInput.addEventListener('input', e => { proc.title = e.target.value; scheduleSave(); });

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
      if(r.processes.length === 0) r.processes.push({ id: uid(), title: '', steps: [], components: [] });
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

export const DEFAULT_FLOW_NODE_W = 170;

// Module-level "what's currently being manipulated" state, same discipline
// as dragPayload above: always reset to null on every exit path (success
// or cancel) of its gesture, never left dangling.
let flowNodeDrag = null; // { r, node, el, startClientX, startClientY, startX, startY }
let flowEdgeDraw = null; // { r, fromNode, fromEl, currentClientX, currentClientY }

// Spreadsheet-style column labels (A, B, ... Z, AA, AB, ...) — picks the
// first one not already used by an existing node, so a deleted node's
// letter can be reused by the next Add, and existing labels are never
// renumbered out from under an ingredient that already links to them.
function excelColumnLabel(i){
  let n = i + 1, label = '';
  while(n > 0){
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}
function nextFlowNodeLabel(nodes){
  const used = new Set((nodes || []).map(n => (n.label || '').trim().toUpperCase()).filter(Boolean));
  for(let i = 0; i < 18278; i++){ // A..Z, AA..ZZ, AAA..ZZZ — far more than any real recipe needs
    const label = excelColumnLabel(i);
    if(!used.has(label)) return label;
  }
  return 'X' + (nodes.length + 1); // astronomically unlikely fallback
}

function blankFlowNode(label, x, y){
  return { id: uid(), x: Math.round(x), y: Math.round(y), w: DEFAULT_FLOW_NODE_W, label, text: '', linkedProcessId: null };
}

// A node's displayed text is either its own free-typed .text, or — when
// linked to a Process (see the node's "Link" dropdown) — live-derived
// fresh from that Process's current title + steps every time this is
// called, so editing the List always shows up the next time the
// Flowchart is rendered without any separate push-sync step. Falls back
// to whatever .text was last set if the linked Process no longer exists
// (shouldn't normally happen — Process deletion detaches the link and
// freezes the text instead — but never crash on a dangling reference).
export function computeFlowNodeText(node, processes){
  if(!node.linkedProcessId) return node.text || '';
  const proc = (processes || []).find(p => p.id === node.linkedProcessId);
  if(!proc) return node.text || '';
  const steps = (proc.steps || []).filter(s => (s||'').trim() !== '');
  return [proc.title || 'Untitled process', ...steps].join('\n');
}

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

// Every node div is position:absolute inside #flowchartCanvas (itself
// position:relative), so offsetLeft/offsetTop are ALREADY canvas-local
// coordinates — no viewport/scroll conversion needed for node-to-node
// geometry, only for the one case that needs a real pointer position (the
// live ghost-edge preview line, handled separately in redrawFlowEdges).
export function rectOf(el){
  return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
}

// Where a straight line from a rect's center to `target` crosses that
// rect's own border — used to clip an edge so it visually starts/ends at
// a node's edge instead of its center.
export function clipToRectEdge(rect, target){
  const cx = rect.x + rect.w/2, cy = rect.y + rect.h/2;
  const dx = target.x - cx, dy = target.y - cy;
  if(dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min((rect.w/2) / Math.abs(dx || 1e-6), (rect.h/2) / Math.abs(dy || 1e-6));
  return { x: cx + dx*scale, y: cy + dy*scale };
}

export const FLOW_ARROWHEAD_DEFS = `<defs><marker id="flowArrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--primary)"></path></marker></defs>`;

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

function renderDescPoints(r){
  const list = document.getElementById('descPointsList');
  if(!list) return;
  list.innerHTML = '';
  r.description.forEach((point, idx) => {
    const row = document.createElement('div');
    row.className = 'desc-point-row';
    row.innerHTML = `
      <span class="step-badge">${idx+1}</span>
      <textarea rows="2" placeholder="e.g. Product characteristics, selling point, target audience..."></textarea>
      <button class="icon-btn" title="Delete">${icon('x')}</button>
    `;
    const ta = row.querySelector('textarea');
    ta.value = point;
    ta.addEventListener('input', e => { r.description[idx] = e.target.value; scheduleSave(); });
    row.querySelector('.icon-btn').addEventListener('click', () => {
      r.description.splice(idx, 1);
      renderDescPoints(r);
      scheduleSave();
    });
    list.appendChild(row);
  });
}

/* Up to 3 reference photos attached to Description / Concept — same pattern
   as the Trial Photos row (resize on upload, thumbnail grid, click to
   remove), just a separate array so the two photo sets don't mix. */
function renderDescPhotos(r){
  const row = document.getElementById('descPhotosRow');
  const input = document.getElementById('descPhotoInput');
  if(!row) return;
  row.innerHTML = r.descPhotos.map((photo, idx) => `
    <div class="trial-photo-thumb" data-idx="${idx}">
      <img src="${escapeHtml(photo)}" alt="Description photo ${idx+1}">
      <button title="Remove this photo">${icon('x')}</button>
    </div>
  `).join('');
  row.querySelectorAll('.trial-photo-thumb button').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.closest('.trial-photo-thumb').dataset.idx, 10);
      r.descPhotos.splice(idx, 1);
      renderDescPhotos(r);
      scheduleSave();
    });
  });
  if(input) input.style.display = r.descPhotos.length >= 3 ? 'none' : '';
}

function withTemporaryVisibility(el, fn){
  const prevCss = el.style.cssText;
  el.style.cssText = 'display:block !important;position:absolute;left:-9999px;top:-9999px;visibility:visible;';
  fn();
  el.style.cssText = prevCss;
}

function renderPrintView(r){
  const infoEl = document.getElementById('printInfoCard');
  if(infoEl){
    const totalWt = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
    infoEl.innerHTML = `
      <div class="ci-name">${escapeHtml(r.name || 'Untitled recipe')}</div>
      <div class="ci-row"><b>Code:</b> ${escapeHtml(fullCode(r) || '-')}</div>
      <div class="ci-row"><b>Date:</b> ${escapeHtml(r.date || '-')}</div>
      <div class="ci-row"><b>Total weight:</b> ${formatWeight(totalWt)}</div>
      ${r.customerName ? `<div class="ci-row"><b>Customer:</b> ${escapeHtml(r.customerName)}</div>` : ''}
      ${r.destinationCountry ? `<div class="ci-row"><b>Destination country:</b> ${escapeHtml(r.destinationCountry)}</div>` : ''}
      ${r.salesRep ? `<div class="ci-row"><b>Sales rep:</b> ${escapeHtml(r.salesRep)}</div>` : ''}
      ${descriptionListHtml(r)}
    `;
  }

  const treeEl = document.getElementById('printIngredientTree');
  if(treeEl){
    const totalWt = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
    treeEl.innerHTML = readOnlyIngredientTreeHtml(r.parts, totalWt, r.processFlowchart.nodes);
  }

  // Mutually exclusive with the flowchart print view below, matching
  // whichever mode is currently selected on-screen (see processViewMode).
  const isFlowMode = r.processViewMode === 'flowchart' && r.processFlowchart.nodes.length > 0;
  const procEl = document.getElementById('printProcessesView');
  if(procEl) procEl.innerHTML = isFlowMode ? '' : readOnlyProcessesHtml(r.processes);

  const flowEl = document.getElementById('printProcessFlowchart');
  if(flowEl){
    if(isFlowMode){
      withTemporaryVisibility(flowEl, () => renderReadOnlyProcessFlowchart(flowEl, r.processFlowchart, r.processes));
    } else {
      flowEl.innerHTML = '';
    }
  }
}

/* ---------- Recipe actions ---------- */
function duplicateCurrent(){
  const r = getCurrent();
  if(!r) return;
  const copy = JSON.parse(JSON.stringify(r));
  copy.id = uid();
  copy.name = (r.name || 'Untitled recipe') + ' (Copy)';
  copy.createdBy = currentUser?.email || '';
  copy.createdAt = Date.now();
  copy.updatedBy = currentUser?.email || '';
  copy.updatedAt = Date.now();
  // A duplicate is a distinct recipe, not the same one — carrying over the
  // original's sequence number would give two recipes the identical code
  // (e.g. both "BRE01"). Computed now, before push, so the count below
  // doesn't include this copy — the original recipe (still in `recipes`)
  // is what makes this land one past it.
  if(copy.productType) copy.recipeSeq = suggestNextRecipeSeq(copy.productType, copy.id);
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
  openRecipe(copy.id);
  setUnlockedRecipeId(copy.id);
  saveRecipeToCloud(copy);
  logActivityEvent('created', 'recipe', copy.name || 'Untitled recipe');
  renderSidebar();
  renderMain();
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
