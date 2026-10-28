// "Import (Excel)" -- bring edits made in the workbook from Export All (Excel + photos) back into Forge.
//
// Deliberately conservative: it only touches records the person can safely bulk-edit in a spreadsheet, shows exactly
// what would change BEFORE anything is written, never deletes anything, and saves a file with the previous values of
// everything it changed.
//   * Sheets read: Materials, Products, Projects (the main table of each; nested child sheets such as
//     Materials.subIngredients or Projects.products are NOT imported, and neither are photos / files).
//   * A row with an `id` that exists  -> only the cells that differ from what is stored are updated.
//   * A row with an EMPTY `id`        -> a new record is created (it needs a name).
//   * A row whose `id` is not found   -> skipped and reported (so a typo can never create a duplicate).
//   * System columns (id, createdAt, createdBy, updatedAt, updatedBy) are never changed from the file.
// Cell values are converted to the type already used in that field (text stays text, a number field stays a number).
import { db, uid, currentUser, escapeHtml, isCurrentUserAdmin, logActivityEvent } from './app.js';
import { collection, doc, getDocs, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const TARGETS = [
  { sheet: 'Materials', coll: 'ingredientMaster', entity: 'material', nameOf: d => d.nameEn || d.nameTh || '', needs: d => !!(d.nameEn || d.nameTh) },
  { sheet: 'Products',  coll: 'productList',      entity: 'product',  nameOf: d => d.name || d.code || '',   needs: d => !!d.name },
  { sheet: 'Projects',  coll: 'projects',         entity: 'project',  nameOf: d => d.name || '',             needs: d => !!d.name }
];
const SYSTEM_COLS = new Set(['id', 'root_id', 'parent_key', 'key', 'row', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'updatedSession']);
const MAX_SHOWN = 150;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDataUrl = v => typeof v === 'string' && /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(v);

function plain(v){
  if(v === null || v === undefined) return '';
  if(v instanceof Date){
    const p = n => String(n).padStart(2, '0');
    return `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())}`;
  }
  if(typeof v === 'object'){
    if(v.richText) return v.richText.map(t => t.text).join('');
    if('result' in v) return plain(v.result);
    if(v.text !== undefined) return String(v.text);
    if(v.hyperlink) return String(v.hyperlink);
    return String(v);
  }
  return v;
}
function getAt(obj, path){
  let cur = obj;
  for(const k of path.split('.')){
    if(cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}
function setAt(obj, path, value){
  const keys = path.split('.');
  let cur = obj;
  keys.slice(0, -1).forEach(k => { if(!isObj(cur[k])) cur[k] = {}; cur = cur[k]; });
  cur[keys[keys.length - 1]] = value;
}
function emptyLike(v){
  if(Array.isArray(v)) return [];
  if(isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, emptyLike(x)]));
  if(typeof v === 'boolean') return false;
  return '';
}

// the value a cell should have, given how the field is typed in the existing data; { skip } when it must not be imported
function convert(cell, sample){
  const raw = plain(cell);
  if(typeof raw === 'string' && /^images\//.test(raw)) return { skip: 'photo / file path' };
  if(isDataUrl(sample)) return { skip: 'photo / file' };
  if(isObj(sample) || (Array.isArray(sample) && sample.some(x => isObj(x) || Array.isArray(x)))) return { skip: 'nested data (child sheet)' };
  if(Array.isArray(sample)){
    const numeric = sample.length > 0 && sample.every(x => typeof x === 'number');
    const parts = String(raw === '' ? '' : raw).split('\n').map(s => s.trim()).filter(Boolean);
    if(numeric){
      const nums = parts.map(Number);
      if(nums.some(n => !Number.isFinite(n))) return { error: 'expected numbers separated by line breaks' };
      return { value: nums };
    }
    return { value: parts };
  }
  if(typeof sample === 'boolean'){
    if(typeof raw === 'boolean') return { value: raw };
    const s = String(raw).trim().toLowerCase();
    if(['true', '1', 'yes', 'y'].includes(s)) return { value: true };
    if(['false', '0', 'no', 'n', ''].includes(s)) return { value: false };
    return { error: 'expected TRUE or FALSE' };
  }
  if(typeof sample === 'number'){
    if(raw === '') return { value: '' };
    const n = Number(raw);
    return Number.isFinite(n) ? { value: n } : { error: 'expected a number' };
  }
  return { value: raw === '' ? '' : String(raw) };   // text stays text (a typed 25 becomes "25")
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function readSheet(ws){
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => { headers[col] = String(plain(cell.value)).trim(); });
  const rows = [];
  ws.eachRow((row, n) => {
    if(n === 1) return;
    const cells = {};
    let any = false;
    headers.forEach((h, col) => {
      if(!h) return;
      const v = plain(row.getCell(col).value);
      cells[h] = v;
      if(v !== '') any = true;
    });
    if(any) rows.push({ rowNumber: n, cells });
  });
  return { headers: headers.filter(Boolean), rows };
}

// Works out what an import of one sheet would do (nothing is written here).
function planSheet(target, sheet, existing){
  const byId = new Map(existing.map(d => [String(d.id), d]));
  // how each column is typed in the stored data (first record that has a value), for typing cells of new records too
  const sampleOf = path => { for(const d of existing){ const v = getAt(d, path); if(v !== undefined && v !== null) return v; } return undefined; };
  const plan = { target, updates: [], creates: [], errors: [], skippedCols: new Map(), unchanged: 0 };
  const importableCols = sheet.headers.filter(h => !SYSTEM_COLS.has(h));

  // template for new records: every top-level field seen in the stored data, emptied
  const template = {};
  existing.forEach(d => Object.entries(d).forEach(([k, v]) => { if(!(k in template) && !SYSTEM_COLS.has(k)) template[k] = emptyLike(v); }));

  for(const { rowNumber, cells } of sheet.rows){
    const idCell = String(cells.id ?? '').trim();
    const isNew = idCell === '';
    const cur = isNew ? null : byId.get(idCell);
    if(!isNew && !cur){
      plan.errors.push(`Row ${rowNumber}: id "${idCell}" was not found, so the row was skipped (leave id empty to create a new record).`);
      continue;
    }
    const changes = {};
    const newDoc = isNew ? JSON.parse(JSON.stringify(template)) : null;
    for(const col of importableCols){
      const sample = isNew ? sampleOf(col) : getAt(cur, col);
      const cell = cells[col];
      if(sample === undefined || sample === null){
        // a field this record does not have yet: only a non-empty text value is taken
        if(cell === '' || cell === undefined) continue;
        if(isNew){ const c = convert(cell, ''); if(c.value !== undefined) setAt(newDoc, col, c.value); continue; }
        if(typeof cell === 'string' && /^images\//.test(cell)) continue;
        changes[col] = { from: undefined, to: typeof cell === 'number' || typeof cell === 'boolean' ? cell : String(cell) };
        continue;
      }
      const c = convert(cell, sample);
      if(c.skip){ plan.skippedCols.set(col, c.skip); continue; }
      if(c.error){ plan.errors.push(`Row ${rowNumber}, column "${col}": ${c.error} (got "${cell}") -- cell ignored.`); continue; }
      if(isNew){ setAt(newDoc, col, c.value); continue; }
      if(!same(c.value, sample)) changes[col] = { from: sample, to: c.value };
    }
    if(isNew){
      if(!target.needs(newDoc)){ plan.errors.push(`Row ${rowNumber}: a new record needs a name, so the row was skipped.`); continue; }
      plan.creates.push({ rowNumber, doc: newDoc, label: target.nameOf(newDoc) });
    }else if(Object.keys(changes).length){
      plan.updates.push({ id: cur.id, label: target.nameOf(cur) || cur.id, changes });
    }else plan.unchanged++;
  }
  return plan;
}

function fmt(v){
  if(v === undefined) return '(empty)';
  const s = Array.isArray(v) ? v.join(' | ') : String(v);
  return s === '' ? '(empty)' : (s.length > 80 ? s.slice(0, 77) + '...' : s);
}

function reportHtml(plans, missingSheets){
  const sections = plans.map(p => {
    const t = p.target;
    const upd = p.updates.slice(0, MAX_SHOWN).map(u => `
      <div class="imp-item"><b>${escapeHtml(u.label)}</b>
        ${Object.entries(u.changes).map(([col, ch]) => `<div class="imp-change"><code>${escapeHtml(col)}</code>: ${escapeHtml(fmt(ch.from))} &rarr; <b>${escapeHtml(fmt(ch.to))}</b></div>`).join('')}
      </div>`).join('');
    const crt = p.creates.slice(0, MAX_SHOWN).map(c => `<div class="imp-item">+ <b>${escapeHtml(c.label)}</b> (row ${c.rowNumber})</div>`).join('');
    return `
      <div class="imp-section">
        <div class="imp-title">${escapeHtml(t.sheet)}: <b>${p.updates.length}</b> to update, <b>${p.creates.length}</b> new, ${p.unchanged} unchanged${p.errors.length ? `, <span style="color:var(--danger)">${p.errors.length} problem(s)</span>` : ''}</div>
        ${p.skippedCols.size ? `<div class="imp-note">Columns not imported: ${[...p.skippedCols.entries()].map(([c, why]) => `<code>${escapeHtml(c)}</code> (${escapeHtml(why)})`).join(', ')}</div>` : ''}
        ${p.errors.slice(0, 40).map(e => `<div class="imp-error">${escapeHtml(e)}</div>`).join('')}
        ${p.updates.length > MAX_SHOWN ? `<div class="imp-note">Showing the first ${MAX_SHOWN} of ${p.updates.length} updates.</div>` : ''}
        ${upd}${crt}
      </div>`;
  }).join('');
  const missing = missingSheets.length ? `<div class="imp-note">Not found in the file (skipped): ${missingSheets.map(escapeHtml).join(', ')}</div>` : '';
  return sections + missing;
}

function downloadJson(name, obj){
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function applyPlans(plans){
  const me = currentUser?.email || '';
  const now = Date.now();
  // previous values first, so the change can be reversed by hand
  const undo = {
    importedAt: new Date(now).toISOString(), by: me,
    note: 'Previous values of every field the Excel import changed (updates) and the ids of records it created. Nothing was deleted.',
    updates: plans.flatMap(p => p.updates.map(u => ({ collection: p.target.coll, id: u.id, label: u.label, previous: Object.fromEntries(Object.entries(u.changes).map(([k, ch]) => [k, ch.from === undefined ? null : ch.from])) }))),
    created: []
  };
  const ops = [];
  for(const p of plans){
    for(const u of p.updates){
      const data = { updatedAt: now, updatedBy: me };
      Object.entries(u.changes).forEach(([col, ch]) => { data[col] = ch.to; });
      ops.push({ kind: 'update', ref: doc(db, p.target.coll, u.id), data });
    }
    for(const c of p.creates){
      const id = uid();
      const data = { ...c.doc, id, createdAt: now, createdBy: me, updatedAt: now, updatedBy: me };
      undo.created.push({ collection: p.target.coll, id, label: c.label });
      ops.push({ kind: 'set', ref: doc(db, p.target.coll, id), data });
    }
  }
  downloadJson(`forge-excel-import-undo-${new Date(now).toISOString().slice(0, 10)}.json`, undo);
  for(let i = 0; i < ops.length; i += 400){
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach(o => (o.kind === 'update' ? batch.update(o.ref, o.data) : batch.set(o.ref, o.data)));
    await batch.commit();
  }
  plans.forEach(p => {
    if(p.updates.length || p.creates.length){
      logActivityEvent('updated', p.target.entity, `Excel import: ${p.updates.length} updated, ${p.creates.length} new`);
    }
  });
  return { updated: plans.reduce((s, p) => s + p.updates.length, 0), created: plans.reduce((s, p) => s + p.creates.length, 0) };
}

function showReview(plans, missingSheets){
  return new Promise(resolve => {
    document.getElementById('excelImportOverlay')?.remove();
    const total = plans.reduce((s, p) => s + p.updates.length + p.creates.length, 0);
    const overlay = document.createElement('div');
    overlay.id = 'excelImportOverlay';
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `
      <div class="modal" style="max-width:760px;">
        <div class="modal-header"><div class="modal-title">Import from Excel &mdash; review</div></div>
        <div class="modal-body" style="max-height:60vh;overflow:auto;">
          <p style="font-size:13px;color:var(--text-dim);margin-top:0;">Nothing has been saved yet. Only the cells that differ from what Forge holds are listed. Nothing is ever deleted; a file with the previous values is downloaded when you apply.</p>
          ${reportHtml(plans, missingSheets)}
        </div>
        <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;">
          <button type="button" class="btn" data-role="imp-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" data-role="imp-apply" ${total ? '' : 'disabled'}>Apply ${total} change${total === 1 ? '' : 's'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = v => { overlay.remove(); resolve(v); };
    overlay.querySelector('[data-role="imp-cancel"]').addEventListener('click', () => close(false));
    overlay.querySelector('[data-role="imp-apply"]').addEventListener('click', () => close(true));
  });
}

export async function importFromExcelFile(file){
  if(!isCurrentUserAdmin()){ alert('Importing from Excel is limited to the admin account.'); return; }
  if(!window.ExcelJS){ alert('Excel is not available right now (ExcelJS failed to load) -- check your connection and try again.'); return; }
  let wb;
  try{
    wb = new window.ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
  }catch(err){
    alert('That file could not be read as an Excel workbook (.xlsx): ' + (err.message || err));
    return;
  }
  const plans = [], missing = [];
  for(const target of TARGETS){
    const ws = wb.getWorksheet(target.sheet);
    if(!ws){ missing.push(target.sheet); continue; }
    const sheet = await readSheet(ws);
    if(!sheet.headers.includes('id')){ missing.push(`${target.sheet} (no "id" column)`); continue; }
    const snap = await getDocs(collection(db, target.coll));
    const existing = snap.docs.map(d => ({ ...d.data(), id: d.data().id || d.id }));
    plans.push(planSheet(target, sheet, existing));
  }
  if(!plans.length){ alert('None of the sheets Forge can import (Materials, Products, Projects) were found in this file. Use the workbook from Export All (Excel + photos).'); return; }
  const go = await showReview(plans, missing);
  if(!go) return;
  const res = await applyPlans(plans);
  alert(`Import finished: ${res.updated} record(s) updated, ${res.created} created. The file with the previous values was downloaded (forge-excel-import-undo-...json) -- keep it until you have checked the result.`);
}
