import {
  recipes, escapeHtml, icon, recipeDisplayLabel, fullCode, allIngredientsInRecipe,
  formatWeight, descriptionListHtml, findMaterialByLabel,
  playContentTransition, compareSetsCol, currentUser
} from './app.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { partIngredients, partSubParts, seriesKeyDisplay } from './recipes-data.js';

let compareShowCodes = true;
let compareShowWeights = false;
// Whole-section visibility -- an eye toggle next to each section's own
// title, kept visible even while the section is hidden (see
// sectionTitleWithEye below) so there's always a way to turn it back on.
// Hiding a section hides its title too, not just its body.
let compareShowCosting = true;
let compareShowSteps = true;
// Compare Ingredients: grouped into one table per Part (matching the
// recipe editor's own breakdown, current rows collapsible per section) vs
// one combined table across the whole recipe, ignoring Part boundaries.
let compareGroupByPart = true;
// Per-section collapse state while grouped by Part (keyed by the section's
// own label, since Part has no stable id) -- collapsing hides that
// section's ingredient rows but keeps its title/column headers/subtotal
// visible, same idea as a Part's own collapse in the recipe editor.
// Session-only, not persisted with the rest of a saved comparison.
let comparePartCollapsed = {};
// Free-text note per recipe slot (keyed by recipe id) -- typed here, not
// auto-saved on every keystroke (renderCompareContent() fully rebuilds this
// area on most other changes, e.g. toggling a checkbox, which would lose an
// in-progress edit if it round-tripped through the DOM instead of this
// module-level object). Only persisted, alongside the picked recipes and
// toggles, when "Save Compare Trials" is clicked -- see compareSetsCol.
let compareNotes = {};

// Set by Recipe Detail's "Compare Trials" button just before switching to
// this view (via app.js's shared re-export hub, same pattern
// recipes.js's own recipesListCategoryFilter uses) so the picker starts
// scoped to one Recipe Series instead of every recipe in the app. Cleared
// (null) by every plain "Compare Recipes" entry point, and by the "Show
// All Recipes" button below — never sticky across an unrelated visit.
export let compareSeriesPrefilter = null;
export function setCompareSeriesPrefilter(v){
  compareSeriesPrefilter = v;
}

const MAX_COMPARE_SLOTS = 5;

// Same "one grid track per picker/recipe" inline style trials.js already
// uses for its own product-count grid (see .compare-info-grid's own CSS
// comment) -- the plain CSS class's repeat(5,1fr) is only ever the
// fallback for the very first paint, immediately overridden per mount/
// "+ Add Recipe" click with however many slots are actually showing, so 2
// starting slots don't leave 3 empty grid tracks' worth of dead space.
function gridColsStyle(n){
  return `grid-template-columns:220px repeat(${n},1fr);`;
}

function pickerColHtml(slotIdx, optionsHtml){
  return `
    <div class="compare-picker-col">
      <label>Recipe ${slotIdx+1}</label>
      <select class="compare-select" data-slot="${slotIdx}">
        <option value="">— Not selected —</option>
        ${optionsHtml}
      </select>
    </div>
  `;
}

export function mountCompareView(){
  const main = document.getElementById('mainArea');
  main.classList.add('main-wide');
  const candidates = compareSeriesPrefilter
    ? recipes.filter(r => r.seriesId === compareSeriesPrefilter.seriesId)
    : recipes;
  // Alphabetical by product name, then by code, so recipes are easy to find
  // in the dropdown instead of jumping around by last-edited time.
  const sorted = [...candidates].sort((a,b) =>
    (a.name||'Untitled recipe').localeCompare(b.name||'Untitled recipe', undefined, {sensitivity:'base'}) ||
    (a.code||'').localeCompare(b.code||'', undefined, {numeric:true})
  );
  const options = sorted.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(recipeDisplayLabel(r))}</option>`).join('');
  // Always start blank, at just 2 slots — the user picks recipes fresh
  // every time this view opens, rather than defaulting to the most
  // recently updated ones or to every slot up to the max at once. "+ Add
  // Recipe" below grows it one slot at a time, up to MAX_COMPARE_SLOTS.
  const startSlots = 2;
  const pickersHtml = Array.from({length: startSlots}, (_, i) => pickerColHtml(i, options)).join('');

  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('scale', 24)} ${compareSeriesPrefilter ? 'Compare Trials' : 'Compare Recipes'}${compareSeriesPrefilter ? ` — ${escapeHtml(seriesKeyDisplay(compareSeriesPrefilter.seriesKey, candidates[0]))}` : ''}</div>
      <div class="toolbar">
        ${compareSeriesPrefilter ? `<button class="btn btn-sm" id="btnCompareShowAll">Show All Recipes</button>` : ''}
        ${compareSeriesPrefilter ? `<button class="btn btn-sm" id="btnSaveCompareSet">${icon('save', 14)} Save Compare Trials</button>` : ''}
        <button class="btn" id="btnPrintCompare">${icon('printer')} Print</button>
      </div>
    </div>
    <div class="card compare-root-card">
      <div class="compare-pickers" id="comparePickers" style="${gridColsStyle(startSlots)}"><div class="compare-info-spacer"></div>${pickersHtml}</div>
      <button class="btn btn-sm" type="button" id="btnAddCompareSlot" style="margin-top:10px;">+ Add Recipe</button>
      <div id="compareContent"></div>
    </div>
  `;

  document.getElementById('btnPrintCompare').addEventListener('click', () => {
    // Browsers default the "Save as PDF" filename to document.title -- set
    // it to "<loaded date/time> <page name> Forge <account>" just for the
    // print, then restore the real page title afterwards (same pattern as
    // recipes.js's own Print and projects.js's per-project Print).
    const originalTitle = document.title;
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateTimeStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const pageLabel = compareSeriesPrefilter
      ? `Compare Trials — ${seriesKeyDisplay(compareSeriesPrefilter.seriesKey, candidates[0])}`
      : 'Compare Recipes';
    document.title = `${dateTimeStr} ${pageLabel} Forge ${currentUser?.email || ''}`.replace(/[\\/:*?"<>|]/g, '-');
    const restoreTitle = () => {
      document.title = originalTitle;
      window.removeEventListener('afterprint', restoreTitle);
    };
    window.addEventListener('afterprint', restoreTitle);
    window.print();
  });
  document.getElementById('btnCompareShowAll')?.addEventListener('click', () => {
    compareSeriesPrefilter = null;
    mountCompareView();
  });
  document.querySelectorAll('.compare-select').forEach(sel => {
    sel.addEventListener('change', renderCompareContent);
  });

  function updateAddSlotBtnVisibility(){
    const addBtn = document.getElementById('btnAddCompareSlot');
    if(addBtn) addBtn.style.display = document.querySelectorAll('.compare-select').length >= MAX_COMPARE_SLOTS ? 'none' : '';
  }
  updateAddSlotBtnVisibility();

  // Appends one more picker slot (up to MAX_COMPARE_SLOTS) -- shared by the
  // "+ Add Recipe" click below and by restoring a saved set with more than
  // 2 recipes in it (see loadSavedCompareSet).
  function addSlot(){
    const pickers = document.getElementById('comparePickers');
    const slotIdx = document.querySelectorAll('.compare-select').length;
    if(slotIdx >= MAX_COMPARE_SLOTS) return null;
    pickers.insertAdjacentHTML('beforeend', pickerColHtml(slotIdx, options));
    pickers.setAttribute('style', gridColsStyle(slotIdx+1));
    const sel = pickers.lastElementChild.querySelector('.compare-select');
    sel.addEventListener('change', renderCompareContent);
    updateAddSlotBtnVisibility();
    return sel;
  }
  document.getElementById('btnAddCompareSlot').addEventListener('click', () => {
    if(addSlot()) renderCompareContent();
  });

  // Compare Trials (series-scoped only — one saved set per series, see
  // compareSetsCol in app.js) restores whichever Trials/toggles were last
  // saved for this series, so reopening it doesn't start from a blank
  // picker every time. Fetched in the background after the first paint
  // rather than blocking it, since it's a nice-to-have, not the view's
  // critical path.
  async function loadSavedCompareSet(){
    if(!compareSeriesPrefilter) return;
    let snap;
    try {
      snap = await getDoc(doc(compareSetsCol, compareSeriesPrefilter.seriesId));
    } catch(err) { return; } // offline/permission hiccup -- just stay on the blank picker
    if(!snap.exists()) return;
    const saved = snap.data();
    const ids = (saved.recipeIds || []).filter(id => candidates.some(r => r.id === id));
    if(ids.length === 0) return;
    let selects = [...document.querySelectorAll('.compare-select')];
    while(selects.length < ids.length){
      const sel = addSlot();
      if(!sel) break;
      selects.push(sel);
    }
    selects.forEach((sel, idx) => { sel.value = ids[idx] || ''; });
    // renderCompareContent() (below) rebuilds the checkbox markup from these
    // module-level vars on every render, so setting them here is enough --
    // no need to separately touch the (about to be replaced) checkbox DOM.
    compareShowCodes = saved.showCodes !== false;
    compareShowWeights = !!saved.showWeights;
    compareShowCosting = saved.showCosting !== false;
    compareShowSteps = saved.showSteps !== false;
    compareGroupByPart = saved.groupByPart !== false;
    compareNotes = { ...(saved.notes || {}) };
    renderCompareContent();
  }
  document.getElementById('btnSaveCompareSet')?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    const ids = [...document.querySelectorAll('.compare-select')].map(sel => sel.value).filter(Boolean);
    const original = btn.innerHTML;
    try {
      await setDoc(doc(compareSetsCol, compareSeriesPrefilter.seriesId), {
        seriesId: compareSeriesPrefilter.seriesId,
        recipeIds: ids,
        showCodes: compareShowCodes,
        showWeights: compareShowWeights,
        showCosting: compareShowCosting,
        showSteps: compareShowSteps,
        groupByPart: compareGroupByPart,
        notes: compareNotes,
        savedAt: Date.now(),
        savedBy: currentUser?.email || '',
      });
      btn.innerHTML = `${icon('check', 14)} Saved`;
    } catch(err){
      btn.innerHTML = `${icon('save', 14)} Save failed`;
    }
    setTimeout(() => { btn.innerHTML = original; }, 1800);
  });

  renderCompareContent();
  loadSavedCompareSet();
  playContentTransition(main);
}

function stripIngredientCode(label){
  return label.replace(/\s*\([^)]*\)\s*$/, '');
}

// A section title with an eye toggle beside it (Compare Costing / Compare
// Process Steps) -- when hidden, the label text disappears too, but this
// row itself (and its button) stays, so there's still something to click
// to bring the section back.
function sectionTitleWithEye(toggleId, label, visible){
  return `
    <div class="compare-section-title compare-section-title-toggle">
      ${visible ? label : ''}
      <button type="button" class="compare-section-eye-btn" id="${toggleId}" title="${visible ? 'Hide this section' : 'Show this section'}">${icon(visible ? 'eye' : 'eye-off', 14)}</button>
    </div>
  `;
}

function renderCompareContent(){
  const content = document.getElementById('compareContent');
  const ids = [...document.querySelectorAll('.compare-select')].map(sel => sel.value);
  const selected = ids.map(id => recipes.find(r => r.id === id)).filter(Boolean);
  const showCodes = compareShowCodes;
  const showWeights = compareShowWeights;

  if(selected.length < 2){
    content.innerHTML = '<div class="compare-empty">Select at least 2 recipes to compare</div>';
    return;
  }

  // --- basic info ---
  const infoHtml = ids.map(id => {
    const r = recipes.find(x => x.id === id);
    if(!r) return '<div class="compare-info-col"><div class="compare-empty" style="padding:8px 0;">— Not selected —</div></div>';
    const totalWt = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
    return `
      <div class="compare-info-col">
        <div class="ci-name">${escapeHtml(r.name || 'Untitled recipe')}</div>
        <div class="ci-row"><b>Code:</b> ${escapeHtml(fullCode(r) || '-')}</div>
        <div class="ci-row"><b>Date:</b> ${escapeHtml(r.date || '-')}</div>
        <div class="ci-row"><b>Total weight:</b> ${formatWeight(totalWt)}</div>
        ${r.customerName ? `<div class="ci-row"><b>Customer:</b> ${escapeHtml(r.customerName)}</div>` : ''}
        ${r.destinationCountry ? `<div class="ci-row"><b>Destination country:</b> ${escapeHtml(r.destinationCountry)}</div>` : ''}
        ${r.salesRep ? `<div class="ci-row"><b>Sales rep:</b> ${escapeHtml(r.salesRep)}</div>` : ''}
        ${descriptionListHtml(r)}
        ${compareSeriesPrefilter ? `
          <div class="ci-row" style="margin-top:8px;">
            <label style="display:block;font-weight:600;margin-bottom:4px;">Note:</label>
            <textarea class="compare-note-input" data-recipe-id="${escapeHtml(r.id)}" rows="2" placeholder="Add a note about this trial…">${escapeHtml(compareNotes[r.id] || '')}</textarea>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  // --- ingredient comparison (union across selected recipes) ---
  const ingredientRows = new Map(); // key -> { label, values: {recipeId: pct}, weights: {recipeId: g} }
  selected.forEach(r => {
    const allIng = allIngredientsInRecipe(r).filter(i => (i.name||'').trim() !== '');
    allIng.forEach(i => {
      const key = i.name.trim().toLowerCase();
      if(!ingredientRows.has(key)) ingredientRows.set(key, { label: i.name.trim(), values: {}, weights: {} });
      const row = ingredientRows.get(key);
      row.weights[r.id] = (row.weights[r.id] || 0) + (parseFloat(i.weight) || 0);
    });
  });
  // % of recipe, computed from weight per recipe — ing.percent is now each
  // ingredient's % of its own part, not of the whole recipe, so it can't be
  // summed directly here.
  selected.forEach(r => {
    const totalWt = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
    ingredientRows.forEach(row => {
      const wt = row.weights[r.id];
      if(wt !== undefined) row.values[r.id] = totalWt > 0 ? (wt / totalWt * 100) : 0;
    });
  });

  const rows = [...ingredientRows.values()].sort((a,b) => {
    const maxA = Math.max(...ids.map(id => a.values[id] || 0));
    const maxB = Math.max(...ids.map(id => b.values[id] || 0));
    return maxB - maxA;
  });

  // A visible left border on the first column of every recipe (after the
  // first) so, when scanning several recipes side by side, it's obvious at
  // a glance where one recipe's numbers end and the next one's begin.
  function boundaryClass(idx){ return idx > 0 ? ' recipe-boundary' : ''; }

  // Fixed-width label column + N equal unset-width columns — with
  // table-layout:fixed, unset <col>s split the remaining width evenly, so
  // this lines each recipe's column(s) up with its equal-width info card.
  function colgroupHtml(numDataCols){
    return `<colgroup><col style="width:220px;">${'<col>'.repeat(numDataCols)}</colgroup>`;
  }

  // The ingredient/costing tables identify each recipe by just its code
  // (already shown in full above in the info cards) rather than repeating
  // the full product name — keeps these columns narrow and lined up with
  // the equal-width info cards instead of stretching wide per recipe name.
  function recipeColLabel(r){
    return fullCode(r) || recipeDisplayLabel(r);
  }

  const ingHeaderCells = ids.map((id, idx) => {
    const r = recipes.find(x => x.id === id);
    return `<th class="${boundaryClass(idx)}">${r ? escapeHtml(recipeColLabel(r)) : '-'}</th>`;
  }).join('');

  // With weights on, % and g get their own aligned columns per recipe
  // (rather than being crammed into one cell) — a two-row header names the
  // recipe once, then labels each of its two sub-columns.
  const ingHeaderRowsHtml = showWeights
    ? `
      <tr><th rowspan="2">Ingredient</th>${ids.map((id, idx) => {
        const r = recipes.find(x => x.id === id);
        return `<th colspan="2" class="${boundaryClass(idx)}">${r ? escapeHtml(recipeColLabel(r)) : '-'}</th>`;
      }).join('')}</tr>
      <tr>${ids.map((id, idx) => `<th class="col-pct${boundaryClass(idx)}">%</th><th class="col-wt">g</th>`).join('')}</tr>
    `
    : `<tr><th>Ingredient</th>${ingHeaderCells}</tr>`;

  // Same union-by-name logic as above, but scoped to one part position at a
  // time (mirrors the recipe page, where ingredients are grouped by Part
  // rather than shown as one flat list) — % stays "% of whole recipe" so
  // the numbers are still directly comparable across parts and recipes.
  // Returns two cells (% | g) when showWeights is on, so the numbers line
  // up in their own columns instead of being stacked inside one cell.
  function ingCell(row, id, idx){
    if(!selected.some(r => r.id === id)){
      return showWeights ? `<td class="${boundaryClass(idx)}">-</td><td>-</td>` : `<td class="${boundaryClass(idx)}">-</td>`;
    }
    const v = row.values[id];
    if(v === undefined){
      return showWeights
        ? `<td class="compare-missing${boundaryClass(idx)}" colspan="2">— Not used —</td>`
        : `<td class="compare-missing${boundaryClass(idx)}">— Not used —</td>`;
    }
    if(!showWeights) return `<td class="${boundaryClass(idx)}">${v.toFixed(2)}%</td>`;
    const wt = row.weights[id] || 0;
    return `<td class="col-pct${boundaryClass(idx)}">${v.toFixed(2)}%</td><td class="col-wt">${formatWeight(wt)}</td>`;
  }

  // Builds one section per Part at a given tree level, then recurses into
  // each one's own Sub-parts -- mirrors the recipe editor's own nesting
  // (Part > Sub-part > Sub-sub-part...) instead of flattening everything
  // under its top-level Part like the old position-only version did. Parts
  // are matched across the selected recipes by NAME (trimmed,
  // case-insensitive) at each level, same as ingredient rows are unioned by
  // name -- position alone isn't reliable once recipes can have differently-
  // ordered or differently-nested Sub-parts. `path` (not just the label) is
  // the section's identity for collapse-state/DOM purposes, since two
  // different Sub-parts under different parents can share a plain name like
  // "Sauce".
  function buildPartSections(getLevelParts, depth, parentPath){
    const order = [];
    const byKey = new Map();
    selected.forEach(r => {
      (getLevelParts(r) || []).forEach((part, idx) => {
        const nm = (part.name || '').trim();
        const key = nm ? nm.toLowerCase() : `__unnamed_${idx}`;
        if(!byKey.has(key)){
          byKey.set(key, { label: nm || `Part ${idx+1}`, partsByRecipe: new Map() });
          order.push(key);
        }
        byKey.get(key).partsByRecipe.set(r.id, part);
      });
    });
    return order.map(key => {
      const entry = byKey.get(key);
      const path = parentPath ? `${parentPath} > ${entry.label}` : entry.label;
      const partRows = new Map();
      selected.forEach(r => {
        const part = entry.partsByRecipe.get(r.id);
        if(!part) return;
        const totalWt = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
        // Only this Part's OWN direct ingredients -- Sub-parts get their own
        // separate (nested) section below, not folded in here.
        partIngredients(part).filter(i => (i.name||'').trim() !== '').forEach(i => {
          const rowKey = i.name.trim().toLowerCase();
          if(!partRows.has(rowKey)) partRows.set(rowKey, { label: i.name.trim(), values: {}, weights: {} });
          const row = partRows.get(rowKey);
          const wt = (row.weights[r.id] || 0) + (parseFloat(i.weight) || 0);
          row.weights[r.id] = wt;
          row.values[r.id] = totalWt > 0 ? (wt / totalWt * 100) : 0;
        });
      });
      const sortedRows = [...partRows.values()].sort((a,b) => {
        const maxA = Math.max(...ids.map(id => a.values[id] || 0));
        const maxB = Math.max(...ids.map(id => b.values[id] || 0));
        return maxB - maxA;
      });
      const subSections = buildPartSections(
        r => partSubParts(entry.partsByRecipe.get(r.id) || { items: [] }),
        depth + 1,
        path
      );
      return { label: entry.label, path, depth, rows: sortedRows, subSections };
    }).filter(section => section.rows.length > 0 || section.subSections.length > 0);
  }
  const partSections = buildPartSections(r => r.parts, 0, '');

  // A section's own rows only cover its DIRECT ingredients (see
  // buildPartSections above) -- its Subtotal, though, is expected to read
  // the same way a Part header's own Formula WT./% of Recipe does in the
  // live editor: the WHOLE subtree, every Sub-part nested inside it
  // included, not just what's directly listed in its own table. Recurses
  // down every subSection and adds its rows in too.
  function sectionRecursiveTotals(section){
    const totals = {};
    ids.forEach(id => { totals[id] = { pct: 0, wt: 0 }; });
    section.rows.forEach(row => {
      ids.forEach(id => {
        totals[id].pct += row.values[id] || 0;
        totals[id].wt += row.weights[id] || 0;
      });
    });
    section.subSections.forEach(sub => {
      const subTotals = sectionRecursiveTotals(sub);
      ids.forEach(id => {
        totals[id].pct += subTotals[id].pct;
        totals[id].wt += subTotals[id].wt;
      });
    });
    return totals;
  }

  function renderPartSection(section){
    const collapsed = !!comparePartCollapsed[section.path];
    const bodyRows = section.rows.map(row => {
      const presentCount = ids.filter(id => selected.some(r=>r.id===id) && row.values[id] !== undefined).length;
      const isDiff = presentCount > 0 && presentCount < selected.length;
      const cells = ids.map((id, idx) => ingCell(row, id, idx)).join('');
      const displayLabel = showCodes ? row.label : stripIngredientCode(row.label);
      return `<tr class="${isDiff ? 'diff-row' : ''}"><td>${escapeHtml(displayLabel)}</td>${cells}</tr>`;
    }).join('');
    const recursiveTotals = sectionRecursiveTotals(section);
    const subtotalCells = ids.map((id, idx) => {
      if(!selected.some(r => r.id === id)) return showWeights ? `<td class="${boundaryClass(idx)}">-</td><td>-</td>` : `<td class="${boundaryClass(idx)}">-</td>`;
      const { pct, wt } = recursiveTotals[id];
      return showWeights
        ? `<td class="col-pct${boundaryClass(idx)}">${pct.toFixed(2)}%</td><td class="col-wt">${formatWeight(wt)}</td>`
        : `<td class="${boundaryClass(idx)}">${pct.toFixed(2)}%</td>`;
    }).join('');
    // Only this Part's own direct ingredients get a table (a Sub-part with
    // no direct ingredients of its own, just further Sub-parts, skips
    // straight to its children instead of showing an empty table).
    const tableHtml = section.rows.length === 0 ? '' : `
      <div style="overflow-x:auto;">
        <table class="compare-table">
          ${colgroupHtml(ids.length * (showWeights ? 2 : 1))}
          <thead>${ingHeaderRowsHtml}</thead>
          <tbody>${collapsed ? '' : bodyRows}</tbody>
          <tfoot><tr class="total-row"><td>${escapeHtml(section.label)} Subtotal</td>${subtotalCells}</tr></tfoot>
        </table>
      </div>
    `;
    const childrenHtml = collapsed ? '' : section.subSections.map(renderPartSection).join('');
    return `
      <div class="compare-section-title compare-part-section-title" style="font-size:13px;margin:16px 0 8px;padding-left:${section.depth*20}px;">
        <button type="button" class="compare-section-eye-btn compare-part-collapse-btn" data-section="${escapeHtml(section.path)}" title="${collapsed ? 'Expand this part' : 'Collapse this part'}">${icon(collapsed ? 'chevron-right' : 'chevron-down', 14)}</button>
        ${escapeHtml(section.label)}
      </div>
      <div style="padding-left:${section.depth*20}px;">
        ${tableHtml}
        ${childrenHtml}
      </div>
    `;
  }
  const partSectionsHtml = partSections.map(renderPartSection).join('');

  // Combined mode ignores Part boundaries entirely -- one flat table over
  // `rows`, the same whole-recipe ingredient union already built above for
  // the Recipe Total footer row.
  const combinedBodyRows = rows.map(row => {
    const presentCount = ids.filter(id => selected.some(r=>r.id===id) && row.values[id] !== undefined).length;
    const isDiff = presentCount > 0 && presentCount < selected.length;
    const cells = ids.map((id, idx) => ingCell(row, id, idx)).join('');
    const displayLabel = showCodes ? row.label : stripIngredientCode(row.label);
    return `<tr class="${isDiff ? 'diff-row' : ''}"><td>${escapeHtml(displayLabel)}</td>${cells}</tr>`;
  }).join('');
  const combinedTableHtml = `
    <div style="overflow-x:auto;">
      <table class="compare-table">
        ${colgroupHtml(ids.length * (showWeights ? 2 : 1))}
        <thead>${ingHeaderRowsHtml}</thead>
        <tbody>${combinedBodyRows || `<tr><td colspan="${ids.length+1}" class="compare-empty">No ingredients yet</td></tr>`}</tbody>
      </table>
    </div>
  `;

  const totalCells = ids.map((id, idx) => {
    const r = recipes.find(x => x.id === id);
    if(!r) return `<td class="${boundaryClass(idx)}">-</td>`;
    // Summing each ingredient's already-rounded % can drift off 100% (e.g.
    // 99.99%) purely from rounding noise. % is always weight/totalWeight, so
    // the true total is exactly 100% by construction whenever there's any
    // weight at all — same fix as the Grand Total box on the recipe page.
    const totalWt = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
    const totalPct = totalWt > 0 ? 100 : 0;
    return `<td class="${boundaryClass(idx)}">${totalPct.toFixed(2)}%</td>`;
  }).join('');

  // --- costing comparison (weight × library price/kg, per ingredient) ---
  function priceOf(label){
    const m = findMaterialByLabel(label);
    if(!m || m.price === '' || m.price == null) return null;
    const p = parseFloat(m.price);
    return isNaN(p) ? null : p;
  }

  const costRows = rows.map(row => {
    const price = priceOf(row.label);
    const cells = ids.map((id, idx) => {
      if(!selected.some(r => r.id === id)) return `<td class="${boundaryClass(idx)}">-</td>`;
      const wt = row.weights[id];
      if(wt === undefined) return `<td class="compare-missing${boundaryClass(idx)}">— Not used —</td>`;
      if(price === null) return `<td class="compare-missing${boundaryClass(idx)}">No price set</td>`;
      return `<td class="${boundaryClass(idx)}">฿${((wt / 1000) * price).toFixed(2)}</td>`;
    }).join('');
    const displayLabel = showCodes ? row.label : stripIngredientCode(row.label);
    return `<tr><td>${escapeHtml(displayLabel)}</td>${cells}</tr>`;
  }).join('');

  const costTotalCells = ids.map((id, idx) => {
    if(!selected.some(r => r.id === id)) return `<td class="${boundaryClass(idx)}">-</td>`;
    let total = 0;
    let hasUnpriced = false;
    rows.forEach(row => {
      const wt = row.weights[id];
      if(wt === undefined) return;
      const price = priceOf(row.label);
      if(price === null){ hasUnpriced = true; return; }
      total += (wt / 1000) * price;
    });
    return `<td class="${boundaryClass(idx)}">฿${total.toFixed(2)}${hasUnpriced ? ' *' : ''}</td>`;
  }).join('');

  const costPerKgCells = ids.map((id, idx) => {
    if(!selected.some(r => r.id === id)) return `<td class="${boundaryClass(idx)}">-</td>`;
    const r = recipes.find(x => x.id === id);
    let total = 0;
    let hasUnpriced = false;
    rows.forEach(row => {
      const wt = row.weights[id];
      if(wt === undefined) return;
      const price = priceOf(row.label);
      if(price === null){ hasUnpriced = true; return; }
      total += (wt / 1000) * price;
    });
    const batchKg = (r && r.batchWeight) ? r.batchWeight / 1000 : 0;
    if(batchKg <= 0) return `<td class="compare-missing${boundaryClass(idx)}">No batch weight</td>`;
    return `<td class="${boundaryClass(idx)}">฿${(total / batchKg).toFixed(2)}${hasUnpriced ? ' *' : ''}</td>`;
  }).join('');

  // --- steps comparison ---
  const stepsHtml = ids.map(id => {
    const r = recipes.find(x => x.id === id);
    if(!r) return '<div class="compare-steps-col compare-empty">— Not selected —</div>';
    const processes = (r.processes || []).filter(p => (p.title||'').trim() !== '' || (p.steps||[]).some(s => (s||'').trim() !== ''));
    const processesHtml = processes.map(p => {
      const steps = (p.steps || []).filter(s => (s||'').trim() !== '');
      return `
        <div class="compare-process-title">${escapeHtml(p.title || 'Untitled process')}</div>
        ${steps.length ? `<ol>${steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : '<div class="compare-missing">No steps yet</div>'}
      `;
    }).join('');
    return `
      <div class="compare-steps-col">
        <div class="ci-name" style="font-size:13px;">${escapeHtml(recipeDisplayLabel(r))}</div>
        ${processesHtml || '<div class="compare-missing">No processes yet</div>'}
      </div>
    `;
  }).join('');

  content.innerHTML = `
    <div class="compare-info-grid" style="${gridColsStyle(ids.length)}"><div class="compare-info-spacer"></div>${infoHtml}</div>

    <div class="compare-section-title">Compare Ingredients (% of recipe)</div>
    <label class="compare-toggle-label">
      <input type="checkbox" id="compareShowCodes" ${showCodes ? 'checked' : ''}>
      Show ingredient codes
    </label>
    <label class="compare-toggle-label">
      <input type="checkbox" id="compareShowWeights" ${showWeights ? 'checked' : ''}>
      Also show weight (g)
    </label>
    <label class="compare-toggle-label">
      <input type="radio" name="compareGroupMode" id="compareGroupByPartRadio" value="byPart" ${compareGroupByPart ? 'checked' : ''}>
      Group by Part
    </label>
    <label class="compare-toggle-label">
      <input type="radio" name="compareGroupMode" id="compareGroupCombinedRadio" value="combined" ${compareGroupByPart ? '' : 'checked'}>
      Combined (one table)
    </label>
    ${compareGroupByPart ? (partSectionsHtml || '<div class="compare-empty">No ingredients yet</div>') : combinedTableHtml}
    <div style="overflow-x:auto;margin-top:16px;">
      <table class="compare-table">
        ${colgroupHtml(ids.length)}
        <thead><tr><th>Recipe Total</th>${ingHeaderCells}</tr></thead>
        <tfoot><tr class="total-row"><td>Total</td>${totalCells}</tr></tfoot>
      </table>
    </div>
    <div class="compare-legend"><span class="swatch"></span>Light orange rows = ingredients not used identically across all selected recipes</div>

    ${sectionTitleWithEye('toggleCostingSection', 'Compare Costing (weight × library price/kg)', compareShowCosting)}
    ${compareShowCosting ? `
      <div style="overflow-x:auto;">
        <table class="compare-table">
          ${colgroupHtml(ids.length)}
          <thead><tr><th>Ingredient</th>${ingHeaderCells}</tr></thead>
          <tbody>${costRows || `<tr><td colspan="${ids.length+1}" class="compare-empty">No ingredients yet</td></tr>`}</tbody>
          <tfoot>
            <tr class="total-row"><td>Total Cost</td>${costTotalCells}</tr>
            <tr class="total-row"><td>Cost / kg of product</td>${costPerKgCells}</tr>
          </tfoot>
        </table>
      </div>
      <div class="compare-legend">Costs are in Thai Baht (฿), calculated from weight × the ingredient's Price/kg in the library. "No price set" ingredients are excluded from Total Cost — a "*" marks a total that is a partial estimate because at least one ingredient has no price on file. "Cost / kg of product" divides Total Cost by the recipe's batch weight, so costs are comparable per kg of finished product even when batch sizes differ.</div>
    ` : ''}

    ${sectionTitleWithEye('toggleStepsSection', 'Compare Process Steps', compareShowSteps)}
    ${compareShowSteps ? `<div class="compare-steps-grid" style="${gridColsStyle(ids.length)}"><div class="compare-info-spacer"></div>${stepsHtml}</div>` : ''}
  `;

  document.getElementById('compareShowCodes').addEventListener('change', e => {
    compareShowCodes = e.target.checked;
    renderCompareContent();
  });
  document.getElementById('compareShowWeights').addEventListener('change', e => {
    compareShowWeights = e.target.checked;
    renderCompareContent();
  });
  document.getElementById('compareGroupByPartRadio').addEventListener('change', () => {
    compareGroupByPart = true;
    renderCompareContent();
  });
  document.getElementById('compareGroupCombinedRadio').addEventListener('change', () => {
    compareGroupByPart = false;
    renderCompareContent();
  });
  document.querySelectorAll('.compare-part-collapse-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const label = btn.dataset.section;
      comparePartCollapsed[label] = !comparePartCollapsed[label];
      renderCompareContent();
    });
  });
  document.getElementById('toggleCostingSection').addEventListener('click', () => {
    compareShowCosting = !compareShowCosting;
    renderCompareContent();
  });
  document.getElementById('toggleStepsSection').addEventListener('click', () => {
    compareShowSteps = !compareShowSteps;
    renderCompareContent();
  });
  // Just updates the module-level object, not a re-render (see compareNotes
  // above) -- re-rendering on every keystroke would blow away the cursor/
  // focus mid-sentence.
  document.querySelectorAll('.compare-note-input').forEach(el => {
    el.addEventListener('input', e => {
      compareNotes[e.target.dataset.recipeId] = e.target.value;
    });
  });
}
