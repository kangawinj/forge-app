/* ---------- Components & Process: tree table ----------
   One table holds the whole formula -- the recipe, every Part and Sub-part,
   and every ingredient -- as an indented, collapsible tree, so a deeply
   nested recipe can be read (and edited) on one screen. Columns:
   Component | Yield | Prepare (g) | Formula (g) | % of parent | note | "...".
   It is only a different VIEW over the same recipe data: every figure comes
   from the same functions the old inline tree uses (recomputeFromWeights,
   partTotalWeight, partPrepareWeight, computePrepareWeight ...), and every
   edit follows the same rules:
     - a Formula weight is typed directly; the % of its siblings is derived;
     - a % back-solves the weight holding every other sibling fixed
       (pct = w / (w + others));
     - a Part's weight / % scales everything inside it proportionally;
     - a Part's own Yield is typed on its row (an ingredient's Yield only ever
       comes from its library variant, so it is shown read-only);
     - an ingredient only gets a weight once its name is in the library.
   Values are shown as text; click one to edit it in place (Enter = confirm,
   Esc = cancel). On narrow screens (iPad portrait, phones) the table keeps
   just Component / Formula / % and a tap opens an edit sheet with the rest
   (Done keeps, Cancel reverts). The previous inline layout is still
   available behind the "Previous layout" switch (recipes.js renderParts).
   Circular imports back to recipes.js are safe -- everything below only runs
   inside functions, never at module-evaluation time. */
import {
  escapeHtml, icon, uid, ingredientMaster, materialLabel, findMaterialByLabel,
  computePrepareWeight, partPrepareWeight, isValidYieldPct
} from './app.js';
import {
  blankPart, blankIngredient, partTotalWeight, itemWeight, recomputeFromWeights,
  siblingsWeightExcluding, isPartOrDescendant, round4, formatWeight
} from './recipes-data.js';
import {
  scheduleSave, saveNow, refreshDisplays, renderParts, unlockedRecipeId, fuzzyMaterialMatches,
  hasUnresolvedIngredient, snapshotWeights, applyScaleFromSnapshot,
  renderIngSubsToggle, registerWorkspaceUpdater
} from './recipes.js';
import { renderProcesses } from './recipes-processes.js';

/* ---------- view switch (per browser, like the other layout preferences) ---------- */
const VIEW_KEY = 'forge_cp_view';
export function isWorkspaceView(){
  try { return localStorage.getItem(VIEW_KEY) !== 'classic'; } catch(e){ return true; }
}
export function setWorkspaceView(mode){
  try { localStorage.setItem(VIEW_KEY, mode); } catch(e){}
}
export function applyViewMode(){
  const wrap = document.querySelector('.ingredients-edit-view');
  if(!wrap) return;
  const on = isWorkspaceView();
  wrap.classList.toggle('cp-mode-workspace', on);
  wrap.classList.toggle('cp-mode-classic', !on);
  wrap.querySelectorAll('.cp-view-toggle').forEach(b => { b.textContent = on ? 'Previous layout' : 'Tree table'; });
}

/* ---------- state ---------- */
const state = { recipeId: null, selected: null, query: '', groupsOnly: false };
let R = null;                       // recipe being edited
let view = [];                      // entries currently shown, in order
let allEntries = [];                // every entry (shown or not)
let rowEls = [];                    // DOM rows, parallel to `view`
let editing = null;                 // the open in-place editor
let drag = null;                    // { item, array }
let statusObserver = null, resizeObserver = null, lastSheetMode = null, toastTimer = null;
const collapsed = new WeakSet();    // Parts whose children are folded away

const isLocked = () => !R || unlockedRecipeId !== R.id;
const isPart = it => !!it && (it.kind === 'part' || Array.isArray(it.items));
const partLabel = p => ((p && p.name) || '').trim() || 'Untitled part';
const ingLabel = i => ((i && i.name) || '').trim() || 'New ingredient';
const fixed2 = n => (parseFloat(n) || 0).toFixed(2);
const recipeLabel = () => ((R && R.name) || '').trim() || 'Recipe';
const isNarrow = () => window.matchMedia && window.matchMedia('(max-width:700px)').matches;
const wsWidth = () => { const w = document.getElementById('cpWorkspace'); return w ? w.clientWidth : 0; };
// Phones and iPad portrait: the table keeps Component / Formula / % and a tap opens the edit sheet.
const isSheetMode = () => { const w = wsWidth(); return w > 0 && w <= 820; };
const multFor = path => path.reduce((m, p) => computePrepareWeight(m, p.prepYieldPct), 1);
const selEntry = () => allEntries.find(e => (e.kind === 'root' ? state.selected === null : e.item === state.selected)) || allEntries[0];

/* ---------- tree model ---------- */
function buildEntries(){
  const out = [{ kind: 'root', item: null, items: R.parts, path: [], depth: 0 }];
  const walk = (items, path, depth) => items.forEach(it => {
    const part = isPart(it);
    out.push({ kind: part ? 'part' : 'ing', item: it, items, path, depth });
    if(part) walk(it.items, [...path, it], depth + 1);
  });
  walk(R.parts, [], 1);
  return out;
}
function computeView(){
  allEntries = buildEntries();
  const q = state.query.trim().toLowerCase();
  const show = new Set(), hit = new Set();
  if(q){
    allEntries.forEach(e => {
      if(e.kind === 'root') return;
      const name = e.kind === 'part' ? partLabel(e.item) : (e.item.name || '');
      if(name.toLowerCase().includes(q)){ hit.add(e.item); show.add(e.item); e.path.forEach(p => show.add(p)); }
    });
  }
  allEntries.forEach(e => {
    e.match = false;
    if(e.kind === 'root'){ e.visible = true; return; }
    if(q){ e.visible = show.has(e.item); e.match = hit.has(e.item); return; }     // a search shows the found items plus their path
    e.visible = !(state.groupsOnly && e.kind === 'ing') && !e.path.some(p => collapsed.has(p));
  });
  view = allEntries.filter(e => e.visible);
}
function validateSelection(){
  if(state.selected === null) return;
  if(!allEntries.some(e => e.item === state.selected)) state.selected = null;
}
// Where "Add ..." goes: the selected Part, or the Part holding the selected ingredient, or the recipe root.
function targetFor(entry){
  if(entry.kind === 'root') return { part: null, items: R.parts, path: [], name: recipeLabel() };
  if(entry.kind === 'part') return { part: entry.item, items: entry.item.items, path: [...entry.path, entry.item], name: partLabel(entry.item) };
  const part = entry.path[entry.path.length - 1];
  return { part, items: part.items, path: entry.path, name: partLabel(part) };
}

/* ---------- scaling (same rules as the classic header fields) ---------- */
function seedEmptyPart(part, targetWeight){
  const items = part.items || [];
  if(items.length === 0) return;
  const share = targetWeight / items.length;
  items.forEach(item => {
    if(isPart(item)) seedEmptyPart(item, share);
    else item.weight = round4(share);
  });
}
function scalePartTo(part, target){
  if(target < 0) return;
  const current = partTotalWeight(part);
  if(current <= 0){ seedEmptyPart(part, target); return; }
  applyScaleFromSnapshot(part.items, snapshotWeights(part.items), target / current);
}
function scaleRecipeTo(target){
  const current = R.parts.reduce((s, p) => s + partTotalWeight(p), 0);
  if(target < 0) return;
  if(current <= 0){ R.parts.forEach(p => seedEmptyPart(p, target / (R.parts.length || 1))); return; }
  const snap = new Map();
  R.parts.forEach(p => snapshotWeights(p.items, snap));
  R.parts.forEach(p => applyScaleFromSnapshot(p.items, snap, target / current));
}

/* ---------- shared UI bits ---------- */
function toast(msg){
  let t = document.querySelector('.tt-toast');
  if(!t){ t = document.createElement('div'); t.className = 'tt-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3600);
}
let menuEl = null;
function closeMenu(){
  if(!menuEl) return;
  menuEl.remove(); menuEl = null;
  document.removeEventListener('pointerdown', onMenuOutside, true);
  document.removeEventListener('keydown', onMenuKey, true);
  window.removeEventListener('resize', closeMenu);
}
function onMenuOutside(e){ if(menuEl && !menuEl.contains(e.target)) closeMenu(); }
function onMenuKey(e){ if(e.key === 'Escape'){ e.stopPropagation(); closeMenu(); } }
function openMenu(anchor, entries){
  closeMenu();
  const m = document.createElement('div');
  m.className = 'cp-menu';
  m.setAttribute('role', 'menu');
  entries.forEach(e => {
    if(e === 'sep'){ const s = document.createElement('div'); s.className = 'cp-menu-sep'; m.appendChild(s); return; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cp-menu-item' + (e.danger ? ' danger' : '');
    b.setAttribute('role', 'menuitem');
    b.innerHTML = `${e.icon ? icon(e.icon, 16) : '<span class="cp-menu-noicon"></span>'}<span>${escapeHtml(e.label)}</span>`;
    if(e.disabled) b.disabled = true;
    b.addEventListener('click', () => { closeMenu(); e.onClick(); });
    m.appendChild(b);
  });
  document.body.appendChild(m);
  const rect = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  const left = Math.min(Math.max(8, rect.right - mw), window.innerWidth - mw - 8);
  let top = rect.bottom + 4;
  if(top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 4);
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  menuEl = m;
  document.addEventListener('pointerdown', onMenuOutside, true);
  document.addEventListener('keydown', onMenuKey, true);
  window.addEventListener('resize', closeMenu);
  const first = m.querySelector('button:not([disabled])');
  if(first) first.focus();
}

// A bottom sheet on phones (sized to the VISIBLE viewport so the on-screen
// keyboard never covers Done), a centered dialog everywhere else.
function makeShell({ title, subtitle = '', cancelLabel = 'Cancel', doneLabel = 'Done', onCancel, onDone, footer = true }){
  const backdrop = document.createElement('div');
  backdrop.className = 'cp-sheet-backdrop';
  backdrop.innerHTML = `
    <div class="cp-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="cp-sheet-head">
        <button type="button" class="cp-sheet-cancel">${escapeHtml(cancelLabel)}</button>
        <div class="cp-sheet-titles"><h3 class="cp-sheet-title">${escapeHtml(title)}</h3>${subtitle ? `<div class="cp-sheet-sub">${escapeHtml(subtitle)}</div>` : ''}</div>
        <span class="cp-sheet-head-spacer"></span>
      </div>
      <div class="cp-sheet-body"></div>
      ${footer ? `<div class="cp-sheet-foot"><button type="button" class="btn btn-primary cp-sheet-done">${escapeHtml(doneLabel)}</button></div>` : ''}
    </div>`;
  const sheet = backdrop.querySelector('.cp-sheet');
  const vv = window.visualViewport;
  function fit(){
    if(!isNarrow() || !vv){ sheet.style.height = ''; sheet.style.top = ''; return; }
    sheet.style.height = vv.height + 'px';
    sheet.style.top = vv.offsetTop + 'px';
  }
  let closed = false;
  function close(){
    if(closed) return;
    closed = true;
    backdrop.remove();
    document.body.classList.remove('cp-sheet-open');
    document.removeEventListener('keydown', onKey, true);
    if(vv){ vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); }
  }
  function cancel(){ if(onCancel) onCancel(); close(); }
  function done(){ if(onDone) onDone(); close(); }
  function onKey(e){ if(e.key === 'Escape'){ e.stopPropagation(); cancel(); } }
  backdrop.addEventListener('pointerdown', e => { if(e.target === backdrop) cancel(); });
  backdrop.querySelector('.cp-sheet-cancel').addEventListener('click', cancel);
  const doneBtn = backdrop.querySelector('.cp-sheet-done');
  if(doneBtn) doneBtn.addEventListener('click', done);
  document.addEventListener('keydown', onKey, true);
  if(vv){ vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }
  document.body.appendChild(backdrop);
  document.body.classList.add('cp-sheet-open');
  fit();
  return { backdrop, sheet, body: backdrop.querySelector('.cp-sheet-body'), close, cancel, done };
}

function commitOnEnter(el){
  el.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); el.blur(); } });
}
function selectOnFocus(el){
  let justFocused = false;
  el.addEventListener('mousedown', () => { justFocused = document.activeElement !== el; });
  el.addEventListener('focus', () => el.select());
  el.addEventListener('mouseup', e => { if(justFocused){ e.preventDefault(); justFocused = false; } });
}

/* ---------- ingredient name picker (library search) ---------- */
function wireNameCombo(input, box, ing, onChange){
  function hide(){ box.innerHTML = ''; box.classList.remove('open'); }
  function show(){
    if(document.activeElement !== input){ hide(); return; }
    const matches = fuzzyMaterialMatches(input.value, 8);
    if(matches.length === 0){ hide(); return; }
    box.innerHTML = matches.map(m => `
      <div class="ing-suggestion-item" data-id="${escapeHtml(m.id)}">
        <span class="ing-suggestion-name">${escapeHtml(materialLabel(m))}</span>
        ${m.brand ? `<span class="ing-suggestion-brand">${escapeHtml(m.brand)}</span>` : ''}
      </div>`).join('');
    box.classList.add('open');
    box.querySelectorAll('.ing-suggestion-item').forEach(el => {
      // pointerdown fires before the input's blur, so the pick isn't lost.
      el.addEventListener('pointerdown', e => {
        e.preventDefault();
        const m = ingredientMaster.find(x => x.id === el.dataset.id);
        if(m){ input.value = materialLabel(m); input.dispatchEvent(new Event('input', { bubbles: true })); }
        hide();
      });
    });
  }
  input.addEventListener('input', () => {
    ing.name = input.value;
    const m = findMaterialByLabel(input.value);
    ing.materialId = m ? m.id : null;
    if(onChange) onChange(m);
    refreshDisplays(R);
    renderProcesses(R);
    scheduleSave();
    show();
  });
  input.addEventListener('focus', show);
  input.addEventListener('blur', hide);
}
function libraryHint(ing, matched){
  if(matched) return { text: matched.vendorCode ? `Code: ${matched.vendorCode}` : '', cls: 'code' };
  if((ing.name || '').trim()) return { text: 'Not in the library — add it in "Ingredient Library" first', cls: 'warn' };
  return { text: 'Pick an ingredient from the library to enter a weight', cls: '' };
}

/* ---------- moving / copying ---------- */
function moveWithin(array, item, dir){
  const i = array.indexOf(item), j = i + dir;
  if(i === -1 || j < 0 || j >= array.length) return false;
  [array[i], array[j]] = [array[j], array[i]];
  return true;
}
// Moves `item` out of `sourceArray` into `targetArray` (at `index`, default end).
function relocate(item, sourceArray, targetArray, index){
  const i = sourceArray.indexOf(item);
  if(i === -1) return false;
  if(isPart(item) && targetArray !== R.parts){
    const owner = allEntries.find(e => e.kind === 'part' && e.item.items === targetArray);
    if(owner && isPartOrDescendant(owner.item, item)) return false;      // never nest a Part inside itself
  }
  sourceArray.splice(i, 1);
  // A Part never sits completely empty -- same safety net as deleting its last ingredient.
  if(!isPart(item) && sourceArray.length === 0 && sourceArray !== R.parts) sourceArray.push(blankIngredient());
  if(index == null || index > targetArray.length) targetArray.push(item); else targetArray.splice(index, 0, item);
  return true;
}
function cloneItem(item){
  const c = JSON.parse(JSON.stringify(item));
  const fresh = it => { if(isPart(it)) it.items.forEach(fresh); else it.id = uid(); };
  fresh(c);
  if(isPart(c) && (c.name || '').trim()) c.name = `${c.name} (copy)`;
  return c;
}
function afterStructureChange(){
  renderParts(R);          // re-renders this table (and recomputes every %)
  renderProcesses(R);      // Process Components follow Part / ingredient names + weights
  scheduleSave();
}
function openMoveTo(item, sourceArray){
  const options = [];
  if(isPart(item)) options.push({ label: `${recipeLabel()} (top level)`, depth: 0, target: R.parts, current: sourceArray === R.parts });
  allEntries.filter(e => e.kind === 'part').forEach(e => {
    if(isPart(item) && isPartOrDescendant(e.item, item)) return;      // can't nest a Part inside itself
    options.push({ label: partLabel(e.item), depth: e.depth, target: e.item.items, current: e.item.items === sourceArray });
  });
  const label = isPart(item) ? partLabel(item) : ingLabel(item);
  const shell = makeShell({ title: `Move "${label}" to…`, footer: false, cancelLabel: 'Close' });
  shell.body.innerHTML = `<div class="cp-pick-list">${options.map((o, i) => `
    <button type="button" class="cp-pick-item${o.current ? ' current' : ''}" data-i="${i}" style="padding-left:${14 + o.depth * 16}px" ${o.current ? 'disabled' : ''}>
      ${icon(o.depth === 0 ? 'package' : 'folder', 16)}<span>${escapeHtml(o.label)}</span>${o.current ? '<em>current</em>' : ''}
    </button>`).join('')}</div>`;
  shell.body.querySelectorAll('.cp-pick-item').forEach(b => b.addEventListener('click', () => {
    const o = options[+b.dataset.i];
    if(relocate(item, sourceArray, o.target)){ shell.close(); afterStructureChange(); }
  }));
}

/* ---------- the edit sheet (Done keeps, Cancel reverts) ---------- */
function openItemSheet(item, ctx){
  closeMenu();
  const part = isPart(item);
  const container = ctx.items;
  const ownerName = ctx.path.length ? partLabel(ctx.path[ctx.path.length - 1]) : recipeLabel();
  const trail = [recipeLabel(), ...ctx.path.map(partLabel)].join(' › ');
  const backup = part
    ? { name: item.name, prepYieldPct: item.prepYieldPct, snap: snapshotWeights(item.items) }
    : JSON.parse(JSON.stringify(item));
  const baseWeight = part ? partTotalWeight(item) : 0;
  let mode = 'weight';

  const shell = makeShell({
    title: part ? 'Edit part' : 'Edit ingredient',
    subtitle: trail,
    onCancel(){
      if(part){ item.name = backup.name; item.prepYieldPct = backup.prepYieldPct; applyScaleFromSnapshot(item.items, backup.snap, 1); }
      else{ Object.keys(item).forEach(k => { if(!(k in backup)) delete item[k]; }); Object.assign(item, backup); }
      recomputeFromWeights(R);
      afterStructureChange();
    },
    onDone(){ afterStructureChange(); }
  });
  const b = shell.body;
  b.innerHTML = `
    <label class="cp-sheet-label" for="cpShName">${part ? 'Part name' : 'Ingredient'}</label>
    <div class="cp-name-wrap"><input type="text" id="cpShName" class="cp-sheet-input" autocomplete="off" placeholder="${part ? 'Part name' : 'Search the library or type a name'}"><div class="cp-sugg-box"></div></div>
    <div class="cp-hint" id="cpShHint"></div>
    <div class="cp-seg" role="tablist" aria-label="Edit by">
      <button type="button" role="tab" class="active" data-mode="weight">Weight</button>
      <button type="button" role="tab" data-mode="percent">Percent</button>
    </div>
    <label class="cp-sheet-label" for="cpShVal" id="cpShValLabel">Formula weight (g)</label>
    <input type="number" id="cpShVal" class="cp-sheet-input cp-sheet-num" step="0.01" min="0" inputmode="decimal" enterkeyhint="done">
    <div class="cp-sheet-readout"><span id="cpShReadLabel"></span><strong id="cpShReadVal"></strong></div>
    <div class="cp-hint warn" id="cpShMsg" role="alert" hidden></div>
    <details class="cp-sheet-more"${isSheetMode() ? ' open' : ''}>
      <summary>More details<small>${part ? 'Yield' : 'Yield, prepare weight, note'}</small></summary>
      <div class="cp-sheet-more-body">
        <div class="cp-sheet-readout"><span>Prepare weight (g)</span><strong id="cpShPrep"></strong></div>
        ${part ? `
          <label class="cp-sheet-label" for="cpShYield">Part yield (%)</label>
          <input type="number" id="cpShYield" class="cp-sheet-input" step="0.01" min="0.01" max="999.99" inputmode="decimal" placeholder="100">` : `
          <div class="cp-sheet-readout"><span>Yield (from library variant)</span><strong id="cpShIngYield"></strong></div>
          <div class="ing-subs" id="cpShSubs"></div>
          <label class="cp-sheet-label" for="cpShNote">Note</label>
          <textarea id="cpShNote" class="cp-sheet-input" rows="3" placeholder="Add a note…"></textarea>`}
      </div>
    </details>`;

  const q = sel => b.querySelector(sel);
  const nameIn = q('#cpShName'), hintEl = q('#cpShHint'), valIn = q('#cpShVal'), valLabel = q('#cpShValLabel');
  const readLabel = q('#cpShReadLabel'), readVal = q('#cpShReadVal'), msg = q('#cpShMsg'), prepEl = q('#cpShPrep');
  nameIn.value = item.name || '';
  const mult = () => multFor(ctx.path);

  function matched(){ return part ? true : !!findMaterialByLabel(nameIn.value); }
  function showMsg(t){ msg.hidden = !t; msg.textContent = t || ''; }
  function refreshReadout(){
    const w = itemWeight(item);
    if(mode === 'weight'){ readLabel.textContent = `% of ${ownerName}`; readVal.textContent = `${fixed2(item.percent)}%`; }
    else{ readLabel.textContent = 'Formula weight'; readVal.textContent = formatWeight(w); }
    const prep = part ? partPrepareWeight(item) * mult() : computePrepareWeight(item.weight, item.prepYieldPct) * mult();
    prepEl.textContent = fixed2(prep);
    const y = q('#cpShIngYield');
    if(y){ const v = parseFloat(item.prepYieldPct); y.textContent = (isFinite(v) && v > 0) ? `${v}%` : '100%'; }
  }
  function seedValue(){
    valLabel.textContent = mode === 'weight' ? 'Formula weight (g)' : `Percent of ${ownerName} (%)`;
    valIn.max = mode === 'percent' ? '100' : '';
    valIn.value = mode === 'weight' ? fixed2(itemWeight(item)) : fixed2(item.percent);
    showMsg('');
    refreshReadout();
  }
  function syncEnabled(){
    const ok = matched();
    valIn.disabled = !ok;
    shell.sheet.querySelectorAll('.cp-seg button').forEach(x => { x.disabled = !ok; });
    if(!part){
      const m = findMaterialByLabel(nameIn.value);
      const h = libraryHint(item, m);
      hintEl.textContent = h.text; hintEl.className = 'cp-hint ' + h.cls;
      renderIngSubsToggle(q('#cpShSubs'), item, m, q('#cpShNote'), () => { refreshReadout(); refreshDisplays(R); });
    }
  }
  function applyWeight(w){
    w = Math.max(0, w);
    if(part){
      if(baseWeight <= 0) seedEmptyPart(item, w);
      else applyScaleFromSnapshot(item.items, backup.snap, w / baseWeight);
    }
    else item.weight = round4(w);
    recomputeFromWeights(R);
  }
  valIn.addEventListener('input', () => {
    const v = parseFloat(valIn.value);
    if(!isFinite(v) || v < 0){ valIn.classList.add('invalid'); showMsg('Enter a number of 0 or more'); return; }
    valIn.classList.remove('invalid');
    showMsg('');
    if(mode === 'weight') applyWeight(v);
    else{
      const others = container.reduce((s, it) => it === item ? s : s + itemWeight(it), 0);
      const f = v / 100;
      if(others > 0 && f < 1) applyWeight(f * others / (1 - f));
      else showMsg(others > 0 ? 'Percent must be below 100' : 'Percent can only be set when something else shares this group');
    }
    refreshReadout();
    scheduleSave();
  });
  commitOnEnter(valIn);
  selectOnFocus(valIn);
  valIn.addEventListener('blur', () => { if(!valIn.classList.contains('invalid')) seedValue(); });
  b.querySelectorAll('.cp-seg button').forEach(btn => btn.addEventListener('click', () => {
    mode = btn.dataset.mode;
    b.querySelectorAll('.cp-seg button').forEach(x => x.classList.toggle('active', x === btn));
    valIn.classList.remove('invalid');
    seedValue();
  }));

  if(part){
    nameIn.addEventListener('input', () => { item.name = nameIn.value; });
    const yIn = q('#cpShYield');
    yIn.value = item.prepYieldPct != null ? item.prepYieldPct : '';
    yIn.addEventListener('input', () => {
      item.prepYieldPct = yIn.value === '' ? null : (parseFloat(yIn.value) || null);
      yIn.classList.toggle('invalid', !isValidYieldPct(yIn.value));
      refreshReadout();
      scheduleSave();
    });
  }else{
    wireNameCombo(nameIn, b.querySelector('.cp-sugg-box'), item, () => { syncEnabled(); seedValue(); });
    const noteIn = q('#cpShNote');
    noteIn.value = item.note || '';
    noteIn.addEventListener('input', () => { item.note = noteIn.value; scheduleSave(); });
  }
  syncEnabled();
  seedValue();
  setTimeout(() => { if(!part && !(item.name || '').trim()) nameIn.focus(); }, 0);
}

/* ---------- in-place editing ---------- */
function closeEditor(){
  if(!editing) return;
  const { cell, html } = editing;
  editing = null;
  cell.classList.remove('editing');
  cell.innerHTML = html;
}
function currentValue(entry, field){
  const it = entry.item;
  if(field === 'name') return it ? (it.name || '') : '';
  if(field === 'wt') return entry.kind === 'root' ? R.parts.reduce((s, p) => s + partTotalWeight(p), 0) : (entry.kind === 'part' ? partTotalWeight(it) : it.weight);
  if(field === 'pct') return it.percent;
  if(field === 'yield') return it.prepYieldPct != null ? it.prepYieldPct : '';
  return '';
}
// Validates and applies one typed value. Returns an error message, or '' when applied.
function applyValue(entry, field, raw){
  const it = entry.item;
  if(field === 'yield'){
    if(raw === ''){ it.prepYieldPct = null; return ''; }
    if(!isValidYieldPct(raw)) return 'Yield must be between 0.01% and 999.99%';
    it.prepYieldPct = parseFloat(raw);
    return '';
  }
  const v = parseFloat(raw);
  if(raw === '' || !isFinite(v) || v < 0) return 'Enter a number of 0 or more';
  if(field === 'wt'){
    if(entry.kind === 'root') scaleRecipeTo(v);
    else if(entry.kind === 'part') scalePartTo(it, v);
    else{
      if(!it.materialId) return 'Pick the ingredient from the library first';
      it.weight = v;
    }
  }else if(field === 'pct'){
    if(entry.kind === 'ing' && !it.materialId) return 'Pick the ingredient from the library first';
    if(v >= 100) return 'Percent must be below 100';
    const others = entry.kind === 'part' ? siblingsWeightExcluding(entry.items, it) : entry.items.reduce((s, x) => x === it ? s : s + itemWeight(x), 0);
    if(others <= 0) return 'Percent can only be set when something else shares this group';
    const target = (v / 100) * others / (1 - v / 100);
    if(entry.kind === 'part') scalePartTo(it, target);
    else it.weight = round4(target);
  }
  return '';
}
function startEdit(idx, field){
  const entry = view[idx];
  if(!entry) return;
  if(isLocked()) return;
  if(isSheetMode()){
    if(entry.kind === 'root'){ toast('Use "Scale recipe to" above to change the whole recipe weight'); return; }
    openItemSheet(entry.item, entry);
    return;
  }
  if(entry.kind === 'root' && field !== 'wt') return;
  if(entry.kind === 'ing' && (field === 'wt' || field === 'pct') && !entry.item.materialId){ field = 'name'; toast('Pick the ingredient from the library first'); }
  if(entry.kind === 'ing' && field === 'yield') return;
  closeEditor();
  const row = rowEls[idx];
  const cell = row.querySelector(field === 'name' ? '.tt-c-name .tt-name-block' : `.tt-c-${field}`);
  if(!cell) return;
  const original = currentValue(entry, field);
  const html = cell.innerHTML;
  const numeric = field !== 'name';
  cell.classList.add('editing');
  const label = field === 'name' ? 'Name' : field === 'wt' ? 'Formula weight (g)' : field === 'pct' ? '% of parent' : 'Yield (%)';
  cell.innerHTML = `
    <div class="tt-editor${numeric ? ' num' : ' name'}">
      <div class="${numeric ? '' : 'cp-name-wrap'} tt-input-wrap">
        <input class="tt-input" type="${numeric ? 'number' : 'text'}" ${numeric ? 'step="0.01" min="0" inputmode="decimal"' : 'autocomplete="off"'} aria-label="${escapeHtml(label)}" enterkeyhint="done">
        ${numeric ? '' : '<div class="cp-sugg-box"></div>'}
      </div>
      <button type="button" class="tt-ok" aria-label="Confirm">${icon('check', 16)}</button>
      <button type="button" class="tt-cancel" aria-label="Cancel">${icon('x', 16)}</button>
      <div class="tt-err" role="alert" hidden></div>
    </div>`;
  const input = cell.querySelector('.tt-input');
  const err = cell.querySelector('.tt-err');
  const ed = { cell, html, entry, field, done: false };
  editing = ed;
  input.value = numeric ? (field === 'yield' ? (original === '' ? '' : original) : fixed2(original)) : (original || '');
  if(!numeric && entry.kind === 'ing'){
    const orig = { name: entry.item.name, materialId: entry.item.materialId };
    ed.revert = () => { entry.item.name = orig.name; entry.item.materialId = orig.materialId; };
    wireNameCombo(input, cell.querySelector('.cp-sugg-box'), entry.item, null);
  }
  if(!numeric && entry.kind === 'part'){
    const orig = entry.item.name;
    ed.revert = () => { entry.item.name = orig; };
    input.addEventListener('input', () => { entry.item.name = input.value; renderProcesses(R); scheduleSave(); });
  }
  function finish(commit){
    if(ed.done) return;
    if(commit && numeric){
      const msg = applyValue(entry, field, input.value.trim());
      if(msg){ err.textContent = msg; err.hidden = false; input.classList.add('invalid'); input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
      recomputeFromWeights(R);
      ed.done = true;
      closeEditor();
      refreshDisplays(R);
      scheduleSave();
      return;
    }
    ed.done = true;
    if(!commit && ed.revert){ ed.revert(); recomputeFromWeights(R); }
    closeEditor();
    refreshDisplays(R);
    if(!numeric){ renderRows(); renderProcesses(R); }     // a new name changes the row's text, code line and library check
  }
  input.addEventListener('keydown', e => {
    if(e.key === 'Enter'){ e.preventDefault(); finish(true); focusRow(idx); }
    else if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); finish(false); focusRow(idx); }
  });
  input.addEventListener('blur', e => {
    const to = e.relatedTarget;
    if(to && cell.contains(to)) return;
    setTimeout(() => { if(!ed.done && editing === ed) finish(true); }, 0);
  });
  const ok = cell.querySelector('.tt-ok'), no = cell.querySelector('.tt-cancel');
  [ok, no].forEach(btn => btn.addEventListener('mousedown', e => e.preventDefault()));
  ok.addEventListener('click', () => { finish(true); focusRow(idx); });
  no.addEventListener('click', () => { finish(false); focusRow(idx); });
  input.focus();
  input.select();
}
function focusRow(idx){
  const row = rowEls[idx];
  if(row) row.focus({ preventScroll: true });
}

/* ---------- rendering ---------- */
const GUIDE_CAP_WIDE = 8, GUIDE_CAP_NARROW = 3;
function rowHtml(e, idx, sheetMode){
  const it = e.item;
  const isRoot = e.kind === 'root', part = e.kind === 'part';
  const group = isRoot || part;
  const lvl = Math.min(e.depth, sheetMode ? GUIDE_CAP_NARROW : GUIDE_CAP_WIDE);
  const guides = '<i class="tt-guide"></i>'.repeat(Math.max(0, lvl - (group ? 1 : 0)));
  const name = isRoot ? recipeLabel() : (part ? partLabel(it) : ingLabel(it));
  const hasKids = group && (isRoot ? R.parts.length > 0 : it.items.length > 0);
  const open = group && !collapsed.has(it) && !state.query.trim();
  const sel = (isRoot ? state.selected === null : state.selected === it);
  const mat = !group && it.materialId ? ingredientMaster.find(m => m.id === it.materialId) : null;
  const locked = isLocked();
  const editable = (field, text, aria) => locked
    ? `<span class="tt-val" data-f="${field}">${text}</span>`
    : `<button type="button" class="tt-edit tt-val" data-edit="${field}" data-f="${field}" aria-label="${escapeHtml(aria)}">${text}</button>`;
  let sub = '';
  if(!group){
    if(mat && mat.vendorCode) sub = `<small class="tt-sub">Code: ${escapeHtml(mat.vendorCode)}</small>`;
    else if(!mat && (it.name || '').trim()) sub = `<small class="tt-sub warn">${icon('alert-triangle', 12)} Not in the library</small>`;
  }
  if(e.match && e.path.length) sub += `<small class="tt-sub path">in ${escapeHtml(e.path.map(partLabel).join(' › '))}</small>`;
  const yv = part ? (it.prepYieldPct != null && it.prepYieldPct !== '' ? it.prepYieldPct : 100) : null;
  const ingY = !group ? parseFloat(it.prepYieldPct) : NaN;
  const yieldCell = isRoot ? '<span class="tt-dash" aria-label="none">–</span>'
    : part ? editable('yield', `${yv} %`, `Edit yield of ${name}`)
    : (isFinite(ingY) && ingY > 0 && ingY !== 100 ? `<span class="tt-val ro" data-f="yield">${ingY} %</span>` : '<span class="tt-dash" aria-label="none">–</span>');
  const wtText = fixed2(currentValue(e, 'wt'));
  const pctCell = isRoot ? '<span class="tt-dash" aria-label="none">–</span>' : editable('pct', `${fixed2(it.percent)} %`, `Edit % of parent for ${name}`);
  const chev = group
    ? (hasKids
        ? `<button type="button" class="tt-chev" data-chev="1" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${escapeHtml(name)}">${icon(open ? 'chevron-down' : 'chevron-right', 16)}</button>`
        : '<span class="tt-chev-sp"></span>')
    : '<span class="tt-chev-sp"></span>';
  const nameBtn = (isRoot || locked)
    ? `<span class="tt-name${group ? ' grp' : ''}" data-f="name">${escapeHtml(name)}</span>`
    : `<button type="button" class="tt-edit tt-name${group ? ' grp' : ''}${!group && !(it.name || '').trim() ? ' ph' : ''}" data-edit="name" data-f="name" aria-label="Edit name: ${escapeHtml(name)}">${escapeHtml(name)}</button>`;
  const hasNote = !group && (it.note || '').trim();
  return `
    <div class="tt-row ${isRoot ? 'tt-root' : group ? 'tt-part' : 'tt-ing'}${sel ? ' selected' : ''}${e.match ? ' hit' : ''}" role="row" data-idx="${idx}"
         aria-level="${e.depth + 1}" ${group ? `aria-expanded="${open}"` : ''} aria-selected="${sel}" tabindex="${sel ? 0 : -1}">
      <div class="tt-c tt-c-handle" role="gridcell">${isRoot || locked ? '' : `<span class="tt-drag" draggable="true" title="Drag to reorder or move" aria-hidden="true">${icon('grip-vertical', 14)}</span>`}</div>
      <div class="tt-c tt-c-name" role="gridcell">
        <span class="tt-guides" aria-hidden="true">${guides}</span>${chev}
        <span class="tt-kind" aria-hidden="true">${icon(group ? 'folder' : 'file-text', 18)}</span>
        <span class="tt-name-block">${nameBtn}${sub}</span>${hasNote ? `<span class="tt-note-inline" role="img" aria-label="Has a note">${icon('file-text', 14)}</span>` : ''}
      </div>
      <div class="tt-c tt-c-yield num" role="gridcell">${yieldCell}</div>
      <div class="tt-c tt-c-prep num" role="gridcell"><span class="tt-prep" data-f="prep"></span></div>
      <div class="tt-c tt-c-wt num" role="gridcell">${editable('wt', wtText, `Edit formula weight of ${name}`)}</div>
      <div class="tt-c tt-c-pct num" role="gridcell">${pctCell}</div>
      <div class="tt-c tt-c-note" role="gridcell">${hasNote ? `<button type="button" class="tt-icon-btn tt-note" aria-label="View note for ${escapeHtml(name)}" title="${escapeHtml(it.note)}">${icon('file-text', 18)}</button>` : ''}</div>
      <div class="tt-c tt-c-menu" role="gridcell"><button type="button" class="tt-icon-btn tt-menu" aria-haspopup="menu" aria-label="Actions for ${escapeHtml(name)}"${locked ? ' disabled' : ''}>${icon('ellipsis', 18)}</button></div>
    </div>`;
}

function renderRows(){
  const grid = document.getElementById('ttRows');
  if(!grid) return;
  closeEditor();
  closeMenu();
  computeView();
  validateSelection();
  const sheetMode = isSheetMode();
  lastSheetMode = sheetMode;
  grid.innerHTML = view.map((e, i) => rowHtml(e, i, sheetMode)).join('') +
    (R.parts.length === 0 ? '<div class="tt-empty">No parts yet — use “Add part” below to create the first one</div>' : '') +
    (state.query.trim() && view.length <= 1 && R.parts.length ? '<div class="tt-empty">Nothing in this recipe matches your search</div>' : '');
  rowEls = [...grid.querySelectorAll('.tt-row')];
  updateDisplays();
  renderCommandBar();
}

// Prepare / weights / % in place (never touches an open editor).
function updateDisplays(){
  if(!R || !rowEls.length) return;
  view.forEach((e, i) => {
    const row = rowEls[i];
    if(!row) return;
    const it = e.item;
    const isRoot = e.kind === 'root';
    let prep;
    if(isRoot) prep = R.parts.reduce((s, p) => s + partPrepareWeight(p), 0);
    else if(e.kind === 'part') prep = partPrepareWeight(it) * multFor(e.path);
    else prep = computePrepareWeight(it.weight, it.prepYieldPct) * multFor(e.path);
    const set = (f, text) => { const el = row.querySelector(`[data-f="${f}"]`); if(el && !el.closest('.editing')) el.textContent = text; };
    set('prep', fixed2(prep));
    set('wt', fixed2(currentValue(e, 'wt')));
    if(!isRoot) set('pct', `${fixed2(it.percent)} %`);
    if(e.kind === 'part'){ const y = it.prepYieldPct != null && it.prepYieldPct !== '' ? it.prepYieldPct : 100; set('yield', `${y} %`); }
    const y = isRoot ? NaN : parseFloat(it.prepYieldPct);
    const prepEl = row.querySelector('[data-f="prep"]');
    if(prepEl) prepEl.classList.toggle('lossy', isFinite(y) && y > 0 && y < 100);
  });
  updateCommandBarTotals();
}

function renderCommandBar(){
  const bar = document.getElementById('ttBar');
  if(!bar) return;
  const e = selEntry();
  const t = targetFor(e);
  const locked = isLocked();
  const selName = e.kind === 'root' ? recipeLabel() : (e.kind === 'part' ? partLabel(e.item) : ingLabel(e.item));
  const toRoot = e.kind === 'root';
  bar.innerHTML = `
    <div class="tt-bar-sel"><span class="tt-bar-label">Selected:</span> <strong class="tt-bar-name">${escapeHtml(selName)}</strong>${e.kind === 'ing' ? `<span class="tt-bar-in"> in ${escapeHtml(t.name)}</span>` : ''}</div>
    <div class="tt-bar-actions">
      <button type="button" class="btn tt-bar-btn" id="ttAddIng"${locked || toRoot ? ' disabled' : ''} title="${toRoot ? 'Select a part to add ingredients to it' : `Add an ingredient to ${escapeHtml(t.name)}`}">${icon('plus', 16)}<span>Add ingredient</span></button>
      <button type="button" class="btn tt-bar-btn" id="ttAddSub"${locked ? ' disabled' : ''} title="${toRoot ? 'Add a top-level part' : `Add a sub-part to ${escapeHtml(t.name)}`}">${icon('plus', 16)}<span>${toRoot ? 'Add part' : 'Add sub-part'}</span></button>
      <button type="button" class="btn tt-bar-btn" id="ttEditProc" title="Go to Process Steps">${icon('sliders-horizontal', 16)}<span>Edit process</span></button>
    </div>
    <div class="tt-bar-info" id="ttBarInfo" aria-live="polite"></div>`;
  updateCommandBarTotals();
}
function updateCommandBarTotals(){
  const info = document.getElementById('ttBarInfo');
  if(!info) return;
  const e = selEntry();
  const t = targetFor(e);
  const total = t.part ? partTotalWeight(t.part) : R.parts.reduce((s, p) => s + partTotalWeight(p), 0);
  const pct = t.items.reduce((s, x) => s + (parseFloat(x.percent) || 0), 0);
  const ok = total <= 0 || Math.abs(pct - 100) < 0.05;
  info.className = 'tt-bar-info' + (ok ? '' : ' bad');
  info.innerHTML = `<span class="tt-bar-total">${escapeHtml(t.name)} total: <b>${formatWeight(total)}</b>${total > 0 ? ` · <b>${pct.toFixed(2)}%</b>` : ''}</span>` +
    (ok ? '' : `<span class="tt-bar-warn">${icon('alert-triangle', 14)} Percent total is ${pct.toFixed(2)}%, not 100%</span>`);
}

function selectEntry(idx, { scroll } = {}){
  const e = view[idx];
  if(!e) return;
  state.selected = e.kind === 'root' ? null : e.item;
  rowEls.forEach((el, i) => {
    const on = i === idx;
    el.classList.toggle('selected', on);
    el.setAttribute('aria-selected', on);
    el.tabIndex = on ? 0 : -1;
  });
  renderCommandBar();
  if(scroll) rowEls[idx].scrollIntoView({ block: 'nearest' });
}

/* ---------- adding ---------- */
function addIngredient(){
  const e = selEntry();
  if(e.kind === 'root') return;
  const t = targetFor(e);
  if(hasUnresolvedIngredient(t.part)){
    alert('This part has an ingredient that is not yet in the library. Please select from the library or add it first before adding the next row.');
    return;
  }
  const ing = blankIngredient();
  t.items.push(ing);
  collapsed.delete(t.part);
  state.selected = ing;
  afterStructureChange();
  focusNew(ing);
}
function addSubPart(){
  const e = selEntry();
  const t = targetFor(e);
  const part = blankPart(t.part ? '' : `Part ${R.parts.length + 1}`);
  t.items.push(part);
  if(t.part) collapsed.delete(t.part);
  state.selected = part;
  afterStructureChange();
  focusNew(part);
}
function focusNew(item){
  setTimeout(() => {
    const idx = view.findIndex(x => x.item === item);
    if(idx === -1) return;
    selectEntry(idx, { scroll: true });
    startEdit(idx, 'name');
  }, 0);
}

/* ---------- row menu ---------- */
function rowMenuEntries(idx){
  const e = view[idx];
  const it = e.item;
  if(e.kind === 'root'){
    return [
      { icon: 'plus', label: 'Add part', onClick: () => { selectEntry(idx); addSubPart(); } },
      { icon: 'chevron-down', label: 'Expand all', onClick: expandAll },
      { icon: 'chevron-up', label: 'Collapse all', onClick: collapseAll }
    ];
  }
  const part = e.kind === 'part';
  const items = e.items;
  const i = items.indexOf(it);
  const entries = [{ icon: part ? 'folder' : 'file-text', label: part ? 'Edit part…' : 'Edit details…', onClick: () => openItemSheet(it, e) }];
  if(part) entries.push({ icon: 'plus', label: 'Add ingredient here', onClick: () => { selectEntry(idx); addIngredient(); } }, { icon: 'plus', label: 'Add sub-part here', onClick: () => { selectEntry(idx); addSubPart(); } });
  entries.push('sep');
  entries.push({ icon: 'copy', label: 'Duplicate', onClick: () => { items.splice(i + 1, 0, cloneItem(it)); afterStructureChange(); } });
  entries.push({ icon: 'chevron-up', label: 'Move up', disabled: i <= 0, onClick: () => { if(moveWithin(items, it, -1)) afterStructureChange(); } });
  entries.push({ icon: 'chevron-down', label: 'Move down', disabled: i >= items.length - 1, onClick: () => { if(moveWithin(items, it, 1)) afterStructureChange(); } });
  entries.push({ icon: 'move', label: 'Move to…', onClick: () => openMoveTo(it, items) });
  entries.push('sep');
  const lastTop = items === R.parts && R.parts.length <= 1;
  entries.push({ icon: 'trash-2', label: part ? 'Delete part' : 'Delete', danger: true, disabled: lastTop, onClick: () => {
    if(part && !confirm(`Delete "${it.name || 'this part'}" and everything inside it?`)) return;
    const k = items.indexOf(it);
    if(k !== -1) items.splice(k, 1);
    if(!part && items.length === 0 && items !== R.parts) items.push(blankIngredient());
    if(state.selected === it) state.selected = e.path.length ? e.path[e.path.length - 1] : null;
    afterStructureChange();
  } });
  return entries;
}
function expandAll(){ allEntries.forEach(e => { if(e.kind === 'part') collapsed.delete(e.item); }); renderRows(); }
function collapseAll(){ allEntries.forEach(e => { if(e.kind === 'part' && e.item.items.length) collapsed.add(e.item); }); renderRows(); }

/* ---------- grid events (one delegated listener each -- cheap for big recipes) ---------- */
function wireGrid(grid){
  const rowOf = el => { const r = el.closest('.tt-row'); return r && r.dataset.idx !== undefined ? +r.dataset.idx : -1; };
  grid.addEventListener('click', ev => {
    const idx = rowOf(ev.target);
    if(idx < 0) return;
    const e = view[idx];
    if(ev.target.closest('.tt-chev')){
      if(collapsed.has(e.item)) collapsed.delete(e.item); else collapsed.add(e.item);
      renderRows();
      focusRow(idx);
      return;
    }
    if(ev.target.closest('.tt-menu')){ selectEntry(idx); openMenu(ev.target.closest('.tt-menu'), rowMenuEntries(idx)); return; }
    if(ev.target.closest('.tt-note')){ selectEntry(idx); if(!isLocked()) openItemSheet(e.item, e); else toast('Unlock the recipe to edit its note'); return; }
    if(ev.target.closest('.tt-editor')) return;
    const editBtn = ev.target.closest('[data-edit]');
    selectEntry(idx);
    if(editBtn){ startEdit(idx, editBtn.dataset.edit); return; }
    if(isSheetMode() && e.kind !== 'root' && !isLocked()) openItemSheet(e.item, e);
  });
  grid.addEventListener('keydown', ev => {
    if(ev.target.closest('.tt-editor')) return;
    const row = ev.target.closest('.tt-row');
    if(!row || row.dataset.idx === undefined) return;
    if(ev.target !== row && ev.target.closest('button') && ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const idx = +row.dataset.idx, e = view[idx];
    const go = n => { if(n >= 0 && n < view.length){ ev.preventDefault(); selectEntry(n, { scroll: true }); focusRow(n); } };
    if(ev.key === 'ArrowDown') go(idx + 1);
    else if(ev.key === 'ArrowUp') go(idx - 1);
    else if(ev.key === 'Home') go(0);
    else if(ev.key === 'End') go(view.length - 1);
    else if(ev.key === 'ArrowRight' && e.kind !== 'ing' && collapsed.has(e.item)){ ev.preventDefault(); collapsed.delete(e.item); renderRows(); focusRow(idx); }
    else if(ev.key === 'ArrowLeft' && e.kind === 'part' && !collapsed.has(e.item) && e.item.items.length){ ev.preventDefault(); collapsed.add(e.item); renderRows(); focusRow(idx); }
    else if(ev.key === 'Enter' || ev.key === 'F2'){ ev.preventDefault(); startEdit(idx, ev.key === 'F2' ? 'name' : 'wt'); }
  });
  // drag a row by its handle: before/after = reorder (also across groups); middle of a group = move into it
  grid.addEventListener('dragstart', ev => {
    const handle = ev.target.closest('.tt-drag');
    if(!handle) return;
    const idx = rowOf(handle), e = view[idx];
    drag = { item: e.item, array: e.items };
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', 'row');
    rowEls[idx].classList.add('dragging');
  });
  grid.addEventListener('dragend', () => { rowEls.forEach(r => r.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-into')); drag = null; });
  function zoneFor(ev, row, e){
    const rect = row.getBoundingClientRect();
    const rel = (ev.clientY - rect.top) / rect.height;
    if(e.kind === 'root') return 'into';
    if(e.kind === 'part' && rel > 0.3 && rel < 0.7) return 'into';
    return rel < 0.5 ? 'before' : 'after';
  }
  function dropAllowed(e, zone){
    if(!drag || drag.item === e.item) return false;
    if(e.kind === 'root') return isPart(drag.item);                       // only a Part can go to the top level
    if(isPart(drag.item)){
      if(zone === 'into'){ if(e.kind === 'part' && isPartOrDescendant(e.item, drag.item)) return false; }
      else{
        if(e.path.includes(drag.item)) return false;                      // not beside one of its own descendants
      }
    }else if(zone !== 'into' && e.items === R.parts) return false;        // an ingredient can't sit at the top level
    return true;
  }
  grid.addEventListener('dragover', ev => {
    const row = ev.target.closest('.tt-row'); if(!row || row.dataset.idx === undefined || !drag) return;
    const e = view[+row.dataset.idx], zone = zoneFor(ev, row, e);
    if(!dropAllowed(e, zone)) return;
    ev.preventDefault();
    rowEls.forEach(r => r.classList.remove('drop-before', 'drop-after', 'drop-into'));
    row.classList.add(`drop-${zone}`);
  });
  grid.addEventListener('drop', ev => {
    const row = ev.target.closest('.tt-row'); if(!row || row.dataset.idx === undefined || !drag) return;
    ev.preventDefault();
    const e = view[+row.dataset.idx], zone = zoneFor(ev, row, e);
    if(!dropAllowed(e, zone)){ drag = null; return; }
    const moving = drag.item, src = drag.array;
    let ok;
    if(zone === 'into'){
      const target = e.kind === 'root' ? R.parts : e.item.items;
      ok = relocate(moving, src, target);
      if(ok && e.kind === 'part') collapsed.delete(e.item);
    }else{
      const si = src.indexOf(moving);
      let at = e.items.indexOf(e.item);
      if(e.items === src && si !== -1 && si < at) at -= 1;   // removing it first shifts the target left
      if(zone === 'after') at += 1;
      ok = relocate(moving, src, e.items, at);
    }
    drag = null;
    if(ok) afterStructureChange();
  });
}

/* ---------- entry point (called by recipes.js renderParts) ---------- */
export function renderWorkspace(r){
  R = r;
  const host = document.getElementById('cpWorkspace');
  if(!host) return;
  if(state.recipeId !== r.id){ state.recipeId = r.id; state.selected = null; state.query = ''; state.groupsOnly = false; }
  const prevScroll = document.getElementById('ttScroll');
  const scrollTop = prevScroll ? prevScroll.scrollTop : 0;
  closeEditor();
  closeMenu();
  host.innerHTML = `
    <div class="tt-toolbar cp-lock-exempt">
      <button type="button" class="tt-chip cp-view-toggle" title="Switch between this tree table and the previous inline layout"></button>
      <div class="cp-search tt-search">${icon('search', 16)}<input type="search" id="ttSearch" placeholder="Find ingredient or sub-part…" aria-label="Find an ingredient or sub-part" value="${escapeHtml(state.query)}"></div>
      <button type="button" class="tt-tool" id="ttCollapseAll" aria-label="Collapse all groups">${icon('chevron-up', 16)}<span>Collapse all</span></button>
      <button type="button" class="tt-tool" id="ttExpandAll" aria-label="Expand all groups">${icon('chevron-down', 16)}<span>Expand all</span></button>
      <label class="tt-switch"><span class="tt-switch-label">${icon('folder', 16)}<span>Groups only</span></span>
        <input type="checkbox" role="switch" id="ttGroupsOnly" ${state.groupsOnly ? 'checked' : ''}><span class="tt-switch-track" aria-hidden="true"></span></label>
    </div>
    <div class="tt-wrap cp-lock-exempt">
      <div class="tt-scroll" id="ttScroll">
        <div class="tt-grid" role="treegrid" aria-label="Components and ingredients" id="ttGrid">
          <div class="tt-row tt-head" role="row">
            <div class="tt-c tt-c-handle" role="columnheader"></div>
            <div class="tt-c tt-c-name" role="columnheader">Component</div>
            <div class="tt-c tt-c-yield num" role="columnheader">Yield</div>
            <div class="tt-c tt-c-prep num" role="columnheader">Prepare (g)</div>
            <div class="tt-c tt-c-wt num" role="columnheader">Formula (g)</div>
            <div class="tt-c tt-c-pct num" role="columnheader">% of parent</div>
            <div class="tt-c tt-c-note" role="columnheader"><span class="sr-only">Note</span></div>
            <div class="tt-c tt-c-menu" role="columnheader"><span class="sr-only">Actions</span></div>
          </div>
          <div id="ttRows" role="rowgroup"></div>
        </div>
      </div>
    </div>
    <div class="tt-bar cp-lock-exempt" id="ttBar" role="toolbar" aria-label="Actions for the selected group"></div>`;

  applyViewMode();
  const search = document.getElementById('ttSearch');
  search.addEventListener('input', () => { state.query = search.value; renderRows(); });
  search.addEventListener('keydown', e => { if(e.key === 'Escape' && search.value){ search.value = ''; state.query = ''; renderRows(); } });
  document.getElementById('ttCollapseAll').addEventListener('click', collapseAll);
  document.getElementById('ttExpandAll').addEventListener('click', expandAll);
  document.getElementById('ttGroupsOnly').addEventListener('change', e => { state.groupsOnly = e.target.checked; renderRows(); });
  wireGrid(document.getElementById('ttGrid'));
  document.getElementById('ttBar').addEventListener('click', e => {
    const b = e.target.closest('button'); if(!b || b.disabled) return;
    if(b.id === 'ttAddIng') addIngredient();
    else if(b.id === 'ttAddSub') addSubPart();
    else if(b.id === 'ttEditProc'){ const t = document.getElementById('processesList'); if(t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });

  renderRows();
  const sc = document.getElementById('ttScroll');
  if(sc) sc.scrollTop = scrollTop;
  setupHeader(r);
  registerWorkspaceUpdater(updateDisplays);

  if(resizeObserver) resizeObserver.disconnect();
  if(window.ResizeObserver){
    resizeObserver = new ResizeObserver(() => { if(lastSheetMode !== null && isSheetMode() !== lastSheetMode) renderRows(); });
    resizeObserver.observe(host);
  }
}

// Header strip: recipe name, unsaved-changes status mirrored from the page's own save status, and Save.
function setupHeader(r){
  const nameEl = document.getElementById('ttRecipeName');
  if(nameEl) nameEl.textContent = r.name || 'Untitled recipe';
  const status = document.getElementById('ttStatus');
  const src = document.getElementById('saveStatus');
  const btn = document.getElementById('ttSaveBtn');
  const locked = isLocked();
  if(btn){ btn.hidden = locked; btn.onclick = () => saveNow(); }
  function sync(){
    if(!status) return;
    if(locked){ status.className = 'tt-status ro'; status.innerHTML = `${icon('lock', 14)} Read-only`; return; }
    const t = src ? src.textContent.trim() : '';
    if(/^saving/i.test(t)){ status.className = 'tt-status dirty'; status.innerHTML = '<span class="tt-dot"></span> Unsaved changes…'; }
    else if(/^saved/i.test(t)){ status.className = 'tt-status ok'; status.innerHTML = `${icon('check', 14)} ${escapeHtml(t)}`; }
    else { status.className = 'tt-status'; status.textContent = ''; }
  }
  if(statusObserver) statusObserver.disconnect();
  if(src){
    statusObserver = new MutationObserver(sync);
    statusObserver.observe(src, { childList: true, characterData: true, subtree: true });
  }
  sync();
}
