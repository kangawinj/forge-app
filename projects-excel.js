// Projects -> Export Excel. Same flat-row ExcelJS pattern as
// materials-excel.js/products-excel.js (own copy of the XL_COLORS/border
// helpers, see that file's own comment on why). One row per project --
// Requirements' structured fields are flattened into their own columns
// (lossless, just wide) and Monthly Updates are summarized to a count +
// latest entry rather than one column per update, which would make a
// project with a long history unreadable as a single row.
import { recipes, recipeDisplayLabel, fullCode, formatActivityDateTime } from './app.js';
import { getRequirements, certificateSummaryText } from './projects-requirements.js';
import { PROJECT_STATUS_LABELS, muPlanSummaryLine, migrateMonthlyUpdate } from './projects-data.js';

function xlArgb(hex){
  return 'FF' + hex.replace('#','').toUpperCase();
}
const XL_COLORS = {
  headerFill: xlArgb('#16294a'),
  headerText: xlArgb('#ffffff'),
  groupFill: xlArgb('#e8ecf5'),
  groupText: xlArgb('#0c1830'),
  border: xlArgb('#dfe3ea'),
  text: xlArgb('#1c2333')
};
function xlThinBorder(){
  return { style: 'thin', color: { argb: XL_COLORS.border } };
}
function addSectionTitleBar(ws, title, colSpan){
  ws.mergeCells(1, 1, 1, colSpan);
  const cell = ws.getCell(1, 1);
  cell.value = title;
  cell.font = { bold: true, size: 13, color: { argb: XL_COLORS.headerText } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.headerFill } };
  cell.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 26;
}

const COLUMNS = [
  { header: 'Project Name', key: 'name', width: 26 },
  { header: 'Status', key: 'status', width: 16 },
  { header: 'Requested Date', key: 'requestDate', width: 14 },
  { header: 'Customer', key: 'customer', width: 20 },
  { header: 'Destination', key: 'destination', width: 16 },
  { header: 'Owner Sales Rep', key: 'ownerSalesRep', width: 18 },
  { header: 'Factory Sales Rep', key: 'factorySalesRep', width: 18 },
  { header: 'Responsible Person (PD)', key: 'responsiblePerson', width: 18 },
  { header: 'Factory', key: 'factory', width: 18 },
  { header: 'Products', key: 'products', width: 34 },
  { header: 'Flavor or Filling', key: 'flavorFilling', width: 24 },
  { header: 'Composition', key: 'composition', width: 24 },
  { header: 'Recipe', key: 'recipe', width: 24 },
  { header: 'Packaging Condition', key: 'packagingCondition', width: 24 },
  { header: 'Storage Condition', key: 'storageCondition', width: 20 },
  { header: 'Shelf Life', key: 'shelfLife', width: 14 },
  { header: 'Cooking Condition', key: 'cookingCondition', width: 30 },
  { header: 'Certificate', key: 'certificate', width: 22 },
  { header: 'Requirements Note', key: 'reqNote', width: 26 },
  { header: 'Monthly Updates', key: 'muCount', width: 14 },
  { header: 'Latest Update', key: 'latestUpdate', width: 34 },
  { header: 'Created By', key: 'createdBy', width: 22 },
  { header: 'Last Updated', key: 'lastUpdated', width: 30 }
];

function productsText(products){
  if(!Array.isArray(products) || !products.length) return '';
  return products.map(prod => {
    const r = recipes.find(x => x.id === prod.recipeId);
    const label = r ? `${recipeDisplayLabel(r)}${fullCode(r) ? ' · ' + fullCode(r) : ''}` : 'Recipe not found';
    return `${label} — ${prod.stage || 'Requested'}`;
  }).join('\n');
}

function cookingConditionText(cc){
  if(!Array.isArray(cc) || !cc.length) return '';
  return cc.map(g => {
    const steps = (g.steps || []).filter(Boolean).map((s,i) => `${i+1}. ${s}`).join(' ');
    return [g.method, steps].filter(Boolean).join(' — ');
  }).join('\n');
}

function latestUpdateText(monthlyUpdates){
  if(!Array.isArray(monthlyUpdates) || !monthlyUpdates.length) return '';
  const sorted = [...monthlyUpdates].map(migrateMonthlyUpdate).sort((a,b) => (b.date||'').localeCompare(a.date||''));
  const mu = sorted[0];
  const parts = [mu.date, muPlanSummaryLine(mu)];
  if(mu.actionTaken) parts.push('Action: ' + mu.actionTaken);
  return parts.filter(Boolean).join('\n');
}

export async function exportProjectsToExcel(projects){
  if(!window.ExcelJS){
    alert('Excel export isn\'t available right now (ExcelJS failed to load) -- check your connection and try again.');
    return;
  }
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Forge';
  wb.created = new Date();
  const ws = wb.addWorksheet('Projects');
  ws.columns = COLUMNS.map(c => ({ width: c.width }));
  addSectionTitleBar(ws, 'Projects', COLUMNS.length);

  const headerRow = ws.addRow(COLUMNS.map(c => c.header));
  headerRow.eachCell(cell => {
    cell.font = { bold: true, size: 11, color: { argb: XL_COLORS.groupText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.groupFill } };
    cell.border = { top: xlThinBorder(), bottom: xlThinBorder(), left: xlThinBorder(), right: xlThinBorder() };
    cell.alignment = { vertical: 'middle' };
  });

  const sorted = [...projects].filter(p => !p.isUnassignedBucket).sort((a,b) => (a.name||'').localeCompare(b.name||''));
  sorted.forEach(p => {
    const req = getRequirements(p);
    const lastUpdated = (p.updatedBy && p.updatedAt !== p.createdAt)
      ? `${p.updatedBy}${p.updatedAt ? ' · ' + formatActivityDateTime(p.updatedAt) : ''}`
      : '';
    const row = ws.addRow([
      p.name || '',
      PROJECT_STATUS_LABELS[p.status] || p.status || '',
      p.requestDate || '',
      p.customerName || '',
      p.destinationCountry || '',
      p.ownerSalesRep || '',
      p.factorySalesRep || '',
      p.responsiblePerson || '',
      p.factoryName || '',
      productsText(p.products),
      req.flavorFilling || '',
      req.composition || '',
      req.recipe || '',
      req.packagingCondition || '',
      req.storageCondition || '',
      req.shelfLife || '',
      cookingConditionText(req.cookingCondition),
      certificateSummaryText(req.certificate),
      req.note || '',
      (p.monthlyUpdates || []).length,
      latestUpdateText(p.monthlyUpdates),
      p.createdBy || '',
      lastUpdated
    ]);
    row.eachCell(cell => {
      cell.font = { size: 11, color: { argb: XL_COLORS.text } };
      cell.alignment = { wrapText: true, vertical: 'top' };
      cell.border = { top: xlThinBorder(), bottom: xlThinBorder(), left: xlThinBorder(), right: xlThinBorder() };
    });
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Projects ${new Date().toISOString().slice(0,10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

// Projects by Status (List view) -> Excel, laid out like the page: the Excel-tracker columns, one section row per
// status, then the Monthly Update columns. `model` is built by projects.js from the very rows the page shows:
//   { title, headers: [...], widths: [...], groups: [{ label, rows: [[...cells]] }] }
export async function exportProjectsStatusTableToExcel(model){
  if(!window.ExcelJS){
    alert('Excel export is not available right now (ExcelJS failed to load) -- check your connection and try again.');
    return;
  }
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Forge';
  wb.created = new Date();
  const ws = wb.addWorksheet('Projects by Status');
  ws.columns = model.widths.map(w => ({ width: w }));
  const span = model.headers.length;
  addSectionTitleBar(ws, model.title, span);

  const head = ws.addRow(model.headers);
  head.height = 32;
  head.eachCell(cell => {
    cell.font = { bold: true, size: 11, color: { argb: xlArgb('#0c2b30') } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: xlArgb('#bfeff3') } };
    cell.border = { top: xlThinBorder(), bottom: xlThinBorder(), left: xlThinBorder(), right: xlThinBorder() };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: 2 }];     // title + header rows, and No. + Product Name, stay in view

  const centered = new Set([0, 2, 4, 5, 6, 7, 8, 9]);        // No., Initiated by, Target Market, Owner, PD, Date, Cooked, Factory
  for(const g of model.groups){
    const bar = ws.addRow([g.label]);
    ws.mergeCells(bar.number, 1, bar.number, span);
    bar.height = 22;
    bar.getCell(1).font = { bold: true, size: 11, color: { argb: XL_COLORS.groupText } };
    bar.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.groupFill } };
    bar.getCell(1).alignment = { vertical: 'middle', indent: 1 };
    for(const cells of g.rows){
      const row = ws.addRow(cells);
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.border = { top: xlThinBorder(), bottom: xlThinBorder(), left: xlThinBorder(), right: xlThinBorder() };
        cell.font = { size: 11, color: { argb: XL_COLORS.text }, bold: col === 2 };
        cell.alignment = { vertical: 'top', wrapText: true, horizontal: centered.has(col - 1) ? 'center' : 'left' };
      });
    }
  }
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (model.fileName || 'Projects by Status').replace(/[\\/:*?"<>|]/g, '-') + '.xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
