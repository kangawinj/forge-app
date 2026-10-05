/* ---------- Components & Process workspace ----------
   The master/detail layout of "4. Components and Process": a collapsible
   "Recipe structure" tree on the left, and the selected Part's breadcrumb,
   summary, tabs and ingredient list on the right. It is only a different
   VIEW over the same recipe data -- every weight / % / Yield / Prepare
   figure is computed by the same functions the classic inline tree uses
   (recomputeFromWeights, partTotalWeight, partPrepareWeight,
   computePrepareWeight ...), and every edit goes through the same rules:
     - typing a Formula weight sets it directly (the % of its siblings is
       derived on commit);
     - typing a % back-solves the weight holding every other sibling fixed
       (pct = w / (w + others));
     - typing a Part's weight / % scales everything inside it
       proportionally from the state when the edit began;
     - an ingredient can only get a weight once its name is in the library.
   Layouts: desktop = tree + table; iPad landscape = compact tree + table
   without the Prepare column; narrow (iPad portrait / phone) = the tree
   folds into a "Recipe structure" button, and on phones every ingredient
   is a card that opens an edit sheet (Done = keep, Cancel = revert; the
   recipe itself is saved by the existing Save). The old inline tree is
   still there behind the "Classic view" switch (recipes.js renderParts).
   Circular imports back to recipes.js are safe -- everything below only
   runs inside functions, never at module-evaluation time. */
import {
  escapeHtml, icon, ingredientMaster, materialLabel, findMaterialByLabel,
  computePrepareWeight, partPrepareWeight, isValidYieldPct
} from './app.js';
import {
  blankPart, blankIngredient, partTotalWeight, itemWeight, recomputeFromWeights,
  siblingsWeightExcluding, isPartOrDescendant, round2, round4, formatWeight
} from './recipes-data.js';
import {
  scheduleSave, refreshDisplays, renderParts, unlockedRecipeId, fuzzyMaterialMatches,
  materialTooltip, hasUnresolvedIngredient, snapshotWeights, applyScaleFromSnapshot,
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
  const btn = document.getElementById('btnCpView');
  if(btn) btn.textContent = on ? 'Classic view' : 'New view';
}

/* ---------- state ---------- */
const state = { recipeId: null, selected: undefined, selIdx: null, tab: 'ing', navQuery: '', rowQuery: '', navOpen: false };
let R = null;                 // recipe being edited
let rowRefs = [];             // per-row refs for in-place refresh
let navRefs = [];             // { part, weightEl } for in-place refresh
let navMap = new Map();       // data-nid -> part
let detailRefs = null;        // header/stat elements for in-place refresh
let drag = null;              // { item, array }
const navCollapsed = new WeakSet();

const isLocked = () => !R || unlockedRecipeId !== R.id;
const isPart = it => !!it && (it.kind === 'part' || Array.isArray(it.items));
const partLabel = p => ((p && p.name) || '').trim() || 'Untitled part';
const fixed2 = n => (parseFloat(n) || 0).toFixed(2);
// A phone-sized screen (the edit sheet becomes a full page sized to the visible viewport) ...
const isNarrow = () => window.matchMedia && window.matchMedia('(max-width:700px)').matches;
// ... versus the workspace itself being narrow enough that rows show as cards (matches the CSS container query).
const isCards = () => { const w = document.getElementById('cpWorkspace'); return !!w && w.clientWidth > 0 && w.clientWidth <= 620; };

function pathTo(parts, target, trail = []){
  for(const p of (parts || [])){
    if(!isPart(p)) continue;
    const t = [...trail, p];
    if(p === target) return t;
    const f = pathTo(p.items, target, t);
    if(f) return f;
  }
  return null;
}
function idxPathOf(items, target, trail = []){
  for(let i = 0; i < (items || []).length; i++){
    const it = items[i];
    if(!isPart(it)) continue;
    if(it === target) return [...trail, i];
    const f = idxPathOf(it.items, target, [...trail, i]);
    if(f) return f;
  }
  return null;
}
// Combined Yield effect of a chain of Parts (each Part's own Yield compounds).
const multFor = path => path.reduce((m, p) => computePrepareWeight(m, p.prepYieldPct), 1);
const currentPath = () => state.selected ? (pathTo(R.parts, state.selected) || []) : [];
const containerItems = () => state.selected ? state.selected.items : R.parts;
const siblingsOfSelected = () => { const p = currentPath(); return p.length > 1 ? p[p.length - 2].items : R.parts; };
const recipeLabel = () => ((R && R.name) || '').trim() || 'Recipe';

function resolveSelection(r){
  if(state.recipeId !== r.id){
    state.recipeId = r.id; state.selected = undefined; state.selIdx = null;
    state.tab = 'ing'; state.navQuery = ''; state.rowQuery = ''; state.navOpen = false;
  }
  let ok = state.selected === null || (state.selected && pathTo(r.parts, state.selected));
  if(!ok && state.selIdx && state.selIdx.length){
    let items = r.parts, node = null;
    for(const i of state.selIdx){
      const it = items[i];
      if(!isPart(it)){ node = null; break; }
      node = it; items = it.items;
    }
    if(node){ state.selected = node; ok = true; }
  }
  if(!ok) state.selected = (r.parts || []).length === 1 ? r.parts[0] : null;
  state.selIdx = state.selected ? idxPathOf(r.parts, state.selected) : null;
}
function setSelection(part){
  state.selected = part || null;
  state.selIdx = part ? idxPathOf(R.parts, part) : null;
  state.tab = 'ing'; state.rowQuery = ''; state.navOpen = false;
  renderNav();
  renderDetail();
  syncNavToggleLabel();
  const ws = document.getElementById('cpWorkspace');
  if(ws) ws.classList.remove('nav-open');
}

/* ---------- small DOM helpers ---------- */
function lockSubtree(el){
  if(!el || !isLocked()) return;
  el.querySelectorAll('input, textarea, select, button').forEach(x => {
    if(!x.closest('.cp-lock-exempt')) x.disabled = true;
  });
}
function afterStructureChange(){
  renderParts(R);          // re-renders this workspace (and recomputes every %)
  renderProcesses(R);      // Process Components follow Part / ingredient names + weights
  scheduleSave();
}
// Enter commits a number field (same as leaving it), then moves down to the next one on screen.
function commitOnEnter(el, nextSelector){
  el.addEventListener('keydown', e => {
    if(e.key !== 'Enter') return;
    e.preventDefault();
    el.blur();
    if(!nextSelector) return;
    const all = [...document.querySelectorAll(nextSelector)].filter(n => n.offsetParent !== null && !n.disabled);
    const next = all[all.indexOf(el) + 1];
    if(next) next.focus();
  });
}
function selectOnFocus(el){
  let justFocused = false;
  el.addEventListener('mousedown', () => { justFocused = document.activeElement !== el; });
  el.addEventListener('focus', () => el.select());
  el.addEventListener('mouseup', e => { if(justFocused){ e.preventDefault(); justFocused = false; } });
}
function setNum(el, n){
  if(!el || document.activeElement === el) return;
  const v = parseFloat(n) || 0;
  el.value = v.toFixed(2);
  el.title = v.toFixed(4);
}

/* ---------- scaling a Part (same rules as the classic header fields) ---------- */
function seedEmptyPart(part, targetWeight){
  const items = part.items || [];
  if(items.length === 0) return;
  const share = targetWeight / items.length;
  items.forEach(item => {
    if(isPart(item)) seedEmptyPart(item, share);
    else item.weight = round4(share);
  });
}
// base + snapshot are captured when an edit begins, so typing digit by digit
// (through a transient 0) never destroys the original ratios.
function scalePartTo(part, target, base, snapshot){
  if(target < 0) return;
  const current = base != null ? base : partTotalWeight(part);
  if(current <= 0){ seedEmptyPart(part, target); return; }
  applyScaleFromSnapshot(part.items, snapshot || snapshotWeights(part.items), target / current);
}

/* ---------- menus / sheets ---------- */
let menuEl = null;
function closeMenu(){
  if(!menuEl) return;
  menuEl.remove(); menuEl = null;
  document.removeEventListener('pointerdown', onMenuOutside, true);
  document.removeEventListener('keydown', onMenuKey, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('scroll', closeMenu, true);
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
  window.addEventListener('scroll', closeMenu, true);
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
    onChange(m);
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

/* ---------- moving things around ---------- */
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
  sourceArray.splice(i, 1);
  // A Part never sits completely empty -- same safety net as deleting its last ingredient.
  if(!isPart(item) && sourceArray.length === 0 && sourceArray !== R.parts) sourceArray.push(blankIngredient());
  if(index == null || index > targetArray.length) targetArray.push(item); else targetArray.splice(index, 0, item);
  return true;
}
function allPartsFlat(parts = R.parts, depth = 0, out = []){
  (parts || []).forEach(p => { if(isPart(p)){ out.push({ part: p, depth }); allPartsFlat(p.items, depth + 1, out); } });
  return out;
}
function openMoveTo(item, sourceArray){
  const options = [];
  if(isPart(item)) options.push({ label: `${recipeLabel()} (top level)`, depth: 0, target: R.parts, current: sourceArray === R.parts });
  allPartsFlat().forEach(({ part, depth }) => {
    if(isPart(item) && isPartOrDescendant(part, item)) return;      // can't nest a Part inside itself
    options.push({ label: partLabel(part), depth: depth + 1, target: part.items, current: part.items === sourceArray });
  });
  const shell = makeShell({ title: `Move "${isPart(item) ? partLabel(item) : ((item.name || '').trim() || 'ingredient')}" to…`, footer: false, cancelLabel: 'Close' });
  shell.body.innerHTML = `<div class="cp-pick-list">${options.map((o, i) => `
    <button type="button" class="cp-pick-item${o.current ? ' current' : ''}" data-i="${i}" style="padding-left:${14 + o.depth * 18}px" ${o.current ? 'disabled' : ''}>
      ${icon(o.depth === 0 ? 'package' : 'folder', 16)}<span>${escapeHtml(o.label)}</span>${o.current ? '<em>current</em>' : ''}
    </button>`).join('')}</div>`;
  shell.body.querySelectorAll('.cp-pick-item').forEach(b => b.addEventListener('click', () => {
    const o = options[+b.dataset.i];
    if(relocate(item, sourceArray, o.target)){ shell.close(); afterStructureChange(); }
  }));
}

/* ---------- the edit sheet (Done keeps, Cancel reverts) ---------- */
function openItemSheet(item, container){
  closeMenu();
  const part = isPart(item);
  const owner = state.selected;                       // null at the recipe root
  const ownerName = owner ? partLabel(owner) : recipeLabel();
  const backup = part
    ? { name: item.name, prepYieldPct: item.prepYieldPct, snap: snapshotWeights(item.items) }
    : JSON.parse(JSON.stringify(item));
  const baseWeight = part ? partTotalWeight(item) : 0;
  let mode = 'weight';

  const shell = makeShell({
    title: part ? 'Edit part' : 'Edit ingredient',
    subtitle: ownerName,
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
    <div class="cp-hint warn" id="cpShMsg" hidden></div>
    <details class="cp-sheet-more">
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
  const ancestors = currentPath();                                 // Parts above this row
  const mult = () => multFor(ancestors);

  function matched(){ return part ? true : !!findMaterialByLabel(nameIn.value); }
  function showMsg(t){ msg.hidden = !t; msg.textContent = t || ''; }
  function refreshReadout(){
    const w = itemWeight(item);
    if(mode === 'weight'){ readLabel.textContent = `Share of ${ownerName}`; readVal.textContent = `${fixed2(item.percent)}%`; }
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
    if(part) scalePartTo(item, w, baseWeight, backup.snap);
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
      else showMsg(others > 0 ? 'Percent must be below 100' : 'Percent can only be set when something else shares this Part');
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
  setTimeout(() => {
    if(!part && !(item.name || '').trim()) nameIn.focus();
    else if(!valIn.disabled && isNarrow()) { /* leave the keyboard closed until the user taps a field */ }
  }, 0);
}

/* ---------- navigation tree ---------- */
function nodeMatches(part, q){
  if(!q) return true;
  if(partLabel(part).toLowerCase().includes(q)) return true;
  return part.items.some(it => isPart(it) ? nodeMatches(it, q) : (it.name || '').toLowerCase().includes(q));
}
function renderNav(){
  const tree = document.getElementById('cpTree');
  if(!tree) return;
  navMap = new Map(); navRefs = [];
  let nid = 0;
  const q = state.navQuery.trim().toLowerCase();
  const rows = [];

  function nodeHtml(part, depth){
    const id = String(++nid);
    navMap.set(id, part);
    const subs = part.items.filter(isPart);
    const visibleSubs = subs.filter(s => nodeMatches(s, q));
    const collapsed = !q && navCollapsed.has(part);
    const hits = q ? part.items.filter(it => !isPart(it) && (it.name || '').toLowerCase().includes(q)).slice(0, 2).map(it => it.name) : [];
    const selected = state.selected === part;
    let html = `
      <div class="cp-node${selected ? ' selected' : ''}" role="treeitem" tabindex="0" data-nid="${id}" style="--depth:${depth}"
           ${subs.length ? `aria-expanded="${!collapsed}"` : ''} aria-selected="${selected}">
        <span class="cp-node-chev${subs.length ? '' : ' empty'}" data-chev="${id}">${subs.length ? icon(collapsed ? 'chevron-right' : 'chevron-down', 16) : ''}</span>
        <span class="cp-node-icon">${icon(depth <= 1 ? 'package' : 'folder', 18)}</span>
        <span class="cp-node-text"><span class="cp-node-name">${escapeHtml(partLabel(part))}</span>${hits.length ? `<span class="cp-node-hit">${hits.map(escapeHtml).join(' · ')}</span>` : ''}</span>
        <span class="cp-node-wt" data-navwt="${id}"></span>
      </div>`;
    if(!collapsed) visibleSubs.forEach(s => { html += nodeHtml(s, depth + 1); });
    return html;
  }

  // Root = the whole recipe.
  const rootSel = state.selected === null;
  rows.push(`
    <div class="cp-node cp-node-root${rootSel ? ' selected' : ''}" role="treeitem" tabindex="0" data-nid="root" style="--depth:0" aria-selected="${rootSel}">
      <span class="cp-node-chev empty"></span>
      <span class="cp-node-icon">${icon('flask-conical', 18)}</span>
      <span class="cp-node-text"><span class="cp-node-name">${escapeHtml(recipeLabel())}</span></span>
      <span class="cp-node-wt" data-navwt="root"></span>
    </div>`);
  R.parts.filter(isPart).filter(p => nodeMatches(p, q)).forEach(p => rows.push(nodeHtml(p, 1)));
  if(q && rows.length === 1) rows.push('<div class="cp-nav-empty">No parts or ingredients match</div>');
  tree.innerHTML = rows.join('');

  tree.querySelectorAll('.cp-node').forEach(el => {
    const id = el.dataset.nid;
    const part = id === 'root' ? null : navMap.get(id);
    const choose = () => setSelection(part);
    el.addEventListener('click', e => {
      const chev = e.target.closest('.cp-node-chev');
      if(chev && !chev.classList.contains('empty')){
        if(navCollapsed.has(part)) navCollapsed.delete(part); else navCollapsed.add(part);
        renderNav();
        return;
      }
      choose();
    });
    el.addEventListener('keydown', e => {
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); choose(); }
      else if(part && e.key === 'ArrowLeft' && !navCollapsed.has(part) && part.items.some(isPart)){ navCollapsed.add(part); renderNav(); }
      else if(part && e.key === 'ArrowRight' && navCollapsed.has(part)){ navCollapsed.delete(part); renderNav(); }
    });
    // Drop an ingredient / Part onto a tree node to move it into that Part.
    el.addEventListener('dragover', e => {
      if(!drag) return;
      if(part){ if(isPart(drag.item) && isPartOrDescendant(part, drag.item)) return; }
      else if(!isPart(drag.item)) return;     // only a Part can go to the top level
      e.preventDefault();
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drop-target');
      if(!drag) return;
      if(part && isPart(drag.item) && isPartOrDescendant(part, drag.item)){ drag = null; return; }   // never nest a Part inside itself
      if(!part && !isPart(drag.item)){ drag = null; return; }
      const target = part ? part.items : R.parts;
      if(relocate(drag.item, drag.array, target)){ drag = null; afterStructureChange(); }
    });
    navRefs.push({ part, weightEl: el.querySelector('[data-navwt]') });
  });
  updateNavWeights();
  lockSubtree(document.getElementById('cpNav'));
}
function updateNavWeights(){
  navRefs.forEach(({ part, weightEl }) => {
    if(!weightEl) return;
    weightEl.textContent = formatWeight(part ? partTotalWeight(part) : R.parts.reduce((s, p) => s + partTotalWeight(p), 0));
  });
}
function syncNavToggleLabel(){
  const el = document.getElementById('cpNavToggleSel');
  if(el) el.textContent = state.selected ? partLabel(state.selected) : recipeLabel();
}

/* ---------- detail pane ---------- */
function crumbsHtml(path){
  const parts = [`<button type="button" class="cp-crumb" data-crumb="root">${escapeHtml(recipeLabel())}</button>`];
  path.forEach((p, i) => {
    parts.push('<span class="cp-crumb-sep" aria-hidden="true">/</span>');
    parts.push(i === path.length - 1
      ? `<span class="cp-crumb current" id="cpCrumbCurrent" aria-current="page">${escapeHtml(partLabel(p))}</span>`
      : `<button type="button" class="cp-crumb" data-crumb="${i}">${escapeHtml(partLabel(p))}</button>`);
  });
  return parts.join('');
}
function rowCountText(sel){
  const items = containerItems();
  const ing = items.filter(it => !isPart(it) && (it.name || '').trim() !== '').length;
  const subs = items.filter(isPart).length;
  if(!sel){ return `${subs} part${subs === 1 ? '' : 's'}`; }
  const bits = [];
  if(ing) bits.push(`${ing} ingredient${ing === 1 ? '' : 's'}`);
  if(subs) bits.push(`${subs} sub-part${subs === 1 ? '' : 's'}`);
  return bits.join(' · ') || 'Empty';
}

function renderDetail(){
  const host = document.getElementById('cpDetail');
  if(!host) return;
  closeMenu();
  const sel = state.selected;
  const path = currentPath();
  const parentName = path.length > 1 ? partLabel(path[path.length - 2]) : recipeLabel();
  const shareLabel = path.length > 1 ? `Share of ${parentName}` : 'Share of recipe';

  host.innerHTML = `
    <nav class="cp-crumbs cp-lock-exempt" aria-label="Location in the recipe">${crumbsHtml(path)}</nav>
    <div class="cp-head">
      <div class="cp-title-wrap">
        ${sel
          ? `<input type="text" class="cp-title-input" id="cpPartName" placeholder="Part name" aria-label="Part name">`
          : `<h3 class="cp-title-static">${escapeHtml(recipeLabel())}</h3>`}
        <span class="cp-chip" id="cpCount"></span>
      </div>
      <button type="button" class="cp-icon-btn cp-head-menu" id="cpHeadMenu" aria-haspopup="menu" aria-label="${sel ? 'Part actions' : 'Recipe actions'}">${icon('ellipsis', 20)}</button>
    </div>
    <div class="cp-stats">
      <div class="cp-stat">
        <div class="cp-stat-label">${sel ? 'Formula weight' : 'Formula total'}</div>
        <div class="cp-stat-val">${sel ? '<input type="number" class="cp-num" id="cpPartWt" step="0.01" min="0" inputmode="decimal" aria-label="Formula weight in grams"><em>g</em>' : '<span id="cpRootWt"></span>'}</div>
      </div>
      <div class="cp-stat">
        <div class="cp-stat-label">Prepare weight</div>
        <div class="cp-stat-val"><span id="cpPartPrep"></span></div>
      </div>
      ${sel ? `
      <div class="cp-stat">
        <div class="cp-stat-label">Yield</div>
        <div class="cp-stat-val"><input type="number" class="cp-num" id="cpPartYield" step="0.01" min="0.01" max="999.99" placeholder="100" inputmode="decimal" aria-label="Part yield percent"><em>%</em></div>
      </div>
      <div class="cp-stat">
        <div class="cp-stat-label">${escapeHtml(shareLabel)}</div>
        <div class="cp-stat-val"><input type="number" class="cp-num" id="cpPartPct" step="0.01" min="0" max="100" inputmode="decimal" aria-label="${escapeHtml(shareLabel)}"><em>%</em></div>
      </div>` : ''}
    </div>
    <div class="cp-tabs cp-lock-exempt" role="tablist">
      <button type="button" role="tab" class="cp-tab${state.tab === 'ing' ? ' active' : ''}" data-tab="ing" aria-selected="${state.tab === 'ing'}">${sel ? 'Ingredients' : 'Parts'}</button>
      <button type="button" role="tab" class="cp-tab${state.tab === 'proc' ? ' active' : ''}" data-tab="proc" aria-selected="${state.tab === 'proc'}">Process</button>
    </div>
    <div class="cp-panel" id="cpPanel"></div>`;

  detailRefs = {
    count: host.querySelector('#cpCount'), rootWt: host.querySelector('#cpRootWt'), prep: host.querySelector('#cpPartPrep'),
    wt: host.querySelector('#cpPartWt'), yld: host.querySelector('#cpPartYield'), pct: host.querySelector('#cpPartPct'),
    name: host.querySelector('#cpPartName')
  };

  const crumbBar = host.querySelector('.cp-crumbs');
  if(crumbBar) crumbBar.scrollLeft = crumbBar.scrollWidth;   // narrow screens scroll the trail; keep the current part in view
  host.querySelectorAll('[data-crumb]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.crumb;
    setSelection(k === 'root' ? null : path[+k]);
  }));
  host.querySelectorAll('.cp-tab').forEach(b => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    host.querySelectorAll('.cp-tab').forEach(x => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-selected', on); });
    renderPanel();
  }));

  if(sel) wirePartHeader(sel);
  wireHeadMenu(sel);
  renderPanel();
  updateDetailDisplays();
  lockSubtree(host);
}

function wirePartHeader(sel){
  const { name, wt, yld, pct } = detailRefs;
  name.value = sel.name || '';
  name.addEventListener('input', () => {
    sel.name = name.value;
    const cur = document.getElementById('cpCrumbCurrent'); if(cur) cur.textContent = partLabel(sel);
    renderNavLabelsOnly();
    syncNavToggleLabel();
    renderProcesses(R);
    scheduleSave();
  });

  // Scaling a Part's weight / share: same capture-at-focus approach as the classic header fields.
  let base = null, snap = null;
  const begin = () => { base = partTotalWeight(sel); snap = snapshotWeights(sel.items); };
  const end = el => { base = null; snap = null; refreshDisplays(R); setNum(el, el === wt ? partTotalWeight(sel) : sel.percent); };
  wt.addEventListener('focus', begin);
  wt.addEventListener('input', () => {
    const v = parseFloat(wt.value);
    if(!isNaN(v) && v >= 0) scalePartTo(sel, v, base, snap);
    scheduleSave();
  });
  wt.addEventListener('blur', () => end(wt));
  commitOnEnter(wt); selectOnFocus(wt);

  pct.addEventListener('focus', begin);
  pct.addEventListener('input', () => {
    const v = parseFloat(pct.value);
    if(isNaN(v) || v < 0) return;
    const others = siblingsWeightExcluding(siblingsOfSelected(), sel);
    const f = v / 100;
    if(others > 0 && f < 1) scalePartTo(sel, f * others / (1 - f), base, snap);
    scheduleSave();
  });
  pct.addEventListener('blur', () => end(pct));
  commitOnEnter(pct); selectOnFocus(pct);

  yld.addEventListener('input', () => {
    sel.prepYieldPct = yld.value === '' ? null : (parseFloat(yld.value) || null);
    yld.classList.toggle('invalid', !isValidYieldPct(yld.value));
    yld.title = isValidYieldPct(yld.value) ? '' : 'Yield must be between 0.01% and 999.99%';
    scheduleSave();
  });
  yld.addEventListener('blur', () => refreshDisplays(R));
  commitOnEnter(yld);
}
function renderNavLabelsOnly(){
  document.querySelectorAll('#cpTree .cp-node').forEach(el => {
    const id = el.dataset.nid;
    if(id === 'root') return;
    const part = navMap.get(id);
    const nameEl = el.querySelector('.cp-node-name');
    if(part && nameEl) nameEl.textContent = partLabel(part);
  });
}

function wireHeadMenu(sel){
  document.getElementById('cpHeadMenu').addEventListener('click', e => {
    const btn = e.currentTarget;
    const entries = [];
    entries.push({ icon: 'plus', label: sel ? 'Add sub-part' : 'Add part', onClick: () => addPart() });
    if(sel){
      const sibs = siblingsOfSelected();
      entries.push({ icon: 'chevron-up', label: 'Move up', disabled: sibs.indexOf(sel) <= 0, onClick: () => { if(moveWithin(sibs, sel, -1)) afterStructureChange(); } });
      entries.push({ icon: 'chevron-down', label: 'Move down', disabled: sibs.indexOf(sel) >= sibs.length - 1, onClick: () => { if(moveWithin(sibs, sel, 1)) afterStructureChange(); } });
      entries.push({ icon: 'move', label: 'Move to…', onClick: () => openMoveTo(sel, sibs) });
      entries.push('sep');
      const isLastTop = sibs === R.parts && R.parts.length <= 1;
      entries.push({ icon: 'trash-2', label: 'Delete part', danger: true, disabled: isLastTop, onClick: () => deleteSelectedPart() });
    }
    openMenu(btn, entries);
  });
}

function addPart(){
  const target = containerItems();
  const part = blankPart(state.selected ? '' : `Part ${R.parts.length + 1}`);
  target.push(part);
  state.selected = part;
  state.selIdx = idxPathOf(R.parts, part);
  state.tab = 'ing';
  afterStructureChange();
  setTimeout(() => { const n = document.getElementById('cpPartName'); if(n){ n.focus(); n.select(); } }, 0);
}
function deleteSelectedPart(){
  const sel = state.selected;
  if(!sel) return;
  if(!confirm(`Delete "${sel.name || 'this part'}" and everything inside it?`)) return;
  const path = currentPath();
  const sibs = siblingsOfSelected();
  const i = sibs.indexOf(sel);
  if(i !== -1) sibs.splice(i, 1);
  state.selected = path.length > 1 ? path[path.length - 2] : null;
  state.selIdx = state.selected ? idxPathOf(R.parts, state.selected) : null;
  afterStructureChange();
}
function addIngredient(){
  const sel = state.selected;
  if(!sel) return;
  if(hasUnresolvedIngredient(sel)){
    alert('This part has an ingredient that is not yet in the library. Please select from the library or add it first before adding the next row.');
    return;
  }
  const ing = blankIngredient();
  sel.items.push(ing);
  renderParts(R);
  refreshDisplays(R);
  scheduleSave();
  if(isCards()){
    openItemSheet(ing, sel.items);
  }else{
    setTimeout(() => {
      const rows = document.querySelectorAll('#cpPanel .cp-row-ing .cp-name-input');
      const last = rows[rows.length - 1];
      if(last){ last.focus(); last.scrollIntoView({ block: 'nearest' }); }
    }, 0);
  }
}

/* ---------- panel: Ingredients / Process ---------- */
function renderPanel(){
  const panel = document.getElementById('cpPanel');
  if(!panel) return;
  closeMenu();
  rowRefs = [];
  if(state.tab === 'proc'){ renderProcessPanel(panel); lockSubtree(panel); return; }
  const sel = state.selected;
  const path = currentPath();
  const ownerName = sel ? partLabel(sel) : recipeLabel();
  panel.innerHTML = `
    <div class="cp-listbar">
      <div class="cp-search cp-search-wide cp-lock-exempt">${icon('search', 16)}<input type="search" id="cpRowSearch" placeholder="${sel ? 'Search ingredients…' : 'Search parts…'}" aria-label="Search this list" value="${escapeHtml(state.rowQuery)}"></div>
      <div class="cp-listbar-actions">
        ${sel ? `<button type="button" class="btn cp-btn" id="cpAddSub">${icon('plus', 16)} Add sub-part</button>
                 <button type="button" class="btn btn-primary cp-btn" id="cpAddIng">${icon('plus', 16)} Add ingredient</button>`
              : `<button type="button" class="btn btn-primary cp-btn" id="cpAddPart">${icon('plus', 16)} Add part</button>`}
      </div>
    </div>
    <div class="cp-table" role="table" aria-label="${escapeHtml(ownerName)} contents">
      <div class="cp-row cp-thead" role="row">
        <div class="cp-c-handle"></div>
        <div class="cp-c-name" role="columnheader">${sel ? 'Ingredient' : 'Part'}</div>
        <div class="cp-c-prep num" role="columnheader">Prepare (g)</div>
        <div class="cp-c-wt num" role="columnheader">Formula (g)</div>
        <div class="cp-c-pct num" role="columnheader" id="cpPctHead">% of ${escapeHtml(ownerName)}</div>
        <div class="cp-c-note" role="columnheader">${sel ? 'Notes' : ''}</div>
        <div class="cp-c-menu"></div>
      </div>
      <div class="cp-rows" id="cpRows"></div>
      <div class="cp-row cp-tfoot" role="row">
        <div class="cp-c-handle"></div>
        <div class="cp-c-name"><strong>Total</strong></div>
        <div class="cp-c-prep num"><strong id="cpFootPrep"></strong></div>
        <div class="cp-c-wt num"><strong id="cpFootWt"></strong></div>
        <div class="cp-c-pct num"><strong id="cpFootPct"></strong></div>
        <div class="cp-c-note cp-foot-ok" id="cpFootOk"></div>
        <div class="cp-c-menu"></div>
      </div>
    </div>
    <div class="cp-foot-note">${icon('alert-triangle', 14)}<span>Percentages are relative to ${sel ? 'the selected part' : 'the whole recipe'} (<b>${escapeHtml(ownerName)}</b>).</span></div>
    <div class="cp-mbar">
      <div class="cp-mbar-total"><span>Total</span><strong id="cpMbarWt"></strong><span class="cp-mbar-dot">•</span><strong id="cpMbarPct"></strong></div>
      ${sel ? `<button type="button" class="btn btn-primary cp-btn cp-mbar-add" id="cpAddIngM">${icon('plus', 18)} Add ingredient</button>`
            : `<button type="button" class="btn btn-primary cp-btn cp-mbar-add" id="cpAddPartM">${icon('plus', 18)} Add part</button>`}
    </div>`;

  const rowsEl = panel.querySelector('#cpRows');
  const items = containerItems();
  if(items.length === 0){
    rowsEl.innerHTML = '<div class="cp-empty">No parts yet — use “Add part” to create the first one</div>';
  }
  items.forEach(item => rowsEl.appendChild(isPart(item) ? buildPartRow(item, items) : buildIngredientRow(item, items)));

  const search = panel.querySelector('#cpRowSearch');
  function applyRowFilter(){
    const qq = state.rowQuery.trim().toLowerCase();
    rowRefs.forEach(ref => {
      const name = isPart(ref.item) ? partLabel(ref.item) : (ref.item.name || '');
      ref.row.hidden = !!qq && !name.toLowerCase().includes(qq);
    });
  }
  search.addEventListener('input', () => { state.rowQuery = search.value; applyRowFilter(); });
  applyRowFilter();

  const on = (id, fn) => { const el = panel.querySelector(id); if(el) el.addEventListener('click', fn); };
  on('#cpAddIng', addIngredient); on('#cpAddIngM', addIngredient);
  on('#cpAddSub', addPart); on('#cpAddPart', addPart); on('#cpAddPartM', addPart);

  updateDetailDisplays();
  lockSubtree(panel);
}

function rowMenuEntries(item, items){
  const part = isPart(item);
  const i = items.indexOf(item);
  const entries = [];
  entries.push({ icon: part ? 'folder' : 'file-text', label: part ? 'Edit part…' : 'Edit details…', onClick: () => openItemSheet(item, items) });
  if(part) entries.push({ icon: 'chevron-right', label: 'Open', onClick: () => setSelection(item) });
  entries.push({ icon: 'chevron-up', label: 'Move up', disabled: i <= 0, onClick: () => { if(moveWithin(items, item, -1)) afterStructureChange(); } });
  entries.push({ icon: 'chevron-down', label: 'Move down', disabled: i >= items.length - 1, onClick: () => { if(moveWithin(items, item, 1)) afterStructureChange(); } });
  entries.push({ icon: 'move', label: 'Move to…', onClick: () => openMoveTo(item, items) });
  entries.push('sep');
  const lastTop = items === R.parts && R.parts.length <= 1;
  entries.push({ icon: 'trash-2', label: part ? 'Delete part' : 'Delete', danger: true, disabled: lastTop, onClick: () => {
    if(part && !confirm(`Delete "${item.name || 'this part'}" and everything inside it?`)) return;
    const idx = items.indexOf(item);
    if(idx !== -1) items.splice(idx, 1);
    if(!part && items.length === 0) items.push(blankIngredient());
    afterStructureChange();
  } });
  return entries;
}

// Drag a row by its handle to reorder (or onto a node of the tree to move it there).
function wireRowDrag(row, item, items){
  const handle = row.querySelector('.cp-drag');
  handle.addEventListener('dragstart', e => {
    drag = { item, array: items };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'row');
    row.classList.add('dragging');
  });
  handle.addEventListener('dragend', () => { row.classList.remove('dragging'); drag = null; });
  row.addEventListener('dragover', e => {
    if(!drag || drag.item === item || drag.array !== items) return;
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    row.classList.toggle('drop-before', before);
    row.classList.toggle('drop-after', !before);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
  row.addEventListener('drop', e => {
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    row.classList.remove('drop-before', 'drop-after');
    if(!drag || drag.item === item || drag.array !== items) return;
    const moving = drag.item;
    items.splice(items.indexOf(moving), 1);
    let at = items.indexOf(item);
    if(!before) at += 1;
    items.splice(at, 0, moving);
    drag = null;
    afterStructureChange();
  });
}

function rowShell(kind){
  const row = document.createElement('div');
  row.className = `cp-row cp-row-${kind}`;
  row.setAttribute('role', 'row');
  return row;
}
const cellFields = (pctLabel) => `
  <div class="cp-cell cp-c-prep"><span class="cp-cell-label">Prepare (g)</span><span class="cp-prep"></span></div>
  <div class="cp-cell cp-c-wt"><span class="cp-cell-label">Formula (g)</span><span class="cp-field"><input type="number" class="cp-num cp-wt-input" step="0.01" min="0" inputmode="decimal" aria-label="Formula weight in grams"><em>g</em></span></div>
  <div class="cp-cell cp-c-pct"><span class="cp-cell-label cp-pct-label">${escapeHtml(pctLabel)}</span><span class="cp-field"><input type="number" class="cp-num cp-pct-input" step="0.01" min="0" max="100" inputmode="decimal" aria-label="${escapeHtml(pctLabel)}"><em>%</em></span></div>`;

function buildIngredientRow(ing, items){
  const row = rowShell('ing');
  const pctLabel = `% of ${state.selected ? partLabel(state.selected) : recipeLabel()}`;
  row.innerHTML = `
    <div class="cp-cell cp-c-handle"><span class="cp-drag" draggable="true" title="Drag to reorder — or drop it on a part in the structure to move it there">${icon('grip-vertical', 16)}</span></div>
    <div class="cp-cell cp-c-name">
      <div class="cp-name-wrap"><input type="text" class="cp-name-input" placeholder="Search the library or type a name" autocomplete="off" aria-label="Ingredient name"><div class="cp-sugg-box"></div></div>
      <div class="cp-name-static"></div>
      <div class="cp-hint"></div>
    </div>
    ${cellFields(pctLabel)}
    <div class="cp-cell cp-c-note"><button type="button" class="cp-icon-btn cp-note-btn" title="Details and note" aria-label="Details and note">${icon('file-text', 18)}</button></div>
    <div class="cp-cell cp-c-menu"><button type="button" class="cp-icon-btn cp-menu-btn" aria-haspopup="menu" aria-label="Row actions">${icon('ellipsis', 18)}</button></div>`;

  const nameIn = row.querySelector('.cp-name-input'), nameStatic = row.querySelector('.cp-name-static');
  const hintEl = row.querySelector('.cp-hint');
  const wtIn = row.querySelector('.cp-wt-input'), pctIn = row.querySelector('.cp-pct-input');
  const noteBtn = row.querySelector('.cp-note-btn');
  nameIn.value = ing.name || '';

  function syncLibrary(m){
    const matched = m !== undefined ? m : findMaterialByLabel(nameIn.value);
    wtIn.disabled = !matched; pctIn.disabled = !matched;
    nameIn.classList.remove('is-linked', 'invalid');
    if(matched){ nameIn.classList.add('is-linked'); nameIn.title = materialTooltip(matched); } else { nameIn.title = ''; if(nameIn.value.trim()) nameIn.classList.add('invalid'); }
    const h = libraryHint(ing, matched);
    hintEl.textContent = h.text; hintEl.className = 'cp-hint ' + h.cls;
    hintEl.hidden = !h.text;
    nameStatic.textContent = nameIn.value.trim() || 'Tap to choose an ingredient';
    nameStatic.classList.toggle('placeholder', !nameIn.value.trim());
    noteBtn.classList.toggle('has-note', !!(ing.note || '').trim());
    if(isLocked()){ wtIn.disabled = true; pctIn.disabled = true; }
  }
  wireNameCombo(nameIn, row.querySelector('.cp-sugg-box'), ing, m => syncLibrary(m));
  syncLibrary();

  wtIn.addEventListener('input', () => { ing.weight = clampWeightInput(wtIn.value); scheduleSave(); });
  wtIn.addEventListener('blur', () => { refreshDisplays(R); setNum(wtIn, ing.weight); });
  commitOnEnter(wtIn, '#cpPanel .cp-wt-input'); selectOnFocus(wtIn);

  pctIn.addEventListener('input', () => {
    const v = parseFloat(pctIn.value);
    if(isNaN(v) || v < 0) return;
    const others = items.reduce((s, it) => it === ing ? s : s + itemWeight(it), 0);
    const f = v / 100;
    if(others > 0 && f < 1){ ing.weight = round4(f * others / (1 - f)); setNum(wtIn, ing.weight); }
    scheduleSave();
  });
  pctIn.addEventListener('blur', () => { refreshDisplays(R); setNum(pctIn, ing.percent); });
  commitOnEnter(pctIn, '#cpPanel .cp-pct-input'); selectOnFocus(pctIn);

  const openSheet = () => openItemSheet(ing, items);
  noteBtn.addEventListener('click', openSheet);
  row.querySelector('.cp-menu-btn').addEventListener('click', e => openMenu(e.currentTarget, rowMenuEntries(ing, items)));
  // On phones the whole card is the tap target; the library search + inline fields live in the sheet.
  row.addEventListener('click', e => {
    if(!isCards() || e.target.closest('.cp-menu-btn, .cp-note-btn, .cp-drag')) return;
    openSheet();
  });
  wireRowDrag(row, ing, items);
  rowRefs.push({ row, item: ing, kind: 'ing', wtIn, pctIn, prepEl: row.querySelector('.cp-prep'), nameStatic, noteBtn });
  return row;
}
const clampWeightInput = v => Math.max(0, parseFloat(v) || 0);

function buildPartRow(part, items){
  const row = rowShell('part');
  const pctLabel = `% of ${state.selected ? partLabel(state.selected) : recipeLabel()}`;
  row.innerHTML = `
    <div class="cp-cell cp-c-handle"><span class="cp-drag" draggable="true" title="Drag to reorder — or drop it on another part in the structure to nest it there">${icon('grip-vertical', 16)}</span></div>
    <div class="cp-cell cp-c-name">
      <button type="button" class="cp-part-link cp-lock-exempt" title="Open this part">${icon('folder', 18)}<span class="cp-part-link-text"><span class="cp-part-link-name"></span><small class="cp-part-link-sub"></small></span></button>
    </div>
    ${cellFields(pctLabel)}
    <div class="cp-cell cp-c-note"><button type="button" class="cp-icon-btn cp-open-btn cp-lock-exempt" title="Open this part" aria-label="Open this part">${icon('chevron-right', 18)}</button></div>
    <div class="cp-cell cp-c-menu"><button type="button" class="cp-icon-btn cp-menu-btn" aria-haspopup="menu" aria-label="Row actions">${icon('ellipsis', 18)}</button></div>`;
  const wtIn = row.querySelector('.cp-wt-input'), pctIn = row.querySelector('.cp-pct-input');
  const nameEl = row.querySelector('.cp-part-link-name'), subEl = row.querySelector('.cp-part-link-sub');

  let base = null, snap = null;
  const begin = () => { base = partTotalWeight(part); snap = snapshotWeights(part.items); };
  const end = (el, value) => { base = null; snap = null; refreshDisplays(R); setNum(el, value()); };
  wtIn.addEventListener('focus', begin);
  wtIn.addEventListener('input', () => { const v = parseFloat(wtIn.value); if(!isNaN(v) && v >= 0) scalePartTo(part, v, base, snap); scheduleSave(); });
  wtIn.addEventListener('blur', () => end(wtIn, () => partTotalWeight(part)));
  commitOnEnter(wtIn, '#cpPanel .cp-wt-input'); selectOnFocus(wtIn);
  pctIn.addEventListener('focus', begin);
  pctIn.addEventListener('input', () => {
    const v = parseFloat(pctIn.value);
    if(isNaN(v) || v < 0) return;
    const others = siblingsWeightExcluding(items, part);
    const f = v / 100;
    if(others > 0 && f < 1) scalePartTo(part, f * others / (1 - f), base, snap);
    scheduleSave();
  });
  pctIn.addEventListener('blur', () => end(pctIn, () => part.percent));
  commitOnEnter(pctIn, '#cpPanel .cp-pct-input'); selectOnFocus(pctIn);

  const open = () => setSelection(part);
  row.querySelector('.cp-part-link').addEventListener('click', e => { e.stopPropagation(); open(); });
  row.querySelector('.cp-open-btn').addEventListener('click', e => { e.stopPropagation(); open(); });
  row.querySelector('.cp-menu-btn').addEventListener('click', e => openMenu(e.currentTarget, rowMenuEntries(part, items)));
  row.addEventListener('click', e => {
    if(!isCards() || e.target.closest('.cp-menu-btn, .cp-drag, .cp-part-link, .cp-open-btn, input')) return;
    open();
  });
  wireRowDrag(row, part, items);
  rowRefs.push({ row, item: part, kind: 'part', wtIn, pctIn, prepEl: row.querySelector('.cp-prep'), nameEl, subEl });
  return row;
}

/* ---------- Process tab (read-only; editing stays in "5. Process Steps") ---------- */
function renderProcessPanel(panel){
  const sel = state.selected;
  const name = sel ? partLabel(sel) : '';
  const list = (R.processes || []).filter(p => {
    const hasContent = (p.title || '').trim() !== '' || (p.steps || []).some(s => (s || '').trim() !== '');
    if(!hasContent) return false;
    if(!sel) return true;
    return (p.components || []).some(c => (c.name || '').trim() === (sel.name || '').trim() && (sel.name || '').trim() !== '');
  });
  panel.innerHTML = `
    <div class="cp-proc-note">${sel
      ? `Process steps that use <b>${escapeHtml(name)}</b> as a component.`
      : 'All process steps for this recipe.'}
      <button type="button" class="btn cp-btn cp-lock-exempt" id="cpGoProcess">Open Process Steps</button></div>
    ${list.length ? list.map(p => {
      const steps = (p.steps || []).filter(s => (s || '').trim() !== '');
      return `<div class="cp-proc"><div class="cp-proc-title">${escapeHtml(p.title || 'Untitled process')}</div>
        ${steps.length ? `<ol>${steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : '<div class="cp-hint">No steps yet</div>'}</div>`;
    }).join('') : '<div class="cp-empty">No process steps use this part yet — add it as a Component in “5. Process Steps”.</div>'}`;
  panel.querySelector('#cpGoProcess').addEventListener('click', () => {
    const t = document.getElementById('processesList');
    if(t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/* ---------- in-place refresh (every figure re-derived from the live data) ---------- */
function updateDetailDisplays(){
  if(!R || !detailRefs) return;
  const sel = state.selected;
  const path = currentPath();
  const mult = multFor(path);
  const items = containerItems();
  const total = sel ? partTotalWeight(sel) : R.parts.reduce((s, p) => s + partTotalWeight(p), 0);
  const prepTotal = sel ? partPrepareWeight(sel) * multFor(path.slice(0, -1)) : R.parts.reduce((s, p) => s + partPrepareWeight(p), 0);

  if(detailRefs.count) detailRefs.count.textContent = rowCountText(sel);
  if(detailRefs.rootWt) detailRefs.rootWt.textContent = formatWeight(total);
  if(detailRefs.prep){
    detailRefs.prep.textContent = formatWeight(prepTotal);
    const py = parseFloat(sel && sel.prepYieldPct);
    detailRefs.prep.classList.toggle('lossy', !!sel && isFinite(py) && py > 0 && py < 100);
  }
  if(sel){
    setNum(detailRefs.wt, total);
    setNum(detailRefs.pct, sel.percent);
    if(detailRefs.yld && document.activeElement !== detailRefs.yld) detailRefs.yld.value = sel.prepYieldPct != null ? sel.prepYieldPct : '';
  }

  rowRefs.forEach(ref => {
    const it = ref.item;
    if(ref.kind === 'ing'){
      setNum(ref.wtIn, it.weight);
      setNum(ref.pctIn, it.percent);
      const prep = computePrepareWeight(it.weight, it.prepYieldPct) * mult;
      ref.prepEl.textContent = fixed2(prep);
      const y = parseFloat(it.prepYieldPct);
      ref.prepEl.classList.toggle('lossy', isFinite(y) && y > 0 && y < 100);
      ref.noteBtn.classList.toggle('has-note', !!(it.note || '').trim());
    }else{
      const w = partTotalWeight(it);
      setNum(ref.wtIn, w);
      setNum(ref.pctIn, it.percent);
      ref.prepEl.textContent = fixed2(partPrepareWeight(it) * mult);
      ref.nameEl.textContent = partLabel(it);
      const n = it.items.filter(x => isPart(x) || (x.name || '').trim() !== '').length;
      ref.subEl.textContent = `${n} item${n === 1 ? '' : 's'}`;
    }
  });

  const footWt = document.getElementById('cpFootWt');
  if(footWt){
    footWt.textContent = fixed2(total);
    const pct = items.reduce((s, it) => s + (parseFloat(it.percent) || 0), 0);
    document.getElementById('cpFootPrep').textContent = fixed2(prepTotal);
    document.getElementById('cpFootPct').textContent = `${pct.toFixed(2)}%`;
    const ok = total <= 0 || Math.abs(pct - 100) < 0.05;
    const okEl = document.getElementById('cpFootOk');
    okEl.innerHTML = total > 0 ? `<span class="cp-ok ${ok ? '' : 'bad'}">${icon(ok ? 'check' : 'alert-triangle', 14)} Percent total: ${Math.round(pct * 100) / 100}%</span>` : '';
    const mw = document.getElementById('cpMbarWt'), mp = document.getElementById('cpMbarPct');
    if(mw) mw.textContent = formatWeight(total);
    if(mp) mp.textContent = `${pct.toFixed(2)}%`;
  }
  updateNavWeights();
}

/* ---------- entry point (called by recipes.js renderParts) ---------- */
export function renderWorkspace(r){
  R = r;
  const host = document.getElementById('cpWorkspace');
  if(!host) return;
  resolveSelection(r);
  closeMenu();
  host.classList.toggle('nav-open', state.navOpen);
  host.innerHTML = `
    <button type="button" class="cp-nav-toggle cp-lock-exempt" id="cpNavToggle" aria-expanded="${state.navOpen}" aria-controls="cpNav">
      ${icon('git-branch', 18)}<span class="cp-nav-toggle-text"><b>Recipe structure</b><small id="cpNavToggleSel"></small></span>${icon('chevron-down', 18)}
    </button>
    <div class="cp-body">
      <aside class="cp-nav" id="cpNav" aria-label="Recipe structure">
        <div class="cp-nav-head">Recipe structure</div>
        <div class="cp-search cp-lock-exempt">${icon('search', 16)}<input type="search" id="cpNavSearch" placeholder="Search ingredients or parts…" aria-label="Search the recipe structure" value="${escapeHtml(state.navQuery)}"></div>
        <div class="cp-tree cp-lock-exempt" id="cpTree" role="tree" aria-label="Parts"></div>
        <button type="button" class="btn cp-btn cp-nav-add" id="cpNavAdd">${icon('plus', 16)} <span id="cpNavAddText"></span></button>
      </aside>
      <section class="cp-detail" id="cpDetail" aria-live="polite"></section>
    </div>`;

  document.getElementById('cpNavToggle').addEventListener('click', () => {
    state.navOpen = !state.navOpen;
    host.classList.toggle('nav-open', state.navOpen);
    document.getElementById('cpNavToggle').setAttribute('aria-expanded', state.navOpen);
  });
  document.getElementById('cpNavSearch').addEventListener('input', e => { state.navQuery = e.target.value; renderNav(); });
  const addBtn = document.getElementById('cpNavAdd');
  document.getElementById('cpNavAddText').textContent = state.selected ? 'Add sub-part' : 'Add part';
  addBtn.addEventListener('click', addPart);

  renderNav();
  renderDetail();
  syncNavToggleLabel();
  lockSubtree(addBtn);
  registerWorkspaceUpdater(() => {
    // The tree text can also change from outside (a renamed recipe) -- keep labels current.
    updateDetailDisplays();
  });
}
