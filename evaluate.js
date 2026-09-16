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
//
// Walks through one product per page (same Back/Next Sample flow as the
// real Perform Evaluation wizard in trials.js, see renderEvalWizardStep/
// renderEvalWizardReview), ending on a Review page that lists every
// answer with its own Back button before the one and only Submit -- so a
// guest can fix a wrong tap before anything is actually written, rather
// than the earlier single long scrolling form. Nothing is saved to
// Firestore until Submit on the Review page; the Thank You page after that
// is genuinely final (the create-only /evaluationResponses rule gives a
// guest no way to edit a response after it's written, so there's nothing
// to go "back" to from there).
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
function jarScoreDisplay(value){
  return /^[1-9]$/.test(value || '') ? `${value}/9` : '-';
}
// Same "Idea Guideline" math as jarAdjustmentPercent in trials.js -- how
// far off-ideal a JAR answer is, as a -100%/+100% figure toward the
// midpoint ("Just right"). Kept in sync manually, same reasoning as every
// other duplicated constant/helper in this file.
function jarAdjustmentPercent(value){
  const n = parseInt(value, 10);
  if(!(n >= 1 && n <= JAR_SCALE.length)) return null;
  const midpoint = Math.ceil(JAR_SCALE.length / 2);
  const maxDeviation = midpoint - 1;
  if(maxDeviation <= 0) return 0;
  return Math.round(-((n - midpoint) / maxDeviation) * 100);
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

// The evaluationLinks snapshot this page is walking through, and the
// current step -- 0..products.length-1 is a product's own page, and
// products.length is the trailing Review page. Both module-level since
// renderWizardStep() re-renders only #wizardRoot (the "Your Name" field
// above it, part of the same header render() builds once, must survive
// every step change untouched).
let linkData = null;
let step = 0;
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
          ${(() => {
            const pct = jarAdjustmentPercent(mine[c.id]);
            if(pct === null || pct === 0) return '';
            const markerPos = 50 + pct / 2;
            return `
              <div class="eval-wizard-idea-guideline">
                <div class="eval-wizard-idea-label">Idea Guideline — toward Just Right (พอดี)</div>
                <div class="eval-wizard-idea-track">
                  <div class="eval-wizard-idea-center"></div>
                  <div class="eval-wizard-idea-marker" style="left:${markerPos}%;"></div>
                </div>
                <div class="eval-wizard-idea-scale-labels">
                  <span${pct <= -100 ? ' class="eval-wizard-idea-scale-hidden"' : ''}>-100%</span>
                  <span>Just right</span>
                  <span${pct >= 100 ? ' class="eval-wizard-idea-scale-hidden"' : ''}>+100%</span>
                  <span class="eval-wizard-idea-marker-value" style="left:${markerPos}%;">${pct > 0 ? '+' : ''}${pct}%</span>
                </div>
              </div>
            `;
          })()}
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

// One product's own page -- Back is disabled on the very first product
// (nowhere earlier to go), and the last product's "Next Sample" reads
// "Review" instead, same wording/behavior as renderEvalWizardStep.
function stepHtml(product, criteria, total){
  return `
    <div class="eval-wizard-progress" style="margin-bottom:8px;">Sample ${step + 1} of ${total}</div>
    ${productSectionHtml(product, criteria)}
    <div class="card eval-wizard-nav" style="margin-bottom:0;margin-top:0;">
      <button type="button" class="btn btn-sm" data-role="wiz-back" ${step === 0 ? 'disabled' : ''}>Back</button>
      <button type="button" class="btn btn-sm btn-primary" data-role="wiz-next">${step === total - 1 ? 'Review' : 'Next Sample'}</button>
    </div>
  `;
}

// The last page before anything is actually written -- lists every
// product's own answers (same layout as renderEvalWizardReview) so a
// guest can catch a wrong tap before Submit, with Back returning to the
// last product's own page to fix it. Submit is the only action on this
// whole page that ever touches Firestore.
function reviewHtml(products, criteria){
  return `
    <div class="card">
      <div class="eval-wizard-title" style="margin-bottom:14px;">Review Your Evaluation</div>
      ${products.map(p => {
        const ans = answers[p.id] || {};
        return `
          <div class="eval-wizard-review-product">
            <div class="eval-wizard-review-product-name">${escapeHtml(p.label)}</div>
            ${criteria.map(c => {
              const pct = jarAdjustmentPercent(ans[c.id]);
              const pctBadge = (pct !== null && pct !== 0) ? `<span class="eval-wizard-review-idea-badge">${pct > 0 ? '+' : ''}${pct}%</span>` : '';
              return `
              <div class="eval-wizard-review-row eval-wizard-review-row-3col">
                <span>${escapeHtml(c.label)}</span>
                <b>${jarScoreDisplay(ans[c.id])}${ans[c.id] ? `<span class="eval-wizard-review-jar-meaning">${escapeHtml(jarScoreLabel(ans[c.id]))}</span>` : ''}${pctBadge}</b>
                <span class="eval-wizard-review-note-col">${escapeHtml(ans[`${c.id}_note`] || '')}</span>
              </div>
            `;
            }).join('')}
            ${(ans.comment || '').trim() ? `<div class="eval-wizard-review-row"><span>Comments</span><b>${escapeHtml(ans.comment)}</b></div>` : ''}
            <div class="eval-wizard-review-row"><span>Test Result</span><b class="${EVAL_WIZARD_RESULT_CLASSES[ans.testResult] || ''}">${escapeHtml(ans.testResult || '-')}</b></div>
          </div>
        `;
      }).join('')}
      <div class="eval-wizard-nav">
        <button type="button" class="btn btn-sm" data-role="wiz-back">Back</button>
        <button type="button" class="btn btn-sm btn-primary" data-role="wiz-submit">Submit Evaluation</button>
      </div>
      <div id="submitFeedback" style="font-size:13px;color:var(--text-dim);margin-top:8px;"></div>
    </div>
  `;
}

function render(data){
  linkData = data;
  step = 0;
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
    <div id="wizardRoot"></div>
  `;
  renderWizardStep();
}

function renderWizardStep(){
  const wizardRoot = document.getElementById('wizardRoot');
  const products = linkData.products || [];
  const criteria = linkData.criteria || [];
  if(products.length === 0){
    wizardRoot.innerHTML = '<div class="card"><div class="overview-empty">No products were added to this test yet.</div></div>';
    return;
  }
  step = Math.max(0, Math.min(step, products.length));
  const isReview = step >= products.length;
  wizardRoot.innerHTML = isReview ? reviewHtml(products, criteria) : stepHtml(products[step], criteria, products.length);
  wireWizardStep();
}

// Press-and-drag across the 1-9 row to scrub through scores, like a slider
// -- per request, holding a finger down and sliding it across the buttons
// should pick whichever one it's currently over, not require lifting and
// re-tapping each one. Only ever active for an actual drag: a touch that
// starts and ends on the same button never marks itself as "moved", so it
// falls through to the ordinary click handler above untouched (same
// toggle-off-if-already-selected behavior as a plain tap always had) --
// this only takes over once the finger has crossed onto a different
// button. touchmove's own preventDefault (while a button is under the
// finger) is what stops the browser from treating the drag as a page
// scroll instead, and per spec that also suppresses the synthetic click
// event a touch normally fires afterward, so a real drag's own commit
// below is the only thing that runs for it -- nothing double-fires.
function wireJarDragSelect(row, mine){
  let dragValue = null;
  let dragMoved = false;
  function buttonAtPoint(x, y){
    const el = document.elementFromPoint(x, y);
    const btn = el && el.closest ? el.closest('[data-role="eval-jar"]') : null;
    return (btn && row.contains(btn)) ? btn : null;
  }
  function preview(btn){
    row.querySelectorAll('[data-role="eval-jar"]').forEach(b => {
      b.classList.toggle('selected', b === btn);
    });
    const question = row.closest('.eval-wizard-question');
    const caption = question?.querySelector(`[data-jar-caption="${btn.dataset.criteriaId}"]`);
    if(caption) caption.textContent = jarScoreLabel(btn.dataset.value);
  }
  row.addEventListener('touchstart', e => {
    const t = e.touches[0];
    const btn = buttonAtPoint(t.clientX, t.clientY);
    dragValue = btn ? btn.dataset.value : null;
    dragMoved = false;
  }, { passive: true });
  row.addEventListener('touchmove', e => {
    const t = e.touches[0];
    const btn = buttonAtPoint(t.clientX, t.clientY);
    if(btn){
      e.preventDefault();
      if(btn.dataset.value !== dragValue){
        dragValue = btn.dataset.value;
        dragMoved = true;
        preview(btn);
      }
    }
  }, { passive: false });
  row.addEventListener('touchend', () => {
    if(dragMoved && dragValue){
      const criteriaId = row.querySelector('[data-role="eval-jar"]').dataset.criteriaId;
      mine[criteriaId] = dragValue;
      renderWizardStep();
    }
    dragValue = null;
    dragMoved = false;
  });
  row.addEventListener('touchcancel', () => { dragValue = null; dragMoved = false; });
}

function wireWizardStep(){
  document.querySelectorAll('#wizardRoot [data-product-id]').forEach(section => {
    const productId = section.dataset.productId;
    const mine = answers[productId] || (answers[productId] = {});
    section.querySelectorAll('[data-role="eval-jar"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const criteriaId = btn.dataset.criteriaId;
        mine[criteriaId] = mine[criteriaId] === btn.dataset.value ? '' : btn.dataset.value;
        // Full re-render (not a DOM patch) -- same as the real Perform
        // Evaluation wizard's own JAR click handler -- since the Idea
        // Guideline block below each question only exists/updates by being
        // recomputed from the answer that just changed.
        renderWizardStep();
      });
    });
    section.querySelectorAll('.eval-wizard-jar-row').forEach(row => wireJarDragSelect(row, mine));
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
  document.querySelector('[data-role="wiz-back"]')?.addEventListener('click', () => {
    step = Math.max(0, step - 1);
    renderWizardStep();
    window.scrollTo(0, 0);
  });
  document.querySelector('[data-role="wiz-next"]')?.addEventListener('click', () => {
    step = Math.min((linkData.products || []).length, step + 1);
    renderWizardStep();
    window.scrollTo(0, 0);
  });
  document.querySelector('[data-role="wiz-submit"]')?.addEventListener('click', () => save());
}

async function save(){
  const btn = document.querySelector('[data-role="wiz-submit"]');
  const feedback = document.getElementById('submitFeedback');
  const guestName = document.getElementById('fGuestName').value.trim();
  if(!guestName){
    document.getElementById('fGuestName').scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('fGuestName').focus();
    feedback.style.color = 'var(--danger)';
    feedback.textContent = 'Please enter your name (at the top of the page) before submitting.';
    return;
  }
  if(!linkData.expiresAt || linkData.expiresAt <= Date.now()){
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
      trialId: linkData.trialId,
      guestName,
      submittedAt: Date.now(),
      imported: false,
      answers
    });
    // The header card above (trial info + "Your Name") is left as-is,
    // not wiped out like a full render() would -- only #wizardRoot is
    // replaced, so a mistaken submit can still be corrected: "Back to
    // Edit" returns to the Review page with every answer just submitted
    // still sitting in `answers`, ready to tweak and resend. This can
    // never *edit* the response just written (a guest has no update
    // access to /evaluationResponses, see firestore.rules), only create a
    // fresh corrected one -- both responses stay visible to the team, who
    // can Dismiss whichever one doesn't belong.
    document.getElementById('wizardRoot').innerHTML = `<div class="card" style="text-align:center;padding:32px 20px;">
      <p style="font-size:15px;font-weight:600;color:var(--primary-dark);margin-bottom:6px;">Thank you, ${escapeHtml(guestName)}!</p>
      <p style="color:var(--text-dim);margin-bottom:16px;">Your evaluation has been submitted.</p>
      <button type="button" class="btn btn-sm" data-role="wiz-edit-again">${'←'} Back to Edit</button>
    </div>`;
    document.querySelector('[data-role="wiz-edit-again"]')?.addEventListener('click', () => {
      step = (linkData.products || []).length;
      renderWizardStep();
      window.scrollTo(0, 0);
    });
  }catch(err){
    feedback.style.color = 'var(--danger)';
    feedback.textContent = 'Could not submit: ' + (err.message || err);
    btn.disabled = false;
  }
}

init();
