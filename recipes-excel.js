/* ---------- Export Excel ----------
   The first worksheet measures the live Preview and exports its text and
   numbers as editable cells via recipe-excel-preview.js. The five detail
   worksheets below remain available for simpler tabular editing.
   Builds a real, editable .xlsx workbook (via the ExcelJS global loaded in
   index.html -- see the <script> tag near the bottom of index.html) that
   mirrors the Print/Preview page section by section -- one sheet each for
   "1. Product Details", "2. Recipe Overview (all parts combined)",
   "3. Costing", "4. Ingredients" (the Part/Sub-part tree from
   "Components and Process"), and "5. Process Steps" -- using the exact
   same numbered titles as the app's own .card-title headings, with real
   cell styling (fonts/fills/borders/indentation) so it reads like the
   on-screen Preview, not a flat data dump. Re-derives everything straight
   from the live recipe object the same way renderPrintView/
   printIngredientTableHtml/renderOverview do, rather than scraping the
   print DOM, so it's correct even if Print/Preview was never opened this
   session. Colors match the app's own --primary/--primary-light/--border
   CSS variables (style.css) so the workbook reads as the same product.
   Split out of recipes.js (which grew past 5,200 lines) -- see recipes.js's
   own top-of-file comment for the overall file split. */
import { addRecipePreviewSheet } from './recipe-excel-preview.js';
import { finishRecipeWorksheets } from './excel-layout.js';
import { computeIngredientCost, computePrepareWeight, partPrepareWeight, ingredientMaster } from './app.js';
import {
  fullCode, recipeProductTypeCode, findProjectForRecipe, allIngredientsInRecipe,
  allIngredientsInPart, partTotalWeight, formatWeight, collectIngredientsWithPrepareWeight,
  findPartByName
} from './recipes-data.js';
import { renderPrintView } from './recipes-print.js';
// Circular import back to core recipes.js -- safe, see trials-wizard.js's
// own comment on this same pattern. costingMarginVisible is only ever read
// here, never written.
import { costingMarginVisible } from './recipes.js';

function xlArgb(hex){
  return 'FF' + hex.replace('#','').toUpperCase();
}
const XL_COLORS = {
  headerFill: xlArgb('#16294a'),
  headerText: xlArgb('#ffffff'),
  groupFill: xlArgb('#e8ecf5'),
  groupText: xlArgb('#0c1830'),
  border: xlArgb('#dfe3ea'),
  dim: xlArgb('#6b7280'),
  text: xlArgb('#1c2333')
};
function xlThinBorder(){
  return { style: 'thin', color: { argb: XL_COLORS.border } };
}

// A dark banner across row 1, reading the exact same "N. Section Name" text
// as the matching on-screen .card-title -- every sheet gets one, so paging
// through the workbook reads like paging through the Preview page's own
// numbered cards instead of a set of generically-named tabs.
function addSectionTitleBar(ws, title, colSpan){
  ws.mergeCells(1, 1, 1, colSpan);
  const cell = ws.getCell(1, 1);
  cell.value = title;
  cell.font = { bold: true, size: 13, color: { argb: XL_COLORS.headerText } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.headerFill } };
  cell.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 26;
}

// Same grouping/costing math as renderOverview (the live "2. Recipe
// Overview" table) -- grouped by name+Prep across every Part, each group's
// Prepare weight summed per-instance via collectIngredientsWithPrepareWeight
// so multi-Part compounding matches exactly. Pulled out as a pure function
// (no DOM reads) so both the Overview and Costing sheets can share one
// computation instead of each re-deriving it their own way.
function computeRecipeOverviewData(r){
  const allIngredients = allIngredientsInRecipe(r);
  const prepareWeightByIng = new Map();
  (r.parts || []).forEach(part => collectIngredientsWithPrepareWeight(part).forEach(({ ing, prepareWt }) => prepareWeightByIng.set(ing, prepareWt)));

  const named = allIngredients.filter(i => (i.name||'').trim() !== '');
  const groups = new Map();
  named.forEach(i => {
    const key = i.name.trim().toLowerCase() + '|' + (i.note || '').trim().toLowerCase();
    if(!groups.has(key)){
      const material = i.materialId ? ingredientMaster.find(m => m.id === i.materialId) : null;
      const pricePerKg = material && material.price !== '' && material.price != null ? parseFloat(material.price) : null;
      groups.set(key, {
        name: i.name.trim(), note: i.note || '', pct: 0, wt: 0, prepareWt: 0,
        prepYieldPct: i.prepYieldPct,
        vendorName: material ? material.vendorName : '',
        manufacturer: material ? material.manufacturer : '',
        brand: material ? material.brand : '',
        pricePerKg
      });
    }
    const g = groups.get(key);
    g.wt += parseFloat(i.weight) || 0;
    g.prepareWt += (prepareWeightByIng.get(i) ?? computePrepareWeight(i.weight, i.prepYieldPct));
  });

  const totalRecipeWeight = allIngredients.reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
  let totalCost = 0, allPriced = true, anyPriced = false;
  const rows = [...groups.values()];
  rows.forEach(g => {
    g.pct = totalRecipeWeight > 0 ? (g.wt / totalRecipeWeight * 100) : 0;
    g.cost = computeIngredientCost(g.prepareWt, g.pricePerKg);
    if(g.cost != null){ totalCost += g.cost; anyPriced = true; } else { allPriced = false; }
  });

  const prepareTotal = rows.reduce((s,g)=>s+g.prepareWt,0);
  const hasCost = totalRecipeWeight > 0 && anyPriced;
  return { rows, totalRecipeWeight, prepareTotal, totalCost: hasCost ? totalCost : null, costSuffix: allPriced ? '' : '*', hasCost };
}

// Same currency-conversion / Overhead / three-tier-margin cascade as
// renderOverview's own Costing block, just reading the persisted r.* fields
// (r.pricingCurrency/exchangeRate/servingSizeG/overheadMultiplier/
// factoryMarginMin.../etc, all saved by the live "3. Costing" card's own
// inputs -- see their wiring further up this file) instead of live <input>
// DOM values, so this can run standalone at export time.
function computeCostingData(r, ov){
  const pricingCurrency = r.pricingCurrency || 'THB';
  const exchangeRateVal = parseFloat(r.exchangeRate);
  const rateAvailable = pricingCurrency === 'THB' || (isFinite(exchangeRateVal) && exchangeRateVal > 0);
  const money = (v, roundUp005) => {
    if(v == null || !rateAvailable) return null;
    let converted = pricingCurrency === 'THB' ? v : (v / exchangeRateVal);
    if(roundUp005) converted = Math.ceil(converted / 0.05) * 0.05;
    return pricingCurrency === 'THB' ? `฿${converted.toFixed(2)}` : `${converted.toFixed(2)} ${pricingCurrency}`;
  };
  const costSuffix = ov.costSuffix;
  const costPer100 = ov.hasCost ? (ov.totalCost / ov.totalRecipeWeight) * 100 : null;
  const costPerKg = ov.hasCost ? (ov.totalCost / ov.totalRecipeWeight) * 1000 : null;
  const servingSize = parseFloat(r.servingSizeG) || 0;
  const costPerServing = (servingSize > 0 && costPer100 != null) ? (costPer100 / 100 * servingSize) : null;

  const pct = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  const marginPrice = (base, marginPct) => (base != null && marginPct != null) ? base * (1 + marginPct / 100) : null;
  const priceRangeStr = (min, max) => {
    if(min == null || max == null) return '—';
    const minStr = money(min, true), maxStr = money(max, true);
    if(minStr == null || maxStr == null) return '—';
    return `${minStr} – ${maxStr}${costSuffix}`;
  };

  const overheadMultiplier = pct(r.overheadMultiplier);
  const overheadBase = costPerServing != null ? costPerServing * (overheadMultiplier ?? 1) : null;
  const factoryMarginMin = pct(r.factoryMarginMin), factoryMarginMax = pct(r.factoryMarginMax);
  const factoryPriceMin = marginPrice(overheadBase, factoryMarginMin);
  const factoryPriceMax = marginPrice(overheadBase, factoryMarginMax);
  const companyMarginMin = pct(r.companyMarginMin), companyMarginMax = pct(r.companyMarginMax);
  const companyPriceMin = marginPrice(factoryPriceMin, companyMarginMin);
  const companyPriceMax = marginPrice(factoryPriceMax, companyMarginMax);
  const customerMarginMin = pct(r.customerMarginMin), customerMarginMax = pct(r.customerMarginMax);
  const customerPriceMin = marginPrice(companyPriceMin, customerMarginMin);
  const customerPriceMax = marginPrice(companyPriceMax, customerMarginMax);

  return {
    pricingCurrency, exchangeRateVal: rateAvailable ? exchangeRateVal : null, exchangeRateDate: r.exchangeRateDate || '',
    servingSize,
    costPerServing: money(costPerServing), costPer100: money(costPer100), costPerKg: money(costPerKg), costSuffix,
    overheadMultiplier,
    factoryMarginMin, factoryMarginMax, factoryPriceRange: priceRangeStr(factoryPriceMin, factoryPriceMax),
    companyMarginMin, companyMarginMax, companyPriceRange: priceRangeStr(companyPriceMin, companyPriceMax),
    customerMarginMin, customerMarginMax, customerPriceRange: priceRangeStr(customerPriceMin, customerPriceMax)
  };
}

function buildProductDetailsSheet(wb, r){
  const ws = wb.addWorksheet('1. Product Details');
  ws.columns = [{ width: 22 }, { width: 70 }];
  addSectionTitleBar(ws, '1. Product Details', 2);
  let row = 2;

  const titleCell = ws.getCell(row, 1);
  ws.mergeCells(row, 1, row, 2);
  titleCell.value = r.name || 'Untitled recipe';
  titleCell.font = { bold: true, size: 16, color: { argb: XL_COLORS.text } };
  row += 2;

  function kv(label, value){
    ws.getCell(row, 1).value = label;
    ws.getCell(row, 1).font = { bold: true, color: { argb: XL_COLORS.text } };
    ws.getCell(row, 2).value = (value || '').toString().trim() || '-';
    ws.getCell(row, 2).alignment = { wrapText: true, vertical: 'top' };
    row++;
  }

  const typeCode = recipeProductTypeCode(r);
  kv('Code', fullCode(r));
  kv('Date', r.date);
  kv('Product Type', r.productType ? `${r.productType}${typeCode ? ` (${typeCode})` : ''}` : '');

  const link = findProjectForRecipe(r.id);
  if(link){
    const { project, product } = link;
    row++;
    const sectionCell = ws.getCell(row, 1);
    sectionCell.value = 'Linked Project';
    sectionCell.font = { bold: true, size: 12, color: { argb: XL_COLORS.groupText } };
    row++;
    kv('Project', project.name || 'Untitled project');
    kv('Customer', project.customerName);
    kv('Destination', project.destinationCountry);
    kv('Project Owner', project.ownerSalesRep);
    kv('Factory Sales Rep', project.factorySalesRep);
    kv('PD', project.responsiblePerson);
    kv('Factory', project.factoryName);
    kv('Stage', product.stage);
  }

  row++;
  ws.getCell(row, 1).value = 'Description';
  ws.getCell(row, 1).font = { bold: true, color: { argb: XL_COLORS.text } };
  row++;
  const points = (r.description || []).filter(p => (p||'').trim() !== '');
  if(points.length){
    points.forEach(p => {
      ws.getCell(row, 2).value = `• ${p}`;
      ws.getCell(row, 2).alignment = { wrapText: true };
      row++;
    });
  } else {
    ws.getCell(row, 2).value = '-';
    row++;
  }

  if((r.descPhotos || []).length){
    kv('Photos', `${r.descPhotos.length} photo(s) attached — view in app`);
  }

  if((r.note||'').trim()){
    row++;
    ws.getCell(row, 1).value = 'Note';
    ws.getCell(row, 1).font = { bold: true, color: { argb: XL_COLORS.text } };
    ws.getCell(row, 2).value = r.note;
    ws.getCell(row, 2).alignment = { wrapText: true, vertical: 'top' };
    row++;
  }

  row++;
  const totalWt = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
  kv('Total weight', formatWeight(totalWt));
}

// "2. Recipe Overview (all parts combined)" -- ingredients grouped by
// name+Prep across every Part (not the Part tree itself, which is its own
// separate sheet below) -- same table/columns/sort (heaviest first) as the
// live on-screen card.
function buildRecipeOverviewSheet(wb, r){
  const ws = wb.addWorksheet('2. Recipe Overview');
  ws.columns = [
    { width: 6 }, { width: 40 }, { width: 30 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 14 }
  ];
  addSectionTitleBar(ws, '2. Recipe Overview (all parts combined)', 7);

  const headerRow = ws.addRow(['#', 'Ingredient / Prep', 'Brand / Vendor / Manufacturer', '% of Recipe', 'Formula Wt. (g)', 'Prepare Wt. (g)', 'Cost (฿)']);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: XL_COLORS.headerText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.headerFill } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  headerRow.height = 26;

  const ov = computeRecipeOverviewData(r);
  const sorted = [...ov.rows].sort((a,b) => b.wt - a.wt);

  if(sorted.length === 0){
    ws.addRow(['', 'No ingredient names entered yet']);
  } else {
    sorted.forEach((g, idx) => {
      const subLabel = [g.brand, g.vendorName, g.manufacturer].filter(Boolean).join(' · ');
      const row = ws.addRow([
        idx+1,
        g.note ? `${g.name} (${g.note})` : g.name,
        subLabel,
        g.pct, g.wt, g.prepareWt,
        g.cost != null ? g.cost : null
      ]);
      row.eachCell((cell, colNumber) => {
        cell.border = { bottom: xlThinBorder() };
        if(colNumber >= 4) cell.alignment = { horizontal: 'right' };
      });
      row.getCell(2).font = { color: { argb: XL_COLORS.text } };
      row.getCell(3).font = { size: 10, color: { argb: XL_COLORS.dim } };
      row.getCell(4).numFmt = '0.00"%"';
      row.getCell(5).numFmt = '#,##0.00';
      row.getCell(6).numFmt = '#,##0.00';
      if(g.cost != null) row.getCell(7).numFmt = '#,##0.00';
    });

    const totalRow = ws.addRow(['', 'Formula Total', '', 100, ov.totalRecipeWeight, ov.prepareTotal, ov.totalCost != null ? ov.totalCost : null]);
    totalRow.eachCell((cell, colNumber) => {
      cell.font = { bold: true, color: { argb: XL_COLORS.text } };
      cell.border = { top: { style: 'medium', color: { argb: XL_COLORS.text } } };
      if(colNumber >= 4) cell.alignment = { horizontal: 'right' };
    });
    totalRow.getCell(4).numFmt = '0.00"%"';
    totalRow.getCell(5).numFmt = '#,##0.00';
    totalRow.getCell(6).numFmt = '#,##0.00';
    if(ov.totalCost != null) totalRow.getCell(7).numFmt = '#,##0.00';

    if(ov.costSuffix){
      const noteRow = ws.addRow(['', '* Some ingredients have no Price/kg on file in the Ingredient Library — this total doesn\'t include their cost.']);
      noteRow.getCell(2).font = { italic: true, size: 9, color: { argb: XL_COLORS.dim } };
    }
  }

  ws.views = [{ state: 'frozen', ySplit: 2 }];
}

// "3. Costing" -- Currency/Exchange Rate/Serving Size, Cost/100g/Cost/kg/
// Cost per Serving, then the Overhead Multiplier + three-tier Factory/
// Company/Customer Margin cascade, same figures as the live card.
function buildCostingSheet(wb, r){
  const ws = wb.addWorksheet('3. Costing');
  ws.columns = [{ width: 34 }, { width: 40 }];
  addSectionTitleBar(ws, '3. Costing', 2);
  let row = 3;

  function kv(label, value){
    ws.getCell(row, 1).value = label;
    ws.getCell(row, 1).font = { bold: true, color: { argb: XL_COLORS.text } };
    ws.getCell(row, 2).value = (value === null || value === undefined || value === '') ? '—' : value;
    row++;
  }

  const ov = computeRecipeOverviewData(r);
  const c = computeCostingData(r, ov);

  kv('Currency', c.pricingCurrency);
  if(c.pricingCurrency !== 'THB'){
    kv('Exchange Rate (1 = ? THB)', c.exchangeRateVal);
    kv('Rate Date', c.exchangeRateDate);
  }
  kv('Amount per Serving (g)', c.servingSize || '');
  if(c.servingSize) kv('Cost RM / Serving', c.costPerServing ? `${c.costPerServing}${c.costSuffix}` : '—');
  kv('Cost RM / 100 g', c.costPer100 ? `${c.costPer100}${c.costSuffix}` : '—');
  kv('Cost RM / kg', c.costPerKg ? `${c.costPerKg}${c.costSuffix}` : '—');

  // Overhead Multiplier / Margins / Selling Price (and the explanatory note
  // below them) mirror the live Costing card's own eye toggle
  // (btnToggleCostingMargin / costingMarginVisible, a per-browser
  // localStorage preference -- see its wiring further up this file) --
  // whichever state it's currently in when Export Excel is clicked is what
  // ships in the workbook, same as what Print/Preview would show right now.
  if(costingMarginVisible){
    row++;
    const sectionCell = ws.getCell(row, 1);
    sectionCell.value = 'Overhead & Margins';
    sectionCell.font = { bold: true, size: 12, color: { argb: XL_COLORS.groupText } };
    row++;
    kv('Overhead Multiplier', c.overheadMultiplier != null ? `×${c.overheadMultiplier}` : '(none, ×1)');
    kv('Factory Margin (Min–Max % Markup on Cost)', (c.factoryMarginMin!=null && c.factoryMarginMax!=null) ? `${c.factoryMarginMin}–${c.factoryMarginMax}%` : '');
    kv('Factory Selling Price / Serving', c.factoryPriceRange);
    kv('Company Margin (Min–Max % Markup on Factory Price)', (c.companyMarginMin!=null && c.companyMarginMax!=null) ? `${c.companyMarginMin}–${c.companyMarginMax}%` : '');
    kv('Company Selling Price / Serving', c.companyPriceRange);
    kv('Customer Margin (Min–Max % Markup on Company Price)', (c.customerMarginMin!=null && c.customerMarginMax!=null) ? `${c.customerMarginMin}–${c.customerMarginMax}%` : '');
    kv('Customer Selling Price / Serving', c.customerPriceRange);

    row++;
    ws.mergeCells(row, 1, row, 2);
    const noteCell = ws.getCell(row, 1);
    noteCell.value = 'Costs are calculated from weight × the ingredient\'s Price/kg in the library (always stored in Thai Baht). Selling Price figures round up to the nearest 0.05 of the selected currency.';
    noteCell.font = { italic: true, size: 9, color: { argb: XL_COLORS.dim } };
    noteCell.alignment = { wrapText: true };
  }
}

function buildIngredientsSheet(wb, r){
  const ws = wb.addWorksheet('4. Ingredients');
  ws.columns = [
    { width: 40 }, { width: 10 }, { width: 26 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 14 }
  ];
  addSectionTitleBar(ws, '4. Ingredients (Parts & Sub-parts)', 7);

  const headerRow = ws.addRow(['Ingredient', 'Yield', 'Prep / Note', 'Formula (g)', 'Prepare (g)', '% of Part', '% of Recipe']);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: XL_COLORS.headerText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.headerFill } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  headerRow.height = 28;

  const totalWeight = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
  const namedParts = (r.parts || []).filter(part => allIngredientsInPart(part).some(i => (i.name||'').trim() !== ''));

  function addPartRows(part, depth, ancestorMultiplier){
    const namedIngredients = (part.ingredients||[]).filter(i => (i.name||'').trim() !== '');
    const namedSubParts = (part.parts||[]).filter(sub => allIngredientsInPart(sub).some(i => (i.name||'').trim() !== ''));
    const label = (part.name||'').trim() || 'Unnamed part';
    const partWeight = partTotalWeight(part);
    const partPct = totalWeight > 0 ? (partWeight / totalWeight * 100) : 0;
    const ownMultiplier = computePrepareWeight(1, part.prepYieldPct);
    const py = parseFloat(part.prepYieldPct);
    const partYieldDisplay = (isFinite(py) && py > 0) ? py : 100;

    const groupRow = ws.addRow([label, partYieldDisplay, '', partWeight, partPrepareWeight(part), partPct, partPct]);
    groupRow.eachCell((cell, colNumber) => {
      cell.font = { bold: true, color: { argb: XL_COLORS.groupText } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.groupFill } };
      cell.border = { bottom: xlThinBorder() };
      cell.alignment = colNumber === 1 ? { indent: depth, vertical: 'middle' } : { horizontal: 'right', vertical: 'middle' };
    });
    groupRow.getCell(2).numFmt = '0.00"%"';
    groupRow.getCell(4).numFmt = '#,##0.00';
    groupRow.getCell(5).numFmt = '#,##0.00';
    groupRow.getCell(6).numFmt = '0.00"%"';
    groupRow.getCell(7).numFmt = '0.00"%"';

    const childMultiplier = ancestorMultiplier * ownMultiplier;
    namedIngredients.forEach(ing => {
      const formulaWt = parseFloat(ing.weight) || 0;
      const prepareWt = computePrepareWeight(formulaWt, ing.prepYieldPct) * childMultiplier;
      const pctOfRecipe = totalWeight > 0 ? (formulaWt / totalWeight * 100) : 0;
      const ingRow = ws.addRow([
        ing.name, null, (ing.note||'').trim(), formulaWt, prepareWt, parseFloat(ing.percent)||0, pctOfRecipe
      ]);
      ingRow.eachCell((cell, colNumber) => {
        cell.border = { bottom: xlThinBorder() };
        cell.font = { color: { argb: XL_COLORS.text } };
        if(colNumber === 1) cell.alignment = { indent: depth+1, vertical: 'middle' };
        else if(colNumber !== 3) cell.alignment = { horizontal: 'right', vertical: 'middle' };
      });
      ingRow.getCell(4).numFmt = '#,##0.00';
      ingRow.getCell(5).numFmt = '#,##0.00';
      ingRow.getCell(6).numFmt = '0.00"%"';
      ingRow.getCell(7).numFmt = '0.00"%"';
    });

    namedSubParts.forEach(sub => addPartRows(sub, depth+1, childMultiplier));
  }

  if(namedParts.length === 0){
    ws.addRow(['No ingredients']);
  } else {
    namedParts.forEach(part => addPartRows(part, 0, 1));
    const totalPrepareWeight = namedParts.reduce((s,p) => s + partPrepareWeight(p), 0);
    const totalRow = ws.addRow(['Formula total', '', '', totalWeight, totalPrepareWeight, 100, 100]);
    totalRow.eachCell((cell, colNumber) => {
      cell.font = { bold: true, color: { argb: XL_COLORS.text } };
      cell.border = { top: { style: 'medium', color: { argb: XL_COLORS.text } } };
      if(colNumber > 1) cell.alignment = { horizontal: 'right' };
    });
    totalRow.getCell(4).numFmt = '#,##0.00';
    totalRow.getCell(5).numFmt = '#,##0.00';
    totalRow.getCell(6).numFmt = '0.00"%"';
    totalRow.getCell(7).numFmt = '0.00"%"';
  }

  ws.views = [{ state: 'frozen', ySplit: 2 }];
}

function buildProcessSheet(wb, r){
  const ws = wb.addWorksheet('5. Process Steps');
  ws.columns = [{ width: 6 }, { width: 34 }, { width: 16 }, { width: 12 }, { width: 18 }, { width: 12 }];
  addSectionTitleBar(ws, '5. Process Steps', 6);

  const list = (r.processes || []).filter(p =>
    (p.title||'').trim() !== '' || (p.steps||[]).some(s => (s||'').trim() !== '') || (p.components||[]).length > 0
  );
  if(list.length === 0){
    ws.getCell(2, 1).value = 'No processes yet';
    return;
  }

  const fmtReps = (arr) => (arr || []).map(v => { const n = parseFloat(v); return isFinite(n) ? n.toFixed(2) : null; });
  const avgOf = (nums) => nums.length ? (nums.reduce((s,n)=>s+n,0) / nums.length).toFixed(2) : null;

  let row = 2;
  function setRow(values, style){
    const r2 = ws.getRow(row);
    r2.values = values;
    if(style) style(r2);
    row++;
    return r2;
  }

  list.forEach(p => {
    ws.mergeCells(row, 1, row, 6);
    setRow([p.title || 'Untitled process'], r2 => {
      r2.height = 22;
      const cell = r2.getCell(1);
      cell.font = { bold: true, size: 13, color: { argb: XL_COLORS.groupText } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.groupFill } };
      cell.alignment = { vertical: 'middle', indent: 1 };
    });

    const components = p.components || [];
    if(components.length){
      setRow(['#','Component','Weight (g)','Tolerance','Range','%'], r2 => {
        r2.eachCell(cell => {
          cell.font = { bold: true, color: { argb: XL_COLORS.dim } };
          cell.border = { bottom: xlThinBorder() };
        });
      });
      components.forEach((c, cIdx) => {
        const wt = parseFloat(c.weight) || 0;
        const tol = parseFloat(c.tolerance) || 0;
        setRow([cIdx+1, c.name||'', wt, tol ? `±${tol}` : '', `${(wt-tol).toFixed(2)}-${(wt+tol).toFixed(2)} g`, parseFloat(c.percent)||0], r2 => {
          r2.getCell(3).numFmt = '#,##0.00';
          r2.getCell(6).numFmt = '0.00"%"';
        });

        const matchedPart = findPartByName(r.parts, (c.name || '').trim());
        const innerIngredients = matchedPart ? allIngredientsInPart(matchedPart).filter(i => (i.name||'').trim() !== '') : [];
        innerIngredients.forEach(ing => {
          setRow(['', ing.name, parseFloat(ing.weight)||0, '', '', parseFloat(ing.percent)||0], r2 => {
            const nameCell = r2.getCell(2);
            nameCell.font = { italic: true, color: { argb: XL_COLORS.dim } };
            nameCell.alignment = { indent: 1 };
            r2.getCell(3).numFmt = '#,##0.00';
            r2.getCell(6).numFmt = '0.00"%"';
          });
        });
      });
      setRow(['', 'Total', components.reduce((s,c)=>s+(parseFloat(c.weight)||0),0), '', '', components.reduce((s,c)=>s+(parseFloat(c.percent)||0),0)], r2 => {
        r2.eachCell(cell => { cell.font = { bold: true }; cell.border = { top: xlThinBorder() }; });
        r2.getCell(3).numFmt = '#,##0.00';
        r2.getCell(6).numFmt = '0.00"%"';
      });
    }

    const wtBefore = parseFloat(p.weightBefore);
    const wtAfter = parseFloat(p.weightAfter);
    const actualYieldPct = (isFinite(wtBefore) && wtBefore > 0 && isFinite(wtAfter)) ? (wtAfter / wtBefore * 100).toFixed(2) + '%' : '—';
    setRow(['Actual Yield'], r2 => { r2.getCell(1).font = { bold: true, color: { argb: XL_COLORS.dim } }; });
    setRow(['', 'Weight Before / After', `${isFinite(wtBefore) ? formatWeight(wtBefore) : '—'} → ${isFinite(wtAfter) ? formatWeight(wtAfter) : '—'}`, `Yield ${actualYieldPct}`]);
    ['brix','salt','ph'].forEach(field => {
      const reps = fmtReps(Array.isArray(p[field]) ? p[field] : [null, null, null]);
      const validReps = reps.filter(v => v != null);
      const label = field === 'brix' ? '°Brix' : field === 'salt' ? '%Salt' : 'pH';
      setRow(['', label, reps.map(v => v != null ? v : '—').join(', '), `Avg ${avgOf(validReps.map(Number)) || '—'}`]);
    });

    setRow(['Steps'], r2 => { r2.getCell(1).font = { bold: true, color: { argb: XL_COLORS.dim } }; });
    const steps = (p.steps || []).filter(s => (s||'').trim() !== '');
    if(steps.length){
      steps.forEach((s, idx) => {
        ws.mergeCells(row, 3, row, 6);
        setRow(['', `${idx+1}.`, s]);
      });
    } else {
      setRow(['', 'No steps yet']);
    }

    row++; // blank separator row between processes
  });
}

export async function exportRecipeToExcel(r){
  if(!window.ExcelJS){
    alert('Excel export isn\'t available right now (ExcelJS failed to load) -- check your connection and try again.');
    return;
  }
  r = structuredClone(r);
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Forge';
  wb.created = new Date();

  renderPrintView(r);
  await addRecipePreviewSheet(wb, document.getElementById('recipeCards'));
  buildProductDetailsSheet(wb, r);
  buildRecipeOverviewSheet(wb, r);
  buildCostingSheet(wb, r);
  buildIngredientsSheet(wb, r);
  buildProcessSheet(wb, r);
  finishRecipeWorksheets(wb);

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const code = fullCode(r);
  const namePart = [r.name || 'Untitled recipe', code].filter(Boolean).join(' ');
  a.download = `Recipe ${namePart}`.replace(/[\\/:*?"<>|]/g, '-') + '.xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
