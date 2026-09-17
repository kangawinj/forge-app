// Recipe Overview table -- the sortable BOM/costing table (ingredient
// name/%/weight/cost) plus the Costing card's Overhead Multiplier/Margins/
// Selling Price block and its show/hide toggle. Split out of recipes.js
// (which grew past 3,400 lines even after its first split) -- see
// recipes.js's own top-of-file comment for the overall file split.
import {
  escapeHtml, icon, ingredientMaster, computePrepareWeight,
  computeIngredientCost, openMaterialDetail
} from './app.js';
import { formatWeight } from './recipes-data.js';

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
export function overviewHeaderRowHtml(){
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

// Replaces renderRecipeEditor's direct overviewSortKey/overviewSortDir
// reassignment -- an importing module can't reassign another module's
// `let` directly, same fix used for openEvalWizard/registerNewRecipe/etc.
// in the earlier splits this session.
export function toggleOverviewSort(key){
  if(overviewSortKey === key){
    overviewSortDir = overviewSortDir === 'asc' ? 'desc' : 'asc';
  }else{
    overviewSortKey = key;
    overviewSortDir = 'asc';
  }
}

// Replaces renderRecipeEditor's direct costingMarginVisible reassignment +
// localStorage write, same reason as toggleOverviewSort above.
export function toggleCostingMarginVisible(){
  costingMarginVisible = !costingMarginVisible;
  try { localStorage.setItem(COSTING_MARGIN_VISIBLE_KEY, String(costingMarginVisible)); } catch(e) {}
  return costingMarginVisible;
}

export function renderOverview(allIngredients, prepareWeightByIng){
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
