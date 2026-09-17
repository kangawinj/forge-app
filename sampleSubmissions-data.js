// Sample Submissions -- pure data/model helpers (submission/sample shape
// builders, migration, Firestore save helpers, Project/Product lookups,
// the shared Product-picker suggestion box, and summary computations),
// no full-list rendering. Split out of sampleSubmissions.js -- see that
// file's own top-of-file comment for the overall file split.
import {
  uid, currentUser, sampleSubmissionsCol, productList, db,
  sampleSubmissionCountersCol, projects
} from './app.js';
import {
  setDoc, doc, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const SUBMISSION_DECISION_OPTIONS = ['Approved', 'Revise', 'Rejected'];
export const SUBMISSION_DEV_STATUS_OPTIONS = ['Ready', 'In Process', 'On Hold'];

export function submissionLabel(s){
  return s.formNo ? `${s.formNo}${s.customer ? ' — ' + s.customer : ''}` : (s.customer || 'Untitled submission');
}

// Sample ID is always derived from the submission's own Form No. (so a
// sample can be traced back to which shipment it came from at a glance),
// never typed by hand -- see the "seq" field on each sample below. It's
// stable once assigned: a sample keeps its seq for life regardless of
// where it sits in the list, so deleting or reordering other rows never
// changes it, and it's never reused once assigned even after a delete
// (nextSampleSeq only ever counts up, matching issueSubmissionFormNo's
// own never-reused-number guarantee).
export function sampleIdFor(s, sample){
  return sample.seq ? `${s.formNo || 'SS-----'}-S${String(sample.seq).padStart(2, '0')}` : '—';
}
// Defensive fix-up for a sample that predates this feature (seq missing)
// -- assigns it the next number in this submission's own sequence,
// exactly like a freshly-added sample would get (see "+ Add Sample"
// below), and reports whether anything actually changed so the caller
// only re-saves when needed.
export function backfillSampleSeqs(s){
  let changed = false;
  if(typeof s.nextSampleSeq !== 'number'){ s.nextSampleSeq = 0; changed = true; }
  s.samples.forEach(sample => {
    if(!sample.seq){
      s.nextSampleSeq += 1;
      sample.seq = s.nextSampleSeq;
      changed = true;
    }
  });
  return changed;
}

export function blankSample(){
  return {
    id: uid(), seq: null, productId: '', manualProductName: '',
    developmentStatus: '', lotNo: '',
    requestedQty: '', actualQtySent: '', netWtPerBag: '', storage: '', remarks: '',
    taste: '', texture: '', appearance: '', convenience: '',
    decision: '', feedback: '', owner: '', dueDate: '', nextAction: '',
    certification: '', currency: '', leadTime: '', customerComment: ''
  };
}

// Docs Request -- a checklist rather than free text, per the user's
// requested format. taxInvoiceDetails only matters (and only renders)
// when taxInvoice is checked; otherDetails only when other is checked.
export function blankDocs(){
  return {
    specification: false, quotation: false, taxInvoice: false, other: false,
    taxInvoiceDetails: {
      carrierName: '', flightNo: '', portOfLoading: '', portOfDestination: '',
      departureDateTime: '', arrivalDateTime: ''
    },
    otherDetails: ''
  };
}
// A submission saved before Docs became a checklist has `docs` as a plain
// string -- rather than silently dropping whatever was typed there, it's
// carried forward into the "Other documents" checkbox/detail field, the
// closest equivalent in the new shape.
export function normalizeDocs(docs){
  if(docs && typeof docs === 'object'){
    return { ...blankDocs(), ...docs, taxInvoiceDetails: { ...blankDocs().taxInvoiceDetails, ...(docs.taxInvoiceDetails || {}) } };
  }
  const blank = blankDocs();
  if(typeof docs === 'string' && docs.trim()){
    blank.other = true;
    blank.otherDetails = docs;
  }
  return blank;
}

export function blankSubmission(){
  return {
    id: uid(), projectId: '',
    formNo: '', docDate: '', courier: '', customer: '', projectLead: '',
    expectedReceipt: '', trackingNo: '', destination: '', coordinator: '', deliveryLocation: '',
    shipmentStorage: '', purpose: '', presentDate: '', receiver: '', docs: blankDocs(),
    samples: [], nextSampleSeq: 0,
    handling: '', status: '',
    feedbackOwner: '', feedbackDue: '', nextReview: '', notes: '',
    preparedByName: '', preparedByDate: '', receivedByName: '', receivedByDate: '',
    createdBy: currentUser?.email || '', createdAt: Date.now(),
    updatedBy: currentUser?.email || '', updatedAt: Date.now()
  };
}
export function migrateSubmission(s){
  return {
    ...s,
    docs: normalizeDocs(s.docs),
    samples: Array.isArray(s.samples) ? s.samples.map(row => ({ ...blankSample(), ...row })) : []
  };
}

export function saveSubmissionToCloud(s){
  return setDoc(doc(sampleSubmissionsCol, s.id), s);
}
export function scheduleSubmissionSave(s){
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
export async function issueSubmissionFormNo(){
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

// Looks up a submission's linked Project (for the "Project" picker's
// auto-fill, see applyProjectAutofill below). Only meaningful for a user
// who can see Projects at all -- callers must check hasModuleAccess
// ('projects') before rendering the picker in the first place.
export function linkedProject(s){
  return s.projectId ? (projects.find(p => p.id === s.projectId) || null) : null;
}
// One-shot copy (not a live lookup like linkedProduct below) -- picking a
// Project is meant to pre-fill a starting point for these fields, which
// the user can then freely edit without it snapping back if the Project
// record changes later. customerName/destinationCountry are a direct
// match; Project Lead/Coordinator map to a Project's PD (Responsible
// Person) and Sales Rep, the closest existing equivalents.
export function applyProjectAutofill(s, project){
  if(!project) return;
  s.customer = project.customerName || '';
  s.destination = project.destinationCountry || '';
  s.projectLead = project.responsiblePerson || '';
  s.coordinator = project.ownerSalesRep || '';
}

// Looks up a sample row's linked Product List item live (never copied onto
// the row) so an edit to the Product List record is reflected everywhere
// it's referenced without re-entry -- see the plan's "single source of
// truth" decision. Returns null for a manual/unlinked row.
export function linkedProduct(sample){
  return sample.productId ? (productList.find(p => p.id === sample.productId) || null) : null;
}
export function sampleProductName(sample){
  const p = linkedProduct(sample);
  return p ? p.name : (sample.manualProductName || '');
}
export function productPickerLabel(p){
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
export function fuzzyProductMatches(query, limit){
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

// One suggestion dropdown shared across every sample row's Product
// picker, appended straight to <body> so it's never subject to an
// ancestor's overflow clipping or transform-containing-block quirks --
// see the product-picker wiring below for why that matters. Lazily
// created once and reused for the page's lifetime (renderSubmissionsList
// rebuilds #submissionsList often, but never touches <body> itself, so
// this survives every re-render without leaking a fresh element each time).
let sharedProductSuggestBox = null;
export function getSharedProductSuggestBox(){
  if(!sharedProductSuggestBox){
    sharedProductSuggestBox = document.createElement('div');
    sharedProductSuggestBox.className = 'ing-suggestions ssample-suggestions';
    document.body.appendChild(sharedProductSuggestBox);
  }
  return sharedProductSuggestBox;
}
export function closeProductSuggestBox(){
  if(sharedProductSuggestBox){
    sharedProductSuggestBox.classList.remove('open');
    sharedProductSuggestBox.innerHTML = '';
  }
}

export function toNum(v){
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}
// Requested/Sent/Ready/Variance -- computed fresh from samples[] on every
// render, never a separately-edited field that could drift out of sync
// with the rows it summarizes (see the plan's "summaries are computed"
// decision).
export function computeQuantitySummary(samples){
  const requested = samples.reduce((s, row) => s + (toNum(row.requestedQty) || 0), 0);
  const sent = samples.reduce((s, row) => s + (toNum(row.actualQtySent) || 0), 0);
  const ready = samples.filter(row => row.developmentStatus === 'Ready').length;
  return { requested, sent, variance: sent - requested, ready, total: samples.length };
}
export function computeFollowUpSummary(samples){
  const counts = { Approved: 0, Revise: 0, Rejected: 0, 'No decision': 0 };
  samples.forEach(row => {
    const d = SUBMISSION_DECISION_OPTIONS.includes(row.decision) ? row.decision : 'No decision';
    counts[d]++;
  });
  return counts;
}
export function overallAvg(row){
  const scores = [row.taste, row.texture, row.appearance, row.convenience].map(toNum).filter(v => v !== null);
  return scores.length ? (scores.reduce((s,v) => s+v, 0) / scores.length) : null;
}
