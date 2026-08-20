import {
  escapeHtml, icon, resizeImageFile, requestAuthConfirm, playContentTransition,
  formatActivityDateTime, formatDateLong, formatTimeOnly, currentUser, uid,
  mainFeatureView, setMainFeatureView, recipesLoaded, currentId, renderMain, renderSidebar,
  recipes, recipeDisplayLabel, fullCode, logActivityEvent, diffMainFields, snapshotMainFields,
  renderBarList, openRecipeFromDashboard, metaLists, metaItemName, projectsCol, PROJECT_STAGES,
  showCloudError, trialStringListHtml
} from './app.js';
import {
  onSnapshot, setDoc, deleteDoc, doc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// since ¥ alone is ambiguous between JPY and CNY. Unlike the physical
// packaging/weight/MOQ units above (now the user-editable Units reference
// list — see metaLists.units / unitsDatalist), currency is a closed,
// small set that doesn't make sense to let grow arbitrarily, so it stays
// a plain <select>.
const CURRENCY_OPTIONS = ['THB','JPY','USD','CNY','EUR'];

// Overall project lifecycle status (distinct from PROJECT_STAGES, which
// tracks each individual product's stage within a project).
const PROJECT_STATUSES = ['Not Started','In Progress','Blocked / On Hold','In Review','Completed','Cancelled'];
const PROJECT_STATUS_LABELS = {
  'Not Started': 'Not Started (ยังไม่เริ่ม)',
  'In Progress': 'In Progress (กำลังดำเนินการ)',
  'Blocked / On Hold': 'Blocked / On Hold (ติดปัญหา / รอการตัดสินใจ)',
  'In Review': 'In Review (รอตรวจสอบ)',
  'Completed': 'Completed (เสร็จสมบูรณ์)',
  'Cancelled': 'Cancelled (ยกเลิก)'
};

// Position along the pipeline (Not Started -> In Progress -> In Review ->
// Completed) each status represents, plus a color that doubles as a status
// signal: On Hold reuses the "stuck partway" position but in red (needs
// attention), Cancelled shows full-width in muted grey (closed out, not
// "achieved").
const PROJECT_STATUS_BAR = {
  'Not Started': { pct: 0, color: 'var(--border)' },
  'In Progress': { pct: 40, color: 'var(--accent)' },
  'Blocked / On Hold': { pct: 40, color: 'var(--danger)' },
  'In Review': { pct: 75, color: 'var(--primary)' },
  'Completed': { pct: 100, color: 'var(--ok)' },
  'Cancelled': { pct: 100, color: 'var(--text-dim)' }
};
function projectStatusBarHtml(status){
  const s = status || PROJECT_STATUSES[0];
  const cfg = PROJECT_STATUS_BAR[s] || PROJECT_STATUS_BAR['Not Started'];
  return `<div class="proj-status-bar-track" title="${escapeHtml(s)}"><div class="proj-status-bar-fill" style="width:${cfg.pct}%;background:${cfg.color};"></div></div>`;
}

// Pill colors are separate from PROJECT_STATUS_BAR's progress-bar colors —
// a bar fill can just be var(--accent) etc., but a pill needs a light
// background + readable text + border all at once, which CSS custom
// properties can't derive from a single color value via string concatenation
// (var(...) isn't a hex string), so each status gets its own explicit triple.
const PROJECT_STATUS_PILL = {
  'Not Started': { bg:'var(--bg)', border:'var(--border)', text:'var(--text-dim)' },
  'In Progress': { bg:'var(--accent-light)', border:'var(--accent)', text:'var(--primary-dark)' },
  'Blocked / On Hold': { bg:'var(--danger-light)', border:'var(--danger)', text:'var(--danger)' },
  'In Review': { bg:'var(--primary-light)', border:'var(--primary)', text:'var(--primary-dark)' },
  'Completed': { bg:'var(--ok-light)', border:'var(--ok)', text:'var(--ok)' },
  'Cancelled': { bg:'var(--bg)', border:'var(--border)', text:'var(--text-dim)' }
};
export function statusPillHtml(status){
  const s = status || PROJECT_STATUSES[0];
  const cfg = PROJECT_STATUS_PILL[s] || PROJECT_STATUS_PILL['Not Started'];
  return `<span class="status-pill" style="background:${cfg.bg};color:${cfg.text};border-color:${cfg.border};">${escapeHtml(s)}</span>`;
}

// Cancelled projects show a neutral grey photo ring — every other status,
// including Completed, glows in its real status color (see PROJECT_STATUS_PILL).
function projectPhotoStatusColor(status){
  const s = status || PROJECT_STATUSES[0];
  if(s === 'Cancelled') return 'var(--text-dim)';
  return (PROJECT_STATUS_PILL[s] || PROJECT_STATUS_PILL['Not Started']).border;
}

// Only stages that represent forward progress toward a finished product —
// On Hold/Cancelled products don't have a meaningful position on this scale,
// so they're excluded from the average rather than distorting it.
const STAGE_PROGRESS_ORDER = ['Requested','Formulating','Sampling','Customer Review','Approved','In Production'];
export function projectProgressPct(p){
  const prods = (p.products || []).filter(pr => STAGE_PROGRESS_ORDER.includes(pr.stage));
  if(!prods.length) return 0;
  const sum = prods.reduce((s, pr) => s + STAGE_PROGRESS_ORDER.indexOf(pr.stage), 0);
  return Math.round((sum / prods.length) / (STAGE_PROGRESS_ORDER.length - 1) * 100);
}
export function projectHasUpdateThisMonth(p){
  const now = new Date();
  return (p.monthlyUpdates || []).some(mu => {
    if(!mu.date) return false;
    const d = new Date(mu.date);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
}
// The single most useful next step for this project, shown in the Active
// Projects table — same underlying signals as computeActionItems(), just
// reduced to one line per project instead of a global flat list.
export function projectNextAction(p){
  if(!(p.products || []).length) return 'Add a product';
  if(p.status === 'In Progress' && !projectHasUpdateThisMonth(p)) return "Add this month's update";
  return '—';
}

// Reads the Monthly Update draft fields (date/results/next-plan) out of a
// project's expanded row and, if there's anything worth keeping, appends it
// to monthlyUpdates. Shared by "+ Add Update" and the main Save button —
// Save needs this too, otherwise exiting edit mode silently discards
// whatever was typed there but never explicitly added.
// Older entries only had Activities (results) and Next Plan — Action Taken
// and Next Action are what those mean now, just renamed as part of the
// Plan / Action Taken / Next Action redesign. Plan itself didn't exist
// before, so it's blank on anything migrated. Non-destructive: reads old
// fields as a fallback, never deletes them.
export function migrateMonthlyUpdate(mu){
  return {
    ...mu,
    plan: mu.plan || '',
    // "When" is still just mu.date (a plain "YYYY-MM-DD", unchanged) plus
    // this new optional mu.time ("HH:mm") shown alongside it — kept as two
    // separate fields on purpose rather than merging into one
    // datetime-local value, since mu.date's plain-date format is relied on
    // everywhere (getTaskStatus, computeTaskTracking, the Calendar's day-
    // cell lookup, formatDateLong) and switching it would break all of
    // those string comparisons at once.
    time: mu.time || '',
    planWho: mu.planWho || '',
    planWhere: mu.planWhere || '',
    planHow: mu.planHow || '',
    actionTaken: mu.actionTaken !== undefined ? mu.actionTaken : (mu.results || ''),
    nextAction: mu.nextAction !== undefined ? mu.nextAction : (mu.nextPlan || ''),
    nextActionDue: mu.nextActionDue !== undefined ? mu.nextActionDue : (mu.nextPlanDate || ''),
    // Next Action gets the exact same 5W1H shape as Plan (see above) — its
    // own When/Who/Where/How alongside the existing nextAction ("What")
    // and nextActionDue ("When" date part, unchanged for the same reason
    // mu.date stays untouched).
    nextActionTime: mu.nextActionTime || '',
    nextActionWho: mu.nextActionWho || '',
    nextActionWhere: mu.nextActionWhere || '',
    nextActionHow: mu.nextActionHow || '',
    autoCreatePlan: !!mu.autoCreatePlan,
    sourceUpdateId: mu.sourceUpdateId || '',
    linkedRecipeId: mu.linkedRecipeId || '',
    attachments: Array.isArray(mu.attachments) ? mu.attachments : [],
    completedDate: mu.completedDate || ''
  };
}
// Combines the 5W1H fields into one line for anywhere Plan is shown as a
// single summary (Task Tracking, the Calendar) — the date itself is left
// out since every one of those places already shows/groups by date some
// other way (a date heading, the day cell itself, the entry's own header).
export function muPlanSummaryLine(mu){
  const parts = [];
  if(mu.time) parts.push(mu.time);
  if(mu.planWho) parts.push(mu.planWho);
  // What before Where — Where (a company name) tends to run long and, in
  // the truncated single-line spots this feeds (Task Tracking, Calendar
  // chips), was pushing What off the end entirely. What is the part
  // actually worth reading if something has to get cut off.
  if(mu.plan) parts.push(mu.plan);
  if(mu.planWhere) parts.push(`@ ${mu.planWhere}`);
  return parts.join(' · ');
}

// "Planned" (auto-created, nothing done yet) vs "logged" (Action Taken has
// been recorded) — derived from the data instead of a separately stored
// status, so it can never drift out of sync with what's actually filled in.
export function monthlyUpdateStatus(mu){
  return mu.actionTaken ? 'logged' : 'planned';
}

// Finer-grained status for the left-border/badge treatment on each timeline
// entry — completed always wins regardless of date (a task logged late is
// still done, not overdue), otherwise it's purely a date comparison against
// today. Recomputed on every render from live data, never stored, so a
// task that's still open automatically flips from "today" to "overdue" the
// moment the calendar turns over — no separate day-rollover logic needed.
export function getTaskStatus(mu, todayStr){
  if(mu.actionTaken) return 'completed';
  if(!mu.date) return 'nodate';
  if(mu.date < todayStr) return 'overdue';
  if(mu.date === todayStr) return 'today';
  return 'upcoming';
}
export function daysBetween(earlierDateStr, laterDateStr){
  const ms = new Date(laterDateStr + 'T00:00:00') - new Date(earlierDateStr + 'T00:00:00');
  return Math.max(1, Math.round(ms / 86400000));
}
const TASK_STATUS_META = {
  overdue: { icon: '⚠', label: (mu, todayStr) => { const d = daysBetween(mu.date, todayStr); return `Overdue ${d} day${d === 1 ? '' : 's'}`; } },
  today: { icon: '◷', label: () => 'Due Today' },
  completed: { icon: '✓', label: () => 'Completed' },
  upcoming: { icon: '→', label: () => 'Upcoming' },
  nodate: { icon: '–', label: () => 'No Due Date' }
};

// Guesses which way to translate an Activities Updates field: Thai
// detected anywhere in it (same Thai Unicode block test as the password
// prompt's keyboard-language badge) translates to English, anything else
// translates to Thai — covers the common case of drafting mostly in
// English with no Thai typed yet too.
function guessTranslateTargetLang(text){
  return /[฀-๿]/.test(text) ? 'en' : 'th';
}

// Free, keyless machine translation via the same public endpoint
// translate.google.com's own web page calls (client=gtx) — no API key or
// signup needed, unlike the official paid Google Cloud Translation API.
// This is an unofficial, undocumented use of that endpoint (there's no
// terms-of-service-sanctioned "no key needed" tier of Google Translate),
// so it could be rate-limited or blocked without notice; if that ever
// happens, this is the one function to swap for a paid API call — nothing
// else needs to change, see wireMuTranslateButton below.
async function translateText(text, targetLang){
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Translation service unavailable');
  const data = await res.json();
  // Response shape: [[[translatedChunk, originalChunk, ...], ...], ...] —
  // one translated chunk per sentence/segment; stitched back into one string.
  return data[0].map(chunk => chunk[0]).join('');
}

// Puts the translated text first with the original following in
// parentheses — an Activities Updates entry then reads bilingually, led
// by whichever language was just translated to, instead of losing
// whatever was typed first. Shared by both the "Add Update" panel and
// the "Edit entry" popup, since both use the exact same
// .mu-field-with-translate + .mu-translate-btn markup pair.
function wireMuTranslateButton(wrapEl){
  const textarea = wrapEl.querySelector('textarea');
  const btn = wrapEl.querySelector('.mu-translate-btn');
  if(!textarea || !btn) return;
  btn.addEventListener('click', async () => {
    const original = textarea.value.trim();
    if(!original) return;
    btn.classList.add('loading');
    try{
      const translated = await translateText(original, guessTranslateTargetLang(original));
      textarea.value = `${translated}\n(${original})`;
    }catch(err){
      console.error('Forge: translation failed', err);
      alert('Translation failed — the free translation service may be temporarily unavailable. Please try again in a moment.');
    }finally{
      btn.classList.remove('loading');
    }
  });
}

// If "Create as Plan automatically" was checked and there's a Next Action
// with a due date, chains a new Planned entry whose Plan is that Next
// Action text — the follow-up shows up ready to log once it's actually
// acted on, instead of retyping the same reminder as a new entry by hand.
// Guarded against firing twice for the same source (e.g. re-saving an
// already-chained entry with the checkbox still on).
function maybeAutoCreateNextPlan(p, mu){
  if(!mu.autoCreatePlan || !mu.nextAction || !mu.nextActionDue) return;
  if(!Array.isArray(p.monthlyUpdates)) p.monthlyUpdates = [];
  if(p.monthlyUpdates.some(x => x.sourceUpdateId === mu.id)) return;
  p.monthlyUpdates.push({
    id: uid(), date: mu.nextActionDue, time: mu.nextActionTime || '',
    planWho: mu.nextActionWho || '', plan: mu.nextAction, planWhere: mu.nextActionWhere || '', planHow: mu.nextActionHow || '',
    actionTaken: '', nextAction: '', nextActionDue: '',
    autoCreatePlan: false, sourceUpdateId: mu.id,
    createdBy: currentUser?.email || '', createdAt: Date.now()
  });
}

function captureMonthlyUpdateDraft(p, block){
  const dateInput = block.querySelector('.proj-mu-date');
  const timeInput = block.querySelector('.proj-mu-time');
  const whoInput = block.querySelector('.proj-mu-who');
  const planInput = block.querySelector('.proj-mu-plan');
  const whereInput = block.querySelector('.proj-mu-where');
  const howInput = block.querySelector('.proj-mu-how');
  const actionInput = block.querySelector('.proj-mu-action');
  const nextActionTimeInput = block.querySelector('.proj-mu-nextaction-time');
  const nextActionWhoInput = block.querySelector('.proj-mu-nextaction-who');
  const nextActionInput = block.querySelector('.proj-mu-nextaction');
  const nextActionWhereInput = block.querySelector('.proj-mu-nextaction-where');
  const nextActionHowInput = block.querySelector('.proj-mu-nextaction-how');
  const nextActionDueInput = block.querySelector('.proj-mu-nextaction-due');
  const autoCreateInput = block.querySelector('.proj-mu-autocreate');
  const recipeInput = block.querySelector('.proj-mu-recipe');
  const completedDateInput = block.querySelector('.proj-mu-completed-date');
  if(!dateInput) return false;
  const date = dateInput.value;
  const time = timeInput?.value || '';
  const planWho = whoInput?.value.trim() || '';
  const plan = planInput.value.trim();
  const planWhere = whereInput?.value.trim() || '';
  const planHow = howInput?.value.trim() || '';
  const actionTaken = actionInput.value.trim();
  const nextActionTime = nextActionTimeInput?.value || '';
  const nextActionWho = nextActionWhoInput?.value.trim() || '';
  const nextAction = nextActionInput.value.trim();
  const nextActionWhere = nextActionWhereInput?.value.trim() || '';
  const nextActionHow = nextActionHowInput?.value.trim() || '';
  const nextActionDue = nextActionDueInput.value;
  const autoCreatePlan = !!autoCreateInput?.checked;
  const linkedRecipeId = recipeInput?.value || '';
  const completedDate = resolveMuCompletedDate(actionTaken, completedDateInput?.value || '', new Date().toISOString().slice(0, 10));
  if(!date || (!plan && !actionTaken && !nextAction)) return false;
  if(!Array.isArray(p.monthlyUpdates)) p.monthlyUpdates = [];
  const mu = {
    id: uid(), date, time, planWho, plan, planWhere, planHow, actionTaken,
    nextActionTime, nextActionWho, nextAction, nextActionWhere, nextActionHow, nextActionDue, autoCreatePlan,
    linkedRecipeId, attachments: monthlyUpdateDraftAttachments, completedDate,
    sourceUpdateId: '', createdBy: currentUser?.email || '', createdAt: Date.now()
  };
  monthlyUpdateDraftAttachments = [];
  p.monthlyUpdates.push(mu);
  maybeAutoCreateNextPlan(p, mu);
  return mu;
}

// The 6 field-name prefixes recognized in legacy free-text `requirements`
// blobs (see parseLegacyRequirements) -- the exact labels already typed by
// hand across existing projects, e.g. "Packaging condition: Microwaveable
// black plastic tray".
const REQUIREMENTS_FIELD_DEFS = [
  { key: 'flavorFilling',      re: /^\s*flavor\s+or\s+filling\s*:/i },
  { key: 'composition',        re: /^\s*composition\s*:/i },
  { key: 'recipe',             re: /^\s*recipe\s*:/i },
  { key: 'packagingCondition', re: /^\s*packaging\s+condition\s*:/i },
  { key: 'cookingCondition',   re: /^\s*cooking\s+condition\s*:/i },
  { key: 'certificate',        re: /^\s*certificate\s*:/i }
];

function blankRequirements(){
  return { flavorFilling:'', composition:'', recipe:'', packagingCondition:'', cookingCondition: blankCookingCondition(), certificate:'', note:'' };
}

function blankCookingCondition(){
  return { method: '', steps: [] };
}

// Normalizes cookingCondition into {method, steps}, whatever shape it
// currently is in -- already-structured (new projects, or ones already
// saved once under this shape), or a legacy plain string (either
// newline-joined, from parseLegacyRequirements' old free-text parsing, or
// arrow-joined, from an earlier iteration of the Cooking Condition
// autofill that stored one flat string). Never drops data: any string
// input becomes `steps` with no `method`, since a bare method name was
// never recoverable from either legacy format.
function getCookingCondition(cc){
  if(cc && typeof cc === 'object') return { method: cc.method || '', steps: Array.isArray(cc.steps) ? cc.steps : [] };
  const text = (cc || '').trim();
  return { method: '', steps: text ? text.split(/\n|→/).map(s => s.trim()).filter(Boolean) : [] };
}

// Parses the free-text `requirements` blob that older/unedited projects
// still have in Firestore into the 6 structured fields, plus a `note`
// catch-all for anything that doesn't match a known "Label:" prefix (a
// leading preamble, a typo'd label, etc.) so nothing is ever silently
// dropped. A field's content can span multiple following lines -- each
// line is tested against every known prefix; a non-matching line is
// treated as a continuation of whichever field is currently "open" (or
// falls into `note` if no field is open yet).
function parseLegacyRequirements(text){
  const result = blankRequirements();
  if(!text) return result;
  const buffers = { flavorFilling:[], composition:[], recipe:[], packagingCondition:[], cookingCondition:[], certificate:[], note:[] };
  let currentKey = null;
  String(text).split(/\r\n|\r|\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if(line === '') return;
    const match = REQUIREMENTS_FIELD_DEFS.find(def => def.re.test(rawLine));
    if(match){
      currentKey = match.key;
      const inline = rawLine.replace(match.re, '').trim();
      if(inline) buffers[currentKey].push(inline);
    } else {
      buffers[currentKey || 'note'].push(line);
    }
  });
  REQUIREMENTS_FIELD_DEFS.forEach(def => { result[def.key] = buffers[def.key].join('\n'); });
  result.note = buffers.note.join('\n');
  return result;
}

// Returns p.requirements as the structured object, parsing on the fly if
// it's still the legacy string (or defaulting if missing/blank). Never
// mutates `p` -- called at render time only; the object shape only gets
// persisted to Firestore once the project is next saved (see the save
// handler further down), same deferred-migration approach already used
// by migrateMonthlyUpdate above.
function getRequirements(p){
  const req = p.requirements;
  const result = (req && typeof req === 'object') ? { ...blankRequirements(), ...req } : parseLegacyRequirements(req);
  result.cookingCondition = getCookingCondition(result.cookingCondition);
  return result;
}

function blankProject(){
  return {
    id: uid(),
    name: "",
    image: "",
    status: PROJECT_STATUSES[0],
    requestDate: new Date().toISOString().slice(0,10),
    startDate: "",
    targetEndDate: "",
    customerName: "",
    destinationCountry: "",
    ownerSalesRep: "",
    factorySalesRep: "",
    responsiblePerson: "",
    factoryName: "",
    flavors: [],
    requirements: blankRequirements(),
    portionWeightQty: "",
    portionWeightUnit: "g",
    portionPerUnit: "pcs",
    innerPackQty: "",
    innerPackWeightUnit: "g",
    innerPackUnit: "pack",
    outerPackQty: "",
    outerPackUnit: "pack",
    outerPackContainerUnit: "carton",
    moqQty: "",
    moqUnit: "pcs",
    products: [],
    monthlyUpdates: [],
    createdBy: currentUser?.email || '',
    createdAt: Date.now(),
    updatedBy: currentUser?.email || '',
    updatedAt: Date.now()
  };
}

// A project can have several flavors/fillings (e.g. a mochi assortment),
// each with its own Target/Actual Price, Formula/Reference No., and Note —
// pricing (and, as of Formula/Reference No., the recipe code too) used to
// be one project-wide field and now lives per flavor instead, since each
// flavor is really its own recipe. Currency and per-unit basis are shared
// by both prices on the same flavor (they're only meaningful compared
// against each other in the same terms), not tracked separately per price.
function blankFlavor(){
  return { id: uid(), name: "", targetPrice: "", actualPrice: "", priceCurrency: "THB", priceUnit: "kg", formulaRefCode: "", note: "" };
}

export function blankProduct(recipeId){
  const now = Date.now();
  return {
    id: uid(),
    recipeId,
    salesRep: '',
    stage: PROJECT_STAGES[0],
    updatedAt: now,
    log: [ { id: uid(), date: now, stage: PROJECT_STAGES[0], note: 'Product added to project', by: currentUser?.email || '' } ]
  };
}

// Packaging spec display strings — "-" when the quantity hasn't been filled
// in yet, same convention as every other optional field in the read-only
// summary (see readOnlyDetailRows).
function formatPortionWeight(p){
  return p.portionWeightQty ? `${p.portionWeightQty} ${p.portionWeightUnit || 'g'} / ${p.portionPerUnit || 'pcs'}` : '-';
}
function formatInnerPacking(p){
  return p.innerPackQty ? `${p.innerPackQty} ${p.innerPackWeightUnit || 'g'} / ${p.innerPackUnit || 'pack'}` : '-';
}
function formatOuterPacking(p){
  return p.outerPackQty ? `${p.outerPackQty} ${p.outerPackUnit || 'pack'} / ${p.outerPackContainerUnit || 'carton'}` : '-';
}
function formatProjectMoq(p){
  return p.moqQty ? `${p.moqQty} ${p.moqUnit || 'pcs'}` : '-';
}

// Copies the template-like fields (name, photo, customer/destination/owner,
// requirements, linked products) but resets everything that represents this
// specific run's history and progress — status, request date, each
// product's stage/log, monthly updates, and the created/updated trail —
// since a duplicate is meant to start over, not carry the original's
// progress forward. Duplicates whatever was last saved on the original, not
// any unsaved edits still sitting in its form.
function duplicateProject(p){
  const now = Date.now();
  return {
    ...p,
    id: uid(),
    name: (p.name || 'Untitled project').trim() + ' (Copy)',
    status: PROJECT_STATUSES[0],
    requestDate: new Date().toISOString().slice(0,10),
    startDate: "",
    targetEndDate: "",
    monthlyUpdates: [],
    products: (p.products || []).map(prod => ({
      id: uid(),
      recipeId: prod.recipeId,
      salesRep: prod.salesRep,
      stage: PROJECT_STAGES[0],
      updatedAt: now,
      log: [ { id: uid(), date: now, stage: PROJECT_STAGES[0], note: 'Product added to project', by: currentUser?.email || '' } ]
    })),
    createdBy: currentUser?.email || '',
    createdAt: now,
    updatedBy: currentUser?.email || '',
    updatedAt: now
  };
}

function saveProjectToCloud(p){
  return setDoc(doc(projectsCol, p.id), p);
}
function deleteProjectFromCloud(id){
  return deleteDoc(doc(projectsCol, id));
}
export function scheduleProjectSave(p){
  p.updatedAt = Date.now();
  p.updatedBy = currentUser?.email || '';
  saveProjectToCloud(p);
}
function addProductLogEntry(product, stage, note){
  product.log.push({ id: uid(), date: Date.now(), stage, note: (note || '').trim(), by: currentUser?.email || '' });
  product.stage = stage;
  product.updatedAt = Date.now();
}

export function mountProjectsView(){
  const main = document.getElementById('mainArea');
  main.classList.add('main-wide');
  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('folder', 24)} Projects</div>
    </div>
    <div class="card">
      <button class="btn btn-primary btn-sm" id="btnAddProject" style="margin-bottom:16px;">+ New Project</button>
      <div id="newProjectPanel"></div>
      <div id="projectsDashboard"></div>
      <div id="projectsToolbar" style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
        <div class="search-box" style="margin:0;flex:1;min-width:200px;position:relative;">
          <input type="text" id="projectSearchInput" style="padding-right:28px;" placeholder="Search projects (name, customer, destination, owner, factory...)">
          <button type="button" class="search-clear-btn" id="btnClearProjectSearch" title="Clear search" style="display:none;">${icon('x', 14)}</button>
        </div>
        <div class="col-toggle-wrap">
          <button type="button" class="btn btn-sm" id="btnProjectColumns">${icon('sliders-horizontal', 14)} Columns</button>
          <div class="col-toggle-menu" id="projectColumnsMenu">
            ${PROJECT_TOGGLE_COLUMNS.map(c => `
              <label class="col-toggle-item">
                <input type="checkbox" data-col-key="${escapeHtml(c.key)}" ${projectHiddenColumns.has(c.key) ? '' : 'checked'}>
                ${escapeHtml(c.label)}
              </label>
            `).join('')}
          </div>
        </div>
      </div>
      <div id="projectsList"></div>
    </div>
  `;

  document.getElementById('btnAddProject').addEventListener('click', () => {
    newProjectOpen = true;
    newProjectImage = '';
    renderNewProjectPanel();
  });
  renderNewProjectPanel();
  const projectSearchInputEl = document.getElementById('projectSearchInput');
  const clearProjectSearchBtn = document.getElementById('btnClearProjectSearch');
  function updateClearProjectSearchBtn(){
    clearProjectSearchBtn.style.display = projectSearchInputEl.value ? 'flex' : 'none';
  }
  updateClearProjectSearchBtn();
  projectSearchInputEl.addEventListener('input', () => {
    updateClearProjectSearchBtn();
    renderProjectsList();
  });
  clearProjectSearchBtn.addEventListener('click', () => {
    projectSearchInputEl.value = '';
    updateClearProjectSearchBtn();
    projectSearchInputEl.focus();
    renderProjectsList();
  });
  const columnsMenu = document.getElementById('projectColumnsMenu');
  document.getElementById('btnProjectColumns').addEventListener('click', e => {
    e.stopPropagation();
    columnsMenu.classList.toggle('open');
  });
  columnsMenu.addEventListener('click', e => e.stopPropagation());
  columnsMenu.querySelectorAll('[data-col-key]').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.colKey;
      if(cb.checked) projectHiddenColumns.delete(key);
      else projectHiddenColumns.add(key);
      localStorage.setItem(PROJECT_HIDDEN_COLUMNS_KEY, JSON.stringify(Array.from(projectHiddenColumns)));
      applyProjectColumnVisibility();
      activeProjScrollbarProxySync?.();
    });
  });

  renderProjectsList();
  playContentTransition(main);
}

let projectEditingId = null;
// Staged, uncommitted edits for the currently-open Cooking Condition steps
// list -- kept separate from p.requirements itself (same reasoning as
// Reference Lists' refListEditingSteps) so Cancel discards them like every
// other Requirements field does, instead of the live-save behavior
// Flavor/Filling rows use.
let cookingStepsEditing = [];
let cookingMethodEditing = '';
let monthlyUpdateEditingId = null;
let monthlyUpdateAddOpen = false;
// Staged attachments for whichever Activities Updates inline form (add or
// edit) is currently open — only one can be open at a time (see
// monthlyUpdateEditingId / monthlyUpdateAddOpen above), so one shared array
// is enough. Reset to [] on open/cancel, read into the entry on Save.
let monthlyUpdateDraftAttachments = [];
let muEditModalAttachments = [];
let projectExpandedIds = new Set();
let editingProjectImage = ''; // staged photo as a data URL for whichever project is being edited
let newProjectOpen = false; // whether the "+ New Project" entry panel is showing, below the button
let newProjectImage = ''; // staged photo as a data URL for the not-yet-saved new-project draft
// Excel-style per-column value filters for the projects table — see the "▾"
// button sortableProjectHeader() adds to every sortable column. Keyed by
// the same field key as PROJECT_SORT_ACCESSORS/PROJECT_FILTER_ACCESSORS; a
// missing key means that column isn't filtered (shows every value). Holding
// a Set of the specific raw values still checked, not a single value, is
// what makes this multi-select rather than the old single-choice dropdowns
// it replaced.
let projectColumnFilters = {};
// Which single column's filter popover is currently open, if any — kept in
// module state (not just a DOM class) because renderProjectsList() rebuilds
// the whole table on every filter click, and without this the popover would
// visibly close after every single checkbox click instead of staying open
// while you check off several values in a row.
let openProjectFilterMenuKey = null;
let projectSortKey = 'updatedAt';
let projectSortDir = 'desc';
// Whichever renderProjectsList() call is most recent owns this — see the
// single persistent window resize listener wired near the bottom of the
// script, which just calls whatever this currently points at.
let activeProjScrollbarProxySync = null;

/* ---------- Unsaved-changes guard (Projects only) ----------
   Recipe edits autosave within ~400ms of any change (see scheduleSave), and
   Trial edits save on every field's own 'change' event — neither can lose
   real work by navigating away. A project's main fields are different: they
   only get read out of the DOM and saved when the row's own Save button is
   clicked (see the [data-role="save-project"] handler), so typing into an
   open edit row or the "+ New Project" panel and then clicking a navbar tab
   or a different recipe would silently throw that away. This guard catches
   exactly that gap — see guardNavigation, wired onto every persistent
   navbar/sidebar click that can navigate away while Projects is open. */
function hasUnsavedProjectEdit(){
  if(projectEditingId) return true;
  if(newProjectOpen && document.getElementById('newProjName')?.value.trim()) return true;
  return false;
}
let pendingGuardedNavigation = null;
export function guardNavigation(action){
  if(!hasUnsavedProjectEdit()){ action(); return; }
  pendingGuardedNavigation = action;
  document.getElementById('unsavedChangesModalOverlay').classList.add('open');
}
function closeUnsavedChangesModal(){
  document.getElementById('unsavedChangesModalOverlay').classList.remove('open');
  pendingGuardedNavigation = null;
}
export function initUnsavedChangesGuard(){
  document.getElementById('btnCloseUnsavedChanges').addEventListener('click', closeUnsavedChangesModal);
  document.getElementById('btnUnsavedCancel').addEventListener('click', closeUnsavedChangesModal);
  // Reuses the real Save/Cancel buttons already wired on the open edit row
  // or the "+ New Project" panel instead of duplicating their logic — a
  // plain click() dispatch runs the exact same handler a manual click would.
  document.getElementById('btnUnsavedSave').addEventListener('click', () => {
    document.querySelector('[data-role="save-project"]')?.click();
    document.getElementById('btnSaveNewProject')?.click();
    const action = pendingGuardedNavigation;
    closeUnsavedChangesModal();
    action?.();
  });
  document.getElementById('btnUnsavedDiscard').addEventListener('click', () => {
    document.querySelector('[data-role="cancel-project"]')?.click();
    document.getElementById('btnCancelNewProject')?.click();
    const action = pendingGuardedNavigation;
    closeUnsavedChangesModal();
    action?.();
  });
  window.addEventListener('beforeunload', e => {
    if(!hasUnsavedProjectEdit()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// Accessor per sortable column — keeps the header-click handler and the
// comparator working off the same single source of truth for "what does
// this column's value mean," text columns lowercased so sorting isn't
// case-sensitive.
const PROJECT_SORT_ACCESSORS = {
  name: p => (p.name || '').toLowerCase(),
  status: p => p.status || PROJECT_STATUSES[0],
  requestDate: p => p.requestDate || '',
  customerName: p => (p.customerName || '').toLowerCase(),
  destinationCountry: p => (p.destinationCountry || '').toLowerCase(),
  ownerSalesRep: p => (p.ownerSalesRep || '').toLowerCase(),
  factorySalesRep: p => (p.factorySalesRep || '').toLowerCase(),
  responsiblePerson: p => (p.responsiblePerson || '').toLowerCase(),
  factoryName: p => (p.factoryName || '').toLowerCase(),
  productCount: p => p.products.length,
  updatedAt: p => p.updatedAt || 0
};
function compareProjects(a, b){
  const accessor = PROJECT_SORT_ACCESSORS[projectSortKey] || PROJECT_SORT_ACCESSORS.updatedAt;
  const av = accessor(a), bv = accessor(b);
  const cmp = (typeof av === 'number' && typeof bv === 'number') ? av - bv : String(av).localeCompare(String(bv));
  return projectSortDir === 'asc' ? cmp : -cmp;
}

// Same fields as PROJECT_SORT_ACCESSORS, but the *raw* display value (not
// lowercased, numbers turned into strings) — this is what actually shows up
// as a checkbox label in a column's filter popover and what a project's
// value is compared against, so it needs to read the same as the cell
// itself rather than the folded-for-sorting version.
const PROJECT_FILTER_ACCESSORS = {
  name: p => p.name || '',
  status: p => p.status || PROJECT_STATUSES[0],
  requestDate: p => p.requestDate || '',
  customerName: p => p.customerName || '',
  destinationCountry: p => p.destinationCountry || '',
  ownerSalesRep: p => p.ownerSalesRep || '',
  factorySalesRep: p => p.factorySalesRep || '',
  responsiblePerson: p => p.responsiblePerson || '',
  factoryName: p => p.factoryName || '',
  productCount: p => String(p.products.length)
};

// The checkbox-list popover for one column's "▾" filter button — every
// distinct value currently in use across ALL projects (not narrowed by any
// other active filter; each column's list is independent, simpler than
// Excel's cross-narrowing behavior and avoids a recursive-filtering class
// of bugs for what's a fairly small table). A blank/missing value gets its
// own "(Blank)" entry rather than being silently dropped from the list.
function projectColumnFilterMenuHtml(key){
  const accessor = PROJECT_FILTER_ACCESSORS[key];
  const allValues = Array.from(new Set(projects.map(accessor))).sort((a, b) => {
    return key === 'productCount' ? Number(a) - Number(b) : a.localeCompare(b);
  });
  const activeFilter = projectColumnFilters[key];
  const isChecked = v => !activeFilter || activeFilter.has(v);
  const allChecked = !activeFilter;
  return `
    <div class="proj-col-filter-menu" data-filter-menu="${key}">
      <label class="proj-col-filter-item proj-col-filter-selectall">
        <input type="checkbox" class="filter-select-all" ${allChecked ? 'checked' : ''}>
        <b>(Select All)</b>
      </label>
      <div class="proj-col-filter-values">
        ${allValues.map(v => `
          <label class="proj-col-filter-item">
            <input type="checkbox" class="filter-value-cb" value="${escapeHtml(v)}" ${isChecked(v) ? 'checked' : ''}>
            ${v === '' ? '<i>(Blank)</i>' : escapeHtml(v)}
          </label>
        `).join('')}
      </div>
      ${activeFilter ? `<button type="button" class="btn btn-sm proj-col-filter-clear" data-clear-filter="${key}" style="margin-top:6px;width:100%;">Clear filter</button>` : ''}
    </div>
  `;
}
function sortableProjectHeader(label, key){
  const active = projectSortKey === key;
  const arrow = active ? icon(projectSortDir === 'asc' ? 'chevron-up' : 'chevron-down', 12) : '';
  const hasFilter = !!projectColumnFilters[key];
  return `
    <th class="proj-th-sortable${active ? ' active' : ''}" data-col="${key}">
      <span class="proj-th-label" data-sort-key="${key}">${escapeHtml(label)} ${arrow}</span>
      <button type="button" class="proj-th-filter-btn${hasFilter ? ' active' : ''}" data-filter-trigger="${key}" title="Filter ${escapeHtml(label)}">${icon('chevron-down', 12)}</button>
      ${projectColumnFilterMenuHtml(key)}
    </th>
  `;
}

// Which projects-table columns can be hidden via the "Columns" picker —
// Project (name), the expand arrow, and the Edit/Delete actions column are
// left out on purpose: hiding the row's own identity or its only actions
// would make the table useless rather than just less cluttered.
// PROJECT_TABLE_TOTAL_COLUMNS is every <th>/<td> the summary row actually
// has (including those 3 non-toggleable ones) — used to size the expanded
// detail row's colspan (see projectDetailColspan below) so it always spans
// exactly however many columns are currently visible.
const PROJECT_TOGGLE_COLUMNS = [
  { key: 'photo', label: 'Photo' },
  { key: 'status', label: 'Status' },
  { key: 'requestDate', label: 'Requested' },
  { key: 'customerName', label: 'Customer' },
  { key: 'destinationCountry', label: 'Destination' },
  { key: 'ownerSalesRep', label: 'Owner' },
  { key: 'factorySalesRep', label: 'Factory Rep' },
  { key: 'responsiblePerson', label: 'PD' },
  { key: 'factoryName', label: 'Factory' },
  { key: 'requirements', label: 'Reqs' },
  { key: 'productCount', label: 'Products' }
];
const PROJECT_TABLE_TOTAL_COLUMNS = 14;
const PROJECT_HIDDEN_COLUMNS_KEY = 'forgeProjectHiddenColumns';
let projectHiddenColumns = new Set();
try{
  const saved = JSON.parse(localStorage.getItem(PROJECT_HIDDEN_COLUMNS_KEY) || '[]');
  if(Array.isArray(saved)) projectHiddenColumns = new Set(saved);
}catch(e){ /* ignore corrupt/old localStorage value, just start with nothing hidden */ }
function projectDetailColspan(){
  return PROJECT_TABLE_TOTAL_COLUMNS - projectHiddenColumns.size;
}
// Applies the current hidden-column set to whatever the projects table's
// DOM looks like right now — every [data-col] header/cell gets display:none
// if its key is hidden, and every expanded detail row's colspan is kept in
// sync so it still spans exactly the visible columns (not the full 14).
// Called after every full table rebuild and after each individual toggle,
// so it never needs a full renderProjectsList() just to show/hide a column.
function applyProjectColumnVisibility(){
  document.querySelectorAll('.proj-overview-table [data-col]').forEach(el => {
    el.style.display = projectHiddenColumns.has(el.dataset.col) ? 'none' : '';
  });
  const colspan = projectDetailColspan();
  document.querySelectorAll('.proj-overview-table .proj-detail-row > td[colspan]').forEach(td => {
    td.colSpan = colspan;
  });
}

// The "+ New Project" entry form — shown inline right below the button and
// kept out of the `projects` array (and Firestore) entirely until Save is
// clicked, so just opening the panel never creates a stray blank project.
function renderNewProjectPanel(){
  const panel = document.getElementById('newProjectPanel');
  if(!panel) return;
  if(!newProjectOpen){
    panel.innerHTML = '';
    return;
  }
  panel.innerHTML = `
    <div class="card" style="margin:0 0 16px;background:var(--bg);">
      <div class="project-header-grid">
        <div class="field" style="margin-bottom:0;">
          <label>Project Name</label>
          <input type="text" id="newProjName" placeholder="e.g. Sunrise Foods Q3 Launch">
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Photo (optional)</label>
          <input type="file" id="newProjImageInput" accept="image/*">
          <div style="display:flex;align-items:center;gap:10px;margin-top:6px;">
            <img id="newProjImagePreview" src="${newProjectImage ? escapeHtml(newProjectImage) : ''}" style="${newProjectImage ? '' : 'display:none;'}width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--border);">
            <button type="button" class="btn btn-sm" id="newProjImageRemove" style="${newProjectImage ? '' : 'display:none;'}">Remove photo</button>
          </div>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Status</label>
          <select class="proj-select" id="newProjStatus">
            ${PROJECT_STATUSES.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(PROJECT_STATUS_LABELS[s])}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Request Date</label>
          <input type="date" id="newProjRequestDate" value="${escapeHtml(new Date().toISOString().slice(0,10))}">
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Start Date</label>
          <input type="date" id="newProjStartDate">
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Target / End Date</label>
          <input type="date" id="newProjTargetEndDate">
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Customer Name</label>
          <input type="text" id="newProjCustomer" list="customerDatalist" placeholder="e.g. ABC Trading Co.">
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Destination Country</label>
          <input type="text" id="newProjDestination" list="destinationDatalist" placeholder="e.g. Japan">
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Project Owner</label>
          <input type="text" id="newProjOwner" list="salesRepDatalist" placeholder="e.g. Somchai">
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Factory Sales Rep</label>
          <input type="text" id="newProjFactoryRep" list="salesRepDatalist" placeholder="e.g. Kenta-san">
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Responsible Person (PD)</label>
          <input type="text" id="newProjResponsible" list="responsiblePersonDatalist" placeholder="e.g. Kanya">
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Factory</label>
          <input type="text" id="newProjFactory" list="customerDatalist" placeholder="e.g. Rayong Plant 2">
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Portion Weight</label>
          <div class="combo-row">
            <input type="number" id="newProjPortionQty" placeholder="e.g. 20" step="any" min="0">
            <input type="text" id="newProjPortionUnit" list="unitsDatalist" value="g" placeholder="unit">
            <span>/</span>
            <input type="text" id="newProjPortionPerUnit" list="unitsDatalist" value="pcs" placeholder="per">
          </div>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Inner Packing</label>
          <div class="combo-row">
            <input type="number" id="newProjInnerQty" placeholder="e.g. 30" step="any" min="0">
            <input type="text" id="newProjInnerWeightUnit" list="unitsDatalist" value="g" placeholder="unit">
            <span>/</span>
            <input type="text" id="newProjInnerPackUnit" list="unitsDatalist" value="pack" placeholder="pack unit">
          </div>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>Outer Packing</label>
          <div class="combo-row">
            <input type="number" id="newProjOuterQty" placeholder="e.g. 24" step="any" min="0">
            <input type="text" id="newProjOuterPackUnit" list="unitsDatalist" value="pack" placeholder="pack unit">
            <span>/</span>
            <input type="text" id="newProjOuterContainerUnit" list="unitsDatalist" value="carton" placeholder="container">
          </div>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>MOQ</label>
          <div class="combo-row">
            <input type="number" id="newProjMoqQty" placeholder="e.g. 500" step="any" min="0">
            <input type="text" id="newProjMoqUnit" list="unitsDatalist" value="pcs" placeholder="unit">
          </div>
        </div>
        <div class="field" style="margin-bottom:0;grid-column:1 / -1;">
          <label>Requirements</label>
          <div class="field" style="margin-bottom:8px;">
            <label>Flavor or Filling</label>
            <input type="text" id="newProjReqFlavorFilling" placeholder="e.g. Original">
          </div>
          <div class="field" style="margin-bottom:8px;">
            <label>Composition</label>
            <textarea id="newProjReqComposition" placeholder="e.g. Takoyaki: 20g x 4 pieces"></textarea>
          </div>
          <div class="field" style="margin-bottom:8px;">
            <label>Recipe</label>
            <textarea id="newProjReqRecipe" placeholder="Reference / attachment notes"></textarea>
          </div>
          <div class="field" style="margin-bottom:8px;">
            <label>Packaging condition</label>
            <textarea id="newProjReqPackaging" placeholder="e.g. Microwaveable black plastic tray"></textarea>
          </div>
          <div class="field" style="margin-bottom:8px;">
            <label>Cooking Condition</label>
            <input type="text" id="newProjReqCookingCondition" placeholder="e.g. N/A">
          </div>
          <div class="field" style="margin-bottom:8px;">
            <label>Certificate</label>
            <input type="text" id="newProjReqCertificate" placeholder="e.g. Halal certificate">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Note</label>
            <textarea id="newProjReqNote" placeholder="Anything else not covered above"></textarea>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn btn-primary btn-sm" id="btnSaveNewProject">${icon('save')} Save</button>
        <button class="btn btn-sm proj-action-cancel" id="btnCancelNewProject">${icon('undo-2')} Cancel</button>
      </div>
    </div>
  `;

  const imageInput = document.getElementById('newProjImageInput');
  const imagePreview = document.getElementById('newProjImagePreview');
  const imageRemoveBtn = document.getElementById('newProjImageRemove');
  imageInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if(!file) return;
    try{
      newProjectImage = await resizeImageFile(file, 400);
      imagePreview.src = newProjectImage;
      imagePreview.style.display = 'block';
      imageRemoveBtn.style.display = 'inline-flex';
    }catch(err){
      alert(err.message || 'Could not read that image file');
    }
  });
  imageRemoveBtn.addEventListener('click', () => {
    newProjectImage = '';
    imageInput.value = '';
    imagePreview.src = '';
    imagePreview.style.display = 'none';
    imageRemoveBtn.style.display = 'none';
  });

  // Same customer-country auto-fill as the edit-row form (see the
  // .proj-customer 'change' listener below) — kept as a separate, small
  // duplicate here since this panel isn't part of the projects table.
  document.getElementById('newProjCustomer').addEventListener('change', e => {
    const match = metaLists.customers.find(c => metaItemName(c) === e.target.value.trim());
    if(match && match.country){
      document.getElementById('newProjDestination').value = match.country;
    }
  });

  document.getElementById('btnCancelNewProject').addEventListener('click', () => {
    newProjectOpen = false;
    newProjectImage = '';
    renderNewProjectPanel();
  });

  document.getElementById('btnSaveNewProject').addEventListener('click', () => {
    const p = blankProject();
    p.name = document.getElementById('newProjName').value.trim();
    p.image = newProjectImage;
    p.status = document.getElementById('newProjStatus').value;
    p.requestDate = document.getElementById('newProjRequestDate').value;
    p.startDate = document.getElementById('newProjStartDate').value;
    p.targetEndDate = document.getElementById('newProjTargetEndDate').value;
    p.customerName = document.getElementById('newProjCustomer').value.trim();
    p.destinationCountry = document.getElementById('newProjDestination').value.trim();
    p.ownerSalesRep = document.getElementById('newProjOwner').value.trim();
    p.factorySalesRep = document.getElementById('newProjFactoryRep').value.trim();
    p.responsiblePerson = document.getElementById('newProjResponsible').value.trim();
    p.factoryName = document.getElementById('newProjFactory').value.trim();
    p.portionWeightQty = document.getElementById('newProjPortionQty').value.trim();
    p.portionWeightUnit = document.getElementById('newProjPortionUnit').value.trim();
    p.portionPerUnit = document.getElementById('newProjPortionPerUnit').value.trim();
    p.innerPackQty = document.getElementById('newProjInnerQty').value.trim();
    p.innerPackWeightUnit = document.getElementById('newProjInnerWeightUnit').value.trim();
    p.innerPackUnit = document.getElementById('newProjInnerPackUnit').value.trim();
    p.outerPackQty = document.getElementById('newProjOuterQty').value.trim();
    p.outerPackUnit = document.getElementById('newProjOuterPackUnit').value.trim();
    p.outerPackContainerUnit = document.getElementById('newProjOuterContainerUnit').value.trim();
    p.moqQty = document.getElementById('newProjMoqQty').value.trim();
    p.moqUnit = document.getElementById('newProjMoqUnit').value.trim();
    p.requirements = {
      flavorFilling: document.getElementById('newProjReqFlavorFilling').value.trim(),
      composition: document.getElementById('newProjReqComposition').value.trim(),
      recipe: document.getElementById('newProjReqRecipe').value.trim(),
      packagingCondition: document.getElementById('newProjReqPackaging').value.trim(),
      // Quick-create keeps a single plain field for speed -- the full
      // method+steps editor (see the main edit form) is available once the
      // project is opened, same "start simple, refine later" tradeoff the
      // rest of this modal already makes.
      cookingCondition: (() => {
        const v = document.getElementById('newProjReqCookingCondition').value.trim();
        return { method: '', steps: v ? [v] : [] };
      })(),
      certificate: document.getElementById('newProjReqCertificate').value.trim(),
      note: document.getElementById('newProjReqNote').value.trim()
    };
    projects.push(p);
    saveProjectToCloud(p);
    logActivityEvent('created', 'project', p.name || 'Untitled project');
    newProjectOpen = false;
    newProjectImage = '';
    projectEditingId = p.id;
    projectExpandedIds.add(p.id);
    renderNewProjectPanel();
    renderProjectsList();
  });
}

// Wires up a click handler shared by both kinds of clickable element inside
// the "Projects by Status" card: a project's own photo (jump to + expand
// that one project) and a status bar/row (filter the table to that status).
// Called once after every dashboardContainer rebuild, same as the Gantt
// chart's own click wiring right above it.
function wireProjectsByStatusCardClicks(dashboardContainer){
  dashboardContainer.querySelectorAll('[data-gallery-project-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.galleryProjectId;
      projectExpandedIds.add(id);
      renderProjectsList();
      document.querySelector(`tbody[data-project-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
  dashboardContainer.querySelectorAll('[data-status-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      projectColumnFilters = { ...projectColumnFilters, status: new Set([btn.dataset.statusFilter]) };
      renderProjectsList();
      document.getElementById('projectsList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

// A horizontal timeline bar per project running from Start Date to Target/
// End Date, colored by status (same palette as the photo gallery ring).
// Always reflects ALL projects (not the search/status filter), same as the
// rest of the dashboard summary above the table. Projects missing either
// date are simply left off the chart — there's no meaningful bar to draw
// for them, and forcing a fallback (e.g. Request Date as a stand-in) would
// misrepresent a project that was never actually scheduled.
function renderProjectGanttChart(){
  const container = document.getElementById('projectGanttChart');
  if(!container) return;
  const withDates = projects
    .filter(p => p.startDate && p.targetEndDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  if(!withDates.length){
    container.innerHTML = `
      <div class="dash-card-title">Project Timeline</div>
      <div class="dash-empty">No projects have both a Start Date and Target/End Date yet — add them in a project's details to see the Gantt chart here</div>
    `;
    return;
  }

  const DAY = 86400000;
  const PX_PER_DAY = 8;
  const ROW_H = 30;
  const toTime = s => new Date(s + 'T00:00:00').getTime();
  const minStart = Math.min(...withDates.map(p => toTime(p.startDate)));
  const maxEnd = Math.max(...withDates.map(p => toTime(p.targetEndDate)));
  // Pad both ends by a few days so the first/last bar isn't flush against
  // the chart edge, and guard a tiny (or single-project, same-day) range
  // from producing a near-zero-width timeline.
  const rangeStart = minStart - 3 * DAY;
  const rangeEnd = Math.max(maxEnd + 3 * DAY, rangeStart + 14 * DAY);
  const totalDays = Math.ceil((rangeEnd - rangeStart) / DAY);
  const timelineWidth = totalDays * PX_PER_DAY;
  const xOf = t => Math.round((t - rangeStart) / DAY * PX_PER_DAY);

  // Month tick marks across the padded range, snapped to the 1st of each
  // month so labels land on a predictable, evenly-spaced grid.
  const months = [];
  const cursor = new Date(rangeStart);
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  while(cursor.getTime() <= rangeEnd){
    months.push(new Date(cursor.getTime()));
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const now = Date.now();
  const showToday = now >= rangeStart && now <= rangeEnd;
  const gridlinesHtml = months.map(m => `<div class="gantt-gridline" style="left:${xOf(m.getTime())}px"></div>`).join('')
    + (showToday ? `<div class="gantt-today-line" style="left:${xOf(now)}px" title="Today"></div>` : '');
  const monthLabelsHtml = months.map(m => `<div class="gantt-month-label" style="left:${xOf(m.getTime())}px">${escapeHtml(m.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }))}</div>`).join('');

  const barsHtml = withDates.map((p, i) => {
    const left = xOf(toTime(p.startDate));
    const width = Math.max(4, xOf(toTime(p.targetEndDate)) - left);
    const color = projectPhotoStatusColor(p.status);
    const name = p.name || 'Untitled project';
    return `<div class="gantt-bar" data-gantt-project-id="${escapeHtml(p.id)}" style="top:${i * ROW_H + 5}px;left:${left}px;width:${width}px;background:${color};" title="${escapeHtml(name)} — ${escapeHtml(p.startDate)} → ${escapeHtml(p.targetEndDate)}"></div>`;
  }).join('');
  const labelsHtml = withDates.map(p => `<div class="gantt-label-row" data-gantt-project-id="${escapeHtml(p.id)}" style="height:${ROW_H}px;" title="${escapeHtml(p.name || 'Untitled project')}">${escapeHtml(p.name || 'Untitled project')}</div>`).join('');

  container.innerHTML = `
    <div class="dash-card-title">Project Timeline</div>
    <div class="gantt-body">
      <div class="gantt-labels">
        <div class="gantt-labels-header"></div>
        ${labelsHtml}
      </div>
      <div class="gantt-scroll">
        <div class="gantt-timeline" style="width:${timelineWidth}px;">
          <div class="gantt-timeline-header">${monthLabelsHtml}</div>
          <div class="gantt-timeline-body" style="height:${withDates.length * ROW_H}px;">
            ${gridlinesHtml}
            ${barsHtml}
          </div>
        </div>
      </div>
    </div>
  `;

  container.querySelectorAll('[data-gantt-project-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.ganttProjectId;
      projectExpandedIds.add(id);
      renderProjectsList();
      document.querySelector(`tbody[data-project-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

export function renderProjectsList(){
  const container = document.getElementById('projectsList');
  const dashboardContainer = document.getElementById('projectsDashboard');
  if(!container) return;
  if(projects.length === 0){
    if(dashboardContainer) dashboardContainer.innerHTML = '';
    container.innerHTML = '<div class="overview-empty">No projects yet — click "+ New Project" above to start one</div>';
    return;
  }

  // The search box lives outside both #projectsDashboard and #projectsList
  // (a sibling, static element) so re-rendering these containers on every
  // keystroke never destroys/recreates the input itself — the cursor and
  // focus just stay put, same trick the recipe sidebar search already uses.
  const searchQuery = (document.getElementById('projectSearchInput')?.value || '').trim().toLowerCase();
  const matchesSearch = p => {
    if(!searchQuery) return true;
    const haystack = [
      p.name, p.customerName, p.destinationCountry, p.ownerSalesRep,
      p.factorySalesRep, p.responsiblePerson, p.factoryName,
      p.status || PROJECT_STATUSES[0]
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(searchQuery);
  };
  // Excel-style per-column value filters (see the "▾" button on every
  // sortable header) — a column only shows up here once at least one of
  // its values has been unchecked; an absent key means "show everything"
  // for that column, same idea as the old "All statuses"-style dropdowns
  // this replaced.
  const matchesColumnFilters = p => Object.entries(projectColumnFilters).every(([key, allowed]) => {
    const accessor = PROJECT_FILTER_ACCESSORS[key];
    return accessor ? allowed.has(accessor(p)) : true;
  });
  const sorted = projects.filter(p => matchesSearch(p) && matchesColumnFilters(p)).sort(compareProjects);

  // Dashboard summary always reflects ALL projects (not the search filter)
  // — searching narrows the table below, not the overview stats above it.
  const allProductsGlobal = projects.flatMap(pr => pr.products || []);
  const productsByStage = PROJECT_STAGES
    .map(stage => ({ label: stage, count: allProductsGlobal.filter(x => x.stage === stage).length }))
    .filter(g => g.count > 0);
  const projectsByStatus = PROJECT_STATUSES
    .map(status => ({ label: status, count: projects.filter(pr => (pr.status || PROJECT_STATUSES[0]) === status).length }))
    .filter(g => g.count > 0);
  if(dashboardContainer){
    dashboardContainer.innerHTML = `
      <div class="dash-metrics" style="margin-bottom:14px;">
        <div class="dash-metric">
          <div class="dash-metric-label">Projects</div>
          <div class="dash-metric-value">${projects.length}</div>
        </div>
        <div class="dash-metric">
          <div class="dash-metric-label">Products</div>
          <div class="dash-metric-value">${allProductsGlobal.length}</div>
        </div>
      </div>
      <div class="dash-card" style="margin-bottom:16px;">
        <div class="dash-card-title">Projects by Status</div>
        ${renderStatusBarList(projectsByStatus)}
      </div>
      <div class="dash-card" style="margin-bottom:16px;">
        <div class="dash-card-title">Products by stage</div>
        ${renderBarList(productsByStage)}
      </div>
      <div class="dash-card" style="margin-bottom:16px;" id="projectGanttChart"></div>
    `;
    renderProjectGanttChart();
    wireProjectsByStatusCardClicks(dashboardContainer);
  }

  if(sorted.length === 0){
    const q = document.getElementById('projectSearchInput').value.trim();
    const label = q ? `No projects match "${escapeHtml(q)}"` : 'No projects match the selected filters';
    container.innerHTML = `<div class="overview-empty">${label}</div>`;
    return;
  }

  // Empty-value marker for the overview table — a plain blank cell reads as
  // "nothing to report", but a project missing Customer/Destination/etc. is
  // usually a data gap that needs following up on, so it's flagged in
  // --danger red instead of just left blank.
  const missingCell = v => v ? escapeHtml(v) : '<span class="proj-missing" title="Missing">—</span>';

  container.innerHTML = `
    <div class="proj-table-scroll">
    <table class="proj-overview-table">
      <thead>
        <tr>
          <th></th>
          <th data-col="photo">Photo</th>
          ${sortableProjectHeader('Project', 'name')}
          ${sortableProjectHeader('Status', 'status')}
          ${sortableProjectHeader('Requested', 'requestDate')}
          ${sortableProjectHeader('Customer', 'customerName')}
          ${sortableProjectHeader('Destination', 'destinationCountry')}
          ${sortableProjectHeader('Owner', 'ownerSalesRep')}
          ${sortableProjectHeader('Factory Rep', 'factorySalesRep')}
          ${sortableProjectHeader('PD', 'responsiblePerson')}
          ${sortableProjectHeader('Factory', 'factoryName')}
          <th data-col="requirements">Reqs</th>
          ${sortableProjectHeader('Products', 'productCount')}
          <th class="proj-actions-cell"></th>
        </tr>
      </thead>
      ${sorted.map(p => {
        const isEditing = p.id === projectEditingId;
        const isExpanded = isEditing || projectExpandedIds.has(p.id);
        const ro = isEditing ? '' : 'readonly';
        const usedRecipeIds = new Set(p.products.map(prod => prod.recipeId));
        const availableRecipes = recipes.filter(r => !usedRecipeIds.has(r.id));
        const activity = [];
        if(p.createdBy) activity.push(`Created by ${escapeHtml(p.createdBy)}${p.createdAt ? ' · ' + escapeHtml(formatActivityDateTime(p.createdAt)) : ''}`);
        if(p.updatedBy && p.updatedAt !== p.createdAt) activity.push(`Last edited by ${escapeHtml(p.updatedBy)}${p.updatedAt ? ' · ' + escapeHtml(formatActivityDateTime(p.updatedAt)) : ''}`);

        // Same edit/view split as the project header above — read-only
        // means read-only, so Sales Rep and Stage show as plain text here
        // too instead of an always-live input/select a viewer could
        // accidentally change without ever clicking Edit.
        const rows = p.products.map(prod => {
          const r = recipes.find(x => x.id === prod.recipeId);
          const label = r
            ? `${escapeHtml(recipeDisplayLabel(r))}${fullCode(r) ? ' · ' + escapeHtml(fullCode(r)) : ''}`
            : '<span style="color:var(--danger);">Recipe not found (deleted?)</span>';
          if(!isEditing){
            return `
              <tr data-product-id="${escapeHtml(prod.id)}">
                <td>${label}</td>
                <td>${escapeHtml(prod.salesRep || '-')}</td>
                <td>${escapeHtml(prod.stage || PROJECT_STAGES[0])}</td>
                <td style="font-size:12px;color:var(--text-dim);white-space:nowrap;">${escapeHtml(formatActivityDateTime(prod.updatedAt) || '')}</td>
                <td style="white-space:nowrap;">
                  <button class="icon-btn" title="Progress log" data-role="open-log">${icon('clock')}</button>
                </td>
              </tr>
            `;
          }
          return `
            <tr data-product-id="${escapeHtml(prod.id)}">
              <td>${label}</td>
              <td><input type="text" class="proj-product-rep" list="salesRepDatalist" value="${escapeHtml(prod.salesRep)}" placeholder="Sales rep"></td>
              <td>
                <select class="proj-select proj-product-stage">
                  ${PROJECT_STAGES.map(s => `<option value="${escapeHtml(s)}" ${s === prod.stage ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
                </select>
              </td>
              <td style="font-size:12px;color:var(--text-dim);white-space:nowrap;">${escapeHtml(formatActivityDateTime(prod.updatedAt) || '')}</td>
              <td style="white-space:nowrap;">
                <button class="icon-btn" title="Progress log" data-role="open-log">${icon('clock')}</button>
                <button class="icon-btn" title="Remove product" data-role="remove-product">${icon('x')}</button>
              </td>
            </tr>
          `;
        }).join('');

        const productCount = p.products.length;
        const req = getRequirements(p);

        // Append-only activity timeline (Plan / Action Taken / Next Action
        // per entry) — separate from the per-product progress log, since
        // this is a project-level summary meant for handing straight to a
        // supervisor, not tied to any one product's pipeline stage. An
        // entry with no Action Taken yet reads as "Planned" (see
        // monthlyUpdateStatus) — normally one auto-created by a previous
        // entry's "Create as Plan automatically" checkbox.
        const rawUpdates = p.monthlyUpdates || [];
        const migratedUpdates = rawUpdates.map(migrateMonthlyUpdate);
        const todayStr = new Date().toISOString().slice(0, 10);
        const monthlyUpdatesHtml = migratedUpdates.length
          ? [...migratedUpdates].sort((a,b) => (b.date||'').localeCompare(a.date||'') || (b.createdAt||0) - (a.createdAt||0)).map((mu, idx, sorted) => {
              if(isEditing && mu.id === monthlyUpdateEditingId){
                return `
                  <div class="mu-entry" data-update-id="${escapeHtml(mu.id)}">
                    <div class="mu-entry-marker"></div>
                    <div class="mu-entry-body">
                      <div class="proj-monthly-add">
                        <div class="mu-plan-box">
                          <div class="mu-plan-box-title">Plan</div>
                          <div class="field">
                            <label>When</label>
                            <div class="mu-when-group">
                              <input type="date" class="proj-mu-edit-date" value="${escapeHtml(mu.date || '')}">
                              <input type="time" class="proj-mu-edit-time" value="${escapeHtml(mu.time || '')}">
                            </div>
                          </div>
                          <div class="field">
                            <label>Who</label>
                            <input type="text" class="proj-mu-edit-who" list="salesRepDatalist" placeholder="e.g. Yano-san" value="${escapeHtml(mu.planWho || '')}">
                          </div>
                          <div class="field">
                            <label>What</label>
                            <div class="mu-field-with-translate" style="width:auto;">
                              <textarea class="proj-mu-edit-plan" placeholder="What">${escapeHtml(mu.plan || '')}</textarea>
                              <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                            </div>
                          </div>
                          <div class="field">
                            <label>Where</label>
                            <input type="text" class="proj-mu-edit-where" list="customerDatalist" placeholder="e.g. UMIOS Office" value="${escapeHtml(mu.planWhere || '')}">
                            <select class="proj-select proj-mu-edit-where-location" style="display:none;margin-top:6px;"></select>
                          </div>
                          <div class="field" style="margin-bottom:0;">
                            <label>How</label>
                            <div class="mu-field-with-translate" style="width:auto;">
                              <textarea class="proj-mu-edit-how" placeholder="How">${escapeHtml(mu.planHow || '')}</textarea>
                              <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                            </div>
                          </div>
                        </div>
                        <div class="mu-plan-box">
                          <div class="mu-plan-box-title">Action Taken</div>
                          <div class="field">
                            <label>Action Taken</label>
                            <div class="mu-field-with-translate" style="width:auto;">
                              <textarea class="proj-mu-edit-action" placeholder="Action Taken">${escapeHtml(mu.actionTaken || '')}</textarea>
                              <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                            </div>
                          </div>
                          <div class="field" style="margin-bottom:0;">
                            <label>Completed Date (optional)</label>
                            <input type="date" class="proj-mu-edit-completed-date" value="${escapeHtml(mu.completedDate || '')}" title="Completed date — defaults to today once Action Taken is filled in, edit if it was actually finished on a different day">
                          </div>
                        </div>
                        <div class="mu-plan-box">
                          <div class="mu-plan-box-title">Next Action</div>
                          <div class="field">
                            <label>When</label>
                            <div class="mu-when-group">
                              <input type="date" class="proj-mu-edit-nextaction-due" value="${escapeHtml(mu.nextActionDue || '')}" title="Next Action due date">
                              <input type="time" class="proj-mu-edit-nextaction-time" value="${escapeHtml(mu.nextActionTime || '')}">
                            </div>
                          </div>
                          <div class="field">
                            <label>Who</label>
                            <input type="text" class="proj-mu-edit-nextaction-who" list="salesRepDatalist" placeholder="e.g. Yano-san" value="${escapeHtml(mu.nextActionWho || '')}">
                          </div>
                          <div class="field">
                            <label>What</label>
                            <div class="mu-field-with-translate" style="width:auto;">
                              <textarea class="proj-mu-edit-nextaction" placeholder="Next Action">${escapeHtml(mu.nextAction || '')}</textarea>
                              <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                            </div>
                          </div>
                          <div class="field">
                            <label>Where</label>
                            <input type="text" class="proj-mu-edit-nextaction-where" list="customerDatalist" placeholder="e.g. UMIOS Office" value="${escapeHtml(mu.nextActionWhere || '')}">
                            <select class="proj-select proj-mu-edit-nextaction-where-location" style="display:none;margin-top:6px;"></select>
                          </div>
                          <div class="field" style="margin-bottom:0;">
                            <label>How</label>
                            <div class="mu-field-with-translate" style="width:auto;">
                              <textarea class="proj-mu-edit-nextaction-how" placeholder="How">${escapeHtml(mu.nextActionHow || '')}</textarea>
                              <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                            </div>
                          </div>
                        </div>
                        <div class="field">
                          <label>Linked Recipe (optional)</label>
                          <select class="proj-select proj-mu-edit-recipe">${muRecipeOptionsHtml(mu.linkedRecipeId)}</select>
                        </div>
                        <div class="field">
                          <label>Attachments (optional)</label>
                          <div class="mu-attachments-editor">
                            <div class="mu-attachments-chiplist"></div>
                            <label class="btn btn-sm mu-attach-btn">${icon('paperclip', 14)} Attach file/photo<input type="file" class="mu-attach-input" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv" multiple style="display:none;"></label>
                          </div>
                        </div>
                        <label class="mu-autocreate-label"><input type="checkbox" class="proj-mu-edit-autocreate" ${mu.autoCreatePlan ? 'checked' : ''}> Create as Plan automatically</label>
                        <div style="display:flex;gap:8px;">
                          <button class="btn btn-sm btn-primary" data-role="save-monthly-update-edit">${icon('save')} Save</button>
                          <button class="btn btn-sm proj-action-cancel" data-role="cancel-monthly-update-edit">${icon('undo-2')} Cancel</button>
                        </div>
                      </div>
                    </div>
                  </div>
                `;
              }
              const status = monthlyUpdateStatus(mu);
              const source = mu.sourceUpdateId ? migratedUpdates.find(x => x.id === mu.sourceUpdateId) : null;
              // Full status (overdue/today/upcoming/completed/nodate) for
              // the left-border accent + badge — separate from the
              // planned/logged split above, which only drives the timeline
              // marker and the PLANNED pill.
              const taskStatus = getTaskStatus(mu, todayStr);
              const meta = TASK_STATUS_META[taskStatus];
              const nextActionSuperseded = mu.nextActionDue && migratedUpdates.some(x => x.sourceUpdateId === mu.id);
              const linkedRecipe = mu.linkedRecipeId ? recipes.find(r => r.id === mu.linkedRecipeId) : null;
              return `
              <div class="mu-entry${idx === sorted.length - 1 ? ' mu-entry-last' : ''}" data-update-id="${escapeHtml(mu.id)}">
                <div class="mu-entry-marker${status === 'planned' ? ' mu-marker-planned' : ''}"></div>
                <div class="mu-entry-body mu-status-${taskStatus}">
                  <div class="mu-entry-header">
                    <span class="mu-entry-date">${escapeHtml(formatDateLong(mu.date))} · ${status === 'logged' ? escapeHtml(formatTimeOnly(mu.createdAt)) : '<span class="mu-planned-label">Planned</span>'}</span>
                    <span class="mu-status-badge">${meta.icon} ${escapeHtml(meta.label(mu, todayStr))}</span>
                    ${isEditing ? `<button class="icon-btn" title="Edit this update" data-role="edit-monthly-update" style="float:right;">${icon('pencil')}</button><button class="icon-btn" title="Delete this update" data-role="delete-monthly-update" style="float:right;">${icon('x')}</button>` : ''}
                    <div class="mu-entry-by">${mu.createdBy ? escapeHtml(mu.createdBy) : ''}</div>
                  </div>
                  <div class="mu-card-grid"${mu.nextAction ? '' : ' style="grid-template-columns:repeat(2,1fr);"'}>
                    <div class="mu-card mu-card-clickable" data-section="plan" title="Click to update">
                      <div class="mu-card-title">${icon('file-text', 14)} PLAN${source ? ' <span class="mu-badge">AUTO-CREATED</span>' : ''}${status === 'planned' ? ' <span class="mu-status-pill">PLANNED</span>' : ''}</div>
                      ${(mu.time || mu.planWho) ? `<div class="mu-plan-detail-line">${mu.time ? `<b>When:</b> ${escapeHtml(mu.time)}` : ''}${mu.time && mu.planWho ? ' &nbsp;·&nbsp; ' : ''}${mu.planWho ? escapeHtml(mu.planWho) : ''}</div>` : ''}
                      <div class="mu-card-text">${mu.plan ? escapeHtml(mu.plan) : '<span class="mu-empty">No plan recorded</span>'}</div>
                      ${mu.planWhere ? `<div class="mu-plan-detail-line"><b>@</b> ${escapeHtml(mu.planWhere)}</div>` : ''}
                      ${mu.planHow ? `<div class="mu-plan-detail-line"><b>How:</b> ${escapeHtml(mu.planHow)}</div>` : ''}
                      ${source ? `<div class="mu-source-link">${icon('undo-2', 12)} From Next action · ${escapeHtml(formatDateLong(source.date))}${source.createdAt ? ', ' + escapeHtml(formatTimeOnly(source.createdAt)) : ''}</div>` : ''}
                    </div>
                    <div class="mu-card mu-card-clickable" data-section="action" title="Click to update">
                      <div class="mu-card-title">${icon('check', 14)} ACTION TAKEN</div>
                      <div class="mu-card-text">${mu.actionTaken ? escapeHtml(mu.actionTaken) : '<span class="mu-empty">Not yet taken action</span>'}</div>
                    </div>
                    ${mu.nextAction ? `
                    <div class="mu-card mu-card-clickable" data-section="nextaction" title="Click to update">
                      <div class="mu-card-title">${icon('clock', 14)} NEXT ACTION${mu.nextActionDue ? `<span class="mu-due-inline${nextActionSuperseded ? ' mu-due-superseded' : ''}">Due ${escapeHtml(formatDateLong(mu.nextActionDue))}</span>` : ''}</div>
                      ${(mu.nextActionTime || mu.nextActionWho) ? `<div class="mu-plan-detail-line">${mu.nextActionTime ? `<b>When:</b> ${escapeHtml(mu.nextActionTime)}` : ''}${mu.nextActionTime && mu.nextActionWho ? ' &nbsp;·&nbsp; ' : ''}${mu.nextActionWho ? escapeHtml(mu.nextActionWho) : ''}</div>` : ''}
                      <div class="mu-card-text">${escapeHtml(mu.nextAction)}</div>
                      ${mu.nextActionWhere ? `<div class="mu-plan-detail-line"><b>@</b> ${escapeHtml(mu.nextActionWhere)}</div>` : ''}
                      ${mu.nextActionHow ? `<div class="mu-plan-detail-line"><b>How:</b> ${escapeHtml(mu.nextActionHow)}</div>` : ''}
                    </div>
                    ` : ''}
                  </div>
                  ${(linkedRecipe || mu.attachments.length) ? `
                  <div class="mu-entry-extras">
                    ${linkedRecipe ? `<button type="button" class="mu-recipe-link" data-role="open-mu-recipe" data-recipe-id="${escapeHtml(linkedRecipe.id)}">${icon('link', 12)} ${escapeHtml(recipeDisplayLabel(linkedRecipe))}</button>` : ''}
                    ${muAttachmentChipsHtml(mu.attachments, false)}
                  </div>
                  ` : ''}
                </div>
              </div>
            `;
            }).join('')
          : '<div class="overview-empty">No activities updates yet</div>';

        const summaryRow = `
          <tr class="proj-row">
            <td><button type="button" class="part-toggle-btn${isExpanded ? ' open' : ''}" title="Expand / collapse this project">${icon('chevron-right')}</button></td>
            <td data-col="photo">${p.image ? `<img src="${escapeHtml(p.image)}" class="material-thumb" alt="${escapeHtml(p.name || 'Project photo')}">` : '<div class="material-thumb material-thumb-empty"></div>'}</td>
            <td><b>${escapeHtml(p.name || 'Untitled project')}</b>${projectStatusBarHtml(p.status)}</td>
            <td data-col="status">${escapeHtml(p.status || PROJECT_STATUSES[0])}</td>
            <td data-col="requestDate">${missingCell(p.requestDate)}</td>
            <td data-col="customerName">${missingCell(p.customerName)}</td>
            <td data-col="destinationCountry">${missingCell(p.destinationCountry)}</td>
            <td data-col="ownerSalesRep">${missingCell(p.ownerSalesRep)}</td>
            <td data-col="factorySalesRep">${missingCell(p.factorySalesRep)}</td>
            <td data-col="responsiblePerson">${missingCell(p.responsiblePerson)}</td>
            <td data-col="factoryName">${missingCell(p.factoryName)}</td>
            <td data-col="requirements">${Object.values(req).some(v => (v||'').trim()) ? icon('check', 14) : '<span class="proj-missing" title="Missing">—</span>'}</td>
            <td data-col="productCount">${productCount === 0 ? '<span class="proj-missing" title="No products yet">0</span>' : productCount}</td>
            <td class="proj-actions-cell" style="white-space:nowrap;">
              ${isEditing
                ? ''
                : `<button class="btn btn-sm" data-role="print-project" title="Print this project">${icon('printer')}</button><button class="btn btn-sm" data-role="edit-project">${icon('pencil')} Edit</button><button class="btn btn-sm btn-danger" data-role="delete-project">${icon('x')} Delete</button>`}
            </td>
          </tr>
        `;

        // Read-only view: photo on the left, a clean label/value list on the
        // right (same dt/dd styling as the Ingredient Library's detail
        // view) — replaces the disabled-input grid so a project you're just
        // looking at (not editing) reads like a document, not a form.
        const detailRowsHtml = rows => rows.map(([label, value]) => `
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value || '-')}</dd>
        `).join('');
        // Split around the Flavor/Filling table (below) so it lands exactly
        // where it visually used to sit as a single field — right after
        // Factory, before Portion Weight — even though it's no longer part
        // of the flat label/value list itself.
        const readOnlyDetailRowsBefore = detailRowsHtml([
          ['Status', PROJECT_STATUS_LABELS[p.status] || p.status || PROJECT_STATUSES[0]],
          ['Request Date', p.requestDate],
          ['Start Date', p.startDate],
          ['Target / End Date', p.targetEndDate],
          ['Customer Name', p.customerName],
          ['Destination Country', p.destinationCountry],
          ['Project Owner', p.ownerSalesRep],
          ['Factory Sales Rep', p.factorySalesRep],
          ['Responsible Person (PD)', p.responsiblePerson],
          ['Factory', p.factoryName]
        ]);
        const readOnlyDetailRowsAfter = detailRowsHtml([
          ['Portion Weight', p.portionWeightQty ? formatPortionWeight(p) : ''],
          ['Inner Packing', p.innerPackQty ? formatInnerPacking(p) : ''],
          ['Outer Packing', p.outerPackQty ? formatOuterPacking(p) : ''],
          ['MOQ', p.moqQty ? formatProjectMoq(p) : '']
        ]);
        const flavors = p.flavors || [];
        const formatFlavorPrice = (f, price) => price ? `${escapeHtml(price)} ${escapeHtml(f.priceCurrency || 'THB')} / ${escapeHtml(f.priceUnit || 'kg')}` : '-';
        const readOnlyFlavorsHtml = flavors.length ? `
          <div class="flavor-table-scroll">
          <table class="flavor-table">
            <thead><tr><th>Flavor</th><th>Target Price</th><th>Actual Price</th><th>Formula / Reference No.</th><th>Note</th></tr></thead>
            <tbody>${flavors.map(f => `
              <tr>
                <td>${escapeHtml(f.name || 'Untitled flavor')}</td>
                <td>${formatFlavorPrice(f, f.targetPrice)}</td>
                <td>${formatFlavorPrice(f, f.actualPrice)}</td>
                <td>${escapeHtml(f.formulaRefCode || '-')}</td>
                <td>${escapeHtml(f.note || '-')}</td>
              </tr>
            `).join('')}</tbody>
          </table>
          </div>
        ` : '<div class="overview-empty">No flavors yet</div>';
        const allAttachments = allProjectAttachments(p);
        const readOnlyRequirementsHtml = `
          <div class="requirements-box">
            <div class="requirements-box-title">Requirements</div>
            <div class="material-detail-notes-label">Flavor / Filling</div>
            ${readOnlyFlavorsHtml}
            ${req.composition ? `<div class="material-detail-notes-label">Composition</div><div class="material-detail-notes">${escapeHtml(req.composition)}</div>` : ''}
            ${req.recipe ? `<div class="material-detail-notes-label">Recipe</div><div class="material-detail-notes">${escapeHtml(req.recipe)}</div>` : ''}
            ${(req.cookingCondition.method || req.cookingCondition.steps.length) ? `
              <div class="material-detail-notes-label">Cooking Condition${req.cookingCondition.method ? ` — ${escapeHtml(req.cookingCondition.method)}` : ''}</div>
              ${req.cookingCondition.steps.length ? `<ol class="cooking-steps-list">${req.cookingCondition.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
            ` : ''}
            ${req.packagingCondition ? `<div class="material-detail-notes-label">Packaging condition</div><div class="material-detail-notes">${escapeHtml(req.packagingCondition)}</div>` : ''}
            ${req.note ? `<div class="material-detail-notes-label">Note</div><div class="material-detail-notes">${escapeHtml(req.note)}</div>` : ''}
            <dl class="material-detail-list requirements-box-divider">${detailRowsHtml([
              ['Certificate', req.certificate]
            ])}</dl>
          </div>
        `;
        const readOnlyDetailView = `
          <div class="project-detail-view">
            <div class="project-detail-photo">
              ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name || 'Project photo')}">` : '<div class="project-detail-photo-empty"></div>'}
            </div>
            <div class="project-detail-info">
              <div class="project-detail-title">${escapeHtml(p.name || 'Untitled project')}</div>
              <dl class="material-detail-list">${readOnlyDetailRowsBefore}${readOnlyDetailRowsAfter}</dl>
              ${readOnlyRequirementsHtml}
              ${allAttachments.length ? `
              <div class="material-detail-notes-label">Attachments (${allAttachments.length})</div>
              <div class="project-all-attachments mu-entry-extras" style="margin-top:0;">${muAttachmentChipsHtml(allAttachments, false)}</div>
              ` : ''}
            </div>
          </div>
        `;

        const detailRow = isExpanded ? `
          <tr class="proj-detail-row">
            <td colspan="${projectDetailColspan()}">
              ${isEditing ? `
              <div class="proj-edit-toolbar">
                <button class="btn btn-primary btn-sm" data-role="save-project">${icon('save')} Save</button>
                <button class="btn btn-sm proj-action-duplicate" data-role="duplicate-project">${icon('copy')} Duplicate</button>
                <button class="btn btn-sm proj-action-cancel" data-role="cancel-project">${icon('undo-2')} Cancel</button>
              </div>
              <div class="project-header-grid">
                <div class="field" style="margin-bottom:0;">
                  <label>Project Name</label>
                  <input type="text" class="proj-name" ${ro} value="${escapeHtml(p.name)}" placeholder="e.g. Sunrise Foods Q3 Launch">
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Photo (optional)</label>
                  ${isEditing ? `<input type="file" class="proj-image-input" accept="image/*">` : ''}
                  <div style="display:flex;align-items:center;gap:10px;margin-top:6px;">
                    <img class="proj-image-preview" src="${p.image ? escapeHtml(p.image) : ''}" style="${p.image ? '' : 'display:none;'}width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--border);">
                    ${isEditing ? `<button type="button" class="btn btn-sm proj-image-remove" style="${p.image ? '' : 'display:none;'}">Remove photo</button>` : ''}
                  </div>
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Status</label>
                  <select class="proj-select proj-status" ${isEditing ? '' : 'disabled'}>
                    ${PROJECT_STATUSES.map(s => `<option value="${escapeHtml(s)}" ${s === (p.status || PROJECT_STATUSES[0]) ? 'selected' : ''}>${escapeHtml(PROJECT_STATUS_LABELS[s])}</option>`).join('')}
                  </select>
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Request Date</label>
                  <input type="date" class="proj-request-date" ${ro} value="${escapeHtml(p.requestDate || '')}">
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Start Date</label>
                  <input type="date" class="proj-start-date" ${ro} value="${escapeHtml(p.startDate || '')}">
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Target / End Date</label>
                  <input type="date" class="proj-target-end-date" ${ro} value="${escapeHtml(p.targetEndDate || '')}">
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Customer Name</label>
                  <input type="text" class="proj-customer" list="customerDatalist" ${ro} value="${escapeHtml(p.customerName)}" placeholder="e.g. ABC Trading Co.">
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Destination Country</label>
                  <input type="text" class="proj-destination" list="destinationDatalist" ${ro} value="${escapeHtml(p.destinationCountry)}" placeholder="e.g. Japan">
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Project Owner</label>
                  <input type="text" class="proj-owner" list="salesRepDatalist" ${ro} value="${escapeHtml(p.ownerSalesRep)}" placeholder="e.g. Somchai">
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Factory Sales Rep</label>
                  <input type="text" class="proj-factory-rep" list="salesRepDatalist" ${ro} value="${escapeHtml(p.factorySalesRep)}" placeholder="e.g. Kenta-san">
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Responsible Person (PD)</label>
                  <input type="text" class="proj-responsible" list="responsiblePersonDatalist" ${ro} value="${escapeHtml(p.responsiblePerson)}" placeholder="e.g. Kanya">
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Factory</label>
                  <input type="text" class="proj-factory" list="customerDatalist" ${ro} value="${escapeHtml(p.factoryName)}" placeholder="e.g. Rayong Plant 2">
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Portion Weight</label>
                  <div class="combo-row">
                    <input type="number" class="proj-portion-qty" ${ro} value="${escapeHtml(p.portionWeightQty || '')}" placeholder="e.g. 20" step="any" min="0">
                    <input type="text" class="proj-portion-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.portionWeightUnit || 'g')}" placeholder="unit">
                    <span>/</span>
                    <input type="text" class="proj-portion-per-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.portionPerUnit || 'pcs')}" placeholder="per">
                  </div>
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Inner Packing</label>
                  <div class="combo-row">
                    <input type="number" class="proj-inner-qty" ${ro} value="${escapeHtml(p.innerPackQty || '')}" placeholder="e.g. 30" step="any" min="0">
                    <input type="text" class="proj-inner-weight-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.innerPackWeightUnit || 'g')}" placeholder="unit">
                    <span>/</span>
                    <input type="text" class="proj-inner-pack-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.innerPackUnit || 'pack')}" placeholder="pack unit">
                  </div>
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>Outer Packing</label>
                  <div class="combo-row">
                    <input type="number" class="proj-outer-qty" ${ro} value="${escapeHtml(p.outerPackQty || '')}" placeholder="e.g. 24" step="any" min="0">
                    <input type="text" class="proj-outer-pack-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.outerPackUnit || 'pack')}" placeholder="pack unit">
                    <span>/</span>
                    <input type="text" class="proj-outer-container-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.outerPackContainerUnit || 'carton')}" placeholder="container">
                  </div>
                </div>
                <div class="field" style="margin-bottom:0;">
                  <label>MOQ</label>
                  <div class="combo-row">
                    <input type="number" class="proj-moq-qty" ${ro} value="${escapeHtml(p.moqQty || '')}" placeholder="e.g. 500" step="any" min="0">
                    <input type="text" class="proj-moq-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.moqUnit || 'pcs')}" placeholder="unit">
                  </div>
                </div>
                <div class="field" style="margin-bottom:0;grid-column:1 / -1;">
                  <div class="requirements-box">
                    <div class="requirements-box-title">Requirements</div>
                    <div class="field" style="margin-bottom:8px;">
                      <label>Flavor / Filling</label>
                      <div class="flavor-table-scroll">
                      <table class="flavor-table flavor-table-edit">
                        <thead><tr><th>Flavor</th><th>Target Price</th><th>Actual Price</th><th>Formula / Reference No.</th><th>Note</th><th>Currency</th><th>Per</th><th></th></tr></thead>
                        <tbody class="proj-flavors-tbody">${(p.flavors||[]).map(f => `
                          <tr data-flavor-id="${escapeHtml(f.id)}">
                            <td><input type="text" class="flavor-name" ${ro} value="${escapeHtml(f.name||'')}" placeholder="e.g. Red bean"></td>
                            <td><input type="number" class="flavor-target-price" ${ro} value="${escapeHtml(f.targetPrice||'')}" step="any" min="0"></td>
                            <td><input type="number" class="flavor-actual-price" ${ro} value="${escapeHtml(f.actualPrice||'')}" step="any" min="0"></td>
                            <td><input type="text" class="flavor-formula-ref" ${ro} value="${escapeHtml(f.formulaRefCode||'')}" placeholder="e.g. JPN01-25"></td>
                            <td><input type="text" class="flavor-note" ${ro} value="${escapeHtml(f.note||'')}" placeholder="Note"></td>
                            <td><select class="proj-select flavor-currency" ${isEditing ? '' : 'disabled'}>${CURRENCY_OPTIONS.map(c => `<option value="${c}" ${c === (f.priceCurrency || 'THB') ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
                            <td><input type="text" class="flavor-unit" list="unitsDatalist" ${ro} value="${escapeHtml(f.priceUnit || 'kg')}" placeholder="unit"></td>
                            <td>${isEditing ? `<button type="button" class="icon-btn" title="Delete this flavor" data-role="remove-flavor">${icon('x')}</button>` : ''}</td>
                          </tr>
                        `).join('')}</tbody>
                      </table>
                      </div>
                      ${isEditing ? `<button type="button" class="btn btn-sm add-row-btn" data-role="add-flavor">+ Add Flavor</button>` : ((p.flavors||[]).length ? '' : '<div class="overview-empty">No flavors yet</div>')}
                    </div>
                    <div class="field" style="margin-bottom:8px;">
                      <label>Composition</label>
                      <textarea class="proj-req-composition" ${ro} placeholder="e.g. Takoyaki: 20g x 4 pieces">${escapeHtml(req.composition)}</textarea>
                    </div>
                    <div class="field" style="margin-bottom:8px;">
                      <label>Recipe</label>
                      <textarea class="proj-req-recipe" ${ro} placeholder="Reference / attachment notes">${escapeHtml(req.recipe)}</textarea>
                    </div>
                    <div class="field requirements-box-divider-below" style="margin-bottom:8px;">
                      <label>Cooking Condition</label>
                      <input type="text" class="proj-req-cooking-method" list="cookingMethodDatalist" ${ro} value="${escapeHtml(isEditing ? cookingMethodEditing : req.cookingCondition.method)}" placeholder="e.g. Microwave">
                      <div style="margin-top:8px;">
                        ${trialStringListHtml(isEditing ? cookingStepsEditing : req.cookingCondition.steps, isEditing, 'proj-cooking-step-input', 'cooking-step', 'e.g. Reheat from frozen, 2-3 minutes')}
                      </div>
                    </div>
                    <div class="field" style="margin-bottom:8px;">
                      <label>Packaging condition</label>
                      <textarea class="proj-req-packaging" ${ro} placeholder="e.g. Microwaveable black plastic tray">${escapeHtml(req.packagingCondition)}</textarea>
                    </div>
                    <div class="field" style="margin-bottom:8px;">
                      <label>Note</label>
                      <textarea class="proj-req-note" ${ro} placeholder="Anything else not covered above">${escapeHtml(req.note)}</textarea>
                    </div>
                    <div class="field requirements-box-divider" style="margin-bottom:0;">
                      <label>Certificate</label>
                      <input type="text" class="proj-req-certificate" ${ro} value="${escapeHtml(req.certificate)}" placeholder="e.g. Halal certificate">
                    </div>
                  </div>
                </div>
              </div>
              ` : readOnlyDetailView}
              ${activity.length ? `<div class="reflist-item-meta" style="margin:10px 0;">${activity.join(' &nbsp;|&nbsp; ')}</div>` : ''}

              ${p.products.length ? `
              <table>
                <thead><tr><th>Product</th><th>Sales Rep</th><th>Stage</th><th>Last Update</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
              ` : `<div class="overview-empty">No products yet${isEditing ? ' — add one below' : ''}</div>`}

              ${isEditing ? `
              <div class="project-add-row" style="margin-top:12px;">
                <select class="proj-select add-product-select">
                  <option value="">${availableRecipes.length ? 'Select a recipe to add...' : 'All recipes already added'}</option>
                  ${availableRecipes.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(recipeDisplayLabel(r))}${fullCode(r) ? ' · ' + escapeHtml(fullCode(r)) : ''}</option>`).join('')}
                </select>
                <button class="btn btn-sm" data-role="add-product">+ Add Product</button>
              </div>
              ` : ''}

              <div class="field" style="margin-bottom:0;margin-top:16px;" id="activities-updates-${escapeHtml(p.id)}">
                <label>Activities Updates</label>
                <div class="mu-timeline proj-monthly-list">${monthlyUpdatesHtml}</div>
                ${isEditing ? (monthlyUpdateAddOpen ? `
                  <div class="proj-monthly-add">
                    <div class="mu-plan-box">
                      <div class="mu-plan-box-title">Plan</div>
                      <div class="field">
                        <label>When</label>
                        <div class="mu-when-group">
                          <input type="date" class="proj-mu-date" value="${escapeHtml(new Date().toISOString().slice(0,10))}">
                          <input type="time" class="proj-mu-time">
                        </div>
                      </div>
                      <div class="field">
                        <label>Who</label>
                        <input type="text" class="proj-mu-who" list="salesRepDatalist" placeholder="e.g. Yano-san">
                      </div>
                      <div class="field">
                        <label>What</label>
                        <div class="mu-field-with-translate" style="width:auto;">
                          <textarea class="proj-mu-plan" placeholder="What"></textarea>
                          <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                        </div>
                      </div>
                      <div class="field">
                        <label>Where</label>
                        <input type="text" class="proj-mu-where" list="customerDatalist" placeholder="e.g. UMIOS Office">
                        <select class="proj-select proj-mu-where-location" style="display:none;margin-top:6px;"></select>
                      </div>
                      <div class="field" style="margin-bottom:0;">
                        <label>How</label>
                        <div class="mu-field-with-translate" style="width:auto;">
                          <textarea class="proj-mu-how" placeholder="How"></textarea>
                          <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                        </div>
                      </div>
                    </div>
                    <div class="mu-plan-box">
                      <div class="mu-plan-box-title">Action Taken</div>
                      <div class="field">
                        <label>Action Taken</label>
                        <div class="mu-field-with-translate" style="width:auto;">
                          <textarea class="proj-mu-action" placeholder="Action Taken"></textarea>
                          <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                        </div>
                      </div>
                      <div class="field" style="margin-bottom:0;">
                        <label>Completed Date (optional)</label>
                        <input type="date" class="proj-mu-completed-date" title="Completed date — defaults to today once Action Taken is filled in, edit if it was actually finished on a different day">
                      </div>
                    </div>
                    <div class="mu-plan-box">
                      <div class="mu-plan-box-title">Next Action</div>
                      <div class="field">
                        <label>When</label>
                        <div class="mu-when-group">
                          <input type="date" class="proj-mu-nextaction-due" title="Next Action due date">
                          <input type="time" class="proj-mu-nextaction-time">
                        </div>
                      </div>
                      <div class="field">
                        <label>Who</label>
                        <input type="text" class="proj-mu-nextaction-who" list="salesRepDatalist" placeholder="e.g. Yano-san">
                      </div>
                      <div class="field">
                        <label>What</label>
                        <div class="mu-field-with-translate" style="width:auto;">
                          <textarea class="proj-mu-nextaction" placeholder="Next Action"></textarea>
                          <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                        </div>
                      </div>
                      <div class="field">
                        <label>Where</label>
                        <input type="text" class="proj-mu-nextaction-where" list="customerDatalist" placeholder="e.g. UMIOS Office">
                        <select class="proj-select proj-mu-nextaction-where-location" style="display:none;margin-top:6px;"></select>
                      </div>
                      <div class="field" style="margin-bottom:0;">
                        <label>How</label>
                        <div class="mu-field-with-translate" style="width:auto;">
                          <textarea class="proj-mu-nextaction-how" placeholder="How"></textarea>
                          <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                        </div>
                      </div>
                    </div>
                    <div class="field">
                      <label>Linked Recipe (optional)</label>
                      <select class="proj-select proj-mu-recipe">${muRecipeOptionsHtml('')}</select>
                    </div>
                    <div class="field">
                      <label>Attachments (optional)</label>
                      <div class="mu-attachments-editor">
                        <div class="mu-attachments-chiplist"></div>
                        <label class="btn btn-sm mu-attach-btn">${icon('paperclip', 14)} Attach file/photo<input type="file" class="mu-attach-input" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv" multiple style="display:none;"></label>
                      </div>
                    </div>
                    <label class="mu-autocreate-label"><input type="checkbox" class="proj-mu-autocreate"> Create as Plan automatically</label>
                    <div style="display:flex;gap:8px;">
                      <button class="btn btn-sm btn-primary" data-role="add-monthly-update">${icon('save')} Save</button>
                      <button class="btn btn-sm proj-action-cancel" data-role="cancel-add-monthly-update">${icon('undo-2')} Cancel</button>
                    </div>
                  </div>
                ` : `<button class="btn btn-sm" data-role="open-add-monthly-update">+ Add Update</button>`) : ''}
              </div>
            </td>
          </tr>
        ` : '';

        return `<tbody data-project-id="${escapeHtml(p.id)}">${summaryRow}${detailRow}</tbody>`;
      }).join('')}
    </table>
    </div>
    <div class="proj-scrollbar-proxy" id="projScrollbarProxy"><div id="projScrollbarProxyInner"></div></div>
  `;
  applyProjectColumnVisibility();

  // The table scrolls sideways within the page now (no bounded vertical
  // box), which means its own horizontal scrollbar sits at the bottom of
  // the (long) row list — not reachable without scrolling all the way down
  // first. This thin proxy bar stays pinned to the bottom of the viewport
  // while any part of the table is on screen, and its scroll position stays
  // in sync with the real table so dragging either one moves both.
  const tableScroll = container.querySelector('.proj-table-scroll');
  const scrollbarProxy = document.getElementById('projScrollbarProxy');
  const scrollbarProxyInner = document.getElementById('projScrollbarProxyInner');
  function syncProjScrollbarProxy(){
    const needsScroll = tableScroll.scrollWidth > tableScroll.clientWidth + 1;
    scrollbarProxy.style.display = needsScroll ? 'block' : 'none';
    scrollbarProxyInner.style.width = tableScroll.scrollWidth + 'px';
  }
  syncProjScrollbarProxy();
  // renderProjectsList() re-runs on every search/sort/edit, which would
  // otherwise stack up a new window resize listener each time — routing
  // through this single persistent listener (attached once, below) instead
  // just reassigns which sync function it calls.
  activeProjScrollbarProxySync = syncProjScrollbarProxy;
  tableScroll.addEventListener('scroll', () => { scrollbarProxy.scrollLeft = tableScroll.scrollLeft; });
  scrollbarProxy.addEventListener('scroll', () => { tableScroll.scrollLeft = scrollbarProxy.scrollLeft; });

  container.querySelectorAll('.proj-th-label').forEach(labelEl => {
    labelEl.addEventListener('click', () => {
      const key = labelEl.dataset.sortKey;
      if(projectSortKey === key){
        projectSortDir = projectSortDir === 'asc' ? 'desc' : 'asc';
      }else{
        projectSortKey = key;
        projectSortDir = 'asc';
      }
      renderProjectsList();
    });
  });

  // Excel-style per-column filter popovers — the "▾" button next to each
  // sortable header's label. Opening/closing is a pure DOM class toggle (no
  // re-render needed just to show/hide the popover); checking or
  // unchecking a value actually changes projectColumnFilters, which does
  // need a full renderProjectsList() to re-filter the rows — and since that
  // rebuilds the whole table, openProjectFilterMenuKey is what makes the
  // same popover reappear open afterward instead of the click silently
  // closing it.
  container.querySelectorAll('[data-filter-trigger]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key = btn.dataset.filterTrigger;
      openProjectFilterMenuKey = openProjectFilterMenuKey === key ? null : key;
      container.querySelectorAll('[data-filter-menu]').forEach(m => {
        m.classList.toggle('open', m.dataset.filterMenu === openProjectFilterMenuKey);
      });
    });
  });
  container.querySelectorAll('[data-filter-menu]').forEach(menu => {
    menu.addEventListener('click', e => e.stopPropagation());
    const key = menu.dataset.filterMenu;
    const accessor = PROJECT_FILTER_ACCESSORS[key];
    const allValues = Array.from(new Set(projects.map(accessor)));
    const selectAllCb = menu.querySelector('.filter-select-all');
    selectAllCb.addEventListener('change', () => {
      if(selectAllCb.checked) delete projectColumnFilters[key];
      else projectColumnFilters[key] = new Set();
      renderProjectsList();
    });
    menu.querySelectorAll('.filter-value-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const current = new Set(projectColumnFilters[key] || allValues);
        if(cb.checked) current.add(cb.value); else current.delete(cb.value);
        if(current.size === allValues.length) delete projectColumnFilters[key];
        else projectColumnFilters[key] = current;
        renderProjectsList();
      });
    });
    menu.querySelector('[data-clear-filter]')?.addEventListener('click', () => {
      delete projectColumnFilters[key];
      renderProjectsList();
    });
  });
  if(openProjectFilterMenuKey){
    container.querySelector(`[data-filter-menu="${CSS.escape(openProjectFilterMenuKey)}"]`)?.classList.add('open');
  }

  container.querySelectorAll('tbody[data-project-id]').forEach(block => {
    const id = block.dataset.projectId;
    const p = projects.find(x => x.id === id);
    if(!p) return;
    const isEditing = id === projectEditingId;
    const isExpanded = isEditing || projectExpandedIds.has(id);

    block.querySelector('.part-toggle-btn').addEventListener('click', () => {
      if(projectExpandedIds.has(id)) projectExpandedIds.delete(id);
      else projectExpandedIds.add(id);
      renderProjectsList();
    });

    // Prints the whole expanded project detail (fields, Requirements,
    // Flavor/Filling table, Products, Activities Updates) as a one-off
    // read-only page -- expands the row first if it wasn't already, then
    // scopes @media print (see style.css) to just this project's tbody via
    // the .printing-project marker, cleaning both up once printing ends.
    block.querySelector('[data-role="print-project"]')?.addEventListener('click', () => {
      projectExpandedIds.add(id);
      renderProjectsList();
      requestAnimationFrame(() => {
        const printTarget = document.querySelector(`#projectsList tbody[data-project-id="${id}"]`);
        if(!printTarget) return;
        printTarget.classList.add('printing-project');
        const originalTitle = document.title;
        document.title = `Project ${p.name || 'Untitled project'} Forge`.replace(/[\\/:*?"<>|]/g, '-');
        const cleanup = () => {
          printTarget.classList.remove('printing-project');
          document.title = originalTitle;
          window.removeEventListener('afterprint', cleanup);
        };
        window.addEventListener('afterprint', cleanup);
        window.print();
      });
    });

    if(isEditing){
      editingProjectImage = p.image || '';
      const projImageInput = block.querySelector('.proj-image-input');
      const projImagePreview = block.querySelector('.proj-image-preview');
      const projImageRemoveBtn = block.querySelector('.proj-image-remove');
      projImageInput?.addEventListener('change', async e => {
        const file = e.target.files[0];
        if(!file) return;
        try{
          editingProjectImage = await resizeImageFile(file, 400);
          projImagePreview.src = editingProjectImage;
          projImagePreview.style.display = 'block';
          projImageRemoveBtn.style.display = 'inline-flex';
        }catch(err){
          alert(err.message || 'Could not read that image file');
        }
      });
      projImageRemoveBtn?.addEventListener('click', () => {
        editingProjectImage = '';
        projImageInput.value = '';
        projImagePreview.src = '';
        projImagePreview.style.display = 'none';
        projImageRemoveBtn.style.display = 'none';
      });

      // Customers can carry a Country in Reference Lists (see addNewEntry /
      // saveEdit in renderRefListItems) — picking a customer that has one
      // on file saves re-typing the same destination on every project.
      block.querySelector('.proj-customer').addEventListener('change', e => {
        const match = metaLists.customers.find(c => metaItemName(c) === e.target.value.trim());
        if(match && match.country){
          block.querySelector('.proj-destination').value = match.country;
        }
      });

      // Picking a Cooking Method that has Steps on file (see Reference
      // Lists) pulls them in as a starting point -- still a plain editable
      // step list afterward, not locked to whatever the reference list
      // says (see the add/remove/edit wiring below).
      block.querySelector('.proj-req-cooking-method').addEventListener('change', e => {
        cookingMethodEditing = e.target.value.trim();
        const match = metaLists.cookingMethods.find(m => metaItemName(m) === cookingMethodEditing);
        if(match && (match.steps || []).length){
          cookingStepsEditing = [...match.steps];
        }
        renderProjectsList();
      });
      block.querySelector('[data-role="add-cooking-step"]')?.addEventListener('click', () => {
        cookingStepsEditing.push('');
        renderProjectsList();
      });
      block.querySelectorAll('[data-role="remove-cooking-step"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.idx, 10);
          cookingStepsEditing.splice(idx, 1);
          renderProjectsList();
        });
      });
      block.querySelectorAll('.proj-cooking-step-input').forEach((inp, idx) => {
        inp.addEventListener('change', () => { cookingStepsEditing[idx] = inp.value.trim(); });
      });

      block.querySelector('[data-role="save-project"]').addEventListener('click', () => {
        p.name = block.querySelector('.proj-name').value.trim();
        p.image = editingProjectImage;
        p.status = block.querySelector('.proj-status').value;
        p.requestDate = block.querySelector('.proj-request-date').value;
        p.startDate = block.querySelector('.proj-start-date').value;
        p.targetEndDate = block.querySelector('.proj-target-end-date').value;
        p.customerName = block.querySelector('.proj-customer').value.trim();
        p.destinationCountry = block.querySelector('.proj-destination').value.trim();
        p.ownerSalesRep = block.querySelector('.proj-owner').value.trim();
        p.factorySalesRep = block.querySelector('.proj-factory-rep').value.trim();
        p.responsiblePerson = block.querySelector('.proj-responsible').value.trim();
        p.factoryName = block.querySelector('.proj-factory').value.trim();
        p.portionWeightQty = block.querySelector('.proj-portion-qty').value.trim();
        p.portionWeightUnit = block.querySelector('.proj-portion-unit').value.trim();
        p.portionPerUnit = block.querySelector('.proj-portion-per-unit').value.trim();
        p.innerPackQty = block.querySelector('.proj-inner-qty').value.trim();
        p.innerPackWeightUnit = block.querySelector('.proj-inner-weight-unit').value.trim();
        p.innerPackUnit = block.querySelector('.proj-inner-pack-unit').value.trim();
        p.outerPackQty = block.querySelector('.proj-outer-qty').value.trim();
        p.outerPackUnit = block.querySelector('.proj-outer-pack-unit').value.trim();
        p.outerPackContainerUnit = block.querySelector('.proj-outer-container-unit').value.trim();
        p.moqQty = block.querySelector('.proj-moq-qty').value.trim();
        p.moqUnit = block.querySelector('.proj-moq-unit').value.trim();
        p.requirements = {
          // No longer an editable field (the "Flavor / Filling" table below
          // already covers this) -- preserved as-is rather than dropped, in
          // case older data still has it set.
          flavorFilling: getRequirements(p).flavorFilling,
          composition: block.querySelector('.proj-req-composition').value.trim(),
          recipe: block.querySelector('.proj-req-recipe').value.trim(),
          packagingCondition: block.querySelector('.proj-req-packaging').value.trim(),
          cookingCondition: {
            method: block.querySelector('.proj-req-cooking-method').value.trim(),
            steps: [...block.querySelectorAll('.proj-cooking-step-input')].map(el => el.value.trim()).filter(Boolean)
          },
          certificate: block.querySelector('.proj-req-certificate').value.trim(),
          note: block.querySelector('.proj-req-note').value.trim()
        };
        // Also picks up a Monthly Update draft — otherwise clicking Save
        // (top-right, for the header fields) while text sits in the
        // date/results/next-plan boxes silently throws that text away,
        // since Save re-renders the row and only "+ Add Update" used to
        // actually commit it.
        const newMuFromSave = captureMonthlyUpdateDraft(p, block);
        projectEditingId = null;
        monthlyUpdateEditingId = null;
        monthlyUpdateAddOpen = false;
        cookingMethodEditing = '';
        cookingStepsEditing = [];
        projectExpandedIds.delete(p.id);
        scheduleProjectSave(p);
        logActivityEvent('updated', 'project', p.name || 'Untitled project', diffMainFields(projectEditSnapshotBefore, p, PROJECT_DIFF_FIELDS));
        if(newMuFromSave) logMuAddedEvent(p, newMuFromSave);
        projectEditSnapshotBefore = null;
        renderProjectsList();
      });
      block.querySelector('[data-role="duplicate-project"]').addEventListener('click', () => {
        const copy = duplicateProject(p);
        projects.push(copy);
        saveProjectToCloud(copy);
        logActivityEvent('created', 'project', copy.name || 'Untitled project');
        projectEditingId = copy.id;
        projectExpandedIds.add(copy.id);
        renderProjectsList();
      });
      block.querySelector('[data-role="cancel-project"]').addEventListener('click', () => {
        projectEditingId = null;
        monthlyUpdateEditingId = null;
        monthlyUpdateAddOpen = false;
        projectEditSnapshotBefore = null;
        cookingMethodEditing = '';
        cookingStepsEditing = [];
        projectExpandedIds.add(p.id);
        renderProjectsList();
      });

      block.querySelector('[data-role="open-add-monthly-update"]')?.addEventListener('click', () => {
        monthlyUpdateAddOpen = true;
        monthlyUpdateDraftAttachments = [];
        renderProjectsList();
      });
      block.querySelector('[data-role="cancel-add-monthly-update"]')?.addEventListener('click', () => {
        monthlyUpdateAddOpen = false;
        monthlyUpdateDraftAttachments = [];
        renderProjectsList();
      });
      // Whichever of the Add-Update panel or an Edit-entry popup is
      // currently open (only one at a time), wire up its Plan/Action
      // Taken/Next Action translate buttons and its attachment editor.
      block.querySelectorAll('.mu-field-with-translate').forEach(wireMuTranslateButton);
      const muAttachEditorEl = block.querySelector('.mu-attachments-editor');
      if(muAttachEditorEl) wireMuAttachmentEditor(muAttachEditorEl, () => monthlyUpdateDraftAttachments);
      wireWhereLocationPicker(
        block.querySelector('.proj-mu-where, .proj-mu-edit-where'),
        block.querySelector('.proj-mu-where-location, .proj-mu-edit-where-location')
      );
      wireWhereLocationPicker(
        block.querySelector('.proj-mu-nextaction-where, .proj-mu-edit-nextaction-where'),
        block.querySelector('.proj-mu-nextaction-where-location, .proj-mu-edit-nextaction-where-location')
      );
      block.querySelector('[data-role="add-monthly-update"]')?.addEventListener('click', () => {
        const newMu = captureMonthlyUpdateDraft(p, block);
        if(!newMu){
          alert('Please pick a date and fill in at least one of What / Action Taken / Next Action.');
          return;
        }
        monthlyUpdateAddOpen = false;
        scheduleProjectSave(p);
        logMuAddedEvent(p, newMu);
        renderProjectsList();
      });

      block.querySelectorAll('[data-role="delete-monthly-update"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const updateId = btn.closest('[data-update-id]').dataset.updateId;
          if(!confirm('Delete this activity update? This cannot be undone.')) return;
          p.monthlyUpdates = (p.monthlyUpdates || []).filter(mu => mu.id !== updateId);
          scheduleProjectSave(p);
          renderProjectsList();
        });
      });

      block.querySelectorAll('[data-role="edit-monthly-update"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const updateId = btn.closest('[data-update-id]').dataset.updateId;
          const mu = (p.monthlyUpdates || []).find(x => x.id === updateId);
          monthlyUpdateEditingId = updateId;
          monthlyUpdateDraftAttachments = mu ? (mu.attachments || []).map(a => ({...a})) : [];
          muEditSnapshotBefore = mu ? snapshotMainFields(mu, MU_DIFF_FIELDS) : null;
          renderProjectsList();
        });
      });

      block.querySelector('[data-role="save-monthly-update-edit"]')?.addEventListener('click', () => {
        const entry = block.querySelector('[data-update-id="' + CSS.escape(monthlyUpdateEditingId) + '"]');
        const mu = (p.monthlyUpdates || []).find(x => x.id === monthlyUpdateEditingId);
        if(!entry || !mu) return;
        const date = entry.querySelector('.proj-mu-edit-date').value;
        const time = entry.querySelector('.proj-mu-edit-time')?.value || '';
        const planWho = entry.querySelector('.proj-mu-edit-who')?.value.trim() || '';
        const plan = entry.querySelector('.proj-mu-edit-plan').value.trim();
        const planWhere = entry.querySelector('.proj-mu-edit-where')?.value.trim() || '';
        const planHow = entry.querySelector('.proj-mu-edit-how')?.value.trim() || '';
        const actionTaken = entry.querySelector('.proj-mu-edit-action').value.trim();
        const nextActionTime = entry.querySelector('.proj-mu-edit-nextaction-time')?.value || '';
        const nextActionWho = entry.querySelector('.proj-mu-edit-nextaction-who')?.value.trim() || '';
        const nextAction = entry.querySelector('.proj-mu-edit-nextaction').value.trim();
        const nextActionWhere = entry.querySelector('.proj-mu-edit-nextaction-where')?.value.trim() || '';
        const nextActionHow = entry.querySelector('.proj-mu-edit-nextaction-how')?.value.trim() || '';
        const nextActionDue = entry.querySelector('.proj-mu-edit-nextaction-due').value;
        const autoCreatePlan = !!entry.querySelector('.proj-mu-edit-autocreate')?.checked;
        const linkedRecipeId = entry.querySelector('.proj-mu-edit-recipe')?.value || '';
        const completedDate = resolveMuCompletedDate(actionTaken, entry.querySelector('.proj-mu-edit-completed-date')?.value || '', new Date().toISOString().slice(0, 10));
        if(!date || (!plan && !actionTaken && !nextAction)){
          alert('Please pick a date and fill in at least one of What / Action Taken / Next Action.');
          return;
        }
        mu.date = date;
        mu.time = time;
        mu.planWho = planWho;
        mu.plan = plan;
        mu.planWhere = planWhere;
        mu.planHow = planHow;
        mu.actionTaken = actionTaken;
        mu.nextActionTime = nextActionTime;
        mu.nextActionWho = nextActionWho;
        mu.nextAction = nextAction;
        mu.nextActionWhere = nextActionWhere;
        mu.nextActionHow = nextActionHow;
        mu.nextActionDue = nextActionDue;
        mu.autoCreatePlan = autoCreatePlan;
        mu.linkedRecipeId = linkedRecipeId;
        mu.attachments = monthlyUpdateDraftAttachments;
        mu.completedDate = completedDate;
        const muChanges = diffMainFields(muEditSnapshotBefore, mu, MU_DIFF_FIELDS);
        monthlyUpdateEditingId = null;
        monthlyUpdateDraftAttachments = [];
        muEditSnapshotBefore = null;
        maybeAutoCreateNextPlan(p, mu);
        scheduleProjectSave(p);
        logActivityEvent('updated', 'project', p.name || 'Untitled project', muChanges);
        renderProjectsList();
      });
      block.querySelector('[data-role="cancel-monthly-update-edit"]')?.addEventListener('click', () => {
        monthlyUpdateEditingId = null;
        monthlyUpdateDraftAttachments = [];
        muEditSnapshotBefore = null;
        renderProjectsList();
      });
    }else{
      block.querySelector('[data-role="edit-project"]').addEventListener('click', () => {
        projectEditingId = p.id;
        monthlyUpdateEditingId = null;
        monthlyUpdateAddOpen = false;
        projectEditSnapshotBefore = snapshotMainFields(p, PROJECT_DIFF_FIELDS);
        const cc = getRequirements(p).cookingCondition;
        cookingMethodEditing = cc.method;
        cookingStepsEditing = [...cc.steps];
        renderProjectsList();
      });
    }

    // Everything below only exists in the DOM when the detail row is
    // rendered (isExpanded) — unlike the old always-rendered-but-hidden
    // .part-body, the table's detail <tr> is only emitted at all when
    // expanded, so these queries would hit null while collapsed.
    if(isExpanded){
      block.querySelectorAll('tr[data-product-id]').forEach(row => {
        const prodId = row.dataset.productId;
        const prod = p.products.find(x => x.id === prodId);
        if(!prod) return;

        if(isEditing){
          row.querySelector('.proj-product-rep').addEventListener('change', e => { prod.salesRep = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.proj-product-stage').addEventListener('change', e => {
            addProductLogEntry(prod, e.target.value, '');
            scheduleProjectSave(p);
            renderProjectsList();
          });
          row.querySelector('[data-role="remove-product"]').addEventListener('click', () => {
            const r = recipes.find(x => x.id === prod.recipeId);
            if(!confirm(`Remove "${r ? recipeDisplayLabel(r) : 'this product'}" from the project? Its progress log will be lost.`)) return;
            p.products = p.products.filter(x => x.id !== prodId);
            scheduleProjectSave(p);
            renderProjectsList();
          });
        }
        row.querySelector('[data-role="open-log"]').addEventListener('click', () => openProductLogModal(p.id, prod.id));
      });

      if(isEditing){
        const addSelect = block.querySelector('.add-product-select');
        block.querySelector('[data-role="add-product"]').addEventListener('click', () => {
          const recipeId = addSelect.value;
          if(!recipeId) return;
          p.products.push(blankProduct(recipeId));
          scheduleProjectSave(p);
          renderProjectsList();
        });
      }

      if(isEditing){
        block.querySelectorAll('.proj-flavors-tbody tr[data-flavor-id]').forEach(row => {
          const flavorId = row.dataset.flavorId;
          const flavor = (p.flavors || []).find(x => x.id === flavorId);
          if(!flavor) return;
          row.querySelector('.flavor-name').addEventListener('change', e => { flavor.name = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.flavor-target-price').addEventListener('change', e => { flavor.targetPrice = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.flavor-actual-price').addEventListener('change', e => { flavor.actualPrice = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.flavor-formula-ref').addEventListener('change', e => { flavor.formulaRefCode = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.flavor-note').addEventListener('change', e => { flavor.note = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.flavor-currency').addEventListener('change', e => { flavor.priceCurrency = e.target.value; scheduleProjectSave(p); });
          row.querySelector('.flavor-unit').addEventListener('change', e => { flavor.priceUnit = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('[data-role="remove-flavor"]').addEventListener('click', () => {
            p.flavors = p.flavors.filter(x => x.id !== flavorId);
            scheduleProjectSave(p);
            renderProjectsList();
          });
        });
        block.querySelector('[data-role="add-flavor"]')?.addEventListener('click', () => {
          if(!Array.isArray(p.flavors)) p.flavors = [];
          p.flavors.push(blankFlavor());
          scheduleProjectSave(p);
          renderProjectsList();
        });
      }

      // Status badge and the PLAN / ACTION TAKEN / NEXT ACTION cards all
      // open the same update-popup — works whether or not the project
      // itself is currently in Edit mode, same as Progress Log's
      // "open-log" button above.
      block.querySelectorAll('.mu-status-badge, .mu-card-clickable').forEach(el => {
        el.addEventListener('click', () => {
          const updateId = el.closest('[data-update-id]')?.dataset.updateId;
          if(updateId) openMuEditModal(p.id, updateId, el.dataset.section || null);
        });
      });
      block.querySelectorAll('[data-role="open-mu-recipe"]').forEach(btn => {
        btn.addEventListener('click', () => openRecipeFromDashboard(btn.dataset.recipeId));
      });
      block.querySelectorAll('[data-update-id] .mu-entry-extras [data-role="open-mu-attachment-preview"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const updateId = btn.closest('[data-update-id]')?.dataset.updateId;
          const mu = migrateMonthlyUpdate((p.monthlyUpdates || []).find(x => x.id === updateId) || {});
          const idx = mu.attachments.findIndex(a => a.id === btn.dataset.attachmentId);
          if(idx !== -1) openMuAttachmentPreview(mu.attachments, idx);
        });
      });
      // Same preview popup from the project summary's consolidated
      // "Attachments" section — cycles through every attachment on the
      // project (all updates combined), not just one entry's.
      block.querySelectorAll('.project-all-attachments [data-role="open-mu-attachment-preview"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const all = allProjectAttachments(p);
          const idx = all.findIndex(a => a.id === btn.dataset.attachmentId);
          if(idx !== -1) openMuAttachmentPreview(all, idx);
        });
      });
    }

    block.querySelector('[data-role="delete-project"]')?.addEventListener('click', () => {
      if(!confirm(`Delete project "${p.name || 'Untitled project'}"? This removes all its products and progress logs. This cannot be undone.`)) return;
      requestAuthConfirm(
        'Confirm Identity to Delete',
        `Enter your password to delete "${p.name || 'Untitled project'}".`,
        () => {
          projects = projects.filter(x => x.id !== p.id);
          deleteProjectFromCloud(p.id);
          logActivityEvent('deleted', 'project', p.name || 'Untitled project');
          renderProjectsList();
        }
      );
    });
  });
}

/* ---------- Product progress log modal ---------- */
let productLogContext = null; // { projectId, productId }

function getProductLogTarget(){
  if(!productLogContext) return null;
  const p = projects.find(x => x.id === productLogContext.projectId);
  if(!p) return null;
  return p.products.find(x => x.id === productLogContext.productId) || null;
}

function openProductLogModal(projectId, productId){
  productLogContext = { projectId, productId };
  const select = document.getElementById('productLogStageSelect');
  select.innerHTML = PROJECT_STAGES.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  const product = getProductLogTarget();
  if(product) select.value = product.stage;
  document.getElementById('productLogNoteInput').value = '';
  renderProductLog();
  document.getElementById('productLogModalOverlay').classList.add('open');
}
function closeProductLogModal(){
  document.getElementById('productLogModalOverlay').classList.remove('open');
  productLogContext = null;
}
function renderProductLog(){
  const listEl = document.getElementById('productLogList');
  const product = getProductLogTarget();
  if(!listEl) return;
  if(!product){ listEl.innerHTML = ''; return; }
  const sorted = [...product.log].sort((a,b) => b.date - a.date);
  listEl.innerHTML = sorted.map(entry => `
    <div class="project-log-entry">
      <div class="project-log-stage">${escapeHtml(entry.stage)}</div>
      <div class="project-log-date">${escapeHtml(formatActivityDateTime(entry.date) || '')}${entry.by ? ' · ' + escapeHtml(entry.by) : ''}</div>
      ${entry.note ? `<div class="project-log-note">${escapeHtml(entry.note)}</div>` : ''}
    </div>
  `).join('');
}

let muEditModalContext = null; // { projectId, updateId }

// Clicking a timeline entry's status badge (Overdue / Due Today / etc.)
// opens this directly — a faster way to update or close out that specific
// item than expanding the whole project into edit mode first. Works
// independently of the project's own isEditing state, same as the Progress
// Log popup does for products.
function getMuEditModalTarget(){
  if(!muEditModalContext) return null;
  const p = projects.find(x => x.id === muEditModalContext.projectId);
  if(!p) return null;
  const mu = (p.monthlyUpdates || []).find(x => x.id === muEditModalContext.updateId);
  return mu ? { p, mu } : null;
}
function openMuEditModal(projectId, updateId, section){
  muEditModalContext = { projectId, updateId };
  const target = getMuEditModalTarget();
  if(!target) return;
  const mu = migrateMonthlyUpdate(target.mu);
  document.getElementById('muEditModalDate').value = mu.date || '';
  document.getElementById('muEditModalTime').value = mu.time || '';
  document.getElementById('muEditModalWho').value = mu.planWho || '';
  document.getElementById('muEditModalPlan').value = mu.plan || '';
  document.getElementById('muEditModalWhere').value = mu.planWhere || '';
  // Setting .value in JS doesn't fire 'input' on its own — dispatch it so
  // wireWhereLocationPicker's listener re-evaluates against this entry's
  // Where value instead of whatever the previously-open entry left behind.
  document.getElementById('muEditModalWhere').dispatchEvent(new Event('input'));
  document.getElementById('muEditModalHow').value = mu.planHow || '';
  document.getElementById('muEditModalAction').value = mu.actionTaken || '';
  document.getElementById('muEditModalNextActionDue').value = mu.nextActionDue || '';
  document.getElementById('muEditModalNextActionTime').value = mu.nextActionTime || '';
  document.getElementById('muEditModalNextActionWho').value = mu.nextActionWho || '';
  document.getElementById('muEditModalNextAction').value = mu.nextAction || '';
  document.getElementById('muEditModalNextActionWhere').value = mu.nextActionWhere || '';
  document.getElementById('muEditModalNextActionWhere').dispatchEvent(new Event('input'));
  document.getElementById('muEditModalNextActionHow').value = mu.nextActionHow || '';
  document.getElementById('muEditModalCompletedDate').value = mu.completedDate || '';
  document.getElementById('muEditModalAutoCreate').checked = !!mu.autoCreatePlan;
  document.getElementById('muEditModalRecipe').innerHTML = muRecipeOptionsHtml(mu.linkedRecipeId);
  muEditModalAttachments = (mu.attachments || []).map(a => ({...a}));
  redrawMuEditModalAttachments();
  muEditSnapshotBefore = snapshotMainFields(mu, MU_DIFF_FIELDS);
  document.getElementById('muEditModalOverlay').classList.add('open');
  // Jump straight to the box the user actually clicked (Plan / Action
  // Taken / Next Action) instead of always landing at the top — the
  // modal can otherwise be a long scroll past sections they don't need.
  if(section){
    requestAnimationFrame(() => {
      document.querySelector(`#muEditModalOverlay [data-mu-box="${section}"]`)?.scrollIntoView({ block: 'start' });
    });
  }
}
function redrawMuEditModalAttachments(){
  const chipList = document.getElementById('muEditModalAttachChips');
  chipList.innerHTML = muAttachmentChipsHtml(muEditModalAttachments, true);
  chipList.querySelectorAll('[data-role="remove-mu-attachment"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = muEditModalAttachments.findIndex(a => a.id === btn.dataset.attachmentId);
      if(idx !== -1) muEditModalAttachments.splice(idx, 1);
      redrawMuEditModalAttachments();
    });
  });
  chipList.querySelectorAll('[data-role="open-mu-attachment-preview"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = muEditModalAttachments.findIndex(a => a.id === btn.dataset.attachmentId);
      if(idx !== -1) openMuAttachmentPreview(muEditModalAttachments, idx);
    });
  });
}
function closeMuEditModal(){
  document.getElementById('muEditModalOverlay').classList.remove('open');
  muEditModalContext = null;
  muEditModalAttachments = [];
  muEditSnapshotBefore = null;
}
function saveMuEditModal(){
  const target = getMuEditModalTarget();
  if(!target) return;
  const date = document.getElementById('muEditModalDate').value;
  const time = document.getElementById('muEditModalTime').value;
  const planWho = document.getElementById('muEditModalWho').value.trim();
  const plan = document.getElementById('muEditModalPlan').value.trim();
  const planWhere = document.getElementById('muEditModalWhere').value.trim();
  const planHow = document.getElementById('muEditModalHow').value.trim();
  const actionTaken = document.getElementById('muEditModalAction').value.trim();
  const nextActionTime = document.getElementById('muEditModalNextActionTime').value;
  const nextActionWho = document.getElementById('muEditModalNextActionWho').value.trim();
  const nextAction = document.getElementById('muEditModalNextAction').value.trim();
  const nextActionWhere = document.getElementById('muEditModalNextActionWhere').value.trim();
  const nextActionHow = document.getElementById('muEditModalNextActionHow').value.trim();
  const nextActionDue = document.getElementById('muEditModalNextActionDue').value;
  const autoCreatePlan = document.getElementById('muEditModalAutoCreate').checked;
  const linkedRecipeId = document.getElementById('muEditModalRecipe').value;
  const completedDate = resolveMuCompletedDate(actionTaken, document.getElementById('muEditModalCompletedDate').value, new Date().toISOString().slice(0, 10));
  if(!date || (!plan && !actionTaken && !nextAction)){
    alert('Please pick a date and fill in at least one of What / Action Taken / Next Action.');
    return;
  }
  const { p, mu } = target;
  mu.date = date;
  mu.time = time;
  mu.planWho = planWho;
  mu.plan = plan;
  mu.planWhere = planWhere;
  mu.planHow = planHow;
  mu.actionTaken = actionTaken;
  mu.nextActionTime = nextActionTime;
  mu.nextActionWho = nextActionWho;
  mu.nextAction = nextAction;
  mu.nextActionWhere = nextActionWhere;
  mu.nextActionHow = nextActionHow;
  mu.nextActionDue = nextActionDue;
  mu.autoCreatePlan = autoCreatePlan;
  mu.linkedRecipeId = linkedRecipeId;
  mu.attachments = muEditModalAttachments;
  mu.completedDate = completedDate;
  const muChanges = diffMainFields(muEditSnapshotBefore, mu, MU_DIFF_FIELDS);
  maybeAutoCreateNextPlan(p, mu);
  scheduleProjectSave(p);
  logActivityEvent('updated', 'project', p.name || 'Untitled project', muChanges);
  muEditModalAttachments = [];
  closeMuEditModal();
  renderProjectsList();
}

// One-time wiring for the sidebar entry point plus the persistent nested
// "product progress log" popup (stays a real modal, per the decision to
// keep small utility dialogs as popups).
export function initProjectsModal(){
  document.getElementById('btnOpenProjects').addEventListener('click', () => guardNavigation(() => {
    setMainFeatureView('projects');
    renderMain();
    renderSidebar();
  }));

  document.getElementById('btnCloseProductLogModal').addEventListener('click', closeProductLogModal);
  document.getElementById('productLogModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'productLogModalOverlay') closeProductLogModal();
  });
  document.getElementById('btnAddProductLogEntry').addEventListener('click', () => {
    const product = getProductLogTarget();
    if(!product) return;
    const stage = document.getElementById('productLogStageSelect').value;
    const note = document.getElementById('productLogNoteInput').value;
    addProductLogEntry(product, stage, note);
    scheduleProjectSave(projects.find(x => x.id === productLogContext.projectId));
    document.getElementById('productLogNoteInput').value = '';
    renderProductLog();
    renderProjectsList();
  });

  document.getElementById('btnCloseMuEditModal').addEventListener('click', closeMuEditModal);
  document.getElementById('btnCancelMuEditModal').addEventListener('click', closeMuEditModal);
  document.getElementById('muEditModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'muEditModalOverlay') closeMuEditModal();
  });
  document.getElementById('btnSaveMuEditModal').addEventListener('click', saveMuEditModal);
  document.querySelectorAll('#muEditModalOverlay .mu-field-with-translate').forEach(wireMuTranslateButton);
  wireWhereLocationPicker(document.getElementById('muEditModalWhere'), document.getElementById('muEditModalWhereLocation'));
  wireWhereLocationPicker(document.getElementById('muEditModalNextActionWhere'), document.getElementById('muEditModalNextActionWhereLocation'));
  document.getElementById('muEditModalAttachInput').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for(const file of files){
      try{
        muEditModalAttachments.push(await fileToMuAttachment(file));
      }catch(err){
        alert(err.message || 'Could not attach that file.');
      }
    }
    redrawMuEditModalAttachments();
  });
}

/* ---------- Projects: cross-recipe production tracking (shared via Firestore) ---------- */
export let projects = [];

export function attachProjectsListener(){
  unsubscribeProjects = onSnapshot(projectsCol, snapshot => {
    projects = snapshot.docs.map(d => d.data());
    projects.forEach(p => {
      if(!Array.isArray(p.products)) p.products = [];
      p.products.forEach(prod => { if(!Array.isArray(prod.log)) prod.log = []; });
      if(p.image === undefined) p.image = '';
      if(p.startDate === undefined) p.startDate = '';
      if(p.targetEndDate === undefined) p.targetEndDate = '';
    });
    projectsLoaded = true;
    if(mainFeatureView === 'projects') renderProjectsList();
    if(document.getElementById('productLogModalOverlay').classList.contains('open')) renderProductLog();
    if(!currentId && !mainFeatureView && recipesLoaded) renderMain();
  }, err => {
    console.error('Forge: projects listener error', err);
    showCloudError('Failed to load projects from Firebase: ' + err.message);
  });
}

const PROJECT_DIFF_FIELDS = {
  name: 'Project Name', status: 'Status', requestDate: 'Request Date', startDate: 'Start Date', targetEndDate: 'Target / End Date',
  customerName: 'Customer Name', destinationCountry: 'Destination Country', ownerSalesRep: 'Project Owner', factorySalesRep: 'Factory Sales Rep',
  responsiblePerson: 'Responsible Person (PD)', factoryName: 'Factory',
  portionWeightQty: 'Portion Weight Qty', portionWeightUnit: 'Portion Weight Unit', portionPerUnit: 'Portion Per Unit',
  innerPackQty: 'Inner Pack Qty', innerPackWeightUnit: 'Inner Pack Weight Unit', innerPackUnit: 'Inner Pack Unit',
  outerPackQty: 'Outer Pack Qty', outerPackUnit: 'Outer Pack Unit', outerPackContainerUnit: 'Outer Pack Container',
  moqQty: 'MOQ Qty', moqUnit: 'MOQ Unit'
};

// An Activities Update entry's own main fields — linkedRecipeId/attachments
// are deliberately left out, same "main scalar fields only" rule as
// everywhere else (they're refs/arrays, not something a plain before/after
// string reads well for).
const MU_DIFF_FIELDS = {
  date: 'When (Date)', time: 'When (Time)', planWho: 'Who', plan: 'What', planWhere: 'Where', planHow: 'How',
  actionTaken: 'Action Taken', completedDate: 'Completed Date',
  nextActionDue: 'Next Action When (Date)', nextActionTime: 'Next Action When (Time)', nextActionWho: 'Next Action Who',
  nextAction: 'Next Action What', nextActionWhere: 'Next Action Where', nextActionHow: 'Next Action How'
};

// Auto-fills Completed Date with today the first time Action Taken gets
// filled in, but only if the field was left blank — never overwrites a
// date someone already typed (an entry logged today that was actually
// finished yesterday, say). Clears it back out if Action Taken is emptied
// again, so a reopened/undone task doesn't keep a stale completion date.
function resolveMuCompletedDate(actionTaken, completedDateInput, todayStr){
  if(!actionTaken.trim()) return '';
  return completedDateInput || todayStr;
}

let projectEditSnapshotBefore = null;
let muEditSnapshotBefore = null;

// A brand new Activities Update entry has no "before" state to diff against
// (see diffMainFields's null-before short-circuit), so it gets its own
// one-line "Added: ..." notification instead of a field-by-field diff.
function logMuAddedEvent(p, mu){
  logActivityEvent('updated', 'project', p.name || 'Untitled project', [{
    field: 'Activities Updates',
    before: '(no entry)',
    after: `Added: "${(mu.plan || mu.actionTaken || mu.nextAction || 'Untitled').trim()}" (${mu.date})`
  }]);
}

// Activities Updates attachments — same "no Firebase Storage, base64 in the
// Firestore document" approach as every photo elsewhere in Forge. Images go
// through the same resize/compress used for photos so they stay small;
// non-image files (PDF/Word/Excel) can't be resized, so they're capped
// instead — the whole project document (name, products, every update, every
// attachment) has to fit Firestore's 1MB document limit.
const MU_ATTACHMENT_MAX_BYTES = 300 * 1024;
const MU_ATTACHMENT_IMAGE_MAX_DIM = 640;
function readFileAsDataUrl(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}
async function fileToMuAttachment(file){
  const isImage = file.type.startsWith('image/');
  if(isImage){
    const dataUrl = await resizeImageFile(file, MU_ATTACHMENT_IMAGE_MAX_DIM);
    return { id: uid(), name: file.name, dataUrl, isImage: true };
  }
  if(file.size > MU_ATTACHMENT_MAX_BYTES){
    throw new Error(`"${file.name}" is too big (${Math.round(file.size/1024)}KB) — files must be under ${Math.round(MU_ATTACHMENT_MAX_BYTES/1024)}KB`);
  }
  const dataUrl = await readFileAsDataUrl(file);
  return { id: uid(), name: file.name, dataUrl, isImage: false };
}
// Shared by the popup modal, the inline add form, the inline edit form, and
// the read-only card — `editable` controls whether a remove (✕) button
// shows on each chip.
function muAttachmentChipsHtml(attachments, editable){
  if(!attachments || !attachments.length) return '';
  return attachments.map(a => `
    <span class="mu-attachment-chip" data-attachment-id="${escapeHtml(a.id)}">
      <button type="button" class="mu-attachment-name" data-role="open-mu-attachment-preview" data-attachment-id="${escapeHtml(a.id)}" title="Click to preview">
        ${a.isImage
          ? `<img src="${escapeHtml(a.dataUrl)}" class="mu-attachment-thumb" alt="${escapeHtml(a.name)}">`
          : `<span class="mu-attachment-file-icon">${icon('file-text', 12)}</span>`}
        <span class="mu-attachment-name-text">${escapeHtml(a.name)}</span>
      </button>
      ${editable ? `<button type="button" class="mu-attachment-remove" data-role="remove-mu-attachment" data-attachment-id="${escapeHtml(a.id)}" title="Remove">${icon('x', 10)}</button>` : ''}
    </span>
  `).join('');
}
// Every attachment across every Activities Update on a project, newest
// entry first — powers the project summary's consolidated "Attachments"
// section, so a file doesn't only turn up by scrolling through each
// individual update looking for it.
function allProjectAttachments(p){
  return [...(p.monthlyUpdates || [])]
    .sort((a,b) => (b.date||'').localeCompare(a.date||'') || (b.createdAt||0) - (a.createdAt||0))
    .flatMap(mu => migrateMonthlyUpdate(mu).attachments || []);
}
// A Where field's value matching a Company Directory entry that has its
// own Locations (see Company Directory's Locations feature) triggers a
// follow-up location picker right below it — selecting one appends
// "(Location)" onto the company name already typed, e.g. "UMIOS ASIA
// OCEANIA CO., LTD. (Office)". Re-recognizes an already-"Company
// (Location)" value on re-edit by stripping the trailing "(...)" before
// matching, so the picker still offers to change it, not just append a
// second one.
function wireWhereLocationPicker(whereInput, locationSelect){
  if(!whereInput || !locationSelect) return;
  const sync = () => {
    const raw = whereInput.value.trim();
    const companyName = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const company = companyName ? metaLists.customers.find(c => metaItemName(c) === companyName) : null;
    const locations = company?.locations || [];
    if(locations.length){
      locationSelect.innerHTML = `<option value="">- Select location -</option>${locations.map(loc => `<option value="${escapeHtml(loc)}">${escapeHtml(loc)}</option>`).join('')}`;
      locationSelect.style.display = '';
      locationSelect.dataset.companyName = companyName;
    }else{
      locationSelect.style.display = 'none';
      locationSelect.innerHTML = '';
    }
  };
  whereInput.addEventListener('input', sync);
  locationSelect.addEventListener('change', () => {
    const loc = locationSelect.value;
    const companyName = locationSelect.dataset.companyName || '';
    if(loc && companyName) whereInput.value = `${companyName} (${loc})`;
    locationSelect.style.display = 'none';
  });
  sync(); // covers the field already having a value when this wires (editing an existing entry)
}
function muRecipeOptionsHtml(selectedId){
  return `<option value="">No linked recipe</option>` +
    recipes.slice().sort((a,b) => (a.name||'').localeCompare(b.name||'')).map(r =>
      `<option value="${escapeHtml(r.id)}" ${r.id === selectedId ? 'selected' : ''}>${escapeHtml(recipeDisplayLabel(r))}${fullCode(r) ? ' · ' + escapeHtml(fullCode(r)) : ''}</option>`
    ).join('');
}
// Wires a file input + its sibling chip-list container so picking files
// stages them into `draftArrayGetter()`'s array and redraws just that
// container — never a full renderProjectsList(), which would wipe out
// whatever the user is mid-typing in the Plan/Action Taken/Next Action
// fields of the very same form.
function wireMuAttachmentEditor(container, draftArrayGetter, onChange){
  const input = container.querySelector('.mu-attach-input');
  const chipList = container.querySelector('.mu-attachments-chiplist');
  if(!input || !chipList) return;
  const redraw = () => {
    chipList.innerHTML = muAttachmentChipsHtml(draftArrayGetter(), true);
    chipList.querySelectorAll('[data-role="remove-mu-attachment"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const arr = draftArrayGetter();
        const idx = arr.findIndex(a => a.id === btn.dataset.attachmentId);
        if(idx !== -1) arr.splice(idx, 1);
        redraw();
      });
    });
    chipList.querySelectorAll('[data-role="open-mu-attachment-preview"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const arr = draftArrayGetter();
        const idx = arr.findIndex(a => a.id === btn.dataset.attachmentId);
        if(idx !== -1) openMuAttachmentPreview(arr, idx);
      });
    });
  };
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.value = '';
    for(const file of files){
      try{
        draftArrayGetter().push(await fileToMuAttachment(file));
      }catch(err){
        alert(err.message || 'Could not attach that file.');
      }
    }
    redraw();
    onChange?.();
  });
  redraw();
}

// Attachment Preview popup — a click on an attachment chip's name/thumbnail
// (editable draft, popup modal, or the read-only saved card) opens this
// instead of the browser just downloading the data URI straight away.
// Images render inline, PDFs render in an iframe (browsers can display
// those natively), anything else (Word/Excel/CSV) falls back to a plain
// Download button since there's no way to render those in a browser tab.
// Prev/Next cycles through every attachment on the same entry.
let muAttachmentPreviewContext = null; // { attachments, index }
function openMuAttachmentPreview(attachments, index){
  if(!attachments || !attachments.length) return;
  muAttachmentPreviewContext = { attachments, index: Math.max(0, Math.min(index, attachments.length - 1)) };
  renderMuAttachmentPreview();
  document.getElementById('muAttachmentPreviewModalOverlay').classList.add('open');
}
function closeMuAttachmentPreview(){
  document.getElementById('muAttachmentPreviewModalOverlay').classList.remove('open');
  muAttachmentPreviewContext = null;
}
function renderMuAttachmentPreview(){
  if(!muAttachmentPreviewContext) return;
  const { attachments, index } = muAttachmentPreviewContext;
  const a = attachments[index];
  document.getElementById('muAttachmentPreviewTitle').textContent = a.name;
  const body = document.getElementById('muAttachmentPreviewBody');
  const isPdf = a.dataUrl.startsWith('data:application/pdf');
  if(a.isImage){
    body.innerHTML = `<img src="${escapeHtml(a.dataUrl)}" alt="${escapeHtml(a.name)}" class="mu-attachment-preview-img">`;
  }else if(isPdf){
    body.innerHTML = `<iframe src="${escapeHtml(a.dataUrl)}" class="mu-attachment-preview-frame" title="${escapeHtml(a.name)}"></iframe>`;
  }else{
    body.innerHTML = `<div class="mu-attachment-preview-fallback">${icon('file-text', 40)}<p>This file type can't be previewed here — use Download to open it.</p></div>`;
  }
  document.getElementById('muAttachmentPreviewCounter').textContent = attachments.length > 1 ? `${index + 1} / ${attachments.length}` : '';
  document.getElementById('btnMuAttachmentPreviewPrev').style.visibility = attachments.length > 1 ? 'visible' : 'hidden';
  document.getElementById('btnMuAttachmentPreviewNext').style.visibility = attachments.length > 1 ? 'visible' : 'hidden';
  const downloadBtn = document.getElementById('btnMuAttachmentPreviewDownload');
  downloadBtn.href = a.dataUrl;
  downloadBtn.download = a.name;
}
function muAttachmentPreviewStep(delta){
  if(!muAttachmentPreviewContext) return;
  const { attachments } = muAttachmentPreviewContext;
  muAttachmentPreviewContext.index = (muAttachmentPreviewContext.index + delta + attachments.length) % attachments.length;
  renderMuAttachmentPreview();
}
export function initMuAttachmentPreviewModal(){
  document.getElementById('btnCloseMuAttachmentPreview').addEventListener('click', closeMuAttachmentPreview);
  document.getElementById('muAttachmentPreviewModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'muAttachmentPreviewModalOverlay') closeMuAttachmentPreview();
  });
  document.getElementById('btnMuAttachmentPreviewPrev').addEventListener('click', () => muAttachmentPreviewStep(-1));
  document.getElementById('btnMuAttachmentPreviewNext').addEventListener('click', () => muAttachmentPreviewStep(1));
}

// Same layout as renderBarList, but each bar is colored by its own status
// (via PROJECT_STATUS_BAR) instead of one flat color for every bar — so
// "Projects by Status" reads the same way the mini status bar under each
// project's name in the table already does. Every status with at least one
// project gets a strip of every one of its projects shown directly above
// its own bar (formerly a single combined gallery above this whole card —
// moved here so each status's projects sit with that status's own numbers)
// — a project with no photo yet still gets a plain placeholder circle
// rather than being left out of the strip entirely, so the strip's own
// count always matches the status's real project count.
// Both the bar/row and each individual photo are clickable — see
// wireProjectsByStatusCardClicks, wired once after this HTML is inserted
// into the dashboard.
function renderStatusBarList(groups){
  if(!groups.length) return '<div class="dash-empty">No data yet</div>';
  const max = Math.max(...groups.map(g => g.count));
  return groups.map(g => {
    const color = (PROJECT_STATUS_BAR[g.label] || PROJECT_STATUS_BAR['Not Started']).color;
    const projectsForStatus = projects.filter(p => (p.status || PROJECT_STATUSES[0]) === g.label);
    const photosHtml = projectsForStatus.length ? `
      <div class="proj-gallery-grid" style="margin-bottom:6px;">
        ${projectsForStatus.map(p => `
          <button type="button" class="proj-gallery-item" data-gallery-project-id="${escapeHtml(p.id)}" title="${escapeHtml(p.name || 'Untitled project')}">
            ${p.image
              ? `<img class="proj-gallery-thumb" src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name || 'Project photo')}" style="border-color:${projectPhotoStatusColor(p.status)};box-shadow:0 0 10px ${projectPhotoStatusColor(p.status)};${g.label === 'Cancelled' ? 'filter:grayscale(100%);' : ''}">`
              : `<span class="proj-gallery-thumb proj-gallery-thumb-empty" style="border-color:${projectPhotoStatusColor(p.status)};box-shadow:0 0 10px ${projectPhotoStatusColor(p.status)};${g.label === 'Cancelled' ? 'filter:grayscale(100%);' : ''}">${icon('folder', 22)}</span>`}
            <span class="proj-gallery-name">${escapeHtml(p.name || 'Untitled project')}</span>
          </button>
        `).join('')}
      </div>
    ` : '';
    return `
      <div class="dash-status-group">
        ${photosHtml}
        <button type="button" class="dash-bar-item dash-bar-item-clickable" data-status-filter="${escapeHtml(g.label)}" title="Filter the projects table to ${escapeHtml(g.label)}">
          <div class="dash-bar-label-row"><span>${escapeHtml(g.label)}</span><span class="dbl-count">${g.count}</span></div>
          <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${Math.max(4, Math.round(g.count/max*100))}%;background:${color};"></div></div>
        </button>
      </div>
    `;
  }).join('');
}


let unsubscribeProjects = null;
let projectsLoaded = false;

// Tears down the projects Firestore listener and resets its load-state to
// empty — called from the shared sign-out handler in app.js, kept here so
// that handler doesn't need write access to bindings this module owns
// (same pattern as resetMaterialsState/resetTrialsState/resetRefListsState).
// Only resets load-state, not UI-transient editing state (projectEditingId,
// projectColumnFilters, etc.) — same convention the other three follow.
export function resetProjectsState(){
  if(unsubscribeProjects){ unsubscribeProjects(); unsubscribeProjects = null; }
  projectsLoaded = false;
  projects = [];
}

// Small exported setters for the two places app.js's own Dashboard code
// needs to change Projects-owned state from outside this module (a plain
// `projectColumnFilters = ...`/`openProjectFilterMenuKey = ...` assignment
// from app.js isn't possible — ES modules can't reassign a sibling
// module's `let` binding from outside it).
export function setProjectStatusFilter(status){
  projectColumnFilters = { status: new Set([status]) };
}
export function closeProjectFilterMenu(){
  openProjectFilterMenuKey = null;
}

export { projectExpandedIds, unsubscribeProjects, openProjectFilterMenuKey, activeProjScrollbarProxySync };
