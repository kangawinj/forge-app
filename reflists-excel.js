// Reference Lists -> Export Excel. Same flat-row ExcelJS pattern as
// materials-excel.js (own copy of the XL_COLORS/border helpers, see that
// file's own comment on why). One worksheet per list, since each of the 8
// lists has its own distinct shape (Company Directory's Locations, Cooking
// Method's Steps/Note, Evaluation Criteria's Sub-items, Contact
// Directory's own contact fields, ...) -- Trial Code Format and Food
// Allergens are static reference pages, not stored lists, so they're not
// included.
import { metaItemName, formatActivityDateTime } from './app.js';

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
function activityText(item){
  const parts = [];
  if(item.createdBy) parts.push(`Added by ${item.createdBy}${item.createdAt ? ' · ' + formatActivityDateTime(item.createdAt) : ''}`);
  if(item.updatedBy && item.updatedAt !== item.createdAt) parts.push(`Edited by ${item.updatedBy}${item.updatedAt ? ' · ' + formatActivityDateTime(item.updatedAt) : ''}`);
  return parts.join('\n');
}

// Each sheet: { title, key, columns: [{header,width}], row(item) => [...] }
// -- `columns` always ends with Added/Edited, appended automatically.
const SHEETS = [
  {
    title: 'Company Directory', key: 'customers',
    columns: [{ header: 'Name', width: 26 }, { header: 'Country', width: 16 }, { header: 'Locations', width: 30 }],
    row: item => [metaItemName(item), item.country || '', (item.locations || []).join(', ')]
  },
  {
    title: 'Contact Directory', key: 'salesReps',
    columns: [
      { header: 'Name', width: 22 }, { header: 'Contact Type', width: 16 }, { header: 'Company', width: 20 },
      { header: 'Country', width: 16 }, { header: 'Job Title', width: 18 }, { header: 'Department', width: 16 },
      { header: 'Email', width: 22 }, { header: 'Phone', width: 16 }
    ],
    row: item => [metaItemName(item), item.contactType || '', item.company || '', item.country || '', item.jobTitle || '', item.department || '', item.email || '', item.phone || '']
  },
  {
    title: 'Destination Countries', key: 'destinationCountries',
    columns: [{ header: 'Country', width: 26 }],
    row: item => [metaItemName(item)]
  },
  {
    title: 'Product Types', key: 'productTypes',
    columns: [{ header: 'Name', width: 24 }, { header: 'Code', width: 12 }],
    row: item => [metaItemName(item), item.code || '']
  },
  {
    title: 'Units', key: 'units',
    columns: [{ header: 'Unit', width: 16 }],
    row: item => [metaItemName(item)]
  },
  {
    title: 'Cooking Method', key: 'cookingMethods',
    columns: [{ header: 'Method', width: 22 }, { header: 'Steps', width: 34 }, { header: 'Note', width: 26 }],
    row: item => [metaItemName(item), (item.steps || []).map((s,i) => `${i+1}. ${s}`).join('\n'), item.note || '']
  },
  {
    title: 'Storage Condition', key: 'storageConditions',
    columns: [{ header: 'Condition', width: 30 }],
    row: item => [metaItemName(item)]
  },
  {
    title: 'Evaluation Criteria', key: 'evaluationCriteria',
    columns: [{ header: 'Criteria', width: 22 }, { header: 'Sub-items', width: 30 }],
    row: item => [metaItemName(item), (item.subs || []).join(', ')]
  }
];

export async function exportRefListsToExcel(metaLists){
  if(!window.ExcelJS){
    alert('Excel export isn\'t available right now (ExcelJS failed to load) -- check your connection and try again.');
    return;
  }
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Forge';
  wb.created = new Date();

  SHEETS.forEach(sheet => {
    const ws = wb.addWorksheet(sheet.title);
    const columns = [...sheet.columns, { header: 'Added / Edited', width: 34 }];
    ws.columns = columns.map(c => ({ width: c.width }));
    addSectionTitleBar(ws, sheet.title, columns.length);
    const headerRow = ws.addRow(columns.map(c => c.header));
    headerRow.eachCell(cell => {
      cell.font = { bold: true, size: 11, color: { argb: XL_COLORS.groupText } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.groupFill } };
      cell.border = { top: xlThinBorder(), bottom: xlThinBorder(), left: xlThinBorder(), right: xlThinBorder() };
      cell.alignment = { vertical: 'middle' };
    });
    const items = [...(metaLists[sheet.key] || [])].sort((a,b) => metaItemName(a).localeCompare(metaItemName(b)));
    items.forEach(item => {
      const row = ws.addRow([...sheet.row(item), activityText(item)]);
      row.eachCell(cell => {
        cell.font = { size: 11, color: { argb: XL_COLORS.text } };
        cell.alignment = { wrapText: true, vertical: 'top' };
        cell.border = { top: xlThinBorder(), bottom: xlThinBorder(), left: xlThinBorder(), right: xlThinBorder() };
      });
    });
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Reference Lists ${new Date().toISOString().slice(0,10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
