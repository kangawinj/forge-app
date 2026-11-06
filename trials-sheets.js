// Excel sheets attached to a Sample Evaluation (trial): import an .xlsx, see it as a table right in the card, and
// export it again as an Excel file. The sheets are stored as plain text cells (t.excelFiles) -- pictures, charts and
// formulas in the original are not kept, only what each cell shows, plus its look: bold / italic / size / text colour /
// fill colour / alignment / borders, merged cells, column widths and row heights.
// Firestore refuses arrays inside arrays, so a row is { c: [cell texts] } and a merge is { r1, c1, r2, c2 }.
// Pictures are kept too, shrunk to a small JPEG each so they fit inside the evaluation (see shrinkImage).
import { currentUser, uid, escapeHtml, icon, formatActivityDateTime, requestAuthConfirm } from './app.js';
import { scheduleTrialSave } from './trials-data.js';

const MAX_ROWS = 500;
const MAX_COLS = 40;
const MAX_FILE_JSON = 600000;   // one imported file, as stored (pictures included)
const MAX_IMAGES = 60;          // pictures kept per file
const MAX_TRIAL_JSON = 950000;  // Firestore's limit is 1 MB per document

const activeSheet = new Map();  // fileId -> index of the sheet tab being looked at

function colLetter(n){
  let s = '';
  for(; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

// Picture bytes -> { src: smaller JPEG data URL (transparent areas become white), w, h }. Null if the browser cannot read the format.
async function shrinkImage(buffer, ext, maxSide, quality){
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[String(ext).toLowerCase()];
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
    return { src: c.toDataURL('image/jpeg', quality), w: c.width, h: c.height };
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

// "Place in cell" pictures (the Insert > Pictures > Place in Cell kind, shown in a cell as a picture but stored by the
// file as an error value) are not seen by ExcelJS, so they are read straight out of the .xlsx zip: cell -> value
// metadata -> rich value -> related media file. Returns { sheetName: [{ r, c, buffer, ext }] }.
let jszipPromise = null;
function loadJSZip(){
  if(window.JSZip) return Promise.resolve(window.JSZip);
  if(!jszipPromise) jszipPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => res(window.JSZip);
    s.onerror = () => { jszipPromise = null; rej(new Error('could not load the zip reader')); };
    document.head.appendChild(s);
  });
  return jszipPromise;
}
async function readCellPictures(file){
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const text = async p => { const f = zip.file(p); return f ? f.async('string') : null; };
  const parse = s => new DOMParser().parseFromString(s, 'application/xml');
  const all = (doc, local) => Array.from(doc.getElementsByTagNameNS('*', local));
  const attr = (el, local) => { for(const a of Array.from(el.attributes)) if(a.localName === local) return a.value; return null; };
  // the theme's colour palette, in the order Excel numbers it (0 = light 1, 1 = dark 1, 2 = light 2, 3 = dark 2, 4-9 = accents ...)
  let theme = [];
  const themeXml = await text('xl/theme/theme1.xml');
  const scheme = themeXml ? all(parse(themeXml), 'clrScheme')[0] : null;
  if(scheme) theme = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(n => {
    const el = Array.from(scheme.children).find(x => x.localName === n);
    const c = el && el.firstElementChild;
    return c ? String((c.localName === 'sysClr' ? c.getAttribute('lastClr') : c.getAttribute('val')) || '').toUpperCase() : '';
  });
  const rvXml = await text('xl/richData/rdrichvalue.xml');
  const metaXml = await text('xl/metadata.xml');
  if(!rvXml || !metaXml) return { pics: {}, theme };
  const structXml = await text('xl/richData/rdrichvaluestructure.xml');
  const relXml = await text('xl/richData/richValueRel.xml');
  const relRels = await text('xl/richData/_rels/richValueRel.xml.rels');
  if(!structXml || !relXml || !relRels) return { pics: {}, theme };
  // rich value i -> index of its picture in richValueRel.xml
  const structs = all(parse(structXml), 's').map(s => all(s, 'k').map(k => attr(k, 'n')));
  const richToRel = all(parse(rvXml), 'rv').map(rv => {
    const keys = structs[Number(attr(rv, 's')) || 0] || [];
    const at = keys.indexOf('_rvRel:LocalImageIdentifier');
    const v = Array.from(rv.children).filter(x => x.localName === 'v')[at];
    return at >= 0 && v ? Number(v.textContent) : -1;
  });
  const relIds = all(parse(relXml), 'rel').map(r => attr(r, 'id'));
  const relTarget = {};
  all(parse(relRels), 'Relationship').forEach(r => { relTarget[r.getAttribute('Id')] = r.getAttribute('Target'); });
  // cell value-metadata index (vm, 1-based) -> rich value i
  const meta = parse(metaXml);
  const fm = all(meta, 'futureMetadata').find(f => f.getAttribute('name') === 'XLRICHVALUE');
  const rvbOfBk = fm ? Array.from(fm.children).filter(b => b.localName === 'bk').map(b => { const rvb = all(b, 'rvb')[0]; return rvb ? Number(attr(rvb, 'i')) : -1; }) : [];
  const vmToRich = all(meta, 'valueMetadata').flatMap(vmEl => Array.from(vmEl.children).filter(b => b.localName === 'bk').map(b => {
    const rc = all(b, 'rc')[0];
    return rc ? (rvbOfBk[Number(attr(rc, 'v'))] ?? -1) : -1;
  }));
  // sheet name -> sheet xml path
  const wbDoc = parse(await text('xl/workbook.xml') || '<x/>');
  const wbRels = {};
  all(parse(await text('xl/_rels/workbook.xml.rels') || '<x/>'), 'Relationship').forEach(r => { wbRels[r.getAttribute('Id')] = r.getAttribute('Target'); });
  const out = {};
  for(const sEl of all(wbDoc, 'sheet')){
    const target = wbRels[attr(sEl, 'id')];
    if(!target) continue;
    const xml = await text(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
    if(!xml) continue;
    const list = [];
    for(const c of all(parse(xml), 'c')){
      const vm = Number(c.getAttribute('vm'));
      if(!vm) continue;
      const rich = vmToRich[vm - 1];
      const relIdx = rich >= 0 ? richToRel[rich] : -1;
      const tgt = relIdx >= 0 ? relTarget[relIds[relIdx]] : null;
      const m = /^([A-Z]+)(\d+)$/.exec(c.getAttribute('r') || '');
      if(!tgt || !m) continue;
      const path = 'xl/' + tgt.replace(/^\.\.\//, '');
      const f = zip.file(path);
      if(!f) continue;
      list.push({ r: Number(m[2]) - 1, c: [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, buffer: await f.async('uint8array'), ext: (path.split('.').pop() || '').toLowerCase() });
    }
    if(list.length) out[sEl.getAttribute('name')] = list;
  }
  return { pics: out, theme };
}

// ---- reading a cell's look the way Excel stores it (theme colours, number / date formats, border styles ...) ----
const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080'];
function applyTint(hex, t){
  if(!t) return hex;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0, l = (mx + mn) / 2;
  if(mx !== mn){
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = t < 0 ? l * (1 + t) : l * (1 - t) + t;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = x => { if(x < 0) x += 1; if(x > 1) x -= 1; return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p; };
  const out = s === 0 ? [l, l, l] : [f(h + 1 / 3), f(h), f(h - 1 / 3)];
  return out.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
// an ExcelJS colour ({ argb } | { theme, tint } | { indexed }) -> 'RRGGBB' ('' when automatic / unknown)
function colorHex(col, theme){
  if(!col) return '';
  if(col.argb && /^[0-9A-F]{8}$/i.test(col.argb)) return col.argb.slice(0, 2).toUpperCase() === '00' ? '' : col.argb.slice(2).toUpperCase();
  if(col.theme != null && theme[col.theme]) return applyTint(theme[col.theme], col.tint || 0);
  if(col.indexed != null && INDEXED[col.indexed]) return INDEXED[col.indexed];
  return '';
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// a date shown the way its Excel number format says (UTC fields: ExcelJS hands dates back as UTC)
function fmtDate(d, f){
  const p2 = n => String(n).padStart(2, '0');
  const Y = d.getUTCFullYear(), M = d.getUTCMonth(), D = d.getUTCDate(), h = d.getUTCHours(), mi = d.getUTCMinutes(), s = d.getUTCSeconds();
  if(!f || /^general$/i.test(f)) return `${p2(D)}/${p2(M + 1)}/${Y}` + (h || mi ? ` ${p2(h)}:${p2(mi)}` : '');
  const toks = f.split(';')[0].replace(/\[[^\]]*\]/g, '').match(/"[^"]*"|\\.|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|am\/pm|A\/P|./gi) || [];
  const isUnit = x => /^(yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s)$/i.test(x);
  const units = toks.map((x, i) => isUnit(x) ? i : -1).filter(i => i >= 0);
  const ampm = toks.some(x => /^(AM\/PM|A\/P)$/i.test(x));
  return toks.map((x, i) => {
    const k = x.toLowerCase();
    if(k === 'yyyy') return String(Y);
    if(k === 'yy') return p2(Y % 100);
    if(k === 'dddd') return WEEKDAYS[d.getUTCDay()];
    if(k === 'ddd') return WEEKDAYS[d.getUTCDay()].slice(0, 3);
    if(k === 'dd') return p2(D);
    if(k === 'd') return String(D);
    if(k === 'hh' || k === 'h'){ const hh = ampm ? ((h + 11) % 12) + 1 : h; return k === 'hh' ? p2(hh) : String(hh); }
    if(k === 'ss') return p2(s);
    if(k === 's') return String(s);
    if(k === 'mmmm') return MONTHS[M];
    if(k === 'mmm') return MONTHS[M].slice(0, 3);
    if(k === 'mm' || k === 'm'){
      const at = units.indexOf(i), prev = toks[units[at - 1]], next = toks[units[at + 1]];
      const minute = (prev && /^h+$/i.test(prev)) || (next && /^s+$/i.test(next));
      const v = minute ? mi : M + 1;
      return k === 'mm' ? p2(v) : String(v);
    }
    if(k === 'am/pm') return h < 12 ? 'AM' : 'PM';
    if(k === 'a/p') return h < 12 ? 'A' : 'P';
    if(x.startsWith('"')) return x.slice(1, -1);
    if(x.startsWith('\\')) return x.slice(1);
    return x;
  }).join('');
}
// a number shown the way its Excel number format says (decimals, thousands, %, currency text); General -> as is
function fmtNumber(n, f){
  if(!f || /^general$/i.test(f)) return String(Number(n.toPrecision(12)));
  const parts = f.split(';');
  let sec = parts[0], neg = false;
  if(n < 0 && parts[1]){ sec = parts[1]; n = Math.abs(n); neg = true; }
  sec = sec.replace(/\[[^\]]*\]/g, '').replace(/_./g, '').replace(/\*./g, '');
  const m = /^(.*?)([#0?][#0?,]*(?:\.[#0?]+)?)(.*)$/.exec(sec);
  if(!m) return String(n);
  const lit = s => s.replace(/"([^"]*)"/g, '$1').replace(/\\(.)/g, '$1');
  const val = /%/.test(sec) ? n * 100 : n;
  const dec = (m[2].split('.')[1] || '').length, zeros = (m[2].split('.')[0].match(/0/g) || []).length;
  let [ip, fp] = Math.abs(val).toFixed(dec).split('.');
  ip = ip.padStart(zeros, '0');
  if(m[2].includes(',')) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (val < 0 && !neg ? '-' : '') + lit(m[1]) + ip + (fp ? '.' + fp : '') + lit(m[3]);
}
// stored border: { t|r|b|l: 'style:RRGGBB' } (an older import stored just the letters) -> [[side, style, colour]]
function borderParts(bd){
  if(!bd) return [];
  const sides = { t: 'top', r: 'right', b: 'bottom', l: 'left' };
  if(typeof bd === 'string') return [...bd].filter(k => sides[k]).map(k => [sides[k], 'thin', '555555']);
  return Object.entries(bd).filter(([k]) => sides[k]).map(([k, v]) => { const [style, color] = String(v).split(':'); return [sides[k], style || 'thin', color || '000000']; });
}
function cssBorder(style, color){
  const w = /^medium/.test(style) ? 2 : /^thick/.test(style) ? 3 : 1;
  const kind = /dash/i.test(style) ? 'dashed' : /dot|hair/i.test(style) ? 'dotted' : /double/.test(style) ? 'double' : 'solid';
  return `${kind === 'double' ? Math.max(3, w) : w}px ${kind} #${color}`;
}

async function parseWorkbook(file, maxSide = 480, quality = 0.7, cellSide = 180){
  if(!window.ExcelJS) throw new Error('Excel reading is not available right now (ExcelJS failed to load) -- check your connection and try again.');
  const wb = new window.ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const sheets = [];
  let kept = 0, skipped = 0;
  let cellPics = {}, theme = [];
  try{ ({ pics: cellPics, theme } = await readCellPictures(file)); }catch(e){ console.warn('Forge: reading in-cell pictures / theme failed', e); }
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
      const shrunk = media?.buffer ? await shrinkImage(media.buffer, media.extension, maxSide, quality) : null;
      if(!shrunk){ skipped++; continue; }
      const [w, h] = pictureSize(ws, im.range);
      images.push({ r: tl.nativeRow, c: tl.nativeCol, x: Math.round((tl.nativeColOff || 0) / 9525), y: Math.round((tl.nativeRowOff || 0) / 9525), w, h, src: shrunk.src });
      kept++;
    }
    // pictures placed inside cells: shown at up to 120 px, and the cell's own "#VALUE!" text is dropped
    const inCell = new Set();
    for(const cp of (cellPics[ws.name] || [])){
      if(cp.r >= MAX_ROWS || cp.c >= MAX_COLS || kept >= MAX_IMAGES){ skipped++; continue; }
      const shrunk = await shrinkImage(cp.buffer, cp.ext, cellSide, quality);
      if(!shrunk){ skipped++; continue; }
      const k = 120 / Math.max(shrunk.w, shrunk.h);
      images.push({ r: cp.r, c: cp.c, x: 0, y: 0, w: Math.round(shrunk.w * k), h: Math.round(shrunk.h * k), src: shrunk.src, cp: 1 });
      inCell.add(`${cp.r},${cp.c}`);
      kept++;
    }
    const rowCount = Math.min(Math.max(ws.rowCount || 0, ...images.map(i => i.r + 1)), MAX_ROWS);
    const colCount = Math.min(Math.max(ws.columnCount || 0, ...images.map(i => i.c + 1)), MAX_COLS);
    const rows = [];
    const styles = {};
    const vals = {};
    let lastRow = Math.max(0, ...images.map(i => i.r + 1)), lastCol = Math.max(0, ...images.map(i => i.c + 1));
    for(let r = 1; r <= rowCount; r++){
      const out = [];
      for(let c = 1; c <= colCount; c++){
        const cell = ws.getCell(r, c);
        const key = `${r - 1},${c - 1}`;
        let text = '', raw;
        try{ text = cell.text == null ? '' : String(cell.text); }catch(e){ text = ''; }
        // numbers and dates are shown the way their Excel number format says, and kept as real values (for the export)
        let v = cell.value;
        if(v && typeof v === 'object' && !(v instanceof Date) && 'result' in v) v = v.result;
        if(v instanceof Date && !isNaN(v)){ text = fmtDate(v, cell.numFmt); raw = 'D:' + v.toISOString(); }
        else if(typeof v === 'number' && isFinite(v)){ text = fmtNumber(v, cell.numFmt); raw = v; }
        if(inCell.has(key)){ text = ''; raw = undefined; }
        out.push(text);
        if(raw !== undefined) vals[key] = raw;
        if(text !== ''){ lastRow = Math.max(lastRow, r); lastCol = Math.max(lastCol, c); }
        const st = {};
        const fnt = cell.font || {};
        if(fnt.bold) st.b = 1;
        if(fnt.italic) st.i = 1;
        if(fnt.underline) st.u = 1;
        if(fnt.strike) st.s = 1;
        if(fnt.size && fnt.size !== 11) st.sz = fnt.size;
        if(fnt.name && fnt.name !== 'Calibri') st.fn = fnt.name;
        const fc = colorHex(fnt.color, theme);
        if(fc && fc !== '000000') st.fc = fc;
        const bg = cell.fill?.type === 'pattern' && cell.fill.pattern && cell.fill.pattern !== 'none' ? colorHex(cell.fill.fgColor, theme) : '';
        if(bg && bg !== 'FFFFFF') st.bg = bg;
        if(['left', 'center', 'right'].includes(cell.alignment?.horizontal)) st.ha = cell.alignment.horizontal;
        if(['top', 'middle', 'bottom'].includes(cell.alignment?.vertical)) st.va = cell.alignment.vertical;
        if(cell.alignment?.wrapText) st.wr = 1;
        const bd = {};
        for(const side of ['top', 'right', 'bottom', 'left']){
          const b = cell.border?.[side];
          if(b?.style) bd[side[0]] = `${b.style}:${colorHex(b.color, theme) || '000000'}`;
        }
        if(Object.keys(bd).length) st.bd = bd;
        if(raw !== undefined && cell.numFmt && !/^general$/i.test(cell.numFmt)) st.nf = cell.numFmt;
        if(Object.keys(st).length) styles[key] = st;
      }
      rows.push(out);
    }
    const trimmed = rows.slice(0, lastRow).map(r => ({ c: r.slice(0, lastCol) }));
    const colw = [];
    for(let c = 1; c <= lastCol; c++){ const w = ws.getColumn(c).width; colw.push(w ? Math.round(w * 10) / 10 : 0); }
    const rowh = {};
    for(let r = 1; r <= lastRow; r++){ const h = ws.getRow(r).height; if(h) rowh[r - 1] = Math.round(h * 10) / 10; }
    const merges = (ws.model?.merges || []).map(m => {
      const mm = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(m);
      if(!mm) return null;
      const toNum = s => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
      return { r1: Number(mm[2]) - 1, c1: toNum(mm[1]) - 1, r2: Number(mm[4]) - 1, c2: toNum(mm[3]) - 1 };
    }).filter(m => m && m.r1 < lastRow && m.c1 < lastCol);
    if(trimmed.length) sheets.push({ name: ws.name || `Sheet ${sheets.length + 1}`, rows: trimmed, styles, merges, images, colw, rowh, vals, v2: 1, ng: ws.views?.[0]?.showGridLines === false ? 1 : 0 });
  }
  return { sheets, skipped };
}

function sheetTableHtml(sheet, edit = false, sel = null){
  const spans = {}, hidden = new Set();
  (sheet.merges || []).forEach(({ r1, c1, r2, c2 }) => {
    spans[`${r1},${c1}`] = [r2 - r1 + 1, c2 - c1 + 1];
    for(let r = r1; r <= r2; r++) for(let c = c1; c <= c2; c++) if(r !== r1 || c !== c1) hidden.add(`${r},${c}`);
  });
  const pics = {};
  (sheet.images || []).forEach(im => { (pics[`${im.r},${im.c}`] = pics[`${im.r},${im.c}`] || []).push(im); });
  const cols = Math.max(...sheet.rows.map(r => r.c.length), 1);
  // the original column widths / row heights when the file gave them (chars -> px like Excel: 7 px a char + 5)
  const hasWidths = edit || (sheet.colw || []).some(w => w);
  const colPx = c => Math.round(((sheet.colw || [])[c] || 8.43) * 7 + 5);
  const colgroup = hasWidths ? `<colgroup><col style="width:36px">${Array.from({ length: cols }, (_, c) => `<col style="width:${colPx(c)}px">`).join('')}</colgroup>` : '';
  const tableStyle = hasWidths ? ` style="table-layout:fixed;width:${36 + Array.from({ length: cols }, (_, c) => colPx(c)).reduce((a, b) => a + b, 0)}px;min-width:0;"` : '';
  const v2 = !!sheet.v2;   // imported by the version that keeps the file's own wrapping / vertical alignment / fonts
  const cellStyle = st => [
    st.bg ? `background:#${st.bg}` : '', st.fc ? `color:#${st.fc}` : '', st.i ? 'font-style:italic' : '',
    st.u || st.s ? `text-decoration:${[st.u ? 'underline' : '', st.s ? 'line-through' : ''].filter(Boolean).join(' ')}` : '',
    st.fn ? `font-family:'${String(st.fn).replace(/['"<>&]/g, '')}',sans-serif` : '',
    st.sz ? `font-size:${Math.min(28, Math.round(st.sz * 4 / 3))}px` : '', st.ha ? `text-align:${st.ha}` : '',
    st.va || v2 ? `vertical-align:${st.va || 'bottom'}` : '',
    !wrapOf(st, v2) ? 'white-space:nowrap' : '',
    ...borderParts(st.bd).map(([side, style, color]) => `border-${side}:${cssBorder(style, color)}`)
  ].filter(Boolean).join(';');
  const head = `<tr><th class="tsheet-corner"></th>${Array.from({ length: cols }, (_, i) => `<th${edit ? ` data-colhead="${i}"` : ''}>${colLetter(i + 1)}${edit ? `<span class="tsheet-colgrip" data-col="${i}" title="Drag to change the column width"></span>` : ''}</th>`).join('')}</tr>`;
  const body = sheet.rows.map((row, r) => `<tr${(sheet.rowh || {})[r] ? ` style="height:${Math.round(sheet.rowh[r] * 4 / 3)}px"` : ''}><th class="tsheet-rowno"${edit ? ` data-rowhead="${r}"` : ''}>${r + 1}${edit ? `<span class="tsheet-rowgrip" data-row="${r}" title="Drag to change the row height"></span>` : ''}</th>${Array.from({ length: cols }, (_, c) => {
    const key = `${r},${c}`;
    if(hidden.has(key)) return '';
    const st = sheet.styles?.[key] || {};
    const sp = spans[key];
    const imgs = (pics[key] || []).map(im => edit
      ? `<span class="tsheet-pic"><img class="tsheet-img" src="${escapeHtml(im.src)}" alt="" style="width:${Math.min(im.w, 420)}px;"><span class="tsheet-picbar"><button type="button" data-pic-scale="0.8" data-img-index="${sheet.images.indexOf(im)}" title="Smaller">&minus;</button><button type="button" data-pic-scale="1.25" data-img-index="${sheet.images.indexOf(im)}" title="Larger">+</button><button type="button" data-pic-remove data-img-index="${sheet.images.indexOf(im)}" title="Remove this picture">&times;</button></span></span>`
      : `<img class="tsheet-img" src="${escapeHtml(im.src)}" alt="" style="width:${Math.min(im.w, 420)}px;">`).join('');
    const inner = edit
      ? `<span class="tsheet-ed" contenteditable="false" spellcheck="false" data-r="${r}" data-c="${c}">${escapeHtml(row.c[c] || '')}</span><span class="tsheet-cellpics" contenteditable="false">${imgs}<button type="button" class="tsheet-addpic" data-r="${r}" data-c="${c}" title="Add a picture to this cell">${icon('upload', 12)}</button></span>`
      : `${escapeHtml(row.c[c] || '')}${imgs}`;
    const inSel = !!(edit && sel && r >= sel.r1 && r <= sel.r2 && c >= sel.c1 && c <= sel.c2);
    const cls = [st.b ? 'tsheet-bold' : '', inSel ? 'tsheet-sel' : ''].filter(Boolean).join(' ');
    return `<td${edit ? ` data-r="${r}" data-c="${c}"` : ''}${sp ? ` rowspan="${sp[0]}" colspan="${sp[1]}"` : ''}${cellStyle(st) ? ` style="${escapeHtml(cellStyle(st))}"` : ''}${cls ? ` class="${cls}"` : ''}>${inner}</td>`;
  }).join('')}</tr>`).join('');
  return `<table class="tsheet-table${edit ? ' tsheet-editing' : ''}${sheet.ng ? ' tsheet-nogrid' : ''}"${tableStyle}>${colgroup}<thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// Editing one sheet of an attached file in place: a working copy (`draft`) is changed and only written back on Save.
let sheetEdit = null;        // { trialId, fileId, sheetIndex, draft, sel }
let sheetDragUp = null;      // the document-level mouseup handler of the table being edited
// does a cell wrap its text? its own setting, else the default (an older import wrapped everything; a v2 import wraps only what the file says)
const wrapOf = (st, v2) => st.wr !== undefined ? !!st.wr : !v2;
let keepScroll = null;       // scroll position of the table being edited, restored after a redraw
const clone = o => JSON.parse(JSON.stringify(o));
function normalizeDraft(d){
  const cols = Math.max(...d.rows.map(r => r.c.length), 1);
  d.rows.forEach(r => { while(r.c.length < cols) r.c.push(''); });
  d.colw = Array.from({ length: cols }, (_, c) => (d.colw || [])[c] || 13);
  d.rowh = d.rowh || {};
  d.images = d.images || [];
  d.merges = d.merges || [];
  d.styles = d.styles || {};
  return d;
}

export function trialSheetsHtml(t, isEditing){
  if(sheetEdit && sheetEdit.trialId === t.id && !isEditing) sheetEdit = null;
  const files = Array.isArray(t.excelFiles) ? t.excelFiles : [];
  const cards = files.map(f => {
    const ed = !!(sheetEdit && sheetEdit.trialId === t.id && sheetEdit.fileId === f.id && isEditing);
    const idx = ed ? sheetEdit.sheetIndex : Math.min(activeSheet.get(f.id) || 0, f.sheets.length - 1);
    const sheet = ed ? sheetEdit.draft : f.sheets[idx];
    const otherEditing = !!(sheetEdit && sheetEdit.trialId === t.id && !ed);
    return `
      <div class="tsheet-card${ed ? ' tsheet-card-editing' : ''}" data-sheet-file-id="${escapeHtml(f.id)}">
        <div class="tsheet-head">
          <span class="tsheet-name">${icon('file-text', 14)} ${escapeHtml(f.name)}</span>
          <span class="tsheet-meta">${escapeHtml(f.importedBy || '')}${f.importedAt ? ' · ' + escapeHtml(formatActivityDateTime(f.importedAt)) : ''}</span>
          <span class="tsheet-actions">
            ${ed ? `
              <button type="button" class="btn btn-sm" data-role="sheet-add-row">${icon('plus', 14)} Row</button>
              <button type="button" class="btn btn-sm" data-role="sheet-add-col">${icon('plus', 14)} Column</button>
              <button type="button" class="btn btn-sm btn-primary" data-role="sheet-edit-save">${icon('save', 14)} Save table</button>
              <button type="button" class="btn btn-sm" data-role="sheet-edit-cancel">Cancel</button>
            ` : `
              <button type="button" class="btn btn-sm" data-role="export-trial-sheet">${icon('download', 14)} Export Excel</button>
              ${isEditing ? `<button type="button" class="btn btn-sm" data-role="edit-trial-sheet" ${otherEditing ? 'disabled title="Finish the other table first"' : ''}>${icon('pencil', 14)} Edit table</button>` : ''}
              ${isEditing ? `<button type="button" class="btn btn-sm btn-danger" data-role="remove-trial-sheet" title="Remove this file from the evaluation">${icon('x', 14)} Remove</button>` : ''}
            `}
          </span>
        </div>
        ${ed
          ? `<div class="tsheet-edit-hint">Editing sheet "${escapeHtml(sheet.name)}": click a cell to select it (drag, or Shift+click, for several; a column letter or row number selects all of it), <b>double-click</b> it &mdash; or press Enter, or just start typing &mdash; to type. Enter confirms (Alt+Enter = new line inside the cell), Esc cancels. Use the bar below to format, merge or split cells. Drag the edge of a column letter or row number to resize. The arrow button in a cell adds a picture. Nothing is kept until you press Save table.</div>`
          : (f.sheets.length > 1 ? `<div class="tsheet-tabs">${f.sheets.map((s, i) => `<button type="button" class="tsheet-tab${i === idx ? ' active' : ''}" data-role="trial-sheet-tab" data-sheet-index="${i}">${escapeHtml(s.name)}</button>`).join('')}</div>` : '')}
        ${ed ? `<div class="tsheet-fmtbar">
          <select data-fmt-select="fn" title="Font">${['Calibri', 'Arial', 'Tahoma', 'Times New Roman', 'Courier New', 'TH Sarabun New', 'Angsana New'].map(n => `<option>${n}</option>`).join('')}</select>
          <select data-fmt-select="sz" title="Font size">${[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28].map(n => `<option${n === 11 ? ' selected' : ''}>${n}</option>`).join('')}</select>
          <span class="tsheet-fb-sep"></span>
          <button type="button" data-fmt="b" title="Bold"><b>B</b></button>
          <button type="button" data-fmt="i" title="Italic"><i>I</i></button>
          <button type="button" data-fmt="u" title="Underline"><u>U</u></button>
          <button type="button" data-fmt="s" title="Strikethrough"><s>S</s></button>
          <label class="tsheet-fb-color" title="Text colour"><span>A</span><input type="color" data-fmt-color="fc" value="#000000"></label>
          <label class="tsheet-fb-color" title="Fill colour"><span class="tsheet-fb-fill">&#9632;</span><input type="color" data-fmt-color="bg" value="#ffff00"></label>
          <button type="button" data-fmt="nobg" title="Remove the fill colour">No fill</button>
          <span class="tsheet-fb-sep"></span>
          <button type="button" data-fmt="ha:left" title="Align left">Left</button>
          <button type="button" data-fmt="ha:center" title="Centre">Centre</button>
          <button type="button" data-fmt="ha:right" title="Align right">Right</button>
          <button type="button" data-fmt="va:top" title="Align to the top">Top</button>
          <button type="button" data-fmt="va:middle" title="Align to the middle">Middle</button>
          <button type="button" data-fmt="va:bottom" title="Align to the bottom">Bottom</button>
          <span class="tsheet-fb-sep"></span>
          <button type="button" data-fmt="wrap" title="Wrap text: long text breaks into lines inside the cell">Wrap text</button>
          <button type="button" data-fmt="nowrap" title="No wrap: text stays on one line (it runs over empty cells next to it)">No wrap</button>
          <span class="tsheet-fb-sep"></span>
          <button type="button" data-fmt="merge" title="Merge the selected cells into one">Merge cells</button>
          <button type="button" data-fmt="split" title="Split a merged cell back into cells">Split cells</button>
          <select data-fmt-select="border" title="Borders of the selected cells">${[['', 'Borders...'], ['all', 'All borders'], ['outer', 'Outer border'], ['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right'], ['none', 'No border']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        </div>` : ''}
        <div class="tsheet-scroll" ${ed ? 'tabindex="0"' : ''}>${sheetTableHtml(sheet, ed, ed ? sheetEdit.sel : null)}</div>
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

function wireSheetEditor(card, t, f, rerender){
  const draft = sheetEdit.draft;
  const scrollBox = card.querySelector('.tsheet-scroll');
  if(keepScroll && keepScroll.fileId === f.id){ scrollBox.scrollTop = keepScroll.top; scrollBox.scrollLeft = keepScroll.left; keepScroll = null; }
  const redraw = () => { keepScroll = { fileId: f.id, top: scrollBox.scrollTop, left: scrollBox.scrollLeft }; rerender(); };
  const table = card.querySelector('table');
  const rowsN = () => draft.rows.length, colsN = () => draft.colw.length;
  const cellOf = (r, c) => table.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
  const mergeAt = (r, c) => draft.merges.find(m => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2);
  const keyOf = (r, c) => `${r},${c}`;
  // ---- selection (click, drag, shift+click, arrows; a column letter / row number selects the whole column / row) ----
  const rangeFor = (ar, ac, fr, fc) => {
    let r1 = Math.min(ar, fr), r2 = Math.max(ar, fr), c1 = Math.min(ac, fc), c2 = Math.max(ac, fc);
    for(let again = true; again;){
      again = false;
      for(const m of draft.merges){
        if(m.r1 <= r2 && m.r2 >= r1 && m.c1 <= c2 && m.c2 >= c1 && (m.r1 < r1 || m.r2 > r2 || m.c1 < c1 || m.c2 > c2)){
          r1 = Math.min(r1, m.r1); r2 = Math.max(r2, m.r2); c1 = Math.min(c1, m.c1); c2 = Math.max(c2, m.c2); again = true;
        }
      }
    }
    return { ar, ac, fr, fc, r1, c1, r2, c2 };
  };
  const paintSel = () => {
    table.querySelectorAll('.tsheet-sel').forEach(x => x.classList.remove('tsheet-sel'));
    const s = sheetEdit.sel;
    if(s) table.querySelectorAll('td[data-r]').forEach(td => {
      const r = Number(td.dataset.r), c = Number(td.dataset.c);
      if(r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2) td.classList.add('tsheet-sel');
    });
    // the toolbar shows the look of the first selected cell
    const st = s ? (draft.styles[keyOf(s.r1, s.c1)] || {}) : {};
    const on = (k, v) => card.querySelector(`[data-fmt="${k}"]`)?.classList.toggle('active', v);
    on('b', !!st.b); on('i', !!st.i); on('u', !!st.u); on('s', !!st.s);
    ['left', 'center', 'right'].forEach(v => on('ha:' + v, st.ha === v));
    ['top', 'middle', 'bottom'].forEach(v => on('va:' + v, (st.va || (draft.v2 ? 'bottom' : 'top')) === v));
    const wraps = wrapOf(st, !!draft.v2);
    on('wrap', wraps); on('nowrap', !wraps);
    const setVal = (sel, v) => { const el = card.querySelector(sel); if(el) el.value = v; };
    setVal('[data-fmt-select="fn"]', st.fn || 'Calibri');
    setVal('[data-fmt-select="sz"]', String(st.sz || 11));
    setVal('[data-fmt-color="fc"]', '#' + (st.fc || '000000').toLowerCase());
    if(st.bg) setVal('[data-fmt-color="bg"]', '#' + st.bg.toLowerCase());
  };
  const select = (ar, ac, fr, fc) => { sheetEdit.sel = rangeFor(ar, ac, fr, fc); paintSel(); };
  const reveal = (r, c) => cellOf(r, c)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  // ---- typing: double-click a cell (or Enter / F2, or just start typing) ----
  let editOriginal = '';
  const startEdit = (td, replace) => {
    const sp = td?.querySelector('.tsheet-ed');
    if(!sp) return;
    editOriginal = sp.innerText.replace(/\n$/, '');
    sp.contentEditable = 'true';
    sp.focus();
    const rg = document.createRange();
    rg.selectNodeContents(sp);
    if(!replace) rg.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(rg);
  };
  const moveSel = (dr, dc, extend) => {
    const s = sheetEdit.sel;
    if(!s) return;
    const nr = Math.max(0, Math.min(rowsN() - 1, s.fr + dr)), nc = Math.max(0, Math.min(colsN() - 1, s.fc + dc));
    if(extend) select(s.ar, s.ac, nr, nc); else select(nr, nc, nr, nc);
    reveal(nr, nc);
    scrollBox.focus({ preventScroll: true });
  };
  card.querySelectorAll('.tsheet-ed').forEach(el => {
    el.addEventListener('input', () => {
      draft.rows[Number(el.dataset.r)].c[Number(el.dataset.c)] = el.innerText.replace(/\n$/, '');
      if(draft.vals) delete draft.vals[`${el.dataset.r},${el.dataset.c}`];   // typed text replaces the number / date it held
    });
    el.addEventListener('blur', () => { el.contentEditable = 'false'; });
    el.addEventListener('paste', e => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });
    el.addEventListener('keydown', e => {
      if(e.key === 'Enter' && e.altKey){ e.preventDefault(); document.execCommand('insertLineBreak'); }
      else if(e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); el.contentEditable = 'false'; el.blur(); moveSel(e.key === 'Enter' ? (e.shiftKey ? -1 : 1) : 0, e.key === 'Tab' ? (e.shiftKey ? -1 : 1) : 0, false); }
      else if(e.key === 'Escape'){
        e.preventDefault();
        el.innerText = editOriginal;
        draft.rows[Number(el.dataset.r)].c[Number(el.dataset.c)] = editOriginal;
        el.contentEditable = 'false';
        el.blur();
        scrollBox.focus({ preventScroll: true });
      }
    });
  });
  let dragging = false;
  table.addEventListener('mousedown', e => {
    if(e.button !== 0 || e.target.closest('button, .tsheet-colgrip, .tsheet-rowgrip')) return;
    const td = e.target.closest('td[data-r]');
    if(td){
      if(td.querySelector('.tsheet-ed[contenteditable="true"]')) return;   // already typing in it
      const r = Number(td.dataset.r), c = Number(td.dataset.c);
      if(e.shiftKey && sheetEdit.sel) select(sheetEdit.sel.ar, sheetEdit.sel.ac, r, c); else select(r, c, r, c);
      dragging = true;
      scrollBox.focus({ preventScroll: true });
      return;
    }
    const ch = e.target.closest('th[data-colhead]'), rh = e.target.closest('th[data-rowhead]');
    if(ch){ const c = Number(ch.dataset.colhead); select(0, c, rowsN() - 1, c); scrollBox.focus({ preventScroll: true }); }
    else if(rh){ const r = Number(rh.dataset.rowhead); select(r, 0, r, colsN() - 1); scrollBox.focus({ preventScroll: true }); }
  });
  table.addEventListener('mouseover', e => {
    if(!dragging || !sheetEdit.sel) return;
    const td = e.target.closest('td[data-r]');
    if(td) select(sheetEdit.sel.ar, sheetEdit.sel.ac, Number(td.dataset.r), Number(td.dataset.c));
  });
  if(sheetDragUp) document.removeEventListener('mouseup', sheetDragUp);
  sheetDragUp = () => { dragging = false; };
  document.addEventListener('mouseup', sheetDragUp);
  table.addEventListener('dblclick', e => {
    const td = e.target.closest('td[data-r]');
    if(!td || e.target.closest('button')) return;
    startEdit(td, false);
  });
  scrollBox.addEventListener('keydown', e => {
    if(e.target.closest('.tsheet-ed[contenteditable="true"]')) return;
    const s = sheetEdit.sel;
    if(!s) return;
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if(arrows[e.key]){ e.preventDefault(); moveSel(arrows[e.key][0], arrows[e.key][1], e.shiftKey); }
    else if(e.key === 'Enter' || e.key === 'F2'){ e.preventDefault(); startEdit(cellOf(s.r1, s.c1), false); }
    else if(e.key === 'Delete' || e.key === 'Backspace'){
      e.preventDefault();
      for(let r = s.r1; r <= s.r2; r++) for(let c = s.c1; c <= s.c2; c++){ draft.rows[r].c[c] = ''; if(draft.vals) delete draft.vals[keyOf(r, c)]; }
      redraw();
    }
    else if(e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) startEdit(cellOf(s.r1, s.c1), true);   // the typed key then replaces the cell's text
  });
  // ---- formatting the selected cells ----
  const mutateSel = fn => {
    const s = sheetEdit.sel;
    if(!s){ alert('Select a cell (or drag over several cells) first.'); return; }
    for(let r = s.r1; r <= s.r2; r++) for(let c = s.c1; c <= s.c2; c++){
      const k = keyOf(r, c), st = { ...(draft.styles[k] || {}) };
      fn(st, r, c);
      if(Object.keys(st).length) draft.styles[k] = st; else delete draft.styles[k];
    }
    redraw();
  };
  const firstStyle = () => { const s = sheetEdit.sel; return s ? (draft.styles[keyOf(s.r1, s.c1)] || {}) : {}; };
  const toggle = k => { const on = !firstStyle()[k]; mutateSel(st => { if(on) st[k] = 1; else delete st[k]; }); };
  const borderOf = st => (st.bd && typeof st.bd === 'object') ? { ...st.bd } : Object.fromEntries(borderParts(st.bd).map(([side, style, color]) => [side[0], `${style}:${color}`]));
  const applyBorder = mode => {
    const s = sheetEdit.sel;
    mutateSel((st, r, c) => {
      if(mode === 'none'){ delete st.bd; return; }
      const bd = borderOf(st), m = mergeAt(r, c);
      const edge = { t: r === s.r1, b: (m ? m.r2 : r) === s.r2, l: c === s.c1, r: (m ? m.c2 : c) === s.c2 };
      const line = 'thin:000000';
      if(mode === 'all') ['t', 'r', 'b', 'l'].forEach(k => { bd[k] = line; });
      else if(mode === 'outer') ['t', 'r', 'b', 'l'].forEach(k => { if(edge[k]) bd[k] = line; });
      else { const k = { top: 't', bottom: 'b', left: 'l', right: 'r' }[mode]; if(edge[k]) bd[k] = line; }
      st.bd = bd;
    });
  };
  const doMerge = () => {
    const s = sheetEdit.sel;
    if(!s || (s.r1 === s.r2 && s.c1 === s.c2)){ alert('Select two or more cells to merge.'); return; }
    draft.merges = draft.merges.filter(m => !(m.r1 >= s.r1 && m.r2 <= s.r2 && m.c1 >= s.c1 && m.c2 <= s.c2));
    draft.merges.push({ r1: s.r1, c1: s.c1, r2: s.r2, c2: s.c2 });
    // like Excel, only the top-left cell's text survives; pictures of the other cells move to it
    for(let r = s.r1; r <= s.r2; r++) for(let c = s.c1; c <= s.c2; c++){
      if(r === s.r1 && c === s.c1) continue;
      draft.rows[r].c[c] = '';
      if(draft.vals) delete draft.vals[keyOf(r, c)];
    }
    draft.images.forEach(im => { if(im.r >= s.r1 && im.r <= s.r2 && im.c >= s.c1 && im.c <= s.c2){ im.r = s.r1; im.c = s.c1; } });
    redraw();
  };
  const doSplit = () => {
    const s = sheetEdit.sel;
    if(!s) return;
    const before = draft.merges.length;
    draft.merges = draft.merges.filter(m => !(m.r1 <= s.r2 && m.r2 >= s.r1 && m.c1 <= s.c2 && m.c2 >= s.c1));
    if(draft.merges.length === before){ alert('The selected cells are not merged.'); return; }
    redraw();
  };
  card.querySelectorAll('[data-fmt]').forEach(btn => btn.addEventListener('mousedown', e => e.preventDefault()));   // keep the selection / caret while clicking the toolbar
  card.querySelectorAll('[data-fmt]').forEach(btn => btn.addEventListener('click', () => {
    const [k, v] = btn.dataset.fmt.split(':');
    if(k === 'b' || k === 'i' || k === 'u' || k === 's') toggle(k);
    else if(k === 'ha') mutateSel(st => { st.ha = v; });
    else if(k === 'va') mutateSel(st => { st.va = v; });
    else if(k === 'wrap') mutateSel(st => { st.wr = 1; });
    else if(k === 'nowrap') mutateSel(st => { st.wr = 0; });
    else if(k === 'nobg') mutateSel(st => { delete st.bg; });
    else if(k === 'merge') doMerge();
    else if(k === 'split') doSplit();
  }));
  card.querySelector('[data-fmt-select="fn"]')?.addEventListener('change', e => mutateSel(st => { if(e.target.value === 'Calibri') delete st.fn; else st.fn = e.target.value; }));
  card.querySelector('[data-fmt-select="sz"]')?.addEventListener('change', e => mutateSel(st => { if(Number(e.target.value) === 11) delete st.sz; else st.sz = Number(e.target.value); }));
  card.querySelector('[data-fmt-select="border"]')?.addEventListener('change', e => { if(e.target.value) applyBorder(e.target.value); });
  card.querySelector('[data-fmt-color="fc"]')?.addEventListener('change', e => { const hex = e.target.value.slice(1).toUpperCase(); mutateSel(st => { if(hex === '000000') delete st.fc; else st.fc = hex; }); });
  card.querySelector('[data-fmt-color="bg"]')?.addEventListener('change', e => { const hex = e.target.value.slice(1).toUpperCase(); mutateSel(st => { st.bg = hex; }); });
  paintSel();
  // rows / columns
  card.querySelector('[data-role="sheet-add-row"]')?.addEventListener('click', () => {
    if(draft.rows.length >= MAX_ROWS){ alert(`A sheet can have up to ${MAX_ROWS} rows.`); return; }
    draft.rows.push({ c: Array(draft.colw.length).fill('') });
    redraw();
  });
  card.querySelector('[data-role="sheet-add-col"]')?.addEventListener('click', () => {
    if(draft.colw.length >= MAX_COLS){ alert(`A sheet can have up to ${MAX_COLS} columns.`); return; }
    draft.rows.forEach(r => r.c.push(''));
    draft.colw.push(13);
    redraw();
  });
  // pictures
  card.querySelectorAll('.tsheet-addpic').forEach(btn => btn.addEventListener('click', () => {
    const r = Number(btn.dataset.r), c = Number(btn.dataset.c);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if(!file) return;
      if(draft.images.length >= MAX_IMAGES){ alert(`A file can keep up to ${MAX_IMAGES} pictures.`); return; }
      const shrunk = await shrinkImage(await file.arrayBuffer(), (file.type.split('/')[1] || '').toLowerCase(), 480, 0.7);
      if(!shrunk){ alert('Could not read that picture (use PNG, JPG, GIF or WebP).'); return; }
      const k = 120 / Math.max(shrunk.w, shrunk.h);
      draft.images.push({ r, c, x: 0, y: 0, w: Math.round(shrunk.w * k), h: Math.round(shrunk.h * k), src: shrunk.src, cp: 1 });
      redraw();
    });
    input.click();
  }));
  card.querySelectorAll('[data-pic-remove]').forEach(btn => btn.addEventListener('click', () => {
    draft.images.splice(Number(btn.dataset.imgIndex), 1);
    redraw();
  }));
  card.querySelectorAll('[data-pic-scale]').forEach(btn => btn.addEventListener('click', () => {
    const im = draft.images[Number(btn.dataset.imgIndex)];
    const k = Number(btn.dataset.picScale);
    im.w = Math.min(420, Math.max(30, Math.round(im.w * k)));
    im.h = Math.max(20, Math.round(im.h * k));
    redraw();
  }));
  // dragging the edge of a column letter / row number
  const drag = (grip, onMove) => grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX, y0 = e.clientY;
    const move = ev => onMove(ev.clientX - x0, ev.clientY - y0);
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
  card.querySelectorAll('.tsheet-colgrip').forEach(grip => {
    const c = Number(grip.dataset.col);
    const col = table.querySelectorAll('colgroup col')[c + 1];
    const w0 = parseFloat(col.style.width), tw0 = parseFloat(table.style.width);
    drag(grip, dx => {
      const w = Math.max(24, w0 + dx);
      col.style.width = w + 'px';
      table.style.width = (tw0 + w - w0) + 'px';
      draft.colw[c] = Math.round((w - 5) / 7 * 10) / 10;
    });
  });
  card.querySelectorAll('.tsheet-rowgrip').forEach(grip => {
    const r = Number(grip.dataset.row);
    const tr = grip.closest('tr');
    const h0 = tr.getBoundingClientRect().height;
    drag(grip, (dx, dy) => {
      const h = Math.max(18, h0 + dy);
      tr.style.height = h + 'px';
      draft.rowh[r] = Math.round(h * 0.75 * 10) / 10;
    });
  });
  // save / cancel
  card.querySelector('[data-role="sheet-edit-cancel"]')?.addEventListener('click', () => {
    if(!confirm('Discard the changes you made to this table?')) return;
    sheetEdit = null;
    rerender();
  });
  card.querySelector('[data-role="sheet-edit-save"]')?.addEventListener('click', () => {
    const next = { ...f, sheets: f.sheets.map((s, i) => i === sheetEdit.sheetIndex ? draft : s) };
    const size = JSON.stringify(next).length;
    if(size > MAX_FILE_JSON){ alert(`This table is now too large to keep inside the evaluation (${Math.round(size / 1000)} KB; the limit is ${MAX_FILE_JSON / 1000} KB). Remove some pictures or rows and save again.`); return; }
    if(JSON.stringify(t).length - JSON.stringify(f).length + size > MAX_TRIAL_JSON){ alert('This evaluation is already close to the size limit (photos take most of it), so these changes cannot be saved.'); return; }
    const before = t.excelFiles;
    t.excelFiles = before.map(x => x.id === f.id ? next : x);
    try{ scheduleTrialSave(t); }catch(err){ t.excelFiles = before; alert('Could not save: ' + (err.message || err)); return; }
    sheetEdit = null;
    rerender();
  });
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
        ({ sheets, skipped } = await parseWorkbook(file, 300, 0.55, 120));
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
    card.querySelector('[data-role="edit-trial-sheet"]')?.addEventListener('click', () => {
      const idx = Math.min(activeSheet.get(f.id) || 0, f.sheets.length - 1);
      sheetEdit = { trialId: t.id, fileId: f.id, sheetIndex: idx, draft: normalizeDraft(clone(f.sheets[idx])) };
      rerender();
    });
    if(sheetEdit && sheetEdit.trialId === t.id && sheetEdit.fileId === f.id && isEditing) wireSheetEditor(card, t, f, rerender);
    card.querySelector('[data-role="remove-trial-sheet"]')?.addEventListener('click', () => {
      // removing is asked twice over: the warning below, and the person's password (same as editing a project cell)
      requestAuthConfirm('Confirm removal', `Remove "${f.name}" from this evaluation? Its table and pictures here are deleted (the original file on your computer is not touched). Enter your password to remove it.`, () => {
        t.excelFiles = (t.excelFiles || []).filter(x => x.id !== f.id);
        scheduleTrialSave(t);
        rerender();
      });
    });
  });
}

// the stored table back out as an .xlsx (what each cell showed, with bold / fill / merged cells)
// one worksheet per stored sheet of `f`, added to an existing workbook `wb` (sheet names stay unique through `used`,
// a Set of lower-cased names already taken in that workbook; `prefix` goes in front of each name)
export function addAttachedSheets(wb, f, used = new Set(), prefix = ''){
  f.sheets.forEach((s, i) => {
    let name = (prefix + String(s.name || `Sheet ${i + 1}`)).replace(/[\[\]:*?\/\\]/g, '-').slice(0, 31) || `Sheet ${i + 1}`, k = 2;
    while(used.has(name.toLowerCase())) name = `${name.slice(0, 27)} (${k++})`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name);
    const widths = [];
    const v2 = !!s.v2;
    const ownBorders = v2 || Object.values(s.styles || {}).some(x => x.bd);   // the file's own borders only; none were added
    if(s.ng) ws.views = [{ showGridLines: false }];
    s.rows.forEach((rowObj, r) => {
      rowObj.c.forEach((text, c) => {
        const cell = ws.getCell(r + 1, c + 1);
        const key = `${r},${c}`;
        const raw = s.vals ? s.vals[key] : undefined;
        if(raw !== undefined) cell.value = typeof raw === 'string' && raw.startsWith('D:') ? new Date(raw.slice(2)) : raw;
        else cell.value = !s.vals && text !== '' && /^-?\d+(\.\d+)?$/.test(text) && String(Number(text)) === text ? Number(text) : text;
        const st = s.styles?.[key] || {};
        if(st.nf && raw !== undefined) cell.numFmt = st.nf;
        cell.alignment = { vertical: st.va || (v2 ? 'bottom' : 'top'), horizontal: st.ha, wrapText: wrapOf(st, v2) };
        if(ownBorders){
          const parts = borderParts(st.bd);
          if(parts.length) cell.border = Object.fromEntries(parts.map(([side, style, color]) => [side, { style, color: { argb: 'FF' + color } }]));
        }else{
          const grey = { style: 'thin', color: { argb: 'FFBFBFBF' } };
          cell.border = { top: grey, left: grey, bottom: grey, right: grey };
        }
        if(st.b || st.i || st.u || st.s || st.sz || st.fc || st.fn) cell.font = { name: st.fn || 'Calibri', bold: !!st.b, italic: !!st.i, underline: !!st.u, strike: !!st.s, size: st.sz || 11, ...(st.fc ? { color: { argb: 'FF' + st.fc } } : {}) };
        if(st.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + st.bg } };
        const longest = Math.max(...String(text).split('\n').map(x => x.length), 0);
        widths[c] = Math.max(widths[c] || 8, Math.min(longest + 2, 60));
      });
    });
    // the file's own column widths and row heights win over the guessed ones (a v2 import has no guesses at all: Excel's default 8.43)
    const nCols = Math.max(...s.rows.map(r => r.c.length), 1);
    if(v2) for(let c = 0; c < nCols; c++) widths[c] = 8.43;
    (s.colw || []).forEach((w, c) => { if(w) widths[c] = w; });
    Object.entries(s.rowh || {}).forEach(([r, h]) => { ws.getRow(Number(r) + 1).height = h; });
    (s.images || []).filter(im => im.cp).forEach(im => {
      widths[im.c] = Math.max(widths[im.c] || 8, Math.ceil(im.w / 7) + 2);
      const row = ws.getRow(im.r + 1);
      row.height = Math.max(row.height || 15, Math.ceil(im.h * 0.75) + 4);
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
}

export async function exportSheetsFile(f){
  if(!window.ExcelJS){ alert('Excel export isn\'t available right now (ExcelJS failed to load) -- check your connection and try again.'); return; }
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Forge';
  wb.created = new Date();
  addAttachedSheets(wb, f);
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
