// The navbar Notifications bell -- merges the sign-in log with the
// add/edit/delete activity log into one feed, plus the "what changed"
// Activity Changes modal. Split out of app.js -- see app.js's own
// top-of-file comment for the overall file split.
import { escapeHtml, formatActivityDateTime, loginEvents, activityEvents } from './app.js';

// "Unread" is tracked client-side only (localStorage, per browser) against
// the newest sign-in the user has actually opened this panel to see —
// there's no per-user read-state stored in Firestore for this, since it's
// just a lightweight badge count, not something that needs to sync across
// devices.
export const LOGIN_EVENTS_LAST_SEEN_KEY = 'forgeLastSeenLoginEventAt';
const ACTIVITY_ENTITY_LABELS = { recipe: 'Recipe', project: 'Project', trial: 'Test', material: 'Ingredient', submission: 'Submission' };
const ACTIVITY_VERB_LABELS = { created: 'added', updated: 'edited', deleted: 'deleted', imported: 'imported', rejected: 'rejected' };
// Merges the sign-in log with the add/edit/delete activity log into one
// feed, newest first — this is the only place the two collections meet;
// everywhere else (attachLoginEventsListener/attachActivityEventsListener)
// they're loaded and stored completely separately.
export function renderNotificationsBell(){
  const list = document.getElementById('navbarNotifList');
  const badge = document.getElementById('navbarNotifBadge');
  if(!list || !badge) return;
  const merged = [
    ...loginEvents.map(ev => ({ at: ev.timestamp, title: `${ev.email || 'Unknown'} signed in`, by: '', id: null, changes: [] })),
    ...activityEvents.map(ev => ({
      at: ev.at,
      title: `${ACTIVITY_ENTITY_LABELS[ev.entityType] || ev.entityType} "${ev.entityName || 'Untitled'}" ${ACTIVITY_VERB_LABELS[ev.type] || ev.type}`,
      by: `by ${ev.by || 'Unknown'}`,
      id: ev.id,
      changes: ev.changes || []
    }))
  ].sort((a, b) => b.at - a.at).slice(0, 50);
  list.innerHTML = merged.length
    ? merged.map(item => `
        <div class="navbar-notif-item${item.changes.length ? ' navbar-notif-item-clickable' : ''}" ${item.changes.length ? `data-activity-id="${escapeHtml(item.id)}"` : ''}>
          <div class="ni-email">${escapeHtml(item.title)}</div>
          ${item.by ? `<div class="ni-by">${escapeHtml(item.by)}</div>` : ''}
          <div class="ni-time">${escapeHtml(formatActivityDateTime(item.at) || '')}</div>
          ${item.changes.length ? `<div class="ni-changes-hint">${item.changes.length} field${item.changes.length === 1 ? '' : 's'} changed — click to view</div>` : ''}
        </div>
      `).join('')
    : '<div class="navbar-notif-empty">No activity recorded yet</div>';
  list.querySelectorAll('[data-activity-id]').forEach(el => {
    el.addEventListener('click', () => {
      const ev = activityEvents.find(e => e.id === el.dataset.activityId);
      if(ev) openActivityChangesModal(ev);
    });
  });
  const lastSeen = Number(localStorage.getItem(LOGIN_EVENTS_LAST_SEEN_KEY) || 0);
  const unreadCount = merged.filter(item => item.at > lastSeen).length;
  badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
  badge.style.display = unreadCount > 0 ? 'flex' : 'none';
}

// Opens the "what changed" modal for one activity event — see the
// [data-activity-id] click wiring right above, in renderNotificationsBell.
function openActivityChangesModal(ev){
  const entityLabel = ACTIVITY_ENTITY_LABELS[ev.entityType] || ev.entityType;
  document.getElementById('activityChangesTitle').textContent = `${entityLabel} "${ev.entityName || 'Untitled'}"`;
  const list = document.getElementById('activityChangesList');
  const changes = ev.changes || [];
  list.innerHTML = `
    <p style="font-size:12px;color:var(--text-dim);margin-top:0;">Edited by ${escapeHtml(ev.by || 'Unknown')} · ${escapeHtml(formatActivityDateTime(ev.at) || '')}</p>
    ${changes.length ? changes.map(c => `
      <div class="activity-change-row">
        <div class="activity-change-field">${escapeHtml(c.field)}</div>
        <div class="activity-change-values">
          <span class="activity-change-before">${escapeHtml(c.before)}</span>
          <span class="activity-change-arrow">→</span>
          <span class="activity-change-after">${escapeHtml(c.after)}</span>
        </div>
      </div>
    `).join('') : '<div class="overview-empty">No field changes recorded for this edit</div>'}
  `;
  document.getElementById('activityChangesModalOverlay').classList.add('open');
}
export function initActivityChangesModal(){
  document.getElementById('btnCloseActivityChanges').addEventListener('click', () => {
    document.getElementById('activityChangesModalOverlay').classList.remove('open');
  });
  document.getElementById('activityChangesModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'activityChangesModalOverlay') document.getElementById('activityChangesModalOverlay').classList.remove('open');
  });
}
