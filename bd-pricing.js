// BD Pricing Workspace -- the screen. Pure maths lives in bd-pricing-calc.js
// (unit-tested on its own); this file only collects inputs, shows the
// results, and saves/loads proposals.
//
// Rendering model: renderAll() rebuilds the page (used when the structure
// changes: scenario/mode/recipe/currency switches, extra-cost rows added or
// removed); every plain keystroke only calls refresh(), which rewrites the
// computed cells in place, so typing never loses focus.
import {
  escapeHtml, icon, recipes, recipeDisplayLabel, currentUser, uid, wireModalOverlayClose,
  bdProposalsCol, canAccessBdPricing, formatActivityDateTime, playContentTransition
} from './app.js';
import { doc, setDoc, deleteDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { computeRecipeOverviewData } from './recipes-excel.js';
import { TIER_KEYS, TIER_LABELS, isNum, calcChain, calcReverse } from './bd-pricing-calc.js';

const DRAFT_KEY = 'forge_bdWorkspaceDraft';
const CHANNELS = ['ร้านอาหาร', 'ค้าปลีก / ซูเปอร์มาร์เก็ต', 'Food Service', 'ส่งออก', 'ออนไลน์', 'อื่นๆ'];
const CURRENCIES = ['THB', 'USD', 'JPY', 'CNY', 'EUR'];
const STEP_OPTIONS = [
  { v: 0.05, l: '0.05' }, { v: 0.01, l: '0.01' }, { v: 0.1, l: '0.10' },
  { v: 0.5, l: '0.50' }, { v: 1, l: '1.00' }, { v: 0, l: 'ไม่ปัดเศษ' }
];
const TIER_ICONS = { factory: '1', company: '2', customer: '3' };

let ws = null;                 // the workspace being edited
let proposals = [];            // saved proposals (Firestore, live)
let unsubscribeProposals = null;
let currentProposalId = null;  // set once the workspace has been saved / loaded from a saved one
let draftTimer = null;

/* ---------- model ---------- */
function blankScenario(name){
  return {
    id: uid(), name,
    mode: 'cost',              // 'cost' = start from cost, 'target' = start from the target price
    materialOverride: null,    // null = use the recipe's cost; a number = typed by hand
    tiers: [{ o: 25, m: 10, w: null }, { o: 5, m: 10, w: null }, { o: 25, m: 10, w: null }],   // expense % / target profit %, per tier, of THAT tier's selling price
    extras: [],                // { id, name, tier, unit: 'amount' | 'percent', value }
    targetPrice: null,
    targetRef: 'customer',     // which price the target means: 'company' (company -> customer) or 'customer' (customer's resale)
    qty: 10000
  };
}
function blankWorkspace(){
  const scenarios = [blankScenario('ราคาปกติ'), blankScenario('ราคาต่อรอง'), blankScenario('ยอดสั่งซื้อสูง')];
  return {
    customer: '', project: '', recipeId: '', channel: CHANNELS[0],
    currency: 'THB', exchangeRate: null, servingG: null,
    step: 0.05, minMarginPct: 10,
    scenarios, activeScenarioId: scenarios[0].id
  };
}
const clone = o => JSON.parse(JSON.stringify(o));
function activeScenario(){
  return ws.scenarios.find(s => s.id === ws.activeScenarioId) || ws.scenarios[0];
}
function loadDraft(){
  try{
    const raw = localStorage.getItem(DRAFT_KEY);
    if(!raw) return null;
    const d = JSON.parse(raw);
    return (d && Array.isArray(d.scenarios) && d.scenarios.length >= 3) ? d : null;
  }catch(e){ return null; }
}
function saveDraftSoon(){
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try{ localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...ws, _proposalId: currentProposalId })); }catch(e){ /* storage off -- skip */ }
  }, 400);
}

/* ---------- money / numbers ---------- */
function money(v){
  if(!isNum(v)) return '—';
  const n = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return ws.currency === 'THB' ? `฿${n}` : `${n} ${ws.currency}`;
}
const pctText = v => isNum(v) ? `${(v * 100).toFixed(1)}%` : '—';
const val = v => (v == null || v === '') ? '' : v;
const stepValue = () => isNum(Number(ws.step)) ? Number(ws.step) : 0.05;
const rateOk = () => ws.currency === 'THB' || (isNum(ws.exchangeRate) && ws.exchangeRate > 0);

// Material cost per serving in the workspace currency, with every reason it
// might be missing or incomplete spelled out (never invented).
function materialInfo(sc){
  const warns = [];
  if(isNum(sc.materialOverride)) return { cost: sc.materialOverride, source: 'manual', warns };
  const recipe = ws.recipeId ? recipes.find(r => r.id === ws.recipeId) : null;
  if(!recipe) return { cost: null, source: 'none', warns };
  const ov = computeRecipeOverviewData(recipe);
  if(!ov.hasCost){
    warns.push('สูตรนี้ยังไม่มีราคาวัตถุดิบ — ยังคำนวณต้นทุนอัตโนมัติไม่ได้');
    return { cost: null, source: 'recipe', warns };
  }
  if(ov.costSuffix === '*') warns.push('วัตถุดิบบางรายการยังไม่มีราคา — ต้นทุนรวมยังไม่ครบ (ต่ำกว่าความเป็นจริง)');
  if(!(isNum(ws.servingG) && ws.servingG > 0)){
    return { cost: null, source: 'recipe', warns: [...warns, 'ใส่ขนาด Serving (กรัม) เพื่อคำนวณต้นทุนต่อ Serving'] };
  }
  const thb = (ov.totalCost / ov.totalRecipeWeight) * ws.servingG;
  if(ws.currency !== 'THB'){
    if(!rateOk()) return { cost: null, source: 'recipe', warns: [...warns, 'ยังไม่ได้ใส่อัตราแลกเปลี่ยน จึงแปลงต้นทุนเป็นสกุลเงินนี้ไม่ได้'] };
    return { cost: thb / ws.exchangeRate, source: 'recipe', warns };
  }
  return { cost: thb, source: 'recipe', warns };
}

// Everything that must be fixed before a price can be trusted.
function globalErrors(sc){
  const errs = [];
  if(!(isNum(ws.servingG) && ws.servingG > 0)) errs.push('ขนาด Serving ต้องมากกว่า 0 กรัม');
  if(!rateOk()) errs.push(`สกุลเงิน ${ws.currency} ต้องมีอัตราแลกเปลี่ยน (1 ${ws.currency} = กี่ THB) — ระบบไม่สร้างอัตราขึ้นเอง`);
  if(sc.qty != null && (!isNum(sc.qty) || sc.qty < 0)) errs.push('ปริมาณขายต้องเป็นตัวเลขที่ไม่ติดลบ');
  if(isNum(sc.materialOverride) && sc.materialOverride < 0) errs.push('ต้นทุนวัตถุดิบต้องไม่ติดลบ');
  sc.extras.forEach(e => {
    if(e.value != null && e.value !== '' && (!isNum(e.value) || e.value < 0)) errs.push(`ค่าใช้จ่าย "${e.name || 'ไม่มีชื่อ'}" ต้องเป็นตัวเลขที่ไม่ติดลบ`);
  });
  const seen = new Map();
  sc.extras.forEach(e => {
    const n = (e.name || '').trim().toLowerCase();
    if(!n) return;
    const key = e.tier + '|' + n;
    if(seen.has(key)) errs.push(`ค่าใช้จ่าย "${e.name.trim()}" ซ้ำกันในลำดับ${TIER_LABELS[e.tier]} — ลบหรือรวมรายการเพื่อไม่ให้นับซ้ำ`);
    seen.set(key, true);
  });
  if(sc.mode === 'target' && !(isNum(sc.targetPrice) && sc.targetPrice > 0)) errs.push('กรอกราคาเป้าหมาย (มากกว่า 0)');
  return errs;
}
function duplicateAcrossTiers(sc){
  const byName = new Map();
  sc.extras.forEach(e => {
    const n = (e.name || '').trim().toLowerCase();
    if(!n) return;
    if(!byName.has(n)) byName.set(n, new Set());
    byName.get(n).add(e.tier);
  });
  return [...byName.entries()].filter(([, tiers]) => tiers.size > 1).map(([n]) => n);
}

// Full result for one scenario.
function compute(sc){
  const material = materialInfo(sc);
  const errors = globalErrors(sc);
  const chain = calcChain(sc, material.cost, stepValue());
  const out = { sc, material, errors, chain, ok: !errors.length && chain.every(t => t.ok) };
  if(sc.mode === 'target' && isNum(sc.targetPrice) && sc.targetPrice > 0){
    const refIdx = sc.targetRef === 'company' ? 1 : 2;
    out.refIdx = refIdx;
    out.reverse = calcReverse(sc, sc.targetPrice, refIdx, stepValue());
    out.gap = chain[refIdx].ok ? chain[refIdx].price - sc.targetPrice : null;   // > 0: calculated price is above the target
  }
  if(chain[1].ok){
    out.monthlyProfit = isNum(sc.qty) ? Math.round(chain[1].profit * sc.qty) : null;   // full-precision profit x servings, rounded only at the end
    out.marginOk = chain[1].margin * 100 >= ws.minMarginPct - 1e-9;
  }
  return out;
}

/* ---------- page ---------- */
export function mountBdPricingView(){
  const main = document.getElementById('mainArea');
  main.classList.remove('trials-a4-width');
  main.classList.add('main-wide');
  if(!canAccessBdPricing()){
    main.innerHTML = `
      <div class="main-header"><div class="section-title-display">BD Pricing Workspace</div></div>
      <div class="card"><div class="overview-empty">หน้านี้เปิดให้เฉพาะทีม Business Development — ติดต่อผู้ดูแลระบบเพื่อขอสิทธิ์เข้าใช้งาน</div></div>`;
    return;
  }
  if(!ws){
    const draft = loadDraft();
    if(draft){ currentProposalId = draft._proposalId || null; delete draft._proposalId; ws = draft; }
    else ws = blankWorkspace();
  }
  if(!unsubscribeProposals){
    unsubscribeProposals = onSnapshot(bdProposalsCol, snap => {
      proposals = snap.docs.map(d => d.data());
      const btn = document.getElementById('bdpSavedBtn');
      if(btn) btn.textContent = `ข้อเสนอที่บันทึก (${proposals.length})`;
      if(document.getElementById('bdModalOverlay')?.dataset.view === 'saved') renderSavedModal();
    }, err => console.error('Forge: BD proposals listener error', err));
  }
  renderAll();
  playContentTransition(main);
}

export function resetBdPricingState(){
  if(unsubscribeProposals){ unsubscribeProposals(); unsubscribeProposals = null; }
  proposals = [];
  ws = null;
  currentProposalId = null;
}

function fieldNum(path, extra = ''){
  return `<input type="number" step="any" data-bd="${path}" data-type="num" ${extra}>`;
}

function renderAll(){
  const main = document.getElementById('mainArea');
  const sc = activeScenario();
  const recipeOptions = [...recipes].sort((a, b) => recipeDisplayLabel(a).localeCompare(recipeDisplayLabel(b), undefined, { sensitivity: 'base', numeric: true }));
  main.innerHTML = `
    <div class="bdp-header">
      <div>
        <div class="section-title-display">BD Pricing Workspace</div>
        <div class="bdp-sub">วางแผนราคาและกำไรสำหรับข้อเสนอลูกค้า</div>
      </div>
      <div class="bdp-header-actions">
        <button type="button" class="btn btn-sm" id="bdpSavedBtn">ข้อเสนอที่บันทึก (${proposals.length})</button>
        <button type="button" class="btn bdp-btn-primary" id="bdpSaveBtn">${icon('save', 16)} บันทึกข้อเสนอ</button>
      </div>
    </div>
    <div class="bdp-layout">
      <div class="bdp-main">

        <section class="bdp-card">
          <div class="bdp-card-title"><span class="bdp-num">1</span> ข้อมูลโอกาสขาย</div>
          <div class="bdp-grid bdp-grid-4">
            <label class="bdp-field"><span>ลูกค้า</span><input type="text" data-bd="ws.customer" data-type="text" value="${escapeHtml(ws.customer)}" placeholder="เช่น Customer A"></label>
            <label class="bdp-field"><span>ชื่อโครงการ</span><input type="text" data-bd="ws.project" data-type="text" value="${escapeHtml(ws.project)}" placeholder="เช่น New Sauce"></label>
            <label class="bdp-field"><span>สินค้าหรือสูตร</span>
              <select data-bd="ws.recipeId" data-type="recipe">
                <option value="">— ไม่ผูกสูตร (กรอกต้นทุนเอง) —</option>
                ${recipeOptions.map(r => `<option value="${escapeHtml(r.id)}" ${r.id === ws.recipeId ? 'selected' : ''}>${escapeHtml(recipeDisplayLabel(r))}</option>`).join('')}
              </select>
            </label>
            <label class="bdp-field"><span>ช่องทางขาย</span>
              <select data-bd="ws.channel" data-type="text">
                ${CHANNELS.map(c => `<option ${c === ws.channel ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
              </select>
            </label>
            <label class="bdp-field"><span>สกุลเงิน</span>
              <select data-bd="ws.currency" data-type="currency">
                ${CURRENCIES.map(c => `<option ${c === ws.currency ? 'selected' : ''}>${c}</option>`).join('')}
              </select>
            </label>
            <label class="bdp-field" id="bdpRateField" style="${ws.currency === 'THB' ? 'display:none;' : ''}"><span>อัตราแลกเปลี่ยน (1 ${escapeHtml(ws.currency)} = ? THB)</span>${fieldNum('ws.exchangeRate', `value="${escapeHtml(val(ws.exchangeRate))}" min="0" placeholder="เช่น 36.50"`)}</label>
            <label class="bdp-field"><span>ขนาดต่อ Serving</span><div class="bdp-unit-input">${fieldNum('ws.servingG', `value="${escapeHtml(val(ws.servingG))}" min="0" placeholder="เช่น 162"`)}<em>g</em></div></label>
            <label class="bdp-field"><span>ปริมาณขายคาดการณ์ต่อเดือน <small>(${escapeHtml(sc.name)})</small></span><div class="bdp-unit-input">${fieldNum('sc.qty', `value="${escapeHtml(val(sc.qty))}" min="0" placeholder="เช่น 10,000"`)}<em>Serving / เดือน</em></div></label>
          </div>
          <div class="bdp-material-row" id="bdpMaterialRow"></div>
        </section>

        <section class="bdp-card">
          <div class="bdp-card-title"><span class="bdp-num">2</span> วิธีตั้งราคา</div>
          <div class="bdp-mode-row">
            <div class="bdp-mode-btns">
              <button type="button" class="bdp-mode-btn ${sc.mode === 'cost' ? 'active' : ''}" data-act="mode" data-mode="cost">เริ่มจากต้นทุน</button>
              <button type="button" class="bdp-mode-btn ${sc.mode === 'target' ? 'active' : ''}" data-act="mode" data-mode="target">เริ่มจากราคาเป้าหมาย</button>
            </div>
            <div class="bdp-target-box" style="${sc.mode === 'target' ? '' : 'display:none;'}">
              <label class="bdp-field"><span>ราคาเป้าหมาย</span><div class="bdp-unit-input">${fieldNum('sc.targetPrice', `value="${escapeHtml(val(sc.targetPrice))}" min="0" placeholder="เช่น 89.00"`)}<em>${ws.currency === 'THB' ? '฿' : escapeHtml(ws.currency)} / Serving</em></div></label>
              <label class="bdp-field"><span>ราคาเป้าหมายนี้หมายถึง</span>
                <select data-bd="sc.targetRef" data-type="text-refresh">
                  <option value="company" ${sc.targetRef === 'company' ? 'selected' : ''}>ราคาที่บริษัทขายให้ลูกค้า</option>
                  <option value="customer" ${sc.targetRef === 'customer' ? 'selected' : ''}>ราคาที่ลูกค้าขายต่อปลายทาง</option>
                </select>
              </label>
            </div>
          </div>
          <div class="bdp-settings-row">
            <label class="bdp-field"><span>ปัดราคาขายขึ้นครั้งละ</span>
              <select data-bd="ws.step" data-type="num-select">
                ${STEP_OPTIONS.map(o => `<option value="${o.v}" ${Number(ws.step) === o.v ? 'selected' : ''}>${o.l}${o.v ? ' ' + (ws.currency === 'THB' ? 'บาท' : ws.currency) : ''}</option>`).join('')}
              </select>
            </label>
            <label class="bdp-field"><span>เกณฑ์กำไรขั้นต่ำของบริษัท (% ของราคาขาย)</span><div class="bdp-unit-input">${fieldNum('ws.minMarginPct', `value="${escapeHtml(val(ws.minMarginPct))}" min="0" max="99"`)}<em>%</em></div></label>
          </div>
        </section>

        <section class="bdp-card">
          <div class="bdp-card-title"><span class="bdp-num">3</span> ต้นทุนและราคาตามลำดับ</div>
          <div class="bdp-table" id="bdpTable">
            <div class="bdp-tr bdp-th">
              <div>ลำดับ</div>
              <div>ต้นทุนตั้งต้น<small>(${ws.currency === 'THB' ? '฿' : escapeHtml(ws.currency)} / Serving และ % ของราคาขาย)</small></div>
              <div>ค่าใช้จ่ายเพิ่มเติม<small>(฿ / Serving)</small></div>
              <div>ค่าใช้จ่าย<small>(% ของราคาขาย)</small></div>
              <div>กำไรเป้าหมาย<small>(% ของราคาขาย)</small></div>
              <div>ราคาขาย<small>(ปัดแล้ว)</small></div>
              <div>ค่าใช้จ่ายจริง<small>(฿ / Serving)</small></div>
              <div>กำไรจริง<small>(฿ / Serving, %)</small></div>
            </div>
            ${TIER_KEYS.map((key, i) => `
              <div class="bdp-tr" data-tier="${i}">
                <div class="bdp-tier-name" data-label="ลำดับ"><span class="bdp-num bdp-num-sm">${TIER_ICONS[key]}</span> ${TIER_LABELS[key]}</div>
                <div data-label="ต้นทุนตั้งต้น">${i === 0
                  ? fieldNum('material', 'id="bdpMaterialInput" min="0"')
                  : `<div class="bdp-out" id="bdp-base-${i}">—</div>`}
                  <div class="bdp-share" title="${i === 0 ? 'ต้นทุนวัตถุดิบ' : 'ต้นทุนสินค้า (ราคาลำดับก่อนหน้า)'}เป็นกี่ % ของราคาขายลำดับนี้ — กรอกแล้วราคา = ต้นทุน ÷ % นี้ และกำไรเป้าหมายจะถูกคำนวณจากส่วนที่เหลือ (เว้นว่าง = ไม่ใช้)">
                    ${fieldNum(`sc.tiers.${i}.w`, `value="${escapeHtml(val(sc.tiers[i].w))}" min="0" max="99.99" placeholder="% ${i === 0 ? 'วัตถุดิบ' : 'สินค้า'}"`)}<em>%</em>
                  </div>
                  <small class="bdp-hint" id="bdp-w-${i}"></small></div>
                <div data-label="ค่าใช้จ่ายเพิ่มเติม (฿ / Serving)"><div class="bdp-out" id="bdp-fixed-${i}">—</div></div>
                <div data-label="ค่าใช้จ่าย (% ของราคาขาย)">${fieldNum(`sc.tiers.${i}.o`, `value="${escapeHtml(val(sc.tiers[i].o))}" min="0" max="99"`)}<small class="bdp-hint" id="bdp-oextra-${i}"></small></div>
                <div data-label="กำไรเป้าหมาย (% ของราคาขาย)">${fieldNum(`sc.tiers.${i}.m`, `value="${escapeHtml(val(sc.tiers[i].m))}" min="0" max="99"`)}<small class="bdp-hint" id="bdp-mnote-${i}"></small></div>
                <div data-label="ราคาขาย"><div class="bdp-out bdp-out-price" id="bdp-price-${i}">—</div><small class="bdp-hint" id="bdp-raw-${i}"></small></div>
                <div data-label="ค่าใช้จ่ายจริง (฿ / Serving)"><div class="bdp-out" id="bdp-exp-${i}">—</div></div>
                <div data-label="กำไรจริง"><div class="bdp-out" id="bdp-profit-${i}">—</div><small class="bdp-hint" id="bdp-margin-${i}"></small></div>
                <div class="bdp-tr-error" id="bdp-err-${i}"></div>
              </div>`).join('')}
          </div>
          <div class="bdp-extras" id="bdpExtras"></div>
          <div class="bdp-note" id="bdpTableNote"></div>
        </section>

        <section class="bdp-card">
          <div class="bdp-card-title"><span class="bdp-num">4</span> เปรียบเทียบข้อเสนอ</div>
          <div class="bdp-scenarios" id="bdpScenarios"></div>
        </section>
      </div>

      <aside class="bdp-summary" id="bdpSummary"></aside>
    </div>`;
  wirePage();
  renderExtras();
  refresh();
}

/* ---------- extra costs ---------- */
function renderExtras(){
  const sc = activeScenario();
  const host = document.getElementById('bdpExtras');
  host.innerHTML = `
    <div class="bdp-extras-head">
      <b>ค่าใช้จ่ายเพิ่มเติม</b>
      <button type="button" class="bdp-btn-outline" data-act="add-extra">${icon('plus', 14)} เพิ่มค่าใช้จ่าย</button>
    </div>
    ${sc.extras.length ? sc.extras.map((e, i) => `
      <div class="bdp-extra-row" data-extra="${i}">
        <input type="text" data-bd="sc.extras.${i}.name" data-type="text-refresh-soft" value="${escapeHtml(e.name)}" placeholder="ชื่อรายการ เช่น บรรจุภัณฑ์ ขนส่ง ค่าใช้จ่ายขาย">
        <select data-bd="sc.extras.${i}.tier" data-type="text-refresh" title="รายการนี้ถูกนับที่ลำดับเดียวเท่านั้น">
          ${TIER_KEYS.map(k => `<option value="${k}" ${e.tier === k ? 'selected' : ''}>ลำดับ ${TIER_LABELS[k]}</option>`).join('')}
        </select>
        <select data-bd="sc.extras.${i}.unit" data-type="text-refresh">
          <option value="amount" ${e.unit === 'amount' ? 'selected' : ''}>${ws.currency === 'THB' ? '฿' : escapeHtml(ws.currency)} / Serving</option>
          <option value="percent" ${e.unit === 'percent' ? 'selected' : ''}>% ของราคาขาย</option>
        </select>
        ${fieldNum(`sc.extras.${i}.value`, `value="${escapeHtml(val(e.value))}" min="0" placeholder="0"`)}
        <button type="button" class="icon-btn" data-act="remove-extra" data-i="${i}" title="ลบรายการนี้">${icon('x', 14)}</button>
      </div>`).join('') : '<div class="bdp-empty">ยังไม่มีค่าใช้จ่ายเพิ่มเติม — เช่น บรรจุภัณฑ์ ขนส่ง ค่าใช้จ่ายขาย (แต่ละรายการนับที่ลำดับเดียวเท่านั้น)</div>'}
    <div class="bdp-warn" id="bdpExtrasWarn"></div>`;
  wireInputs(host);
  host.querySelector('[data-act="add-extra"]').addEventListener('click', () => {
    activeScenario().extras.push({ id: uid(), name: '', tier: 'factory', unit: 'amount', value: null });
    saveDraftSoon();
    renderExtras();
    refresh();
    const rows = document.querySelectorAll('.bdp-extra-row input[type="text"]');
    rows[rows.length - 1]?.focus();
  });
  host.querySelectorAll('[data-act="remove-extra"]').forEach(btn => btn.addEventListener('click', () => {
    activeScenario().extras.splice(Number(btn.dataset.i), 1);
    saveDraftSoon();
    renderExtras();
    refresh();
  }));
}

/* ---------- binding ---------- */
function resolve(path){
  const parts = path.split('.');
  let obj = parts[0] === 'sc' ? activeScenario() : ws;
  for(let i = 1; i < parts.length - 1; i++) obj = obj[parts[i]];
  return { obj, key: parts[parts.length - 1] };
}
function wirePage(){
  const main = document.getElementById('mainArea');
  wireInputs(main);
  main.querySelectorAll('[data-act="mode"]').forEach(btn => btn.addEventListener('click', () => {
    activeScenario().mode = btn.dataset.mode;
    saveDraftSoon();
    renderAll();
  }));
  document.getElementById('bdpSaveBtn').addEventListener('click', saveProposal);
  document.getElementById('bdpSavedBtn').addEventListener('click', openSavedModal);
}
function wireInputs(root){
  root.querySelectorAll('[data-bd]').forEach(el => {
    const path = el.dataset.bd;
    const type = el.dataset.type;
    if(path === 'material'){
      el.value = val(activeScenarioMaterialShown());
      el.addEventListener('input', () => {
        const sc = activeScenario();
        sc.materialOverride = el.value === '' ? null : parseFloat(el.value);
        if(sc.materialOverride != null && !isNum(sc.materialOverride)) sc.materialOverride = null;
        saveDraftSoon();
        refresh({ skipMaterialInput: true });
      });
      return;
    }
    const { obj, key } = resolve(path);
    const apply = () => {
      let v;
      if(type === 'num' || type === 'num-select') v = el.value === '' ? null : parseFloat(el.value);
      else v = el.value;
      if(isNum(v) === false && (type === 'num' || type === 'num-select')) v = null;
      obj[key] = v;
    };
    if(type === 'recipe'){
      el.addEventListener('change', () => {
        apply();
        const r = recipes.find(x => x.id === ws.recipeId);
        if(r && isNum(parseFloat(r.servingSizeG)) && !(isNum(ws.servingG) && ws.servingG > 0)) ws.servingG = parseFloat(r.servingSizeG);
        ws.scenarios.forEach(s => { s.materialOverride = null; });
        saveDraftSoon();
        renderAll();
      });
    }else if(type === 'currency'){
      el.addEventListener('change', () => { apply(); saveDraftSoon(); renderAll(); });
    }else if(type === 'text-refresh'){
      el.addEventListener('change', () => { apply(); saveDraftSoon(); renderExtras(); refresh(); });
    }else if(type === 'num-select'){
      el.addEventListener('change', () => { apply(); saveDraftSoon(); refresh(); });
    }else{
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
        apply();
        saveDraftSoon();
        refresh();
      });
    }
  });
}
function activeScenarioMaterialShown(){
  const sc = activeScenario();
  if(isNum(sc.materialOverride)) return sc.materialOverride;
  const info = materialInfo(sc);
  return info.cost != null ? +info.cost.toFixed(4) : null;
}

/* ---------- computed cells ---------- */
function setText(id, text, title){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = text;
  if(title != null) el.title = title;
}
function refresh(opts = {}){
  const sc = activeScenario();
  const res = compute(sc);
  const matInput = document.getElementById('bdpMaterialInput');
  if(matInput && !opts.skipMaterialInput && document.activeElement !== matInput){
    matInput.value = val(activeScenarioMaterialShown());
  }
  const rateField = document.getElementById('bdpRateField');
  if(rateField) rateField.style.display = ws.currency === 'THB' ? 'none' : '';

  // material source line
  const matRow = document.getElementById('bdpMaterialRow');
  if(matRow){
    const recipe = ws.recipeId ? recipes.find(r => r.id === ws.recipeId) : null;
    const src = res.material.source;
    matRow.innerHTML = `
      <span class="bdp-badge ${src === 'recipe' ? 'bdp-badge-auto' : 'bdp-badge-manual'}">${src === 'recipe' ? 'คำนวณอัตโนมัติจากสูตร' : src === 'manual' ? 'กรอกเอง' : 'กรอกเอง (ยังไม่ผูกสูตร)'}</span>
      <span>ต้นทุนวัตถุดิบ / Serving: <b>${res.material.cost != null ? money(res.material.cost) : '—'}</b></span>
      ${recipe && src === 'manual' ? '<button type="button" class="bdp-link" data-act="use-auto">ใช้ค่าอัตโนมัติจากสูตร</button>' : ''}
      ${recipe && src !== 'manual' ? '<span class="bdp-muted">แก้ที่ช่องต้นทุนในตารางด้านล่างเพื่อกรอกเอง</span>' : ''}
      ${res.material.warns.map(w => `<span class="bdp-warn-inline">${icon('alert-triangle', 14)} ${escapeHtml(w)}</span>`).join('')}`;
    matRow.querySelector('[data-act="use-auto"]')?.addEventListener('click', () => {
      sc.materialOverride = null;
      saveDraftSoon();
      refresh();
    });
  }

  // table
  res.chain.forEach((t, i) => {
    const base = i === 0 ? null : (t.ok ? t.base : (res.chain[i - 1].ok ? res.chain[i - 1].price : null));
    if(i > 0) setText(`bdp-base-${i}`, base != null ? money(base) : '—');
    setText(`bdp-fixed-${i}`, money(t.fixedExtra));
    setText(`bdp-oextra-${i}`, t.oExtraPct ? `รวม ${+(t.oBasePct + t.oExtraPct).toFixed(2)}% (รวมรายการเพิ่มเติม ${+t.oExtraPct.toFixed(2)}%)` : '');
    setText(`bdp-price-${i}`, t.ok ? money(t.price) : '—');
    setText(`bdp-raw-${i}`, t.ok ? `ก่อนปัด ${money(t.raw)}` : '');
    setText(`bdp-exp-${i}`, t.ok ? money(t.expenses) : '—');
    setText(`bdp-profit-${i}`, t.ok ? money(t.profit) : '—');
    setText(`bdp-margin-${i}`, t.ok ? `${pctText(t.margin)} (เป้า ${t.mPct}%)` : '');
    const wSet = isNum(sc.tiers[i].w);
    const mInput = document.querySelector(`[data-bd="sc.tiers.${i}.m"]`);
    if(mInput) mInput.disabled = wSet;
    setText(`bdp-mnote-${i}`, wSet ? (t.ok ? `คำนวณจากสัดส่วนต้นทุน = ${+t.mPct.toFixed(2)}%` : 'ใช้สัดส่วนต้นทุน % แทน') : '');
    setText(`bdp-w-${i}`, wSet && t.ok ? `จริงหลังปัด ${+(t.baseShare * 100).toFixed(2)}%` : '');
    const err = document.getElementById(`bdp-err-${i}`);
    if(err){ err.textContent = t.ok ? '' : t.errors.join(' • '); err.style.display = t.ok ? 'none' : ''; }
    document.querySelector(`.bdp-tr[data-tier="${i}"]`)?.classList.toggle('bdp-tr-bad', !t.ok);
  });
  const dupAcross = duplicateAcrossTiers(sc);
  setText('bdpExtrasWarn', res.errors.some(e => e.includes('ซ้ำกัน')) ? '' : (dupAcross.length ? `ชื่อ "${dupAcross.join('", "')}" ปรากฏหลายลำดับ — ตรวจสอบว่าไม่ได้ตั้งใจนับซ้ำ` : ''));
  const warnEl = document.getElementById('bdpExtrasWarn');
  if(warnEl) warnEl.style.display = warnEl.textContent ? '' : 'none';
  setText('bdpTableNote', `ค่าใช้จ่ายและกำไรคิดจากราคาขาย • ปัดขึ้นครั้งละ ${stepValue() > 0 ? stepValue().toFixed(2) + ' ' + (ws.currency === 'THB' ? 'บาท' : ws.currency) : '— (ไม่ปัดเศษ)'} • ราคาที่ปัดแล้วของแต่ละลำดับเป็นต้นทุนของลำดับถัดไป`);

  renderScenarioCards();
  renderSummary(res);
  const ov = document.getElementById('bdModalOverlay');
  if(ov?.classList.contains('open')){
    if(ov.dataset.view === 'compare') renderCompareModal();
    else if(ov.dataset.view === 'detail') renderDetailModal();
  }
}

/* ---------- scenarios (section 4) ---------- */
function renderScenarioCards(){
  const host = document.getElementById('bdpScenarios');
  if(!host) return;
  const icons = ['file-text', 'tag', 'bar-chart-2'];
  host.innerHTML = ws.scenarios.map((s, i) => {
    const r = compute(s);
    const active = s.id === ws.activeScenarioId;
    return `
      <div class="bdp-scn ${active ? 'active' : ''}" data-scn="${escapeHtml(s.id)}">
        <label class="bdp-scn-top">
          <span class="bdp-scn-icon">${icon(icons[i] || 'file-text', 18)}</span>
          <input type="text" class="bdp-scn-name" data-bd="ws.scenarios.${i}.name" data-type="text-scn" value="${escapeHtml(s.name)}">
          <input type="radio" name="bdpScenario" value="${escapeHtml(s.id)}" ${active ? 'checked' : ''} title="แก้ไขสถานการณ์นี้">
        </label>
        <div class="bdp-scn-metrics">
          <div><span>ราคาเสนอขาย</span><b>${r.chain[1].ok ? money(r.chain[1].price) : '—'}</b></div>
          <div><span>กำไรต่อเดือน</span><b>${r.monthlyProfit != null ? money(r.monthlyProfit) : '—'}</b></div>
        </div>
      </div>`;
  }).join('') + `
    <div class="bdp-scn-copy">
      <button type="button" class="bdp-link" data-act="copy-scenario">คัดลอกสมมติฐานต้นทุน/ราคาของ "${escapeHtml(activeScenario().name)}" ไปยังสถานการณ์อื่นทั้งหมด</button>
      <span class="bdp-muted">(ไม่รวมชื่อและปริมาณขาย — แต่ละสถานการณ์ปรับค่าของตัวเองได้ต่อ)</span>
    </div>`;
  host.querySelector('[data-act="copy-scenario"]').addEventListener('click', () => {
    const src = activeScenario();
    if(!confirm(`คัดลอกสมมติฐานของ "${src.name}" ไปแทนที่สถานการณ์อื่นทั้งหมด? (วิธีตั้งราคา ต้นทุนวัตถุดิบ ค่าใช้จ่าย/กำไรตามลำดับ ค่าใช้จ่ายเพิ่มเติม และราคาเป้าหมาย)`)) return;
    ws.scenarios.forEach(s => {
      if(s.id === src.id) return;
      s.mode = src.mode;
      s.materialOverride = src.materialOverride;
      s.tiers = clone(src.tiers);
      s.extras = clone(src.extras).map(e => ({ ...e, id: uid() }));
      s.targetPrice = src.targetPrice;
      s.targetRef = src.targetRef;
    });
    saveDraftSoon();
    refresh();
  });
  host.querySelectorAll('input[type="radio"]').forEach(rb => rb.addEventListener('change', () => {
    ws.activeScenarioId = rb.value;
    saveDraftSoon();
    renderAll();
  }));
  host.querySelectorAll('.bdp-scn').forEach(card => card.addEventListener('click', e => {
    if(e.target.closest('input')) return;
    if(card.dataset.scn === ws.activeScenarioId) return;
    ws.activeScenarioId = card.dataset.scn;
    saveDraftSoon();
    renderAll();
  }));
  host.querySelectorAll('.bdp-scn-name').forEach(inp => inp.addEventListener('input', () => {
    const { obj, key } = resolve(inp.dataset.bd);
    obj[key] = inp.value;
    saveDraftSoon();
  }));
}

/* ---------- summary panel ---------- */
function renderSummary(res){
  const sc = res.sc;
  const host = document.getElementById('bdpSummary');
  if(!host) return;
  const [f, c, u] = res.chain;
  let body;
  if(!res.ok){
    const msgs = [...res.errors, ...res.chain.filter(t => !t.ok).flatMap(t => t.errors.map(e => `${TIER_LABELS[t.key]}: ${e}`))];
    body = `
      <div class="bdp-sum-error">
        <div class="bdp-sum-error-title">${icon('alert-triangle', 18)} ยังคำนวณราคาไม่ได้</div>
        <ul>${[...new Set(msgs)].map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
      </div>`;
  }else{
    const targetBlock = (sc.mode === 'target' && res.gap != null) ? renderTargetBlock(res) : '';
    body = `
      <div class="bdp-sum-card">
        <div class="bdp-sum-label">ราคาเสนอขายของบริษัท / Serving</div>
        <div class="bdp-sum-big">${money(c.price)}</div>
        <div class="bdp-sum-sub">ราคาขายปลายทาง (ลูกค้า) / Serving <b>${money(u.price)}</b></div>
      </div>
      <div class="bdp-sum-card">
        <div class="bdp-sum-label">กำไรจริงของบริษัท</div>
        <div class="bdp-sum-row">
          <div><span class="bdp-sum-profit">${money(c.profit)}</span> <span class="bdp-sum-unit">/ Serving</span></div>
          <div class="bdp-sum-pct ${res.marginOk ? '' : 'bad'}">${pctText(c.margin)}<small>อัตรากำไรจริง</small></div>
        </div>
        <div class="bdp-sum-sub">เป้าหมาย ${c.mPct}% • เกณฑ์ขั้นต่ำ ${ws.minMarginPct}%</div>
        <div class="bdp-pill ${res.marginOk ? 'ok' : 'bad'}">${res.marginOk ? '✓ ผ่านเกณฑ์กำไร' : '✕ ไม่ผ่านเกณฑ์กำไร'}</div>
      </div>
      <div class="bdp-sum-card">
        <div class="bdp-sum-label">กำไรประมาณการต่อเดือน${isNum(sc.qty) ? ` (จาก ${Number(sc.qty).toLocaleString('en-US')} Serving)` : ''}</div>
        <div class="bdp-sum-profit">${res.monthlyProfit != null ? money(res.monthlyProfit) : '—'}</div>
      </div>
      ${targetBlock}`;
  }
  host.innerHTML = `
    <div class="bdp-sum-title">สรุปข้อเสนอ <small>${escapeHtml(sc.name)}</small></div>
    ${body}
    <div class="bdp-sum-actions">
      <button type="button" class="bdp-btn-outline bdp-wide" id="bdpCompareBtn">${icon('file-text', 16)} เปรียบเทียบข้อเสนอ</button>
      <button type="button" class="bdp-btn-outline bdp-wide" id="bdpDetailBtn">${icon('list', 16)} ดูรายละเอียดการคำนวณ</button>
    </div>`;
  document.getElementById('bdpCompareBtn').addEventListener('click', openCompareModal);
  document.getElementById('bdpDetailBtn').addEventListener('click', openDetailModal);
  host.querySelector('[data-act="toggle-budget"]')?.addEventListener('click', e => {
    host.querySelector('.bdp-budget')?.classList.toggle('open');
    e.currentTarget.classList.toggle('open');
  });
}

function renderTargetBlock(res){
  const sc = res.sc;
  const refLabel = sc.targetRef === 'company' ? 'ราคาที่บริษัทขายให้ลูกค้า' : 'ราคาที่ลูกค้าขายต่อปลายทาง';
  const calcRef = res.chain[res.refIdx].price;
  const over = res.gap > 1e-9;
  const mat = res.material.cost;
  const rev = res.reverse;
  const matBudget = rev[0] && rev[0].ok ? rev[0].maxBase : null;
  let advice;
  if(matBudget == null){
    advice = `<div class="bdp-advice bad">ราคาเป้าหมายนี้รองรับต้นทุนไม่ได้ — ค่าใช้จ่าย กำไร และค่าใช้จ่ายเพิ่มเติมของลำดับต่างๆ ใช้ราคาไปหมดแล้ว ต้องลดค่าใช้จ่าย/กำไรของลำดับใดลำดับหนึ่ง หรือเพิ่มราคาเป้าหมาย</div>`;
  }else if(mat != null && mat > matBudget + 1e-9){
    advice = `<div class="bdp-advice bad">ต้องลดต้นทุนวัตถุดิบ <b>${money(mat - matBudget)}</b> / Serving (จาก ${money(mat)} เหลือไม่เกิน <b>${money(matBudget)}</b>) หรือปรับค่าใช้จ่าย/กำไรตามลำดับในตารางด้านล่าง</div>`;
  }else if(mat != null){
    advice = `<div class="bdp-advice ok">ต้นทุนวัตถุดิบอยู่ในงบ — เหลือช่องว่างอีก <b>${money(matBudget - mat)}</b> / Serving (งบสูงสุด ${money(matBudget)})</div>`;
  }else{
    advice = `<div class="bdp-advice">งบต้นทุนวัตถุดิบสูงสุดที่รองรับได้: <b>${money(matBudget)}</b> / Serving</div>`;
  }
  const rows = [];
  for(let i = res.refIdx; i >= 0; i--){
    const b = rev[i];
    const actualBase = res.chain[i].ok ? res.chain[i].base : null;
    const diff = (b && b.ok && actualBase != null) ? actualBase - b.maxBase : null;
    rows.push(`<tr>
      <td>${TIER_LABELS[TIER_KEYS[i]]}</td>
      <td>${b && b.priceBudget != null ? money(b.priceBudget) : '—'}</td>
      <td>${b && b.ok ? money(b.maxBase) : 'รองรับไม่ได้'}</td>
      <td>${actualBase != null ? money(actualBase) : '—'}</td>
      <td class="${diff != null && diff > 1e-9 ? 'bad' : 'ok'}">${diff == null ? '—' : (diff > 1e-9 ? '+' + money(diff) + ' เกิน' : money(-diff) + ' เหลือ')}</td>
    </tr>`);
  }
  return `
    <div class="bdp-target-card ${over ? 'over' : 'under'}">
      <div class="bdp-target-title">${over ? icon('alert-triangle', 20) + ' สูงกว่าราคาเป้าหมาย' : '✓ ไม่เกินราคาเป้าหมาย'}
        <b>${over ? money(res.gap) : money(-res.gap)}</b> <small>/ Serving${over ? '' : ' (ต่ำกว่าเป้า)'}</small></div>
      <div class="bdp-target-cmp">
        <div><span>${escapeHtml(refLabel)} (ตามการคำนวณ)</span><b>${money(calcRef)}</b></div>
        <div><span>ราคาเป้าหมาย (${sc.targetRef === 'company' ? 'บริษัท → ลูกค้า' : 'ลูกค้า → ปลายทาง'})</span><b>${money(sc.targetPrice)}</b></div>
      </div>
      ${advice}
    </div>
    <button type="button" class="bdp-tip" data-act="toggle-budget">${icon('lightbulb', 18)} <span>ลองปรับต้นทุนหรือกำไรตามลำดับ</span><em>${icon('chevron-down', 16)}</em></button>
    <div class="bdp-budget">
      <div class="bdp-budget-note">ต้นทุนตั้งต้นสูงสุด = ราคา × (1 − ค่าใช้จ่าย% − กำไร%) − ค่าใช้จ่ายเพิ่มเติม — ราคาระหว่างทางปัดลง และงบวัตถุดิบปัดลงเป็น 0.01 เพื่อไม่ให้ต่ำกว่าเป้ากำไร</div>
      <table class="bdp-budget-table">
        <thead><tr><th>ลำดับ</th><th>ราคาสูงสุดที่รับได้</th><th>ต้นทุนตั้งต้นสูงสุด</th><th>ต้นทุนจริง</th><th>ส่วนต่าง</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

/* ---------- modals ---------- */
function ensureModalWired(){
  const ov = document.getElementById('bdModalOverlay');
  if(ov.dataset.wired) return ov;
  ov.dataset.wired = '1';
  const close = () => { ov.classList.remove('open'); ov.dataset.view = ''; };
  document.getElementById('btnCloseBdModal').addEventListener('click', close);
  wireModalOverlayClose('bdModalOverlay', close);
  return ov;
}
function openModal(view, title){
  const ov = ensureModalWired();
  ov.dataset.view = view;
  document.getElementById('bdModalTitle').textContent = title;
  ov.classList.add('open');
}
function openCompareModal(){ openModal('compare', 'เปรียบเทียบข้อเสนอ'); renderCompareModal(); }
function openDetailModal(){ openModal('detail', 'รายละเอียดการคำนวณ'); renderDetailModal(); }
function openSavedModal(){ openModal('saved', 'ข้อเสนอที่บันทึกไว้'); renderSavedModal(); }

function renderCompareModal(){
  const results = ws.scenarios.map(s => compute(s));
  const best = results.reduce((b, r, i) => (r.monthlyProfit != null && (b < 0 || r.monthlyProfit > results[b].monthlyProfit)) ? i : b, -1);
  const row = (label, fn) => `<tr><th>${label}</th>${results.map((r, i) => `<td class="${i === best && label === 'กำไรรวมต่อเดือน' ? 'best' : ''}">${fn(r)}</td>`).join('')}</tr>`;
  document.getElementById('bdModalBody').innerHTML = `
    <div class="bdp-compare-wrap"><table class="bdp-compare">
      <thead><tr><th></th>${results.map(r => `<th>${escapeHtml(r.sc.name)}${r.sc.id === ws.activeScenarioId ? ' <small>(กำลังแก้ไข)</small>' : ''}</th>`).join('')}</tr></thead>
      <tbody>
        ${row('วิธีตั้งราคา', r => r.sc.mode === 'target' ? `เริ่มจากราคาเป้าหมาย ${isNum(r.sc.targetPrice) ? money(r.sc.targetPrice) : '—'}` : 'เริ่มจากต้นทุน')}
        ${row('ต้นทุนวัตถุดิบ / Serving', r => r.material.cost != null ? money(r.material.cost) : '—')}
        ${row('ราคาเสนอขาย (บริษัท)', r => r.chain[1].ok ? money(r.chain[1].price) : '—')}
        ${row('ราคาขายปลายทาง (ลูกค้า)', r => r.chain[2].ok ? money(r.chain[2].price) : '—')}
        ${row('กำไรต่อหน่วย (บริษัท)', r => r.chain[1].ok ? money(r.chain[1].profit) : '—')}
        ${row('อัตรากำไรจริง', r => r.chain[1].ok ? pctText(r.chain[1].margin) : '—')}
        ${row('ปริมาณ / เดือน', r => isNum(r.sc.qty) ? Number(r.sc.qty).toLocaleString('en-US') + ' Serving' : '—')}
        ${row('กำไรรวมต่อเดือน', r => r.monthlyProfit != null ? money(r.monthlyProfit) : '—')}
        ${row('เทียบราคาเป้าหมาย', r => r.gap == null ? '—' : (r.gap > 1e-9 ? `<span class="bad">สูงกว่า ${money(r.gap)}</span>` : `<span class="ok">ไม่เกินเป้า (${money(-r.gap)})</span>`))}
        ${row('เกณฑ์กำไรขั้นต่ำ', r => r.monthlyProfit == null ? '—' : (r.marginOk ? '<span class="ok">ผ่าน</span>' : '<span class="bad">ไม่ผ่าน</span>'))}
      </tbody>
    </table></div>
    <div class="bdp-note">แต่ละสถานการณ์มีราคา ปริมาณ และสมมติฐานต้นทุนของตัวเอง — การเพิ่มปริมาณไม่ลดต้นทุนต่อหน่วยอัตโนมัติ ถ้าต้องการส่วนลดตามปริมาณให้ปรับต้นทุน/ค่าใช้จ่ายของสถานการณ์นั้นเอง</div>`;
}

function renderDetailModal(){
  const sc = activeScenario();
  const res = compute(sc);
  const step = stepValue();
  const parts = [];
  parts.push(`<div class="bdp-note">สถานการณ์: <b>${escapeHtml(sc.name)}</b> • สกุลเงิน ${ws.currency} • ปัดขึ้นครั้งละ ${step > 0 ? step : 'ไม่ปัด'} • ต้นทุนวัตถุดิบ ${res.material.cost != null ? money(res.material.cost) : '—'}</div>`);
  if(res.errors.length) parts.push(`<div class="bdp-sum-error"><ul>${res.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`);
  res.chain.forEach((t, i) => {
    const name = TIER_LABELS[TIER_KEYS[i]];
    if(!t.ok){
      parts.push(`<div class="bdp-detail"><h4>${i + 1}. ${name}</h4><div class="bdp-sum-error"><ul>${t.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div></div>`);
      return;
    }
    const o = t.oPct, m = t.mPct;
    parts.push(`
      <div class="bdp-detail">
        <h4>${i + 1}. ${name}</h4>
        <table class="bdp-budget-table"><tbody>
          <tr><th>C ต้นทุนตั้งต้น</th><td>${money(t.base)}${i > 0 ? ` <small>(= ราคาขายลำดับ${TIER_LABELS[TIER_KEYS[i - 1]]})</small>` : ''}</td></tr>
          <tr><th>F ค่าใช้จ่ายเพิ่มเติม (จำนวนเงิน)</th><td>${money(t.fixed)}</td></tr>
          <tr><th>o ค่าใช้จ่าย % ของราคาขาย</th><td>${+o.toFixed(4)}%${t.oExtraPct ? ` (พื้นฐาน ${t.oBasePct}% + รายการเพิ่มเติม ${+t.oExtraPct.toFixed(4)}%)` : ''}</td></tr>
          ${t.wPct != null ? `<tr><th>w ต้นทุนเป็น % ของราคาขาย (กำหนดเอง)</th><td>${t.wPct}% → ราคา = C ÷ w</td></tr>` : ''}
          <tr><th>m กำไรเป้าหมาย % ของราคาขาย</th><td>${+(+m).toFixed(4)}%${t.derivedM ? ' <small>(คำนวณ: m = 1 − o − w × (C + F) ÷ C)</small>' : ''}</td></tr>
          <tr><th>ราคาขายก่อนปัด = (C + F) ÷ (1 − o − m)</th><td>(${t.base.toFixed(4)} + ${t.fixed.toFixed(4)}) ÷ (1 − ${(o / 100).toFixed(4)} − ${(m / 100).toFixed(4)}) = <b>${t.raw.toFixed(6)}</b></td></tr>
          <tr><th>ราคาขายหลังปัด</th><td><b>${money(t.price)}</b></td></tr>
          <tr><th>ค่าใช้จ่ายจริง = F + ราคา × o</th><td>${t.fixed.toFixed(4)} + ${t.price.toFixed(2)} × ${(o / 100).toFixed(4)} = ${money(t.expenses)}</td></tr>
          <tr><th>กำไรจริง = ราคา − C − F − ราคา × o</th><td>${money(t.profit)} <small>(เป้าหมายก่อนปัด ${money(t.raw * m / 100)})</small></td></tr>
          <tr><th>อัตรากำไรจริง = กำไรจริง ÷ ราคา</th><td>${pctText(t.margin)} <small>(เป้า ${m}%)</small></td></tr>
        </tbody></table>
      </div>`);
  });
  if(res.monthlyProfit != null){
    parts.push(`<div class="bdp-note">กำไรต่อเดือน = กำไรจริงของบริษัทต่อ Serving (ไม่ปัดก่อน ${res.chain[1].profit.toFixed(6)}) × ${Number(sc.qty).toLocaleString('en-US')} Serving = <b>${money(res.monthlyProfit)}</b> (ปัดเป็นจำนวนเต็มตอนแสดงผลเท่านั้น)</div>`);
  }
  document.getElementById('bdModalBody').innerHTML = parts.join('');
}

function renderSavedModal(){
  const sorted = [...proposals].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  document.getElementById('bdModalBody').innerHTML = sorted.length ? `
    <div class="bdp-saved-list">${sorted.map(p => `
      <div class="bdp-saved-row ${p.id === currentProposalId ? 'current' : ''}">
        <div class="bdp-saved-main">
          <b>${escapeHtml(p.name || 'ไม่มีชื่อ')}</b>
          <small>${escapeHtml([p.customer, p.project].filter(Boolean).join(' · '))}</small>
          <small>แก้ไขล่าสุด ${escapeHtml(p.updatedBy || p.createdBy || '-')} · ${p.updatedAt ? escapeHtml(formatActivityDateTime(p.updatedAt)) : ''}</small>
        </div>
        <button type="button" class="btn btn-sm" data-act="open-saved" data-id="${escapeHtml(p.id)}">เปิด</button>
        <button type="button" class="btn btn-sm btn-danger" data-act="delete-saved" data-id="${escapeHtml(p.id)}">ลบ</button>
      </div>`).join('')}</div>` : '<div class="overview-empty">ยังไม่มีข้อเสนอที่บันทึกไว้ — กด "บันทึกข้อเสนอ" เพื่อเก็บงานนี้</div>';
  document.querySelectorAll('#bdModalBody [data-act="open-saved"]').forEach(btn => btn.addEventListener('click', () => {
    const p = proposals.find(x => x.id === btn.dataset.id);
    if(!p) return;
    if(!confirm('เปิดข้อเสนอนี้? ข้อมูลที่กำลังกรอกอยู่ตอนนี้จะถูกแทนที่')) return;
    ws = clone(p.ws);
    currentProposalId = p.id;
    saveDraftSoon();
    document.getElementById('bdModalOverlay').classList.remove('open');
    document.getElementById('bdModalOverlay').dataset.view = '';
    renderAll();
  }));
  document.querySelectorAll('#bdModalBody [data-act="delete-saved"]').forEach(btn => btn.addEventListener('click', () => {
    const p = proposals.find(x => x.id === btn.dataset.id);
    if(!p || !confirm(`ลบข้อเสนอ "${p.name || 'ไม่มีชื่อ'}" ? การลบนี้ย้อนกลับไม่ได้`)) return;
    deleteDoc(doc(bdProposalsCol, p.id)).catch(err => alert('ลบไม่สำเร็จ: ' + err.message));
    if(currentProposalId === p.id) currentProposalId = null;
  }));
}

/* ---------- save ---------- */
async function saveProposal(){
  const btn = document.getElementById('bdpSaveBtn');
  const name = [ws.customer, ws.project].map(s => (s || '').trim()).filter(Boolean).join(' – ');
  if(!name){ alert('กรอกชื่อลูกค้าหรือชื่อโครงการก่อนบันทึก เพื่อใช้เป็นชื่อข้อเสนอ'); return; }
  const existing = proposals.find(p => p.id === currentProposalId);
  const id = existing ? existing.id : uid();
  const now = Date.now();
  const payload = {
    id, name, customer: ws.customer || '', project: ws.project || '',
    ws: clone(ws),
    createdBy: existing?.createdBy || currentUser?.email || '', createdAt: existing?.createdAt || now,
    updatedBy: currentUser?.email || '', updatedAt: now
  };
  btn.disabled = true;
  try{
    await setDoc(doc(bdProposalsCol, id), payload);
    currentProposalId = id;
    saveDraftSoon();
    btn.innerHTML = `${icon('check', 16)} บันทึกแล้ว`;
  }catch(err){
    alert('บันทึกไม่สำเร็จ: ' + err.message + '\n(ตรวจสอบว่าบัญชีนี้มีสิทธิ์ BD Pricing)');
    btn.innerHTML = `${icon('save', 16)} บันทึกข้อเสนอ`;
    btn.disabled = false;
    return;
  }
  setTimeout(() => { if(document.getElementById('bdpSaveBtn') === btn){ btn.innerHTML = `${icon('save', 16)} บันทึกข้อเสนอ`; btn.disabled = false; } }, 1800);
}
