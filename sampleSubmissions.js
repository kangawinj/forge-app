import {
  uid, currentUser, escapeHtml, icon, logActivityEvent,
  playContentTransition, mainFeatureView, diffMainFields, requestAuthConfirm,
  formatActivityDateTime, formatDateLong, sampleSubmissionsCol, showCloudError,
  productList, db, sampleSubmissionCountersCol
} from './app.js';
import {
  onSnapshot, setDoc, doc, deleteDoc, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let submissions = [];
let submissionExpandedIds = new Set();
let submissionEditingId = null;
let unsubscribeSubmissions = null;
let submissionsLoaded = false;
const SUBMISSION_DIFF_FIELDS = {
  formNo: 'Form No.', docDate: 'Doc. Date', shipDate: 'Ship Date', courier: 'Courier',
  customer: 'Customer', projectLead: 'Project Lead', expectedReceipt: 'Expected Receipt',
  trackingNo: 'Tracking No.', destination: 'Destination', coordinator: 'Coordinator',
  deliveryLocation: 'Delivery Location', shipmentStorage: 'Storage', purpose: 'Purpose',
  presentDate: 'Present. Date', receiver: 'Receiver', docs: 'Docs',
  handling: 'Handling', status: 'Status', feedbackOwner: 'Feedback Owner',
  feedbackDue: 'Feedback Due', nextReview: 'Next Review', notes: 'Notes'
};
let submissionEditSnapshotBefore = null;

const SUBMISSION_DECISION_OPTIONS = ['Approved', 'Revise', 'Rejected'];
const SUBMISSION_DEV_STATUS_OPTIONS = ['Ready', 'In Process', 'On Hold'];

function submissionLabel(s){
  return s.formNo ? `${s.formNo}${s.customer ? ' — ' + s.customer : ''}` : (s.customer || 'Untitled submission');
}

function blankSample(){
  return {
    id: uid(), productId: '', manualProductName: '',
    sampleId: '', developmentStatus: '', lotNo: '', mfgDate: '', expiryDate: '',
    requestedQty: '', actualQtySent: '', netWtPerBag: '', storage: '', remarks: '',
    taste: '', texture: '', appearance: '', convenience: '',
    decision: '', feedback: '', owner: '', dueDate: '', nextAction: '',
    certification: '', currency: '', leadTime: '', customerComment: ''
  };
}

function blankSubmission(){
  return {
    id: uid(),
    formNo: '', docDate: '', shipDate: '', courier: '', customer: '', projectLead: '',
    expectedReceipt: '', trackingNo: '', destination: '', coordinator: '', deliveryLocation: '',
    shipmentStorage: '', purpose: '', presentDate: '', receiver: '', docs: '',
    samples: [],
    handling: '', status: '',
    feedbackOwner: '', feedbackDue: '', nextReview: '', notes: '',
    preparedByName: '', preparedByDate: '', receivedByName: '', receivedByDate: '',
    createdBy: currentUser?.email || '', createdAt: Date.now(),
    updatedBy: currentUser?.email || '', updatedAt: Date.now()
  };
}
function migrateSubmission(s){
  return {
    ...s,
    samples: Array.isArray(s.samples) ? s.samples.map(row => ({ ...blankSample(), ...row })) : []
  };
}

function saveSubmissionToCloud(s){
  return setDoc(doc(sampleSubmissionsCol, s.id), s);
}
function scheduleSubmissionSave(s){
  s.updatedAt = Date.now();
  s.updatedBy = currentUser?.email || '';
  saveSubmissionToCloud(s);
}

// Atomic "SS-<year>-<seq>" Form No., collision-safe even when two people
// hit "+ New Submission" at the same instant -- same runTransaction()
// read-and-increment-in-one-step pattern as recipes.js's createNewTrial(),
// against a per-year counter doc (sampleSubmissionCounters/<year>.maxSeq)
// instead of per-Series, so numbering restarts at 0001 every new year.
// tx.set(...,{merge:true}) (rather than tx.update, which createNewTrial
// can use) because the very first submission of a new year has no counter
// doc yet to update.
async function issueSubmissionFormNo(){
  const year = new Date().getFullYear();
  const counterRef = doc(sampleSubmissionCountersCol, String(year));
  const nextSeq = await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef);
    const seq = (snap.exists() ? (snap.data().maxSeq || 0) : 0) + 1;
    tx.set(counterRef, { maxSeq: seq }, { merge: true });
    return seq;
  });
  return `SS-${year}-${String(nextSeq).padStart(4, '0')}`;
}

// Looks up a sample row's linked Product List item live (never copied onto
// the row) so an edit to the Product List record is reflected everywhere
// it's referenced without re-entry -- see the plan's "single source of
// truth" decision. Returns null for a manual/unlinked row.
function linkedProduct(sample){
  return sample.productId ? (productList.find(p => p.id === sample.productId) || null) : null;
}
function sampleProductName(sample){
  const p = linkedProduct(sample);
  return p ? p.name : (sample.manualProductName || '');
}
function productPickerLabel(p){
  return p.code ? `${p.code} — ${p.name}` : (p.name || 'Untitled product');
}
function isSubsequence(query, text){
  let qi = 0;
  for(let i = 0; i < text.length && qi < query.length; i++){
    if(text[i] === query[qi]) qi++;
  }
  return qi === query.length;
}
// Same ranked-match approach as recipes.js's fuzzyMaterialMatches, adapted
// to search productList by code/name/sampleCode instead of an ingredient's
// EN/TH name.
function fuzzyProductMatches(query, limit){
  const q = (query || '').trim().toLowerCase();
  if(!q) return [];
  const scored = productList.map(p => {
    const label = `${p.code || ''} ${p.name || ''} ${p.sampleCode || ''}`.toLowerCase();
    let score = 0;
    if(label.startsWith(q)) score = 3;
    else if(label.includes(q)) score = 2;
    else if(isSubsequence(q, label)) score = 1;
    return { p, score, label };
  }).filter(x => x.score > 0);
  scored.sort((a,b) => b.score - a.score || a.label.localeCompare(b.label));
  return scored.slice(0, limit || 8).map(x => x.p);
}

function toNum(v){
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}
// Requested/Sent/Ready/Variance -- computed fresh from samples[] on every
// render, never a separately-edited field that could drift out of sync
// with the rows it summarizes (see the plan's "summaries are computed"
// decision).
function computeQuantitySummary(samples){
  const requested = samples.reduce((s, row) => s + (toNum(row.requestedQty) || 0), 0);
  const sent = samples.reduce((s, row) => s + (toNum(row.actualQtySent) || 0), 0);
  const ready = samples.filter(row => row.developmentStatus === 'Ready').length;
  return { requested, sent, variance: sent - requested, ready, total: samples.length };
}
function computeFollowUpSummary(samples){
  const counts = { Approved: 0, Revise: 0, Rejected: 0, 'No decision': 0 };
  samples.forEach(row => {
    const d = SUBMISSION_DECISION_OPTIONS.includes(row.decision) ? row.decision : 'No decision';
    counts[d]++;
  });
  return counts;
}
function overallAvg(row){
  const scores = [row.taste, row.texture, row.appearance, row.convenience].map(toNum).filter(v => v !== null);
  return scores.length ? (scores.reduce((s,v) => s+v, 0) / scores.length) : null;
}

export function mountSampleSubmissionsView(){
  const main = document.getElementById('mainArea');
  main.classList.remove('main-wide');
  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('clipboard-check', 24)} Sample Submissions</div>
    </div>
    <div class="card">
      <button class="btn btn-primary btn-sm" id="btnAddSubmission" style="margin-bottom:16px;">+ New Submission</button>
      <div id="submissionsList"></div>
    </div>
  `;

  const btnAddSubmission = document.getElementById('btnAddSubmission');
  btnAddSubmission.addEventListener('click', async () => {
    if(btnAddSubmission.disabled) return;
    btnAddSubmission.disabled = true;
    const originalLabel = btnAddSubmission.textContent;
    btnAddSubmission.textContent = 'Creating...';
    try{
      const s = blankSubmission();
      s.formNo = await issueSubmissionFormNo();
      submissions.push(s);
      saveSubmissionToCloud(s);
      logActivityEvent('created', 'sample submission', submissionLabel(s));
      submissionEditingId = s.id;
      submissionExpandedIds.add(s.id);
      renderSubmissionsList();
    } finally {
      btnAddSubmission.disabled = false;
      btnAddSubmission.textContent = originalLabel;
    }
  });

  renderSubmissionsList();
  playContentTransition(main);
}

export function renderSubmissionsList(){
  const container = document.getElementById('submissionsList');
  if(!container) return;
  if(submissions.length === 0){
    container.innerHTML = '<div class="overview-empty">No sample submissions yet — click "+ New Submission" above to start one</div>';
    return;
  }
  const sorted = [...submissions].sort((a,b) => b.updatedAt - a.updatedAt);
  container.innerHTML = sorted.map(s => {
    const isEditing = s.id === submissionEditingId;
    const isExpanded = isEditing || submissionExpandedIds.has(s.id);
    const ms = migrateSubmission(s);
    const activity = [];
    if(s.createdBy) activity.push(`Created by ${escapeHtml(s.createdBy)}${s.createdAt ? ' · ' + escapeHtml(formatActivityDateTime(s.createdAt)) : ''}`);
    if(s.updatedBy && s.updatedAt !== s.createdAt) activity.push(`Last edited by ${escapeHtml(s.updatedBy)}${s.updatedAt ? ' · ' + escapeHtml(formatActivityDateTime(s.updatedAt)) : ''}`);

    const headerField = (label, field, type) => `
      <div class="field" style="margin-bottom:0;">
        <label>${label}</label>
        <input type="${type || 'text'}" class="ssub-field" data-field="${field}" value="${escapeHtml(ms[field] || '')}" ${isEditing ? '' : 'readonly'}>
      </div>
    `;
    // Form No. is always system-issued (see issueSubmissionFormNo) --
    // never a plain .ssub-field a person can type into, editing or not.
    // A submission created before this feature existed (formNo still '')
    // shows the placeholder here and gets a real number backfilled the
    // next time someone saves it (see the save-submission handler below).
    const formNoField = `
      <div class="field" style="margin-bottom:0;">
        <label>Form No.</label>
        <input type="text" value="${escapeHtml(ms.formNo || 'ระบบจะออกเลขอัตโนมัติ')}" readonly ${ms.formNo ? '' : 'style="color:var(--text-dim);font-style:italic;"'}>
      </div>
    `;

    const qty = computeQuantitySummary(ms.samples);
    const followUp = computeFollowUpSummary(ms.samples);

    const samplesRowsHtml = ms.samples.map((row, idx) => {
      const p = linkedProduct(row);
      const variance = (toNum(row.actualQtySent) !== null && toNum(row.requestedQty) !== null)
        ? (toNum(row.actualQtySent) - toNum(row.requestedQty)) : null;
      const pickerValue = p ? productPickerLabel(p) : (row.manualProductName || '');
      const specLine = p
        ? `Case Pack: ${escapeHtml(p.packingStyle || '-')} &nbsp;·&nbsp; MOQ: ${escapeHtml(p.moq || '-')} &nbsp;·&nbsp; EXW: ${p.exwPrice !== '' && p.exwPrice != null ? '฿' + escapeHtml(String(p.exwPrice)) : '-'} &nbsp;·&nbsp; Factory: ${escapeHtml(p.factory || '-')} &nbsp;·&nbsp; Allergens: ${escapeHtml(p.allergens || '-')}`
        : (row.productId ? '<span style="color:var(--danger);">Linked product not found (deleted?)</span>' : 'No Product List item linked — using manually typed name');
      return `
        <tr data-sample-id="${escapeHtml(row.id)}">
          <td>${idx + 1}</td>
          <td><input type="text" class="ssample-field" data-field="sampleId" value="${escapeHtml(row.sampleId)}" placeholder="SP-001" ${isEditing ? '' : 'readonly'}></td>
          <td style="min-width:200px;position:relative;">
            <input type="text" class="ssample-product-input" value="${escapeHtml(pickerValue)}" placeholder="Search Product List or type a name..." ${isEditing ? '' : 'readonly'} autocomplete="off">
            <div class="ing-suggestions ssample-suggestions"></div>
            ${isEditing ? `<div class="field-hint" style="margin-top:2px;">${specLine}</div>` : ''}
          </td>
          <td>
            ${isEditing
              ? `<select class="ssample-field" data-field="developmentStatus"><option value="">-</option>${SUBMISSION_DEV_STATUS_OPTIONS.map(o => `<option value="${o}" ${row.developmentStatus === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
              : `<input type="text" value="${escapeHtml(row.developmentStatus || '-')}" readonly>`}
          </td>
          <td><input type="text" class="ssample-field" data-field="lotNo" value="${escapeHtml(row.lotNo)}" ${isEditing ? '' : 'readonly'}></td>
          <td><input type="date" class="ssample-field" data-field="mfgDate" value="${escapeHtml(row.mfgDate)}" ${isEditing ? '' : 'readonly'}></td>
          <td><input type="date" class="ssample-field" data-field="expiryDate" value="${escapeHtml(row.expiryDate)}" ${isEditing ? '' : 'readonly'}></td>
          <td><input type="number" class="ssample-field" data-field="requestedQty" value="${escapeHtml(row.requestedQty)}" min="0" step="1" ${isEditing ? '' : 'readonly'}></td>
          <td><input type="number" class="ssample-field" data-field="actualQtySent" value="${escapeHtml(row.actualQtySent)}" min="0" step="1" ${isEditing ? '' : 'readonly'}></td>
          <td>${variance !== null ? variance : '-'}</td>
          <td><input type="text" class="ssample-field" data-field="netWtPerBag" value="${escapeHtml(row.netWtPerBag)}" ${isEditing ? '' : 'readonly'}></td>
          <td><input type="text" class="ssample-field" data-field="storage" value="${escapeHtml(row.storage)}" ${isEditing ? '' : 'readonly'}></td>
          <td><input type="text" class="ssample-field" data-field="remarks" value="${escapeHtml(row.remarks)}" ${isEditing ? '' : 'readonly'}></td>
          ${isEditing ? `<td><button class="icon-btn" data-role="remove-sample" title="Remove this sample">${icon('x')}</button></td>` : ''}
        </tr>
      `;
    }).join('');

    const productSpecRowsHtml = ms.samples.map((row, idx) => {
      const p = linkedProduct(row);
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${escapeHtml(row.sampleId || '-')}</td>
          <td>${escapeHtml(p ? p.code : '-')}</td>
          <td>${escapeHtml(sampleProductName(row) || '-')}</td>
          <td>${escapeHtml(p?.cookingInstruction || '-')}</td>
          <td>${escapeHtml(p?.composition || '-')}</td>
          <td>${escapeHtml(p?.allergens || '-')}</td>
          <td>${escapeHtml(p?.processedArea || '-')}</td>
          <td>${escapeHtml(p?.factory || '-')}</td>
          <td><input type="text" class="ssample-field" data-field="certification" value="${escapeHtml(row.certification)}" ${isEditing ? '' : 'readonly'}></td>
          <td>${escapeHtml(p?.packingStyle || '-')}</td>
          <td>${escapeHtml(p?.moq || '-')}</td>
          <td><input type="text" class="ssample-field" data-field="currency" value="${escapeHtml(row.currency)}" placeholder="THB" ${isEditing ? '' : 'readonly'}></td>
          <td>${p?.exwPrice !== '' && p?.exwPrice != null ? '฿' + escapeHtml(String(p.exwPrice)) : '-'}</td>
          <td><input type="text" class="ssample-field" data-field="leadTime" value="${escapeHtml(row.leadTime)}" ${isEditing ? '' : 'readonly'}></td>
          <td><input type="text" class="ssample-field" data-field="customerComment" value="${escapeHtml(row.customerComment)}" ${isEditing ? '' : 'readonly'}></td>
        </tr>
      `;
    }).join('');

    const evalRowsHtml = ms.samples.map((row, idx) => {
      const avg = overallAvg(row);
      return `
        <tr data-sample-id="${escapeHtml(row.id)}">
          <td>${idx + 1}</td>
          <td>${escapeHtml(row.sampleId || '-')}</td>
          <td>${escapeHtml(sampleProductName(row) || '-')}</td>
          ${['taste','texture','appearance','convenience'].map(field => `
            <td><input type="number" class="ssample-field" data-field="${field}" value="${escapeHtml(row[field])}" min="1" max="5" step="1" ${isEditing ? '' : 'readonly'}></td>
          `).join('')}
          <td><b>${avg !== null ? avg.toFixed(1) : '-'}</b></td>
          <td>${isEditing
            ? `<select class="ssample-field" data-field="decision"><option value="">No decision</option>${SUBMISSION_DECISION_OPTIONS.map(o => `<option value="${o}" ${row.decision === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
            : `<input type="text" value="${escapeHtml(row.decision || 'No decision')}" readonly>`}</td>
          <td><input type="text" class="ssample-field" data-field="feedback" value="${escapeHtml(row.feedback)}" ${isEditing ? '' : 'readonly'}></td>
          <td><input type="text" class="ssample-field" data-field="owner" list="salesRepDatalist" value="${escapeHtml(row.owner)}" ${isEditing ? '' : 'readonly'}></td>
          <td><input type="date" class="ssample-field" data-field="dueDate" value="${escapeHtml(row.dueDate)}" ${isEditing ? '' : 'readonly'}></td>
          <td><input type="text" class="ssample-field" data-field="nextAction" value="${escapeHtml(row.nextAction)}" ${isEditing ? '' : 'readonly'}></td>
        </tr>
      `;
    }).join('');

    return `
      <div class="part-block${isExpanded ? '' : ' collapsed'}" data-submission-id="${escapeHtml(s.id)}">
        <div class="part-header" style="margin-bottom:12px;">
          <button type="button" class="part-toggle-btn${isExpanded ? ' open' : ''}" title="Expand / collapse this submission">${icon('chevron-right')}</button>
          <span style="font-weight:700;font-size:14px;color:var(--primary-dark);">${escapeHtml(submissionLabel(s))}</span>
          <span class="part-header-summary">${ms.samples.length} sample${ms.samples.length === 1 ? '' : 's'}${ms.shipDate ? ' · Shipped ' + escapeHtml(formatDateLong(ms.shipDate)) : ''}</span>
          ${isEditing ? `<button class="btn btn-sm" data-role="save-submission">${icon('save')} Save</button>` : `<button class="btn btn-sm" data-role="edit-submission">${icon('pencil')} Edit</button>`}
          <button class="btn btn-sm" data-role="print-submission">${icon('printer')} Print</button>
          <button class="btn btn-sm btn-danger" data-role="delete-submission">${icon('x')} Delete</button>
        </div>
        <div class="part-body">
          <div class="card-title" style="font-size:13px;">Document and delivery information</div>
          <div class="grid-3">
            ${formNoField}
            ${headerField('Customer', 'customer')}
            ${headerField('Destination', 'destination')}
          </div>
          <div class="grid-3" style="margin-top:14px;">
            ${headerField('Doc. Date', 'docDate', 'date')}
            ${headerField('Project Lead', 'projectLead')}
            ${headerField('Coordinator', 'coordinator')}
          </div>
          <div class="grid-3" style="margin-top:14px;">
            ${headerField('Ship Date', 'shipDate', 'date')}
            ${headerField('Expected Receipt', 'expectedReceipt', 'date')}
            ${headerField('Delivery Location', 'deliveryLocation')}
          </div>
          <div class="grid-3" style="margin-top:14px;">
            ${headerField('Courier', 'courier')}
            ${headerField('Tracking No.', 'trackingNo')}
            ${headerField('Storage', 'shipmentStorage')}
          </div>
          <div class="grid-3" style="margin-top:14px;">
            ${headerField('Purpose', 'purpose')}
            ${headerField('Present. Date', 'presentDate', 'date')}
            ${headerField('Receiver', 'receiver')}
          </div>
          <div class="field" style="margin-top:14px;">
            ${headerField('Docs (Specification / COA / Allergen declaration)', 'docs')}
          </div>
          ${activity.length ? `<div class="reflist-item-meta" style="margin:10px 0;">${activity.join(' &nbsp;|&nbsp; ')}</div>` : ''}

          <div class="card-title" style="font-size:13px;margin-top:20px;">Samples included in this submission</div>
          <div style="overflow-x:auto;">
            <table class="compare-table ssub-samples-table">
              <thead><tr>
                <th>No.</th><th>Sample ID</th><th>Product</th><th>Dev. Status</th><th>Lot No.</th>
                <th>MFG Date</th><th>Expiry Date</th><th>Requested Qty</th><th>Actual Qty Sent</th>
                <th>Variance</th><th>Net Wt./Bag (g)</th><th>Storage</th><th>Remarks</th>${isEditing ? '<th></th>' : ''}
              </tr></thead>
              <tbody id="ssubSamplesBody-${escapeHtml(s.id)}">${samplesRowsHtml || `<tr><td colspan="${isEditing ? 14 : 13}"><div class="overview-empty">No samples added yet</div></td></tr>`}</tbody>
            </table>
          </div>
          ${isEditing ? `<button class="btn btn-sm add-row-btn" data-role="add-sample" style="margin-top:8px;">+ Add Sample</button>` : ''}

          <div class="card-title" style="font-size:13px;margin-top:20px;">Quantity summary</div>
          <div class="batch-summary" style="grid-template-columns:repeat(4,1fr);">
            <div><div class="batch-stat-label">Requested</div><div class="batch-stat-value">${qty.requested} bags</div></div>
            <div><div class="batch-stat-label">Actual Sent</div><div class="batch-stat-value">${qty.sent} bags</div></div>
            <div><div class="batch-stat-label">Variance (Sent − Requested)</div><div class="batch-stat-value">${qty.variance >= 0 ? '+' : ''}${qty.variance} bags</div></div>
            <div><div class="batch-stat-label">Ready</div><div class="batch-stat-value">${qty.ready} / ${qty.total}</div></div>
          </div>

          <div class="card-title" style="font-size:13px;margin-top:20px;">Product specification (from Product List)</div>
          <div style="overflow-x:auto;">
            <table class="compare-table">
              <thead><tr>
                <th>No.</th><th>Sample ID</th><th>Product Code</th><th>Product Name</th><th>Approved Cooking Instruction</th>
                <th>Composition (Approx.)</th><th>Allergen Statement</th><th>Country of Origin</th><th>Factory</th>
                <th>Certification / Standard</th><th>Case Pack</th><th>MOQ (ctn)</th><th>Currency</th><th>EXW Price</th>
                <th>Lead Time</th><th>Customer Comment / Selling Point</th>
              </tr></thead>
              <tbody>${productSpecRowsHtml || `<tr><td colspan="16"><div class="overview-empty">No samples added yet</div></td></tr>`}</tbody>
            </table>
          </div>

          <div class="card-title" style="font-size:13px;margin-top:20px;">Handling information</div>
          <div class="grid-2">
            <div class="field">
              <label>Handling</label>
              <textarea class="ssub-field" data-field="handling" rows="2" ${isEditing ? '' : 'readonly'}>${escapeHtml(ms.handling)}</textarea>
            </div>
            <div class="field">
              <label>Status</label>
              <input type="text" class="ssub-field" data-field="status" value="${escapeHtml(ms.status)}" placeholder="e.g. Evaluation sample — not for sale" ${isEditing ? '' : 'readonly'}>
            </div>
          </div>

          <div class="card-title" style="font-size:13px;margin-top:20px;">Customer evaluation</div>
          <div style="overflow-x:auto;">
            <table class="compare-table">
              <thead><tr>
                <th>No.</th><th>Sample ID</th><th>Product Name</th><th>Taste (1–5)</th><th>Texture (1–5)</th>
                <th>Appearance (1–5)</th><th>Convenience (1–5)</th><th>Overall Avg.</th><th>Decision</th>
                <th>Feedback / Issue</th><th>Owner</th><th>Due Date</th><th>Next Action</th>
              </tr></thead>
              <tbody id="ssubEvalBody-${escapeHtml(s.id)}">${evalRowsHtml || `<tr><td colspan="13"><div class="overview-empty">No samples added yet</div></td></tr>`}</tbody>
            </table>
          </div>

          <div class="card-title" style="font-size:13px;margin-top:20px;">Follow-up summary</div>
          <div class="batch-summary" style="grid-template-columns:repeat(4,1fr);">
            <div><div class="batch-stat-label">Approved</div><div class="batch-stat-value">${followUp.Approved}</div></div>
            <div><div class="batch-stat-label">Revise</div><div class="batch-stat-value">${followUp.Revise}</div></div>
            <div><div class="batch-stat-label">Rejected</div><div class="batch-stat-value">${followUp.Rejected}</div></div>
            <div><div class="batch-stat-label">No decision</div><div class="batch-stat-value">${followUp['No decision']}</div></div>
          </div>
          <div class="grid-3" style="margin-top:14px;">
            ${headerField('Feedback Owner', 'feedbackOwner')}
            ${headerField('Feedback Due', 'feedbackDue', 'date')}
            ${headerField('Next Review', 'nextReview', 'date')}
          </div>
          <div class="field" style="margin-top:14px;">
            <label>Notes</label>
            <textarea class="ssub-field" data-field="notes" rows="2" ${isEditing ? '' : 'readonly'}>${escapeHtml(ms.notes)}</textarea>
          </div>

          <div class="card-title" style="font-size:13px;margin-top:20px;">Acknowledgement</div>
          <div class="ssub-ack-grid">
            <div>
              <div class="ssub-ack-title">Prepared by</div>
              <div class="grid-2">
                ${headerField('Name', 'preparedByName')}
                ${headerField('Date', 'preparedByDate', 'date')}
              </div>
            </div>
            <div>
              <div class="ssub-ack-title">Received by</div>
              <div class="grid-2">
                ${headerField('Name', 'receivedByName')}
                ${headerField('Date', 'receivedByDate', 'date')}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.part-block[data-submission-id]').forEach(block => {
    const id = block.dataset.submissionId;
    const s = submissions.find(x => x.id === id);
    if(!s) return;
    const isEditing = id === submissionEditingId;
    if(!Array.isArray(s.samples)) s.samples = [];

    block.querySelector('.part-toggle-btn').addEventListener('click', () => {
      if(submissionExpandedIds.has(id)) submissionExpandedIds.delete(id);
      else submissionExpandedIds.add(id);
      renderSubmissionsList();
    });

    if(isEditing){
      block.querySelector('[data-role="save-submission"]').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try{
          // Backfill for a submission created before Form No. was
          // system-issued (see formNoField above) -- everything created
          // through "+ New Submission" already has one by now.
          if(!s.formNo){
            s.formNo = await issueSubmissionFormNo();
            scheduleSubmissionSave(s);
          }
          submissionEditingId = null;
          logActivityEvent('updated', 'sample submission', submissionLabel(s), diffMainFields(submissionEditSnapshotBefore, s, SUBMISSION_DIFF_FIELDS));
          submissionEditSnapshotBefore = null;
          renderSubmissionsList();
        } finally {
          btn.disabled = false;
        }
      });
    }else{
      block.querySelector('[data-role="edit-submission"]').addEventListener('click', () => {
        submissionEditingId = id;
        submissionExpandedIds.add(id);
        submissionEditSnapshotBefore = { ...s };
        renderSubmissionsList();
      });
    }

    block.querySelector('[data-role="print-submission"]').addEventListener('click', () => {
      block.classList.add('printing-only');
      const cleanup = () => {
        block.classList.remove('printing-only');
        window.removeEventListener('afterprint', cleanup);
      };
      window.addEventListener('afterprint', cleanup);
      window.print();
    });

    block.querySelector('[data-role="delete-submission"]').addEventListener('click', () => {
      if(!confirm(`Delete "${submissionLabel(s)}"? This cannot be undone.`)) return;
      requestAuthConfirm(
        'Confirm Identity to Delete',
        'Enter your password to delete this sample submission.',
        () => {
          const deletedLabel = submissionLabel(s);
          submissions = submissions.filter(x => x.id !== s.id);
          deleteDoc(doc(sampleSubmissionsCol, s.id));
          logActivityEvent('deleted', 'sample submission', deletedLabel);
          renderSubmissionsList();
        }
      );
    });

    if(isEditing){
      block.querySelectorAll('.ssub-field').forEach(el => {
        el.addEventListener('change', () => {
          s[el.dataset.field] = el.value.trim();
          scheduleSubmissionSave(s);
        });
      });

      block.querySelector('[data-role="add-sample"]')?.addEventListener('click', () => {
        s.samples.push(blankSample());
        scheduleSubmissionSave(s);
        renderSubmissionsList();
      });
    }

    block.querySelectorAll('[data-role="remove-sample"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('tr[data-sample-id]');
        s.samples = s.samples.filter(x => x.id !== row.dataset.sampleId);
        scheduleSubmissionSave(s);
        renderSubmissionsList();
      });
    });

    block.querySelectorAll('.ssample-field').forEach(el => {
      el.addEventListener('change', () => {
        const row = el.closest('tr[data-sample-id]');
        const sample = s.samples.find(x => x.id === row.dataset.sampleId);
        if(!sample) return;
        sample[el.dataset.field] = el.value.trim();
        scheduleSubmissionSave(s);
        if(['requestedQty','actualQtySent','developmentStatus','taste','texture','appearance','convenience','decision'].includes(el.dataset.field)){
          renderSubmissionsList(); // keep computed summaries/avg in sync
        }
      });
    });

    // Product picker: fuzzy-search suggestion box, same "mousedown before
    // blur" trick as recipes.js's ingredient picker (recipes.js:2665-2717).
    if(isEditing){
      block.querySelectorAll('.ssample-product-input').forEach(input => {
        const row = input.closest('tr[data-sample-id]');
        const sample = s.samples.find(x => x.id === row.dataset.sampleId);
        if(!sample) return;
        const suggestBox = row.querySelector('.ssample-suggestions');
        function renderSuggestions(){
          if(document.activeElement !== input){
            suggestBox.innerHTML = '';
            suggestBox.classList.remove('open');
            return;
          }
          const matches = fuzzyProductMatches(input.value, 8);
          if(matches.length === 0){
            suggestBox.innerHTML = '';
            suggestBox.classList.remove('open');
            return;
          }
          suggestBox.innerHTML = matches.map(p => `
            <div class="ing-suggestion-item" data-id="${escapeHtml(p.id)}">
              <span class="ing-suggestion-name">${escapeHtml(productPickerLabel(p))}</span>
            </div>
          `).join('');
          suggestBox.classList.add('open');
          suggestBox.querySelectorAll('.ing-suggestion-item').forEach(item => {
            item.addEventListener('mousedown', e => {
              e.preventDefault();
              const matched = productList.find(x => x.id === item.dataset.id);
              if(matched){
                sample.productId = matched.id;
                sample.manualProductName = '';
                scheduleSubmissionSave(s);
              }
              suggestBox.innerHTML = '';
              suggestBox.classList.remove('open');
              renderSubmissionsList();
            });
          });
        }
        input.addEventListener('input', e => {
          sample.productId = '';
          sample.manualProductName = e.target.value.trim();
          scheduleSubmissionSave(s);
          renderSuggestions();
        });
        input.addEventListener('focus', renderSuggestions);
        input.addEventListener('blur', () => {
          suggestBox.innerHTML = '';
          suggestBox.classList.remove('open');
        });
      });
    }
  });
}

export function attachSampleSubmissionsListener(){
  unsubscribeSubmissions = onSnapshot(sampleSubmissionsCol, snapshot => {
    submissions = snapshot.docs.map(d => d.data());
    submissionsLoaded = true;
    if(mainFeatureView === 'sampleSubmissions') renderSubmissionsList();
  }, err => {
    console.error('Forge: sample submissions listener error', err);
    showCloudError('Failed to load sample submissions from Firebase: ' + err.message);
  });
}

// Tears down the sampleSubmissions Firestore listener and resets state to
// empty — called from the shared sign-out handler in app.js, same pattern
// as resetTrialsState/resetProductsState.
export function resetSampleSubmissionsState(){
  if(unsubscribeSubmissions){ unsubscribeSubmissions(); unsubscribeSubmissions = null; }
  submissionsLoaded = false;
  submissions = [];
}

export { submissions, submissionExpandedIds, unsubscribeSubmissions };
