// Read-only ingredient-tree/process/flowchart renderers (shared by
// Print, Version Preview, and Compare) plus the Prepare-weight/costing
// math they and the live editor both depend on. Split out of app.js --
// see app.js's own top-of-file comment for the overall file split.
import { escapeHtml } from './app.js';
import {
  formatWeight, allIngredientsInPart, partTotalWeight, DEFAULT_FLOW_NODE_W,
  computeFlowNodeText, FLOW_ARROWHEAD_DEFS, rectOf, clipToRectEdge
} from './recipes-data.js';

// Finds a Part anywhere in the recipe's tree (including nested Sub-parts)
// by name -- a local copy of recipes.js's own findPartByName (not shared
// directly since recipes.js already imports things FROM this file, and
// the reverse would be circular). Used below to look up what's actually
// inside a Process Step's Component when that Component is a whole Part
// added as one lumped entry, same idea as the live editor's own Process
// Steps Components table (see renderComponentRows in recipes.js).
function findPartByNameForProcessView(parts, name){
  for(const part of (parts || [])){
    if((part.name || '').trim() === name) return part;
    const found = findPartByNameForProcessView(part.parts, name);
    if(found) return found;
  }
  return null;
}

// Shared by the print view and the Version Preview modal — a process list
// (title + optional components table + numbered steps) rendered read-only,
// fed from either the live recipe or a frozen version snapshot. `parts` is
// the recipe/snapshot's own ingredient tree, only needed for the Part-
// based Component ingredient breakdown below — optional so any other
// caller that doesn't have it handy can just omit it.
export function readOnlyProcessesHtml(processes, parts){
  const list = (processes || []).filter(p =>
    (p.title||'').trim() !== '' ||
    (p.steps||[]).some(s => (s||'').trim() !== '') ||
    (p.components||[]).length > 0
  );
  if(list.length === 0) return '<div class="compare-missing">No processes yet</div>';
  // Each Process Step (Cutting/Weighing/Mixing 1/...) gets its own bordered
  // white block instead of just flowing straight into the next one -- on
  // the parent .compare-steps-col's own gray background, that's the only
  // thing that actually reads as "here's where one Step ends and the next
  // begins" when there can be many of them stacked in a row.
  // Always rendered, filled in or not -- printed as a blank template a
  // production run can jot real measurements onto by hand, then have
  // someone key in afterward. A rep only shows an actual number once it
  // holds one; blank slots print as "—" so there's still a labeled spot to
  // write each one in on paper.
  const fmtReps = (arr) => (arr || []).map(v => { const n = parseFloat(v); return isFinite(n) ? n.toFixed(2) : null; });
  const avgOf = (nums) => nums.length ? (nums.reduce((s,n)=>s+n,0) / nums.length).toFixed(2) : null;

  return list.map(p => {
    const steps = (p.steps || []).filter(s => (s||'').trim() !== '');
    const components = p.components || [];

    const wtBefore = parseFloat(p.weightBefore);
    const wtAfter = parseFloat(p.weightAfter);
    const actualYieldPct = (isFinite(wtBefore) && wtBefore > 0 && isFinite(wtAfter)) ? (wtAfter / wtBefore * 100).toFixed(2) + '%' : '—';

    const qcRows = ['brix','salt','ph'].map(field => {
      const reps = fmtReps(Array.isArray(p[field]) ? p[field] : [null, null, null]);
      const validReps = reps.filter(v => v != null);
      const label = field === 'brix' ? '°Brix' : field === 'salt' ? '%Salt' : 'pH';
      return `<tr><td>${label}</td><td>${reps.map(v => v != null ? v : '—').join(', ')}</td><td>Avg ${avgOf(validReps.map(Number)) || '—'}</td></tr>`;
    }).join('');

    // Photos sit to the left of the Weight/Yield/QC table (same idea as the
    // live edit page's own photos-then-fields row) instead of their own row
    // above it, so the data reads right where a glance at the photo lands.
    const photosHtml = (p.photos && p.photos.length) ? `
      <div class="trial-photos-row">${p.photos.map((photo, idx) => `
        <div class="trial-photo-thumb"><img src="${escapeHtml(photo)}" alt="Process photo ${idx+1}"></div>
      `).join('')}</div>
    ` : '';

    const actualYieldHtml = `
      <div class="process-view-yield-title">Actual Yield</div>
      <div class="process-view-yield-row">
        ${photosHtml}
        <table class="compare-table process-view-yield-table">
          <tbody>
            <tr><td>Weight Before / After</td><td>${isFinite(wtBefore) ? formatWeight(wtBefore) : '—'} → ${isFinite(wtAfter) ? formatWeight(wtAfter) : '—'}</td><td>Yield ${actualYieldPct}</td></tr>
            ${qcRows}
          </tbody>
        </table>
      </div>
    `;

    return `
      <div class="process-view-step-block">
        <div class="compare-process-title">${escapeHtml(p.title || 'Untitled process')}</div>
        ${components.length ? `
          <table class="compare-table process-view-comp-table" style="margin-bottom:10px;">
            <thead><tr><th>#</th><th>Component</th><th>Weight (g)</th><th>Tolerance</th><th>Range</th><th>%</th></tr></thead>
            <tbody>${components.map((c, cIdx) => {
              const wt = parseFloat(c.weight) || 0;
              const tol = parseFloat(c.tolerance) || 0;
              const mainRow = `<tr><td>${cIdx+1}</td><td>${escapeHtml(c.name||'')}</td><td>${formatWeight(wt)}</td><td>±${tol}</td><td>${(wt-tol).toFixed(2)}-${(wt+tol).toFixed(2)} g</td><td>${(parseFloat(c.percent)||0).toFixed(2)}%</td></tr>`;
              // If this Component is a whole Part (not a single
              // ingredient), show what's actually inside it underneath --
              // same read-only, one-row-per-ingredient breakdown as the
              // live editor's own Components table.
              const matchedPart = findPartByNameForProcessView(parts, (c.name || '').trim());
              const innerIngredients = matchedPart
                ? allIngredientsInPart(matchedPart).filter(i => (i.name||'').trim() !== '')
                : [];
              const subRows = innerIngredients.map(ing => `
                <tr class="comp-sublist-row">
                  <td></td>
                  <td class="comp-sublist-name">${escapeHtml(ing.name)}</td>
                  <td class="comp-sublist-num">${formatWeight(parseFloat(ing.weight) || 0)}</td>
                  <td></td>
                  <td></td>
                  <td class="comp-sublist-num">${(parseFloat(ing.percent) || 0).toFixed(2)}%</td>
                </tr>
              `).join('');
              return mainRow + subRows;
            }).join('')}</tbody>
            <tfoot><tr class="total-row">
              <td></td><td>Total</td>
              <td>${formatWeight(components.reduce((s,c)=>s+(parseFloat(c.weight)||0),0))}</td>
              <td></td><td></td>
              <td>${components.reduce((s,c)=>s+(parseFloat(c.percent)||0),0).toFixed(2)}%</td>
            </tr></tfoot>
          </table>
        ` : ''}
        ${actualYieldHtml}
        ${steps.length ? `<ol>${steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : '<div class="compare-missing">No steps yet</div>'}
      </div>
    `;
  }).join('');
}

// Static, non-interactive mirror of the live Process Flowchart canvas (see
// renderProcessFlowchart) for Printing and Version Preview — reuses the
// exact stored node x/y/w so the read-only view matches what was actually
// designed, just without drag handles/connector dots/delete buttons.
// containerEl-scoped rather than a fixed global id, since Print and
// Version Preview can both hold their own copy in the document at once.
function readOnlyProcessFlowchartHtml(flowchart, processes){
  const nodes = (flowchart && flowchart.nodes) || [];
  if(nodes.length === 0) return '<div class="compare-missing">No flowchart yet</div>';
  const nodesHtml = nodes.map(n => `
    <div class="ro-flow-node" data-node-id="${escapeHtml(n.id)}" style="left:${n.x}px;top:${n.y}px;width:${n.w || DEFAULT_FLOW_NODE_W}px;">
      <div class="flow-node-label">${escapeHtml(n.label || '')}</div>
      <div class="flow-node-text">${escapeHtml(computeFlowNodeText(n, processes))}</div>
    </div>
  `).join('');
  return `
    <div class="flow-canvas-scroll">
      <div class="flow-canvas ro-flow-canvas">
        <svg class="flow-edges-svg"></svg>
        <div class="flow-nodes-layer">${nodesHtml}</div>
      </div>
    </div>
  `;
}

// Measures the just-rendered static nodes (only valid once containerEl is
// actually laid out — see withTemporaryVisibility) and draws the edges +
// sizes the canvas to fit, mirroring redrawFlowEdges/resizeFlowCanvasToFitNodes
// but read-only (no hit-stroke, no click handler, no ghost line).
function finalizeReadOnlyFlowchartEdges(containerEl, flowchart){
  const svg = containerEl.querySelector('.flow-edges-svg');
  const canvas = containerEl.querySelector('.ro-flow-canvas');
  if(!svg || !canvas) return;
  let maxRight = 0, maxBottom = 0;
  canvas.querySelectorAll('.ro-flow-node').forEach(el => {
    maxRight = Math.max(maxRight, el.offsetLeft + el.offsetWidth);
    maxBottom = Math.max(maxBottom, el.offsetTop + el.offsetHeight);
  });
  canvas.style.width = (maxRight + 40) + 'px';
  canvas.style.height = (maxBottom + 40) + 'px';

  let html = FLOW_ARROWHEAD_DEFS;
  ((flowchart && flowchart.edges) || []).forEach(edge => {
    const fromEl = canvas.querySelector(`[data-node-id="${edge.from}"]`);
    const toEl = canvas.querySelector(`[data-node-id="${edge.to}"]`);
    if(!fromEl || !toEl) return;
    const fromRect = rectOf(fromEl), toRect = rectOf(toEl);
    const fromCenter = { x: fromRect.x + fromRect.w/2, y: fromRect.y + fromRect.h/2 };
    const toCenter = { x: toRect.x + toRect.w/2, y: toRect.y + toRect.h/2 };
    const start = clipToRectEdge(fromRect, toCenter);
    const end = clipToRectEdge(toRect, fromCenter);
    html += `<path class="flow-edge-line" d="M${start.x},${start.y} L${end.x},${end.y}" marker-end="url(#flowArrowhead)"></path>`;
  });
  svg.innerHTML = html;
}

export function renderReadOnlyProcessFlowchart(containerEl, flowchart, processes){
  containerEl.innerHTML = readOnlyProcessFlowchartHtml(flowchart, processes);
  if(((flowchart && flowchart.nodes) || []).length > 0){
    finalizeReadOnlyFlowchartEdges(containerEl, flowchart);
  }
}


// ---------- Ingredient Preparation Yield ----------
// Shared by Recipe Overview, the Components/Process ingredient row, the
// Print ingredient table, and Version Preview -- one place for "Prepare
// (gross) weight = Formula (net) weight / (Yield% / 100)" so it's never
// re-derived slightly differently in four places. An invalid/empty/zero/
// negative yield is always silently treated as 100% here (never NaN or
// Infinity) -- the Yield input's own validation state (see
// isValidYieldPct) is what actually surfaces a problem to the user; this
// function's job is just to never crash regardless of what's in the data.
export function computePrepareWeight(formulaWeight, yieldPct){
  const fw = parseFloat(formulaWeight) || 0;
  const y = parseFloat(yieldPct);
  const effectiveYield = (isFinite(y) && y > 0) ? y : 100;
  return fw / (effectiveYield / 100);
}
// Ingredient cost is now based on Prepare (gross) weight, not Formula
// weight -- the Price/kg in the Library is the as-purchased price, so the
// amount actually bought (and paid for) is the gross amount, not the net
// amount that ends up in the batch after trimming/draining loss.
export function computeIngredientCost(prepareWeight, pricePerKg){
  return pricePerKg != null ? (prepareWeight / 1000) * pricePerKg : null;
}
// Only for the Yield input's own error-state styling/message -- never
// gates computePrepareWeight, which always falls back safely regardless.
// Empty/null passes (an empty field just means "not set yet", not invalid).
export function isValidYieldPct(v){
  if(v === '' || v == null) return true;
  const y = parseFloat(v);
  return isFinite(y) && y >= 0.01 && y <= 999.99;
}
// Same recursive shape as partTotalWeight (recipes.js) but summing each
// ingredient's Prepare (gross) weight instead of its Formula weight, then
// dividing by the Part's OWN Yield too -- so a Part/Sub-part can carry its
// own independent prep loss (e.g. the finished sub-assembly itself gets
// strained/reduced) on top of whatever its individual ingredients already
// lose. Compounds naturally through nesting since each level's own division
// happens after summing children that have already had theirs applied.
// Shared by the live editor (recipes.js), Print (recipes.js), and this
// file's own read-only tree -- one place so all three always agree.
export function partPrepareWeight(part){
  const childrenSum = (part.ingredients || []).reduce((s,i) => s + computePrepareWeight(i.weight, i.prepYieldPct), 0)
    + (part.parts || []).reduce((s,sub) => s + partPrepareWeight(sub), 0);
  return computePrepareWeight(childrenSum, part.prepYieldPct);
}

// Shared by the Version Preview modal and Printing — the same Parts ->
// Sub-parts -> Ingredients hierarchy as the live editable form (see
// renderParts/renderPartNode), but as a compact read-only table (name,
// prefixed with box-drawing tree-connector characters, plus %/g as two
// neighboring columns) instead of the on-screen card layout — dense enough
// that a deep recipe still fits on a printed page or in the preview modal,
// while still visually reading as a tree the way the on-screen elbow-line
// artwork does. Recursive so nested Sub-parts show up too, not just each
// top-level Part's direct ingredients.
export function readOnlyIngredientTreeHtml(parts, totalWeight, flowNodes){
  const namedParts = (parts || []).filter(part => allIngredientsInPart(part).some(i => (i.name||'').trim() !== ''));
  if(namedParts.length === 0) return '<div class="overview-empty">No ingredients</div>';
  // The whole Node column is omitted entirely (not just left blank) unless
  // the recipe actually has flowchart nodes, so recipes that never touch
  // that feature get byte-identical print/preview output to before it
  // existed.
  const nodeLabelById = new Map((flowNodes || []).map(n => [n.id, n.label || '?']));
  const showNodeCol = nodeLabelById.size > 0;
  const totalPrepareWeight = namedParts.reduce((s,p)=>s+partPrepareWeight(p), 0);
  const rootRow = `
    <tr class="ro-tree-row ro-tree-root">
      <td class="ro-tree-name">Formula per Portion</td>
      <td class="ro-tree-note"></td>
      <td class="ro-tree-pct">100.00%</td>
      <td class="ro-tree-wt">${fmtNum(totalWeight)}</td>
      <td class="ro-tree-yield"></td>
      <td class="ro-tree-wt">${fmtNum(totalPrepareWeight)}</td>
      <td class="ro-tree-pct">100.00%</td>
      ${showNodeCol ? '<td class="ro-tree-nodecol"></td>' : ''}
    </tr>
  `;
  const bodyRows = namedParts.map((part, idx) =>
    readOnlyPartBranchRows(part, false, totalWeight, totalWeight, [], idx === namedParts.length - 1, nodeLabelById, 1)
  ).join('');
  return `
    <table class="ro-tree-table">
      <thead><tr><th class="ro-tree-name">Component</th><th class="ro-tree-note">Note</th><th class="ro-tree-pct">%</th><th class="ro-tree-wt">Formula (g)</th><th class="ro-tree-yield">Yield</th><th class="ro-tree-wt">Prepare (g)</th><th class="ro-tree-pct">% of Recipe</th>${showNodeCol ? '<th class="ro-tree-nodecol">Node</th>' : ''}</tr></thead>
      <tbody>${rootRow}${bodyRows}</tbody>
    </table>
  `;
}

// Plain number, no unit suffix — the table's own "g" column header carries
// the unit once instead of repeating it on every row (see formatWeight,
// which is used everywhere else that a weight stands alone).
export function fmtNum(n){
  return (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Box-drawing tree connector for one row: one "│  "/"   " segment per
// ancestor level (drawn only when that ancestor still has more siblings
// below it, so the vertical line doesn't dangle past where a branch
// actually ends), then this row's own "├─ " (more siblings follow) or
// "└─ " (last child at this level) elbow.
export function treeGuideHtml(ancestorContinues, isLast){
  const guide = ancestorContinues.map(cont => cont ? '│  ' : '   ').join('') + (isLast ? '└─ ' : '├─ ');
  return `<span class="ro-tree-guide">${guide}</span>`;
}

// One Part's row (name/%/weight) plus, recursively, a row for every named
// ingredient AND every Sub-part nested inside it, all as siblings in the
// same table, ingredients first then Sub-parts (matching the on-screen
// order) so "last child at this level" — and therefore whether this
// branch's own connector lines keep running down past it — is computed
// against that combined, correctly-ordered list. `ancestorContinues` is
// one boolean per ancestor level, carried down and extended by each level
// as it recurses; `isLast` says whether THIS node is the last among its
// own siblings. `parentTotal` is the immediate parent's own total weight
// (the recipe root's total for a top-level Part, or the containing Part's
// total for a nested Sub-part) — % is always computed fresh from the
// actual weights rather than trusting a stored .percent, since older
// versions saved before Sub-parts existed never had one on their Part
// objects.
export function readOnlyPartBranchRows(part, isNested, parentTotal, grandTotal, ancestorContinues, isLast, nodeLabelById, ancestorMultiplier){
  const namedIngredients = (part.ingredients||[]).filter(i => (i.name||'').trim() !== '');
  const namedSubParts = (part.parts||[]).filter(sub => allIngredientsInPart(sub).some(i => (i.name||'').trim() !== ''));
  const label = (part.name||'').trim() || 'Unnamed part';
  const partWeight = partTotalWeight(part);
  const partPct = parentTotal > 0 ? (partWeight / parentTotal * 100) : 0;
  const partPctOfRecipe = grandTotal > 0 ? (partWeight / grandTotal * 100) : 0;
  const showNodeCol = nodeLabelById && nodeLabelById.size > 0;
  // A Part can now carry its own Yield too (on top of any of its
  // ingredients' own) -- shown here, and its Prepare column is this Part's
  // own local rollup (partPrepareWeight), not further multiplied by any
  // ancestor Part's yield -- that further loss shows on the ANCESTOR's own
  // row instead, the same way %-of-Part and %-of-Recipe already coexist as
  // two distinct, both-correct figures for the same row.
  const ownMultiplier = computePrepareWeight(1, part.prepYieldPct);
  const py = parseFloat(part.prepYieldPct);
  const partYieldDisplay = (isFinite(py) && py > 0) ? py : 100;
  const partRow = `
    <tr class="ro-tree-row ro-tree-part">
      <td class="ro-tree-name">${treeGuideHtml(ancestorContinues, isLast)}${escapeHtml(label)}</td>
      <td class="ro-tree-note"></td>
      <td class="ro-tree-pct">${partPct.toFixed(2)}%</td>
      <td class="ro-tree-wt">${fmtNum(partWeight)}</td>
      <td class="ro-tree-yield">${partYieldDisplay.toFixed(2)}%</td>
      <td class="ro-tree-wt">${fmtNum(partPrepareWeight(part))}</td>
      <td class="ro-tree-pct">${partPctOfRecipe.toFixed(2)}%</td>
      ${showNodeCol ? '<td class="ro-tree-nodecol"></td>' : ''}
    </tr>
  `;
  const childAncestorContinues = [...ancestorContinues, !isLast];
  const childCount = namedIngredients.length + namedSubParts.length;
  const childMultiplier = ancestorMultiplier * ownMultiplier;
  const ingRows = namedIngredients.map((ing, idx) => {
    const childIsLast = idx === childCount - 1;
    const nodeLabel = showNodeCol && ing.flowNodeId ? nodeLabelById.get(ing.flowNodeId) : null;
    const formulaWt = parseFloat(ing.weight) || 0;
    const y = parseFloat(ing.prepYieldPct);
    const yieldDisplay = (isFinite(y) && y > 0) ? y : 100;
    const pctOfRecipe = grandTotal > 0 ? (formulaWt / grandTotal * 100) : 0;
    return `
      <tr class="ro-tree-row ro-tree-ing">
        <td class="ro-tree-name">${treeGuideHtml(childAncestorContinues, childIsLast)}${escapeHtml(ing.name)}</td>
        <td class="ro-tree-note">${escapeHtml(ing.note || '')}</td>
        <td class="ro-tree-pct">${(parseFloat(ing.percent)||0).toFixed(2)}%</td>
        <td class="ro-tree-wt">${fmtNum(formulaWt)}</td>
        <td class="ro-tree-yield">${yieldDisplay.toFixed(2)}%</td>
        <td class="ro-tree-wt">${fmtNum(computePrepareWeight(formulaWt, ing.prepYieldPct) * childMultiplier)}</td>
        <td class="ro-tree-pct">${pctOfRecipe.toFixed(2)}%</td>
        ${showNodeCol ? `<td class="ro-tree-nodecol">${nodeLabel ? '→' + escapeHtml(nodeLabel) : ''}</td>` : ''}
      </tr>
    `;
  }).join('');
  const subRows = namedSubParts.map((sub, idx) => {
    const childIsLast = namedIngredients.length + idx === childCount - 1;
    return readOnlyPartBranchRows(sub, true, partWeight, grandTotal, childAncestorContinues, childIsLast, nodeLabelById, childMultiplier);
  }).join('');
  return partRow + ingRows + subRows;
}
