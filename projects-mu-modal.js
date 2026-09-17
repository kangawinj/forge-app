// Product Log popup + Monthly Update Edit modal -- two self-contained
// on-demand dialogs, split out of projects.js. See projects.js's own
// top-of-file comment for the overall file split.
import {
  escapeHtml, formatActivityDateTime, PROJECT_STAGES, logActivityEvent,
  diffMainFields, snapshotMainFields, wireModalOverlayClose
} from './app.js';
import {
  migrateMonthlyUpdate, muPlanSummaryLine, MU_DIFF_FIELDS, resolveMuCompletedDate,
  scheduleProjectSave
} from './projects-data.js';
import { muAttachmentChipsHtml, openMuAttachmentPreview, fileToMuAttachment } from './projects-attachments.js';
// Circular import back to core projects.js -- safe, same pattern proven
// throughout this session's other splits: every cross-call below happens
// inside an event handler, never at module-evaluation time.
import {
  projects, renderProjectsList, muRecipeOptionsHtml, wireMuTranslateButton,
  wireWhereLocationPicker, maybeAutoCreateNextPlan, addProductLogEntry,
  muEditSnapshotBefore, setMuEditSnapshotBefore
} from './projects.js';

/* ---------- Product progress log modal ---------- */
let productLogContext = null; // { projectId, productId }

function getProductLogTarget(){
  if(!productLogContext) return null;
  const p = projects.find(x => x.id === productLogContext.projectId);
  if(!p) return null;
  return p.products.find(x => x.id === productLogContext.productId) || null;
}

export function openProductLogModal(projectId, productId){
  productLogContext = { projectId, productId };
  const select = document.getElementById('productLogStageSelect');
  select.innerHTML = PROJECT_STAGES.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  const product = getProductLogTarget();
  if(product) select.value = product.stage;
  document.getElementById('productLogNoteInput').value = '';
  renderProductLog();
  document.getElementById('productLogModalOverlay').classList.add('open');
}
export function closeProductLogModal(){
  document.getElementById('productLogModalOverlay').classList.remove('open');
  productLogContext = null;
}
export function renderProductLog(){
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
let muEditModalAttachments = [];

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
export function openMuEditModal(projectId, updateId, section){
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
  document.getElementById('muEditModalWith').value = mu.planWith || '';
  document.getElementById('muEditModalOwner').value = mu.planOwner || target.p.responsiblePerson || '';
  document.getElementById('muEditModalAction').value = mu.actionTaken || '';
  document.getElementById('muEditModalNextActionDue').value = mu.nextActionDue || '';
  document.getElementById('muEditModalNextActionTime').value = mu.nextActionTime || '';
  document.getElementById('muEditModalNextActionWho').value = mu.nextActionWho || '';
  document.getElementById('muEditModalNextAction').value = mu.nextAction || '';
  document.getElementById('muEditModalNextActionWhere').value = mu.nextActionWhere || '';
  document.getElementById('muEditModalNextActionWhere').dispatchEvent(new Event('input'));
  document.getElementById('muEditModalNextActionWith').value = mu.nextActionWith || '';
  document.getElementById('muEditModalNextActionOwner').value = mu.nextActionOwner || target.p.responsiblePerson || '';
  document.getElementById('muEditModalCompletedDate').value = mu.completedDate || '';
  document.getElementById('muEditModalAutoCreate').checked = !!mu.autoCreatePlan;
  document.getElementById('muEditModalRecipe').innerHTML = muRecipeOptionsHtml(mu.linkedRecipeId);
  muEditModalAttachments = (mu.attachments || []).map(a => ({...a}));
  redrawMuEditModalAttachments();
  setMuEditSnapshotBefore(snapshotMainFields(mu, MU_DIFF_FIELDS));
  // Only the Unassigned bucket project (see quickAddCalendarPlan) ever
  // shows the Project picker -- an entry already on a real project never
  // needed a "which project" question in the first place.
  const projectFieldEl = document.getElementById('muEditModalProjectField');
  if(target.p.isUnassignedBucket){
    const realProjects = projects.filter(x => !x.isUnassignedBucket)
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    document.getElementById('muEditModalProjectDatalist').innerHTML = realProjects.map(x => `<option value="${escapeHtml(x.name || 'Untitled project')}">`).join('');
    document.getElementById('muEditModalProjectInput').value = '';
    projectFieldEl.style.display = '';
  }else{
    projectFieldEl.style.display = 'none';
  }
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
export function closeMuEditModal(){
  // A blank entry quickAddCalendarPlan created that never got filled in
  // (Cancel, ✕, or the backdrop) shouldn't linger as a permanent empty
  // stub on the calendar -- quietly remove it instead. saveMuEditModal
  // already refuses to save a genuinely empty entry, so this can only
  // ever be reached via one of those three close paths, never a real
  // save.
  const target = getMuEditModalTarget();
  if(target?.mu.createdFromCalendar && !target.mu.plan && !target.mu.actionTaken
    && !target.mu.nextAction && !target.mu.planWho && !target.mu.planWhere
    && !target.mu.planWith && !target.mu.planOwner){
    target.p.monthlyUpdates = (target.p.monthlyUpdates || []).filter(x => x.id !== target.mu.id);
    scheduleProjectSave(target.p);
    renderProjectsList();
  }
  document.getElementById('muEditModalOverlay').classList.remove('open');
  muEditModalContext = null;
  muEditModalAttachments = [];
  setMuEditSnapshotBefore(null);
}
export function saveMuEditModal(){
  const target = getMuEditModalTarget();
  if(!target) return;
  const date = document.getElementById('muEditModalDate').value;
  const time = document.getElementById('muEditModalTime').value;
  const planWho = document.getElementById('muEditModalWho').value.trim();
  const plan = document.getElementById('muEditModalPlan').value.trim();
  const planWhere = document.getElementById('muEditModalWhere').value.trim();
  const planWith = document.getElementById('muEditModalWith').value.trim();
  const planOwner = document.getElementById('muEditModalOwner').value.trim();
  const actionTaken = document.getElementById('muEditModalAction').value.trim();
  const nextActionTime = document.getElementById('muEditModalNextActionTime').value;
  const nextActionWho = document.getElementById('muEditModalNextActionWho').value.trim();
  const nextAction = document.getElementById('muEditModalNextAction').value.trim();
  const nextActionWhere = document.getElementById('muEditModalNextActionWhere').value.trim();
  const nextActionWith = document.getElementById('muEditModalNextActionWith').value.trim();
  const nextActionOwner = document.getElementById('muEditModalNextActionOwner').value.trim();
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
  mu.planWith = planWith;
  mu.planOwner = planOwner;
  mu.actionTaken = actionTaken;
  mu.nextActionTime = nextActionTime;
  mu.nextActionWho = nextActionWho;
  mu.nextAction = nextAction;
  mu.nextActionWhere = nextActionWhere;
  mu.nextActionWith = nextActionWith;
  mu.nextActionOwner = nextActionOwner;
  mu.nextActionDue = nextActionDue;
  mu.autoCreatePlan = autoCreatePlan;
  mu.linkedRecipeId = linkedRecipeId;
  mu.attachments = muEditModalAttachments;
  mu.completedDate = completedDate;
  const muChanges = diffMainFields(muEditSnapshotBefore, mu, MU_DIFF_FIELDS);
  const autoCreateOk = maybeAutoCreateNextPlan(p, mu);
  scheduleProjectSave(p);
  logActivityEvent('updated', 'project', p.name || 'Untitled project', muChanges);
  muEditModalAttachments = [];
  closeMuEditModal();
  renderProjectsList();
  if(!autoCreateOk) alert('"Create as Plan automatically" was checked, but no follow-up Plan was created — Next Action Activity and its due date ("When") must both be filled in first.');
}

// Button wiring for both dialogs above -- was previously inlined in core
// projects.js's initProjectsModal, moved here alongside the state/handlers
// it wires since it's entirely about these two modals.
export function wireProjectModals(){
  document.getElementById('btnCloseProductLogModal').addEventListener('click', closeProductLogModal);
  wireModalOverlayClose('productLogModalOverlay', closeProductLogModal);
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
  wireModalOverlayClose('muEditModalOverlay', closeMuEditModal);
  document.getElementById('btnSaveMuEditModal').addEventListener('click', saveMuEditModal);
  // Only visible while editing an entry still on the Unassigned bucket
  // project (see openMuEditModal) -- picking one here moves the entry
  // over immediately, rather than waiting for Save, so the rest of the
  // popup (which now targets the new project) and the calendar's own
  // "still unassigned" marker both update right away. A plain text input
  // (list=muEditModalProjectDatalist) instead of a <select> so a long
  // project list can be typed/searched instead of scrolled -- matched
  // back to a real project by exact name, same as every other
  // datalist-backed field in this app (e.g. the Customer Name field's
  // country auto-fill).
  document.getElementById('muEditModalProjectInput').addEventListener('change', e => {
    const typedName = e.target.value.trim();
    if(!typedName) return;
    const target = getMuEditModalTarget();
    const targetProject = projects.find(x => !x.isUnassignedBucket && (x.name || '').trim() === typedName);
    if(!target || !targetProject) return;
    target.p.monthlyUpdates = (target.p.monthlyUpdates || []).filter(x => x.id !== target.mu.id);
    scheduleProjectSave(target.p);
    if(!Array.isArray(targetProject.monthlyUpdates)) targetProject.monthlyUpdates = [];
    targetProject.monthlyUpdates.push(target.mu);
    scheduleProjectSave(targetProject);
    logActivityEvent('updated', 'project', targetProject.name || 'Untitled project',
      [{ field: 'Activities Updates', before: 'Unassigned', after: `Moved here: "${muPlanSummaryLine(target.mu) || 'Untitled'}"` }]);
    muEditModalContext = { projectId: targetProject.id, updateId: target.mu.id };
    document.getElementById('muEditModalProjectField').style.display = 'none';
    renderProjectsList();
  });
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
