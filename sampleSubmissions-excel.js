// Sample Submissions -> Export Excel. Same flat-row ExcelJS pattern as
// materials-excel.js (own copy of the XL_COLORS/border helpers, see that
// file's own comment on why). Two sheets, not one: a submission's own
// header fields (Submissions) and its samples (Samples, one row per
// sample with a Form No. column pointing back to its own submission) --
// samples are genuinely tabular data (many numeric/decision columns per
// row), not something that reads well squeezed into one cell per
// submission the way Comment/Improvement text summaries do elsewhere.
import { sampleProductName } from './sampleSubmissions-data.js';

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
function addHeaderRow(ws, columns){
  const headerRow = ws.addRow(columns.map(c => c.header));
  headerRow.eachCell(cell => {
    cell.font = { bold: true, size: 11, color: { argb: XL_COLORS.groupText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.groupFill } };
    cell.border = { top: xlThinBorder(), bottom: xlThinBorder(), left: xlThinBorder(), right: xlThinBorder() };
    cell.alignment = { vertical: 'middle' };
  });
}
function styleDataRow(row){
  row.eachCell(cell => {
    cell.font = { size: 11, color: { argb: XL_COLORS.text } };
    cell.alignment = { wrapText: true, vertical: 'top' };
    cell.border = { top: xlThinBorder(), bottom: xlThinBorder(), left: xlThinBorder(), right: xlThinBorder() };
  });
}

const SUBMISSION_COLUMNS = [
  { header: 'Form No.', key: 'formNo', width: 16 },
  { header: 'Doc. Date', key: 'docDate', width: 12 },
  { header: 'Customer', key: 'customer', width: 20 },
  { header: 'Project Lead', key: 'projectLead', width: 18 },
  { header: 'Destination', key: 'destination', width: 16 },
  { header: 'Delivery Location', key: 'deliveryLocation', width: 22 },
  { header: 'Courier', key: 'courier', width: 14 },
  { header: 'Tracking No.', key: 'trackingNo', width: 18 },
  { header: 'Expected Receipt', key: 'expectedReceipt', width: 16 },
  { header: 'Coordinator', key: 'coordinator', width: 16 },
  { header: 'Storage', key: 'shipmentStorage', width: 16 },
  { header: 'Purpose', key: 'purpose', width: 22 },
  { header: 'Present. Date', key: 'presentDate', width: 14 },
  { header: 'Receiver', key: 'receiver', width: 16 },
  { header: 'Handling', key: 'handling', width: 16 },
  { header: 'Status', key: 'status', width: 14 },
  { header: 'Docs Requested', key: 'docs', width: 26 },
  { header: 'Feedback Owner', key: 'feedbackOwner', width: 16 },
  { header: 'Feedback Due', key: 'feedbackDue', width: 14 },
  { header: 'Next Review', key: 'nextReview', width: 14 },
  { header: 'Notes', key: 'notes', width: 26 },
  { header: 'Prepared By', key: 'preparedBy', width: 22 },
  { header: 'Received By', key: 'receivedBy', width: 22 },
  { header: 'Sample Count', key: 'sampleCount', width: 14 }
];

const SAMPLE_COLUMNS = [
  { header: 'Form No.', key: 'formNo', width: 16 },
  { header: 'Sample ID', key: 'sampleId', width: 16 },
  { header: 'Product', key: 'product', width: 26 },
  { header: 'Development Status', key: 'developmentStatus', width: 16 },
  { header: 'Lot No.', key: 'lotNo', width: 14 },
  { header: 'Requested Qty', key: 'requestedQty', width: 14 },
  { header: 'Actual Qty Sent', key: 'actualQtySent', width: 14 },
  { header: 'Net Wt/Bag', key: 'netWtPerBag', width: 14 },
  { header: 'Storage', key: 'storage', width: 14 },
  { header: 'Taste', key: 'taste', width: 10 },
  { header: 'Texture', key: 'texture', width: 10 },
  { header: 'Appearance', key: 'appearance', width: 10 },
  { header: 'Convenience', key: 'convenience', width: 10 },
  { header: 'Decision', key: 'decision', width: 14 },
  { header: 'Feedback', key: 'feedback', width: 26 },
  { header: 'Owner', key: 'owner', width: 16 },
  { header: 'Due Date', key: 'dueDate', width: 14 },
  { header: 'Next Action', key: 'nextAction', width: 22 },
  { header: 'Certification', key: 'certification', width: 16 },
  { header: 'Lead Time', key: 'leadTime', width: 12 },
  { header: 'Currency', key: 'currency', width: 10 },
  { header: 'Customer Comment', key: 'customerComment', width: 26 },
  { header: 'Remarks', key: 'remarks', width: 24 }
];

function docsText(docs){
  if(!docs || typeof docs !== 'object') return '';
  const picked = [];
  if(docs.specification) picked.push('Specification');
  if(docs.quotation) picked.push('Quotation');
  if(docs.taxInvoice){
    const d = docs.taxInvoiceDetails || {};
    const details = [d.carrierName, d.flightNo, d.portOfLoading && d.portOfDestination ? `${d.portOfLoading} -> ${d.portOfDestination}` : ''].filter(Boolean).join(', ');
    picked.push('Tax Invoice' + (details ? ` (${details})` : ''));
  }
  if(docs.other) picked.push('Other' + (docs.otherDetails ? `: ${docs.otherDetails}` : ''));
  return picked.join(', ');
}

function personDateText(name, date){
  return [name, date].filter(Boolean).join(' · ');
}

export async function exportSampleSubmissionsToExcel(submissions){
  if(!window.ExcelJS){
    alert('Excel export isn\'t available right now (ExcelJS failed to load) -- check your connection and try again.');
    return;
  }
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Forge';
  wb.created = new Date();

  const sorted = [...submissions].sort((a,b) => (b.docDate||'').localeCompare(a.docDate||''));

  const wsSub = wb.addWorksheet('Submissions');
  wsSub.columns = SUBMISSION_COLUMNS.map(c => ({ width: c.width }));
  addSectionTitleBar(wsSub, 'Sample Submissions', SUBMISSION_COLUMNS.length);
  addHeaderRow(wsSub, SUBMISSION_COLUMNS);
  sorted.forEach(s => {
    const row = wsSub.addRow([
      s.formNo || '', s.docDate || '', s.customer || '', s.projectLead || '',
      s.destination || '', s.deliveryLocation || '', s.courier || '', s.trackingNo || '',
      s.expectedReceipt || '', s.coordinator || '', s.shipmentStorage || '', s.purpose || '',
      s.presentDate || '', s.receiver || '', s.handling || '', s.status || '',
      docsText(s.docs), s.feedbackOwner || '', s.feedbackDue || '', s.nextReview || '', s.notes || '',
      personDateText(s.preparedByName, s.preparedByDate), personDateText(s.receivedByName, s.receivedByDate),
      (s.samples || []).length
    ]);
    styleDataRow(row);
  });

  const wsSamples = wb.addWorksheet('Samples');
  wsSamples.columns = SAMPLE_COLUMNS.map(c => ({ width: c.width }));
  addSectionTitleBar(wsSamples, 'Samples', SAMPLE_COLUMNS.length);
  addHeaderRow(wsSamples, SAMPLE_COLUMNS);
  sorted.forEach(s => {
    (s.samples || []).forEach(row => {
      const sampleId = row.seq ? `${s.formNo || 'SS-----'}-S${String(row.seq).padStart(2, '0')}` : '';
      const r = wsSamples.addRow([
        s.formNo || '', sampleId, sampleProductName(row),
        row.developmentStatus || '', row.lotNo || '',
        row.requestedQty || '', row.actualQtySent || '', row.netWtPerBag || '', row.storage || '',
        row.taste || '', row.texture || '', row.appearance || '', row.convenience || '',
        row.decision || '', row.feedback || '', row.owner || '', row.dueDate || '', row.nextAction || '',
        row.certification || '', row.leadTime || '', row.currency || '', row.customerComment || '', row.remarks || ''
      ]);
      styleDataRow(r);
    });
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Sample Submissions ${new Date().toISOString().slice(0,10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
