// The Home dashboard's Activities Calendar card -- month/week/day/year
// grid views, per-pane Who filtering, and the multi-pane layout. Split
// out of app-dashboard.js -- see that file's own top-of-file comment for
// the overall file split.
import { escapeHtml, icon, isMyActivity } from './app.js';
import { projects, migrateMonthlyUpdate, muPlanSummaryLine, getTaskStatus } from './projects.js';
// Circular import back to core app-dashboard.js -- safe, same pattern
// proven throughout this session's splits: every cross-reference below
// happens inside a function body, never at module-evaluation time.
// Read-only -- renderCalendarCardHtml never assigns any of these; every
// assignment site lives in wireDashboardHome, which stays in core.
import {
  homeCalendarViewMode, homeCalendarWhoFilters, homeCalendarWhoMenuOpen,
  homeCalendarPanes, CAL_WHO_UNASSIGNED, CAL_PANE_ALL
} from './app-dashboard.js';

// Every Activities Update with a due date, across every project — same
// source Task Tracking reads (see computeTaskTracking), just not filtered
// down to planned/overdue/soon since the calendar shows a whole month at
// once regardless of status.
export function computeCalendarEvents(){
  const events = [];
  projects.forEach(p => {
    (p.monthlyUpdates || []).map(migrateMonthlyUpdate).forEach(mu => {
      if(!mu.date) return;
      if(!isMyActivity(p, mu)) return;
      events.push({
        projectId: p.id,
        projectName: p.name || 'Untitled project',
        text: muPlanSummaryLine(mu) || mu.actionTaken || 'Untitled task',
        date: mu.date,
        who: mu.planWho || '',
        // Added via an empty-cell click and not yet moved to a real
        // project (see quickAddCalendarPlan) -- flagged so the chip can
        // show a distinct marker (dashed border, see calEventChipHtml)
        // for "still needs a project", without touching the existing
        // status colors (overdue/today/upcoming/completed) it's shown
        // alongside.
        isUnassigned: !!p.isUnassignedBucket,
        mu
      });
    });
  });
  return events;
}
// Builds a date string from a Date's own local Y/M/D components — never
// through toISOString() here, since that converts local midnight to UTC
// and can silently shift the date backward a day in positive-offset
// timezones. mu.date itself is already a plain "YYYY-MM-DD" string (from a
// <input type=date>, no timezone attached), so this has to match that
// exactly for day cells to line up with the right events.
function calGridDateStr(d){
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const CAL_DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CAL_VIEW_MODES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
function calWeekStart(d){
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
}
// Prev/Next steps by a whole period at once — which one depends on
// whatever view is currently showing, so Month view still pages by
// month, Week view by week, etc.
export function calStepView(date, mode, dir){
  const d = new Date(date);
  if(mode === 'day') d.setDate(d.getDate() + dir);
  else if(mode === 'week') d.setDate(d.getDate() + dir * 7);
  else if(mode === 'year') d.setFullYear(d.getFullYear() + dir);
  else d.setMonth(d.getMonth() + dir);
  return d;
}
function calHeaderLabel(viewDate, mode){
  if(mode === 'day') return viewDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if(mode === 'year') return String(viewDate.getFullYear());
  if(mode === 'week'){
    const start = calWeekStart(viewDate);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    // toLocaleDateString with {day, year} but no month isn't a reliably
    // supported Intl combination (some ICU builds return garbled output
    // for it) -- build the same-month "22, 2026" tail by hand instead.
    const endLabel = sameMonth
      ? `${end.getDate()}, ${end.getFullYear()}`
      : end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${startLabel} – ${endLabel}`;
  }
  return viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
// Shared by Month/Week views -- one day's worth of event chips, each
// opening the project's Activities Updates on click, with a hover
// tooltip carrying the full project name + text (see .cal-event-tooltip)
// since the chip itself truncates to fit the cell.
function calEventChipHtml(ev, todayStr){
  const status = getTaskStatus(ev.mu, todayStr);
  return `
    <div class="cal-event-wrap">
      <button type="button" class="cal-event cal-event-${status}${ev.isUnassigned ? ' cal-event-unassigned' : ''} action-go-btn" data-item-type="project" data-item-id="${escapeHtml(ev.projectId)}" data-focus-section="activities">${escapeHtml(ev.text)}</button>
      <div class="cal-event-tooltip"><b>${escapeHtml(ev.projectName)}</b><br>${escapeHtml(ev.text)}${ev.isUnassigned ? '<br><i>Not yet on a project</i>' : ''}</div>
    </div>
  `;
}
function renderCalMonthGrid(viewDate, eventsByDate, todayStr){
  const year = viewDate.getFullYear(), month = viewDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startDow = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;
  const gridStart = new Date(year, month, 1 - startDow);

  let cellsHtml = '';
  for(let i = 0; i < totalCells; i++){
    const cellDate = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const dStr = calGridDateStr(cellDate);
    const inMonth = cellDate.getMonth() === month;
    const isToday = dStr === todayStr;
    const dayEvents = (eventsByDate[dStr] || []).sort((a, b) => (a.projectName || '').localeCompare(b.projectName || ''));
    const dayLabel = cellDate.getDate() === 1
      ? `${cellDate.toLocaleDateString('en-US', { month: 'short' })} ${cellDate.getDate()}`
      : String(cellDate.getDate());
    cellsHtml += `
      <div class="cal-cell cal-cell-clickable${inMonth ? '' : ' cal-cell-outmonth'}${isToday ? ' cal-cell-today' : ''}" data-cal-date="${dStr}">
        <div class="cal-cell-date">${escapeHtml(dayLabel)}</div>
        <div class="cal-cell-events">${dayEvents.map(ev => calEventChipHtml(ev, todayStr)).join('')}</div>
      </div>
    `;
  }
  return `
    <div class="cal-dow-row">${CAL_DOW_NAMES.map(n => `<div class="cal-dow">${n}</div>`).join('')}</div>
    <div class="cal-grid">${cellsHtml}</div>
  `;
}
// One row, one week -- same cell markup as Month view (taller, via
// .cal-grid-week) so a busier week has more room per day to show text
// instead of truncating as aggressively.
function renderCalWeekGrid(viewDate, eventsByDate, todayStr){
  const start = calWeekStart(viewDate);
  let cellsHtml = '';
  for(let i = 0; i < 7; i++){
    const cellDate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const dStr = calGridDateStr(cellDate);
    const isToday = dStr === todayStr;
    const dayEvents = (eventsByDate[dStr] || []).sort((a, b) => (a.projectName || '').localeCompare(b.projectName || ''));
    cellsHtml += `
      <div class="cal-cell cal-cell-clickable${isToday ? ' cal-cell-today' : ''}" data-cal-date="${dStr}">
        <div class="cal-cell-date">${escapeHtml(cellDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</div>
        <div class="cal-cell-events">${dayEvents.map(ev => calEventChipHtml(ev, todayStr)).join('')}</div>
      </div>
    `;
  }
  return `
    <div class="cal-dow-row">${CAL_DOW_NAMES.map(n => `<div class="cal-dow">${n}</div>`).join('')}</div>
    <div class="cal-grid cal-grid-week">${cellsHtml}</div>
  `;
}
// A single day's events as a plain agenda list -- there's only one day's
// worth of room to fill, so full project name + text both show without
// needing the Month/Week chip's hover tooltip.
function renderCalDayAgenda(viewDate, eventsByDate, todayStr){
  const dStr = calGridDateStr(viewDate);
  const dayEvents = (eventsByDate[dStr] || []).sort((a, b) => (a.projectName || '').localeCompare(b.projectName || ''));
  const addBtnHtml = `<button type="button" class="btn btn-sm cal-day-add-btn" data-cal-date="${dStr}">${icon('plus', 14)} Add Plan</button>`;
  if(!dayEvents.length) return `<div class="cal-day-agenda-empty">No activities on this day${addBtnHtml}</div>`;
  return `
    <div class="cal-day-agenda">
      ${dayEvents.map(ev => {
        const status = getTaskStatus(ev.mu, todayStr);
        return `
          <button type="button" class="cal-day-event cal-day-event-${status}${ev.isUnassigned ? ' cal-day-event-unassigned' : ''} action-go-btn" data-item-type="project" data-item-id="${escapeHtml(ev.projectId)}" data-focus-section="activities">
            <span class="cal-day-event-project">${escapeHtml(ev.projectName)}${ev.isUnassigned ? ' <i>(no project yet)</i>' : ''}</span>
            <span class="cal-day-event-text">${escapeHtml(ev.text)}</span>
          </button>
        `;
      }).join('')}
      ${addBtnHtml}
    </div>
  `;
}
// 12 read-only mini-months, each day just a dot for "something's due"
// rather than real event chips (nowhere near enough room to show text at
// this scale) -- click a month to jump into Month view for it.
function renderCalYearGrid(viewDate, eventsByDate){
  const year = viewDate.getFullYear();
  let monthsHtml = '';
  for(let m = 0; m < 12; m++){
    const firstOfMonth = new Date(year, m, 1);
    const startDow = firstOfMonth.getDay();
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;
    const gridStart = new Date(year, m, 1 - startDow);
    let dayCellsHtml = '';
    for(let i = 0; i < totalCells; i++){
      const cellDate = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const inMonth = cellDate.getMonth() === m;
      const hasEvents = inMonth && (eventsByDate[calGridDateStr(cellDate)] || []).length > 0;
      dayCellsHtml += `<div class="cal-mini-cell${inMonth ? '' : ' cal-mini-cell-outmonth'}${hasEvents ? ' cal-mini-cell-has-events' : ''}">${inMonth ? cellDate.getDate() : ''}</div>`;
    }
    monthsHtml += `
      <button type="button" class="cal-mini-month" data-cal-jump-month="${m}">
        <div class="cal-mini-month-title">${escapeHtml(firstOfMonth.toLocaleDateString('en-US', { month: 'long' }))}</div>
        <div class="cal-mini-grid">${dayCellsHtml}</div>
      </button>
    `;
  }
  return `<div class="cal-year-grid">${monthsHtml}</div>`;
}
// One pane's <select> options: All, then every named person, then
// Unassigned if there's anyone to show there -- same three-way split
// renderCalendarCardHtml's Who filter already uses.
function renderCalPaneWhoOptionsHtml(selected, namedWhoOptions, hasUnassignedEvents){
  return `
    <option value="${CAL_PANE_ALL}" ${selected === CAL_PANE_ALL ? 'selected' : ''}>All</option>
    ${namedWhoOptions.map(w => `<option value="${escapeHtml(w)}" ${selected === w ? 'selected' : ''}>${escapeHtml(w)}</option>`).join('')}
    ${hasUnassignedEvents ? `<option value="${CAL_WHO_UNASSIGNED}" ${selected === CAL_WHO_UNASSIGNED ? 'selected' : ''}>Unassigned</option>` : ''}
  `;
}
// filteredEvents has already been through the shared Who checklist filter
// above -- a pane just narrows that further to the one person (or
// Unassigned, or nobody further narrowed at all for All) it's set to.
function renderCalPaneHtml(pane, viewDate, filteredEvents, mode, todayStr, namedWhoOptions, hasUnassignedEvents, canRemove){
  const paneEvents = pane.who === CAL_PANE_ALL
    ? filteredEvents
    : filteredEvents.filter(ev => (ev.who || CAL_WHO_UNASSIGNED) === pane.who);
  const eventsByDate = {};
  paneEvents.forEach(ev => {
    (eventsByDate[ev.date] || (eventsByDate[ev.date] = [])).push(ev);
  });
  const bodyHtml = mode === 'day' ? renderCalDayAgenda(viewDate, eventsByDate, todayStr)
    : mode === 'week' ? renderCalWeekGrid(viewDate, eventsByDate, todayStr)
    : mode === 'year' ? renderCalYearGrid(viewDate, eventsByDate)
    : renderCalMonthGrid(viewDate, eventsByDate, todayStr);
  return `
    <div class="cal-pane${pane.expanded ? ' cal-pane-expanded' : ''}">
      <div class="cal-pane-header">
        <select class="cal-pane-who-select" data-cal-pane-id="${escapeHtml(pane.id)}">
          ${renderCalPaneWhoOptionsHtml(pane.who, namedWhoOptions, hasUnassignedEvents)}
        </select>
        <button type="button" class="icon-btn cal-pane-expand-toggle" data-cal-pane-id="${escapeHtml(pane.id)}" title="${pane.expanded ? 'Restore to half width' : 'Expand to full width'}">${pane.expanded ? '⤡' : '⤢'}</button>
        ${canRemove ? `<button type="button" class="icon-btn cal-pane-remove" data-cal-pane-id="${escapeHtml(pane.id)}" title="Remove this window">${icon('x', 14)}</button>` : ''}
      </div>
      ${bodyHtml}
    </div>
  `;
}
export function renderCalendarCardHtml(viewDate, events){
  // Matches the rest of the app's existing (if imperfect in far-west
  // timezones) "today" convention — see getTaskStatus/computeTaskTracking
  // — so a task the calendar colors as overdue agrees with Task Tracking.
  const todayStr = new Date().toISOString().slice(0, 10);
  const mode = homeCalendarViewMode;
  // Options list comes from *every* event, before filtering -- same as
  // Task Tracking's Who options -- so picking one person doesn't make
  // the others disappear from the list. Events with no assignee get their
  // own checkbox too (CAL_WHO_UNASSIGNED stands in for '' as the Set
  // member/checkbox value, since an empty checkbox value is awkward to
  // read back reliably) rather than just being dropped from the filter
  // entirely.
  const namedWhoOptions = [...new Set(events.map(ev => ev.who).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const hasUnassignedEvents = events.some(ev => !ev.who);
  const allWhoValues = hasUnassignedEvents ? [...namedWhoOptions, CAL_WHO_UNASSIGNED] : namedWhoOptions;
  const allWhoSelected = allWhoValues.length > 0 && allWhoValues.every(v => homeCalendarWhoFilters.has(v));
  const filteredEvents = homeCalendarWhoFilters.size
    ? events.filter(ev => homeCalendarWhoFilters.has(ev.who || CAL_WHO_UNASSIGNED))
    : events;

  const panesHtml = homeCalendarPanes.map(pane =>
    renderCalPaneHtml(pane, viewDate, filteredEvents, mode, todayStr, namedWhoOptions, hasUnassignedEvents, homeCalendarPanes.length > 1)
  ).join('');

  return `
    <div class="dash-card" id="activitiesCalendarCard" style="margin-bottom:14px;">
      <div class="cal-header-bar">
        <div class="dash-card-title" style="margin-bottom:0;">Activities Calendar</div>
        <div class="cal-nav">
          <div class="task-tracking-who-filter-wrap">
            <button type="button" class="btn btn-sm${homeCalendarWhoFilters.size ? ' active' : ''}" id="calWhoTrigger">
              Who${homeCalendarWhoFilters.size ? ` (${homeCalendarWhoFilters.size})` : ''} ${icon('chevron-down', 12)}
            </button>
            <div class="proj-col-filter-menu${homeCalendarWhoMenuOpen ? ' open' : ''}" id="calWhoMenu">
              ${allWhoValues.length ? `
              <label class="proj-col-filter-item proj-col-filter-selectall">
                <input type="checkbox" id="calWhoSelectAll" ${allWhoSelected ? 'checked' : ''}>
                <b>(Select All)</b>
              </label>
              <div class="proj-col-filter-values">
                ${namedWhoOptions.map(w => `
                  <label class="proj-col-filter-item">
                    <input type="checkbox" class="cal-who-cb" value="${escapeHtml(w)}" ${homeCalendarWhoFilters.has(w) ? 'checked' : ''}>
                    ${escapeHtml(w)}
                  </label>
                `).join('')}
                ${hasUnassignedEvents ? `
                  <label class="proj-col-filter-item">
                    <input type="checkbox" class="cal-who-cb" value="${CAL_WHO_UNASSIGNED}" ${homeCalendarWhoFilters.has(CAL_WHO_UNASSIGNED) ? 'checked' : ''}>
                    Unassigned
                  </label>
                ` : ''}
              </div>
              ${homeCalendarWhoFilters.size ? `<button type="button" class="btn btn-sm" id="calClearWhoFilters" style="margin-top:6px;width:100%;">Clear filter</button>` : ''}
              ` : `<div class="dash-empty" style="padding:4px;">No one assigned yet</div>`}
            </div>
          </div>
          <div class="cal-view-switch">
            ${CAL_VIEW_MODES.map(([key, label]) => `<button type="button" class="cal-view-btn${mode === key ? ' active' : ''}" data-cal-view="${key}">${label}</button>`).join('')}
          </div>
          <button type="button" class="btn btn-sm" id="calToday">Today</button>
          <button type="button" class="icon-btn" id="calPrevPeriod" title="Previous">‹</button>
          <span class="cal-month-label">${escapeHtml(calHeaderLabel(viewDate, mode))}</span>
          <button type="button" class="icon-btn" id="calNextPeriod" title="Next">›</button>
        </div>
      </div>
      <div class="cal-panes-grid${homeCalendarPanes.length === 1 ? ' cal-panes-grid-single' : ''}">${panesHtml}</div>
      <button type="button" class="btn btn-sm cal-add-pane-btn" id="calAddPane">${icon('plus', 14)} Add window</button>
    </div>
  `;
}
