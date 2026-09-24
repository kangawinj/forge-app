// The "Perform Evaluation" wizard -- a dedicated full-screen overlay
// (body-appended, independent of the part-block markup) walking one
// product at a time: a JAR score per Sensory Evaluation criteria, a
// Comments field, then Test Result as the last field on that product's
// page, finishing with a Review page listing every product's answers
// together before Done closes the overlay. Split out of trials.js (which
// grew past 2,600 lines) -- see trials.js's own top-of-file comment for
// the overall file split.
import {
  icon, escapeHtml, currentUser, resizeImageFile, uid
} from './app.js';
import {
  getTrialProductData, getMyEvaluation, getMyEvaluatorComment, getMyEvaluatorPhotos,
  EVAL_COMMENT_PHOTO_MAX, normalizeTrialPhotos, getEvaluationCriteria, trialEvalTargets,
  registerEvaluationParticipant, scheduleTrialSave, wireTrialTranslateButton,
  JAR_SCALE, jarScoreLabel, jarScoreDisplay, jarAdjustmentPercent,
  TRIAL_TEST_RESULT_OPTIONS, EVAL_WIZARD_RESULT_CLASSES
} from './trials-data.js';
// Circular import back to core trials.js -- safe because `trials` and
// `renderTrialsList` are only ever read/called from inside functions
// invoked later by user interaction, never at module-evaluation time. The
// same pattern trials.js itself already relies on (`trials` is a live-
// binding `let` export read live by app.js).
import { trials, renderTrialsList } from './trials.js';

// { trialId, step, productIds } while open; step indexes into
// productIds (one wizard "page" per product), or equals productIds.length
// for the trailing Review page. null when the wizard is closed.
let evalWizard = null;

// Opens the wizard for a trial -- replaces trials.js's old inline
// `evalWizard = { trialId, step: 0, productIds }` assignment, since an
// imported `let` binding is read-only to importers in ES modules.
export function openEvalWizard(trialId, productIds){
  evalWizard = { trialId, step: 0, productIds };
}

// Re-rendered on every answer so the overlay always reflects the latest
// evalWizard/trials state, same pattern as renderTrialsList itself.
export function renderEvaluationWizard(){
  const existing = document.getElementById('evalWizardOverlay');
  if(!evalWizard || !currentUser?.email){
    existing?.remove();
    return;
  }
  const t = trials.find(x => x.id === evalWizard.trialId);
  const products = t ? evalWizard.productIds.map(id => trialEvalTargets(t).find(p => p.id === id)).filter(Boolean) : [];
  if(!t || !products.length){
    evalWizard = null;
    existing?.remove();
    return;
  }
  evalWizard.step = Math.max(0, Math.min(evalWizard.step, products.length));
  const criteria = getEvaluationCriteria(t);
  const isReview = evalWizard.step >= products.length;

  const overlay = existing || document.createElement('div');
  overlay.id = 'evalWizardOverlay';
  overlay.className = 'eval-wizard-overlay';
  // No click-to-close-on-backdrop here (unlike the app's other modals,
  // see wireModalOverlayClose) -- the card has no background/border of its
  // own to visually mark where "outside" begins, both are plain white, so
  // a stray click in the gap between questions would close the wizard
  // without the person meaning to. Only the X button (and Back/Review/Done
  // navigation) closes it.
  if(!existing) document.body.appendChild(overlay);
  overlay.innerHTML = isReview
    ? renderEvalWizardReview(t, products, criteria)
    : renderEvalWizardStep(t, products, criteria, evalWizard.step);

  wireEvaluationWizard(overlay, t, products);
}
function renderEvalWizardStep(t, products, criteria, step){
  const p = products[step];
  const pd = getTrialProductData(t, p.id);
  const mine = getMyEvaluation(pd);
  // Read-only mirror of Part 1's own product-photo gallery (pd.photos /
  // normalizeTrialPhotos) -- no upload control here any more (per
  // feedback: uploading only belongs on the form filled in BEFORE
  // evaluating, i.e. Part 1's product card), just whatever's already
  // there so an evaluator can see the sample they're scoring without
  // leaving the wizard. Renders nothing at all if Part 1 has no photo yet.
  const wizardPhotos = normalizeTrialPhotos(pd);
  const wizardPhotosHtml = wizardPhotos.map(photo => `
    <div class="proj-ref-image-item">
      <div class="proj-ref-image-thumb-wrap">
        <img src="${escapeHtml(photo.dataUrl)}" class="proj-ref-image-thumb" alt="${escapeHtml(photo.caption || 'Sample photo')}">
      </div>
    </div>
  `).join('');
  return `
    <div class="eval-wizard-card">
      <div class="eval-wizard-header">
        <div class="eval-wizard-title">Forge · Sensory Evaluation</div>
        <button type="button" class="eval-wizard-close" data-role="eval-wizard-close" title="Close">${icon('x')}</button>
      </div>
      <div class="eval-wizard-progress">Sample ${step + 1} of ${products.length}</div>
      <div class="eval-wizard-product-name">${escapeHtml(p.name || p.label)}</div>
      ${p.code ? `<div class="eval-wizard-product-code">${escapeHtml(p.code)}</div>` : ''}
      ${wizardPhotosHtml ? `<div class="eval-wizard-photos"><div class="proj-ref-images-grid">${wizardPhotosHtml}</div></div>` : ''}
      <div class="eval-wizard-jar-legend">
        ${JAR_SCALE.map(s => `<div class="eval-wizard-jar-legend-item"><b>${s.value}</b><span>${escapeHtml(s.label)}</span></div>`).join('')}
      </div>
      ${criteria.map(c => `
        <div class="eval-wizard-question">
          <div class="eval-wizard-question-label">${escapeHtml(c.label)} <span class="eval-wizard-jar-caption">${escapeHtml(mine[c.id] ? jarScoreLabel(mine[c.id]) : 'Not answered yet')}</span></div>
          <div class="eval-wizard-jar-row">
            ${JAR_SCALE.map(s => `
              <button type="button" class="eval-wizard-jar-btn${mine[c.id] === s.value ? ' selected' : ''}" data-role="eval-jar" data-criteria-id="${escapeHtml(c.id)}" data-value="${s.value}" title="${escapeHtml(s.label)}">${s.value}</button>
            `).join('')}
          </div>
          <div class="mu-field-with-translate" style="width:auto;">
            <textarea class="eval-wizard-criteria-note" data-role="eval-criteria-note" data-criteria-id="${escapeHtml(c.id)}" placeholder="Note for ${escapeHtml(c.label)} (optional)">${escapeHtml(mine[`${c.id}_note`] || '')}</textarea>
            <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
          </div>
          ${(() => {
            const pct = jarAdjustmentPercent(mine[c.id]);
            if(pct === null || pct === 0) return '';
            const markerPos = 50 + pct / 2;
            // The percentage sits ON the -100%/Just right/+100% axis-label
            // row itself now (absolutely positioned inside it, same line),
            // rather than on its own line above or below it -- per
            // follow-up feedback, two separate lines still read as
            // disconnected even once they stopped visually overlapping.
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
        <div class="eval-wizard-question-label">Test Result</div>
        <div class="eval-wizard-testresult-row">
          ${TRIAL_TEST_RESULT_OPTIONS.map(o => `
            <button type="button" class="eval-wizard-testresult-btn${mine.testResult === o ? ' selected ' + (EVAL_WIZARD_RESULT_CLASSES[o] || '') : ''}" data-role="eval-testresult" data-value="${escapeHtml(o)}">${escapeHtml(o)}</button>
          `).join('')}
        </div>
      </div>
      <div class="eval-wizard-nav">
        <button type="button" class="btn btn-sm" data-role="eval-back" ${step === 0 ? 'disabled' : ''}>Back</button>
        <button type="button" class="btn btn-sm btn-primary" data-role="eval-next">${step === products.length - 1 ? 'Review' : 'Next Sample'} ${icon('chevron-right')}</button>
      </div>
    </div>
  `;
}
function renderEvalWizardReview(t, products, criteria){
  return `
    <div class="eval-wizard-card">
      <div class="eval-wizard-header">
        <div class="eval-wizard-title">Forge · Review Your Evaluation</div>
        <button type="button" class="eval-wizard-close" data-role="eval-wizard-close" title="Close">${icon('x')}</button>
      </div>
      ${products.map((p, i) => {
        const pd = getTrialProductData(t, p.id);
        const mine = getMyEvaluation(pd);
        return `
        <div class="eval-wizard-review-product">
          <div class="eval-wizard-review-product-name">${escapeHtml(p.label)}</div>
          ${criteria.map(c => {
            const note = mine[`${c.id}_note`];
            const pct = jarAdjustmentPercent(mine[c.id]);
            const pctBadge = (pct !== null && pct !== 0) ? `<span class="eval-wizard-review-idea-badge">${pct > 0 ? '+' : ''}${pct}%</span>` : '';
            const meaning = mine[c.id] ? `<span class="eval-wizard-review-jar-meaning">${escapeHtml(jarScoreLabel(mine[c.id]))}</span>` : '';
            return `<div class="eval-wizard-review-row eval-wizard-review-row-3col"><span>${escapeHtml(c.label)}</span><b>${escapeHtml(mine[c.id] ? jarScoreDisplay(mine[c.id]) : '-')}${meaning}${pctBadge}</b><span class="eval-wizard-review-note-col">${escapeHtml(note || '')}</span></div>`;
          }).join('')}
          <div class="eval-wizard-review-row"><span>Test Result</span><b class="${EVAL_WIZARD_RESULT_CLASSES[mine.testResult] || ''}">${escapeHtml(mine.testResult || '-')}</b></div>
        </div>
        `;
      }).join('')}
      <div class="eval-wizard-review-disclaimer">Note: This Idea Guideline reflects only your own scores — the final improvement direction may change based on the overall average and other evaluators' opinions (คำแนะนำนี้อ้างอิงจากคะแนนของคุณเท่านั้น ผลสุดท้ายอาจเปลี่ยนแปลงตามค่าเฉลี่ยโดยรวมและความเห็นจากผู้เข้าร่วมทดสอบคนอื่นๆ)</div>
      <div class="eval-wizard-question" style="margin-top:14px;margin-bottom:0;">
        <div class="eval-wizard-question-label">Comments</div>
        <textarea class="eval-wizard-comment" data-role="eval-overall-comment" placeholder="Anything else worth noting — covers every sample above, not just one">${escapeHtml(getMyEvaluatorComment(t))}</textarea>
        <div class="eval-wizard-question-label" style="margin-top:12px;margin-bottom:6px;">Reference Photo (optional)</div>
        ${getMyEvaluatorPhotos(t).length ? `<div class="proj-ref-images-grid">${getMyEvaluatorPhotos(t).map(ph => `
          <div class="proj-ref-image-item">
            <div class="proj-ref-image-thumb-wrap">
              <img src="${escapeHtml(ph.dataUrl)}" class="proj-ref-image-thumb" alt="Reference photo">
              <button type="button" class="proj-ref-image-remove" data-role="remove-eval-photo" data-photo-id="${escapeHtml(ph.id)}" title="Remove">${icon('x', 12)}</button>
            </div>
          </div>
        `).join('')}</div>` : ''}
        ${getMyEvaluatorPhotos(t).length < EVAL_COMMENT_PHOTO_MAX ? `<input type="file" class="eval-review-photo-input" accept="image/*" style="margin-top:8px;">` : ''}
      </div>
      <div class="eval-wizard-nav">
        <button type="button" class="btn btn-sm" data-role="eval-back">Back</button>
        <button type="button" class="btn btn-sm btn-primary" data-role="eval-done">${icon('check')} Done</button>
      </div>
    </div>
  `;
}
function wireEvaluationWizard(overlay, t, products){
  overlay.querySelector('[data-role="eval-wizard-close"]')?.addEventListener('click', () => {
    evalWizard = null;
    renderEvaluationWizard();
  });
  overlay.querySelectorAll('[data-role="eval-jar"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = products[evalWizard.step];
      const pd = getTrialProductData(t, p.id);
      const mine = getMyEvaluation(pd);
      const criteriaId = btn.dataset.criteriaId;
      const value = btn.dataset.value;
      mine[criteriaId] = mine[criteriaId] === value ? '' : value;
      registerEvaluationParticipant(t);
      scheduleTrialSave(t);
      renderTrialsList();
      renderEvaluationWizard();
    });
  });
  overlay.querySelectorAll('.eval-wizard-criteria-note').forEach(el => {
    el.addEventListener('change', () => {
      const p = products[evalWizard.step];
      const pd = getTrialProductData(t, p.id);
      const mine = getMyEvaluation(pd);
      mine[`${el.dataset.criteriaId}_note`] = el.value.trim();
      scheduleTrialSave(t);
      // The Overall table's Note column reads straight from this (see
      // fixedCriteriaRowsHtml) -- refresh it now instead of waiting for
      // some other action to happen to trigger a render, same as every
      // JAR/Test Result answer already does.
      renderTrialsList();
    });
  });
  overlay.querySelectorAll('.mu-field-with-translate').forEach(wireTrialTranslateButton);
  overlay.querySelector('[data-role="eval-overall-comment"]')?.addEventListener('change', e => {
    if(!t.evaluatorComments || typeof t.evaluatorComments !== 'object') t.evaluatorComments = {};
    if(currentUser?.email) t.evaluatorComments[currentUser.email] = e.target.value.trim();
    scheduleTrialSave(t);
    // The Overall table's Comments section reads straight from this (see
    // evaluatorCommentsHtml) -- refresh it now, same as the criteria Note
    // field and every JAR/Test Result answer already do.
    renderTrialsList();
  });
  overlay.querySelector('.eval-review-photo-input')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if(!file) return;
    const photos = getMyEvaluatorPhotos(t);
    if(photos.length >= EVAL_COMMENT_PHOTO_MAX) return;
    photos.push({ id: uid(), dataUrl: await resizeImageFile(file, 500) });
    scheduleTrialSave(t);
    renderTrialsList();
    renderEvaluationWizard();
  });
  overlay.querySelectorAll('[data-role="remove-eval-photo"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const photos = getMyEvaluatorPhotos(t);
      const idx = photos.findIndex(ph => ph.id === btn.dataset.photoId);
      if(idx !== -1) photos.splice(idx, 1);
      scheduleTrialSave(t);
      renderTrialsList();
      renderEvaluationWizard();
    });
  });
  overlay.querySelectorAll('[data-role="eval-testresult"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = products[evalWizard.step];
      const pd = getTrialProductData(t, p.id);
      const mine = getMyEvaluation(pd);
      const value = btn.dataset.value;
      mine.testResult = mine.testResult === value ? '' : value;
      registerEvaluationParticipant(t);
      scheduleTrialSave(t);
      renderTrialsList();
      renderEvaluationWizard();
    });
  });
  // Back/Next Sample/Review all move to a whole new page of questions --
  // scroll the overlay (the actual scrolling element, see .eval-wizard-
  // overlay's own overflow-y:auto) back to its top so the new page opens
  // where its first question is, instead of wherever the previous page
  // happened to be scrolled to (typically the bottom, right where the
  // button just clicked was). Every other renderEvaluationWizard() call in
  // this file is a same-page update (a JAR answer, a note) and must NOT
  // reset scroll, or answering a question mid-scroll would keep yanking
  // the page back to the top.
  overlay.querySelector('[data-role="eval-back"]')?.addEventListener('click', () => {
    evalWizard.step = Math.max(0, evalWizard.step - 1);
    renderEvaluationWizard();
    overlay.scrollTop = 0;
  });
  overlay.querySelector('[data-role="eval-next"]')?.addEventListener('click', () => {
    evalWizard.step = Math.min(products.length, evalWizard.step + 1);
    renderEvaluationWizard();
    overlay.scrollTop = 0;
  });
  overlay.querySelector('[data-role="eval-done"]')?.addEventListener('click', () => {
    evalWizard = null;
    renderTrialsList();
    renderEvaluationWizard();
  });
}
