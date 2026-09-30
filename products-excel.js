// Products -> Export Excel. Same flat-row ExcelJS pattern as
// materials-excel.js (see that file's own comment on why this stays its
// own copy of the XL_COLORS/border helpers rather than importing them).

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
  { header: 'No.', key: 'code', width: 10 },
  { header: 'Product Name', key: 'name', width: 26 },
  { header: 'Sample Code', key: 'sampleCode', width: 16 },
  { header: 'Type', key: 'productType', width: 16 },
  { header: 'Product (Idea Menu)', key: 'ideaMenuName', width: 22 },
  { header: 'Description', key: 'description', width: 30 },
  { header: 'Cooking Instruction', key: 'cookingInstruction', width: 30 },
  { header: 'Composition (Approx.)', key: 'composition', width: 30 },
  { header: 'Allergens', key: 'allergens', width: 24 },
  { header: 'Processed Area', key: 'processedArea', width: 18 },
  { header: 'Factory', key: 'factory', width: 20 },
  { header: 'Size', key: 'size', width: 14 },
  { header: 'Standards/Packing Style', key: 'packingStyle', width: 24 },
  { header: 'MOQ', key: 'moq', width: 12 },
  { header: 'EXW Price (THB)', key: 'exwPrice', width: 16 },
  { header: 'Sales Price', key: 'salesPrice', width: 14 },
  { header: 'Remarks', key: 'remarks', width: 26 }
];

// A composition row is {main, sub1, sub2, pct} -- one line per row so
// several stay readable stacked in one cell.
function compositionText(composition){
  if(!Array.isArray(composition) || !composition.length) return '';
  return composition.map(r => {
    const name = [r.main, r.sub1, r.sub2].filter(Boolean).join(' - ');
    return r.pct !== '' && r.pct != null ? `${name} (${r.pct}%)` : name;
  }).join('\n');
}

export async function exportProductsToExcel(productList){
  if(!window.ExcelJS){
    alert('Excel export isn\'t available right now (ExcelJS failed to load) -- check your connection and try again.');
    return;
  }
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Forge';
  wb.created = new Date();
  const ws = wb.addWorksheet('Products');
  ws.columns = COLUMNS.map(c => ({ width: c.width }));
  addSectionTitleBar(ws, 'Product List', COLUMNS.length);

  const headerRow = ws.addRow(COLUMNS.map(c => c.header));
  headerRow.eachCell(cell => {
    cell.font = { bold: true, size: 11, color: { argb: XL_COLORS.groupText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.groupFill } };
    cell.border = { top: xlThinBorder(), bottom: xlThinBorder(), left: xlThinBorder(), right: xlThinBorder() };
    cell.alignment = { vertical: 'middle' };
  });

  const sorted = [...productList].sort((a,b) => (a.code||'').localeCompare(b.code||'', undefined, { numeric: true }));
  sorted.forEach(p => {
    const row = ws.addRow([
      p.code || '',
      p.name || '',
      p.sampleCode || '',
      p.productType || '',
      p.ideaMenuName || '',
      p.description || '',
      p.cookingInstruction || '',
      compositionText(p.composition),
      p.allergens || '',
      p.processedArea || '',
      p.factory || '',
      p.size || '',
      p.packingStyle || '',
      p.moq || '',
      (p.exwPrice !== '' && p.exwPrice != null) ? Number(p.exwPrice) : '',
      p.salesPrice || '',
      p.remarks || ''
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
  a.download = `Product List ${new Date().toISOString().slice(0,10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
