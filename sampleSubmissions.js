import {
  escapeHtml, icon, logActivityEvent,
  playContentTransition, mainFeatureView, diffMainFields, requestAuthConfirm,
  formatActivityDateTime, sampleSubmissionsCol, showCloudError,
  productList, compositionSummaryText, isCurrentUserAdmin, metaLists, metaItemName, bangkokTodayStr,
  moveToTrash, canDeleteRecord, deleteNotAllowedMessage
} from './app.js';
import { wireSuggestKeys } from './suggest-keys.js';
import {
  onSnapshot, doc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  SUBMISSION_DECISION_OPTIONS, SUBMISSION_DEV_STATUS_OPTIONS, submissionLabel, sampleIdFor,
  backfillSampleSeqs, blankSample, blankDocs, normalizeDocs, blankSubmission, migrateSubmission,
  saveSubmissionToCloud, scheduleSubmissionSave, issueSubmissionFormNo,
  linkedProduct, sampleProductName, productPickerLabel, fuzzyProductMatches,
  getSharedProductSuggestBox, closeProductSuggestBox, toNum, computeQuantitySummary,
  computeFollowUpSummary, overallAvg, needsRenumber, planRenumber, applyRenumber
} from './sampleSubmissions-data.js';
import { exportSampleSubmissionsToExcel } from './sampleSubmissions-excel.js';
import { openShipDoc, rememberShipper, lastShipper } from './sampleSubmissions-docs.js';

let submissions = [];
let submissionExpandedIds = new Set();
let submissionEditingId = null;
let unsubscribeSubmissions = null;
let submissionsLoaded = false;
// docs (see blankDocs/normalizeDocs below) is a checklist object, not a
// plain string like every other field here -- diffMainFields' generic
// String(before) !== String(after) comparison would just show
// "[object Object]" for it, so it's left out of the audit-log diff.
const SUBMISSION_DIFF_FIELDS = {
  formNo: 'Form No.', docDate: 'Doc. Date', courier: 'Courier',
  customer: 'Customer', projectLead: 'Project Lead', expectedReceipt: 'Expected Receipt',
  trackingNo: 'Tracking No.', destination: 'Destination', coordinator: 'Coordinator',
  deliveryCompany: 'Samples Delivery Company', deliveryLocation: 'Samples Delivery Location', shipmentStorage: 'Storage', purpose: 'Purpose',
  presentDate: 'Present. Date', receiver: 'Receiver',
  handling: 'Handling', status: 'Status', feedbackOwner: 'Feedback Owner',
  feedbackDue: 'Feedback Due', nextReview: 'Next Review', notes: 'Notes',
  shipperName: 'Shipper', shipperAddress: 'Shipper Address', consigneeName: 'Consignee', consigneeAddress: 'Consignee Address',
  cartons: 'No. of Cartons', grossWeightKg: 'Gross Weight (kg)', cartonSize: 'Carton Size', countryOfOrigin: 'Country of Origin',
  hsCode: 'HS Code', invoiceCurrency: 'Invoice Currency', exportReason: 'Reason for Export'
};
let submissionEditSnapshotBefore = null;

// Samples Delivery: pick the Company first (any company of the Company Directory), then one of that company's Locations
// ("Location name — address"). The Customer's own company and its first location are filled in when the Customer is chosen.
function companyLocations(companyName){
  const c = metaLists.customers.find(x => metaItemName(x) === (companyName || '').trim());
  if(!c) return [];
  return (c.locations || []).map((name, i) => [name, ((c.locationAddresses || [])[i] || '').trim()].filter(Boolean).join(' — ')).filter(Boolean);
}
// the Location drop-down's options for a company (keeps a value saved earlier that is not in the list, e.g. typed by hand)
function locationSelectOptionsHtml(companyName, current){
  const opts = companyLocations(companyName);
  const hint = !(companyName || '').trim() ? '— Choose a company first —' : (opts.length ? '— Choose a location —' : '— No saved location for this company —');
  return `<option value="">${hint}</option>`
    + (current && !opts.includes(current) ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>` : '')
    + opts.map(o => `<option value="${escapeHtml(o)}"${o === current ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
}


export function mountSampleSubmissionsView(){
  const main = document.getElementById('mainArea');
  main.classList.remove('main-wide', 'trials-a4-width');
  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('clipboard-check', 24)} Sample Submissions</div>
    </div>
    <div class="card">
      <button class="btn btn-primary btn-sm" id="btnAddSubmission" style="margin-bottom:16px;">+ New Submission</button>
      <button type="button" class="btn btn-sm" id="btnExportSubmissionsExcel" style="margin-bottom:16px;margin-left:8px;">${icon('download', 14)} Export Excel</button>
      <button type="button" class="btn btn-sm" id="btnRenumberSubmissions" style="margin-bottom:16px;margin-left:8px;display:none;" title="Give the old SS-year-0000 numbers (from SS-2026-0003 on) the new SS-YYMM-00 format">Renumber old Form Nos.</button>
      <div id="submissionsList"></div>
    </div>
  `;
  document.getElementById('btnRenumberSubmissions').addEventListener('click', async () => {
    const btn = document.getElementById('btnRenumberSubmissions');
    btn.disabled = true;
    try{
      const plan = await planRenumber(submissions);
      if(!plan.length){ alert('Nothing to renumber.'); return; }
      const list = plan.map(p => `${p.oldNo}  ->  ${p.newNo}${p.s.customer ? '   (' + p.s.customer + ')' : ''}`).join('\n');
      if(!confirm(`Renumber these ${plan.length} submission(s)?\n\n${list}\n\nThe old number is kept on the submission as "previous Form No.", but anything already printed or sent with the old number will no longer match.`)) return;
      await applyRenumber(plan);
      logActivityEvent('updated', 'sample submission', `Renumbered ${plan.length} Form No.(s) to SS-YYMM-00`);
      renderSubmissionsList();
      alert(`Done: ${plan.length} Form No.(s) renumbered.`);
    }catch(e){
      console.error('Forge: renumber failed', e);
      alert('Could not renumber: ' + e.message);
    }finally{
      btn.disabled = false;
    }
  });

  document.getElementById('btnExportSubmissionsExcel').addEventListener('click', () => exportSampleSubmissionsToExcel(submissions));

  const btnAddSubmission = document.getElementById('btnAddSubmission');
  btnAddSubmission.addEventListener('click', async () => {
    if(btnAddSubmission.disabled) return;
    btnAddSubmission.disabled = true;
    const originalLabel = btnAddSubmission.textContent;
    btnAddSubmission.textContent = 'Creating...';
    try{
      const s = blankSubmission();
      s.docDate = bangkokTodayStr();   // Doc. Date (the Date under Prepared by) starts as today, editable afterwards
      Object.assign(s, lastShipper());   // the shipper is nearly always the same as last time
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
  const renumberBtn = document.getElementById('btnRenumberSubmissions');
  if(renumberBtn) renumberBtn.style.display = isCurrentUserAdmin() && submissions.some(needsRenumber) ? '' : 'none';   // admins only, and only while old numbers remain
  if(submissions.length === 0){
    container.innerHTML = '<div class="overview-empty">No sample submissions yet — click "+ New Submission" above to start one</div>';
    return;
  }
  const sorted = [...submissions].sort((a,b) => b.updatedAt - a.updatedAt);
  container.innerHTML = sorted.map(s => {
    const isEditing = s.id === submissionEditingId;
    const isExpanded = isEditing || submissionExpandedIds.has(s.id);
    if(!Array.isArray(s.samples)) s.samples = [];
    if(backfillSampleSeqs(s)) scheduleSubmissionSave(s);
    const ms = migrateSubmission(s);
    const activity = [];
    if(s.createdBy) activity.push(`Created by ${escapeHtml(s.createdBy)}${s.createdAt ? ' · ' + escapeHtml(formatActivityDateTime(s.createdAt)) : ''}`);
    if(s.updatedBy && s.updatedAt !== s.createdAt) activity.push(`Last edited by ${escapeHtml(s.updatedBy)}${s.updatedAt ? ' · ' + escapeHtml(formatActivityDateTime(s.updatedAt)) : ''}`);

    // listId hooks a field up to an existing Reference Lists datalist (see
    // reflists.js's renderMetaDatalists) when one genuinely matches the
    // field's meaning -- e.g. Customer/Destination reuse the same company
    // and country lists Projects already draws from. A field with no real
    // matching list (Courier, Storage, Tracking No., ...) is left as plain
    // free text rather than inventing a new admin-managed list for it.
    const headerField = (label, field, type, listId) => `
      <div class="field" style="margin-bottom:0;">
        <label>${label}</label>
        <input type="${type || 'text'}" class="ssub-field" data-field="${field}" value="${escapeHtml(ms[field] || '')}" ${listId ? `list="${listId}"` : ''} ${isEditing ? '' : 'readonly'}>
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
    // Docs Request -- a checklist (see blankDocs/normalizeDocs) instead of
    // free text. Tax Invoice's own 6 fields, and the Other-documents
    // detail field, only render once their checkbox is ticked -- wired in
    // the isEditing block below (.ssub-doc-check re-renders the whole list
    // on toggle, same as the other checkbox-driven fields in this form).
    const docCheck = (label, key) => `
      <label style="display:inline-flex;align-items:center;gap:6px;font-weight:400;margin-right:20px;">
        <input type="checkbox" class="ssub-doc-check" data-doc="${key}" ${ms.docs[key] ? 'checked' : ''} ${isEditing ? '' : 'disabled'}>
        ${label}
      </label>
    `;
    const docField = (label, field, type) => `
      <div class="field" style="margin-bottom:0;">
        <label>${label}</label>
        <input type="${type || 'text'}" class="ssub-doc-field" data-field="${field}" value="${escapeHtml(ms.docs.taxInvoiceDetails[field] || '')}" ${isEditing ? '' : 'readonly'}>
      </div>
    `;
    const docsBlock = `
      <div class="field" style="margin-top:14px;">
        <label>Docs Request</label>
        <div style="margin-top:4px;">
          ${docCheck('Specification', 'specification')}
          ${docCheck('Quotation', 'quotation')}
          ${docCheck('Tax Invoice', 'taxInvoice')}
          ${docCheck('Other Documents', 'other')}
        </div>
      </div>
      ${ms.docs.taxInvoice ? `
        <div class="grid-3" style="margin-top:14px;">
          ${docField('Carrier / Shipper Name', 'carrierName')}
          ${docField('Flight No.', 'flightNo')}
          ${docField('Port of Loading', 'portOfLoading')}
        </div>
        <div class="grid-3" style="margin-top:14px;">
          ${docField('Port of Destination', 'portOfDestination')}
          ${docField('Departure Date & Time (Origin Country)', 'departureDateTime', 'datetime-local')}
          ${docField('Arrival Date & Time (Destination Country)', 'arrivalDateTime', 'datetime-local')}
        </div>
      ` : ''}
      ${ms.docs.other ? `
        <div class="field" style="margin-top:14px;">
          <label>Other Documents Details</label>
          <input type="text" class="ssub-doc-other-field" value="${escapeHtml(ms.docs.otherDetails || '')}" ${isEditing ? '' : 'readonly'}>
        </div>
      ` : ''}
    `;

    // Shipping documents: the extra details the Packing List / Sample Invoice need (they also use Customer, Courier, Tracking,
    // Destination, the samples and their quantities / weights from this submission)
    const areaField = (label, field, rows) => `
      <div class="field" style="margin-bottom:0;">
        <label>${label}</label>
        <textarea class="ssub-field" data-field="${field}" rows="${rows || 3}" ${isEditing ? '' : 'readonly'}>${escapeHtml(ms[field] || '')}</textarea>
      </div>`;
    // Shipping documents is optional: tick it to show the details (and the Packing List / Sample Invoice buttons). Submissions
    // saved before the tick existed show it ticked when they already hold shipping details.
    const shipDataFields = ['shipperName', 'shipperAddress', 'consigneeName', 'consigneeAddress', 'cartons', 'grossWeightKg', 'cartonSize', 'hsCode', 'countryOfOrigin', 'invoiceCurrency', 'exportReason'];
    const shipOn = ms.shipDocsOn === undefined ? (shipDataFields.some(f => ms[f]) || ms.samples.some(r => r.unitValue)) : !!ms.shipDocsOn;
    const shipDocsBlock = `
      <div class="ssub-shipdocs">
        <label class="card-title ssub-shipdocs-toggle" style="font-size:13px;margin-top:20px;display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" class="ssub-shipdocs-check" ${shipOn ? 'checked' : ''} ${isEditing ? '' : 'disabled'}>
          Shipping documents (Packing List / Sample Invoice)
        </label>
        ${!shipOn ? '' : `
        <div class="field-hint" style="margin-bottom:10px;">Used by the Packing List and Sample Invoice buttons at the top. Customer, Destination and the samples below are taken from this submission; leave Consignee blank to use the Customer.</div>
        <div class="ssub-grid4">
          <div style="grid-column:span 2;">${headerField('Shipper (ship from)', 'shipperName')}</div>
          <div style="grid-column:span 2;">${headerField('Consignee (ship to)', 'consigneeName')}</div>
          <div style="grid-column:span 2;">${areaField('Shipper address / contact', 'shipperAddress', 2)}</div>
          <div style="grid-column:span 2;">${areaField('Consignee address / contact', 'consigneeAddress', 2)}</div>
          ${headerField('No. of cartons', 'cartons', 'number')}
          ${headerField('Gross weight (kg)', 'grossWeightKg', 'number')}
          ${headerField('Carton size (cm)', 'cartonSize')}
          ${headerField('HS code', 'hsCode')}
          ${headerField('Country of origin (blank = Thailand)', 'countryOfOrigin', null, 'destinationDatalist')}
          ${headerField('Invoice currency (blank = USD)', 'invoiceCurrency')}
          <div style="grid-column:span 2;">${headerField('Reason for export (blank = FREE SAMPLES - NO COMMERCIAL VALUE)', 'exportReason')}</div>
        </div>
        <div style="overflow-x:auto;margin-top:8px;">
          <table class="compare-table">
            <thead><tr><th>No.</th><th>Sample ID</th><th>Product</th><th>Qty (bags)</th><th>Unit value for customs (per bag)</th></tr></thead>
            <tbody>${ms.samples.map((row, idx) => `
              <tr data-sample-id="${escapeHtml(row.id)}">
                <td>${idx + 1}</td><td>${escapeHtml(sampleIdFor(ms, row))}</td><td>${escapeHtml(sampleProductName(row) || '-')}</td>
                <td>${escapeHtml(String(row.actualQtySent !== '' && row.actualQtySent != null ? row.actualQtySent : (row.requestedQty || '')))}</td>
                <td><input type="number" class="ssample-field" data-field="unitValue" value="${escapeHtml(row.unitValue || '')}" min="0" step="0.01" ${isEditing ? '' : 'readonly'}></td>
              </tr>`).join('') || '<tr><td colspan="5"><div class="overview-empty">No samples added yet</div></td></tr>'}</tbody>
          </table>
        </div>`}
      </div>`;


    // One card per sample: what is being sent (product, status, lot, quantities, storage, remarks) and, right under it, that
    // product's information from the Product List (read-only) with the few details that belong to this submission.
    const ro = isEditing ? '' : 'readonly';
    const samplesCardsHtml = ms.samples.map((row, idx) => {
      const p = linkedProduct(row);
      const pickerValue = p ? productPickerLabel(p) : (row.manualProductName || '');
      const sf = (label, field, type, extra, ph) => `
        <div class="field"${extra ? ` style="${extra}"` : ''}><label>${label}</label>
          <input type="${type || 'text'}" class="ssample-field" data-field="${field}" value="${escapeHtml(row[field])}" ${ph ? `placeholder="${ph}"` : ''} ${ro}${type === 'number' ? ' min="0" step="1"' : ''}></div>`;
      const info = (label, value, extra) => `<div class="ssub-info"${extra ? ` style="${extra}"` : ''}><span>${label}</span><div>${escapeHtml(value || '-')}</div></div>`;
      const img = p && (p.rmImage || p.ideaMenuImage);
      const hint = p ? '' : (row.productId ? '<div class="field-hint" style="color:var(--danger);">Linked product not found (deleted?)</div>' : `<div class="field-hint">No Product List item linked — using manually typed name</div>`);
      return `
        <div class="ssub-sample" data-sample-id="${escapeHtml(row.id)}">
          <div class="ssub-sample-head">
            <span class="ssub-sample-no">${idx + 1}</span>
            <span class="ssub-sample-id">${escapeHtml(sampleIdFor(ms, row))}</span>
            ${isEditing ? `<button class="icon-btn" data-role="remove-sample" title="Remove this sample" style="margin-left:auto;">${icon('x')}</button>` : ''}
          </div>
          <div class="ssub-grid4">
            <div class="field" style="grid-column:span 2;"><label>Product</label>
              <input type="text" class="ssample-product-input" value="${escapeHtml(pickerValue)}" placeholder="Search Product List or type a name..." ${ro} autocomplete="off">
              ${hint}</div>
            <div class="field"><label>Dev. Status</label>
              ${isEditing
                ? `<select class="ssample-field" data-field="developmentStatus"><option value="">-</option>${SUBMISSION_DEV_STATUS_OPTIONS.map(o => `<option value="${o}" ${row.developmentStatus === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
                : `<input type="text" value="${escapeHtml(row.developmentStatus || '-')}" readonly>`}</div>
            ${sf('Lot No.', 'lotNo')}
            ${sf('Requested Qty (bags)', 'requestedQty', 'number')}
            ${sf('Actual Qty Sent (bags)', 'actualQtySent', 'number')}
            ${sf('Net Wt./Bag (g)', 'netWtPerBag')}
            ${sf('Storage', 'storage')}
            ${sf('Remarks', 'remarks', null, 'grid-column:span 2;')}
          </div>
          <div class="ssub-spec">
            ${img ? `<img class="ssub-spec-img" src="${escapeHtml(img)}" alt="">` : `<div class="ssub-spec-img ssub-spec-img-empty"></div>`}
            <div class="ssub-spec-body">
              <div class="ssub-spec-title">From the Product List</div>
              <div class="ssub-grid4 ssub-spec-grid">
                ${info('Product code', p?.code)}${info('Sample code', p?.sampleCode)}${info('Standards / packing style', p?.packingStyle)}${info('Size', p?.size)}
                ${info('MOQ (ctn)', p?.moq)}${info('EXW price', p && p.exwPrice !== '' && p.exwPrice != null ? '฿' + p.exwPrice : '')}${info('Sales price', p?.salesPrice)}${info('Factory', p?.factory)}
                ${info('Country of origin', p?.processedArea)}${info('Allergen statement', p?.allergens, 'grid-column:span 3;')}
                ${info('Approved cooking instruction', p?.cookingInstruction, 'grid-column:span 2;')}${info('Composition (approx.)', p ? compositionSummaryText(p.composition) : '', 'grid-column:span 2;')}
                ${info('Product remarks', p?.remarks, 'grid-column:span 4;')}
              </div>
              <div class="ssub-grid4" style="margin-top:6px;">
                ${sf('Certification / standard', 'certification')}
                ${sf('Currency', 'currency', null, null, 'THB')}
                ${sf('Lead time', 'leadTime')}
                ${sf('Customer comment / selling point', 'customerComment')}
              </div>
            </div>
          </div>
        </div>`;
    }).join('');


    return `
      <div class="part-block${isExpanded ? '' : ' collapsed'}" data-submission-id="${escapeHtml(s.id)}">
        <div class="part-header" style="margin-bottom:12px;">
          <button type="button" class="part-toggle-btn${isExpanded ? ' open' : ''}" title="Expand / collapse this submission">${icon('chevron-right')}</button>
          <span style="font-weight:700;font-size:14px;color:var(--primary-dark);">${escapeHtml(submissionLabel(s))}</span>
          <span class="part-header-summary">${ms.samples.length} sample${ms.samples.length === 1 ? '' : 's'}</span>
          ${isEditing ? `<button class="btn btn-sm" data-role="save-submission">${icon('save')} Save</button>` : `<button class="btn btn-sm" data-role="edit-submission">${icon('pencil')} Edit</button>`}
          <button class="btn btn-sm" data-role="print-submission">${icon('printer')} Print</button>
          ${shipOn ? `
          <button class="btn btn-sm" data-role="ship-doc" data-kind="packing" title="Packing List for this shipment">${icon('clipboard-check')} Packing List</button>
          <button class="btn btn-sm" data-role="ship-doc" data-kind="invoice" title="Sample Invoice (proforma, no commercial value) for customs">${icon('clipboard-check')} Sample Invoice</button>
          ` : ''}
          <button class="btn btn-sm btn-danger" data-role="delete-submission">${icon('x')} Delete</button>
        </div>
        <div class="part-body">
          <div class="card-title" style="font-size:13px;">Document and delivery information</div>
          <div class="ssub-grid4">
            ${formNoField}
            ${headerField('Customer', 'customer', null, 'customerDatalist')}
            ${headerField('Destination', 'destination', null, 'destinationDatalist')}
            ${headerField('Present. Date', 'presentDate', 'date')}
            ${headerField('Project Lead', 'projectLead', null, 'salesRepDatalist')}
            ${headerField('Coordinator', 'coordinator', null, 'salesRepDatalist')}
            ${headerField('Expected Receipt', 'expectedReceipt', 'date')}
            <div style="grid-column:span 2;">${headerField('Samples Delivery Company', 'deliveryCompany', null, 'customerDatalist')}</div>
            <div class="field" style="grid-column:span 2;margin-bottom:0;">
              <label>Samples Delivery Location</label>
              <select class="ssub-field ssub-delivery-loc" data-field="deliveryLocation" ${isEditing ? '' : 'disabled'}>${locationSelectOptionsHtml(ms.deliveryCompany, ms.deliveryLocation)}</select>
            </div>
          </div>
          ${docsBlock}
          ${shipDocsBlock}
          ${activity.length ? `<div class="reflist-item-meta" style="margin:10px 0;">${activity.join(' &nbsp;|&nbsp; ')}</div>` : ''}

          <div style="margin-top:14px;">${headerField('Purpose', 'purpose')}</div>

          <div class="card-title" style="font-size:13px;margin-top:20px;">Samples included in this submission</div>
          <div id="ssubSamplesBody-${escapeHtml(s.id)}">${samplesCardsHtml || '<div class="overview-empty">No samples added yet</div>'}</div>
          ${isEditing ? `<button class="btn btn-sm add-row-btn" data-role="add-sample" style="margin-top:8px;">+ Add Sample</button>` : ''}

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

          <div class="card-title" style="font-size:13px;margin-top:20px;">Follow-up</div>
          <div class="grid-3" style="margin-top:14px;">
            ${headerField('Feedback Owner', 'feedbackOwner', null, 'salesRepDatalist')}
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
                ${headerField('Name', 'preparedByName', null, 'salesRepDatalist')}
                ${headerField('Date', 'docDate', 'date')}
              </div>
            </div>
            <div>
              <div class="ssub-ack-title">Received by</div>
              <div class="grid-2">
                ${headerField('Name', 'receivedByName', null, 'salesRepDatalist')}
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
    s.docs = normalizeDocs(s.docs);

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

    // Print = the clean A4 form (see sampleSubmissions-docs.js), not the on-screen editor
    block.querySelector('[data-role="print-submission"]').addEventListener('click', () => openShipDoc(migrateSubmission(s), 'form'));

    block.querySelector('.ssub-shipdocs-check')?.addEventListener('change', e => {
      s.shipDocsOn = e.target.checked;
      scheduleSubmissionSave(s);
      renderSubmissionsList();
    });
    block.querySelectorAll('[data-role="ship-doc"]').forEach(btn => {
      btn.addEventListener('click', () => openShipDoc(migrateSubmission(s), btn.dataset.kind));
    });

    block.querySelector('[data-role="delete-submission"]').addEventListener('click', () => {
      if(!canDeleteRecord(s)){ alert(deleteNotAllowedMessage('sample submission', s)); return; }
      if(!confirm(`Delete "${submissionLabel(s)}"? This cannot be undone.`)) return;
      requestAuthConfirm(
        'Confirm Identity to Delete',
        'Enter your password to delete this sample submission.',
        () => {
          const deletedLabel = submissionLabel(s);
          submissions = submissions.filter(x => x.id !== s.id);
          moveToTrash('sampleSubmissions', s.id, s, deletedLabel);
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
          if(el.dataset.field === 'shipperName' || el.dataset.field === 'shipperAddress') rememberShipper(s);
          // Picking a Customer from the Company Directory fills Destination with its country, and the Samples Delivery Company with
          // that company and Location with its first location (all still editable, and only filled again when the Customer is
          // changed); a company with no country / location, or a name not in the directory, leaves them alone
          const refreshDeliveryLoc = (pickFirst) => {
            const sel = block.querySelector('.ssub-delivery-loc');
            const opts = companyLocations(s.deliveryCompany);
            if(pickFirst) s.deliveryLocation = opts[0] || '';
            if(sel) sel.innerHTML = locationSelectOptionsHtml(s.deliveryCompany, s.deliveryLocation);
          };
          if(el.dataset.field === 'customer'){
            const match = metaLists.customers.find(c => metaItemName(c) === s.customer);
            if(match && match.country){
              s.destination = match.country;
              const dest = block.querySelector('.ssub-field[data-field="destination"]');
              if(dest) dest.value = match.country;
            }
            if(match){
              s.deliveryCompany = s.customer;
              const co = block.querySelector('.ssub-field[data-field="deliveryCompany"]');
              if(co) co.value = s.customer;
              refreshDeliveryLoc(true);
            }
          }
          if(el.dataset.field === 'deliveryCompany') refreshDeliveryLoc(true);   // another company: its locations, the first one chosen
          scheduleSubmissionSave(s);
        });
      });

      // Docs Request checklist -- toggling any box re-renders so Tax
      // Invoice's/Other's own detail fields appear or disappear.
      block.querySelectorAll('.ssub-doc-check').forEach(el => {
        el.addEventListener('change', () => {
          s.docs[el.dataset.doc] = el.checked;
          scheduleSubmissionSave(s);
          renderSubmissionsList();
        });
      });
      block.querySelectorAll('.ssub-doc-field').forEach(el => {
        el.addEventListener('change', () => {
          s.docs.taxInvoiceDetails[el.dataset.field] = el.value.trim();
          scheduleSubmissionSave(s);
        });
      });
      block.querySelector('.ssub-doc-other-field')?.addEventListener('change', e => {
        s.docs.otherDetails = e.target.value.trim();
        scheduleSubmissionSave(s);
      });

      block.querySelector('[data-role="add-sample"]')?.addEventListener('click', () => {
        const sample = blankSample();
        s.nextSampleSeq = (s.nextSampleSeq || 0) + 1;
        sample.seq = s.nextSampleSeq;
        s.samples.push(sample);
        scheduleSubmissionSave(s);
        renderSubmissionsList();
      });
    }

    block.querySelectorAll('[data-role="remove-sample"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('[data-sample-id]');
        s.samples = s.samples.filter(x => x.id !== row.dataset.sampleId);
        scheduleSubmissionSave(s);
        renderSubmissionsList();
      });
    });

    block.querySelectorAll('.ssample-field').forEach(el => {
      el.addEventListener('change', () => {
        const row = el.closest('[data-sample-id]');
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
    // blur" trick as recipes.js's ingredient picker (recipes.js:2665-2717),
    // but sharing ONE dropdown element appended to <body> (see
    // getSharedProductSuggestBox) instead of one per row. A per-row
    // position:fixed dropdown was still getting silently misplaced/clipped
    // in real use -- ANY ancestor with an active transform (this app's own
    // page-transition animation on #mainArea, for instance) makes itself
    // the containing block for position:fixed descendants too, so "fixed"
    // wasn't reliably fixed to the viewport. A <body> child has no such
    // ancestor, ever, so this sidesteps the whole class of bug rather than
    // chasing each cause of it.
    if(isEditing){
      block.querySelectorAll('.ssample-product-input').forEach(input => {
        const row = input.closest('[data-sample-id]');
        const sample = s.samples.find(x => x.id === row.dataset.sampleId);
        if(!sample) return;
        function renderSuggestions(){
          if(document.activeElement !== input){
            closeProductSuggestBox();
            return;
          }
          const matches = fuzzyProductMatches(input.value, 8);
          if(matches.length === 0){
            closeProductSuggestBox();
            return;
          }
          const box = getSharedProductSuggestBox();
          box.innerHTML = matches.map(p => `
            <div class="ing-suggestion-item" data-id="${escapeHtml(p.id)}">
              <span class="ing-suggestion-name">${escapeHtml(productPickerLabel(p))}</span>
            </div>
          `).join('');
          const r = input.getBoundingClientRect();
          box.style.left = (window.scrollX + r.left) + 'px';
          box.style.top = (window.scrollY + r.bottom + 4) + 'px';
          box.style.width = r.width + 'px';
          box.classList.add('open');
          box.querySelectorAll('.ing-suggestion-item').forEach(item => {
            item.addEventListener('mousedown', e => {
              e.preventDefault();
              const matched = productList.find(x => x.id === item.dataset.id);
              if(matched){
                sample.productId = matched.id;
                sample.manualProductName = '';
                scheduleSubmissionSave(s);
              }
              closeProductSuggestBox();
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
        wireSuggestKeys(input, () => document.querySelector('.ssample-suggestions'), renderSuggestions);   // arrow keys + Enter pick from the list
        input.addEventListener('blur', closeProductSuggestBox);
        // The table's own horizontal-scroll wrapper can move the input out
        // from under an already-open dropdown -- just close it rather than
        // trying to track a moving target.
        input.closest('table')?.parentElement?.addEventListener('scroll', closeProductSuggestBox, { passive: true });
      });
    }
  });
}

export function attachSampleSubmissionsListener(){
  unsubscribeSubmissions = onSnapshot(sampleSubmissionsCol, snapshot => {
    submissions = snapshot.docs.map(d => d.data());
    submissionsLoaded = true;
    if(mainFeatureView !== 'sampleSubmissions') return;
    // Every keystroke in the Product box saves the submission, and that save comes straight back through this listener --
    // rebuilding the list then replaced the box mid-typing (one character, then the cursor was gone). While a field of the list
    // has focus the page already shows what was typed, so the rebuild is skipped.
    const a = document.activeElement;
    if(a && a.closest && a.closest('#submissionsList') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    renderSubmissionsList();
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
