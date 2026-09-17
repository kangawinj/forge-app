// Version History -- snapshot & restore a recipe's formulation. Split out
// of recipes.js (which grew past 5,200 lines) -- see recipes.js's own
// top-of-file comment for the overall file split.
import {
  escapeHtml, icon, uid, wireModalOverlayClose, renderMain,
  readOnlyIngredientTreeHtml, readOnlyProcessesHtml, renderReadOnlyProcessFlowchart
} from './app.js';
import { migrateRecipe, allIngredientsInRecipe, formatWeight, descriptionListHtml } from './recipes-data.js';
// Circular import back to core recipes.js -- safe, see trials-wizard.js's
// own comment on this same pattern (all cross-calls below happen inside
// event handlers, never at module-evaluation time).
import { performSave } from './recipes.js';

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
      performSave(r);
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
  performSave(r);
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
    ${isFlowMode ? '<div id="versionPreviewFlowchart"></div>' : `<div class="compare-steps-col">${readOnlyProcessesHtml(snap.processes, snap.parts)}</div>`}
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
  wireModalOverlayClose('versionPreviewModalOverlay', closeVersionPreview);
  document.getElementById('btnRestoreFromPreview').addEventListener('click', () => {
    if(!versionPreviewContext) return;
    restoreVersion(versionPreviewContext.recipe, versionPreviewContext.version);
  });
}

export function initVersionsModal(){
  document.getElementById('btnCloseVersionsModal').addEventListener('click', closeVersionsModal);
  wireModalOverlayClose('versionsModalOverlay', closeVersionsModal);
  document.getElementById('btnSaveVersion').addEventListener('click', () => {
    const r = versionsModalRecipe;
    if(!r) return;
    const label = document.getElementById('versionLabelInput').value.trim();
    pushVersionCheckpoint(r, label);
    document.getElementById('versionLabelInput').value = '';
    renderVersionsList(r);
    performSave(r);
  });
}

// Shared by every path that should leave a Version History entry (manual
// Save, the 1-minute idle auto-checkpoint, and "Save Current as Version" in
// the modal) — same snapshot shape, same 5-version cap, one place to change.
export function pushVersionCheckpoint(r, label){
  if(!Array.isArray(r.versions)) r.versions = [];
  r.versions.push({ id: uid(), label, savedAt: Date.now(), snapshot: snapshotRecipeCore(r) });
  if(r.versions.length > 5) r.versions = r.versions.slice(r.versions.length - 5);
}

// Per-recipe-id pending idle-checkpoint timers for scheduleVersionCheckpoint
// / cancelVersionCheckpoint / autoCheckpointVersion below -- module-scoped
// here since ES modules don't share `let` bindings; app.js has its own,
// separately-scoped Map of the same name for an unrelated feature, which is
// just a naming coincidence, not a shared timer.
let versionCheckpointTimers = new Map();

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
