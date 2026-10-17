/* ---------- Export Excel for Compare Recipes / Compare Trials ----------
   Builds a workbook from what the Compare page is showing right now (the
   selected recipes, "show codes"/"also show weight" choices, Part grouping):
     1. Overview        -- name, code, date, total weight, customer ... per recipe
     2. Ingredients     -- % of recipe (and g) per recipe, grouped by Part / Sub-part
     3. Costing         -- weight x library Price/kg per recipe, same grouping
     4. Process Steps   -- every recipe's processes side by side
   Ingredients and Costing use Excel's own row outline, so every Part row has a
   +/- button to fold or unfold what is inside it (and 1 2 3 level buttons for
   the whole sheet), like a pivot table. Those two sheets deliberately don't use
   "fit to page" -- ExcelJS writes that setting ahead of the outline setting,
   an order Excel rejects as a corrupt sheet. */
import { fullCode, recipeDisplayLabel, allIngredientsInRecipe, formatWeight } from './app.js';

const C = {
  header: 'FF16294A', headerText: 'FFFFFFFF', group: 'FFE8ECF5', groupText: 'FF0C1830',
  border: 'FFDFE3EA', dim: 'FF6B7280', text: 'FF1C2333', diff: 'FFFFF1E0'
};
const FONT = 'Leelawadee UI';
const thin = () => ({ style: 'thin', color: { argb: C.border } });
const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const MAX_LEVEL = 7;

function titleBar(ws, text, span){
  ws.mergeCells(1, 1, 1, span);
  const cell = ws.getCell(1, 1);
  cell.value = text;
  cell.font = { name: FONT, bold: true, size: 13, color: { argb: C.headerText } };
  cell.fill = fill(C.header);
  cell.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 26;
}
function noteRow(ws, text, span){
  ws.mergeCells(2, 1, 2, span);
  const cell = ws.getCell(2, 1);
  cell.value = text;
  cell.font = { name: FONT, italic: true, size: 9, color: { argb: C.dim } };
  cell.alignment = { vertical: 'middle', indent: 1 };
}
const totalOf = r => allIngredientsInRecipe(r).reduce((s, i) => s + (parseFloat(i.weight) || 0), 0);

// Recipes that are actually picked, in slot order.
function pickedRecipes(d){
  return d.ids.map(id => d.selected.find(r => r.id === id)).filter(Boolean);
}
function recipeHeader(r){
  return `${r.name || 'Untitled recipe'}\n${fullCode(r) || recipeDisplayLabel(r)}`;
}

function styleHeaderCell(cell){
  cell.font = { name: FONT, bold: true, color: { argb: C.headerText } };
  cell.fill = fill(C.header);
  cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
}

/* ----- 1. Overview ----- */
function buildOverview(wb, d, recipes){
  const ws = wb.addWorksheet('Overview');
  ws.columns = [{ width: 24 }, ...recipes.map(() => ({ width: 42 }))];
  titleBar(ws, d.title, recipes.length + 1);
  const head = ws.addRow(['', ...recipes.map(r => r.name || 'Untitled recipe')]);
  head.eachCell((cell, c) => { if(c > 1) styleHeaderCell(cell); });
  head.height = 28;
  const line = (label, fn) => {
    const row = ws.addRow([label, ...recipes.map(fn)]);
    row.getCell(1).font = { name: FONT, bold: true, color: { argb: C.text } };
    row.eachCell((cell, c) => {
      if(c > 1){ cell.font = { name: FONT, color: { argb: C.text } }; cell.alignment = { vertical: 'top', wrapText: true }; }
      cell.border = { bottom: thin() };
    });
    row.getCell(1).alignment = { vertical: 'top' };
  };
  line('Code', r => fullCode(r) || '-');
  line('Date', r => r.date || '-');
  line('Total weight', r => formatWeight(totalOf(r)));
  if(recipes.some(r => r.customerName)) line('Customer', r => r.customerName || '');
  if(recipes.some(r => r.destinationCountry)) line('Destination country', r => r.destinationCountry || '');
  if(recipes.some(r => r.salesRep)) line('Sales rep', r => r.salesRep || '');
  line('Description', r => {
    const pts = (r.description || []).filter(p => (p || '').trim() !== '');
    return pts.length ? pts.map((p, i) => `${i + 1}. ${p}`).join('\n') : '-';
  });
  if(d.notes && recipes.some(r => (d.notes[r.id] || '').trim() !== '')) line('Note', r => d.notes[r.id] || '');
  ws.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
}

/* ----- 2. Ingredients ----- */
function buildIngredients(wb, d, recipes){
  const ws = wb.addWorksheet('Ingredients');
  const per = d.showWeights ? 2 : 1;
  const span = 1 + recipes.length * per;
  ws.columns = [{ width: 46 }, ...recipes.flatMap(() => Array.from({ length: per }, () => ({ width: 15 })))];
  titleBar(ws, `Compare Ingredients (% of recipe) — ${d.title}`, span);
  noteRow(ws, 'Use the + / − buttons beside the row numbers (or the 1 2 3 buttons at the top left) to fold or unfold each Part. Orange rows = ingredient not used in every recipe.', span);

  const h1 = ws.addRow(['Ingredient', ...recipes.flatMap(r => d.showWeights ? [recipeHeader(r), ''] : [recipeHeader(r)])]);
  h1.eachCell(styleHeaderCell);
  h1.height = 34;
  if(d.showWeights){
    recipes.forEach((r, i) => ws.mergeCells(h1.number, 2 + i * 2, h1.number, 3 + i * 2));
    const h2 = ws.addRow(['', ...recipes.flatMap(() => ['%', 'g'])]);
    h2.eachCell(styleHeaderCell);
    ws.mergeCells(h1.number, 1, h2.number, 1);
  }
  const headerRows = d.showWeights ? 2 : 1;
  let maxLevel = 0;
  const level = (row, n) => { row.outlineLevel = Math.min(n, MAX_LEVEL); maxLevel = Math.max(maxLevel, row.outlineLevel); };

  function totals(section){
    const t = {};
    recipes.forEach(r => { t[r.id] = { pct: 0, wt: 0 }; });
    section.rows.forEach(row => recipes.forEach(r => { t[r.id].pct += row.values[r.id] || 0; t[r.id].wt += row.weights[r.id] || 0; }));
    (section.subSections || []).forEach(sub => { const s = totals(sub); recipes.forEach(r => { t[r.id].pct += s[r.id].pct; t[r.id].wt += s[r.id].wt; }); });
    return t;
  }

  function addSection(section, depth){
    const t = totals(section);
    const group = ws.addRow([section.label, ...recipes.flatMap(r => d.showWeights ? [t[r.id].pct, t[r.id].wt] : [t[r.id].pct])]);
    level(group, depth);
    for(let c = 1; c <= span; c++){
      const cell = group.getCell(c);
      cell.font = { name: FONT, bold: true, color: { argb: C.groupText } };
      cell.fill = fill(C.group);
      cell.border = { bottom: thin() };
      cell.alignment = c === 1 ? { indent: depth, vertical: 'middle' } : { horizontal: 'right', vertical: 'middle' };
      if(c > 1) cell.numFmt = (d.showWeights && c % 2 === 1) ? '#,##0.00' : '0.00"%"';
    }
    section.rows.forEach(row => {
      const present = recipes.filter(r => row.values[r.id] !== undefined).length;
      const diff = present > 0 && present < recipes.length;
      const cells = recipes.flatMap(r => {
        const v = row.values[r.id];
        if(v === undefined) return d.showWeights ? ['— Not used —', ''] : ['— Not used —'];
        return d.showWeights ? [v, row.weights[r.id] || 0] : [v];
      });
      const ingRow = ws.addRow([d.labelOf(row), ...cells]);
      level(ingRow, depth + 1);
      for(let c = 1; c <= span; c++){
        const cell = ingRow.getCell(c);
        cell.font = { name: FONT, color: { argb: C.text } };
        cell.border = { bottom: thin() };
        if(diff) cell.fill = fill(C.diff);
        cell.alignment = c === 1 ? { indent: depth + 1, vertical: 'middle', wrapText: true } : { horizontal: 'right', vertical: 'middle' };
        if(c > 1) cell.numFmt = (d.showWeights && c % 2 === 1) ? '#,##0.00' : '0.00"%"';
      }
      if(d.showWeights){
        recipes.forEach((r, i) => {
          if(row.values[r.id] === undefined){
            ws.mergeCells(ingRow.number, 2 + i * 2, ingRow.number, 3 + i * 2);
            const cell = ingRow.getCell(2 + i * 2);
            cell.font = { name: FONT, italic: true, color: { argb: C.dim } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
          }
        });
      }else{
        recipes.forEach((r, i) => {
          if(row.values[r.id] === undefined){
            const cell = ingRow.getCell(2 + i);
            cell.font = { name: FONT, italic: true, color: { argb: C.dim } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
          }
        });
      }
    });
    (section.subSections || []).forEach(sub => addSection(sub, depth + 1));
  }
  d.partSections.forEach(section => addSection(section, 0));

  const total = ws.addRow(['Recipe total', ...recipes.flatMap(r => { const w = totalOf(r); return d.showWeights ? [w > 0 ? 100 : 0, w] : [w > 0 ? 100 : 0]; })]);
  for(let c = 1; c <= span; c++){
    const cell = total.getCell(c);
    cell.font = { name: FONT, bold: true, color: { argb: C.text } };
    cell.border = { top: { style: 'medium', color: { argb: C.text } } };
    cell.alignment = c === 1 ? { vertical: 'middle' } : { horizontal: 'right', vertical: 'middle' };
    if(c > 1) cell.numFmt = (d.showWeights && c % 2 === 1) ? '#,##0.00' : '0.00"%"';
  }
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  ws.properties.outlineLevelRow = maxLevel;
  ws.pageSetup = { paperSize: 9, orientation: 'landscape', scale: 70 };
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 + headerRows, showGridLines: false }];
}

/* ----- 3. Costing ----- */
function buildCosting(wb, d, recipes){
  const ws = wb.addWorksheet('Costing');
  const span = 1 + recipes.length;
  ws.columns = [{ width: 46 }, ...recipes.map(() => ({ width: 20 }))];
  titleBar(ws, `Compare Costing (weight × Price/kg from the Ingredient Library) — ${d.title}`, span);
  noteRow(ws, 'Use the + / − buttons beside the row numbers (or the 1 2 3 buttons at the top left) to fold or unfold each Part. * = a total that leaves out ingredients with no price on file.', span);
  const h = ws.addRow(['Ingredient', ...recipes.map(recipeHeader)]);
  h.eachCell(styleHeaderCell);
  h.height = 34;
  let maxLevel = 0, anyUnpriced = false;
  const level = (row, n) => { row.outlineLevel = Math.min(n, MAX_LEVEL); maxLevel = Math.max(maxLevel, row.outlineLevel); };
  const baht = '"฿"#,##0.00';

  function costs(section){
    const t = {};
    recipes.forEach(r => { t[r.id] = { cost: 0, unpriced: false }; });
    section.rows.forEach(row => {
      const price = d.priceOf(row.label);
      recipes.forEach(r => {
        const wt = row.weights[r.id];
        if(wt === undefined) return;
        if(price === null){ t[r.id].unpriced = true; return; }
        t[r.id].cost += (wt / 1000) * price;
      });
    });
    (section.subSections || []).forEach(sub => { const s = costs(sub); recipes.forEach(r => { t[r.id].cost += s[r.id].cost; t[r.id].unpriced = t[r.id].unpriced || s[r.id].unpriced; }); });
    return t;
  }
  function addSection(section, depth){
    const t = costs(section);
    const group = ws.addRow([section.label, ...recipes.map(() => null)]);
    // numbers with a trailing * when something under the Part has no price
    recipes.forEach((r, i) => {
      const cell = group.getCell(2 + i);
      cell.value = t[r.id].cost;
      if(t[r.id].unpriced){ anyUnpriced = true; cell.numFmt = '"฿"#,##0.00" *"'; } else cell.numFmt = baht;
    });
    level(group, depth);
    for(let c = 1; c <= span; c++){
      const cell = group.getCell(c);
      cell.font = { name: FONT, bold: true, color: { argb: C.groupText } };
      cell.fill = fill(C.group);
      cell.border = { bottom: thin() };
      cell.alignment = c === 1 ? { indent: depth, vertical: 'middle' } : { horizontal: 'right', vertical: 'middle' };
    }
    section.rows.forEach(row => {
      const price = d.priceOf(row.label);
      const cells = recipes.map(r => {
        const wt = row.weights[r.id];
        if(wt === undefined) return '— Not used —';
        if(price === null) return 'No price set';
        return (wt / 1000) * price;
      });
      const ingRow = ws.addRow([d.labelOf(row), ...cells]);
      level(ingRow, depth + 1);
      for(let c = 1; c <= span; c++){
        const cell = ingRow.getCell(c);
        cell.font = { name: FONT, color: { argb: C.text } };
        cell.border = { bottom: thin() };
        cell.alignment = c === 1 ? { indent: depth + 1, vertical: 'middle', wrapText: true } : { horizontal: 'right', vertical: 'middle' };
        if(c > 1){
          if(typeof cell.value === 'number') cell.numFmt = baht;
          else cell.font = { name: FONT, italic: true, color: { argb: C.dim } };
        }
      }
    });
    (section.subSections || []).forEach(sub => addSection(sub, depth + 1));
  }
  d.partSections.forEach(section => addSection(section, 0));

  // Grand totals over the whole recipe (same figures the page shows).
  const totalCost = {}, unpricedAll = {};
  recipes.forEach(r => { totalCost[r.id] = 0; unpricedAll[r.id] = false; });
  d.rows.forEach(row => {
    const price = d.priceOf(row.label);
    recipes.forEach(r => {
      const wt = row.weights[r.id];
      if(wt === undefined) return;
      if(price === null){ unpricedAll[r.id] = true; return; }
      totalCost[r.id] += (wt / 1000) * price;
    });
  });
  const totalRow = ws.addRow(['Total Cost', ...recipes.map(r => totalCost[r.id])]);
  const perKgRow = ws.addRow(['Cost / kg of product', ...recipes.map(r => (r.batchWeight ? totalCost[r.id] / (r.batchWeight / 1000) : 'No batch weight'))]);
  [totalRow, perKgRow].forEach(row => {
    for(let c = 1; c <= span; c++){
      const cell = row.getCell(c);
      cell.font = { name: FONT, bold: true, color: { argb: C.text } };
      cell.border = row === totalRow ? { top: { style: 'medium', color: { argb: C.text } } } : {};
      cell.alignment = c === 1 ? { vertical: 'middle' } : { horizontal: 'right', vertical: 'middle' };
      if(c > 1 && typeof cell.value === 'number'){
        const r = recipes[c - 2];
        cell.numFmt = unpricedAll[r.id] ? '"฿"#,##0.00" *"' : baht;
        if(unpricedAll[r.id]) anyUnpriced = true;
      }
    }
  });
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  ws.properties.outlineLevelRow = maxLevel;
  ws.pageSetup = { paperSize: 9, orientation: 'landscape', scale: 70 };
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 3, showGridLines: false }];
}

/* ----- 4. Process Steps ----- */
function buildSteps(wb, d, recipes){
  const ws = wb.addWorksheet('Process Steps');
  ws.columns = [{ width: 4 }, ...recipes.map(() => ({ width: 52 }))];
  titleBar(ws, `Compare Process Steps — ${d.title}`, recipes.length + 1);
  const h = ws.addRow(['', ...recipes.map(r => recipeDisplayLabel(r))]);
  h.eachCell((cell, c) => { if(c > 1) styleHeaderCell(cell); });
  h.height = 28;
  const lines = recipes.map(r => {
    const out = [];
    (r.processes || []).filter(p => (p.title || '').trim() !== '' || (p.steps || []).some(s => (s || '').trim() !== '')).forEach(p => {
      out.push({ text: p.title || 'Untitled process', head: true });
      const steps = (p.steps || []).filter(s => (s || '').trim() !== '');
      if(steps.length) steps.forEach((s, i) => out.push({ text: `${i + 1}. ${s}` }));
      else out.push({ text: 'No steps yet', dim: true });
    });
    if(!out.length) out.push({ text: 'No processes yet', dim: true });
    return out;
  });
  const n = Math.max(...lines.map(l => l.length));
  for(let i = 0; i < n; i++){
    const row = ws.addRow(['', ...lines.map(l => (l[i] ? l[i].text : ''))]);
    lines.forEach((l, c) => {
      const cell = row.getCell(2 + c);
      const item = l[i];
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.font = { name: FONT, bold: !!(item && item.head), italic: !!(item && item.dim), color: { argb: item && item.dim ? C.dim : C.text } };
      if(item && item.head) cell.fill = fill(C.group);
    });
  }
  ws.pageSetup = { paperSize: 9, orientation: 'landscape', scale: 70 };
  ws.views = [{ state: 'frozen', ySplit: 2, showGridLines: false }];
}

// A NaN / Infinity in a cell makes Excel offer to "repair" the file -- blank them.
function stripNonFinite(wb){
  const bad = v => typeof v === 'number' && !isFinite(v);
  wb.worksheets.forEach(ws => ws.eachRow(row => row.eachCell(cell => { if(bad(cell.value)) cell.value = null; })));
}

export async function exportCompareToExcel(d){
  if(!window.ExcelJS){
    alert('Excel export isn\'t available right now (ExcelJS failed to load) -- check your connection and try again.');
    return;
  }
  const recipes = pickedRecipes(d);
  if(recipes.length < 2){
    alert('Select at least 2 recipes to compare before exporting.');
    return;
  }
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Forge';
  wb.created = new Date();
  buildOverview(wb, d, recipes);
  buildIngredients(wb, d, recipes);
  buildCosting(wb, d, recipes);
  buildSteps(wb, d, recipes);
  stripNonFinite(wb);

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${d.title}`.replace(/[\\/:*?"<>|]/g, '-') + '.xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
