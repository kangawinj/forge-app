// Export one Test Result (a single trial) to Excel, laid out like the page itself: Part 1, Part 2, the
// Products Being Compared cards (with their photos) as columns, the Sensory Evaluation table (Comment +
// Improvement Guidelines per criteria, a Note column, Test Result row), the evaluators' Comments (with
// photos) and the test Note. Split out of trials-summary.js (which keeps the Summary Table export).
import { escapeHtml, formatDateLong, projects, recipes, fullCode, recipeDisplayLabel, formatWeight, allIngredientsInRecipe, findProjectForRecipe } from './app.js';
import {
  migrateTrial, getEvaluationCriteria, getCriteriaNotes, trialEvalTargets, getTrialProductData,
  normalizeTrialPhotos, sensoryFieldValue, improvementFieldValue, combinedVerdict,
  TRIAL_TEST_RESULT_OPTIONS, shortEvaluatorName, summarizeTrialProduct
} from './trials-data.js';
// Circular import back to core trials.js -- safe, only read inside the export functions.
import { trials } from './trials.js';

const argb = hex => 'FF' + hex.replace('#', '').toUpperCase();
const C = {
  headerFill: argb('#16294a'), headerText: argb('#ffffff'),
  groupFill: argb('#e8ecf5'), groupText: argb('#0c1830'),
  border: argb('#dfe3ea'), dim: argb('#6b7280'), text: argb('#1c2333'),
  ok: argb('#2e8b3d'), accent: argb('#ef7f24'), danger: argb('#c0392b'), card: argb('#f4f6fa')
};
const thin = () => ({ style: 'thin', color: { argb: C.border } });
const box = () => ({ top: thin(), bottom: thin(), left: thin(), right: thin() });
const fillOf = color => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: color } });

const PHOTO_W = 150, PHOTO_H = 110; // on-sheet size in px (a photo is scaled to fit this box)

// Loads a photo data URL, scales it to fit the box and re-encodes it as JPEG (so any source type --
// webp included -- works in the workbook and the file stays small). Resolves null when it can't load.
function prepareImage(dataUrl){
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || PHOTO_W, h = img.naturalHeight || PHOTO_H;
      const k = Math.min(PHOTO_W / w, PHOTO_H / h, 1);
      const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
      const canvas = document.createElement('canvas');
      canvas.width = dw * 2; canvas.height = dh * 2;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({ base64: canvas.toDataURL('image/jpeg', 0.85), width: dw, height: dh });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Square, centre-cropped (object-fit: cover) with rounded corners -- the same look as the project photo in the Test
// Summary window. Resolves null when the image can't load.
function prepareSquareImage(dataUrl, size){
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || size, h = img.naturalHeight || size;
      const s = Math.min(w, h);
      const px = size * 3;
      const canvas = document.createElement('canvas');
      canvas.width = px; canvas.height = px;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, px, px);
      const r = Math.round(px * 10 / 48);
      ctx.beginPath();
      ctx.moveTo(r, 0); ctx.arcTo(px, 0, px, px, r); ctx.arcTo(px, px, 0, px, r); ctx.arcTo(0, px, 0, 0, r); ctx.arcTo(0, 0, px, 0, r);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, px, px);
      resolve({ base64: canvas.toDataURL('image/jpeg', 0.9), width: size, height: size });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Builds one Test Result worksheet for trial `t` inside workbook `wb`.
async function buildTrialSheet(wb, t, sheetName){
  const mt = migrateTrial(t);
  const linkedProject = mt.linkedProjectId ? projects.find(p => p.id === mt.linkedProjectId) : null;
  const criteria = getEvaluationCriteria(mt);
  const targets = trialEvalTargets(mt);
  const n = Math.max(1, targets.length);
  const lastCol = 2 + n + 1; // A criteria, B row type, one column per product, then Note
  const PROD_W = 34;

  const ws = wb.addWorksheet(sheetName);
  ws.columns = [{ width: 24 }, { width: 22 }, ...Array.from({ length: n }, () => ({ width: PROD_W })), { width: PROD_W }];
  const colWidth = c => (ws.getColumn(c).width || 10);
  // Rows whose cells are not merged (product columns, sensory table, Test Result) get no explicit height, so Excel
  // fits them to their content itself; only merged-value rows and photo rows are sized here.
  const linesFor = (text, width) => String(text || '').split('\n').reduce((s, p) => s + Math.max(1, Math.ceil(p.length / Math.max(8, width * 1.05))), 0);

  // Pin a photo inside its cell: both corners are given as EMU offsets from the cell's own top-left
  // (nativeColOff / nativeRowOff, 9525 EMU per px), so the picture is centered, keeps its aspect ratio
  // and can never spill out of the cell whatever the display scaling.
  const placeImage = (rowNumber, rowHeightPt, col0, img) => {
    const EMU = 9525;
    const colPx = Math.round((ws.getColumn(col0 + 1).width || PROD_W) * 7 + 5);
    const rowPx = rowHeightPt / 0.75;
    const w = Math.min(img.width, colPx - 6), h = Math.min(img.height, rowPx - 6);
    const x0 = Math.max(2, Math.floor((colPx - w) / 2)), y0 = Math.max(2, Math.floor((rowPx - h) / 2));
    const id = wb.addImage({ base64: img.base64, extension: 'jpeg' });
    ws.addImage(id, {
      tl: { nativeCol: col0, nativeColOff: x0 * EMU, nativeRow: rowNumber - 1, nativeRowOff: y0 * EMU },
      br: { nativeCol: col0, nativeColOff: Math.floor(x0 + w) * EMU, nativeRow: rowNumber - 1, nativeRowOff: Math.floor(y0 + h) * EMU },
      editAs: 'oneCell'
    });
  };

  const dateText = mt.testDate ? formatDateLong(mt.testDate) : 'No test date';
  ws.mergeCells(1, 1, 1, lastCol);
  const title = ws.getCell(1, 1);
  title.value = `Test Result — ${linkedProject?.name || 'Untitled test'} — ${dateText}`;
  title.font = { bold: true, size: 13, color: { argb: C.headerText } };
  title.fill = fillOf(C.headerFill);
  title.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 26;

  const section = text => {
    const row = ws.addRow([text]);
    ws.mergeCells(row.number, 1, row.number, lastCol);
    const cell = row.getCell(1);
    cell.font = { bold: true, size: 11, color: { argb: C.groupText } };
    cell.fill = fillOf(C.groupFill);
    cell.border = box();
    cell.alignment = { vertical: 'middle', indent: 1 };
    row.height = 22;
  };
  const gap = () => { ws.addRow([]).height = 8; };
  // label in A:B, one wide value across the product columns + Note column
  const kv = (label, value, opts = {}) => {
    const text = value == null || String(value) === '' ? '-' : String(value);
    const row = ws.addRow([label]);
    ws.mergeCells(row.number, 1, row.number, 2);
    ws.mergeCells(row.number, 3, row.number, lastCol);
    row.getCell(1).font = { bold: true, size: 11, color: { argb: C.text } };
    row.getCell(3).value = text;
    row.getCell(3).font = { size: 11, bold: !!opts.bold, color: { argb: opts.color || C.text } };
    for(let c = 1; c <= lastCol; c++){
      row.getCell(c).border = box();
      row.getCell(c).alignment = { wrapText: true, vertical: 'top' };
    }
    const width = Array.from({ length: lastCol - 2 }, (_, i) => colWidth(i + 3)).reduce((a, b) => a + b, 0);
    row.height = Math.max(20, linesFor(text, width) * 15 + 4);
  };

  // ---------- Part 1 ----------
  section('Part 1');
  kv('Project Name', linkedProject?.name);
  kv('Customer', linkedProject?.customerName);
  kv('Destination', linkedProject?.destinationCountry);
  kv('Project Owner', linkedProject?.ownerSalesRep);
  kv('Responsible Person (PD)', linkedProject?.responsiblePerson);
  kv('Factory', linkedProject?.factoryName);
  kv('Sample Prepared By', mt.samplePreparedBy);
  kv('Test Date', mt.testDate ? dateText : '');
  kv('Test Location', mt.testLocation);
  const people = (mt.testParticipants || []).filter(s => (s || '').trim() !== '');
  kv('Test Participants', people.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  gap();

  // ---------- Part 2 ----------
  section('Part 2');
  kv('Cooking Method', mt.cookingMethod);
  const cookSteps = (mt.cookingMethodSteps || []).filter(s => (s || '').trim() !== '');
  kv('Steps', cookSteps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  gap();

  if(!targets.length){
    section('Products Being Compared');
    kv('Products', 'No products added yet');
  } else {
    // ---------- Products Being Compared (the cards, one column per product) ----------
    section('Products Being Compared');
    const info = targets.map(p => {
      const r = recipes.find(x => x.id === p.id);
      const mp = (mt.manualProducts || []).find(x => x.id === p.id);
      if(r){
        const link = findProjectForRecipe(r.id);
        return {
          Code: fullCode(r) || '-',
          Date: r.date || '-',
          'Total weight': formatWeight(allIngredientsInRecipe(r).reduce((s, i) => s + (parseFloat(i.weight) || 0), 0)),
          Customer: link?.project.customerName || '',
          Destination: link?.project.destinationCountry || '',
          'Project Owner': link?.project.ownerSalesRep || '',
          Stage: link?.product.stage || ''
        };
      }
      return { Code: mp?.code || '' };
    });

    const headRow = ws.addRow(['Product']);
    ws.mergeCells(headRow.number, 1, headRow.number, 2);
    headRow.getCell(1).font = { bold: true, size: 11, color: { argb: C.headerText } };
    targets.forEach((p, i) => {
      const cell = headRow.getCell(3 + i);
      cell.value = p.code ? `${p.name}\n${p.code}` : p.name;
      cell.font = { bold: true, size: 11, color: { argb: C.headerText } };
    });
    headRow.getCell(lastCol).value = '';
    for(let c = 1; c <= lastCol; c++){
      headRow.getCell(c).fill = fillOf(C.headerFill);
      headRow.getCell(c).border = box();
      headRow.getCell(c).alignment = { wrapText: true, vertical: 'middle', indent: c === 1 ? 1 : 0 };
    }

    ['Code', 'Date', 'Total weight', 'Customer', 'Destination', 'Project Owner', 'Stage'].forEach(field => {
      if(!info.some(x => x[field])) return;
      const row = ws.addRow([field]);
      ws.mergeCells(row.number, 1, row.number, 2);
      row.getCell(1).font = { bold: true, size: 11, color: { argb: C.text } };
      info.forEach((x, i) => { row.getCell(3 + i).value = x[field] || '-'; });
      for(let c = 1; c <= lastCol; c++){
        row.getCell(c).border = box();
        row.getCell(c).fill = fillOf(C.card);
        row.getCell(c).alignment = { wrapText: true, vertical: 'top' };
        if(c > 2) row.getCell(c).font = { size: 11, color: { argb: C.text } };
      }
    });

    // photos: one row per photo slot, each product's photo in its own column (+ a caption row)
    const photoLists = targets.map(p => normalizeTrialPhotos(getTrialProductData(mt, p.id)).filter(ph => ph && ph.dataUrl));
    const slots = Math.max(0, ...photoLists.map(l => l.length));
    for(let k = 0; k < slots; k++){
      const row = ws.addRow([k === 0 ? 'Photos' : '']);
      ws.mergeCells(row.number, 1, row.number, 2);
      row.getCell(1).font = { bold: true, size: 11, color: { argb: C.text } };
      row.getCell(1).alignment = { vertical: 'top' };
      let tallest = 0;
      const placed = [];
      for(let i = 0; i < targets.length; i++){
        const ph = photoLists[i][k];
        if(!ph) continue;
        const img = await prepareImage(ph.dataUrl);
        if(!img) continue;
        placed.push({ col0: 2 + i, img });
        tallest = Math.max(tallest, img.height);
      }
      for(let c = 1; c <= lastCol; c++){ row.getCell(c).border = box(); row.getCell(c).fill = fillOf(C.card); }
      row.height = Math.max(20, (tallest + 12) * 0.75);
      placed.forEach(x => placeImage(row.number, row.height, x.col0, x.img));
      const captions = targets.map((p, i) => (photoLists[i][k]?.caption || '').trim());
      if(captions.some(Boolean)){
        const cap = ws.addRow(['']);
        ws.mergeCells(cap.number, 1, cap.number, 2);
        captions.forEach((txt, i) => { cap.getCell(3 + i).value = txt; });
        for(let c = 1; c <= lastCol; c++){
          cap.getCell(c).border = box();
          cap.getCell(c).fill = fillOf(C.card);
          cap.getCell(c).font = { italic: true, size: 10, color: { argb: C.dim } };
          cap.getCell(c).alignment = { wrapText: true, vertical: 'top' };
        }
      }
    }
    gap();

    // ---------- Sensory Evaluation ----------
    section('Sensory Evaluation');
    const th = ws.addRow(['Criteria']);
    ws.mergeCells(th.number, 1, th.number, 2);
    targets.forEach((p, i) => { th.getCell(3 + i).value = p.code ? `${p.name}\n${p.code}` : p.name; });
    th.getCell(lastCol).value = 'Note';
    for(let c = 1; c <= lastCol; c++){
      const cell = th.getCell(c);
      cell.font = { bold: true, size: 11, color: { argb: C.groupText } };
      cell.fill = fillOf(C.groupFill);
      cell.border = box();
      cell.alignment = { wrapText: true, vertical: 'middle', indent: c === 1 ? 1 : 0 };
    }

    const sensoryNotes = getCriteriaNotes(mt, 'criteriaNotes');
    const improveNotes = getCriteriaNotes(mt, 'criteriaImproveNotes');
    const fillCells = (row, values, note) => {
      values.forEach((v, i) => { row.getCell(3 + i).value = v || '-'; });
      row.getCell(lastCol).value = note || '-';
      for(let c = 3; c <= lastCol; c++){
        row.getCell(c).font = { size: 11, color: { argb: C.text } };
        row.getCell(c).alignment = { wrapText: true, vertical: 'top' };
      }
      for(let c = 1; c <= lastCol; c++) row.getCell(c).border = box();
    };
    criteria.forEach(cr => {
      const r1 = ws.addRow([cr.label, 'Comment']);
      const r2 = ws.addRow(['', 'Improvement Guidelines']);
      ws.mergeCells(r1.number, 1, r2.number, 1);
      r1.getCell(1).font = { bold: true, size: 11, color: { argb: C.text } };
      r1.getCell(1).alignment = { wrapText: true, vertical: 'top' };
      [r1, r2].forEach(r => { r.getCell(2).font = { bold: true, size: 10, color: { argb: C.dim } }; r.getCell(2).alignment = { wrapText: true, vertical: 'top' }; });
      fillCells(r1, targets.map(p => sensoryFieldValue(getTrialProductData(mt, p.id), cr.id)), sensoryNotes[cr.id]);
      fillCells(r2, targets.map(p => improvementFieldValue(getTrialProductData(mt, p.id), cr.id)), improveNotes[cr.id]);
      r1.getCell(1).border = box();
    });

    // Test Result: the three choices with the combined verdict marked, + the reference-sample flag
    const tr = ws.addRow(['Test Result']);
    ws.mergeCells(tr.number, 1, tr.number, 2);
    tr.getCell(1).font = { bold: true, size: 11, color: { argb: C.text } };
    tr.getCell(1).alignment = { vertical: 'top' };
    targets.forEach((p, i) => {
      const pd = getTrialProductData(mt, p.id);
      const verdict = combinedVerdict(pd);
      const runs = [];
      TRIAL_TEST_RESULT_OPTIONS.forEach((o, oi) => {
        const on = verdict === o;
        const color = o === 'Accepted' ? C.ok : o === 'Not accepted' ? C.danger : C.accent;
        runs.push({ text: `${on ? '●' : '○'} ${o}${oi < TRIAL_TEST_RESULT_OPTIONS.length - 1 || pd.referenceSample ? '\n' : ''}`, font: { size: 11, bold: on, color: { argb: on ? color : C.dim } } });
      });
      if(pd.referenceSample) runs.push({ text: '★ Kept as reference sample', font: { size: 11, bold: true, color: { argb: C.groupText } } });
      tr.getCell(3 + i).value = { richText: runs };
      tr.getCell(3 + i).alignment = { wrapText: true, vertical: 'top' };
    });
    for(let c = 1; c <= lastCol; c++) tr.getCell(c).border = box();

    // ---------- evaluators' Comments (+ photos) ----------
    const comments = (t.evaluatorComments && typeof t.evaluatorComments === 'object') ? t.evaluatorComments : {};
    const photosByEmail = (t.evaluatorPhotos && typeof t.evaluatorPhotos === 'object') ? t.evaluatorPhotos : {};
    const emails = [...new Set([...Object.keys(comments), ...Object.keys(photosByEmail)])]
      .filter(email => (comments[email] || '').trim() || (photosByEmail[email] || []).length);
    if(emails.length){
      gap();
      section('Comments');
      for(const email of emails){
        kv(shortEvaluatorName(email), (comments[email] || '').trim() || '-');
        const photos = (photosByEmail[email] || []).filter(ph => ph && ph.dataUrl);
        for(let s = 0; s < photos.length; s += (n + 1)){
          const row = ws.addRow(['']);
          ws.mergeCells(row.number, 1, row.number, 2);
          let tallest = 0;
          const placed = [];
          const chunk = photos.slice(s, s + n + 1);
          for(let j = 0; j < chunk.length; j++){
            const img = await prepareImage(chunk[j].dataUrl);
            if(!img) continue;
            placed.push({ col0: 2 + j, img });
            tallest = Math.max(tallest, img.height);
          }
          for(let c = 1; c <= lastCol; c++) row.getCell(c).border = box();
          row.height = Math.max(20, (tallest + 12) * 0.75);
          placed.forEach(x => placeImage(row.number, row.height, x.col0, x.img));
        }
      }
    }
  }

  gap();
  kv('Note', (mt.note || '').trim());
}

function newWorkbook(){
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Forge';
  wb.created = new Date();
  return wb;
}
function excelReady(){
  if(window.ExcelJS) return true;
  alert('Excel export isn\'t available right now (ExcelJS failed to load) -- check your connection and try again.');
  return false;
}
async function downloadWorkbook(wb, fileName){
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/[\\/:*?"<>|]/g, '-') + '.xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function exportTrialToExcel(t){
  if(!excelReady()) return;
  const mt = migrateTrial(t);
  const linkedProject = mt.linkedProjectId ? projects.find(p => p.id === mt.linkedProjectId) : null;
  const wb = newWorkbook();
  await buildTrialSheet(wb, t, 'Test Result');
  await downloadWorkbook(wb, [`Test Result - ${linkedProject?.name || 'Untitled test'}`, mt.testDate || ''].filter(Boolean).join(' '));
}

// Every test of one project in a single file: one sheet per test, the most recent Tested date first
// (leftmost tab), tests with no date last.
export async function exportProjectTrialsToExcel(projectId){
  if(!excelReady()) return;
  const project = projects.find(p => p.id === projectId);
  const list = trials.filter(t => t.linkedProjectId === projectId)
    .sort((a, b) => (a.testDate ? 0 : 1) - (b.testDate ? 0 : 1) || (b.testDate || '').localeCompare(a.testDate || '') || ((b.updatedAt || 0) - (a.updatedAt || 0)));
  if(!list.length){ alert('This project has no tests yet.'); return; }
  const wb = newWorkbook();
  const used = new Set();
  for(const t of list){
    const base = (t.testDate ? formatDateLong(t.testDate) : 'No test date').replace(/[\[\]:*?\/\\]/g, '-').slice(0, 26);
    let name = base, k = 2;
    while(used.has(name.toLowerCase())) name = `${base} (${k++})`;
    used.add(name.toLowerCase());
    await buildTrialSheet(wb, t, name);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  await downloadWorkbook(wb, `Test Results - ${project?.name || 'Project'} ${stamp}`);
}

// The Test Summary window as a sheet: test details, then one block per product (verdict, details, comments,
// suggested improvements) and the test note -- the same content as the window itself.
export async function exportTrialSummaryToExcel(t){
  if(!excelReady()) return;
  const mt = migrateTrial(t);
  const linkedProject = mt.linkedProjectId ? projects.find(p => p.id === mt.linkedProjectId) : null;
  const criteria = getEvaluationCriteria(mt);
  const wb = newWorkbook();
  const ws = wb.addWorksheet('Test Summary');
  ws.columns = [{ width: 26 }, { width: 80 }, { width: 24 }];
  const wrap = { vertical: 'top', wrapText: true };

  ws.mergeCells(1, 1, 1, 3);
  const title = ws.getCell(1, 1);
  title.value = `Test Summary — ${linkedProject?.name || 'Untitled test'}${mt.testDate ? ' — ' + formatDateLong(mt.testDate) : ''}`;
  title.font = { bold: true, size: 13, color: { argb: C.headerText } };
  title.fill = fillOf(C.headerFill);
  title.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 26;

  // the detail rows get explicit heights so the project photo beside them can be anchored to exact row boundaries
  const kvRowPx = [];
  const kv = (label, value) => {
    if(!String(value || '').trim()) return;
    const row = ws.addRow([label, value]);
    const lines = String(value).split('\n').reduce((s, p) => s + Math.max(1, Math.ceil(p.length / 95)), 0);
    row.height = Math.max(21, lines * 16 + 5);
    kvRowPx.push(row.height / 0.75);
    ws.mergeCells(row.number, 2, row.number, 3);
    row.getCell(1).font = { bold: true, color: { argb: C.dim } };
    row.getCell(1).fill = fillOf(C.card);
    row.getCell(1).alignment = wrap;
    row.getCell(2).alignment = wrap;
    row.getCell(1).border = box(); row.getCell(2).border = box(); row.getCell(3).border = box();
  };
  kv('Project', linkedProject?.name || '');
  kv('Customer / Destination', [linkedProject?.customerName, linkedProject?.destinationCountry].filter(Boolean).join(' · '));
  kv('Tested date', mt.testDate ? formatDateLong(mt.testDate) : '');
  kv('PD / Responsible person', linkedProject?.responsiblePerson || '');
  kv('Test location', mt.testLocation || '');
  kv('Sample prepared by', mt.samplePreparedBy || '');
  kv('Test participants', (mt.testParticipants || []).map(s => String(s || '').trim()).filter(Boolean).join(', '));
  kv('Cooking method', mt.cookingMethod || '');

  // project photo, top right, beside the details
  const photo = linkedProject?.image ? await prepareSquareImage(linkedProject.image, 84) : null;
  if(photo){
    // photo is scaled to at most 84px tall; its bottom-right corner is expressed as (row, offset in that row) by walking
    // the detail rows' own heights, so it fills exactly that span without being squeezed into one row
    const EMU = 9525;
    const k = Math.min(1, 84 / photo.height);
    const w = Math.round(photo.width * k), h = Math.round(photo.height * k);
    const id = wb.addImage({ base64: photo.base64, extension: 'jpeg' });
    let remaining = 3 + h, rowIdx = 0;
    while(remaining > (kvRowPx[rowIdx] || 20)){ remaining -= (kvRowPx[rowIdx] || 20); rowIdx++; }
    ws.addImage(id, {
      tl: { nativeCol: 2, nativeColOff: 3 * EMU, nativeRow: 1, nativeRowOff: 3 * EMU },
      br: { nativeCol: 2, nativeColOff: (3 + w) * EMU, nativeRow: 1 + rowIdx, nativeRowOff: Math.round(remaining) * EMU },
      editAs: 'oneCell'
    });
  }

  const section = text => {
    const row = ws.addRow([text]);
    ws.mergeCells(row.number, 1, row.number, 3);
    const cell = row.getCell(1);
    cell.font = { bold: true, size: 11, color: { argb: C.groupText } };
    cell.fill = fillOf(C.groupFill);
    cell.border = box();
    cell.alignment = { vertical: 'middle', indent: 1 };
    row.height = 22;
  };
  const line = (label, text, note) => {
    const row = ws.addRow([label, note ? `${text}  — ${note}` : text]);
    ws.mergeCells(row.number, 2, row.number, 3);
    row.getCell(1).font = { bold: true, color: { argb: C.text } };
    row.getCell(1).alignment = wrap;
    row.getCell(2).alignment = wrap;
    row.getCell(1).border = box(); row.getCell(2).border = box(); row.getCell(3).border = box();
  };

  ws.addRow([]);
  const targets = trialEvalTargets(mt);
  if(!targets.length) ws.addRow(['No products in this test yet']);
  for(const p of targets){
    const { label, verdict, comments, improvements, reference } = summarizeTrialProduct(mt, criteria, p);
    section(`${label}${reference ? '  (Reference sample)' : ''}`);
    const vRow = ws.addRow(['Verdict', verdict || 'Not yet evaluated']);
    ws.mergeCells(vRow.number, 2, vRow.number, 3);
    vRow.getCell(1).font = { bold: true, color: { argb: C.text } };
    vRow.getCell(2).font = { bold: true, color: { argb: !verdict ? C.dim : /not/i.test(verdict) ? C.danger : /revis/i.test(verdict) ? C.accent : C.ok } };
    [1, 2, 3].forEach(c => { vRow.getCell(c).border = box(); });
    const r = recipes.find(x => x.id === p.id);
    const details = r
      ? [`Code ${fullCode(r) || '-'}`, r.date ? `Date ${r.date}` : '', (() => { const w = allIngredientsInRecipe(r).reduce((s, i) => s + (parseFloat(i.weight) || 0), 0); return w ? `Total weight ${formatWeight(w)}` : ''; })(), findProjectForRecipe(r.id)?.product?.stage ? `Stage ${findProjectForRecipe(r.id).product.stage}` : ''].filter(Boolean).join(' · ')
      : (p.code ? `Code ${p.code}` : '');
    if(details) line('Product details', details);
    comments.forEach((x, i) => line(i === 0 ? 'Comments' : '', `${x.label}: ${x.text}`, x.note));
    if(improvements.length) improvements.forEach((x, i) => line(i === 0 ? 'Suggested improvements' : '', `${x.label}: ${x.suggestion}`, x.note));
    else if(verdict) line('Suggested improvements', 'No Improvement Guidelines suggested');
    ws.addRow([]);
  }
  if((mt.note || '').trim()){ section('Note'); line('', mt.note.trim()); }

  await downloadWorkbook(wb, [`Test Summary - ${linkedProject?.name || 'Untitled test'}`, mt.testDate || ''].filter(Boolean).join(' '));
}
