// Pure data/model helpers for Projects -- status/task math, blank-record
// builders, and Firestore save/delete -- no DOM rendering. Split out of
// projects.js -- see projects.js's own top-of-file comment for the
// overall file split.
import { escapeHtml, currentUser, uid, projectsCol, PROJECT_STAGES } from './app.js';
import { setDoc, doc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { blankRequirements } from './projects-requirements.js';


// since ¥ alone is ambiguous between JPY and CNY. Unlike the physical
// packaging/weight/MOQ units above (now the user-editable Units reference
// list — see metaLists.units / unitsDatalist), currency is a closed,
// small set that doesn't make sense to let grow arbitrarily, so it stays
// a plain <select>.
export const CURRENCY_OPTIONS = ['THB','JPY','USD','CNY','EUR'];

// Overall project lifecycle status (distinct from PROJECT_STAGES, which
// tracks each individual product's stage within a project).
export const PROJECT_STATUSES = ['Not Started','In Progress','Blocked / On Hold','In Review','Completed','Cancelled'];
export const PROJECT_STATUS_LABELS = {
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
export const PROJECT_STATUS_BAR = {
  'Not Started': { pct: 0, color: 'var(--border)' },
  'In Progress': { pct: 40, color: 'var(--accent)' },
  'Blocked / On Hold': { pct: 40, color: 'var(--danger)' },
  'In Review': { pct: 75, color: 'var(--primary)' },
  'Completed': { pct: 100, color: 'var(--ok)' },
  'Cancelled': { pct: 100, color: 'var(--text-dim)' }
};
export function projectStatusBarHtml(status){
  const s = status || PROJECT_STATUSES[0];
  const cfg = PROJECT_STATUS_BAR[s] || PROJECT_STATUS_BAR['Not Started'];
  return `<div class="proj-status-bar-track" title="${escapeHtml(s)}"><div class="proj-status-bar-fill" style="width:${cfg.pct}%;background:${cfg.color};"></div></div>`;
}

// Pill colors are separate from PROJECT_STATUS_BAR's progress-bar colors —
// a bar fill can just be var(--accent) etc., but a pill needs a light
// background + readable text + border all at once, which CSS custom
// properties can't derive from a single color value via string concatenation
// (var(...) isn't a hex string), so each status gets its own explicit triple.
export const PROJECT_STATUS_PILL = {
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
export function projectPhotoStatusColor(status){
  const s = status || PROJECT_STATUSES[0];
  if(s === 'Cancelled') return 'var(--text-dim)';
  return (PROJECT_STATUS_PILL[s] || PROJECT_STATUS_PILL['Not Started']).border;
}

// Only stages that represent forward progress toward a finished product —
// On Hold/Cancelled products don't have a meaningful position on this scale,
// so they're excluded from the average rather than distorting it.
export const STAGE_PROGRESS_ORDER = ['Requested','Formulating','Sampling','Customer Review','Approved','In Production'];
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
    planWith: mu.planWith || '',
    planOwner: mu.planOwner || '',
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
    nextActionWith: mu.nextActionWith || '',
    nextActionOwner: mu.nextActionOwner || '',
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
export const TASK_STATUS_META = {
  overdue: { icon: '⚠', label: (mu, todayStr) => { const d = daysBetween(mu.date, todayStr); return `Overdue ${d} day${d === 1 ? '' : 's'}`; } },
  today: { icon: '◷', label: () => 'Due Today' },
  completed: { icon: '✓', label: () => 'Completed' },
  upcoming: { icon: '→', label: () => 'Upcoming' },
  nodate: { icon: '–', label: () => 'No Due Date' }
};

export function blankProject(){
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
    quotationAttachment: null,
    specAttachment: null,
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
export function blankFlavor(){
  return { id: uid(), name: "", sampleQty: "", sampleQtyUnit: "", sampleRequestDate: "", targetPrice: "", actualPrice: "", priceCurrency: "THB", priceUnit: "kg", formulaRefCode: "", note: "" };
}

// A datalist-backed <input> only shows suggestions matching the CURRENT
// text (e.g. "kg" won't suggest while "pcs" is still typed) -- selecting
// the existing value on focus means one click already has it highlighted,
// so opening the dropdown and picking a different unit just types over it
// instead of needing to delete first.
export function selectTextOnFocus(el){
  if(el) el.addEventListener('focus', () => el.select());
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
// None of these fall back to a guessed unit (g/pcs/pack/carton) when one
// hasn't actually been entered -- a blank unit just doesn't appear, rather
// than silently implying a value nobody chose.
export function formatPortionWeight(p){
  if(!p.portionWeightQty) return '-';
  const qty = [p.portionWeightQty, p.portionWeightUnit].filter(Boolean).join(' ');
  return p.portionPerUnit ? `${qty} / ${p.portionPerUnit}` : qty;
}
export function formatInnerPacking(p){
  if(!p.innerPackQty) return '-';
  const qty = [p.innerPackQty, p.innerPackWeightUnit].filter(Boolean).join(' ');
  return p.innerPackUnit ? `${qty} / ${p.innerPackUnit}` : qty;
}
export function formatOuterPacking(p){
  if(!p.outerPackQty) return '-';
  const qty = [p.outerPackQty, p.outerPackUnit].filter(Boolean).join(' ');
  return p.outerPackContainerUnit ? `${qty} / ${p.outerPackContainerUnit}` : qty;
}
export function formatProjectMoq(p){
  if(!p.moqQty) return '-';
  return [p.moqQty, p.moqUnit].filter(Boolean).join(' ');
}

// Copies the template-like fields (name, photo, customer/destination/owner,
// requirements, linked products) but resets everything that represents this
// specific run's history and progress — status, request date, each
// product's stage/log, monthly updates, and the created/updated trail —
// since a duplicate is meant to start over, not carry the original's
// progress forward. Duplicates whatever was last saved on the original, not
// any unsaved edits still sitting in its form.
export function duplicateProject(p){
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

export function saveProjectToCloud(p){
  return setDoc(doc(projectsCol, p.id), p);
}
export function deleteProjectFromCloud(id){
  return deleteDoc(doc(projectsCol, id));
}
export function scheduleProjectSave(p){
  p.updatedAt = Date.now();
  p.updatedBy = currentUser?.email || '';
  saveProjectToCloud(p);
}

export const PROJECT_DIFF_FIELDS = {
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
export const MU_DIFF_FIELDS = {
  date: 'When (Date)', time: 'When (Time)', planWho: 'Person', plan: 'Activity', planWith: 'With', planWhere: 'Location / Channel', planOwner: 'PD',
  actionTaken: 'Action Taken', completedDate: 'Completed Date',
  nextActionDue: 'Next Action When (Date)', nextActionTime: 'Next Action When (Time)', nextActionWho: 'Next Action Person',
  nextAction: 'Next Action Activity', nextActionWith: 'Next Action With', nextActionWhere: 'Next Action Location / Channel', nextActionOwner: 'Next Action PD'
};

// Auto-fills Completed Date with today the first time Action Taken gets
// filled in, but only if the field was left blank — never overwrites a
// date someone already typed (an entry logged today that was actually
// finished yesterday, say). Clears it back out if Action Taken is emptied
// again, so a reopened/undone task doesn't keep a stale completion date.
export function resolveMuCompletedDate(actionTaken, completedDateInput, todayStr){
  if(!actionTaken.trim()) return '';
  return completedDateInput || todayStr;
}
