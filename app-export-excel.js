// "Export All (Excel)" -- every table of Forge as one database-style workbook plus its photos/files, so the data can
// live in Excel if Forge is ever retired. Unlike the per-recipe / per-test Excel exports (made to be read), this one
// is made to be machine-readable and complete:
//   * one sheet per table, one row per record, a stable `id` first and `root_id` / `parent_key` on every child table
//     to join them (Recipes.id <-> Recipes_lines.root_id, Projects.id <-> Projects_products.root_id, ...);
//   * nested lists and maps become child sheets instead of being dropped or crushed into one cell;
//   * every photo / attachment is written to an images/ folder in the ZIP and the cell holds its relative path;
//   * a README sheet lists every sheet, its row count and what is deliberately not included.
// Everything is read straight from Firestore at the moment of the export (not from what happens to be open in the app).
import { db } from './app.js';
import { APP_VERSION } from './app-changelog.js';
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CELL_LIMIT = 32000;           // Excel allows 32,767 characters in a cell
const EPOCH_MIN = 1e11, EPOCH_MAX = 4e12;
const DATA_URL = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,/i;
const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'application/pdf': 'pdf' };

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = v => v === null || ['string', 'number', 'boolean'].includes(typeof v);

class Book {
  constructor(){ this.tables = new Map(); this.images = []; this.truncated = 0; this.skipped = []; }
  table(name){
    if(!this.tables.has(name)) this.tables.set(name, { name, rows: [], cols: [] });
    return this.tables.get(name);
  }
  addRow(name, row){
    const t = this.table(name);
    for(const k of Object.keys(row)) if(!t.cols.includes(k)) t.cols.push(k);
    t.rows.push(row);
  }
}

function pad(n){ return String(n).padStart(2, '0'); }
function epochText(ms){
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const safe = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60);

// One scalar -> what goes in a cell (photos / files become a path inside the ZIP).
function cellValue(book, ctx, col, v){
  if(v === null || v === undefined) return '';
  if(typeof v === 'string'){
    const m = DATA_URL.exec(v);
    if(m){
      const ext = EXT_BY_MIME[m[1].toLowerCase()] || m[1].split('/')[1].replace(/[^a-z0-9]/gi, '') || 'bin';
      const n = book.images.length + 1;
      const path = `images/${safe(ctx.table)}/${safe(ctx.rootId)}_${safe(col)}_${n}.${ext}`;
      book.images.push({ path, base64: v.slice(m[0].length) });
      return path;
    }
    // control characters (other than tab / line breaks) make Excel report a corrupt file
    const clean = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    if(clean.length > CELL_LIMIT){ book.truncated++; return clean.slice(0, CELL_LIMIT) + ' ...[TRUNCATED]'; }
    return clean;
  }
  if(typeof v === 'number'){
    const last = col.split('.').pop();
    if((/At$/.test(last) || last === 'at') && v >= EPOCH_MIN && v <= EPOCH_MAX) return epochText(v);
    return Number.isFinite(v) ? v : '';
  }
  return v;
}

// Writes one record (and, below it, its nested lists / maps as child tables).
function writeRecord(book, table, obj, base, rootId, opts = {}){
  const skip = opts.skip || new Set();
  const row = { ...base };
  const children = [];
  const visit = (prefix, o) => {
    for(const [k, v] of Object.entries(o)){
      if(!prefix && skip.has(k)) continue;
      const col = prefix + k;
      if(v === null || v === undefined) continue;
      if(isScalar(v)){ row[col] = cellValue(book, { table, rootId }, col, v); continue; }
      if(Array.isArray(v)){
        if(!v.length) continue;
        if(v.every(isScalar)){ row[col] = v.map(x => cellValue(book, { table, rootId }, col, x)).join('\n'); continue; }
        children.push({ kind: 'list', col, items: v });
        continue;
      }
      const vals = Object.values(v);
      if(!vals.length) continue;
      if(vals.every(isPlainObject)){ children.push({ kind: 'keyed', col, entries: Object.entries(v) }); continue; }
      if(vals.every(Array.isArray)){ children.push({ kind: 'keyedLists', col, entries: Object.entries(v) }); continue; }
      visit(col + '.', v);
    }
  };
  visit('', obj);
  const ownKey = obj.id != null && obj.id !== '' ? String(obj.id) : (base.row != null ? String(base.row) : String(rootId));
  if(row.id === undefined && !opts.isChild && obj.id === undefined && opts.docId !== undefined) row.id = opts.docId;
  book.addRow(table, row);

  const writeChild = (path, item, key, i) => {
    const b = { root_id: rootId, parent_key: ownKey, row: i + 1 };
    if(key !== undefined) b.key = key;
    if(isPlainObject(item)) writeRecord(book, path, item, b, rootId, { isChild: true });
    else book.addRow(path, { ...b, value: typeof item === 'object' ? JSON.stringify(item) : item });
  };
  for(const c of children){
    const path = `${table}.${c.col}`;
    if(c.kind === 'list') c.items.forEach((item, i) => writeChild(path, item, undefined, i));
    else if(c.kind === 'keyed') c.entries.forEach(([key, item], i) => writeChild(path, item, key, i));
    else c.entries.forEach(([key, list]) => list.forEach((item, i) => writeChild(path, item, key, i)));
  }
}

// ---- Recipes: the ingredient tree becomes one flat "lines" table (Part path + order), version history a list ----
function writeRecipeExtras(book, r, materialsById){
  const rootId = String(r.id);
  let order = 0;
  const walk = (part, path, level) => {
    const here = path ? `${path} > ${part.name || ''}` : (part.name || '');
    const { items, ...partFields } = part;
    book.addRow('Recipes.lines', {
      root_id: rootId, row: ++order, level, kind: 'part', path: here, name: part.name || '',
      percent: part.percent ?? '', prepYieldPct: part.prepYieldPct ?? '',
      ...Object.fromEntries(Object.entries(partFields).filter(([k, v]) => !['name', 'kind', 'percent', 'prepYieldPct'].includes(k) && isScalar(v)))
    });
    for(const it of (Array.isArray(items) ? items : [])){
      if(it && it.kind === 'part') { walk(it, here, level + 1); continue; }
      const m = it && it.materialId ? materialsById.get(it.materialId) : null;
      book.addRow('Recipes.lines', {
        root_id: rootId, row: ++order, level: level + 1, kind: 'ingredient', path: here, name: it?.name || '',
        materialId: it?.materialId || '', materialNameEn: m ? (m.nameEn || '') : '', materialPrice: m ? (m.price || '') : '',
        percent: it?.percent ?? '', weight: it?.weight ?? '',
        ...Object.fromEntries(Object.entries(it || {}).filter(([k, v]) => !['name', 'kind', 'materialId', 'percent', 'weight'].includes(k) && isScalar(v)).map(([k, v]) => [k, cellValue(book, { table: 'Recipes.lines', rootId }, k, v)]))
      });
    }
  };
  (Array.isArray(r.parts) ? r.parts : []).forEach(p => walk(p, '', 0));
  (Array.isArray(r.versionsMeta) ? r.versionsMeta : []).forEach((v, i) => {
    book.addRow('Recipes.versions', { root_id: rootId, row: i + 1, id: v.id, label: v.label || '', savedAt: typeof v.savedAt === 'number' ? epochText(v.savedAt) : '' });
  });
}

async function fetchAll(name){
  const snap = await getDocs(collection(db, name));
  return snap.docs.map(d => ({ docId: d.id, data: d.data() }));
}

function sheetNames(names){
  const used = new Set(), out = new Map();
  for(const full of names){
    let base = full.replace(/[\[\]:*?\/\\]/g, '-').slice(0, 31);
    let name = base, k = 2;
    while(used.has(name.toLowerCase())){ const suffix = `~${k++}`; name = base.slice(0, 31 - suffix.length) + suffix; }
    used.add(name.toLowerCase());
    out.set(full, name);
  }
  return out;
}

const PREFERRED = ['id', 'root_id', 'parent_key', 'key', 'row', 'name', 'code', 'label'];
function orderedCols(cols){
  return [...PREFERRED.filter(c => cols.includes(c)), ...cols.filter(c => !PREFERRED.includes(c))];
}

export async function exportEverythingToExcel(onProgress = () => {}){
  if(!window.ExcelJS){ alert('Excel export is not available right now (ExcelJS failed to load) -- check your connection and try again.'); return; }
  const notes = [];

  const sources = [
    ['Recipes', 'recipes'], ['Materials', 'ingredientMaster'], ['Projects', 'projects'], ['Trials', 'trials'],
    ['Products', 'productList'], ['SampleSubmissions', 'sampleSubmissions'], ['Series', 'recipeSeries'],
    ['CompareSets', 'compareSets'], ['Users', 'userApprovals'], ['EvaluationResponses', 'evaluationResponses'],
    ['BdProposals', 'bdProposals'], ['Trash', 'trash'], ['ActivityLog', 'activityEvents']
  ];
  const raw = {};
  for(const [table, coll] of sources){
    onProgress(`Reading ${coll}...`);
    try{ raw[table] = await fetchAll(coll); }
    catch(err){ raw[table] = []; notes.push(`${coll}: not exported (${err.code || err.message})`); }
  }
  onProgress('Reading reference lists...');
  let metaDoc = null;
  try{
    const snap = await getDocs(collection(db, 'metaLists'));
    snap.docs.forEach(d => { if(d.id === 'shared') metaDoc = d.data(); });
  }catch(err){ notes.push(`metaLists: not exported (${err.code || err.message})`); }

  const { wb, book } = buildEverything(raw, metaDoc, notes, onProgress);

  onProgress('Packing the file...');
  return packAndDownload(wb, book, notes);
}

// raw: { Recipes: [{docId, data}], Materials: [...], ... } as read from Firestore; metaDoc: the shared Reference Lists document.
export function buildEverything(raw, metaDoc, notes = [], onProgress = () => {}){
  const book = new Book();
  onProgress('Building tables...');
  const materialsById = new Map((raw.Materials || []).map(m => [m.data.id || m.docId, m.data]));

  for(const { docId, data } of raw.Recipes){
    const id = String(data.id || docId);
    writeRecord(book, 'Recipes', data, {}, id, { skip: new Set(['parts', 'versions', 'versionsMeta']), docId });
    writeRecipeExtras(book, { ...data, id }, materialsById);
  }
  const simple = ['Materials', 'Projects', 'Trials', 'Products', 'SampleSubmissions', 'Series', 'CompareSets', 'Users',
    'EvaluationResponses', 'BdProposals', 'ActivityLog'];
  for(const table of simple){
    for(const { docId, data } of raw[table]){
      const rootId = String(data.id || docId);
      writeRecord(book, table, data, { id: rootId }, rootId, { docId });
    }
  }
  // Trash: what was deleted, when and by whom (the deleted record itself is not copied here)
  for(const { docId, data } of raw.Trash){
    const { data: _snapshot, ...rest } = data;
    writeRecord(book, 'Trash', rest, { id: docId }, docId, { docId });
  }
  // Reference lists: every list in the shared document becomes its own table
  if(metaDoc){
    for(const [listName, items] of Object.entries(metaDoc)){
      if(!Array.isArray(items)) continue;
      items.forEach((it, i) => {
        if(isPlainObject(it)) writeRecord(book, `Ref.${listName}`, it, {}, String(it.id || `${listName}-${i + 1}`), { docId: String(it.id || '') });
        else book.addRow(`Ref.${listName}`, { id: `${listName}-${i + 1}`, value: it });
      });
    }
  }

  onProgress('Writing the workbook...');
  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Forge';
  wb.created = new Date();
  const order = [...book.tables.keys()].sort((a, b) => {
    const rootA = a.split('.')[0], rootB = b.split('.')[0];
    const idx = n => { const i = ['Recipes', 'Materials', 'Projects', 'Trials', 'Products', 'SampleSubmissions', 'Series', 'CompareSets', 'Users', 'EvaluationResponses', 'BdProposals', 'Trash', 'ActivityLog', 'Ref'].indexOf(n); return i < 0 ? 99 : i; };
    return idx(rootA) - idx(rootB) || a.localeCompare(b);
  });
  const names = sheetNames(order);

  const readme = wb.addWorksheet('README');
  readme.columns = [{ width: 34 }, { width: 34 }, { width: 12 }, { width: 80 }];
  const title = readme.addRow([`Forge -- full data export (${epochText(Date.now())}, app v${APP_VERSION})`]);
  title.font = { bold: true, size: 14 };
  readme.addRow([]);
  [
    'How to read this workbook: one sheet per table, one row per record. Every record has an `id`.',
    'Child sheets (names contain a dot, e.g. Recipes.processes) have `root_id` = the id of the main record they belong to,',
    '`parent_key` = the id (or row number) of the nested record directly above, and `row` = the position inside its list.',
    'Recipes.lines holds the full ingredient tree: `path` is the Part / Sub-part chain, `level` its depth, `row` the order.',
    'Photos and attached files are in the images/ folder of the ZIP; the cell holds the relative path of the file.',
    'Edits to the Materials, Products and Projects sheets can be brought back with Import (Excel) in Data Management (admin only).',
    'Dates stored as timestamps are written as yyyy-mm-dd hh:mm:ss (local time of the computer that exported).',
    'Not included: the full snapshots of Version History (only the list: Recipes.versions), the content of deleted items in the Trash,',
    'sign-in events and presence data, and passwords (Forge never stores any -- sign-in is handled by Firebase).'
  ].forEach(l => readme.addRow([l]));
  readme.addRow([]);
  const head = readme.addRow(['Table (path)', 'Sheet name', 'Rows', 'Columns']);
  head.font = { bold: true };
  for(const full of order){
    const t = book.tables.get(full);
    const row = readme.addRow([full, names.get(full), t.rows.length, orderedCols(t.cols).join(', ').slice(0, 1500)]);
    row.getCell(4).alignment = { wrapText: true, vertical: 'top' };
  }
  readme.addRow([]);
  readme.addRow([`Photos / files exported: ${book.images.length}`]);
  readme.addRow([`Cells shortened because they exceeded Excel's cell limit: ${book.truncated}`]);
  notes.forEach(n => readme.addRow([n]));

  for(const full of order){
    const t = book.tables.get(full);
    const cols = orderedCols(t.cols);
    const ws = wb.addWorksheet(names.get(full));
    ws.columns = cols.map(c => ({ header: c, key: c, width: Math.min(48, Math.max(10, c.length + 2)) }));
    t.rows.forEach(r => ws.addRow(cols.map(c => r[c] === undefined ? '' : r[c])));
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16294A' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  }

  return { wb, book };
}

async function packAndDownload(wb, book, notes){
  const order = [...book.tables.keys()];
  const buffer = await wb.xlsx.writeBuffer();
  const stamp = new Date().toISOString().slice(0, 10);
  const folder = `Forge-Export-${stamp}`;
  let blob, fileName;
  if(window.JSZip){
    const zip = new window.JSZip();
    zip.file(`${folder}/Forge-All-Data.xlsx`, buffer);
    book.images.forEach(img => zip.file(`${folder}/${img.path}`, img.base64, { base64: true }));
    blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    fileName = `${folder}.zip`;
  }else{
    blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    fileName = `${folder}.xlsx`;
    alert('The photos could not be packed (the ZIP library did not load), so only the Excel file is downloaded.');
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { sheets: order.length, rows: [...book.tables.values()].reduce((s, t) => s + t.rows.length, 0), images: book.images.length, notes };
}
