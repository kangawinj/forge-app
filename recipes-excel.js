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
  findPartByName, overheadPctFromMultiplier, factoryPriceFromShares
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
export function computeRecipeOverviewData(r){
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
  const moneyNum = (v, roundUp005) => {
    if(v == null || !rateAvailable) return null;
    let converted = pricingCurrency === 'THB' ? v : (v / exchangeRateVal);
    if(roundUp005) converted = Math.ceil(converted / 0.05) * 0.05;
    return converted;
  };
  const money = (v, roundUp005) => {
    const converted = moneyNum(v, roundUp005);
    if(converted == null) return null;
    return pricingCurrency === 'THB' ? `฿${converted.toFixed(2)}` : `${converted.toFixed(2)} ${pricingCurrency}`;
  };
  const costSuffix = ov.costSuffix;
  const costPer100 = ov.hasCost ? (ov.totalCost / ov.totalRecipeWeight) * 100 : null;
  const costPerKg = ov.hasCost ? (ov.totalCost / ov.totalRecipeWeight) * 1000 : null;
  const servingSize = parseFloat(r.servingSizeG) || 0;
  const costPerServing = (servingSize > 0 && costPer100 != null) ? (costPer100 / 100 * servingSize) : null;

  const pct = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  const priceStr = v => {
    if(v == null) return '—';
    const str = money(v, true);
    return str == null ? '—' : `${str}${costSuffix}`;
  };

  // Every tier = base + Overhead + Profit shares of 100% (see factoryPriceFromShares).
  const overheadPct = pct(overheadPctFromMultiplier(r.overheadMultiplier));
  const factoryMargin = pct(r.factoryMarginMin) ?? 0; // blank counts as 0%
  const factoryPrice = factoryPriceFromShares(costPerServing, overheadPct, factoryMargin);
  const companyMargin = pct(r.companyMarginMin), companyOverhead = pct(r.companyOverheadMin);
  const companyPrice = factoryPriceFromShares(factoryPrice, companyOverhead, companyMargin);
  const customerMargin = pct(r.customerMarginMin), customerOverhead = pct(r.customerOverheadMin);
  const customerPrice = factoryPriceFromShares(companyPrice, customerOverhead, customerMargin);

  return {
    pricingCurrency, exchangeRateVal: (rateAvailable && isFinite(exchangeRateVal) && exchangeRateVal > 0) ? exchangeRateVal : null, exchangeRateDate: r.exchangeRateDate || '',
    servingSize,
    costPerServing: money(costPerServing), costPer100: money(costPer100), costPerKg: money(costPerKg), costSuffix,
    costPerServingNum: moneyNum(costPerServing), costPer100Num: moneyNum(costPer100), costPerKgNum: moneyNum(costPerKg),
    factoryPriceNum: moneyNum(factoryPrice, true), companyPriceNum: moneyNum(companyPrice, true), customerPriceNum: moneyNum(customerPrice, true),
    overheadPct,
    factoryMargin, factoryPriceText: priceStr(factoryPrice),
    companyOverhead, companyMargin, companyPriceText: priceStr(companyPrice),
    customerOverhead, customerMargin, customerPriceText: priceStr(customerPrice)
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

// Cells the user may type over (everything else is a live formula that
// recalculates when they do) get a pale yellow fill.
const XL_INPUT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: xlArgb('#fff6d6') } };
function markInput(cell){ cell.fill = XL_INPUT_FILL; }
function addInputLegend(ws, colSpan){
  const rn = ws.lastRow ? ws.lastRow.number + 2 : 3;
  ws.mergeCells(rn, 1, rn, colSpan);
  const cell = ws.getCell(rn, 1);
  cell.value = 'Yellow cells are inputs — change them and every other figure on this sheet recalculates.';
  cell.font = { italic: true, size: 9, color: { argb: XL_COLORS.dim } };
}
// Excel's way of writing computePrepareWeight's yield fallback (blank / 0 = 100%).
const xlYield = ref => `IF(${ref}>0,${ref}/100,1)`;

// "2. Recipe Overview (all parts combined)" -- ingredients grouped by
// name+Prep across every Part (not the Part tree itself, which is its own
// separate sheet below) -- same table/columns/sort (heaviest first) as the
// live on-screen card. % of Recipe, Cost and the totals are live formulas
// (Formula/Prepare Wt. and Price / kg are the inputs). Returns the cell
// references the Costing sheet links to (null when there are no rows).
function buildRecipeOverviewSheet(wb, r){
  const SHEET = '2. Recipe Overview';
  const ws = wb.addWorksheet(SHEET);
  ws.columns = [
    { width: 6 }, { width: 40 }, { width: 30 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }
  ];
  addSectionTitleBar(ws, '2. Recipe Overview (all parts combined)', 8);

  const headerRow = ws.addRow(['#', 'Ingredient / Prep', 'Brand / Vendor / Manufacturer', '% of Recipe', 'Formula Wt. (g)', 'Prepare Wt. (g)', 'Cost (฿)', 'Price / kg (฿)']);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: XL_COLORS.headerText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.headerFill } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  headerRow.height = 26;

  const ov = computeRecipeOverviewData(r);
  const sorted = [...ov.rows].sort((a,b) => b.wt - a.wt);
  let refs = null;

  if(sorted.length === 0){
    ws.addRow(['', 'No ingredient names entered yet']);
  } else {
    const firstRow = headerRow.number + 1;
    const lastRow = firstRow + sorted.length - 1;
    const totalRowNum = lastRow + 1;
    const totWt = `$E$${totalRowNum}`;
    sorted.forEach((g, idx) => {
      const rn = firstRow + idx;
      const subLabel = [g.brand, g.vendorName, g.manufacturer].filter(Boolean).join(' · ');
      const row = ws.addRow([
        idx+1,
        g.note ? `${g.name} (${g.note})` : g.name,
        subLabel,
        { formula: `IF(${totWt}=0,0,E${rn}/${totWt}*100)`, result: g.pct },
        g.wt, g.prepareWt,
        { formula: `IF(ISNUMBER(H${rn}),F${rn}/1000*H${rn},"")`, result: g.cost != null ? g.cost : '' },
        g.pricePerKg != null ? g.pricePerKg : null
      ]);
      for(let c = 1; c <= 8; c++){
        const cell = row.getCell(c);
        cell.border = { bottom: xlThinBorder() };
        if(c >= 4) cell.alignment = { horizontal: 'right' };
      }
      row.getCell(2).font = { color: { argb: XL_COLORS.text } };
      row.getCell(3).font = { size: 10, color: { argb: XL_COLORS.dim } };
      row.getCell(4).numFmt = '0.00"%"';
      row.getCell(5).numFmt = '#,##0.00';
      row.getCell(6).numFmt = '#,##0.00';
      row.getCell(7).numFmt = '#,##0.00';
      row.getCell(8).numFmt = '#,##0.00';
      markInput(row.getCell(8));
    });

    const sumOf = col => `SUM(${col}${firstRow}:${col}${lastRow})`;
    // Ingredients with no name aren't listed, but their weight is still in the recipe total.
    const listedWt = sorted.reduce((s,g) => s + g.wt, 0);
    const hiddenWt = Math.max(0, ov.totalRecipeWeight - listedWt);
    const hasHidden = hiddenWt > 1e-9;
    const totalRow = ws.addRow([
      '', 'Formula Total', '',
      hasHidden
        ? { formula: `IF(E${totalRowNum}=0,0,100)`, result: ov.totalRecipeWeight > 0 ? 100 : 0 }
        : { formula: sumOf('D'), result: ov.rows.reduce((s,g) => s + g.pct, 0) },
      { formula: `${sumOf('E')}${hasHidden ? `+${hiddenWt}` : ''}`, result: ov.totalRecipeWeight },
      { formula: sumOf('F'), result: ov.prepareTotal },
      { formula: `IF(COUNT(G${firstRow}:G${lastRow})=0,"",${sumOf('G')})`, result: ov.totalCost != null ? ov.totalCost : '' }
    ]);
    for(let c = 1; c <= 8; c++){
      const cell = totalRow.getCell(c);
      cell.font = { bold: true, color: { argb: XL_COLORS.text } };
      cell.border = { top: { style: 'medium', color: { argb: XL_COLORS.text } } };
      if(c >= 4) cell.alignment = { horizontal: 'right' };
    }
    totalRow.getCell(4).numFmt = '0.00"%"';
    totalRow.getCell(5).numFmt = '#,##0.00';
    totalRow.getCell(6).numFmt = '#,##0.00';
    totalRow.getCell(7).numFmt = '#,##0.00';

    if(ov.costSuffix){
      const noteRow = ws.addRow(['', '* Some ingredients have no Price/kg on file in the Ingredient Library — this total doesn\'t include their cost.']);
      noteRow.getCell(2).font = { italic: true, size: 9, color: { argb: XL_COLORS.dim } };
    }
    addInputLegend(ws, 8);
    refs = { totalWeight: `'${SHEET}'!$E$${totalRowNum}`, totalCost: `'${SHEET}'!$G$${totalRowNum}` };
  }

  ws.views = [{ state: 'frozen', ySplit: 2 }];
  return refs;
}

// "3. Costing" -- Currency/Exchange Rate/Serving Size, Cost/100g/Cost/kg/
// Cost per Serving, then the Overhead + three-tier Factory/Company/Customer
// Margin cascade, same figures as the live card -- as live formulas fed by
// the Overview sheet's totals and the yellow input cells (Currency, Exchange
// Rate, Serving size, Overhead and Margin %). Every tier price = the tier
// below / (1 - (Overhead% + Margin%)/100), chained on the UNROUNDED figure
// and shown rounded up to 0.05, exactly like the live card.
function buildCostingSheet(wb, r, ovRefs){
  const ws = wb.addWorksheet('3. Costing');
  ws.columns = [{ width: 46 }, { width: 22 }, { width: 46 }];
  addSectionTitleBar(ws, '3. Costing', 3);
  let row = 3;

  function put(label, value, { fmt, input, note, align = 'right' } = {}){
    const rn = row++;
    const lc = ws.getCell(rn, 1);
    lc.value = label;
    lc.font = { bold: true, color: { argb: XL_COLORS.text } };
    const vc = ws.getCell(rn, 2);
    vc.value = (value === undefined || (typeof value === 'number' && !isFinite(value))) ? null : value;
    vc.alignment = { horizontal: align };
    if(fmt) vc.numFmt = fmt;
    if(input) markInput(vc);
    if(note){
      const nc = ws.getCell(rn, 3);
      nc.value = note;
      nc.font = { italic: true, size: 9, color: { argb: XL_COLORS.dim } };
    }
    return rn;
  }

  const ov = computeRecipeOverviewData(r);
  const c = computeCostingData(r, ov);
  const isThb = c.pricingCurrency === 'THB';
  const moneyFmt = isThb ? '"฿"#,##0.00' : `#,##0.00" ${c.pricingCurrency}"`;
  const pctFmt = '0.00"%"';
  const dash = v => (v == null ? '—' : v);

  const rCur = put('Currency', c.pricingCurrency, { input: true });
  const rRate = put('Exchange Rate (1 = ? THB)', c.exchangeRateVal, { input: true, fmt: '#,##0.0000', note: 'Only used when Currency is not THB' });
  if(!isThb) put('Rate Date', c.exchangeRateDate || null, { align: 'right' });
  const rServ = put('Amount per Serving (g)', c.servingSize || null, { input: true, fmt: '#,##0.##' });

  const cur = `$B$${rCur}`, rate = `$B$${rRate}`, serv = `$B$${rServ}`;
  const div = `IF(${cur}="THB",1,${rate})`;
  const tc = ovRefs ? ovRefs.totalCost : null, tw = ovRefs ? ovRefs.totalWeight : null;
  const costCell = (mult, per, result) => {
    if(!ovRefs) return '—';
    const core = per === 'serving' ? `IF(${serv}>0,${tc}/${tw}*${serv}/${div},"—")` : `${tc}/${tw}*${mult}/${div}`;
    return { formula: `IFERROR(IF(ISNUMBER(${tc}),${core},"—"),"—")`, result: dash(result) };
  };
  const sfx = c.costSuffix ? { note: c.costSuffix + ' some ingredients have no Price/kg — cost is incomplete' } : {};
  const rCps = put('Cost RM / Serving', costCell(1, 'serving', c.costPerServingNum), { fmt: moneyFmt, ...sfx });
  put('Cost RM / 100 g', costCell(100, 'w', c.costPer100Num), { fmt: moneyFmt, ...sfx });
  put('Cost RM / kg', costCell(1000, 'w', c.costPerKgNum), { fmt: moneyFmt, ...sfx });

  // Overhead / Margins / Selling Price (and the explanatory note below them)
  // mirror the live Costing card's own eye toggle (btnToggleCostingMargin /
  // costingMarginVisible, a per-browser localStorage preference) -- whichever
  // state it's in when Export Excel is clicked is what ships in the workbook.
  if(costingMarginVisible){
    row++;
    const sectionCell = ws.getCell(row, 1);
    sectionCell.value = 'Overhead & Margins';
    sectionCell.font = { bold: true, size: 12, color: { argb: XL_COLORS.groupText } };
    row++;

    const base = `$B$${rCps}`;
    const ceil = expr => `CEILING(ROUND(${expr},6),0.05)`;
    const rFo = put('Overhead (% of Factory Selling Price)', c.overheadPct, { input: true, fmt: pctFmt });
    const rFm = put('Factory Margin (% of Factory Selling Price)', c.factoryMargin, { input: true, fmt: pctFmt });
    const fo = `$B$${rFo}`, fm = `$B$${rFm}`;
    const fShare = `(${fo}+${fm})`;
    const fRaw = `${base}/(1-${fShare}/100)`;
    put('Factory Selling Price / Serving', {
      formula: `IFERROR(IF(AND(ISNUMBER(${base}),${fShare}<100),${ceil(fRaw)},"—"),"—")`, result: dash(c.factoryPriceNum)
    }, { fmt: moneyFmt, ...sfx });

    const rCo = put('Company Overhead (% of Company Selling Price)', c.companyOverhead ?? 0, { input: true, fmt: pctFmt });
    const rCm = put('Company Margin (% of Company Selling Price)', c.companyMargin, { input: true, fmt: pctFmt });
    const co = `$B$${rCo}`, cm = `$B$${rCm}`;
    const cShare = `(${co}+${cm})`;
    const cRaw = `${fRaw}/(1-${cShare}/100)`;
    put('Company Selling Price / Serving', {
      formula: `IFERROR(IF(AND(ISNUMBER(${base}),${fShare}<100,ISNUMBER(${cm}),${cShare}<100),${ceil(cRaw)},"—"),"—")`, result: dash(c.companyPriceNum)
    }, { fmt: moneyFmt, ...sfx });

    const rUo = put('Customer Overhead (% of Customer Selling Price)', c.customerOverhead ?? 0, { input: true, fmt: pctFmt });
    const rUm = put('Customer Margin (% of Customer Selling Price)', c.customerMargin, { input: true, fmt: pctFmt });
    const uo = `$B$${rUo}`, um = `$B$${rUm}`;
    const uShare = `(${uo}+${um})`;
    const uRaw = `${cRaw}/(1-${uShare}/100)`;
    put('Customer Selling Price / Serving', {
      formula: `IFERROR(IF(AND(ISNUMBER(${base}),${fShare}<100,ISNUMBER(${cm}),${cShare}<100,ISNUMBER(${um}),${uShare}<100),${ceil(uRaw)},"—"),"—")`, result: dash(c.customerPriceNum)
    }, { fmt: moneyFmt, ...sfx });

    row++;
    ws.mergeCells(row, 1, row, 3);
    const noteCell = ws.getCell(row, 1);
    noteCell.value = 'Costs are calculated from weight × the ingredient\'s Price/kg in the library (always stored in Thai Baht). Selling Price figures round up to the nearest 0.05 of the selected currency.';
    noteCell.font = { italic: true, size: 9, color: { argb: XL_COLORS.dim } };
    noteCell.alignment = { wrapText: true };
    ws.getRow(row).height = 26;
  }
  addInputLegend(ws, 3);
}

// "4. Ingredients" -- the Part/Sub-part tree. Weights, Yield % and the
// Part's own Yield % are the inputs; each Part's Formula (g) is the sum of
// its children, Prepare (g) divides by the Yields exactly like
// partPrepareWeight/computePrepareWeight (an ingredient's Prepare also
// carries every ancestor Part's Yield), and the % columns and totals are
// formulas too.
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
  const partHasNames = part => allIngredientsInPart(part).some(i => (i.name||'').trim() !== '');
  const namedParts = (r.parts || []).filter(partHasNames);
  const deferred = []; // % formulas need the total row's number, known only at the end
  let maxOutline = 0;
  const rowOf = { ing: new Map(), part: new Map() }; // recipe object -> its row here (the Process sheet links to these)

  // ancestorRefs: the Yield cells of every Part above this one (nearest first)
  // -- an ingredient's Prepare Wt divides by all of them.
  function addPartRows(part, depth, ancestorRefs, ancestorMultiplier){
    const isNamed = item => item.kind === 'part' ? partHasNames(item) : (item.name||'').trim() !== '';
    const items = part.items || [];
    const namedItems = items.filter(isNamed);
    // Blank-named rows aren't listed, but their weight still counts toward the Part.
    const hiddenItems = items.filter(item => !isNamed(item));
    const label = (part.name||'').trim() || 'Unnamed part';
    const partWeight = partTotalWeight(part);
    const partPct = totalWeight > 0 ? (partWeight / totalWeight * 100) : 0;
    const py = parseFloat(part.prepYieldPct);
    const partYieldDisplay = (isFinite(py) && py > 0) ? py : 100;

    const groupRow = ws.addRow([label, partYieldDisplay, '', partWeight, partPrepareWeight(part), partPct, partPct]);
    const pr = groupRow.number;
    rowOf.part.set(part, pr);
    groupRow.outlineLevel = Math.min(depth, 7);   // Excel outline: a Part folds under its parent, like a pivot table
    maxOutline = Math.max(maxOutline, groupRow.outlineLevel);
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
    markInput(groupRow.getCell(2));

    const myRefs = [`$B$${pr}`, ...ancestorRefs];
    const childMultiplier = ancestorMultiplier * computePrepareWeight(1, part.prepYieldPct);
    const weightRefs = [], prepareTerms = [];
    namedItems.forEach(item => {
      if(item.kind === 'part'){
        const rn = addPartRows(item, depth+1, myRefs, childMultiplier);
        weightRefs.push(`D${rn}`);
        prepareTerms.push(`E${rn}`);
        return;
      }
      const ing = item;
      const formulaWt = parseFloat(ing.weight) || 0;
      const iy = parseFloat(ing.prepYieldPct);
      const prepareWt = computePrepareWeight(formulaWt, ing.prepYieldPct) * childMultiplier;
      const ingRow = ws.addRow([
        ing.name, (isFinite(iy) && iy > 0) ? iy : null, (ing.note||'').trim(), formulaWt, 0, 0, 0
      ]);
      const rn = ingRow.number;
      rowOf.ing.set(ing, rn);
      ingRow.outlineLevel = Math.min(depth + 1, 7);
      maxOutline = Math.max(maxOutline, ingRow.outlineLevel);
      for(let c = 1; c <= 7; c++){
        const cell = ingRow.getCell(c);
        cell.border = { bottom: xlThinBorder() };
        cell.font = { color: { argb: XL_COLORS.text } };
        if(c === 1) cell.alignment = { indent: depth+1, vertical: 'middle' };
        else if(c !== 3) cell.alignment = { horizontal: 'right', vertical: 'middle' };
      }
      ingRow.getCell(2).numFmt = '0.00"%"';
      ingRow.getCell(4).numFmt = '#,##0.00';
      ingRow.getCell(5).numFmt = '#,##0.00';
      ingRow.getCell(6).numFmt = '0.00"%"';
      ingRow.getCell(7).numFmt = '0.00"%"';
      markInput(ingRow.getCell(2));
      markInput(ingRow.getCell(4));
      weightRefs.push(`D${rn}`);
      prepareTerms.push(`D${rn}/${xlYield(`$B$${rn}`)}`);
      // Cached results are what the app itself shows (Excel recalculates on open).
      ingRow.getCell(5).value = {
        formula: `D${rn}/${[xlYield(`$B$${rn}`), ...myRefs.map(xlYield)].join('/')}`,
        result: prepareWt
      };
      deferred.push(totalRowNum => {
        ingRow.getCell(6).value = { formula: `IF(D${pr}=0,0,D${rn}/D${pr}*100)`, result: partWeight > 0 ? formulaWt / partWeight * 100 : 0 };
        ingRow.getCell(7).value = { formula: `IF($D$${totalRowNum}=0,0,D${rn}/$D$${totalRowNum}*100)`, result: totalWeight > 0 ? formulaWt / totalWeight * 100 : 0 };
      });
    });

    // Hidden (blank-named) rows contribute as fixed amounts so the Part's figures stay equal to the app's.
    let hiddenWt = 0;
    hiddenItems.forEach(item => {
      if(item.kind === 'part'){ hiddenWt += partTotalWeight(item); prepareTerms.push(String(partPrepareWeight(item))); }
      else{
        const w = parseFloat(item.weight) || 0;
        hiddenWt += w;
        prepareTerms.push(String(computePrepareWeight(w, item.prepYieldPct)));
      }
    });
    groupRow.getCell(4).value = {
      formula: `SUM(${weightRefs.join(',')})${hiddenWt > 0 ? `+${hiddenWt}` : ''}`, result: partWeight
    };
    groupRow.getCell(5).value = {
      formula: `(${prepareTerms.join('+')})/${xlYield(`$B$${pr}`)}`, result: partPrepareWeight(part)
    };
    deferred.push(totalRowNum => {
      groupRow.getCell(6).value = { formula: `IF($D$${totalRowNum}=0,0,D${pr}/$D$${totalRowNum}*100)`, result: partPct };
      groupRow.getCell(7).value = { formula: `IF($D$${totalRowNum}=0,0,D${pr}/$D$${totalRowNum}*100)`, result: partPct };
    });
    return pr;
  }

  if(namedParts.length === 0){
    ws.addRow(['No ingredients']);
  } else {
    const partRows = namedParts.map(part => addPartRows(part, 0, [], 1));
    const hiddenTop = (r.parts || []).filter(p => !partHasNames(p)).reduce((s,p) => s + partTotalWeight(p), 0);
    const totalPrepareWeight = namedParts.reduce((s,p) => s + partPrepareWeight(p), 0);
    const totalRow = ws.addRow([
      'Formula total', '', '',
      { formula: `SUM(${partRows.map(n => `D${n}`).join(',')})${hiddenTop > 0 ? `+${hiddenTop}` : ''}`, result: totalWeight },
      { formula: `SUM(${partRows.map(n => `E${n}`).join(',')})`, result: totalPrepareWeight },
      100, 100
    ]);
    totalRow.eachCell((cell, colNumber) => {
      cell.font = { bold: true, color: { argb: XL_COLORS.text } };
      cell.border = { top: { style: 'medium', color: { argb: XL_COLORS.text } } };
      if(colNumber > 1) cell.alignment = { horizontal: 'right' };
    });
    totalRow.getCell(4).numFmt = '#,##0.00';
    totalRow.getCell(5).numFmt = '#,##0.00';
    totalRow.getCell(6).numFmt = '0.00"%"';
    totalRow.getCell(7).numFmt = '0.00"%"';
    deferred.forEach(fn => fn(totalRow.number));
    addInputLegend(ws, 7);
  }

  // The +/- fold buttons sit on the Part row above its contents (summary row on top), the way a pivot table does.
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  ws.properties.outlineLevelRow = maxOutline;
  ws.views = [{ state: 'frozen', ySplit: 2 }];
  return rowOf;
}

// ingRows: where each Part/ingredient sits on the "4. Ingredients" sheet, so
// the Components tables here can point at those cells -- change a weight
// there and the matching figures on this sheet follow.
function buildProcessSheet(wb, r, ingRows){
  const ING = "'4. Ingredients'!";
  const linkRef = (map, obj, col) => (ingRows && map.has(obj)) ? `${ING}${col}${map.get(obj)}` : null;
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
    // Merge AFTER the values are set -- Row.values rebuilds the row's cells and drops a merge made before it.
    const titleRow = row;
    setRow([p.title || 'Untitled process'], r2 => {
      r2.height = 22;
      const cell = r2.getCell(1);
      cell.font = { bold: true, size: 13, color: { argb: XL_COLORS.groupText } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.groupFill } };
      cell.alignment = { vertical: 'middle', indent: 1 };
    });
    ws.mergeCells(titleRow, 1, titleRow, 6);

    const components = p.components || [];
    if(components.length){
      setRow(['#','Component','Weight (g)','Tolerance','Range','%'], r2 => {
        r2.eachCell(cell => {
          cell.font = { bold: true, color: { argb: XL_COLORS.dim } };
          cell.border = { bottom: xlThinBorder() };
        });
      });
      const compRows = []; // main (non-sub-list) rows -- what Total and % are made of
      const allNamed = allIngredientsInRecipe(r);
      // A component's weight always follows the Ingredients sheet when its name
      // matches a Part (or a single ingredient); only free-typed names keep their own weight.
      const resolved = components.map(c => {
        const name = (c.name || '').trim();
        const matchedPart = findPartByName(r.parts, name);
        let wtRef = null, wtNow = null;
        if(matchedPart){
          wtRef = linkRef(ingRows && ingRows.part, matchedPart, 'D'); wtNow = partTotalWeight(matchedPart);
        } else if(name){
          const same = allNamed.filter(i => (i.name || '').trim() === name);
          if(same.length === 1){ wtRef = linkRef(ingRows && ingRows.ing, same[0], 'D'); wtNow = parseFloat(same[0].weight) || 0; }
        }
        return { matchedPart, wtRef, wt: wtRef ? wtNow : (parseFloat(c.weight) || 0) };
      });
      const compTotal = resolved.reduce((s, x) => s + x.wt, 0);
      components.forEach((c, cIdx) => {
        const { matchedPart, wtRef, wt } = resolved[cIdx];
        const tol = parseFloat(c.tolerance) || 0;
        const rn = row;
        setRow([
          cIdx+1, c.name||'',
          wtRef ? { formula: wtRef, result: wt } : wt,
          tol,
          { formula: `TEXT(C${rn}-D${rn},"0.00")&"-"&TEXT(C${rn}+D${rn},"0.00")&" g"`, result: `${(wt-tol).toFixed(2)}-${(wt+tol).toFixed(2)} g` },
          compTotal > 0 ? wt / compTotal * 100 : 0
        ], r2 => {
          r2.getCell(3).numFmt = '#,##0.00';
          r2.getCell(4).numFmt = '"±"0.##;-"±"0.##;';
          r2.getCell(6).numFmt = '0.00"%"';
          r2.getCell(1).alignment = { horizontal: 'left' };
        });
        compRows.push({ rn, c, wt });

        const innerIngredients = matchedPart ? allIngredientsInPart(matchedPart).filter(i => (i.name||'').trim() !== '') : [];
        innerIngredients.forEach(ing => {
          const nameRef = linkRef(ingRows && ingRows.ing, ing, 'A');
          const wRef = linkRef(ingRows && ingRows.ing, ing, 'D');
          const pRef = linkRef(ingRows && ingRows.ing, ing, 'F');
          setRow([
            '',
            nameRef ? { formula: nameRef, result: ing.name } : ing.name,
            wRef ? { formula: wRef, result: parseFloat(ing.weight)||0 } : (parseFloat(ing.weight)||0),
            '', '',
            pRef ? { formula: pRef, result: parseFloat(ing.percent)||0 } : (parseFloat(ing.percent)||0)
          ], r2 => {
            const nameCell = r2.getCell(2);
            nameCell.font = { italic: true, color: { argb: XL_COLORS.dim } };
            nameCell.alignment = { indent: 1 };
            r2.getCell(3).numFmt = '#,##0.00';
            r2.getCell(6).numFmt = '0.00"%"';
          });
        });
      });
      const totalRn = row;
      const refsOf = col => compRows.map(x => `${col}${x.rn}`).join(',');
      setRow([
        '', 'Total',
        { formula: `SUM(${refsOf('C')})`, result: compTotal },
        '', '',
        { formula: `SUM(${refsOf('F')})`, result: compTotal > 0 ? 100 : 0 }
      ], r2 => {
        r2.eachCell(cell => { cell.font = { bold: true }; cell.border = { top: xlThinBorder() }; });
        r2.getCell(3).numFmt = '#,##0.00';
        r2.getCell(6).numFmt = '0.00"%"';
      });
      // % = each weight / this table's total, like the live table (needs the total's row number).
      compRows.forEach(x => {
        ws.getCell(x.rn, 6).value = { formula: `IF($C$${totalRn}=0,0,C${x.rn}/$C$${totalRn}*100)`, result: compTotal > 0 ? x.wt / compTotal * 100 : 0 };
      });
    }

    const wtBefore = parseFloat(p.weightBefore);
    const wtAfter = parseFloat(p.weightAfter);
    const actualYieldPct = (isFinite(wtBefore) && wtBefore > 0 && isFinite(wtAfter)) ? (wtAfter / wtBefore * 100).toFixed(2) + '%' : '—';
    if(p.showActualYield !== false){
      setRow(['Trial Results Section'], r2 => { r2.getCell(1).font = { bold: true, color: { argb: XL_COLORS.dim } }; });
      setRow(['', 'Weight Before / After', `${isFinite(wtBefore) ? formatWeight(wtBefore) : '—'} → ${isFinite(wtAfter) ? formatWeight(wtAfter) : '—'}`, `Yield ${actualYieldPct}`]);
      ['brix','salt','ph'].forEach(field => {
        const reps = fmtReps(Array.isArray(p[field]) ? p[field] : [null, null, null]);
        const validReps = reps.filter(v => v != null);
        const label = field === 'brix' ? '°Brix' : field === 'salt' ? '%Salt' : 'pH';
        setRow(['', label, reps.map(v => v != null ? v : '—').join(', '), `Avg ${avgOf(validReps.map(Number)) || '—'}`]);
      });

    }

    setRow(['Steps'], r2 => { r2.getCell(1).font = { bold: true, color: { argb: XL_COLORS.dim } }; });
    const steps = (p.steps || []).filter(s => (s||'').trim() !== '');
    if(steps.length){
      // Step number in column A, text from column B across to F, both left-aligned.
      steps.forEach((s, idx) => {
        const stepRow = row;
        setRow([`${idx+1}.`, s], r2 => {
          r2.getCell(1).alignment = { horizontal: 'left', vertical: 'top' };
          r2.getCell(2).alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
        });
        ws.mergeCells(stepRow, 2, stepRow, 6);
      });
    } else {
      const noStepsRow = row;
      setRow(['', 'No steps yet']);
      ws.mergeCells(noStepsRow, 2, noStepsRow, 6);
    }

    row++; // blank separator row between processes
  });
}

// A NaN / Infinity in a cell is written as <v>NaN</v>, which Excel reports as "a problem with some
// content" and offers to repair -- blank such cells (and formula results) instead.
function stripNonFiniteNumbers(wb){
  const bad = v => typeof v === 'number' && !isFinite(v);
  wb.worksheets.forEach(ws => ws.eachRow({ includeEmpty: false }, row => row.eachCell({ includeEmpty: false }, cell => {
    const v = cell.value;
    if(bad(v)) cell.value = null;
    else if(v && typeof v === 'object' && v.formula !== undefined && bad(v.result)) cell.value = { formula: v.formula, result: '' };
  })));
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
  // The sheets carry live formulas -- have Excel recompute them as soon as the file opens.
  wb.calcProperties = { fullCalcOnLoad: true };

  renderPrintView(r);
  await addRecipePreviewSheet(wb, document.getElementById('recipeCards'));
  buildProductDetailsSheet(wb, r);
  const overviewRefs = buildRecipeOverviewSheet(wb, r);
  buildCostingSheet(wb, r, overviewRefs);
  const ingredientRows = buildIngredientsSheet(wb, r);
  buildProcessSheet(wb, r, ingredientRows);
  finishRecipeWorksheets(wb);
  stripNonFiniteNumbers(wb);

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
