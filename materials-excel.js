// Ingredient Library -> Export Excel. Same ExcelJS/XL_COLORS/xlThinBorder
// pattern as trials-summary.js's own Excel export (kept as its own copy
// here rather than imported, same reasoning as that file's own comment on
// this) -- one flat row per ingredient, since this data (unlike Test
// Results' per-product verdicts) has no nested per-evaluator structure to
// lay out with rich text.
import { formatMoq } from './app.js';

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
  { header: 'English Name', key: 'nameEn', width: 26 },
  { header: 'Thai Name', key: 'nameTh', width: 22 },
  { header: 'Brand', key: 'brand', width: 16 },
  { header: 'Vendor Code', key: 'vendorCode', width: 14 },
  { header: 'Vendor Name', key: 'vendorName', width: 20 },
  { header: 'Manufacturer', key: 'manufacturer', width: 20 },
  { header: 'Price/kg (THB)', key: 'price', width: 14 },
  { header: 'MOQ', key: 'moq', width: 12 },
  { header: 'E-Number', key: 'insNumber', width: 12 },
  { header: 'Allergens', key: 'allergens', width: 26 },
  { header: 'Factories', key: 'factories', width: 26 },
  { header: 'Sub Ingredients', key: 'subIngredients', width: 30 },
  { header: 'Usage Notes', key: 'usageNotes', width: 30 }
];

// A sub-ingredient row is {type, size, sizeUnit, cooking, yieldPct} -- one
// line per row so several stay readable stacked in one cell.
function subIngredientsText(subIngredients){
  if(!Array.isArray(subIngredients) || !subIngredients.length) return '';
  return subIngredients.map(si => {
    const parts = [si.type, [si.size, si.sizeUnit].filter(Boolean).join(''), si.cooking, si.yieldPct ? `${si.yieldPct}% yield` : ''].filter(Boolean);
    return parts.join(' · ');
  }).join('\n');
}

export async function exportMaterialsToExcel(ingredientMaster){
  if(!window.ExcelJS){
    alert('Excel export isn\'t available right now (ExcelJS failed to load) -- check your connection and try again.');
    return;
  }
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Forge';
  wb.created = new Date();
  const ws = wb.addWorksheet('Ingredients');
  ws.columns = COLUMNS.map(c => ({ width: c.width }));
  addSectionTitleBar(ws, 'Ingredient Library', COLUMNS.length);

  const headerRow = ws.addRow(COLUMNS.map(c => c.header));
  headerRow.eachCell(cell => {
    cell.font = { bold: true, size: 11, color: { argb: XL_COLORS.groupText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.groupFill } };
    cell.border = { top: xlThinBorder(), bottom: xlThinBorder(), left: xlThinBorder(), right: xlThinBorder() };
    cell.alignment = { vertical: 'middle' };
  });

  const sorted = [...ingredientMaster].sort((a,b) => (a.nameEn||'').localeCompare(b.nameEn||''));
  sorted.forEach(m => {
    const row = ws.addRow([
      m.nameEn || '',
      m.nameTh || '',
      m.brand || '',
      m.vendorCode || '',
      m.vendorName || '',
      m.manufacturer || '',
      (m.price !== '' && m.price != null) ? Number(m.price) : '',
      formatMoq(m.moq) || '',
      m.insNumber || '',
      m.allergens || '',
      (m.factories || []).join(', '),
      subIngredientsText(m.subIngredients),
      m.usageNotes || ''
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
  a.download = `Ingredient Library ${new Date().toISOString().slice(0,10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
