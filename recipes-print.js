// Print view + free-text Description/Concept points and photos. Split out
// of recipes.js (which grew past 5,200 lines) -- see recipes.js's own
// top-of-file comment for the overall file split.
import {
  escapeHtml, icon, computePrepareWeight, partPrepareWeight,
  readOnlyProcessesHtml
} from './app.js';
import {
  allIngredientsInPart, allIngredientsInRecipe, partTotalWeight, formatWeight,
  fullCode, recipeProductTypeCode, findProjectForRecipe, descriptionListHtml
} from './recipes-data.js';
// Circular import back to core recipes.js -- safe, see trials-wizard.js's
// own comment on this same pattern.
import { scheduleSave, linkedProjectInfoHtml } from './recipes.js';

// Same free, keyless machine translation used elsewhere in this app (see
// trials.js's own copy of this same trio) -- recipes.js and projects.js
// don't otherwise depend on each other's internals -- if this ever needs to
// change, the same edit has to be made in both places.
function guessRecipeTranslateTargetLang(text){
  return /[฀-๿]/.test(text) ? 'en' : 'th';
}
async function translateRecipeText(text, targetLang){
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Translation service unavailable');
  const data = await res.json();
  return data[0].map(chunk => chunk[0]).join('');
}
// Puts the translated text first with the original following in
// parentheses, replacing the field's own content -- same behavior as
// wireMuTranslateButton, applied to the Note field and each Description/
// Concept point. Dispatches a real 'input' event after setting the value
// (wireMuTranslateButton's modal reads textarea.value fresh at Save time,
// so it doesn't need to; every field here auto-saves on 'input' instead)
// so the recipe's own already-wired input listener picks up the change and
// schedules a save the normal way, instead of needing a special case.
export function wireRecipeTranslateButton(wrapEl){
  const textarea = wrapEl.querySelector('textarea');
  const btn = wrapEl.querySelector('.mu-translate-btn');
  if(!textarea || !btn) return;
  btn.addEventListener('click', async () => {
    const original = textarea.value.trim();
    if(!original) return;
    btn.classList.add('loading');
    try{
      const translated = await translateRecipeText(original, guessRecipeTranslateTargetLang(original));
      textarea.value = `${translated}\n(${original})`;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }catch(err){
      console.error('Forge: translation failed', err);
      alert('Translation failed — the free translation service may be temporarily unavailable. Please try again in a moment.');
    }finally{
      btn.classList.remove('loading');
    }
  });
}

export function renderDescPoints(r){
  const list = document.getElementById('descPointsList');
  if(!list) return;
  list.innerHTML = '';
  r.description.forEach((point, idx) => {
    const row = document.createElement('div');
    row.className = 'desc-point-row';
    row.innerHTML = `
      <span class="step-badge">${idx+1}</span>
      <div class="desc-point-body">
        <div class="mu-field-with-translate" style="width:auto;">
          <textarea rows="2" placeholder="e.g. Product characteristics, selling point, target audience..."></textarea>
          <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
        </div>
      </div>
      <button class="icon-btn" title="Delete" data-role="delete-desc-point">${icon('x')}</button>
    `;
    const ta = row.querySelector('textarea');
    ta.value = point;
    ta.addEventListener('input', e => { r.description[idx] = e.target.value; scheduleSave(); });
    wireRecipeTranslateButton(row.querySelector('.mu-field-with-translate'));
    row.querySelector('[data-role="delete-desc-point"]').addEventListener('click', () => {
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
export function renderDescPhotos(r){
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

// Print-only redesign of the ingredient breakdown -- Part/Sub-part rows get
// a tinted background and bold group totals, plain padding-based indent
// instead of box-drawing tree connectors, "–" for an empty Prep/Note, and
// the grand total as its own row at the bottom instead of a "Formula per
// Portion" row up top. A separate function from readOnlyIngredientTreeHtml
// (app.js) rather than a rewrite of it, since that one is also reused by
// the Versions comparison view and shouldn't change there.
export function printIngredientTableHtml(parts, totalWeight){
  const namedParts = (parts || []).filter(part => allIngredientsInPart(part).some(i => (i.name||'').trim() !== ''));
  if(namedParts.length === 0) return '<div class="overview-empty">No ingredients</div>';
  const fmtWt = n => (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function rowsForPart(part, depth, ancestorMultiplier){
    const namedIngredients = (part.ingredients||[]).filter(i => (i.name||'').trim() !== '');
    const namedSubParts = (part.parts||[]).filter(sub => allIngredientsInPart(sub).some(i => (i.name||'').trim() !== ''));
    const label = (part.name||'').trim() || 'Unnamed part';
    const partWeight = partTotalWeight(part);
    const partPct = totalWeight > 0 ? (partWeight / totalWeight * 100) : 0;
    // A Part can carry its own Yield now too -- its own row shows that
    // Yield% and its own local partPrepareWeight rollup (not further
    // multiplied by any ancestor Part's Yield -- that shows on the
    // ANCESTOR's own row instead, same as %-of-Part vs %-of-Recipe already
    // being two distinct, both-correct figures for the same row).
    const ownMultiplier = computePrepareWeight(1, part.prepYieldPct);
    const py = parseFloat(part.prepYieldPct);
    const partYieldDisplay = (isFinite(py) && py > 0) ? py : 100;
    const groupRow = `
      <tr class="print-ing-group-row">
        <td style="padding-left:${12 + depth*16}px">${escapeHtml(label)}</td>
        <td class="print-ing-num">${partYieldDisplay.toFixed(2)}%</td>
        <td></td>
        <td class="print-ing-num">${fmtWt(partWeight)}</td>
        <td class="print-ing-num">${fmtWt(partPrepareWeight(part))}</td>
        <td class="print-ing-num">${partPct.toFixed(2)}%</td>
        <td class="print-ing-num">${partPct.toFixed(2)}%</td>
      </tr>
    `;
    const childMultiplier = ancestorMultiplier * ownMultiplier;
    const ingRows = namedIngredients.map(ing => {
      const formulaWt = parseFloat(ing.weight) || 0;
      // Fully compounded -- own Yield AND every ancestor Part's own Yield --
      // since this is the actionable "how much to actually pull" figure the
      // printed sheet exists for. The Yield column itself is left blank on
      // ingredient rows -- same as the live editor, where an ingredient's
      // own Yield (from its Ingredient Library Sub Ingredient) has no
      // visible field of its own any more, only Parts show a Yield.
      const prepareWt = computePrepareWeight(formulaWt, ing.prepYieldPct) * childMultiplier;
      const pctOfRecipe = totalWeight > 0 ? (formulaWt / totalWeight * 100) : 0;
      return `
      <tr class="print-ing-row">
        <td style="padding-left:${12 + (depth+1)*16}px">${escapeHtml(ing.name)}</td>
        <td class="print-ing-num">–</td>
        <td>${escapeHtml(ing.note || '').trim() || '–'}</td>
        <td class="print-ing-num">${fmtWt(formulaWt)}</td>
        <td class="print-ing-num">${fmtWt(prepareWt)}</td>
        <td class="print-ing-num">${(parseFloat(ing.percent)||0).toFixed(2)}%</td>
        <td class="print-ing-num">${pctOfRecipe.toFixed(2)}%</td>
      </tr>
    `;
    }).join('');
    const subRows = namedSubParts.map(sub => rowsForPart(sub, depth+1, childMultiplier)).join('');
    return groupRow + ingRows + subRows;
  }

  // Preparation total -- the same shared partPrepareWeight rollup used by
  // each Part's own group row above, summed across every top-level Part, so
  // it's guaranteed to match what actually prints per row.
  const totalPrepareWeight = namedParts.reduce((s,p) => s + partPrepareWeight(p), 0);

  // "Formula total" is a plain last row of <tbody>, not a <tfoot> --
  // browsers print a <tfoot> at the bottom of EVERY page a table spans
  // across (repeating like a <thead>), which showed up as the total row
  // appearing a page early, mid-table, in addition to its correct spot at
  // the very end once the table actually finished on the next page.
  const bodyRows = namedParts.map(part => rowsForPart(part, 0, 1)).join('')
    + `<tr class="print-ing-total-row"><td>Formula total</td><td class="print-ing-num"></td><td></td><td class="print-ing-num">${fmtWt(totalWeight)} g</td><td class="print-ing-num">${fmtWt(totalPrepareWeight)} g</td><td class="print-ing-num">100.00%</td><td class="print-ing-num">100.00%</td></tr>`;
  return `
    <table class="print-ing-table">
      <thead><tr><th>Ingredient</th><th class="print-ing-num">Yield</th><th>Prep / Note</th><th class="print-ing-num">Formula (g)</th><th class="print-ing-num">Prepare (g)</th><th class="print-ing-num">% of Part</th><th class="print-ing-num">% of Recipe</th></tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
}

export function renderPrintView(r){
  const infoEl = document.getElementById('printInfoCard');
  if(infoEl){
    const totalWt = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
    const link = findProjectForRecipe(r.id);
    const typeCode = recipeProductTypeCode(r);
    const productTypeLabel = r.productType ? `${r.productType}${typeCode ? ` (${typeCode})` : ''}` : '-';
    const photosHtml = (r.descPhotos || []).length ? `
      <div class="ci-row"><b>Photos:</b></div>
      <div class="trial-photos-row">${r.descPhotos.map((photo, idx) => `
        <div class="trial-photo-thumb"><img src="${escapeHtml(photo)}" alt="Description photo ${idx+1}"></div>
      `).join('')}</div>
    ` : '';
    // Same "1. Product Details" facts shown on-screen -- Code/Date/Product
    // Type/Description/Photos plus, if linked, the Project name and its full
    // info panel (Customer/Destination/.../Requirements incl. Product table)
    // via the shared linkedProjectInfoHtml, not just a cherry-picked subset.
    infoEl.innerHTML = `
      <div class="ci-name">${escapeHtml(r.name || 'Untitled recipe')}</div>
      <div class="ci-row"><b>Code:</b> ${escapeHtml(fullCode(r) || '-')}</div>
      <div class="ci-row"><b>Date:</b> ${escapeHtml(r.date || '-')}</div>
      <div class="ci-row"><b>Product Type:</b> ${escapeHtml(productTypeLabel)}</div>
      ${link ? `<div class="ci-row"><b>Project:</b> ${escapeHtml(link.project.name || 'Untitled project')}</div>${linkedProjectInfoHtml(link)}` : ''}
      ${descriptionListHtml(r)}
      ${photosHtml}
      ${(r.note||'').trim() ? `<div class="ci-row"><b>Note:</b></div><div class="material-detail-notes">${escapeHtml(r.note)}</div>` : ''}
      <div class="ci-row"><b>Total weight:</b> ${formatWeight(totalWt)}</div>
    `;
  }

  const treeEl = document.getElementById('printIngredientTree');
  if(treeEl){
    const totalWt = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
    treeEl.innerHTML = printIngredientTableHtml(r.parts, totalWt);
  }

  // Compact companion to the ingredient tree above -- just the Process
  // Steps' titles (plus, per step, which Components go into it) connected
  // top-to-bottom by a vertical line, so the printed recipe and its
  // process flow sit side by side on one page (see
  // .components-process-print-grid). The full step detail (times,
  // temperatures, tolerances) still prints on its own page further down
  // via printProcessesView -- this is a summary, not a replacement.
  // Every node renders the same neutral way (numbered
  // circle) -- there's no "step completed" concept in the data model, so
  // this never fabricates progress/done-state that isn't actually tracked.
  const flowStepsEl = document.getElementById('printProcessStepsFlow');
  if(flowStepsEl){
    const steps = (r.processes || []).filter(p =>
      (p.title||'').trim() !== '' || (p.steps||[]).some(s => (s||'').trim() !== '') || (p.components||[]).length > 0
    );
    flowStepsEl.innerHTML = steps.length ? `
      <div class="simple-process-col-title">Process Flow</div>
      <div class="print-process-flow-stepper">
        ${steps.map((p, idx) => {
          // A component's name is stored as the ingredient's full
          // "English / Thai" library name (or, for a whole Part added as
          // one component, just its plain English label already) -- only
          // the part before the "/" is shown here, so this stays a quick
          // "what goes in" glance instead of repeating the full bilingual
          // ingredient table off to the left.
          const componentNames = (p.components || [])
            .map(c => (c.name || '').split('/')[0].trim())
            .filter(Boolean);
          return `
          <div class="print-process-flow-node">
            <div class="print-process-flow-circle">${idx+1}</div>
            <div class="print-process-flow-text">
              <div class="print-process-flow-label">${escapeHtml(p.title || 'Untitled process')}</div>
              ${componentNames.length ? `<div class="print-process-flow-components">${escapeHtml(componentNames.join(', '))}</div>` : ''}
            </div>
          </div>
        `;
        }).join('')}
      </div>
    ` : '';
  }

  const procEl = document.getElementById('printProcessesView');
  if(procEl) procEl.innerHTML = readOnlyProcessesHtml(r.processes, r.parts);
}
