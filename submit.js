// Standalone public "share a link" project intake page — deliberately
// NOT part of the main authenticated app (doesn't import app.js/
// projects.js at all, no Firebase Auth). Anyone with a link like
// submit.html?token=... can fill this in and save without ever logging
// in; the token itself (not a login) is what Firestore's security rules
// use to scope what they can touch, to exactly one pendingSubmissions
// doc — see the /pendingSubmissions rule in firestore.rules for the
// other half of that story.
//
// Deliberately out of scope for this first version: Idea/Reference
// Images, the Product pricing table, and Recipe file attachments --
// each would mean either exposing more of the authenticated app's own
// Firestore collections/Storage to the public, or base64-inlining
// photos into this doc and risking Firestore's 1MiB document limit on a
// form nobody in-house is watching fill up. Everything else on the New
// Project form (all its plain text/number/date fields, plus the Cooking
// Guidelines steps list) is here.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCAgzfoTpXFCOijaenipzH1Ev1gYXOceTU",
  authDomain: "forge-food-dev.firebaseapp.com",
  projectId: "forge-food-dev",
  storageBucket: "forge-food-dev.firebasestorage.app",
  messagingSenderId: "887048653492",
  appId: "1:887048653492:web:deb9535727e37fb1fea5e1",
  measurementId: "G-JXPV3WHGTE"
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// Kept in sync manually with PROJECT_STATUSES in projects.js -- this page
// can't import that module directly, since projects.js pulls in the
// entire authenticated app (Firebase Auth, every other collection) this
// page is deliberately built to avoid needing at all.
const PROJECT_STATUSES = ['Not Started', 'In Progress', 'Blocked / On Hold', 'In Review', 'Completed', 'Cancelled'];
const PROJECT_STATUS_LABELS = {
  'Not Started': 'Not Started (ยังไม่เริ่ม)',
  'In Progress': 'In Progress (กำลังดำเนินการ)',
  'Blocked / On Hold': 'Blocked / On Hold (ติดปัญหา / รอการตัดสินใจ)',
  'In Review': 'In Review (รอตรวจสอบ)',
  'Completed': 'Completed (เสร็จสมบูรณ์)',
  'Cancelled': 'Cancelled (ยกเลิก)'
};

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function blankSubmission(){
  return {
    submissionStatus: 'pending', createdAt: Date.now(), updatedAt: Date.now(),
    name: '', status: PROJECT_STATUSES[0], requestDate: '', startDate: '', targetEndDate: '',
    customerName: '', destinationCountry: '',
    ownerSalesRep: '', factorySalesRep: '', responsiblePerson: '', factoryName: '',
    portionWeightQty: '', portionWeightUnit: '', portionPerUnit: '',
    innerPackQty: '', innerPackWeightUnit: '', innerPackUnit: '',
    outerPackQty: '', outerPackUnit: '', outerPackContainerUnit: '',
    moqQty: '', moqUnit: '',
    requirements: {
      packagingCondition: '', storageCondition: '', shelfLife: '',
      composition: '', recipe: '',
      cookingCondition: { method: '', steps: [] },
      note: '', certificate: ''
    }
  };
}

const token = new URLSearchParams(location.search).get('token') || '';
const bannerEl = document.getElementById('submitStatusBanner');
const rootEl = document.getElementById('submitFormRoot');
function showBanner(html, kind){
  bannerEl.className = kind === 'error' ? '' : 'overview-empty';
  bannerEl.style.display = 'block';
  bannerEl.style.marginBottom = '16px';
  if(kind === 'error'){
    bannerEl.style.cssText += 'background:#c0392b;color:#fff;padding:10px 16px;border-radius:var(--radius);font-size:13px;';
  }
  bannerEl.innerHTML = html;
}

// Cooking Guidelines' steps list is edited as plain state here, same
// "staged array, re-rendered on every change" pattern the main app uses
// for the same field.
let cookingSteps = [];

async function init(){
  if(!token){
    showBanner('This link is missing its token — please ask for the share link again.', 'error');
    return;
  }
  let data;
  try{
    const snap = await getDoc(doc(db, 'pendingSubmissions', token));
    data = snap.exists() ? snap.data() : blankSubmission();
  }catch(err){
    showBanner('Could not load this form: ' + (err.message || err), 'error');
    return;
  }
  if(data.submissionStatus === 'imported'){
    showBanner('This submission has already been processed by our team. If you need to make further changes, please contact whoever sent you this link.', 'info');
    return;
  }
  cookingSteps = [...(data.requirements?.cookingCondition?.steps || [])];
  render(data);
}

function stepsListHtml(){
  const rows = cookingSteps.map((s, i) => `
    <div class="trial-string-list-row" data-idx="${i}">
      <span class="trial-string-list-num">${i + 1}.</span>
      <input type="text" class="cooking-step-input" value="${escapeHtml(s)}" placeholder="e.g. Reheat from frozen, 2-3 minutes">
      <button type="button" class="icon-btn" data-role="remove-step" data-idx="${i}" title="Remove">×</button>
    </div>
  `).join('');
  return rows + `<button type="button" class="btn btn-sm add-row-btn" id="addStepBtn">+ Add</button>`;
}

function render(data){
  rootEl.innerHTML = `
    <div class="card">
      <div class="requirements-box" style="margin-top:0;">
        <div class="requirements-box-title">Project Information</div>
        <div class="project-header-grid">
          <div class="field" style="margin-bottom:0;">
            <label>Project Name</label>
            <input type="text" id="fName" value="${escapeHtml(data.name)}" placeholder="e.g. Sunrise Foods Q3 Launch">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Status</label>
            <select class="proj-select" id="fStatus">
              ${PROJECT_STATUSES.map(s => `<option value="${escapeHtml(s)}" ${s === data.status ? 'selected' : ''}>${escapeHtml(PROJECT_STATUS_LABELS[s])}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Request Date</label>
            <input type="date" id="fRequestDate" value="${escapeHtml(data.requestDate)}">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Start Date</label>
            <input type="date" id="fStartDate" value="${escapeHtml(data.startDate)}">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Target / End Date</label>
            <input type="date" id="fTargetEndDate" value="${escapeHtml(data.targetEndDate)}">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Customer Name</label>
            <input type="text" id="fCustomer" value="${escapeHtml(data.customerName)}" placeholder="e.g. ABC Trading Co.">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Destination Country</label>
            <input type="text" id="fDestination" value="${escapeHtml(data.destinationCountry)}" placeholder="e.g. Japan">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Project Owner</label>
            <input type="text" id="fOwner" value="${escapeHtml(data.ownerSalesRep)}" placeholder="e.g. Somchai">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Factory Sales Rep</label>
            <input type="text" id="fFactoryRep" value="${escapeHtml(data.factorySalesRep)}" placeholder="e.g. Preecha">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Responsible Person (PD)</label>
            <input type="text" id="fResponsible" value="${escapeHtml(data.responsiblePerson)}" placeholder="e.g. Kanya">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Factory</label>
            <input type="text" id="fFactory" value="${escapeHtml(data.factoryName)}" placeholder="e.g. Rayong Plant 2">
          </div>
        </div>
      </div>
      <div class="requirements-box">
        <div class="requirements-box-title">Requirements</div>
        <div class="project-header-grid" style="margin-bottom:8px;">
          <div class="field" style="margin-bottom:0;">
            <label>Portion Weight</label>
            <div class="combo-row">
              <input type="number" id="fPortionQty" value="${escapeHtml(data.portionWeightQty)}" placeholder="e.g. 20" step="any" min="0">
              <input type="text" id="fPortionUnit" value="${escapeHtml(data.portionWeightUnit)}" placeholder="e.g. g">
              <span>/</span>
              <input type="text" id="fPortionPerUnit" value="${escapeHtml(data.portionPerUnit)}" placeholder="e.g. pcs">
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Inner Packing</label>
            <div class="combo-row">
              <input type="number" id="fInnerQty" value="${escapeHtml(data.innerPackQty)}" placeholder="e.g. 30" step="any" min="0">
              <input type="text" id="fInnerWeightUnit" value="${escapeHtml(data.innerPackWeightUnit)}" placeholder="e.g. g">
              <span>/</span>
              <input type="text" id="fInnerPackUnit" value="${escapeHtml(data.innerPackUnit)}" placeholder="e.g. pack">
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Outer Packing</label>
            <div class="combo-row">
              <input type="number" id="fOuterQty" value="${escapeHtml(data.outerPackQty)}" placeholder="e.g. 24" step="any" min="0">
              <input type="text" id="fOuterPackUnit" value="${escapeHtml(data.outerPackUnit)}" placeholder="e.g. pack">
              <span>/</span>
              <input type="text" id="fOuterContainerUnit" value="${escapeHtml(data.outerPackContainerUnit)}" placeholder="e.g. carton">
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>MOQ</label>
            <div class="combo-row">
              <input type="number" id="fMoqQty" value="${escapeHtml(data.moqQty)}" placeholder="e.g. 500" step="any" min="0">
              <input type="text" id="fMoqUnit" value="${escapeHtml(data.moqUnit)}" placeholder="e.g. pcs">
            </div>
          </div>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Packaging condition</label>
          <textarea id="fPackaging" placeholder="e.g. Microwaveable black plastic tray">${escapeHtml(data.requirements?.packagingCondition)}</textarea>
        </div>
        <div class="project-header-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:8px;">
          <div class="field" style="margin-bottom:0;">
            <label>Storage Condition</label>
            <input type="text" id="fStorageCondition" value="${escapeHtml(data.requirements?.storageCondition)}" placeholder="e.g. Keep frozen at -18°C">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Shelf Life (from production date)</label>
            <input type="text" id="fShelfLife" value="${escapeHtml(data.requirements?.shelfLife)}" placeholder="e.g. 12 months">
          </div>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Composition</label>
          <textarea id="fComposition" placeholder="e.g. Teriyaki Sauce: Soy Sauce 40%, Mirin 25%, Sugar 20%, Sake 15%">${escapeHtml(data.requirements?.composition)}</textarea>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Recipe</label>
          <textarea id="fRecipe" placeholder="Reference / attachment notes">${escapeHtml(data.requirements?.recipe)}</textarea>
        </div>
        <div class="field requirements-box-divider-below" style="margin-bottom:8px;">
          <label>Cooking Guidelines</label>
          <input type="text" id="fCookingMethod" value="${escapeHtml(data.requirements?.cookingCondition?.method)}" placeholder="e.g. Microwave">
          <div style="margin-top:8px;" id="stepsListRoot">${stepsListHtml()}</div>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Note</label>
          <textarea id="fNote" placeholder="Anything else not covered above">${escapeHtml(data.requirements?.note)}</textarea>
        </div>
        <div class="field requirements-box-divider" style="margin-bottom:0;">
          <label>Certificate</label>
          <input type="text" id="fCertificate" value="${escapeHtml(data.requirements?.certificate)}" placeholder="e.g. Halal certificate">
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;align-items:center;">
        <button class="btn btn-primary btn-sm" id="btnSubmit">Save</button>
        <span id="submitFeedback" style="font-size:13px;color:var(--text-dim);"></span>
      </div>
    </div>
  `;

  document.getElementById('stepsListRoot').querySelectorAll('[data-role="remove-step"]').forEach(btn => {
    btn.addEventListener('click', () => {
      cookingSteps.splice(parseInt(btn.dataset.idx, 10), 1);
      document.getElementById('stepsListRoot').innerHTML = stepsListHtml();
      wireStepsList();
    });
  });
  wireStepsList();

  document.getElementById('btnSubmit').addEventListener('click', () => save(data));
}

function wireStepsList(){
  const root = document.getElementById('stepsListRoot');
  root.querySelectorAll('.cooking-step-input').forEach((inp, idx) => {
    inp.addEventListener('change', () => { cookingSteps[idx] = inp.value.trim(); });
  });
  root.querySelectorAll('[data-role="remove-step"]').forEach(btn => {
    btn.addEventListener('click', () => {
      cookingSteps.splice(parseInt(btn.dataset.idx, 10), 1);
      root.innerHTML = stepsListHtml();
      wireStepsList();
    });
  });
  document.getElementById('addStepBtn').addEventListener('click', () => {
    cookingSteps.push('');
    root.innerHTML = stepsListHtml();
    wireStepsList();
  });
}

async function save(existing){
  const btn = document.getElementById('btnSubmit');
  const feedback = document.getElementById('submitFeedback');
  const v = id => document.getElementById(id).value.trim();
  const name = v('fName');
  if(!name){
    feedback.textContent = 'Please enter a Project Name before saving.';
    feedback.style.color = 'var(--danger)';
    document.getElementById('fName').focus();
    return;
  }
  btn.disabled = true;
  feedback.style.color = 'var(--text-dim)';
  feedback.textContent = 'Saving...';
  const payload = {
    submissionStatus: 'pending',
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
    name,
    status: v('fStatus'),
    requestDate: v('fRequestDate'), startDate: v('fStartDate'), targetEndDate: v('fTargetEndDate'),
    customerName: v('fCustomer'), destinationCountry: v('fDestination'),
    ownerSalesRep: v('fOwner'), factorySalesRep: v('fFactoryRep'), responsiblePerson: v('fResponsible'), factoryName: v('fFactory'),
    portionWeightQty: v('fPortionQty'), portionWeightUnit: v('fPortionUnit'), portionPerUnit: v('fPortionPerUnit'),
    innerPackQty: v('fInnerQty'), innerPackWeightUnit: v('fInnerWeightUnit'), innerPackUnit: v('fInnerPackUnit'),
    outerPackQty: v('fOuterQty'), outerPackUnit: v('fOuterPackUnit'), outerPackContainerUnit: v('fOuterContainerUnit'),
    moqQty: v('fMoqQty'), moqUnit: v('fMoqUnit'),
    requirements: {
      packagingCondition: v('fPackaging'),
      storageCondition: v('fStorageCondition'),
      shelfLife: v('fShelfLife'),
      composition: v('fComposition'),
      recipe: v('fRecipe'),
      cookingCondition: {
        method: v('fCookingMethod'),
        steps: [...document.querySelectorAll('.cooking-step-input')].map(el => el.value.trim()).filter(Boolean)
      },
      note: v('fNote'),
      certificate: v('fCertificate')
    }
  };
  try{
    await setDoc(doc(db, 'pendingSubmissions', token), payload);
    feedback.style.color = 'var(--ok)';
    feedback.textContent = 'Saved — you can come back to this same link to make changes until our team reviews it.';
  }catch(err){
    feedback.style.color = 'var(--danger)';
    feedback.textContent = 'Could not save: ' + (err.message || err);
  }finally{
    btn.disabled = false;
  }
}

init();
