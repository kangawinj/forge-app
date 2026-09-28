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

// Kept in sync manually with TRIAL_TEST_RESULT_OPTIONS /
// EVAL_WIZARD_RESULT_CLASSES in trials-data.js -- this page can't import
// that module directly, same "public page avoids pulling in the whole
// authenticated app" reasoning as submit.js not importing projects.js.
const TRIAL_TEST_RESULT_OPTIONS = ['Accepted', 'Not accepted', 'Needs Revision'];
const EVAL_WIZARD_RESULT_CLASSES = {
  'Accepted': 'eval-wizard-tr-accepted',
  'Needs Revision': 'eval-wizard-tr-needs-revision',
  'Not accepted': 'eval-wizard-tr-not-accepted'
};

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
// Per-product answers -- Comment/Improvement Guidelines use the exact
// same key names as the real app's own shared pd fields (['sensory_'+id],
// ['improve_'+id], see sensoryFieldValue/improvementFieldValue in
// trials-data.js) so importing a submission is a plain copy, no key
// remapping needed; testResult stays its own key, genuinely per-evaluator
// on import (see importShareResponse in trials-share.js).
let answers = {};
// One shared Comments + up to EVAL_COMMENT_PHOTO_MAX reference photos for
// the whole submission (per request), asked once on the Review page --
// not nested inside `answers`, since neither is tied to any one product.
let generalComment = '';
let generalPhotos = [];

// Same 192-bit CSPRNG token generation as submit.js's own generateToken
// and trials.js's generateShareToken -- this response's own doc id, freshly
// minted client-side with zero server coordination, which is exactly what
// lets any number of people open the same shared link/QR at once and each
// land on their own independent response with no collision.
function generateResponseId(){
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// Same resize as resizeImageFile in app.js (trials.js's own product photo
// upload calls it with the same maxDim:500) -- kept as its own copy here
// for the usual "this public page doesn't import the authenticated app"
// reason. Capped at 2 per product (EVAL_COMMENT_PHOTO_MAX below) rather
// than the real app's 4, since these ride inside the same
// /evaluationResponses doc as every other answer on this page and
// Firestore caps a single document at 1MiB -- 500px JPEGs at quality 0.7
// stay small enough (tens of KB each) that a couple per product is safe,
// unbounded wouldn't be.
function resizeImageFile(file, maxDim){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read that image file'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
const EVAL_COMMENT_PHOTO_MAX = 2;

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
      ${criteria.map(c => `
        <div class="eval-wizard-question">
          <div class="eval-wizard-question-label">${escapeHtml(c.label)}</div>
          <div class="teval-stack-label">Comment</div>
          <textarea class="eval-wizard-sensory" data-role="eval-sensory" data-criteria-id="${escapeHtml(c.id)}" placeholder="Comment for ${escapeHtml(c.label)}">${escapeHtml(mine[`sensory_${c.id}`] || '')}</textarea>
          <div class="teval-stack-label">Improvement Guidelines</div>
          <textarea class="eval-wizard-improve" data-role="eval-improve" data-criteria-id="${escapeHtml(c.id)}" placeholder="Improvement Guidelines for ${escapeHtml(c.label)}">${escapeHtml(mine[`improve_${c.id}`] || '')}</textarea>
        </div>
      `).join('')}
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
//
// Comments + an optional reference photo are one shared thing covering
// the whole test here (per request), not one of each per product -- asked
// once at the very bottom, after every product's own answers, rather than
// repeated on each product's own page.
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
              const comment = ans[`sensory_${c.id}`] || '';
              const improve = ans[`improve_${c.id}`] || '';
              return `
              <div class="eval-wizard-review-row eval-wizard-review-row-3col">
                <span>${escapeHtml(c.label)}</span>
                <b>${escapeHtml(comment || '-')}</b>
                <span class="eval-wizard-review-note-col">${escapeHtml(improve)}</span>
              </div>
            `;
            }).join('')}
            <div class="eval-wizard-review-row"><span>Test Result</span><b class="${EVAL_WIZARD_RESULT_CLASSES[ans.testResult] || ''}">${escapeHtml(ans.testResult || '-')}</b></div>
          </div>
        `;
      }).join('')}
      <div class="eval-wizard-question" style="margin-top:14px;">
        <div class="eval-wizard-question-label">Comments</div>
        <textarea class="eval-wizard-comment" data-role="review-comment" placeholder="Anything else worth noting — covers every sample above, not just one">${escapeHtml(generalComment)}</textarea>
        <div class="eval-wizard-question-label" style="margin-top:12px;margin-bottom:6px;">Reference Photo (optional)</div>
        ${generalPhotos.length ? `<div class="proj-ref-images-grid">${generalPhotos.map(ph => `
          <div class="proj-ref-image-item">
            <div class="proj-ref-image-thumb-wrap">
              <img src="${escapeHtml(ph.dataUrl)}" class="proj-ref-image-thumb">
              <button type="button" class="proj-ref-image-remove" data-role="remove-review-photo" data-photo-id="${escapeHtml(ph.id)}" title="Remove">×</button>
            </div>
          </div>
        `).join('')}</div>` : ''}
        ${generalPhotos.length < EVAL_COMMENT_PHOTO_MAX ? `<input type="file" class="review-photo-input" accept="image/*" style="margin-top:8px;">` : ''}
      </div>
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
  generalComment = '';
  generalPhotos = [];
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

function wireWizardStep(){
  document.querySelectorAll('#wizardRoot [data-product-id]').forEach(section => {
    const productId = section.dataset.productId;
    const mine = answers[productId] || (answers[productId] = {});
    section.querySelectorAll('[data-role="eval-sensory"]').forEach(el => {
      el.addEventListener('change', () => { mine[`sensory_${el.dataset.criteriaId}`] = el.value.trim(); });
    });
    section.querySelectorAll('[data-role="eval-improve"]').forEach(el => {
      el.addEventListener('change', () => { mine[`improve_${el.dataset.criteriaId}`] = el.value.trim(); });
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
  // Comments + optional reference photo live on the Review page, as one
  // shared field covering the whole submission (per request) -- not
  // scoped to any one product any more.
  document.querySelector('[data-role="review-comment"]')?.addEventListener('change', e => {
    generalComment = e.target.value.trim();
  });
  document.querySelector('.review-photo-input')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if(!file) return;
    if(generalPhotos.length >= EVAL_COMMENT_PHOTO_MAX) return;
    generalPhotos.push({ id: crypto.randomUUID(), dataUrl: await resizeImageFile(file, 500) });
    renderWizardStep();
  });
  document.querySelectorAll('[data-role="remove-review-photo"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = generalPhotos.findIndex(ph => ph.id === btn.dataset.photoId);
      if(idx !== -1) generalPhotos.splice(idx, 1);
      renderWizardStep();
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
      answers,
      comment: generalComment,
      photos: generalPhotos
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
