// The Home dashboard -- metrics, bar charts, Needs Attention, Task
// Tracking, the Activities Calendar, Active Projects, and Product
// Pipeline -- plus the "open from a dashboard card" navigation helpers
// and the top-navbar Home button. Split out of app.js -- see app.js's
// own top-of-file comment for the overall file split.
import {
  escapeHtml, icon, currentUser, uid, mainFeatureView, setMainFeatureView,
  renderMain, renderSidebar, formatActivityDateTime, accountDisplayFromEmail,
  PROJECT_STAGES, countryFlagBadgeHtml, formatDateLong, userProfilesCol,
  isMyActivity, playContentTransition
} from './app.js';
import { setDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { recipes, openRecipe, closeRecipe } from './recipes.js';
import { recipeDisplayLabel, allIngredientsInRecipe } from './recipes-data.js';
import { createNewRecipe, renderRecipesListGrid } from './recipes-list.js';
import { ingredientMaster, renderMaterialTable } from './materials.js';
import {
  projects, projectExpandedIds, renderProjectsList, migrateMonthlyUpdate,
  muPlanSummaryLine, monthlyUpdateStatus, getTaskStatus, daysBetween,
  projectProgressPct, statusPillHtml, projectNextAction, setProjectStatusFilter,
  quickAddCalendarPlan, projectHasUpdateThisMonth
} from './projects.js';
import { trials, trialExpandedIds, renderTrialsList } from './trials.js';
// Circular import back from the Home Calendar split out below -- safe,
// same pattern proven throughout this session's other splits.
import { computeCalendarEvents, calStepView, renderCalendarCardHtml } from './app-dashboard-calendar.js';

/* ---------- Main render ---------- */
/* Groups items by keyFn into descending counts, keeping only the top
   `limit` labels and folding everything past that into a single "Others"
   bucket — keeps bar lists readable regardless of how many distinct
   countries/customers/reps/materials exist. */
function topGroups(items, keyFn, limit){
  const counts = new Map();
  items.forEach(item => {
    const key = (keyFn(item) || '').trim();
    if(!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const sorted = [...counts.entries()].sort((a,b) => b[1] - a[1]);
  const top = sorted.slice(0, limit);
  const othersCount = sorted.slice(limit).reduce((s,[,c]) => s + c, 0);
  if(othersCount > 0) top.push(['Others', othersCount]);
  return top.map(([label,count]) => ({ label, count }));
}

/* Trial evaluation scores are free text (e.g. "8/9") rather than a fixed
   scale, so only entries that actually match a number/number pattern can
   be turned into a comparable ratio — anything else is silently skipped. */
function parseScoreRatio(s){
  const m = String(s || '').trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if(!m) return null;
  const num = parseFloat(m[1]), den = parseFloat(m[2]);
  if(!den) return null;
  return num / den;
}

// Trial Results (see v3.0.223) replaced the old freeform "N/M" evaluation
// score with a fixed Accepted/Not accepted Test Result per product — a
// trial made after that rework has no `evaluation` scores to read any
// more, so this prefers the new field (acceptance rate) and only falls
// back to the legacy ratio for trials from before the format changed, so
// the trend below doesn't just go permanently blank from that point on.
function trialAvgScoreRatio(t){
  const results = Object.values(t.productData || {}).map(pd => pd.testResult).filter(Boolean);
  if(results.length){
    return results.filter(r => r === 'Accepted').length / results.length;
  }
  const ratios = (t.evaluation || []).map(e => parseScoreRatio(e.score)).filter(v => v !== null);
  if(!ratios.length) return null;
  return ratios.reduce((s,v) => s+v, 0) / ratios.length;
}

function computeDashboardData(){
  const now = Date.now();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  const nowDate = new Date();
  const curMonth = nowDate.getMonth(), curYear = nowDate.getFullYear();

  const newThisMonth = recipes.filter(r => r.createdAt &&
    new Date(r.createdAt).getMonth() === curMonth && new Date(r.createdAt).getFullYear() === curYear).length;
  const updatedThisWeek = recipes.filter(r => r.updatedAt && (now - r.updatedAt) <= oneWeekMs).length;

  const yields = recipes.map(r => parseFloat(r.yieldPct)).filter(v => !isNaN(v));
  const avgYield = yields.length ? yields.reduce((s,v) => s+v, 0) / yields.length : null;

  const totalVersions = recipes.reduce((s,r) => s + (Array.isArray(r.versions) ? r.versions.length : 0), 0);

  // Sourced from Projects (not recipes) — Destination Country now lives on
  // the Project since recipes link to a Project instead of carrying their
  // own copy of it (see findProjectForRecipe). Uncapped (no "Others" bucket)
  // since the world-map card plots every country individually.
  const byCountry = topGroups(projects, p => p.destinationCountry, 999);
  const byCustomer = topGroups(recipes, r => r.customerName, 4);
  const bySalesRep = topGroups(recipes, r => r.salesRep, 4);

  const allIngredientRows = recipes.flatMap(r => allIngredientsInRecipe(r));
  const materialUsage = topGroups(allIngredientRows, ing => {
    if(ing.materialId){
      const m = ingredientMaster.find(x => x.id === ing.materialId);
      if(m) return m.nameEn;
    }
    return ing.name;
  }, 5);

  const mostIterated = [...recipes]
    .filter(r => Array.isArray(r.versions) && r.versions.length > 0)
    .sort((a,b) => b.versions.length - a.versions.length)
    .slice(0, 3)
    .map(r => ({ label: recipeDisplayLabel(r), count: r.versions.length }));

  const recentMaterials = [...ingredientMaster]
    .filter(m => m.createdAt)
    .sort((a,b) => b.createdAt - a.createdAt)
    .slice(0, 3);

  const recentActivity = [...recipes]
    .filter(r => r.updatedAt)
    .sort((a,b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);

  const months = [];
  for(let i = 5; i >= 0; i--){
    const d = new Date(curYear, curMonth - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth(), label: d.toLocaleString('en-US',{month:'short'}) });
  }
  const perTrialScore = trials.map(t => ({ t, ratio: trialAvgScoreRatio(t) })).filter(x => x.ratio !== null);
  const trend = months.map(mo => {
    const inMonth = perTrialScore.filter(({t}) => {
      const basis = t.createdAt ? new Date(t.createdAt) : null;
      return basis && basis.getFullYear() === mo.year && basis.getMonth() === mo.month;
    });
    const avg = inMonth.length ? inMonth.reduce((s,{ratio}) => s+ratio, 0) / inMonth.length : null;
    return { label: mo.label, avg };
  });
  const avgTrialScorePct = perTrialScore.length
    ? Math.round(perTrialScore.reduce((s,x) => s+x.ratio, 0) / perTrialScore.length * 100)
    : null;

  const allProducts = projects.flatMap(p => p.products || []);
  // Kept in pipeline order (Requested -> ... -> Cancelled) rather than
  // sorted by count — for a stage funnel, the natural sequence matters more
  // than which stage currently has the most products.
  const productsByStage = PROJECT_STAGES
    .map(stage => ({ label: stage, count: allProducts.filter(prod => prod.stage === stage).length }))
    .filter(g => g.count > 0);

  const recentProjects = [...projects]
    .filter(p => p.updatedAt)
    .sort((a,b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);

  const activeProjectsCount = projects.filter(p => p.status === 'In Progress').length;
  const inReviewProjectsCount = projects.filter(p => p.status === 'In Review').length;
  const updatedThisWeekAll = updatedThisWeek
    + projects.filter(p => p.updatedAt && (now - p.updatedAt) <= oneWeekMs).length
    + trials.filter(t => t.updatedAt && (now - t.updatedAt) <= oneWeekMs).length;

  const topActiveProjects = projects
    .filter(p => p.status === 'In Progress')
    .sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0))
    .slice(0, 5);

  // A single merged feed across all 3 editable record types, newest first —
  // there's no "recently opened" tracking anywhere in Forge, so this is
  // built from real edit timestamps instead of fabricating a view-history
  // feature that doesn't exist.
  const mergedRecentActivity = [
    ...recipes.filter(r => r.updatedAt).map(r => ({ type: 'recipe', icon: 'file-text', id: r.id, name: recipeDisplayLabel(r), updatedAt: r.updatedAt })),
    ...projects.filter(p => p.updatedAt).map(p => ({ type: 'project', icon: 'folder', id: p.id, name: p.name || 'Untitled project', updatedAt: p.updatedAt })),
    ...trials.filter(t => t.updatedAt).map(t => ({ type: 'trial', icon: 'flask-conical', id: t.id, name: (t.recipeIds||[]).map(id => recipes.find(r=>r.id===id)).filter(Boolean).map(recipeDisplayLabel).join(', ') || 'Untitled test', updatedAt: t.updatedAt }))
  ].sort((a,b) => b.updatedAt - a.updatedAt).slice(0, 5);

  return {
    totalRecipes: recipes.length, totalMaterials: ingredientMaster.length, totalProjects: projects.length,
    newThisMonth, updatedThisWeek, avgYield, totalVersions,
    byCountry, byCustomer, bySalesRep, materialUsage, mostIterated, recentMaterials, recentActivity,
    trend, avgTrialScorePct, productsByStage, recentProjects,
    activeProjectsCount, inReviewProjectsCount, updatedThisWeekAll, topActiveProjects, mergedRecentActivity
  };
}

export function renderBarList(groups, altClass){
  if(!groups.length) return '<div class="dash-empty">No data yet</div>';
  const max = Math.max(...groups.map(g => g.count));
  return groups.map(g => `
    <div class="dash-bar-item">
      <div class="dash-bar-label-row"><span>${escapeHtml(g.label)}</span><span class="dbl-count">${g.count}</span></div>
      <div class="dash-bar-track"><div class="dash-bar-fill${altClass ? ' '+altClass : ''}" style="width:${Math.max(4, Math.round(g.count/max*100))}%"></div></div>
    </div>
  `).join('');
}


// Same flag-badge component used on the Reference Lists page (see
// countryFlagBadgeHtml), reused here so a country reads the same way in
// both places — a ranked bar list rather than a map, sized/ordered by
// project count (topGroups already sorts descending).
function renderCountryBarList(groups){
  if(!groups.length) return '<div class="dash-empty">No data yet</div>';
  const max = Math.max(...groups.map(g => g.count));
  return groups.map(g => {
    const shortLabel = g.label.replace(/\([^)]*\)/g, '').trim() || g.label;
    return `
      <div class="dash-country-row">
        ${countryFlagBadgeHtml(g.label)}
        <div class="dash-country-main">
          <div class="dash-bar-label-row"><span>${escapeHtml(shortLabel)}</span><span class="dbl-count">${g.count}</span></div>
          <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${Math.max(4, Math.round(g.count/max*100))}%"></div></div>
        </div>
      </div>
    `;
  }).join('');
}

// Real, derivable "needs attention" signals — deliberately NOT a fabricated
// due-date/task system (Forge has no due-date field anywhere), just honest
// gaps in data that already exists: projects with no products yet, trials
// nobody has scored, active projects missing this month's update, and
// materials with no price on file (which silently breaks Compare Costing).
// Sorted by severity so the dashboard card can show the most pressing first.
const ACTION_SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
function computeActionItems(){
  const items = [];
  projects.forEach(p => {
    if(!(p.products || []).length){
      items.push({ severity: 'high', title: 'Add a product to this project', subjectIcon: 'folder', subject: p.name || 'Untitled project', itemType: 'project', itemId: p.id });
    }
  });
  trials.forEach(t => {
    if((t.recipeIds || []).length && trialAvgScoreRatio(t) === null){
      const label = (t.recipeIds || []).map(id => recipes.find(r => r.id === id)).filter(Boolean).map(recipeDisplayLabel).join(', ') || 'Untitled test';
      items.push({ severity: 'medium', title: 'Score this test', subjectIcon: 'flask-conical', subject: label, itemType: 'trial', itemId: t.id });
    }
  });
  projects.forEach(p => {
    if(p.status === 'In Progress' && (p.products || []).length && !projectHasUpdateThisMonth(p)){
      items.push({ severity: 'medium', title: "Add this month's update", subjectIcon: 'folder', subject: p.name || 'Untitled project', itemType: 'project', itemId: p.id });
    }
  });
  ingredientMaster.forEach(m => {
    if(m.price === '' || m.price == null){
      items.push({ severity: 'low', title: 'Add a price', subjectIcon: 'book-open', subject: m.nameEn || 'Untitled material', itemType: 'material', itemId: m.id });
    }
  });
  return items.sort((a, b) => ACTION_SEVERITY_ORDER[a.severity] - ACTION_SEVERITY_ORDER[b.severity]);
}

// Cross-project view of open tasks — every Activities Updates entry that's
// still "planned" (see monthlyUpdateStatus: no Action Taken recorded yet)
// has a Plan and a date, which together are exactly "a task with a due
// date." Reuses that data instead of a separate task system, bucketed by
// how urgent the date is so a project manager can see what's overdue or
// coming up without opening every project one at a time.
function computeTaskTracking(){
  const todayStr = new Date().toISOString().slice(0, 10);
  const soonCutoffDate = new Date();
  soonCutoffDate.setDate(soonCutoffDate.getDate() + 7);
  const soonCutoffStr = soonCutoffDate.toISOString().slice(0, 10);

  const overdue = [], dueToday = [], dueSoon = [], completedToday = [];
  projects.forEach(p => {
    (p.monthlyUpdates || []).map(migrateMonthlyUpdate).forEach(mu => {
      if(!mu.date) return;
      if(!isMyActivity(p, mu)) return;
      // Uses the entry's own Completed Date (see resolveMuCompletedDate),
      // not its due date — a task logged today that was actually finished
      // yesterday shows up under yesterday, not here, once that date is
      // corrected on the entry itself.
      if(monthlyUpdateStatus(mu) === 'logged'){
        if(mu.completedDate === todayStr){
          // planText set (Task Tracking's other 3 lists never set it) is
          // what tells taskRowHtml to show the Plan → Done two-line format
          // instead of a single line — so it's clear what was asked for
          // and what actually got done, not just the end result alone.
          completedToday.push({ projectId: p.id, projectName: p.name || 'Untitled project', projectImage: p.image || '', text: mu.actionTaken || mu.plan || 'Untitled task', planText: muPlanSummaryLine(mu), date: mu.date, who: mu.planWho || '' });
        }
        return;
      }
      const task = { projectId: p.id, projectName: p.name || 'Untitled project', projectImage: p.image || '', text: muPlanSummaryLine(mu) || 'Untitled task', date: mu.date, who: mu.planWho || '' };
      if(mu.date < todayStr) overdue.push(task);
      else if(mu.date === todayStr) dueToday.push(task);
      else if(mu.date <= soonCutoffStr) dueSoon.push(task);
    });
  });
  overdue.sort((a, b) => a.date.localeCompare(b.date));
  dueSoon.sort((a, b) => a.date.localeCompare(b.date));
  return { overdue, dueToday, dueSoon, completedToday };
}

// Tracks which date the Home dashboard's Activities Calendar is currently
// showing — which fields of it matter depends on homeCalendarViewMode
// (e.g. Month view only reads year/month, Day view reads the full date).
// Reset to today by the Today button; otherwise carried forward across
// re-renders so paging doesn't snap back to the current period every time
// something else on the dashboard changes.
let homeCalendarViewDate = new Date();
// One of 'day' | 'week' | 'month' | 'year' — same carry-forward-across-
// re-renders treatment as homeCalendarViewDate, right above.
export let homeCalendarViewMode = 'month';
// Which people's events the calendar shows — a Set of mu.planWho values,
// empty meaning "everyone" — plus whether its checklist popover is open.
// Same pattern (and carry-forward treatment) as Task Tracking's own Who
// filter (taskTrackingWhoFilters/taskTrackingWhoMenuOpen below); kept as
// a separate Set since filtering the calendar to one person shouldn't
// also filter the Task Tracking lists, or vice versa.
export let homeCalendarWhoFilters = new Set();
export let homeCalendarWhoMenuOpen = false;
// Stand-in for '' (no planWho) in the Who filter's Set/checkbox values --
// an actual empty string is awkward to carry through a checkbox's value
// attribute and back reliably, and doubles as a value CAL_WHO_UNASSIGNED
// itself would never collide with a real person's name.
export const CAL_WHO_UNASSIGNED = '__unassigned__';
// A pane's "show everyone" <select> value -- same reasoning as
// CAL_WHO_UNASSIGNED above (an empty <option value=""> is easy to
// mishandle), kept as a separate sentinel from it since they mean
// opposite things (all vs. specifically nobody).
export const CAL_PANE_ALL = '__all__';
// Side-by-side calendar "windows", each independently showing one
// person's events (or everyone's) so a few people can be monitored at a
// glance -- they all share the same nav (homeCalendarViewDate) and view
// mode (homeCalendarViewMode) above, only the person shown differs per
// pane. Starts with a single All pane, which alone renders identically
// to the old single-calendar layout; +Add window appends more.
export let homeCalendarPanes = [{ id: 'cal-pane-default', who: CAL_PANE_ALL }];
// Called from core app.js's attachMyProfileListener when this account's My
// Profile doc has its own saved calendar layout -- a plain
// `homeCalendarPanes = ...` assignment from outside this module isn't
// possible, ES modules can't reassign a sibling module's `let` binding
// from outside it (same reasoning as openRecipe/setUnlockedRecipeId in
// recipes.js). Takes the raw Firestore array and sanitizes/defaults it
// here (rather than in the core caller) so CAL_PANE_ALL and this shape
// stay this module's own concern.
export function setHomeCalendarPanes(rawPanes){
  homeCalendarPanes = rawPanes.map(p => ({
    id: p?.id || uid(),
    who: typeof p?.who === 'string' && p.who ? p.who : CAL_PANE_ALL,
    expanded: !!p?.expanded
  }));
}

// Task Tracking's Who filter — a Set of names (empty Set means "all"),
// since more than one person can be selected at once. Carried forward
// across re-renders (dashboard stat card clicks, calendar paging, etc.)
// the same way homeCalendarViewDate is, so picking a filter doesn't get
// silently reset by an unrelated dashboard refresh.
let taskTrackingWhoFilters = new Set();
// Whether the Who filter's checklist popover is currently open — kept as
// its own flag (rather than a pure DOM class toggle) so it survives the
// full refreshDashboardHome() re-render a checkbox click triggers, same
// pattern as openProjectFilterMenuKey for the Projects table's column
// filters.
let taskTrackingWhoMenuOpen = false;

// Called from core app.js's document-level "close any open dropdown on an
// outside click" handler -- reading/writing taskTrackingWhoMenuOpen/
// homeCalendarWhoMenuOpen directly from there isn't possible (same
// read-only-imported-binding reasoning as setHomeCalendarPanes above), so
// that handler calls this instead of inlining the two checks itself.
export function closeDashboardWhoMenus(){
  if(taskTrackingWhoMenuOpen){
    taskTrackingWhoMenuOpen = false;
    document.getElementById('taskTrackingWhoMenu')?.classList.remove('open');
  }
  if(homeCalendarWhoMenuOpen){
    homeCalendarWhoMenuOpen = false;
    document.getElementById('calWhoMenu')?.classList.remove('open');
  }
}

export function renderDashboardHome(){
  const d = computeDashboardData();
  const actionItems = computeActionItems();
  const taskTracking = computeTaskTracking();
  // The Who filter's option list is built from every task currently on the
  // board (all 4 lists, before filtering) — so selecting one person never
  // makes the others disappear from the toggle row.
  const allTaskTrackingItems = [...taskTracking.overdue, ...taskTracking.dueToday, ...taskTracking.dueSoon, ...taskTracking.completedToday];
  const taskTrackingWhoOptions = [...new Set(allTaskTrackingItems.map(t => t.who).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const taskTrackingMatchesFilter = t => !taskTrackingWhoFilters.size || taskTrackingWhoFilters.has(t.who);
  taskTracking.overdue = taskTracking.overdue.filter(taskTrackingMatchesFilter);
  taskTracking.dueToday = taskTracking.dueToday.filter(taskTrackingMatchesFilter);
  taskTracking.dueSoon = taskTracking.dueSoon.filter(taskTrackingMatchesFilter);
  taskTracking.completedToday = taskTracking.completedToday.filter(taskTrackingMatchesFilter);

  const metrics = [
    { label:'Recipes', value:d.totalRecipes },
    { label:'Projects', value:d.totalProjects },
    { label:'Materials', value:d.totalMaterials },
    { label:'New this month', value:d.newThisMonth },
    { label:'Avg yield', value:d.avgYield != null ? `${d.avgYield.toFixed(1)}<span class="dm-suffix">%</span>` : '-' },
    { label:'Versions saved', value:d.totalVersions }
  ];

  const trendMax = Math.max(0.0001, ...d.trend.map(t => t.avg || 0));
  const trendHtml = d.trend.map((t,i) => `
    <div class="dash-trend-bar-wrap">
      <div class="dash-trend-bar${i === d.trend.length-1 ? ' current' : ''}" style="height:${t.avg != null ? Math.max(4, Math.round(t.avg/trendMax*100)) : 2}%"></div>
      <div class="dash-trend-label">${escapeHtml(t.label)}</div>
    </div>
  `).join('');

  const recentMaterialsHtml = d.recentMaterials.length
    ? d.recentMaterials.map(m => `<div class="dash-list-row"><span>${escapeHtml(m.nameEn || 'Untitled')}</span><span class="dbl-count">${escapeHtml(formatActivityDateTime(m.createdAt) || '')}</span></div>`).join('')
    : '<div class="dash-empty">No materials yet</div>';

  const mostIteratedHtml = d.mostIterated.length
    ? d.mostIterated.map(x => `<div class="dash-list-row"><span>${escapeHtml(x.label)}</span><span class="dbl-count">${x.count} version${x.count === 1 ? '' : 's'}</span></div>`).join('')
    : '<div class="dash-empty">No saved versions yet</div>';

  const { name: greetingName } = accountDisplayFromEmail(currentUser?.email);
  const todayLabel = new Date().toLocaleDateString('en-US', { day:'numeric', month:'long', year:'numeric' });

  const statCards = [
    { icon:'folder', label:'Active Projects', value:d.activeProjectsCount, action:'filter-in-progress' },
    { icon:'clipboard-check', label:'Pending Review', value:d.inReviewProjectsCount, action:'filter-in-review' },
    { icon:'alert-triangle', label:'Needs Attention', value:actionItems.length, action:'scroll-attention' },
    { icon:'refresh-cw', label:'Updated This Week', value:d.updatedThisWeekAll, action:'scroll-activity' }
  ];
  const statCardsHtml = statCards.map(s => `
    <button type="button" class="hd2-stat-card" data-stat-action="${s.action}">
      <span class="hd2-stat-icon">${icon(s.icon, 20)}</span>
      <span class="hd2-stat-text">
        <span class="hd2-stat-label">${escapeHtml(s.label)}</span>
        <span class="hd2-stat-value">${s.value}</span>
      </span>
      <span class="hd2-stat-arrow">${icon('chevron-right', 16)}</span>
    </button>
  `).join('');

  // These are honest data gaps (missing products/scores/updates/prices),
  // not date-driven — see computeActionItems() for exactly what each one
  // checks. Actual due-date tracking lives in Task Tracking below instead
  // (see computeTaskTracking), sourced from Activities Updates' Next
  // Action due dates rather than being a separate fabricated system.
  const SEVERITY_DOT_COLOR = { high:'var(--danger)', medium:'var(--accent)', low:'var(--text-dim)' };
  const taskRowHtml = t => `
    <div class="task-tracking-row action-go-btn" data-item-type="project" data-item-id="${escapeHtml(t.projectId)}" data-focus-section="activities">
      ${t.projectImage
        ? `<img class="task-tracking-thumb" src="${escapeHtml(t.projectImage)}" alt="">`
        : `<span class="task-tracking-thumb task-tracking-thumb-empty">${icon('folder', 14)}</span>`}
      <div class="task-tracking-body">
        ${t.planText ? `
          <div class="task-tracking-plan-line"><span class="task-tracking-line-label">Plan:</span> ${escapeHtml(t.planText)}</div>
          <div class="task-tracking-done-line"><span class="task-tracking-line-label">Done:</span> ${escapeHtml(t.text)}</div>
        ` : `<div class="task-tracking-text">${escapeHtml(t.text)}</div>`}
        <div class="task-tracking-meta">${icon('folder', 12)} ${escapeHtml(t.projectName)}</div>
      </div>
    </div>
  `;
  // Items already arrive sorted by date (see computeTaskTracking), so a
  // group heading only needs to go in front of each run of same-date
  // items — the per-row date this replaced was repeating the same date
  // over and over down a run, this says it once per group instead.
  const taskTrackingTodayStr = new Date().toISOString().slice(0, 10);
  const taskColumnItemsHtml = (items, showOverdueDays) => {
    let html = '', lastDate = null;
    items.forEach(t => {
      if(t.date !== lastDate){
        const overdueDayCount = daysBetween(t.date, taskTrackingTodayStr);
        const overdueSuffix = showOverdueDays ? ` <span class="task-tracking-overdue-days">(-${overdueDayCount} Day${overdueDayCount === 1 ? '' : 's'})</span>` : '';
        html += `<div class="task-tracking-date-heading">${escapeHtml(formatDateLong(t.date))}${overdueSuffix}</div>`;
        lastDate = t.date;
      }
      html += taskRowHtml(t);
    });
    return html;
  };
  const taskTrackingCols = [
    { key: 'overdue', label: 'Overdue', color: 'var(--danger)', empty: 'Nothing overdue' },
    { key: 'dueSoon', label: 'Due Soon (7 days)', color: 'var(--primary-dark)', empty: 'Nothing due soon' }
  ];
  const renderTaskTrackingCol = col => `
    <div class="task-tracking-col">
      <div class="task-tracking-col-title" style="color:${col.color};">${escapeHtml(col.label)} <span class="dbl-count">${taskTracking[col.key].length}</span></div>
      ${taskTracking[col.key].length ? taskColumnItemsHtml(taskTracking[col.key], col.key === 'overdue') : `<div class="dash-empty">${escapeHtml(col.empty)}</div>`}
    </div>
  `;
  // "Due Today" always has exactly one possible date (today), unlike the
  // other two columns, so its heading shows even with nothing due — and it
  // gets a second, separate list right below for entries due today that
  // are already logged (see completedToday in computeTaskTracking), so the
  // column reads as "today's full picture", not just what's still open.
  const dueTodayColHtml = `
    <div class="task-tracking-col">
      <div class="task-tracking-col-title" style="color:var(--accent);">Due Today <span class="dbl-count">${taskTracking.dueToday.length}</span></div>
      <div class="task-tracking-date-heading">${escapeHtml(formatDateLong(taskTrackingTodayStr))}</div>
      ${taskTracking.dueToday.length ? taskTracking.dueToday.map(taskRowHtml).join('') : `<div class="dash-empty">Nothing due today</div>`}
      ${taskTracking.completedToday.length ? `
      <div class="task-tracking-completed-heading">${icon('check', 12)} Completed Today <span class="dbl-count">${taskTracking.completedToday.length}</span></div>
      ${taskTracking.completedToday.map(taskRowHtml).join('')}
      ` : ''}
    </div>
  `;
  const taskTrackingHtml = renderTaskTrackingCol(taskTrackingCols[0]) + dueTodayColHtml + renderTaskTrackingCol(taskTrackingCols[1]);
  const shownActionItems = actionItems.slice(0, 5);
  const actionItemsHtml = shownActionItems.length
    ? shownActionItems.map(item => `
        <div class="action-item">
          <span class="action-dot" style="background:${SEVERITY_DOT_COLOR[item.severity]};"></span>
          <div class="action-item-body">
            <div class="action-item-title">${escapeHtml(item.title)}</div>
            <div class="action-item-subject">${icon(item.subjectIcon, 14)} ${escapeHtml(item.subject)}</div>
          </div>
          <button class="btn btn-sm action-go-btn" data-item-type="${escapeHtml(item.itemType)}" data-item-id="${escapeHtml(item.itemId)}">Go</button>
        </div>
      `).join('') + (actionItems.length > shownActionItems.length ? `<div class="dash-empty">+${actionItems.length - shownActionItems.length} more</div>` : '')
    : `<div class="dash-empty">Nothing needs attention right now ${icon('party-popper', 14)}</div>`;

  const mergedActivityHtml = d.mergedRecentActivity.length
    ? d.mergedRecentActivity.map(item => `
        <div class="dash-activity-row action-go-btn" data-item-type="${item.type}" data-item-id="${escapeHtml(item.id)}" style="cursor:pointer;">
          <div class="dash-activity-name">${icon(item.icon, 14)} ${escapeHtml(item.name)}</div>
          <div class="dash-activity-time">${escapeHtml(formatActivityDateTime(item.updatedAt) || '')}</div>
        </div>
      `).join('')
    : '<div class="dash-empty">No activity yet</div>';

  const activeProjectsTableHtml = d.topActiveProjects.length
    ? `
      <div class="dash-table-scroll">
      <table class="dash-projects-table">
        <thead><tr><th>Project</th><th>Customer</th><th>Progress</th><th>Status</th><th>Next action</th><th></th></tr></thead>
        <tbody>
          ${d.topActiveProjects.map(p => `
            <tr>
              <td><b>${escapeHtml(p.name || 'Untitled project')}</b></td>
              <td>${escapeHtml(p.customerName || '—')}</td>
              <td>
                <div class="proj-status-bar-track" style="max-width:120px;"><div class="proj-status-bar-fill" style="width:${projectProgressPct(p)}%;background:var(--accent);"></div></div>
                <span class="dash-progress-pct">${projectProgressPct(p)}%</span>
              </td>
              <td>${statusPillHtml(p.status)}</td>
              <td class="dash-next-action">${escapeHtml(projectNextAction(p))}</td>
              <td><button class="btn btn-sm action-go-btn" data-item-type="project" data-item-id="${escapeHtml(p.id)}">View</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
    `
    : '<div class="dash-empty">No active projects right now</div>';

  const pipelineHtml = d.productsByStage.length
    ? `<div class="pipeline-funnel">${d.productsByStage.map((g,i) => `
        ${i > 0 ? '<div class="pipeline-chevron">›</div>' : ''}
        <div class="pipeline-step">
          <div class="pipeline-step-count">${g.count}</div>
          <div class="pipeline-step-label">${escapeHtml(g.label)}</div>
        </div>
      `).join('')}</div>`
    : '<div class="dash-empty">No products in the pipeline yet</div>';

  return `
    <div class="home-dashboard">
      <div class="hd2-greeting">
        <div class="hd2-hello">Hello, ${escapeHtml(greetingName || 'there')}</div>
        <div class="hd2-sub">Your work overview · ${escapeHtml(todayLabel)}</div>
      </div>

      <div class="hd2-searchrow">
        <input type="text" class="hd2-search" id="hdSearchInput" placeholder="Search recipes, projects, materials...">
        <div class="hd2-create-wrap">
          <button type="button" class="btn btn-primary" id="hdCreateBtn">+ Create ${icon('chevron-down', 14)}</button>
          <div class="hd2-create-menu" id="hdCreateMenu">
            <button type="button" class="navbar-account-menu-item" id="hdCreateRecipeBtn">${icon('file-text')} New Recipe</button>
            <button type="button" class="navbar-account-menu-item" id="hdCreateProjectBtn">${icon('folder')} New Project</button>
          </div>
        </div>
      </div>

      <div class="hd2-stats">${statCardsHtml}</div>

      <div class="dash-card" id="taskTrackingCard" style="margin-bottom:14px;">
        <div class="cal-header-bar">
          <div class="dash-card-title" style="margin-bottom:0;">Task Tracking</div>
          <div class="cal-nav">
            <button type="button" class="btn btn-sm btn-primary" id="taskTrackingAddBtn" title="Add a new task/activity, due today">${icon('plus', 12)} Add Task</button>
            <div class="task-tracking-who-filter-wrap">
              <button type="button" class="btn btn-sm${taskTrackingWhoFilters.size ? ' active' : ''}" id="taskTrackingWhoTrigger">
                Who${taskTrackingWhoFilters.size ? ` (${taskTrackingWhoFilters.size})` : ''} ${icon('chevron-down', 12)}
              </button>
              <div class="proj-col-filter-menu${taskTrackingWhoMenuOpen ? ' open' : ''}" id="taskTrackingWhoMenu">
                ${taskTrackingWhoOptions.length ? `
                <div class="proj-col-filter-values">
                  ${taskTrackingWhoOptions.map(w => `
                    <label class="proj-col-filter-item">
                      <input type="checkbox" class="task-tracking-who-cb" value="${escapeHtml(w)}" ${taskTrackingWhoFilters.has(w) ? 'checked' : ''}>
                      ${escapeHtml(w)}
                    </label>
                  `).join('')}
                </div>
                ${taskTrackingWhoFilters.size ? `<button type="button" class="btn btn-sm" id="taskTrackingClearFilters" style="margin-top:6px;width:100%;">Clear filter</button>` : ''}
                ` : `<div class="dash-empty" style="padding:4px;">No one assigned yet</div>`}
              </div>
            </div>
          </div>
        </div>
        <div class="task-tracking-grid">${taskTrackingHtml}</div>
      </div>

      ${renderCalendarCardHtml(homeCalendarViewDate, computeCalendarEvents())}

      <div class="dash-row">
        <div class="dash-card" id="needsAttentionCard">
          <div class="dash-card-title">Needs Attention</div>
          ${actionItemsHtml}
        </div>
        <div class="dash-card" id="recentActivityCard">
          <div class="dash-card-title">Recent Activity</div>
          ${mergedActivityHtml}
        </div>
      </div>

      <div class="dash-card" style="margin-bottom:14px;">
        <div class="dash-card-title">Active Projects</div>
        ${activeProjectsTableHtml}
      </div>

      <div class="dash-card" style="margin-bottom:14px;">
        <div class="dash-card-title">Product Pipeline</div>
        ${pipelineHtml}
      </div>

      <div class="dash-metrics">
        ${metrics.map(m => `
          <div class="dash-metric">
            <div class="dash-metric-label">${escapeHtml(m.label)}</div>
            <div class="dash-metric-value">${m.value}</div>
          </div>
        `).join('')}
      </div>

      <div class="dash-row">
        <div class="dash-card">
          <div class="dash-card-title">By Country / Region</div>
          ${renderCountryBarList(d.byCountry)}
        </div>
      </div>

      <div class="dash-row">
        <div class="dash-card">
          <div class="dash-card-title">Recipes by sales rep</div>
          ${renderBarList(d.bySalesRep)}
        </div>
        <div class="dash-card">
          <div class="dash-card-title">Most-used materials</div>
          ${renderBarList(d.materialUsage, 'alt')}
        </div>
        <div class="dash-card">
          <div class="dash-card-title">Top customers</div>
          ${renderBarList(d.byCustomer, 'alt')}
        </div>
      </div>

      <div class="dash-row">
        <div class="dash-card">
          <div class="dash-card-title">Test acceptance rate, last 6 months${d.avgTrialScorePct != null ? ` <span class="dbl-count">(avg ${d.avgTrialScorePct}%)</span>` : ''}</div>
          ${d.trend.some(t => t.avg != null) ? `<div class="dash-trend">${trendHtml}</div>` : '<div class="dash-empty">No scored test results yet</div>'}
        </div>
        <div class="dash-card">
          <div class="dash-card-title">Most-iterated recipes</div>
          ${mostIteratedHtml}
        </div>
      </div>

      <div class="dash-row">
        <div class="dash-card">
          <div class="dash-card-title">Recently added materials</div>
          ${recentMaterialsHtml}
        </div>
      </div>
    </div>
  `;
}

export function refreshDashboardHome(){
  const main = document.getElementById('mainArea');
  main.innerHTML = renderDashboardHome();
  wireDashboardHome();
  playContentTransition(main);
}

export function wireDashboardHome(){
  const main = document.getElementById('mainArea');

  document.getElementById('calToday')?.addEventListener('click', () => {
    homeCalendarViewDate = new Date();
    refreshDashboardHome();
  });
  document.getElementById('calPrevPeriod')?.addEventListener('click', () => {
    homeCalendarViewDate = calStepView(homeCalendarViewDate, homeCalendarViewMode, -1);
    refreshDashboardHome();
  });
  document.getElementById('calNextPeriod')?.addEventListener('click', () => {
    homeCalendarViewDate = calStepView(homeCalendarViewDate, homeCalendarViewMode, 1);
    refreshDashboardHome();
  });
  document.querySelectorAll('[data-cal-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      homeCalendarViewMode = btn.dataset.calView;
      refreshDashboardHome();
    });
  });
  document.querySelectorAll('[data-cal-jump-month]').forEach(btn => {
    btn.addEventListener('click', () => {
      homeCalendarViewDate = new Date(homeCalendarViewDate.getFullYear(), parseInt(btn.dataset.calJumpMonth, 10), 1);
      homeCalendarViewMode = 'month';
      refreshDashboardHome();
    });
  });
  document.getElementById('calWhoTrigger')?.addEventListener('click', e => {
    e.stopPropagation();
    homeCalendarWhoMenuOpen = !homeCalendarWhoMenuOpen;
    refreshDashboardHome();
  });
  document.getElementById('calWhoMenu')?.addEventListener('click', e => e.stopPropagation());
  main.querySelectorAll('.cal-who-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if(cb.checked) homeCalendarWhoFilters.add(cb.value);
      else homeCalendarWhoFilters.delete(cb.value);
      refreshDashboardHome();
    });
  });
  document.getElementById('calWhoSelectAll')?.addEventListener('change', e => {
    // Reads the checkboxes already on the page (== allWhoValues) rather
    // than recomputing that list here -- same set either way, but this
    // way there's only one place (renderCalendarCardHtml) that decides
    // what counts as "everyone".
    const allValues = [...main.querySelectorAll('.cal-who-cb')].map(cb => cb.value);
    if(e.target.checked) allValues.forEach(v => homeCalendarWhoFilters.add(v));
    else homeCalendarWhoFilters.clear();
    refreshDashboardHome();
  });
  document.getElementById('calClearWhoFilters')?.addEventListener('click', () => {
    homeCalendarWhoFilters.clear();
    refreshDashboardHome();
  });
  main.querySelectorAll('.cal-pane-who-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const pane = homeCalendarPanes.find(p => p.id === sel.dataset.calPaneId);
      if(pane) pane.who = sel.value;
      saveCalendarPanes();
      refreshDashboardHome();
    });
  });
  main.querySelectorAll('.cal-pane-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      homeCalendarPanes = homeCalendarPanes.filter(p => p.id !== btn.dataset.calPaneId);
      saveCalendarPanes();
      refreshDashboardHome();
    });
  });
  main.querySelectorAll('.cal-pane-expand-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const pane = homeCalendarPanes.find(p => p.id === btn.dataset.calPaneId);
      if(pane) pane.expanded = !pane.expanded;
      saveCalendarPanes();
      refreshDashboardHome();
    });
  });
  document.getElementById('calAddPane')?.addEventListener('click', () => {
    homeCalendarPanes.push({ id: uid(), who: CAL_PANE_ALL });
    saveCalendarPanes();
    refreshDashboardHome();
  });
  // Month/Week's day cells (empty space, not an existing event chip --
  // those already navigate to their own project via .action-go-btn) and
  // Day view's own "+ Add Plan" button both start the same quick-add flow
  // (see quickAddCalendarPlan in projects.js): a blank entry on the
  // Unassigned bucket project, opened straight into the Update Activity
  // popup to fill in. Delegated on `main` (not queried per-cell) since a
  // click on a chip still bubbles up through its cell.
  main.querySelectorAll('.cal-cell-clickable').forEach(cell => {
    cell.addEventListener('click', e => {
      if(e.target.closest('.cal-event-wrap')) return;
      quickAddCalendarPlan(cell.dataset.calDate);
    });
  });
  main.querySelectorAll('.cal-day-add-btn').forEach(btn => {
    btn.addEventListener('click', () => quickAddCalendarPlan(btn.dataset.calDate));
  });

  // Same quick-add flow as clicking an empty calendar cell (see the
  // .cal-cell-clickable/.cal-day-add-btn wiring right above) -- a blank
  // entry on the Unassigned bucket project, dated today since there's no
  // specific cell to take the date from here, opened straight into the
  // Update Activity popup to fill in (including moving it off Unassigned
  // once a project's picked).
  document.getElementById('taskTrackingAddBtn')?.addEventListener('click', () => {
    quickAddCalendarPlan(new Date().toISOString().slice(0, 10));
  });
  document.getElementById('taskTrackingWhoTrigger')?.addEventListener('click', e => {
    e.stopPropagation();
    taskTrackingWhoMenuOpen = !taskTrackingWhoMenuOpen;
    refreshDashboardHome();
  });
  document.getElementById('taskTrackingWhoMenu')?.addEventListener('click', e => e.stopPropagation());
  main.querySelectorAll('.task-tracking-who-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if(cb.checked) taskTrackingWhoFilters.add(cb.value);
      else taskTrackingWhoFilters.delete(cb.value);
      refreshDashboardHome();
    });
  });
  document.getElementById('taskTrackingClearFilters')?.addEventListener('click', () => {
    taskTrackingWhoFilters.clear();
    refreshDashboardHome();
  });

  main.querySelectorAll('.action-go-btn').forEach(el => {
    el.addEventListener('click', () => {
      const type = el.dataset.itemType, id = el.dataset.itemId;
      if(type === 'project') openProjectFromDashboard(id, el.dataset.focusSection);
      else if(type === 'trial') openTrialFromDashboard(id);
      else if(type === 'material') openMaterialFromDashboard(id);
      else if(type === 'recipe') openRecipeFromDashboard(id);
    });
  });

  main.querySelectorAll('.hd2-stat-card').forEach(el => {
    el.addEventListener('click', () => {
      const action = el.dataset.statAction;
      if(action === 'filter-in-progress' || action === 'filter-in-review'){
        setProjectStatusFilter(action === 'filter-in-progress' ? 'In Progress' : 'In Review');
        setMainFeatureView('projects');
        renderMain();
        renderSidebar();
      }else if(action === 'scroll-attention'){
        document.getElementById('needsAttentionCard')?.scrollIntoView({ behavior:'smooth', block:'start' });
      }else if(action === 'scroll-activity'){
        document.getElementById('recentActivityCard')?.scrollIntoView({ behavior:'smooth', block:'start' });
      }
    });
  });

  // The sidebar is hidden on the Home dashboard now, so this can't just
  // mirror into it like before — instead it hands off to the full-page
  // Recipes view on the first keystroke and refocuses that view's own
  // search box so typing can continue uninterrupted.
  const searchInputHome = document.getElementById('hdSearchInput');
  searchInputHome?.addEventListener('input', () => {
    const query = searchInputHome.value;
    setMainFeatureView('recipesList');
    renderMain();
    renderSidebar();
    const newInput = document.getElementById('recipesListSearchInput');
    if(newInput){
      newInput.value = query;
      newInput.focus();
      newInput.setSelectionRange(query.length, query.length);
      renderRecipesListGrid();
    }
  });

  const createBtn = document.getElementById('hdCreateBtn');
  const createMenu = document.getElementById('hdCreateMenu');
  createBtn?.addEventListener('click', e => {
    e.stopPropagation();
    createMenu.classList.toggle('open');
  });
  document.getElementById('hdCreateRecipeBtn')?.addEventListener('click', () => {
    createMenu.classList.remove('open');
    createNewRecipe();
  });
  document.getElementById('hdCreateProjectBtn')?.addEventListener('click', () => {
    createMenu.classList.remove('open');
    setMainFeatureView('projects');
    renderMain();
    renderSidebar();
    document.getElementById('btnAddProject')?.click();
  });
}

// "Go" targets for dashboard action items / the Active Projects table —
// open the relevant feature view already expanded (and, for a project,
// filtered down to it) instead of just dropping the user on an unfiltered
// list they'd have to search through themselves.
function openProjectFromDashboard(projectId, focusSection){
  const p = projects.find(x => x.id === projectId);
  setMainFeatureView('projects');
  renderMain();
  renderSidebar();
  projectExpandedIds.add(projectId);
  const input = document.getElementById('projectSearchInput');
  if(input && p && p.name) input.value = p.name;
  renderProjectsList();
  if(focusSection === 'activities'){
    document.getElementById(`activities-updates-${projectId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
function openTrialFromDashboard(trialId){
  setMainFeatureView('trials');
  renderMain();
  renderSidebar();
  trialExpandedIds.add(trialId);
  renderTrialsList();
}
function openMaterialFromDashboard(materialId){
  const m = ingredientMaster.find(x => x.id === materialId);
  setMainFeatureView('materials');
  renderMain();
  renderSidebar();
  const input = document.getElementById('materialSearchInput');
  if(input && m && m.nameEn) input.value = m.nameEn;
  renderMaterialTable();
}
export function openRecipeFromDashboard(recipeId){
  openRecipe(recipeId);
  setMainFeatureView(null);
  renderMain();
  renderSidebar();
}

// Persists homeCalendarPanes to this account's own My Profile doc --
// called after every add/remove/who-change/expand-toggle so the layout
// survives a refresh or switching devices, same document
// attachMyProfileListener reads it back from. Silently a no-op while
// signed out (shouldn't happen in practice, since the calendar only
// renders once signed in, but cheap to guard anyway).
function saveCalendarPanes(){
  if(!currentUser) return;
  setDoc(doc(userProfilesCol, currentUser.uid), { calendarPanes: homeCalendarPanes }, { merge: true })
    .catch(err => console.error('Forge: failed to save calendar panes', err));
}

export function goHome(){
  closeRecipe();
  setMainFeatureView(null);
  renderMain();
  renderSidebar();
}
