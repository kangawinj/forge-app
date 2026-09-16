// Standalone public "Share External Evaluation" page -- deliberately NOT
// part of the main authenticated app (doesn't import app.js/trials.js at
// all, no Firebase Auth), same reasoning as submit.js. Anyone with a link
// like evaluate.html?token=... can fill in a sensory evaluation for the one
// trial that token was generated for and save it without ever logging in;
// the token itself (not a login) is what Firestore's security rules use to
// scope access -- see the /evaluationLinks and /evaluationResponses rules
// in firestore.rules for the other half of that story. Never reads or
// writes the real /trials doc directly: this page only ever sees the
// read-only snapshot a team member's own "Share External Evaluation"
// action wrote into /evaluationLinks (see generateShareLink in trials.js),
// and only ever creates its own new /evaluationResponses doc, never
// touching anyone else's.
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

// Kept in sync manually with JAR_SCALE / TRIAL_TEST_RESULT_OPTIONS /
// EVAL_WIZARD_RESULT_CLASSES in trials.js -- this page can't import that
// module directly, same "public page avoids pulling in the whole
// authenticated app" reasoning as submit.js not importing projects.js.
const JAR_SCALE = [
  { value: '1', label: 'Extremely less than ideal (น้อยเกินไปที่สุด)' },
  { value: '2', label: 'Much less than ideal (น้อยเกินไปมาก)' },
  { value: '3', label: 'Moderately less than ideal (น้อยเกินไปปานกลาง)' },
  { value: '4', label: 'Slightly less than ideal (น้อยเกินไปเล็กน้อย)' },
  { value: '5', label: 'Just right (พอดี)' },
  { value: '6', label: 'Slightly more than ideal (มากเกินไปเล็กน้อย)' },
  { value: '7', label: 'Moderately more than ideal (มากเกินไปปานกลาง)' },
  { value: '8', label: 'Much more than ideal (มากเกินไปมาก)' },
  { value: '9', label: 'Extremely more than ideal (มากเกินไปที่สุด)' }
];
const TRIAL_TEST_RESULT_OPTIONS = ['Accepted', 'Not accepted', 'Needs Revision'];
const EVAL_WIZARD_RESULT_CLASSES = {
  'Accepted': 'eval-wizard-tr-accepted',
  'Needs Revision': 'eval-wizard-tr-needs-revision',
  'Not accepted': 'eval-wizard-tr-not-accepted'
};

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function jarScoreLabel(value){
  const found = JAR_SCALE.find(s => s.value === value);
  return found ? found.label : '';
}

const token = new URLSearchParams(location.search).get('token') || '';
const bannerEl = document.getElementById('evalStatusBanner');
const rootEl = document.getElementById('evalFormRoot');
function showBanner(html, kind){
  bannerEl.style.display = 'block';
  bannerEl.style.marginBottom = '16px';
  bannerEl.style.cssText += kind === 'error'
    ? 'background:#c0392b;color:#fff;padding:10px 16px;border-radius:var(--radius);font-size:13px;'
    : 'background:var(--primary-light);color:var(--primary-dark);padding:10px 16px;border-radius:var(--radius);font-size:13px;';
  bannerEl.innerHTML = html;
}

// Per-product answers, same shape as a real evaluator's own
// pd.evaluations[someKey] in trials.js: { [criteriaId]: '1'-'9',
// [criteriaId+'_note']: string, comment: string, testResult: string }.
let answers = {};

// Same 192-bit CSPRNG token generation as submit.js's own generateToken
// and trials.js's generateShareToken -- this response's own doc id, freshly
// minted client-side with zero server coordination, which is exactly what
// lets any number of people open the same shared link/QR at once and each
// land on their own independent response with no collision.
function generateResponseId(){
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function init(){
  if(!token){
    showBanner('This link is missing its evaluation code. Please ask for a full link or QR code.', 'error');
    return;
  }
  let data;
  try{
    const snap = await getDoc(doc(db, 'evaluationLinks', token));
    if(!snap.exists()){
      showBanner('This evaluation link is invalid or has been removed. Please ask for a new link.', 'error');
      return;
    }
    data = snap.data();
  }catch(err){
    showBanner('Could not load this form: ' + (err.message || err), 'error');
    return;
  }
  if(!data.expiresAt || data.expiresAt <= Date.now()){
    showBanner('This evaluation link has expired (links last 24 hours). Please ask for a new link or QR code.', 'error');
    return;
  }
  render(data);
}

function photosHtml(photos){
  if(!photos || !photos.length) return '';
  return `<div class="eval-wizard-photos"><div class="proj-ref-images-grid">${photos.map(photo => `
    <div class="proj-ref-image-item">
      <div class="proj-ref-image-thumb-wrap">
        <img src="${escapeHtml(photo.dataUrl)}" class="proj-ref-image-thumb" alt="${escapeHtml(photo.caption || 'Sample photo')}">
      </div>
    </div>
  `).join('')}</div></div>`;
}

function productSectionHtml(product, criteria){
  const mine = answers[product.id] || (answers[product.id] = {});
  return `
    <div class="card" style="margin-bottom:16px;" data-product-id="${escapeHtml(product.id)}">
      <div class="eval-wizard-product-name">${escapeHtml(product.label)}</div>
      ${photosHtml(product.photos)}
      <div class="eval-wizard-jar-legend">
        ${JAR_SCALE.map(s => `<div class="eval-wizard-jar-legend-item"><b>${s.value}</b><span>${escapeHtml(s.label)}</span></div>`).join('')}
      </div>
      ${criteria.map(c => `
        <div class="eval-wizard-question">
          <div class="eval-wizard-question-label">${escapeHtml(c.label)} <span class="eval-wizard-jar-caption" data-jar-caption="${escapeHtml(c.id)}">${escapeHtml(mine[c.id] ? jarScoreLabel(mine[c.id]) : 'Not answered yet')}</span></div>
          <div class="eval-wizard-jar-row">
            ${JAR_SCALE.map(s => `
              <button type="button" class="eval-wizard-jar-btn${mine[c.id] === s.value ? ' selected' : ''}" data-role="eval-jar" data-criteria-id="${escapeHtml(c.id)}" data-value="${s.value}" title="${escapeHtml(s.label)}">${s.value}</button>
            `).join('')}
          </div>
          <textarea class="eval-wizard-criteria-note" data-role="eval-criteria-note" data-criteria-id="${escapeHtml(c.id)}" placeholder="Note for ${escapeHtml(c.label)} (optional)">${escapeHtml(mine[`${c.id}_note`] || '')}</textarea>
        </div>
      `).join('')}
      <div class="eval-wizard-question">
        <div class="eval-wizard-question-label">Comments</div>
        <textarea class="eval-wizard-comment" data-role="eval-comment" placeholder="Anything else worth noting about this sample">${escapeHtml(mine.comment || '')}</textarea>
      </div>
      <div class="eval-wizard-question">
        <div class="eval-wizard-question-label">Test Result</div>
        <div class="eval-wizard-testresult-row">
          ${TRIAL_TEST_RESULT_OPTIONS.map(o => `
            <button type="button" class="eval-wizard-testresult-btn${mine.testResult === o ? ' selected ' + (EVAL_WIZARD_RESULT_CLASSES[o] || '') : ''}" data-role="eval-testresult" data-value="${escapeHtml(o)}">${escapeHtml(o)}</button>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function render(data){
  answers = {};
  (data.products || []).forEach(p => { answers[p.id] = {}; });

  rootEl.innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <div class="dash-card-title">${escapeHtml(data.trialLabel || 'Sensory Evaluation')}</div>
      ${data.testDate ? `<div style="font-size:12px;color:var(--text-dim);margin-top:4px;">Tested ${escapeHtml(data.testDate)}</div>` : ''}
      <div class="field" style="margin-top:16px;margin-bottom:0;">
        <label>Your Name</label>
        <input type="text" id="fGuestName" placeholder="e.g. John (Customer)">
      </div>
    </div>
    <div id="productsRoot">${(data.products || []).map(p => productSectionHtml(p, data.criteria || [])).join('')}</div>
    ${(data.products || []).length === 0 ? '<div class="card"><div class="overview-empty">No products were added to this test yet.</div></div>' : ''}
    <div class="card" style="display:flex;gap:8px;align-items:center;">
      <button class="btn btn-primary btn-sm" id="btnSubmitEval">Submit Evaluation</button>
      <span id="submitFeedback" style="font-size:13px;color:var(--text-dim);"></span>
    </div>
  `;

  wireProducts();
  document.getElementById('btnSubmitEval').addEventListener('click', () => save(data));
}

function wireProducts(){
  document.querySelectorAll('#productsRoot [data-product-id]').forEach(section => {
    const productId = section.dataset.productId;
    const mine = answers[productId] || (answers[productId] = {});
    section.querySelectorAll('[data-role="eval-jar"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const criteriaId = btn.dataset.criteriaId;
        mine[criteriaId] = mine[criteriaId] === btn.dataset.value ? '' : btn.dataset.value;
        section.querySelectorAll(`[data-role="eval-jar"][data-criteria-id="${criteriaId}"]`).forEach(b => {
          b.classList.toggle('selected', b.dataset.value === mine[criteriaId]);
        });
        const caption = section.querySelector(`[data-jar-caption="${criteriaId}"]`);
        if(caption) caption.textContent = mine[criteriaId] ? jarScoreLabel(mine[criteriaId]) : 'Not answered yet';
      });
    });
    section.querySelectorAll('[data-role="eval-criteria-note"]').forEach(el => {
      el.addEventListener('change', () => { mine[`${el.dataset.criteriaId}_note`] = el.value.trim(); });
    });
    section.querySelector('[data-role="eval-comment"]')?.addEventListener('change', e => {
      mine.comment = e.target.value.trim();
    });
    section.querySelectorAll('[data-role="eval-testresult"]').forEach(btn => {
      btn.addEventListener('click', () => {
        mine.testResult = mine.testResult === btn.dataset.value ? '' : btn.dataset.value;
        section.querySelectorAll('[data-role="eval-testresult"]').forEach(b => {
          b.classList.toggle('selected', b.dataset.value === mine.testResult);
          Object.values(EVAL_WIZARD_RESULT_CLASSES).forEach(cls => b.classList.remove(cls));
          if(b.dataset.value === mine.testResult && EVAL_WIZARD_RESULT_CLASSES[mine.testResult]) b.classList.add(EVAL_WIZARD_RESULT_CLASSES[mine.testResult]);
        });
      });
    });
  });
}

async function save(data){
  const btn = document.getElementById('btnSubmitEval');
  const feedback = document.getElementById('submitFeedback');
  const guestName = document.getElementById('fGuestName').value.trim();
  if(!guestName){
    feedback.style.color = 'var(--danger)';
    feedback.textContent = 'Please enter your name before submitting.';
    document.getElementById('fGuestName').focus();
    return;
  }
  if(!data.expiresAt || data.expiresAt <= Date.now()){
    showBanner('This evaluation link has expired (links last 24 hours) while this page was open. Your answers were not saved — please ask for a new link.', 'error');
    return;
  }
  btn.disabled = true;
  feedback.style.color = 'var(--text-dim)';
  feedback.textContent = 'Submitting...';
  try{
    const responseId = generateResponseId();
    await setDoc(doc(db, 'evaluationResponses', responseId), {
      linkToken: token,
      trialId: data.trialId,
      guestName,
      submittedAt: Date.now(),
      imported: false,
      answers
    });
    rootEl.innerHTML = `<div class="card" style="text-align:center;padding:32px 20px;">
      <p style="font-size:15px;font-weight:600;color:var(--primary-dark);margin-bottom:6px;">Thank you, ${escapeHtml(guestName)}!</p>
      <p style="color:var(--text-dim);">Your evaluation has been submitted.</p>
    </div>`;
  }catch(err){
    feedback.style.color = 'var(--danger)';
    feedback.textContent = 'Could not submit: ' + (err.message || err);
    btn.disabled = false;
  }
}

init();
