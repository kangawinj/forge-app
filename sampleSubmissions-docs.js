// Shipping documents for a Sample Submission: a Packing List and a Sample Invoice (proforma, "no commercial value"), built
// from what the submission already holds (customer, courier, tracking, samples, quantities) plus the "Shipping documents"
// fields filled in on the submission. Shown on screen as an A4 sheet in an overlay with a Print button (choose "Save as PDF"
// in the print dialog to get a file); nothing is stored by this module.
import { escapeHtml, compositionSummaryText } from './app.js';
import { linkedProduct, sampleProductName, sampleIdFor, toNum, overallAvg, computeQuantitySummary, computeFollowUpSummary } from './sampleSubmissions-data.js';

const LAST_SHIPPER_KEY = 'forgeLastShipper';
// the shipper (who sends the samples) is nearly always the same, so a new submission starts with the one used last time
export function rememberShipper(s){
  try{ localStorage.setItem(LAST_SHIPPER_KEY, JSON.stringify({ shipperName: s.shipperName || '', shipperAddress: s.shipperAddress || '' })); }catch(e){ /* storage blocked: nothing is remembered */ }
}
export function lastShipper(){
  try{ const v = JSON.parse(localStorage.getItem(LAST_SHIPPER_KEY) || '{}'); return { shipperName: v.shipperName || '', shipperAddress: v.shipperAddress || '' }; }catch(e){ return { shipperName: '', shipperAddress: '' }; }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : '';
}
function todayIso(){ const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const num = (v, dp = 2) => { const n = toNum(v); return n === null ? '' : String(Math.round(n * 10 ** dp) / 10 ** dp); };
const money = v => (Math.round(v * 100) / 100).toFixed(2);
const lines = text => escapeHtml(text || '').replace(/\n/g, '<br>');

// the lines of the document: one per sample, quantity = what was actually sent (falls back to what was requested)
function sampleLines(s){
  return (s.samples || []).map((row, i) => {
    const p = linkedProduct(row);
    const qty = toNum(row.actualQtySent) ?? toNum(row.requestedQty) ?? 0;
    const bagG = toNum(row.netWtPerBag);
    return {
      no: i + 1, id: sampleIdFor(s, row), name: sampleProductName(row) || '-', code: p?.code || '',
      lot: row.lotNo || '', qty, bagG, netKg: bagG !== null ? qty * bagG / 1000 : null,
      storage: row.storage || '', remarks: row.remarks || '', unitValue: toNum(row.unitValue)
    };
  });
}

function partyBlock(title, name, address){
  return `<div class="ssdoc-party"><div class="ssdoc-party-title">${title}</div><div class="ssdoc-party-name">${escapeHtml(name) || '&nbsp;'}</div><div>${lines(address) || '&nbsp;'}</div></div>`;
}
function metaRow(label, value, span){
  return `<td class="ssdoc-meta-l">${label}</td><td${span ? ` colspan="${span}"` : ''}>${escapeHtml(value) || '&nbsp;'}</td>`;
}
function signBlock(s){
  return `<div class="ssdoc-sign">
    <div><div class="ssdoc-sign-line"></div>Prepared by: ${escapeHtml(s.preparedByName) || '&nbsp;'}<br>Date: ${escapeHtml(fmtDate(s.docDate || s.preparedByDate)) || '&nbsp;'}</div>
    <div><div class="ssdoc-sign-line"></div>Authorized signature / company stamp</div>
  </div>`;
}

function packingListHtml(s){
  const ls = sampleLines(s);
  const totalQty = ls.reduce((a, l) => a + l.qty, 0);
  const totalNet = ls.reduce((a, l) => a + (l.netKg || 0), 0);
  const tax = (s.docs && s.docs.taxInvoiceDetails) || {};
  return `
    <div class="ssdoc-title">PACKING LIST</div>
    <div class="ssdoc-sub">Samples for evaluation</div>
    <div class="ssdoc-parties">
      ${partyBlock('Shipper', s.shipperName, s.shipperAddress)}
      ${partyBlock('Consignee', s.consigneeName || s.customer, s.consigneeAddress)}
    </div>
    <div class="ssdoc-h">Shipment information</div>
    <table class="ssdoc-meta ssdoc-compact">
      <tr>${metaRow('Packing list no.', s.formNo)}${metaRow('Date', fmtDate(s.docDate || todayIso()))}${metaRow('Destination', s.destination)}</tr>
      <tr>${metaRow('Flight / carrier', [tax.carrierName, tax.flightNo].filter(Boolean).join(' '))}${metaRow('Port of loading', tax.portOfLoading)}${metaRow('Port of destination', tax.portOfDestination)}</tr>
      <tr>${metaRow('No. of cartons', s.cartons)}${metaRow('Gross weight (kg)', num(s.grossWeightKg))}${metaRow('Carton size (cm)', s.cartonSize)}</tr>
    </table>
    <div class="ssdoc-h">Items</div>
    <table class="ssdoc-table">
      <thead><tr><th>No.</th><th>Sample ID</th><th>Description</th><th>Lot no.</th><th>Qty (bags)</th><th>Net wt / bag (g)</th><th>Net wt (kg)</th><th>Storage</th></tr></thead>
      <tbody>${ls.map(l => `<tr><td class="c">${l.no}</td><td>${escapeHtml(l.id)}</td><td>${escapeHtml(l.name)}${l.code ? `<div class="ssdoc-dim">${escapeHtml(l.code)}</div>` : ''}</td><td>${escapeHtml(l.lot)}</td><td class="r">${l.qty}</td><td class="r">${l.bagG !== null ? num(l.bagG) : ''}</td><td class="r">${l.netKg !== null ? num(l.netKg, 3) : ''}</td><td>${escapeHtml(l.storage)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4" class="r"><b>Total</b></td><td class="r"><b>${totalQty}</b></td><td></td><td class="r"><b>${num(totalNet, 3)}</b></td><td></td></tr></tfoot>
    </table>
    ${s.handling ? `<div class="ssdoc-note"><b>Handling:</b> ${lines(s.handling)}</div>` : ''}
    <div class="ssdoc-note">Samples for evaluation only. Not for resale.</div>
    ${signBlock(s)}`;
}

function sampleInvoiceHtml(s){
  const ls = sampleLines(s);
  const cur = s.invoiceCurrency || 'USD';
  const origin = s.countryOfOrigin || 'Thailand';
  const total = ls.reduce((a, l) => a + (l.unitValue !== null ? l.unitValue * l.qty : 0), 0);
  const totalQty = ls.reduce((a, l) => a + l.qty, 0);
  const tax = (s.docs && s.docs.taxInvoiceDetails) || {};
  return `
    <div class="ssdoc-title">SAMPLE INVOICE <span class="ssdoc-title-sm">(Proforma)</span></div>
    <div class="ssdoc-sub ssdoc-strong">${escapeHtml(s.exportReason || 'FREE SAMPLES - NO COMMERCIAL VALUE')}</div>
    <div class="ssdoc-parties">
      ${partyBlock('Shipper / Exporter', s.shipperName, s.shipperAddress)}
      ${partyBlock('Consignee', s.consigneeName || s.customer, s.consigneeAddress)}
    </div>
    <div class="ssdoc-h">Shipment information</div>
    <table class="ssdoc-meta ssdoc-compact">
      <tr>${metaRow('Invoice no.', s.formNo)}${metaRow('Date', fmtDate(s.docDate || todayIso()))}${metaRow('Destination', s.destination)}</tr>
      <tr>${metaRow('Flight / carrier', [tax.carrierName, tax.flightNo].filter(Boolean).join(' '))}${metaRow('Port of loading', tax.portOfLoading)}${metaRow('Port of destination', tax.portOfDestination)}</tr>
      <tr>${metaRow('Country of origin', origin)}<td colspan="4"></td></tr>
    </table>
    <div class="ssdoc-h">Items</div>
    <table class="ssdoc-table">
      <thead><tr><th>No.</th><th>Description of goods</th><th>HS code</th><th>Origin</th><th>Qty (bags)</th><th>Unit value (${escapeHtml(cur)})</th><th>Total value (${escapeHtml(cur)})</th></tr></thead>
      <tbody>${ls.map(l => `<tr><td class="c">${l.no}</td><td>${escapeHtml(l.name)}${l.bagG !== null ? `<div class="ssdoc-dim">${num(l.bagG)} g / bag${l.lot ? ` · Lot ${escapeHtml(l.lot)}` : ''}</div>` : (l.lot ? `<div class="ssdoc-dim">Lot ${escapeHtml(l.lot)}</div>` : '')}</td><td>${escapeHtml(s.hsCode)}</td><td>${escapeHtml(origin)}</td><td class="r">${l.qty}</td><td class="r">${l.unitValue !== null ? money(l.unitValue) : ''}</td><td class="r">${l.unitValue !== null ? money(l.unitValue * l.qty) : ''}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4" class="r"><b>Total</b></td><td class="r"><b>${totalQty}</b></td><td></td><td class="r"><b>${escapeHtml(cur)} ${money(total)}</b></td></tr></tfoot>
    </table>
    <div class="ssdoc-note">Value declared for customs purposes only. These goods are samples sent free of charge for evaluation, with no commercial value and not for resale.</div>
    ${signBlock(s)}`;
}

// The whole submission as one clean A4 form (replaces printing the on-screen form): document and delivery details, the docs
// requested, the samples, the product specification of each, and -- only once something has been entered -- the customer
// evaluation, follow-up, notes and acknowledgement.
function submissionFormHtml(s){
  const samples = s.samples || [];
  const d = s.docs || {};
  const tax = d.taxInvoiceDetails || {};
  const taxBits = [tax.carrierName, tax.flightNo, tax.portOfLoading && `from ${tax.portOfLoading}`, tax.portOfDestination && `to ${tax.portOfDestination}`].filter(Boolean);
  const picked = [d.specification && 'Specification', d.quotation && 'Quotation',
    d.taxInvoice && ('Tax Invoice' + (taxBits.length ? ` (${taxBits.join(' · ')})` : '')),
    d.other && ('Other' + (d.otherDetails ? ` (${d.otherDetails})` : ''))].filter(Boolean);
  const rowsHtml = samples.map((r, i) => {
    const req = toNum(r.requestedQty), act = toNum(r.actualQtySent);
    return `<tr><td class="c">${i + 1}</td><td>${escapeHtml(sampleIdFor(s, r))}</td><td>${escapeHtml(sampleProductName(r) || '-')}</td><td>${escapeHtml(r.developmentStatus)}</td><td>${escapeHtml(r.lotNo)}</td><td class="r">${req ?? ''}</td><td class="r">${act ?? ''}</td><td class="r">${escapeHtml(r.netWtPerBag)}</td><td>${escapeHtml(r.storage)}</td><td>${escapeHtml(r.remarks)}</td></tr>`;
  }).join('');
  const specHtml = samples.map(r => {
    const p = linkedProduct(r);
    const img = p && (p.rmImage || p.ideaMenuImage);
    return `<div class="ssdoc-spec"><div class="ssdoc-spec-h">${img ? `<img class="ssdoc-spec-img" src="${escapeHtml(img)}" alt="">` : ''}${escapeHtml(sampleIdFor(s, r))} — ${escapeHtml(sampleProductName(r) || '-')}${p && p.code ? ` <span class="ssdoc-dim">(${escapeHtml(p.code)})</span>` : ''}${p && p.sampleCode ? ` <span class="ssdoc-dim">· Sample code ${escapeHtml(p.sampleCode)}</span>` : ''}</div>
      <table class="ssdoc-meta ssdoc-compact">
        <tr>${metaRow('Cooking instruction', p?.cookingInstruction)}${metaRow('Composition (approx.)', p ? compositionSummaryText(p.composition) : '')}</tr>
        <tr>${metaRow('Allergen statement', p?.allergens)}${metaRow('Country of origin', p?.processedArea)}</tr>
        <tr>${metaRow('Factory', p?.factory)}${metaRow('Certification / standard', r.certification)}</tr>
        <tr>${metaRow('Standards / packing style', p?.packingStyle)}${metaRow('Size', p?.size)}</tr>
        <tr>${metaRow('MOQ (ctn)', p?.moq)}${metaRow('Price', [r.currency, p && p.exwPrice !== '' && p.exwPrice != null ? `EXW ${p.exwPrice}` : '', p && p.salesPrice !== '' && p.salesPrice != null ? `Sales ${p.salesPrice}` : ''].filter(Boolean).join(' · '))}</tr>
        <tr>${metaRow('Lead time', r.leadTime)}${metaRow('Product remarks', p?.remarks)}</tr>
        ${r.customerComment ? `<tr>${metaRow('Customer comment', r.customerComment)}<td colspan="2"></td></tr>` : ''}
      </table></div>`;
  }).join('');
  const followMeta = [s.feedbackOwner, s.feedbackDue, s.nextReview].some(Boolean);
  return `
    <div class="ssdoc-title">SAMPLE SUBMISSION FORM</div>
    <div class="ssdoc-sub">${escapeHtml(s.formNo)}${s.status ? ` &nbsp;·&nbsp; ${escapeHtml(s.status)}` : ''}</div>
    <div class="ssdoc-h">Document and delivery information</div>
    <table class="ssdoc-meta ssdoc-compact">
      <tr>${metaRow('Form no.', s.formNo)}${metaRow('Customer', s.customer)}${metaRow('Destination', s.destination)}</tr>
      <tr>${metaRow('Present. date', fmtDate(s.presentDate))}${metaRow('Project lead', s.projectLead)}${metaRow('Coordinator', s.coordinator)}</tr>
      <tr>${metaRow('Expected receipt', fmtDate(s.expectedReceipt))}${metaRow('Samples delivery location', [s.deliveryCompany, s.deliveryLocation].filter(Boolean).join(' — '))}${metaRow('Doc. date', fmtDate(s.docDate))}</tr>
      <tr>${metaRow('Purpose', s.purpose)}${metaRow('Handling', s.handling)}<td colspan="2"></td></tr>
      <tr>${metaRow('Docs requested', picked.join(', ') || '-', 5)}</tr>
    </table>
    <div class="ssdoc-h">Samples included</div>
    <table class="ssdoc-table ssdoc-sm"><thead><tr><th>No.</th><th>Sample ID</th><th>Product</th><th>Dev. status</th><th>Lot no.</th><th>Req. qty</th><th>Sent qty</th><th>Net wt/bag (g)</th><th>Storage</th><th>Remarks</th></tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="10" class="c">No samples added</td></tr>'}</tbody></table>
    ${samples.length ? `<div class="ssdoc-h">Product specification</div>${specHtml}` : ''}
    ${followMeta ? `<table class="ssdoc-meta ssdoc-compact"><tr>${metaRow('Feedback owner', s.feedbackOwner)}${metaRow('Feedback due', fmtDate(s.feedbackDue))}</tr><tr>${metaRow('Next review', fmtDate(s.nextReview))}<td colspan="2"></td></tr></table>` : ''}
    ${s.notes ? `<div class="ssdoc-note"><b>Notes:</b> ${lines(s.notes)}</div>` : ''}
    <div class="ssdoc-sign">
      <div><div class="ssdoc-sign-line"></div>Prepared by: ${escapeHtml(s.preparedByName) || '&nbsp;'}<br>Date: ${escapeHtml(fmtDate(s.docDate || s.preparedByDate)) || '&nbsp;'}</div>
      <div><div class="ssdoc-sign-line"></div>Received by: ${escapeHtml(s.receivedByName) || '&nbsp;'}<br>Date: ${escapeHtml(fmtDate(s.receivedByDate)) || '&nbsp;'}</div>
    </div>`;
}

export function openShipDoc(s, kind){
  if(kind !== 'form' && !(s.samples || []).length){ alert('Add at least one sample to this submission first.'); return; }
  document.getElementById('ssdocOverlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ssdocOverlay';
  overlay.className = 'ssdoc-overlay';
  overlay.innerHTML = `
    <div class="ssdoc-toolbar">
      <span class="ssdoc-hint">${kind === 'form' ? 'In the print dialog choose "Save as PDF" for a file.' : 'Fill any blank on the submission (Shipping documents section) and open this again. In the print dialog choose "Save as PDF" for a file.'}</span>
      <button type="button" class="btn btn-primary btn-sm" data-role="ssdoc-print">Print</button>
      <button type="button" class="btn btn-sm" data-role="ssdoc-close">Close</button>
    </div>
    <div class="ssdoc-sheet">${kind === 'invoice' ? sampleInvoiceHtml(s) : (kind === 'form' ? submissionFormHtml(s) : packingListHtml(s))}</div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('ssdoc-open');
  const close = () => { overlay.remove(); document.body.classList.remove('ssdoc-open'); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if(e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.querySelector('[data-role="ssdoc-close"]').addEventListener('click', close);
  overlay.querySelector('[data-role="ssdoc-print"]').addEventListener('click', () => window.print());
}
