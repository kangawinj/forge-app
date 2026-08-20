import {
  recipes, escapeHtml, icon, recipeDisplayLabel, fullCode, allIngredientsInRecipe,
  allIngredientsInPart, formatWeight, descriptionListHtml, findMaterialByLabel,
  playContentTransition
} from './app.js';

let compareShowCodes = true;
let compareShowWeights = false;

export function mountCompareView(){
  const main = document.getElementById('mainArea');
  main.classList.add('main-wide');
  // Alphabetical by product name, then by code, so recipes are easy to find
  // in the dropdown instead of jumping around by last-edited time.
  const sorted = [...recipes].sort((a,b) =>
    (a.name||'Untitled recipe').localeCompare(b.name||'Untitled recipe', undefined, {sensitivity:'base'}) ||
    (a.code||'').localeCompare(b.code||'', undefined, {numeric:true})
  );
  const options = sorted.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(recipeDisplayLabel(r))}</option>`).join('');
  // Always start blank — the user picks recipes fresh every time this view
  // opens, rather than defaulting to the most recently updated ones.
  const pickersHtml = [0,1,2].map(i => `
    <div class="compare-picker-col">
      <label>Recipe ${i+1}</label>
      <select class="compare-select" data-slot="${i}">
        <option value="">— Not selected —</option>
        ${options}
      </select>
    </div>
  `).join('');

  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('scale', 24)} Compare Recipes</div>
      <div class="toolbar">
        <button class="btn" id="btnPrintCompare">${icon('printer')} Print</button>
      </div>
    </div>
    <div class="card">
      <div class="compare-pickers" id="comparePickers"><div class="compare-info-spacer"></div>${pickersHtml}</div>
      <div id="compareContent"></div>
    </div>
  `;

  document.getElementById('btnPrintCompare').addEventListener('click', () => window.print());
  document.querySelectorAll('.compare-select').forEach(sel => {
    sel.addEventListener('change', renderCompareContent);
  });

  renderCompareContent();
  playContentTransition(main);
}

function stripIngredientCode(label){
  return label.replace(/\s*\([^)]*\)\s*$/, '');
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
  // first) so, when scanning 3 recipes side by side, it's obvious at a
  // glance where one recipe's numbers end and the next one's begin.
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

  const maxParts = Math.max(0, ...selected.map(r => (r.parts || []).length));
  const partSections = [];
  for(let pIdx = 0; pIdx < maxParts; pIdx++){
    const partRows = new Map();
    selected.forEach(r => {
      const part = (r.parts || [])[pIdx];
      if(!part) return;
      const totalWt = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
      // Includes ingredients nested inside this Part's own Sub-parts too
      // (allIngredientsInPart), so the comparison numbers stay complete —
      // this section just doesn't visually distinguish which Sub-part each
      // one came from.
      allIngredientsInPart(part).filter(i => (i.name||'').trim() !== '').forEach(i => {
        const key = i.name.trim().toLowerCase();
        if(!partRows.has(key)) partRows.set(key, { label: i.name.trim(), values: {}, weights: {} });
        const row = partRows.get(key);
        const wt = (row.weights[r.id] || 0) + (parseFloat(i.weight) || 0);
        row.weights[r.id] = wt;
        row.values[r.id] = totalWt > 0 ? (wt / totalWt * 100) : 0;
      });
    });
    if(partRows.size === 0) continue; // no recipe has ingredients at this part position — skip the empty section

    let label = `Part ${pIdx+1}`;
    for(const r of selected){
      const nm = (r.parts?.[pIdx]?.name || '').trim();
      if(nm){ label = nm; break; }
    }

    const sortedRows = [...partRows.values()].sort((a,b) => {
      const maxA = Math.max(...ids.map(id => a.values[id] || 0));
      const maxB = Math.max(...ids.map(id => b.values[id] || 0));
      return maxB - maxA;
    });
    partSections.push({ label, rows: sortedRows });
  }

  const partSectionsHtml = partSections.map(section => {
    const bodyRows = section.rows.map(row => {
      const presentCount = ids.filter(id => selected.some(r=>r.id===id) && row.values[id] !== undefined).length;
      const isDiff = presentCount > 0 && presentCount < selected.length;
      const cells = ids.map((id, idx) => ingCell(row, id, idx)).join('');
      const displayLabel = showCodes ? row.label : stripIngredientCode(row.label);
      return `<tr class="${isDiff ? 'diff-row' : ''}"><td>${escapeHtml(displayLabel)}</td>${cells}</tr>`;
    }).join('');
    const subtotalCells = ids.map((id, idx) => {
      if(!selected.some(r => r.id === id)) return showWeights ? `<td class="${boundaryClass(idx)}">-</td><td>-</td>` : `<td class="${boundaryClass(idx)}">-</td>`;
      let pct = 0, wt = 0;
      section.rows.forEach(row => { pct += row.values[id] || 0; wt += row.weights[id] || 0; });
      return showWeights
        ? `<td class="col-pct${boundaryClass(idx)}">${pct.toFixed(2)}%</td><td class="col-wt">${formatWeight(wt)}</td>`
        : `<td class="${boundaryClass(idx)}">${pct.toFixed(2)}%</td>`;
    }).join('');
    return `
      <div class="compare-section-title" style="font-size:13px;margin:16px 0 8px;">${escapeHtml(section.label)}</div>
      <div style="overflow-x:auto;">
        <table class="compare-table">
          ${colgroupHtml(ids.length * (showWeights ? 2 : 1))}
          <thead>${ingHeaderRowsHtml}</thead>
          <tbody>${bodyRows}</tbody>
          <tfoot><tr class="total-row"><td>${escapeHtml(section.label)} Subtotal</td>${subtotalCells}</tr></tfoot>
        </table>
      </div>
    `;
  }).join('');

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
    <div class="compare-info-grid"><div class="compare-info-spacer"></div>${infoHtml}</div>

    <div class="compare-section-title">Compare Ingredients (% of recipe)</div>
    <label class="compare-toggle-label">
      <input type="checkbox" id="compareShowCodes" ${showCodes ? 'checked' : ''}>
      Show ingredient codes
    </label>
    <label class="compare-toggle-label">
      <input type="checkbox" id="compareShowWeights" ${showWeights ? 'checked' : ''}>
      Also show weight (g)
    </label>
    ${partSectionsHtml || '<div class="compare-empty">No ingredients yet</div>'}
    <div style="overflow-x:auto;margin-top:16px;">
      <table class="compare-table">
        ${colgroupHtml(ids.length)}
        <thead><tr><th>Recipe Total</th>${ingHeaderCells}</tr></thead>
        <tfoot><tr class="total-row"><td>Total</td>${totalCells}</tr></tfoot>
      </table>
    </div>
    <div class="compare-legend"><span class="swatch"></span>Light orange rows = ingredients not used identically across all selected recipes</div>

    <div class="compare-section-title">Compare Costing (weight × library price/kg)</div>
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

    <div class="compare-section-title">Compare Process Steps</div>
    <div class="compare-steps-grid"><div class="compare-info-spacer"></div>${stepsHtml}</div>
  `;

  document.getElementById('compareShowCodes').addEventListener('change', e => {
    compareShowCodes = e.target.checked;
    renderCompareContent();
  });
  document.getElementById('compareShowWeights').addEventListener('change', e => {
    compareShowWeights = e.target.checked;
    renderCompareContent();
  });
}
