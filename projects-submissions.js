// Public-intake review workflow: the Share Link panel and the Pending
// Submissions queue/history/review form (reject, delete, save-as-draft).
// "Import as Project" itself (completeSubmissionImport below is its
// last step) stays in core projects.js since it writes straight into
// the New Project panel's own editing state -- see that function's own
// comment. Split out of projects.js -- see projects.js's own
// top-of-file comment for the overall file split.
import {
  escapeHtml, icon, currentUser, uid, myProfile, formatActivityDateTime,
  logActivityEvent, requestAuthConfirm, pendingSubmissionsCol, activityEventsCol,
  metaLists, metaItemName, trialStringListHtml
} from './app.js';
import {
  onSnapshot, setDoc, deleteDoc, doc, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, CURRENCY_OPTIONS, blankFlavor, selectTextOnFocus } from './projects-data.js';
import {
  blankCookingCondition, getCookingConditions, certificateChecklistHtml, getCertificate,
  wireCertificateChecklist, readCertificateChecklist
} from './projects-requirements.js';

let shareLinkOpen = false;
const SHARE_LINK_URL = `${location.origin}/submit.html`;
export function toggleSharePanel(){
  shareLinkOpen = !shareLinkOpen;
  renderSharePanel();
}
export function renderSharePanel(){
  const panel = document.getElementById('shareLinkPanel');
  if(!panel) return;
  if(!shareLinkOpen){ panel.innerHTML = ''; return; }
  panel.innerHTML = `
    <div class="card" style="margin:0 0 16px;background:var(--bg);">
      <div class="field" style="margin-bottom:8px;">
        <label>Share this link with anyone — no Forge account or login needed. Anyone with it can add their own project request; it's the same link every time.</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="shareLinkInput" readonly value="${escapeHtml(SHARE_LINK_URL)}" style="flex:1;">
          <button type="button" class="btn btn-sm" id="btnCopyShareLink">Copy</button>
        </div>
      </div>
      <button type="button" class="btn btn-sm proj-action-cancel" id="btnCloseSharePanel">Close</button>
    </div>
  `;
  document.getElementById('btnCopyShareLink').addEventListener('click', async () => {
    const input = document.getElementById('shareLinkInput');
    input.select();
    try{
      await navigator.clipboard.writeText(SHARE_LINK_URL);
      document.getElementById('btnCopyShareLink').textContent = 'Copied!';
      setTimeout(() => { const b = document.getElementById('btnCopyShareLink'); if(b) b.textContent = 'Copy'; }, 1500);
    }catch{
      // Clipboard API can be blocked (permissions, non-HTTPS context) --
      // the input is already selected above as a manual fallback.
    }
  });
  document.getElementById('btnCloseSharePanel').addEventListener('click', () => {
    shareLinkOpen = false;
    renderSharePanel();
  });
}

// Live count of open (submissionStatus 'pending') submissions, shown as a
// badge on the "Pending Submissions" button -- kept live for the whole
// session (started alongside the main projects listener, torn down on
// sign-out) rather than only while the Projects page happens to be open,
// so the badge is already accurate the moment someone lands there.
export let pendingSubmissionsCount = 0;
let unsubscribePendingSubmissions = null;
// Called from core projects.js's resetProjectsState (the shared sign-out
// handler needs this module's listener torn down too, but can't reach
// unsubscribePendingSubmissions/pendingSubmissionsCount directly -- same
// reasoning as completeSubmissionImport above).
export function resetPendingSubmissionsState(){
  if(unsubscribePendingSubmissions){ unsubscribePendingSubmissions(); unsubscribePendingSubmissions = null; }
  pendingSubmissionsCount = 0;
}
export function attachPendingSubmissionsListener(){
  unsubscribePendingSubmissions = onSnapshot(
    query(pendingSubmissionsCol, where('submissionStatus', '==', 'pending')),
    snap => {
      pendingSubmissionsCount = snap.size;
      const badge = document.getElementById('pendingSubmissionsBadge');
      if(badge){
        badge.textContent = String(pendingSubmissionsCount);
        badge.style.display = pendingSubmissionsCount ? 'inline-flex' : 'none';
      }
    },
    err => console.error('Forge: pending submissions listener error', err)
  );
}

let pendingSubmissionsOpen = false;
let pendingSubmissionsList = null; // null = not fetched yet this time it's opened
// Which sub-view the panel shows when it's open and nothing's being
// reviewed: the live 'pending' queue, or the read-only 'history' of past
// Import/Reject/Delete decisions (see submissionHistory below).
let pendingSubmissionsView = 'pending';
let submissionHistory = null; // null = not fetched yet this time History was opened
// The submission currently open for review/edit (a plain staged copy, id
// included) -- non-null switches the panel from the list to the review
// form. Its own Cooking Guidelines steps are staged separately, same
// "array you edit in place, re-render on every change" pattern the New
// Project panel already uses for the same field.
export let reviewingSubmission = null;
// The submission's own Cooking Guidelines groups, staged the same way --
// see reviewCookingGuidelinesHtml/wireReviewCookingGuidelines below.
let reviewingCookingGuidelines = [];
// The submission's own Product table, staged the same way -- see
// reviewFlavorTableHtml/wireReviewFlavorTable below.
let reviewingFlavors = [];
const SUBMISSION_HISTORY_VERB_LABELS = { imported: 'Imported as Project', rejected: 'Rejected', deleted: 'Deleted' };

export async function togglePendingSubmissionsPanel(){
  pendingSubmissionsOpen = !pendingSubmissionsOpen;
  if(pendingSubmissionsOpen && pendingSubmissionsView === 'pending' && !pendingSubmissionsList){
    await refreshPendingSubmissions();
  }else if(pendingSubmissionsOpen && pendingSubmissionsView === 'history' && !submissionHistory){
    await refreshSubmissionHistory();
  }else{
    renderPendingSubmissionsPanel();
  }
}
async function refreshPendingSubmissions(){
  const panel = document.getElementById('pendingSubmissionsPanel');
  if(panel) panel.innerHTML = '<div class="card" style="margin:0 0 16px;"><div class="overview-empty">Loading…</div></div>';
  try{
    const snap = await getDocs(query(pendingSubmissionsCol, where('submissionStatus', '==', 'pending')));
    pendingSubmissionsList = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }catch(err){
    pendingSubmissionsList = [];
    alert('Could not load pending submissions: ' + (err.message || err));
  }
  renderPendingSubmissionsPanel();
}
// The submission doc itself is deleted (or moved past editing) once
// decided, so this reads from the app's existing append-only activity
// log instead -- entityType 'submission' entries are only ever written
// from importSubmission()/rejectSubmission()/deleteSubmission() below.
// Filtered client-side (not a composite where+orderBy query) so this
// never needs its own Firestore index.
async function refreshSubmissionHistory(){
  const panel = document.getElementById('pendingSubmissionsPanel');
  if(panel) panel.innerHTML = '<div class="card" style="margin:0 0 16px;"><div class="overview-empty">Loading…</div></div>';
  try{
    const snap = await getDocs(query(activityEventsCol, where('entityType', '==', 'submission')));
    submissionHistory = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, 100);
  }catch(err){
    submissionHistory = [];
    alert('Could not load submission history: ' + (err.message || err));
  }
  renderPendingSubmissionsPanel();
}
async function switchPendingSubmissionsView(view){
  if(pendingSubmissionsView === view) return;
  pendingSubmissionsView = view;
  if(view === 'history' && !submissionHistory){
    await refreshSubmissionHistory();
  }else if(view === 'pending' && !pendingSubmissionsList){
    await refreshPendingSubmissions();
  }else{
    renderPendingSubmissionsPanel();
  }
}
export function renderPendingSubmissionsPanel(){
  const panel = document.getElementById('pendingSubmissionsPanel');
  if(!panel) return;
  if(!pendingSubmissionsOpen){ panel.innerHTML = ''; return; }
  if(reviewingSubmission){ renderSubmissionReviewForm(); return; }
  const tabsHtml = `
    <div style="display:flex;gap:6px;margin-bottom:10px;">
      <button type="button" class="btn btn-sm${pendingSubmissionsView === 'pending' ? ' btn-primary' : ''}" data-role="pending-view-tab" data-view="pending">Pending</button>
      <button type="button" class="btn btn-sm${pendingSubmissionsView === 'history' ? ' btn-primary' : ''}" data-role="pending-view-tab" data-view="history">History</button>
    </div>
  `;
  if(pendingSubmissionsView === 'history'){
    const history = submissionHistory || [];
    panel.innerHTML = `
      <div class="card" style="margin:0 0 16px;background:var(--bg);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div class="dash-card-title" style="margin-bottom:0;">Pending Submissions</div>
          <button type="button" class="btn btn-sm" id="btnRefreshSubmissionHistory">Refresh</button>
        </div>
        ${tabsHtml}
        ${history.length ? history.map(ev => `
          <div class="user-admin-row">
            <div class="user-admin-row-main">
              <div class="user-admin-row-email">${escapeHtml(ev.entityName || 'Untitled')}</div>
              <div class="user-admin-row-meta">${escapeHtml(SUBMISSION_HISTORY_VERB_LABELS[ev.type] || ev.type)} by ${escapeHtml(ev.by || 'Unknown')} · ${escapeHtml(formatActivityDateTime(ev.at) || '')}</div>
            </div>
          </div>
        `).join('') : '<div class="overview-empty">No submission history yet</div>'}
      </div>
    `;
    document.getElementById('btnRefreshSubmissionHistory').addEventListener('click', refreshSubmissionHistory);
  }else{
    const list = pendingSubmissionsList || [];
    panel.innerHTML = `
      <div class="card" style="margin:0 0 16px;background:var(--bg);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <div class="dash-card-title" style="margin-bottom:0;">Pending Submissions${list.length ? ` (${list.length})` : ''}</div>
          <button type="button" class="btn btn-sm" id="btnRefreshPendingSubmissions">Refresh</button>
        </div>
        ${tabsHtml}
        ${list.length ? list.map(sub => `
          <div class="user-admin-row" data-submission-id="${escapeHtml(sub.id)}">
            <div class="user-admin-row-main">
              <div class="user-admin-row-email">${escapeHtml(sub.name || '(no project name yet)')}</div>
              <div class="user-admin-row-meta">${escapeHtml(sub.customerName || '')}${sub.customerName && sub.updatedAt ? ' · ' : ''}${sub.updatedAt ? 'Last updated ' + escapeHtml(formatActivityDateTime(sub.updatedAt) || '') : ''}</div>
            </div>
            <div class="user-admin-row-actions">
              <button class="btn btn-sm btn-primary" data-role="review-submission" data-submission-id="${escapeHtml(sub.id)}">Review</button>
            </div>
          </div>
        `).join('') : '<div class="overview-empty">No pending submissions right now</div>'}
      </div>
    `;
    document.getElementById('btnRefreshPendingSubmissions').addEventListener('click', refreshPendingSubmissions);
    panel.querySelectorAll('[data-role="review-submission"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const sub = (pendingSubmissionsList || []).find(s => s.id === btn.dataset.submissionId);
        if(!sub) return;
        reviewingSubmission = { ...sub };
        reviewingCookingGuidelines = getCookingConditions(sub.requirements?.cookingCondition).map(g => ({ id: g.id || uid(), method: g.method, steps: [...g.steps] }));
        reviewingFlavors = (sub.flavors || []).map(f => ({ ...f, id: f.id || uid() }));
        renderPendingSubmissionsPanel();
      });
    });
  }
  panel.querySelectorAll('[data-role="pending-view-tab"]').forEach(btn => {
    btn.addEventListener('click', () => switchPendingSubmissionsView(btn.dataset.view));
  });
}
// Cooking Guidelines editor for the review form -- one or more groups,
// same shape/wiring approach as the New Project panel's own version, but
// only this section's own root re-renders on add/remove (see
// wireReviewCookingGuidelines), never the whole review form, so an
// in-progress edit to a different field on the form isn't lost.
function reviewCookingGuidelinesHtml(){
  return reviewingCookingGuidelines.map((g, gi) => `
    <div class="cooking-guideline-group" data-group-idx="${gi}" style="${gi < reviewingCookingGuidelines.length - 1 ? 'margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border);' : ''}">
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="text" class="sub-review-cooking-method-input" list="cookingMethodDatalist" value="${escapeHtml(g.method)}" placeholder="e.g. Microwave" style="flex:1;">
        ${reviewingCookingGuidelines.length > 1 ? `<button type="button" class="icon-btn" data-role="remove-review-cooking-guideline" title="Remove this guideline">${icon('x')}</button>` : ''}
      </div>
      <div style="margin-top:8px;">
        ${trialStringListHtml(g.steps, true, 'sub-review-cooking-step-input', 'review-step', 'e.g. Reheat from frozen, 2-3 minutes')}
      </div>
    </div>
  `).join('') + `<button type="button" class="btn btn-sm add-row-btn" id="addReviewCookingGuidelineBtn">+ Add Cooking Guidelines</button>`;
}
function renderSubmissionReviewForm(){
  const panel = document.getElementById('pendingSubmissionsPanel');
  const sub = reviewingSubmission;
  const req = sub.requirements || {};
  panel.innerHTML = `
    <div class="card" style="margin:0 0 16px;background:var(--bg);">
      <div class="dash-card-title">Reviewing Submission</div>
      <div class="requirements-box" style="margin-top:0;">
        <div class="requirements-box-title">Project Information</div>
        <div class="project-header-grid">
          <div class="field" style="margin-bottom:0;">
            <label>Project Name</label>
            <input type="text" id="subReviewName" value="${escapeHtml(sub.name)}" placeholder="e.g. Sunrise Foods Q3 Launch">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Status</label>
            <select class="proj-select" id="subReviewStatus">
              ${PROJECT_STATUSES.map(s => `<option value="${escapeHtml(s)}" ${s === sub.status ? 'selected' : ''}>${escapeHtml(PROJECT_STATUS_LABELS[s])}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Request Date</label>
            <input type="date" id="subReviewRequestDate" value="${escapeHtml(sub.requestDate)}">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Start Date</label>
            <input type="date" id="subReviewStartDate" value="${escapeHtml(sub.startDate)}">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Target / End Date</label>
            <input type="date" id="subReviewTargetEndDate" value="${escapeHtml(sub.targetEndDate)}">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Customer Name</label>
            <input type="text" id="subReviewCustomer" value="${escapeHtml(sub.customerName)}" list="customerDatalist" placeholder="e.g. ABC Trading Co.">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Destination Country</label>
            <input type="text" id="subReviewDestination" value="${escapeHtml(sub.destinationCountry)}" list="destinationDatalist" placeholder="e.g. Japan">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Project Owner</label>
            <input type="text" id="subReviewOwner" value="${escapeHtml(sub.ownerSalesRep)}" list="salesRepDatalist" placeholder="e.g. Somchai">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Factory Sales Rep</label>
            <input type="text" id="subReviewFactoryRep" value="${escapeHtml(sub.factorySalesRep)}" list="salesRepDatalist" placeholder="e.g. Preecha">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Responsible Person (PD)</label>
            <input type="text" id="subReviewResponsible" value="${escapeHtml(sub.responsiblePerson)}" list="salesRepDatalist" placeholder="e.g. Kanya">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Factory</label>
            <input type="text" id="subReviewFactory" value="${escapeHtml(sub.factoryName)}" list="customerDatalist" placeholder="e.g. Rayong Plant 2">
          </div>
        </div>
      </div>
      <div class="requirements-box">
        <div class="requirements-box-title">Requirements</div>
        <div class="field" style="margin-bottom:8px;">
          <label>Product</label>
          <div id="reviewFlavorsRoot">${reviewFlavorTableHtml()}</div>
        </div>
        <div class="project-header-grid" style="margin-bottom:8px;">
          <div class="field" style="margin-bottom:0;">
            <label>Portion Weight</label>
            <div class="combo-row">
              <input type="number" id="subReviewPortionQty" value="${escapeHtml(sub.portionWeightQty)}" placeholder="e.g. 20" step="any" min="0">
              <input type="text" id="subReviewPortionUnit" value="${escapeHtml(sub.portionWeightUnit)}" list="unitsDatalist" placeholder="e.g. g">
              <span>/</span>
              <input type="text" id="subReviewPortionPerUnit" value="${escapeHtml(sub.portionPerUnit)}" list="unitsDatalist" placeholder="e.g. pcs">
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Inner Packing</label>
            <div class="combo-row">
              <input type="number" id="subReviewInnerQty" value="${escapeHtml(sub.innerPackQty)}" placeholder="e.g. 30" step="any" min="0">
              <input type="text" id="subReviewInnerWeightUnit" value="${escapeHtml(sub.innerPackWeightUnit)}" list="unitsDatalist" placeholder="e.g. g">
              <span>/</span>
              <input type="text" id="subReviewInnerPackUnit" value="${escapeHtml(sub.innerPackUnit)}" list="unitsDatalist" placeholder="e.g. pack">
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Outer Packing</label>
            <div class="combo-row">
              <input type="number" id="subReviewOuterQty" value="${escapeHtml(sub.outerPackQty)}" placeholder="e.g. 24" step="any" min="0">
              <input type="text" id="subReviewOuterPackUnit" value="${escapeHtml(sub.outerPackUnit)}" list="unitsDatalist" placeholder="e.g. pack">
              <span>/</span>
              <input type="text" id="subReviewOuterContainerUnit" value="${escapeHtml(sub.outerPackContainerUnit)}" list="unitsDatalist" placeholder="e.g. carton">
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>MOQ</label>
            <div class="combo-row">
              <input type="number" id="subReviewMoqQty" value="${escapeHtml(sub.moqQty)}" placeholder="e.g. 500" step="any" min="0">
              <input type="text" id="subReviewMoqUnit" value="${escapeHtml(sub.moqUnit)}" list="unitsDatalist" placeholder="e.g. pcs">
            </div>
          </div>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Packaging condition</label>
          <textarea id="subReviewPackaging" placeholder="e.g. Microwaveable black plastic tray">${escapeHtml(req.packagingCondition)}</textarea>
        </div>
        <div class="project-header-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:8px;">
          <div class="field" style="margin-bottom:0;">
            <label>Storage Condition</label>
            <input type="text" id="subReviewStorageCondition" list="storageConditionDatalist" value="${escapeHtml(req.storageCondition)}" placeholder="e.g. Keep frozen at -18°C">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Shelf Life (from production date)</label>
            <input type="text" id="subReviewShelfLife" value="${escapeHtml(req.shelfLife)}" placeholder="e.g. 12 months">
          </div>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Composition</label>
          <textarea id="subReviewComposition" placeholder="e.g. Teriyaki Sauce: Soy Sauce 40%, Mirin 25%, Sugar 20%, Sake 15%">${escapeHtml(req.composition)}</textarea>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Recipe</label>
          <textarea id="subReviewRecipe" placeholder="Reference / attachment notes">${escapeHtml(req.recipe)}</textarea>
        </div>
        <div class="field requirements-box-divider-below" style="margin-bottom:8px;">
          <label>Cooking Guidelines</label>
          <div id="reviewCookingGuidelinesRoot">${reviewCookingGuidelinesHtml()}</div>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Note</label>
          <textarea id="subReviewNote" placeholder="Anything else not covered above">${escapeHtml(req.note)}</textarea>
        </div>
        <div class="field requirements-box-divider" style="margin-bottom:0;">
          <label>Certificate</label>
          ${certificateChecklistHtml(getCertificate(req.certificate), true)}
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn btn-sm" id="btnSaveSubmissionReview">${icon('save')} Save</button>
        <button class="btn btn-sm proj-action-cancel" id="btnCancelSubmissionReview">${icon('undo-2')} Cancel</button>
        <button class="btn btn-sm btn-danger" id="btnDeleteSubmission">${icon('x')} Delete</button>
        <button class="btn btn-sm btn-danger" id="btnRejectSubmission" style="margin-left:auto;">Reject</button>
        <button class="btn btn-primary btn-sm" id="btnImportSubmission">Import as Project</button>
      </div>
    </div>
  `;
  wireReviewCookingGuidelines();
  wireReviewFlavorTable();
  wireCertificateChecklist(panel);
  document.getElementById('btnSaveSubmissionReview').addEventListener('click', saveSubmissionReview);
  document.getElementById('btnCancelSubmissionReview').addEventListener('click', () => {
    reviewingSubmission = null;
    renderPendingSubmissionsPanel();
  });
  document.getElementById('btnDeleteSubmission').addEventListener('click', deleteSubmission);
  document.getElementById('btnRejectSubmission').addEventListener('click', rejectSubmission);
  document.getElementById('btnImportSubmission').addEventListener('click', importSubmission);
}
// Whoever is signed in right now, in the friendliest form available --
// shown to the (unauthenticated, external) submitter on the public page
// as "handled by", so a raw internal email address isn't the default
// unless that person genuinely never set a Profile display name.
export function currentUserDisplayLabel(){
  return myProfile.displayName || currentUser?.email || 'a team member';
}
async function rejectSubmission(){
  const sub = reviewingSubmission;
  const label = sub.name ? ` ("${sub.name}")` : '';
  if(!confirm(`Reject this submission${label}? The submitter will see it as rejected and won't be able to edit it further.`)) return;
  const btn = document.getElementById('btnRejectSubmission');
  btn.disabled = true;
  try{
    const data = readSubmissionReviewForm();
    await setDoc(doc(pendingSubmissionsCol, sub.id), {
      ...data, submissionStatus: 'rejected', createdAt: sub.createdAt || Date.now(), updatedAt: Date.now(),
      decidedBy: currentUserDisplayLabel(), decidedAt: Date.now()
    });
    logActivityEvent('rejected', 'submission', data.name || sub.name || 'Untitled submission');
    reviewingSubmission = null;
    pendingSubmissionsList = (pendingSubmissionsList || []).filter(s => s.id !== sub.id);
    renderPendingSubmissionsPanel();
  }catch(err){
    alert('Could not reject: ' + (err.message || err));
    btn.disabled = false;
  }
}
function deleteSubmission(){
  const sub = reviewingSubmission;
  const label = sub.name ? ` ("${sub.name}")` : '';
  if(!confirm(`Delete this submission${label}? This cannot be undone.`)) return;
  requestAuthConfirm(
    'Confirm Identity to Delete',
    `Enter your password to delete this submission${label}.`,
    async () => {
      const btn = document.getElementById('btnDeleteSubmission');
      if(btn) btn.disabled = true;
      try{
        await deleteDoc(doc(pendingSubmissionsCol, sub.id));
        logActivityEvent('deleted', 'submission', sub.name || 'Untitled submission');
        reviewingSubmission = null;
        pendingSubmissionsList = (pendingSubmissionsList || []).filter(s => s.id !== sub.id);
        renderPendingSubmissionsPanel();
      }catch(err){
        alert('Could not delete: ' + (err.message || err));
        if(btn) btn.disabled = false;
      }
    }
  );
}
function wireReviewCookingGuidelines(){
  const root = document.getElementById('reviewCookingGuidelinesRoot');
  root.querySelectorAll('.cooking-guideline-group').forEach((groupEl, gi) => {
    const group = reviewingCookingGuidelines[gi];
    if(!group) return;
    groupEl.querySelector('.sub-review-cooking-method-input').addEventListener('change', e => {
      group.method = e.target.value.trim();
      const match = metaLists.cookingMethods.find(m => metaItemName(m) === group.method);
      if(match && (match.steps || []).length){
        group.steps = [...match.steps];
        root.innerHTML = reviewCookingGuidelinesHtml();
        wireReviewCookingGuidelines();
      }
    });
    groupEl.querySelectorAll('.sub-review-cooking-step-input').forEach((inp, idx) => {
      inp.addEventListener('change', () => { group.steps[idx] = inp.value.trim(); });
    });
    groupEl.querySelectorAll('[data-role="remove-review-step"]').forEach(btn => {
      btn.addEventListener('click', () => {
        group.steps.splice(parseInt(btn.dataset.idx, 10), 1);
        root.innerHTML = reviewCookingGuidelinesHtml();
        wireReviewCookingGuidelines();
      });
    });
    groupEl.querySelector('[data-role="add-review-step"]')?.addEventListener('click', () => {
      group.steps.push('');
      root.innerHTML = reviewCookingGuidelinesHtml();
      wireReviewCookingGuidelines();
    });
    groupEl.querySelector('[data-role="remove-review-cooking-guideline"]')?.addEventListener('click', () => {
      reviewingCookingGuidelines.splice(gi, 1);
      root.innerHTML = reviewCookingGuidelinesHtml();
      wireReviewCookingGuidelines();
    });
  });
  document.getElementById('addReviewCookingGuidelineBtn').addEventListener('click', () => {
    reviewingCookingGuidelines.push(blankCookingCondition());
    root.innerHTML = reviewCookingGuidelinesHtml();
    wireReviewCookingGuidelines();
  });
}
// Same columns/fields as the New Project panel's own Product table (see
// blankFlavor/newProjectFlavors) -- only this table's own root re-renders
// on add/remove, never the whole review form, so an in-progress edit to
// a different field on the form isn't lost.
function reviewFlavorTableHtml(){
  const rows = reviewingFlavors.map(f => `
    <tr data-flavor-id="${escapeHtml(f.id)}">
      <td><input type="text" class="flavor-name" value="${escapeHtml(f.name||'')}" placeholder="e.g. Red bean"></td>
      <td><input type="number" class="flavor-sample-qty" value="${escapeHtml(f.sampleQty||'')}" step="any" min="0" placeholder="e.g. 50"></td>
      <td><input type="text" class="flavor-sample-qty-unit" list="unitsDatalist" value="${escapeHtml(f.sampleQtyUnit||'')}" placeholder="e.g. pcs"></td>
      <td><input type="date" class="flavor-sample-request-date" value="${escapeHtml(f.sampleRequestDate||'')}"></td>
      <td><input type="number" class="flavor-target-price" value="${escapeHtml(f.targetPrice||'')}" step="any" min="0"></td>
      <td><input type="number" class="flavor-actual-price" value="${escapeHtml(f.actualPrice||'')}" step="any" min="0"></td>
      <td><select class="proj-select flavor-currency">${CURRENCY_OPTIONS.map(c => `<option value="${c}" ${c === (f.priceCurrency || 'THB') ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
      <td><input type="text" class="flavor-unit" list="unitsDatalist" value="${escapeHtml(f.priceUnit || 'kg')}" placeholder="unit"></td>
      <td><input type="text" class="flavor-formula-ref" value="${escapeHtml(f.formulaRefCode||'')}" placeholder="e.g. JPN01-25"></td>
      <td><input type="text" class="flavor-note" value="${escapeHtml(f.note||'')}" placeholder="Note"></td>
      <td><button type="button" class="icon-btn" title="Delete this product" data-role="remove-review-flavor">${icon('x')}</button></td>
    </tr>
  `).join('');
  return `
    <div class="flavor-table-scroll">
    <table class="flavor-table flavor-table-edit">
      <thead><tr><th>Product</th><th>Sample Qty</th><th>Unit</th><th>Sample Request Date</th><th>Target Price</th><th>Actual Price</th><th>Currency</th><th>Per</th><th>Formula / Reference No.</th><th>Note</th><th></th></tr></thead>
      <tbody class="sub-review-flavors-tbody">${rows}</tbody>
    </table>
    </div>
    <button type="button" class="btn btn-sm add-row-btn" id="addReviewFlavorBtn">+ Add Product</button>
  `;
}
function wireReviewFlavorTable(){
  const root = document.getElementById('reviewFlavorsRoot');
  root.querySelectorAll('.sub-review-flavors-tbody tr[data-flavor-id]').forEach(row => {
    const flavor = reviewingFlavors.find(x => x.id === row.dataset.flavorId);
    if(!flavor) return;
    row.querySelector('.flavor-name').addEventListener('change', e => { flavor.name = e.target.value.trim(); });
    row.querySelector('.flavor-sample-qty').addEventListener('change', e => { flavor.sampleQty = e.target.value.trim(); });
    row.querySelector('.flavor-sample-qty-unit').addEventListener('change', e => { flavor.sampleQtyUnit = e.target.value.trim(); });
    row.querySelector('.flavor-sample-request-date').addEventListener('change', e => { flavor.sampleRequestDate = e.target.value; });
    row.querySelector('.flavor-target-price').addEventListener('change', e => { flavor.targetPrice = e.target.value.trim(); });
    row.querySelector('.flavor-actual-price').addEventListener('change', e => { flavor.actualPrice = e.target.value.trim(); });
    row.querySelector('.flavor-currency').addEventListener('change', e => { flavor.priceCurrency = e.target.value; });
    row.querySelector('.flavor-unit').addEventListener('change', e => { flavor.priceUnit = e.target.value.trim(); });
    row.querySelector('.flavor-formula-ref').addEventListener('change', e => { flavor.formulaRefCode = e.target.value.trim(); });
    row.querySelector('.flavor-note').addEventListener('change', e => { flavor.note = e.target.value.trim(); });
    selectTextOnFocus(row.querySelector('.flavor-sample-qty-unit'));
    selectTextOnFocus(row.querySelector('.flavor-unit'));
    row.querySelector('[data-role="remove-review-flavor"]').addEventListener('click', () => {
      reviewingFlavors = reviewingFlavors.filter(x => x.id !== flavor.id);
      root.innerHTML = reviewFlavorTableHtml();
      wireReviewFlavorTable();
    });
  });
  document.getElementById('addReviewFlavorBtn').addEventListener('click', () => {
    reviewingFlavors.push(blankFlavor());
    root.innerHTML = reviewFlavorTableHtml();
    wireReviewFlavorTable();
  });
}
// Reads the review form's current field values -- shared by Save (writes
// back to the submission doc, still pending) and Import (also writes
// these, but as the final imported/locked state), so Import always acts
// on whatever's currently typed regardless of whether Save was clicked
// first.
export function readSubmissionReviewForm(){
  const v = id => document.getElementById(id)?.value.trim() || '';
  return {
    name: v('subReviewName'), status: v('subReviewStatus'),
    requestDate: v('subReviewRequestDate'), startDate: v('subReviewStartDate'), targetEndDate: v('subReviewTargetEndDate'),
    customerName: v('subReviewCustomer'), destinationCountry: v('subReviewDestination'),
    ownerSalesRep: v('subReviewOwner'), factorySalesRep: v('subReviewFactoryRep'),
    responsiblePerson: v('subReviewResponsible'), factoryName: v('subReviewFactory'),
    portionWeightQty: v('subReviewPortionQty'), portionWeightUnit: v('subReviewPortionUnit'), portionPerUnit: v('subReviewPortionPerUnit'),
    innerPackQty: v('subReviewInnerQty'), innerPackWeightUnit: v('subReviewInnerWeightUnit'), innerPackUnit: v('subReviewInnerPackUnit'),
    outerPackQty: v('subReviewOuterQty'), outerPackUnit: v('subReviewOuterPackUnit'), outerPackContainerUnit: v('subReviewOuterContainerUnit'),
    moqQty: v('subReviewMoqQty'), moqUnit: v('subReviewMoqUnit'),
    flavors: reviewingFlavors,
    requirements: {
      packagingCondition: v('subReviewPackaging'), storageCondition: v('subReviewStorageCondition'), shelfLife: v('subReviewShelfLife'),
      composition: v('subReviewComposition'), recipe: v('subReviewRecipe'),
      cookingCondition: [...document.querySelectorAll('#reviewCookingGuidelinesRoot .cooking-guideline-group')].map(g => ({
        method: g.querySelector('.sub-review-cooking-method-input').value.trim(),
        steps: [...g.querySelectorAll('.sub-review-cooking-step-input')].map(el => el.value.trim()).filter(Boolean)
      })),
      note: v('subReviewNote'),
      certificate: readCertificateChecklist(document.querySelector('#pendingSubmissionsPanel .proj-cert-wrap'))
    }
  };
}
async function saveSubmissionReview(){
  const btn = document.getElementById('btnSaveSubmissionReview');
  btn.disabled = true;
  try{
    const data = { ...readSubmissionReviewForm(), submissionStatus: 'pending', createdAt: reviewingSubmission.createdAt || Date.now(), updatedAt: Date.now() };
    await setDoc(doc(pendingSubmissionsCol, reviewingSubmission.id), data);
    reviewingSubmission = null;
    await refreshPendingSubmissions();
  }catch(err){
    alert('Could not save: ' + (err.message || err));
    btn.disabled = false;
  }
}

// Called from core projects.js's importSubmission after the submission
// doc itself is safely marked imported -- the exact reverse of opening
// a review (reviewingSubmission/pendingSubmissionsList are this
// module's own state, so core can't reassign them directly).
export function completeSubmissionImport(submissionId){
  reviewingSubmission = null;
  pendingSubmissionsList = (pendingSubmissionsList || []).filter(s => s.id !== submissionId);
  renderPendingSubmissionsPanel();
}
