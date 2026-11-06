// Excel sheets attached to a Sample Evaluation (trial): import an .xlsx, see it as a table right in the card, and
// export it again as an Excel file. The sheets are stored as plain text cells (t.excelFiles) -- pictures, charts and
// formulas in the original are not kept, only what each cell shows, plus bold / fill colour / merged cells.
// Firestore refuses arrays inside arrays, so a row is { c: [cell texts] } and a merge is { r1, c1, r2, c2 }.
// Pictures are kept too, shrunk to a small JPEG each so they fit inside the evaluation (see shrinkImage).
import { currentUser, uid, escapeHtml, icon, formatActivityDateTime } from './app.js';
import { scheduleTrialSave } from './trials-data.js';

const MAX_ROWS = 500;
const MAX_COLS = 40;
const MAX_FILE_JSON = 600000;   // one imported file, as stored (pictures included)
const MAX_IMAGES = 30;          // pictures kept per file
const MAX_TRIAL_JSON = 950000;  // Firestore's limit is 1 MB per document

const activeSheet = new Map();  // fileId -> index of the sheet tab being looked at

function colLetter(n){
  let s = '';
  for(; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

// Picture bytes -> a smaller JPEG data URL (transparent areas become white). Null if the browser cannot read the format.
async function shrinkImage(buffer, ext, maxSide, quality){
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }[String(ext).toLowerCase()];
  if(!mime) return null;
  const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
  try{
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  }catch(e){
    return null;
  }finally{
    URL.revokeObjectURL(url);
  }
}
// pixel size a picture had in the sheet: its own size, or the cells between its two corners
function pictureSize(ws, range){
  if(range.ext && range.ext.width) return [range.ext.width, range.ext.height];
  const tl = range.tl, br = range.br;
  if(!tl || !br) return [200, 150];
  const colPx = c => ((ws.getColumn(c + 1).width || 8.43) * 7 + 5);
  const rowPx = r => ((ws.getRow(r + 1).height || 15) * 4 / 3);
  let w = -(tl.nativeColOff || 0) / 9525 + (br.nativeColOff || 0) / 9525, h = -(tl.nativeRowOff || 0) / 9525 + (br.nativeRowOff || 0) / 9525;
  for(let c = tl.nativeCol; c < br.nativeCol; c++) w += colPx(c);
  for(let r = tl.nativeRow; r < br.nativeRow; r++) h += rowPx(r);
  return [Math.max(20, Math.round(w)), Math.max(20, Math.round(h))];
}

async function parseWorkbook(file, maxSide = 480, quality = 0.7){
  if(!window.ExcelJS) throw new Error('Excel reading is not available right now (ExcelJS failed to load) -- check your connection and try again.');
  const wb = new window.ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const sheets = [];
  let kept = 0, skipped = 0;
  const wsList = [];
  wb.eachSheet(ws => { if(!ws.state || ws.state === 'visible') wsList.push(ws); });
  for(const ws of wsList){
    // pictures first (they can sit below / right of the last cell that has text)
    const images = [];
    let imgs = [];
    try{ imgs = ws.getImages() || []; }catch(e){ imgs = []; }
    for(const im of imgs){
      const tl = im.range?.tl;
      if(!tl || tl.nativeRow >= MAX_ROWS || tl.nativeCol >= MAX_COLS || kept >= MAX_IMAGES){ skipped++; continue; }
      const media = wb.getImage(im.imageId);
      const src = media?.buffer ? await shrinkImage(media.buffer, media.extension, maxSide, quality) : null;
      if(!src){ skipped++; continue; }
      const [w, h] = pictureSize(ws, im.range);
      images.push({ r: tl.nativeRow, c: tl.nativeCol, x: Math.round((tl.nativeColOff || 0) / 9525), y: Math.round((tl.nativeRowOff || 0) / 9525), w, h, src });
      kept++;
    }
    const rowCount = Math.min(Math.max(ws.rowCount || 0, ...images.map(i => i.r + 1)), MAX_ROWS);
    const colCount = Math.min(Math.max(ws.columnCount || 0, ...images.map(i => i.c + 1)), MAX_COLS);
    const rows = [];
    const styles = {};
    let lastRow = Math.max(0, ...images.map(i => i.r + 1)), lastCol = Math.max(0, ...images.map(i => i.c + 1));
    for(let r = 1; r <= rowCount; r++){
      const out = [];
      for(let c = 1; c <= colCount; c++){
        const cell = ws.getCell(r, c);
        let text = '';
        try{ text = cell.text == null ? '' : String(cell.text); }catch(e){ text = ''; }
        out.push(text);
        if(text !== ''){ lastRow = Math.max(lastRow, r); lastCol = Math.max(lastCol, c); }
        const st = {};
        if(cell.font?.bold) st.b = 1;
        const argb = cell.fill?.type === 'pattern' ? cell.fill.fgColor?.argb : '';
        if(argb && /^[0-9A-F]{8}$/i.test(argb) && argb.slice(2).toUpperCase() !== 'FFFFFF' && argb.slice(0, 2).toUpperCase() !== '00') st.bg = argb.slice(2);
        if(st.b || st.bg) styles[`${r - 1},${c - 1}`] = st;
      }
      rows.push(out);
    }
    const trimmed = rows.slice(0, lastRow).map(r => ({ c: r.slice(0, lastCol) }));
    const merges = (ws.model?.merges || []).map(m => {
      const mm = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(m);
      if(!mm) return null;
      const toNum = s => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
      return { r1: Number(mm[2]) - 1, c1: toNum(mm[1]) - 1, r2: Number(mm[4]) - 1, c2: toNum(mm[3]) - 1 };
    }).filter(m => m && m.r1 < lastRow && m.c1 < lastCol);
    if(trimmed.length) sheets.push({ name: ws.name || `Sheet ${sheets.length + 1}`, rows: trimmed, styles, merges, images });
  }
  return { sheets, skipped };
}

function sheetTableHtml(sheet){
  const spans = {}, hidden = new Set();
  (sheet.merges || []).forEach(({ r1, c1, r2, c2 }) => {
    spans[`${r1},${c1}`] = [r2 - r1 + 1, c2 - c1 + 1];
    for(let r = r1; r <= r2; r++) for(let c = c1; c <= c2; c++) if(r !== r1 || c !== c1) hidden.add(`${r},${c}`);
  });
  const pics = {};
  (sheet.images || []).forEach(im => { (pics[`${im.r},${im.c}`] = pics[`${im.r},${im.c}`] || []).push(im); });
  const cols = Math.max(...sheet.rows.map(r => r.c.length), 1);
  const head = `<tr><th class="tsheet-corner"></th>${Array.from({ length: cols }, (_, i) => `<th>${colLetter(i + 1)}</th>`).join('')}</tr>`;
  const body = sheet.rows.map((row, r) => `<tr><th class="tsheet-rowno">${r + 1}</th>${Array.from({ length: cols }, (_, c) => {
    const key = `${r},${c}`;
    if(hidden.has(key)) return '';
    const st = sheet.styles?.[key] || {};
    const sp = spans[key];
    return `<td${sp ? ` rowspan="${sp[0]}" colspan="${sp[1]}"` : ''}${st.bg ? ` style="background:#${escapeHtml(st.bg)};"` : ''}${st.b ? ' class="tsheet-bold"' : ''}>${escapeHtml(row.c[c] || '')}${(pics[key] || []).map(im => `<img class="tsheet-img" src="${escapeHtml(im.src)}" alt="" style="width:${Math.min(im.w, 420)}px;">`).join('')}</td>`;
  }).join('')}</tr>`).join('');
  return `<table class="tsheet-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

export function trialSheetsHtml(t, isEditing){
  const files = Array.isArray(t.excelFiles) ? t.excelFiles : [];
  const cards = files.map(f => {
    const idx = Math.min(activeSheet.get(f.id) || 0, f.sheets.length - 1);
    const sheet = f.sheets[idx];
    return `
      <div class="tsheet-card" data-sheet-file-id="${escapeHtml(f.id)}">
        <div class="tsheet-head">
          <span class="tsheet-name">${icon('file-text', 14)} ${escapeHtml(f.name)}</span>
          <span class="tsheet-meta">${escapeHtml(f.importedBy || '')}${f.importedAt ? ' · ' + escapeHtml(formatActivityDateTime(f.importedAt)) : ''}</span>
          <span class="tsheet-actions">
            <button type="button" class="btn btn-sm" data-role="export-trial-sheet">${icon('download', 14)} Export Excel</button>
            ${isEditing ? `<button type="button" class="btn btn-sm btn-danger" data-role="remove-trial-sheet" title="Remove this file from the evaluation">${icon('x', 14)} Remove</button>` : ''}
          </span>
        </div>
        ${f.sheets.length > 1 ? `<div class="tsheet-tabs">${f.sheets.map((s, i) => `<button type="button" class="tsheet-tab${i === idx ? ' active' : ''}" data-role="trial-sheet-tab" data-sheet-index="${i}">${escapeHtml(s.name)}</button>`).join('')}</div>` : ''}
        <div class="tsheet-scroll">${sheetTableHtml(sheet)}</div>
      </div>`;
  }).join('');
  return `
    <div class="field tsheet-field">
      <div class="teval-head">
        <label>Excel Sheets</label>
        ${isEditing ? `<label class="btn btn-sm tsheet-import-btn">${icon('upload', 14)} Import Excel<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-role="import-trial-sheet" hidden></label>` : ''}
      </div>
      ${cards || `<div class="overview-empty">${isEditing ? 'No Excel file yet -- use Import Excel to show a sheet here as a table' : 'No Excel file attached'}</div>`}
    </div>`;
}

export function wireTrialSheets(block, t, isEditing, rerender){
  block.querySelector('[data-role="import-trial-sheet"]')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if(!file) return;
    if(!/\.xlsx$/i.test(file.name)){ alert('Please choose an .xlsx file (open an older .xls in Excel and Save As .xlsx first).'); return; }
    try{
      let { sheets, skipped } = await parseWorkbook(file);
      if(!sheets.length){ alert('That file has no cells with data to show.'); return; }
      let entry = { id: uid(), name: file.name, importedBy: currentUser?.email || '', importedAt: Date.now(), sheets };
      let size = JSON.stringify(entry).length;
      if(size > MAX_FILE_JSON && sheets.some(s => s.images?.length)){
        // pictures are the bulk of it: read the file again with smaller, more compressed pictures
        ({ sheets, skipped } = await parseWorkbook(file, 300, 0.55));
        entry = { ...entry, sheets };
        size = JSON.stringify(entry).length;
      }
      if(size > MAX_FILE_JSON){ alert(`That file is too large to keep inside the evaluation (${Math.round(size / 1000)} KB; the limit is ${MAX_FILE_JSON / 1000} KB). Remove unused rows/sheets and try again.`); return; }
      if(JSON.stringify(t).length + size > MAX_TRIAL_JSON){ alert('This evaluation is already close to the size limit (photos take most of it), so the file cannot be added.'); return; }
      const before = t.excelFiles;
      t.excelFiles = [...(Array.isArray(before) ? before : []), entry];
      try{ scheduleTrialSave(t); }catch(err){ t.excelFiles = before; throw err; }
      rerender();
      if(skipped) alert(`${skipped} picture${skipped > 1 ? 's' : ''} could not be kept (unsupported picture type, or more than ${MAX_IMAGES} pictures in the file). Everything else was added.`);
    }catch(err){
      console.error('Forge: Excel import failed', err);
      alert('Could not read that Excel file: ' + (err.message || err));
    }
  });
  block.querySelectorAll('.tsheet-card').forEach(card => {
    const f = (t.excelFiles || []).find(x => x.id === card.dataset.sheetFileId);
    if(!f) return;
    card.querySelectorAll('[data-role="trial-sheet-tab"]').forEach(btn => btn.addEventListener('click', () => {
      activeSheet.set(f.id, Number(btn.dataset.sheetIndex));
      rerender();
    }));
    card.querySelector('[data-role="export-trial-sheet"]')?.addEventListener('click', () => exportSheetsFile(f));
    card.querySelector('[data-role="remove-trial-sheet"]')?.addEventListener('click', () => {
      if(!confirm(`Remove "${f.name}" from this evaluation? (Your original file on your computer is not touched.)`)) return;
      t.excelFiles = (t.excelFiles || []).filter(x => x.id !== f.id);
      scheduleTrialSave(t);
      rerender();
    });
  });
}

// the stored table back out as an .xlsx (what each cell showed, with bold / fill / merged cells)
export async function exportSheetsFile(f){
  if(!window.ExcelJS){ alert('Excel export isn\'t available right now (ExcelJS failed to load) -- check your connection and try again.'); return; }
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Forge';
  wb.created = new Date();
  const used = new Set();
  f.sheets.forEach((s, i) => {
    let name = String(s.name || `Sheet ${i + 1}`).replace(/[\[\]:*?\/\\]/g, '-').slice(0, 31) || `Sheet ${i + 1}`, k = 2;
    while(used.has(name.toLowerCase())) name = `${name.slice(0, 27)} (${k++})`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);
    const widths = [];
    s.rows.forEach((rowObj, r) => {
      rowObj.c.forEach((text, c) => {
        const cell = ws.getCell(r + 1, c + 1);
        cell.value = text !== '' && /^-?\d+(\.\d+)?$/.test(text) && String(Number(text)) === text ? Number(text) : text;
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.border = { top: { style: 'thin', color: { argb: 'FFBFBFBF' } }, left: { style: 'thin', color: { argb: 'FFBFBFBF' } }, bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } }, right: { style: 'thin', color: { argb: 'FFBFBFBF' } } };
        const st = s.styles?.[`${r},${c}`];
        if(st?.b) cell.font = { bold: true };
        if(st?.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + st.bg } };
        const longest = Math.max(...String(text).split('\n').map(x => x.length), 0);
        widths[c] = Math.max(widths[c] || 8, Math.min(longest + 2, 60));
      });
    });
    widths.forEach((w, c) => { ws.getColumn(c + 1).width = w; });
    (s.images || []).forEach(im => {
      try{
        const id = wb.addImage({ base64: im.src, extension: 'jpeg' });
        ws.addImage(id, { tl: { col: im.c + (im.x || 0) / Math.max(1, (widths[im.c] || 8) * 7 + 5), row: im.r + (im.y || 0) / 20 }, ext: { width: Math.min(im.w, 900), height: Math.min(im.h, 900) } });
      }catch(e){ /* a picture that cannot be placed is skipped */ }
    });
    (s.merges || []).forEach(({ r1, c1, r2, c2 }) => { try{ ws.mergeCells(r1 + 1, c1 + 1, r2 + 1, c2 + 1); }catch(e){ /* overlapping merge in the source -- skip it */ } });
  });
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (f.name || 'Sample Evaluation').replace(/\.xlsx$/i, '').replace(/[\\/:*?"<>|]/g, '-') + ' (Forge).xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
