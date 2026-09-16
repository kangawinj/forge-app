import {
  recipes, recipeDisplayLabel, uid, currentUser, escapeHtml, icon, logActivityEvent,
  playContentTransition, projects, findProjectForRecipe, fullCode, formatWeight,
  allIngredientsInRecipe, formatActivityDateTime, PROJECT_STAGES, mainFeatureView,
  recipesLoaded, diffMainFields, requestAuthConfirm, resizeImageFile, formatDateLong,
  trialStringListHtml, trialsCol, showCloudError,
  metaLists, metaItemName, getRequirements, certificateSummaryText, moveToTrash
} from './app.js';
import {
  onSnapshot, setDoc, doc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let trials = [];
let trialExpandedIds = new Set();
let trialEditingId = null;
// "Perform Evaluation" opens a dedicated full-screen wizard (see
// renderEvaluationWizard) -- Sensory Evaluation and Test Result are
// personal, per-evaluator opinions now (see pd.evaluations), scoped to
// whoever is logged in (currentUser), not a shared Edit anyone can
// overwrite. It's a separate body-appended overlay, independent of the
// regular Edit (which still covers Part 1, Products, Criteria list,
// Improvement Guidelines, Note) -- not mutually exclusive with it.
// { trialId, step, productIds } while open; step indexes into
// productIds (one wizard "page" per product), or equals productIds.length
// for the trailing Review page. null when the wizard is closed.
let evalWizard = null;
// "Summary Test" opens a read-only, body-appended overlay (same pattern
// as evalWizard above, see renderTrialSummaryModal) showing a condensed
// per-product readout -- overall verdict + only the criteria that still
// need adjusting (auto-suggested direction/%, same data Improvement
// Guidelines already computes) -- so someone can see "what does this
// test actually say" at a glance instead of reading the full editable
// tables. Holds the trial id while open, null when closed.
let trialSummaryId = null;
// "List" (the default card-per-test view, with Edit/Perform Evaluation/
// Summary Test/Print/Delete) vs "table" (a read-only, scannable overview
// -- Project / PD / inline Summary Test per row, most-recently-updated
// first -- see renderTrialsSummaryTable). Kept as its own toggle rather
// than replacing the list outright, since the table has none of the
// list's own actions.
let trialsViewMode = 'list';
let unsubscribeTrials = null;
let trialsLoaded = false;
let trialsMigrated = false;
const TRIAL_DIFF_FIELDS = { label: 'Recipes / Products Compared' };
let trialEditSnapshotBefore = null;

const TRIAL_MAX_PRODUCTS = 4;

// A trial has no name of its own — it's a comparison of recipes — so its
// label is just whichever recipes it's comparing, joined together.
function trialLabel(t){
  return (t.recipeIds || []).map(id => recipes.find(r => r.id === id)).filter(Boolean).map(recipeDisplayLabel).join(', ') || 'Untitled test';
}

function blankTrial(){
  return {
    id: uid(),
    recipeIds: [],
    manualProducts: [],
    linkedProjectId: '',
    samplePreparedBy: '',
    testParticipants: [],
    testDate: '',
    testLocation: '',
    cookingMethod: '',
    cookingMethodSteps: [],
    productData: {},
    createdBy: currentUser?.email || '',
    createdAt: Date.now(),
    updatedBy: currentUser?.email || '',
    updatedAt: Date.now()
  };
}
// Old trials only had photos (up to 3, shared across the whole trial) and
// evaluation (freeform criteria rows) — replaced by a structured test-
// report format (see getEvaluationCriteria) with photos and scores per
// product instead. The old fields are left on the document
// untouched (unused, harmless) rather than migrated/stripped, same
// never-destroy-data approach as migrateTrialsFromRecipes above.
function migrateTrial(t){
  return {
    ...t,
    linkedProjectId: t.linkedProjectId || '',
    samplePreparedBy: t.samplePreparedBy || '',
    testParticipants: Array.isArray(t.testParticipants) ? t.testParticipants : [],
    testDate: t.testDate || '',
    testLocation: t.testLocation || '',
    cookingMethod: t.cookingMethod || '',
    cookingMethodSteps: Array.isArray(t.cookingMethodSteps) ? t.cookingMethodSteps : [],
    productData: (t.productData && typeof t.productData === 'object') ? t.productData : {},
    note: t.note || ''
  };
}
// Lazily creates the per-product data bucket (photos + fixed scores) keyed
// by product id — works for both a linked recipe's id and a manual
// product's own id, same keying convention the old evaluation.scores map
// already used. Mutates `t` in place so the caller doesn't have to.
function getTrialProductData(t, productId){
  if(!t.productData || typeof t.productData !== 'object') t.productData = {};
  if(!t.productData[productId]) t.productData[productId] = {};
  return t.productData[productId];
}
// Sensory Evaluation and Test Result are personal opinions now -- each
// evaluator's own answers live under pd.evaluations[email], never
// overwriting anyone else's (see the "Perform Evaluation" wiring below).
// Mutates `t`/`pd` in place, same lazy-init shape as getTrialProductData.
function getMyEvaluation(pd){
  if(!currentUser?.email) return {};
  if(!pd.evaluations || typeof pd.evaluations !== 'object') pd.evaluations = {};
  if(!pd.evaluations[currentUser.email]) pd.evaluations[currentUser.email] = {};
  return pd.evaluations[currentUser.email];
}
// One { who, value } per person who has weighed in on this product's
// given criteria (or Test Result, when criteriaId is null) -- feeds the
// combined "Overall" view. A trial saved before this feature has its
// Sensory Evaluation/Test Result as a flat pd[criteriaId]/pd.testResult
// value instead of pd.evaluations -- rather than silently dropping that
// history, it's folded in as one more entry (attributed to whoever the
// trial's updatedBy was, the closest thing to "who" that data has)
// unless a real evaluator already recorded the exact same value.
function combinedEvaluationEntries(pd, criteriaId, legacyAttributedTo){
  const entries = [];
  if(pd.evaluations && typeof pd.evaluations === 'object'){
    Object.entries(pd.evaluations).forEach(([email, ans]) => {
      const value = criteriaId ? ans?.[criteriaId] : ans?.testResult;
      if(value) entries.push({ who: email, value });
    });
  }
  const legacyValue = criteriaId ? pd[criteriaId] : pd.testResult;
  if(legacyValue && !entries.some(e => e.value === legacyValue)){
    entries.push({ who: legacyAttributedTo || 'Unspecified', value: legacyValue });
  }
  return entries;
}
function shortEvaluatorName(who){
  return (who || '').split('@')[0] || who || 'Unspecified';
}
// Improvement Guidelines gates on whether *anyone* flagged Needs Revision
// now that Test Result is per-evaluator -- one taster catching a problem
// is enough to need an improvement note, even if others accepted it.
function productNeedsRevision(pd){
  if(pd.testResult === 'Needs Revision') return true;
  if(pd.evaluations && typeof pd.evaluations === 'object'){
    return Object.values(pd.evaluations).some(ans => ans?.testResult === 'Needs Revision');
  }
  return false;
}
// A per-criteria-row Note, spanning all products rather than one per
// product -- e.g. a general remark about "Odor" that applies across every
// sample being compared. Sensory Evaluation and Improvement Guidelines
// keep separate notes for the same criteria row (same id, different
// bucket) since the two tables' remarks don't necessarily overlap.
function getCriteriaNotes(t, bucket){
  if(!t[bucket] || typeof t[bucket] !== 'object') t[bucket] = {};
  return t[bucket];
}
// A product's photos: one free-form gallery (up to TRIAL_PHOTO_MAX), each
// with an editable caption (defaults to the uploaded file's own name) --
// no fixed "Before/After frying" categories, the caption itself says
// whatever the photo needs it to. Older trials kept a single plain
// data-URL string in a separate beforePhoto/afterPhoto field each; both
// get folded into the one photos array in place the first time it's
// touched, same lazy-migration approach as getTrialProductData itself
// just above. Never drops data even if both legacy slots had something.
const TRIAL_PHOTO_MAX = 4;
function normalizeTrialPhotos(pd){
  if(!Array.isArray(pd.photos)){
    const merged = [];
    for(const legacyField of ['beforePhoto', 'afterPhoto']){
      const legacy = pd[legacyField];
      if(Array.isArray(legacy)) merged.push(...legacy);
      else if(legacy) merged.push({ id: uid(), dataUrl: legacy, caption: '' });
    }
    pd.photos = merged;
  }
  return pd.photos;
}
// Criteria rows used to be two separate fixed lists (5 for Sensory
// Evaluation, 3 differently-worded for Improvement Guidelines). Now
// they're one user-editable list per trial (rename/add/remove) shared by
// both tables, so a change in one place applies to both instead of the
// two silently drifting out of sync. Default ids match the old fixed
// Sensory Evaluation keys 1:1 so an existing trial's scores (stored flat
// as pd[key]) keep showing up with no migration step; "Appearance
// (Exterior)" is dropped from the default per request -- a trial that
// already had a score under that old key just keeps it, unused, same
// never-destroy-data approach as elsewhere in this file.
function blankEvaluationCriteria(){
  return [
    { id: 'appearanceInterior', label: 'Appearance' },
    { id: 'odor', label: 'Odor' },
    { id: 'taste', label: 'Taste' },
    { id: 'texture', label: 'Texture' }
  ];
}
function getEvaluationCriteria(t){
  if(!Array.isArray(t.evaluationCriteria) || !t.evaluationCriteria.length) t.evaluationCriteria = blankEvaluationCriteria();
  // A test saved before "(Interior)" was dropped from this default (see
  // CHANGELOG 3.0.415) still carries the old label verbatim -- criteria
  // are stored per-test now that they're editable, so the code default
  // alone never reaches it. Only the exact untouched old default text is
  // corrected here, never a custom label someone deliberately typed.
  const legacy = t.evaluationCriteria.find(c => c.id === 'appearanceInterior' && c.label === 'Appearance (Interior)');
  if(legacy) legacy.label = 'Appearance';
  return t.evaluationCriteria;
}
// Improvement Guidelines used to store its 3 criteria under their own
// differently-named fixed keys (improveAppearanceInterior/improveOdor/
// improveTexture). It now shares Sensory Evaluation's criteria ids,
// prefixed "improve_" to keep the two tables' values separate per
// criterion -- this bridges the 3 that overlap so existing notes keep
// showing up. A write always goes to the new prefixed key (see the
// .teval-improve wiring), so this fallback is read-only; the old fields
// are left untouched, just unused going forward.
const LEGACY_IMPROVEMENT_KEYS = { appearanceInterior: 'improveAppearanceInterior', odor: 'improveOdor', texture: 'improveTexture' };
function improvementFieldValue(pd, criteriaId){
  const key = 'improve_' + criteriaId;
  if(pd[key] !== undefined) return pd[key] || '';
  const legacyKey = LEGACY_IMPROVEMENT_KEYS[criteriaId];
  return (legacyKey ? pd[legacyKey] : '') || '';
}
// The "Automatic suggestion" column's actual auto part -- averages this
// criteria's own JAR score(s) from Sensory Evaluation above (same
// combinedEvaluationEntries the JAR table itself reads, so it's always
// exactly what's shown there, across however many evaluators scored it),
// rounds to the nearest JAR step, and says just the direction to adjust in
// -- Increase/Decrease + the criteria name, no restating of the JAR
// wording itself (already shown right above in Sensory Evaluation, so
// repeating it here read as redundant/confusing rather than helpful, per
// user feedback). The midpoint ("Just right") or no numeric score yet
// needs no suggestion -- returns ''. Reads JAR_SCALE's own length/midpoint
// rather than a hardcoded 3/5 so this keeps working if the scale is ever
// resized again. Only ever a smart DEFAULT shown when nobody's typed
// their own note yet (see improvementRowsHtml below); never overwrites a
// saved one, and only actually persists if a person edits the field (its
// change handler is what writes pd[improve_...], this function itself
// never touches saved data).
// Shared by autoImprovementSuggestion below and the Summary Test modal
// (which needs to tell "no suggestion because it's already Just Right"
// apart from "no suggestion because nobody's scored it yet").
function criteriaAverageJarScore(c, pd){
  const entries = combinedEvaluationEntries(pd, c.id, null);
  const nums = entries.map(e => parseInt(e.value, 10)).filter(n => n >= 1 && n <= JAR_SCALE.length);
  if(!nums.length) return null;
  return Math.round(nums.reduce((s,n)=>s+n,0) / nums.length);
}
function autoImprovementSuggestion(c, pd){
  const midpoint = Math.ceil(JAR_SCALE.length / 2);
  const avg = criteriaAverageJarScore(c, pd);
  if(avg === null || avg === midpoint) return '';
  const action = avg < midpoint ? 'Increase' : 'Decrease';
  const actionTh = avg < midpoint ? 'เพิ่ม' : 'ลด';
  // Same -100%/+100% figure as the wizard's own Idea Guideline
  // (jarAdjustmentPercent), computed from this same averaged/rounded
  // score so the two always agree.
  const pct = jarAdjustmentPercent(String(avg));
  return `${action} (${actionTh}) ${c.label} ${pct > 0 ? '+' : ''}${pct}%`;
}
const TRIAL_TEST_RESULT_OPTIONS = ['Accepted', 'Not accepted', 'Needs Revision'];
const TRIAL_TEST_RESULT_CLASSES = {
  'Accepted': 'trial-result-accepted',
  'Needs Revision': 'trial-result-needs-revision',
  'Not accepted': 'trial-result-not-accepted'
};
// Wizard buttons need their own selected-state coloring (not the light-
// theme .trial-result-* chip classes above, whose padding/margin are tuned
// for the small Overall-view chips, not a full-width dark button).
const EVAL_WIZARD_RESULT_CLASSES = {
  'Accepted': 'eval-wizard-tr-accepted',
  'Needs Revision': 'eval-wizard-tr-needs-revision',
  'Not accepted': 'eval-wizard-tr-not-accepted'
};
// The "Perform Evaluation" wizard scores each criteria on a 1-9
// Just-About-Right (JAR) scale -- same generic wording for every
// criteria (per request) rather than custom per-criteria phrasing, so
// it works automatically for any criteria, including ones added later
// via "+ Add Criteria", with no extra setup needed per row. Widened from
// 1-5 to 1-9 per request -- 5 stays the midpoint ("Just right"), so an
// existing saved "3" (the old midpoint) no longer reads as Just Right;
// every other old 1/2/4/5 answer likewise now lands on a different,
// finer-grained step than it meant under the old 5-point scale. This is
// an inherent tradeoff of widening the scale's resolution, not a bug --
// nothing rewrites old answers, they just now read against new anchors.
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
function jarScoreLabel(value){
  const found = JAR_SCALE.find(s => s.value === value);
  return found ? found.label : (value || '');
}
// A legacy free-text answer (from before this JAR redesign) shows as-is
// rather than crashing on the "N/9" format.
function jarScoreDisplay(value){
  return /^[1-9]$/.test(value || '') ? `${value}/9` : (value || '');
}
// "Idea Guideline" -- how far off-ideal a JAR answer is, as a percentage
// toward the midpoint ("Just right"), assuming the distance from the
// midpoint to either end of the scale is a full 100% change in whatever's
// being judged (e.g. 4 steps from 5 to 1 on a 9-point scale == 100%, so
// each step off is 25%). Positive means "increase", negative "decrease" --
// a score of 4 (one step below the midpoint 5, on a 9-point scale) comes
// out to +25%, matching the worked example this was built from. Reads
// JAR_SCALE's own length/midpoint (not hardcoded) so it keeps working if
// the scale is ever resized again, same reasoning as autoImprovementSuggestion.
// Returns null for no/invalid answer yet, 0 exactly at the midpoint.
function jarAdjustmentPercent(value){
  const n = parseInt(value, 10);
  if(!(n >= 1 && n <= JAR_SCALE.length)) return null;
  const midpoint = Math.ceil(JAR_SCALE.length / 2);
  const maxDeviation = midpoint - 1;
  if(maxDeviation <= 0) return 0;
  return Math.round(-((n - midpoint) / maxDeviation) * 100);
}
// Shared by the main render pass and the evaluation wizard so both list
// products being compared the same way (linked recipes first, then manual
// products, each labeled the same way the product cards/table headers are).
function trialEvalTargets(t){
  const linkedRecipes = (t.recipeIds || []).map(id => recipes.find(r => r.id === id)).filter(Boolean);
  const manualProducts = t.manualProducts || [];
  return [
    ...linkedRecipes.map(r => ({ id: r.id, label: fullCode(r) || recipeDisplayLabel(r) })),
    ...manualProducts.map(mp => ({ id: mp.id, label: [mp.name || 'Untitled', mp.code].filter(Boolean).join(' ') }))
  ];
}
// Anyone who actually weighs in on a product should show up in Test
// Participants, even if they weren't added ahead of time -- keeps that
// list matching who really evaluated without requiring a coordinator to
// pre-register every taster first. Fires the first time someone answers
// something in the wizard, not merely on opening it.
function registerEvaluationParticipant(t){
  if(!currentUser?.email) return;
  if(!Array.isArray(t.testParticipants)) t.testParticipants = [];
  const already = t.testParticipants.some(name => name === currentUser.email || name === shortEvaluatorName(currentUser.email));
  if(!already) t.testParticipants.push(shortEvaluatorName(currentUser.email));
}

// The "Perform Evaluation" wizard -- a dedicated full-screen overlay
// (body-appended, independent of the part-block markup) walking one
// product at a time: a JAR score per Sensory Evaluation criteria, a
// Comments field, then Test Result as the last field on that product's
// page, finishing with a Review page listing every product's answers
// together before Done closes the overlay. Re-rendered on every answer
// so the overlay always reflects the latest evalWizard/trials state,
// same pattern as renderTrialsList itself.
function renderEvaluationWizard(){
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
      <div class="eval-wizard-product-name">${escapeHtml(p.label)}</div>
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
          <textarea class="eval-wizard-criteria-note" data-role="eval-criteria-note" data-criteria-id="${escapeHtml(c.id)}" placeholder="Note for ${escapeHtml(c.label)} (optional)">${escapeHtml(mine[`${c.id}_note`] || '')}</textarea>
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
          ${mine.comment ? `<div class="eval-wizard-review-row"><span>Comments</span><b>${escapeHtml(mine.comment)}</b></div>` : ''}
          <div class="eval-wizard-review-row"><span>Test Result</span><b class="${EVAL_WIZARD_RESULT_CLASSES[mine.testResult] || ''}">${escapeHtml(mine.testResult || '-')}</b></div>
        </div>
        `;
      }).join('')}
      <div class="eval-wizard-review-disclaimer">Note: This Idea Guideline reflects only your own scores — the final improvement direction may change based on the overall average and other evaluators' opinions (คำแนะนำนี้อ้างอิงจากคะแนนของคุณเท่านั้น ผลสุดท้ายอาจเปลี่ยนแปลงตามค่าเฉลี่ยโดยรวมและความเห็นจากผู้เข้าร่วมทดสอบคนอื่นๆ)</div>
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
  overlay.querySelector('.eval-wizard-comment')?.addEventListener('change', e => {
    const p = products[evalWizard.step];
    const pd = getTrialProductData(t, p.id);
    const mine = getMyEvaluation(pd);
    mine.comment = e.target.value.trim();
    scheduleTrialSave(t);
    // The Overall table's Comments row reads straight from this (see
    // commentsRowHtml) -- refresh it now, same as the criteria Note field
    // and every JAR/Test Result answer already do.
    renderTrialsList();
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
  overlay.querySelector('[data-role="eval-back"]')?.addEventListener('click', () => {
    evalWizard.step = Math.max(0, evalWizard.step - 1);
    renderEvaluationWizard();
  });
  overlay.querySelector('[data-role="eval-next"]')?.addEventListener('click', () => {
    evalWizard.step = Math.min(products.length, evalWizard.step + 1);
    renderEvaluationWizard();
  });
  overlay.querySelector('[data-role="eval-done"]')?.addEventListener('click', () => {
    evalWizard = null;
    renderTrialsList();
    renderEvaluationWizard();
  });
}

// Combines every evaluator's Test Result answers for a product into one
// headline verdict -- Needs Revision if even one flagged it (same "one
// taster's catch is enough" rule as productNeedsRevision), Accepted only
// if every answer that exists agrees, Not accepted if any answer does
// and none needed revision, or null if nobody's answered yet at all.
function combinedVerdict(pd){
  if(productNeedsRevision(pd)) return 'Needs Revision';
  const entries = combinedEvaluationEntries(pd, null, null);
  if(!entries.length) return null;
  if(entries.every(e => e.value === 'Accepted')) return 'Accepted';
  if(entries.some(e => e.value === 'Not accepted')) return 'Not accepted';
  return null;
}
// EVAL_WIZARD_RESULT_CLASSES' own classes only carry color when nested
// under the specific selectors the wizard/Review page already use
// (.eval-wizard-testresult-btn.selected.X, .eval-wizard-review-row b.X) --
// this modal's verdict badge needs its own standalone-usable classes.
const TRIAL_SUMMARY_VERDICT_CLASSES = {
  'Accepted': 'trial-summary-verdict-accepted',
  'Needs Revision': 'trial-summary-verdict-needs-revision',
  'Not accepted': 'trial-summary-verdict-not-accepted'
};
// Shared by the Summary Test modal (detailed cards) and the Summary Table
// view (compact inline) -- one product's verdict plus which of its
// scored criteria still need adjusting vs are already Just Right, each
// carrying its own Improvement Guidelines Note (t.criteriaImproveNotes --
// the SAME per-criteria note typed into that table's own Note column,
// not Sensory Evaluation's separate criteriaNotes bucket) when there is
// one. Read directly off t rather than through getCriteriaNotes, since
// that helper lazily writes an empty {} onto t if the bucket is missing
// -- fine for the editable table it's normally used from, but this is a
// read-only summary with nothing to ever save, so there's no reason to
// mutate the live trial object just to read from it.
function summarizeTrialProduct(t, criteria, p){
  const pd = getTrialProductData(t, p.id);
  const verdict = combinedVerdict(pd);
  const improveNotes = (t.criteriaImproveNotes && typeof t.criteriaImproveNotes === 'object') ? t.criteriaImproveNotes : {};
  const scoredCriteria = criteria.filter(c => criteriaAverageJarScore(c, pd) !== null);
  const improvements = scoredCriteria
    .map(c => ({ label: c.label, suggestion: autoImprovementSuggestion(c, pd), note: (improveNotes[c.id] || '').trim() }))
    .filter(x => x.suggestion);
  const justRight = scoredCriteria
    .filter(c => !autoImprovementSuggestion(c, pd))
    .map(c => ({ label: c.label, note: (improveNotes[c.id] || '').trim() }));
  return { label: p.label, verdict, improvements, justRight };
}
// Read-only overview -- one row per test (already sorted most-recently-
// updated first by the caller), grouped by linked Project -- Project/PD
// shown once per group (rowspan) rather than repeated on every test's own
// row, with each test inside the group getting its own Summary Test row,
// newest first. Since sortedTrials already arrives newest-first, building
// each group by first-seen order naturally puts both the tests WITHIN a
// group and the groups THEMSELVES (by whichever one's most recent test
// appears earliest in sortedTrials) in that same recency order, with no
// extra sort needed. Untracked/unlinked tests each get their own
// single-test "group" (never merged with each other, since there's no
// shared project to group them by).
function renderTrialsSummaryTable(container, sortedTrials){
  const groups = [];
  const groupByKey = new Map();
  sortedTrials.forEach(t => {
    const key = t.linkedProjectId || ('__unlinked__' + t.id);
    if(!groupByKey.has(key)){
      const g = { projectId: t.linkedProjectId || null, trials: [] };
      groupByKey.set(key, g);
      groups.push(g);
    }
    groupByKey.get(key).trials.push(t);
  });

  container.innerHTML = `
    <div style="overflow-x:auto;">
    <table class="compare-table trial-summary-table">
      <thead><tr><th>Project</th><th>PD / Responsible Person</th><th>Summary Test</th></tr></thead>
      <tbody>
        ${groups.map(g => {
          const linkedProject = g.projectId ? projects.find(pr => pr.id === g.projectId) : null;
          return g.trials.map((t, i) => {
            const criteria = getEvaluationCriteria(t);
            // Only products marked "Continue Development" (see the new row
            // at the bottom of Improvement Guidelines) -- same rule as the
            // Summary Test modal, so the two never disagree about what
            // counts as "worth showing on a summary".
            const evalTargets = trialEvalTargets(t).filter(p => getTrialProductData(t, p.id).continueDevelopment === 'continue');
            const products = evalTargets.map(p => summarizeTrialProduct(t, criteria, p));
            return `
              <tr>
                ${i === 0 ? `
                  <td rowspan="${g.trials.length}">${escapeHtml(linkedProject?.name || '-')}</td>
                  <td rowspan="${g.trials.length}">${escapeHtml(linkedProject?.responsiblePerson || '-')}</td>
                ` : ''}
                <td>
                  <div class="trial-table-summary-test-label">${t.testDate ? 'Tested ' + escapeHtml(formatDateLong(t.testDate)) : 'No test date'}</div>
                  ${products.length === 0 ? '<span class="overview-empty">No products marked "Continue Development"</span>' : products.map(pr => `
                    <div class="trial-table-summary-product">
                      <div class="trial-table-summary-head">
                        <b>${escapeHtml(pr.label)}</b>
                        ${pr.verdict ? `<span class="trial-summary-verdict ${TRIAL_SUMMARY_VERDICT_CLASSES[pr.verdict] || ''}">${escapeHtml(pr.verdict)}</span>` : '<span class="overview-empty">Not yet evaluated</span>'}
                      </div>
                      ${pr.improvements.length ? `<div class="trial-table-summary-line"><b>Improve:</b> ${pr.improvements.map(x => escapeHtml(x.suggestion) + (x.note ? ` (${escapeHtml(x.note)})` : '')).join(', ')}</div>` : ''}
                      ${pr.justRight.length ? `<div class="trial-table-summary-line trial-table-summary-ok"><b>Just Right:</b> ${pr.justRight.map(c => escapeHtml(c.label) + (c.note ? ` (${escapeHtml(c.note)})` : '')).join(', ')}</div>` : ''}
                    </div>
                  `).join('')}
                </td>
              </tr>
            `;
          }).join('');
        }).join('')}
      </tbody>
    </table>
    </div>
  `;
}
function renderTrialSummaryModal(){
  const existing = document.getElementById('trialSummaryOverlay');
  if(!trialSummaryId){ existing?.remove(); return; }
  const t = trials.find(x => x.id === trialSummaryId);
  if(!t){ trialSummaryId = null; existing?.remove(); return; }
  // Only a product explicitly marked "Continue Development" (see the new
  // row at the bottom of Improvement Guidelines) belongs here -- per
  // request, a sample nobody's decided to carry forward (or one flagged
  // Discontinue) shouldn't keep showing up on a page meant for a quick
  // read of where things stand.
  const evalTargets = trialEvalTargets(t).filter(p => getTrialProductData(t, p.id).continueDevelopment === 'continue');
  const criteria = getEvaluationCriteria(t);

  const overlay = existing || document.createElement('div');
  overlay.id = 'trialSummaryOverlay';
  overlay.className = 'eval-wizard-overlay';
  if(!existing){
    document.body.appendChild(overlay);
    // Read-only content, nothing typed here to accidentally lose -- so
    // (unlike the Perform Evaluation wizard above) a click on the
    // backdrop closes this one, same mousedown+click-both-on-overlay
    // guard as wireModalOverlayClose (app.js) uses, just inlined since
    // this overlay is built dynamically rather than living in index.html.
    let mousedownOnOverlay = false;
    overlay.addEventListener('mousedown', e => { mousedownOnOverlay = e.target === overlay; });
    overlay.addEventListener('click', e => {
      if(mousedownOnOverlay && e.target === overlay){ trialSummaryId = null; renderTrialSummaryModal(); }
      mousedownOnOverlay = false;
    });
  }

  overlay.innerHTML = `
    <div class="eval-wizard-card">
      <div class="eval-wizard-header">
        <div class="eval-wizard-title">Forge · Test Summary</div>
        <button type="button" class="eval-wizard-close" data-role="summary-close" title="Close">${icon('x')}</button>
      </div>
      ${evalTargets.length === 0 ? '<div class="overview-empty">No products marked "Continue Development" yet — mark one in Improvement Guidelines to see it here</div>' : evalTargets.map(p => {
        const { label, verdict, improvements, justRight } = summarizeTrialProduct(t, criteria, p);
        return `
          <div class="trial-summary-product">
            <div class="trial-summary-product-head">
              <div class="trial-summary-product-name">${escapeHtml(label)}</div>
              ${verdict
                ? `<span class="trial-summary-verdict ${TRIAL_SUMMARY_VERDICT_CLASSES[verdict] || ''}">${escapeHtml(verdict)}</span>`
                : '<span class="overview-empty">Not yet evaluated</span>'}
            </div>
            ${improvements.length ? `
              <div class="trial-summary-improve-title">Suggested Improvements</div>
              <ul class="trial-summary-improve-list">${improvements.map(x => `<li><b>${escapeHtml(x.label)}:</b> ${escapeHtml(x.suggestion)}${x.note ? `<span class="trial-summary-item-note"> — ${escapeHtml(x.note)}</span>` : ''}</li>`).join('')}</ul>
            ` : (verdict ? '<div class="trial-summary-ok">✓ All criteria are Just Right — no changes suggested</div>' : '')}
            ${justRight.length ? `
              <div class="trial-summary-improve-title">Just Right (พอดี)</div>
              <ul class="trial-summary-justright-list">${justRight.map(c => `<li>${escapeHtml(c.label)}${c.note ? `<span class="trial-summary-item-note"> — ${escapeHtml(c.note)}</span>` : ''}</li>`).join('')}</ul>
            ` : ''}
          </div>
        `;
      }).join('')}
      ${(t.note || '').trim() ? `
        <div class="trial-summary-note">
          <div class="trial-summary-improve-title">Note</div>
          <div class="trial-summary-note-text">${escapeHtml(t.note)}</div>
        </div>
      ` : ''}
    </div>
  `;
  overlay.querySelector('[data-role="summary-close"]')?.addEventListener('click', () => {
    trialSummaryId = null;
    renderTrialSummaryModal();
  });
}

// A product being compared that isn't one of this app's own Recipes — a
// competitor sample, a customer's existing product, anything typed in by
// name rather than picked from the list. Same detail fields as a linked
// Recipe's card (see the compare-info-col markup below) but hand-typed
// instead of pulled from the recipe/project record.
function blankManualTrialProduct(name){
  return { id: uid(), name: (name || '').trim(), code: '', date: '', totalWeight: '', customer: '', destination: '', owner: '', stage: '' };
}

function saveTrialToCloud(t){
  return setDoc(doc(trialsCol, t.id), t);
}
function deleteTrialFromCloud(id){
  return deleteDoc(doc(trialsCol, id));
}
function scheduleTrialSave(t){
  t.updatedAt = Date.now();
  t.updatedBy = currentUser?.email || '';
  saveTrialToCloud(t);
}

/* One-time, idempotent move of each recipe's embedded trialPhotos/
   trialEvaluation into a standalone Trial record linked back by recipeId -
   guarded by trialsMigrated so it only ever runs once per session, and by
   the "does a trial already reference this recipe" check so re-running it
   (e.g. after a reload) can never create duplicates. The old fields are
   left on the recipe untouched (unused, harmless) rather than stripped, so
   this migration can't destroy data if anything about it is ever wrong. */
export function migrateTrialsFromRecipes(){
  if(trialsMigrated || !recipesLoaded || !trialsLoaded) return;
  trialsMigrated = true;
  let migratedAny = false;
  recipes.forEach(r => {
    const hasPhotos = Array.isArray(r.trialPhotos) && r.trialPhotos.length > 0;
    const hasEval = Array.isArray(r.trialEvaluation) && r.trialEvaluation.length > 0;
    if(!hasPhotos && !hasEval) return;
    if(trials.some(t => (t.recipeIds || []).includes(r.id))) return;
    const now = Date.now();
    const t = {
      id: uid(),
      recipeIds: [r.id],
      photos: hasPhotos ? r.trialPhotos : [],
      evaluation: hasEval ? r.trialEvaluation : [],
      createdBy: r.createdBy || '',
      createdAt: r.createdAt || now,
      updatedBy: currentUser?.email || '',
      updatedAt: now
    };
    trials.push(t);
    saveTrialToCloud(t);
    migratedAny = true;
  });
  if(migratedAny && mainFeatureView === 'trials') renderTrialsList();
}

export function mountTrialsView(){
  const main = document.getElementById('mainArea');
  main.classList.remove('main-wide');
  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('flask-conical', 24)} Test Results</div>
    </div>
    <div class="card">
      <div style="display:flex;align-items:center;margin-bottom:16px;">
        <button class="btn btn-primary btn-sm" id="btnAddTrial">+ New Test</button>
        <div class="view-mode-toggle" id="trialsViewToggle">
          <button type="button" class="btn btn-sm view-mode-btn${trialsViewMode === 'list' ? ' active' : ''}" data-mode="list">${icon('list', 14)} List</button>
          <button type="button" class="btn btn-sm view-mode-btn${trialsViewMode === 'table' ? ' active' : ''}" data-mode="table">${icon('file-text', 14)} Summary Table</button>
        </div>
      </div>
      <div id="trialsList"></div>
    </div>
  `;

  document.getElementById('trialsViewToggle').querySelectorAll('.view-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      trialsViewMode = btn.dataset.mode;
      renderTrialsList();
      document.querySelectorAll('#trialsViewToggle .view-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === trialsViewMode));
    });
  });

  document.getElementById('btnAddTrial').addEventListener('click', () => {
    const t = blankTrial();
    trials.push(t);
    saveTrialToCloud(t);
    logActivityEvent('created', 'trial', trialLabel(t));
    trialEditingId = t.id;
    trialExpandedIds.add(t.id);
    renderTrialsList();
  });

  renderTrialsList();
  playContentTransition(main);
}

export function renderTrialsList(){
  const container = document.getElementById('trialsList');
  if(!container) return;
  if(trials.length === 0){
    container.innerHTML = '<div class="overview-empty">No test results yet — click "+ New Test" above to start one</div>';
    return;
  }
  const sorted = [...trials].sort((a,b) => b.updatedAt - a.updatedAt);
  if(trialsViewMode === 'table'){
    renderTrialsSummaryTable(container, sorted);
    renderEvaluationWizard();
    renderTrialSummaryModal();
    return;
  }
  container.innerHTML = sorted.map(t => {
    const isEditing = t.id === trialEditingId;
    const isExpanded = isEditing || trialExpandedIds.has(t.id);
    // Migrated view used only for building this HTML string below — the
    // wiring block further down re-fetches the raw trial from `trials` and
    // guards each field defensively instead, same split used for Projects'
    // monthlyUpdates (see migrateMonthlyUpdate).
    const mt = migrateTrial(t);
    const linkedProject = mt.linkedProjectId ? projects.find(p => p.id === mt.linkedProjectId) : null;
    // The linked Project's own cover photo (p.image -- the same field the
    // Projects list/detail view itself shows, see .proj-row-photo-btn in
    // projects.js), not its separate Idea/Reference Images gallery, which
    // is inspiration material rather than "the project's own picture".
    const linkedProjectImage = linkedProject?.image || null;
    const linkedRecipes = (t.recipeIds || []).map(id => recipes.find(r => r.id === id)).filter(Boolean);
    const manualProducts = t.manualProducts || [];
    const combinedCount = (t.recipeIds || []).length + manualProducts.length;
    const productLabel = linkedProject?.name || (combinedCount
      ? [...linkedRecipes.map(r => recipeDisplayLabel(r)), ...manualProducts.map(mp => mp.name || 'Untitled')].join(', ')
      : 'Untitled test');
    const activity = [];
    if(t.createdBy) activity.push(`Created by ${escapeHtml(t.createdBy)}${t.createdAt ? ' · ' + escapeHtml(formatActivityDateTime(t.createdAt)) : ''}`);
    if(t.updatedBy && t.updatedAt !== t.createdAt) activity.push(`Last edited by ${escapeHtml(t.updatedBy)}${t.updatedAt ? ' · ' + escapeHtml(formatActivityDateTime(t.updatedAt)) : ''}`);

    const usedRecipeIds = new Set(t.recipeIds || []);
    const availableRecipes = recipes
      .filter(r => !usedRecipeIds.has(r.id))
      .sort((a,b) => (a.name||'').localeCompare(b.name||'', undefined, {sensitivity:'base'}));
    const atMax = combinedCount >= TRIAL_MAX_PRODUCTS;

    // A product's photos live per product now (not 3 shared across the
    // whole trial) — same idea as the read-only product cards below, built
    // once here and dropped into each card. No preset "Before/After
    // frying" categories -- just add up to TRIAL_PHOTO_MAX freely, each
    // with its own editable caption to say whatever it needs to. Reuses
    // the same thumbnail-grid-with-caption markup/CSS classes as Projects'
    // Idea / Reference Images gallery (proj-ref-image-*), just with
    // trial-specific data attributes on the interactive bits.
    const trialPhotosHtml = productId => {
      const pd = getTrialProductData(mt, productId);
      const photos = normalizeTrialPhotos(pd);
      const photosHtml = photos.map(photo => `
        <div class="proj-ref-image-item">
          <div class="proj-ref-image-thumb-wrap">
            <img src="${escapeHtml(photo.dataUrl)}" class="proj-ref-image-thumb" alt="${escapeHtml(photo.caption || 'Product photo')}">
            ${isEditing ? `<button type="button" class="proj-ref-image-remove" data-role="remove-trial-photo" data-product-id="${escapeHtml(productId)}" data-photo-id="${escapeHtml(photo.id)}" title="Remove">${icon('x', 12)}</button>` : ''}
          </div>
          ${isEditing
            ? `<input type="text" class="proj-ref-image-caption-input trial-photo-caption-input" data-product-id="${escapeHtml(productId)}" data-photo-id="${escapeHtml(photo.id)}" value="${escapeHtml(photo.caption || '')}" placeholder="Caption">`
            : (photo.caption ? `<div class="proj-ref-image-caption">${escapeHtml(photo.caption)}</div>` : '')}
        </div>
      `).join('');
      return `
        <div class="trial-photo-slot">
          ${photosHtml ? `<div class="proj-ref-images-grid">${photosHtml}</div>` : ''}
          ${isEditing && photos.length < TRIAL_PHOTO_MAX ? `<input type="file" class="trial-product-photo-input" data-product-id="${escapeHtml(productId)}" accept="image/*">` : ''}
          ${!isEditing && !photos.length ? '<div class="trial-photo-empty">No photo</div>' : ''}
        </div>
      `;
    };

    // Side-by-side product cards (same visual language as Compare Recipes'
    // info-grid) so every product being evaluated is visible at once,
    // instead of a click-to-reveal list — the whole point of a comparison.
    const recipeCardsHtml = (t.recipeIds || []).map(recipeId => {
      const r = recipes.find(x => x.id === recipeId);
      const removeBtn = isEditing ? `<button class="icon-btn" data-role="remove-trial-recipe" data-recipe-id="${escapeHtml(recipeId)}" title="Remove this product" style="margin-top:8px;">${icon('x')} Remove</button>` : '';
      if(!r){
        return `
          <div class="compare-info-col">
            <div class="ci-row" style="color:var(--danger);">Recipe not found (deleted?)</div>
            ${removeBtn}
          </div>
        `;
      }
      const totalWt = allIngredientsInRecipe(r).reduce((s,i) => s + (parseFloat(i.weight) || 0), 0);
      const link = findProjectForRecipe(r.id);
      return `
        <div class="compare-info-col">
          <div class="ci-name">${escapeHtml(recipeDisplayLabel(r))}</div>
          <div class="ci-row"><b>Code:</b> ${escapeHtml(fullCode(r) || '-')}</div>
          <div class="ci-row"><b>Date:</b> ${escapeHtml(r.date || '-')}</div>
          <div class="ci-row"><b>Total weight:</b> ${escapeHtml(formatWeight(totalWt))}</div>
          ${link?.project.customerName ? `<div class="ci-row"><b>Customer:</b> ${escapeHtml(link.project.customerName)}</div>` : ''}
          ${link?.project.destinationCountry ? `<div class="ci-row"><b>Destination:</b> ${escapeHtml(link.project.destinationCountry)}</div>` : ''}
          ${link?.project.ownerSalesRep ? `<div class="ci-row"><b>Project Owner:</b> ${escapeHtml(link.project.ownerSalesRep)}</div>` : ''}
          ${link ? `<div class="ci-row"><b>Stage:</b> ${escapeHtml(link.product.stage || '-')}</div>` : ''}
          ${trialPhotosHtml(r.id)}
          ${removeBtn}
        </div>
      `;
    }).join('');

    // A manually-typed product (not one of this app's Recipes) -- just a
    // name and a Code, both free text, plus its own before/after photos
    // (see trialPhotosHtml below). Date/Total weight/Customer/
    // Destination/Project Owner/Stage were dropped; the trial's own
    // Test Date field above already covers "when", and the rest only
    // made sense for a product that actually has a linked Project.
    const manualFieldRows = [
      ['code', 'Code', null]
    ];
    const manualCardsHtml = manualProducts.map(mp => {
      const removeBtn = isEditing ? `<button class="icon-btn" data-role="remove-trial-manual" data-manual-id="${escapeHtml(mp.id)}" title="Remove this product" style="margin-top:8px;">${icon('x')} Remove</button>` : '';
      // Duplicate copies this card (name, Code, photos) as a starting point
      // for a near-identical variant -- e.g. same product at a different
      // Code -- without retyping everything. Hidden once at the cap, same
      // as +Add above.
      const duplicateBtn = isEditing && !atMax ? `<button class="icon-btn" data-role="duplicate-trial-manual" data-manual-id="${escapeHtml(mp.id)}" title="Duplicate this product" style="margin-top:8px;">${icon('copy')} Duplicate</button>` : '';
      if(isEditing){
        return `
          <div class="compare-info-col" data-manual-id="${escapeHtml(mp.id)}">
            <input type="text" class="tmanual-field ci-name-input" data-field="name" value="${escapeHtml(mp.name)}" placeholder="Product name">
            ${manualFieldRows.map(([field, label, datalist]) => `
              <div class="ci-row"><b>${label}:</b> ${
                datalist === 'select'
                  ? `<select class="tmanual-field" data-field="${field}">
                      <option value="">-</option>
                      ${PROJECT_STAGES.map(s => `<option value="${escapeHtml(s)}" ${mp[field] === s ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
                    </select>`
                  : `<input type="${field === 'date' ? 'date' : 'text'}" class="tmanual-field" data-field="${field}" value="${escapeHtml(mp[field] || '')}" placeholder="-" ${datalist ? `list="${datalist}"` : ''}>`
              }</div>
            `).join('')}
            ${trialPhotosHtml(mp.id)}
            ${duplicateBtn}
            ${removeBtn}
          </div>
        `;
      }
      return `
        <div class="compare-info-col">
          <div class="ci-name">${escapeHtml(mp.name || 'Untitled')} <span style="font-weight:400;color:var(--text-dim);">(manual)</span></div>
          ${manualFieldRows.map(([field, label]) => mp[field] ? `<div class="ci-row"><b>${label}:</b> ${escapeHtml(mp[field])}</div>` : '').join('')}
          ${trialPhotosHtml(mp.id)}
        </div>
      `;
    }).join('');

    const productCardsHtml = recipeCardsHtml + manualCardsHtml;

    // Leading 220px spacer/column matches the fixed-width "Criteria" column
    // in the evaluation table below, so each product's card lines up with
    // its own score column — same technique used on the Compare Recipes page.
    const productCardsGrid = productCardsHtml
      ? `<div class="compare-info-grid gap-via-margin" style="grid-template-columns:220px repeat(${combinedCount},minmax(0,1fr));"><div class="compare-info-spacer"></div>${productCardsHtml}</div>`
      : '<div class="overview-empty">No products added yet</div>';

    // Each row's score is per-product (columns matching the product cards
    // above) so every sample can be scored against the same criteria in one
    // glance, the same way Compare Recipes lines up ingredients per recipe.
    // Manual products score exactly like linked recipes — same map keyed by
    // the manual product's own id instead of a recipeId (see
    // getTrialProductData). Criteria rows (see getEvaluationCriteria) are
    // per-trial and user-editable now, replacing the old fixed/freeform
    // split -- add, rename, or remove a row from the Sensory Evaluation
    // table and Improvement Guidelines' rows follow, since both read from
    // the same list.
    const evalTargets = [
      ...linkedRecipes.map(r => ({ id: r.id, label: fullCode(r) || recipeDisplayLabel(r) })),
      // Two manual products can share the same name (e.g. duplicated as a
      // starting point for a variant, or just two samples of "Alfrado" at
      // different Codes) -- appending the Code keeps their evaluation
      // table columns distinguishable instead of both reading "ALFRADO".
      ...manualProducts.map(mp => ({ id: mp.id, label: [mp.name || 'Untitled', mp.code].filter(Boolean).join(' ') }))
    ];
    const evalHeaderCells = evalTargets.map((p, i) => `<th class="${i > 0 ? 'recipe-boundary' : ''}">${escapeHtml(p.label)}</th>`).join('');
    // Improvement Guidelines' own header row (NOT shared with Sensory
    // Evaluation's identical-looking one above, even though both tables
    // otherwise reuse evalTargets/evaluationCriteria). Both the per-sample
    // columns and the trailing Note column are plain free-text fields either
    // way -- but per-sample is meant for the app's own suggested fix for
    // that criteria/sample, while Note is a person's own separate remark,
    // and that distinction wasn't obvious from the column labels alone, so
    // each gets a small caption explaining which is which.
    const improvementHeaderCells = evalTargets.map((p, i) => `<th class="${i > 0 ? 'recipe-boundary' : ''}">${escapeHtml(p.label)}<span class="teval-header-hint">Automatic suggestion (คำแนะนำอัตโนมัติ)</span></th>`).join('');
    const evaluationCriteria = getEvaluationCriteria(mt);
    const sensoryCriteriaNotes = getCriteriaNotes(mt, 'criteriaNotes');
    const fixedCriteriaRowsHtml = evaluationCriteria.map((c, ci) => {
      // Combined per-evaluator notes for this criteria, across every
      // product -- links this column to what's actually typed per-sample
      // in the Perform Evaluation wizard (mine[`${criteriaId}_note`])
      // instead of one hand-typed note only reachable via Edit mode. A
      // note typed the old way (before the wizard had its own per-
      // criteria Note field) is folded in too, attributed to whoever
      // last edited the test, so it's never silently dropped -- same
      // "never destroy data" approach as combinedEvaluationEntries.
      const noteEntries = [];
      evalTargets.forEach(p => {
        const pd = getTrialProductData(mt, p.id);
        if(pd.evaluations && typeof pd.evaluations === 'object'){
          Object.entries(pd.evaluations).forEach(([email, ans]) => {
            const noteVal = ans?.[`${c.id}_note`];
            if(noteVal) noteEntries.push({ who: email, product: p.label, note: noteVal });
          });
        }
      });
      const legacyNote = sensoryCriteriaNotes[c.id];
      if(legacyNote && !noteEntries.some(e => e.note === legacyNote)){
        noteEntries.push({ who: t.updatedBy || 'Unspecified', product: null, note: legacyNote });
      }
      return `
      <tr>
        <td>${isEditing
          ? `<div style="display:flex;align-items:center;gap:6px;">
              <div style="display:flex;flex-direction:column;">
                <button type="button" class="icon-btn" data-role="move-trial-criteria-up" data-criteria-id="${escapeHtml(c.id)}" title="Move up" ${ci === 0 ? 'disabled' : ''}>${icon('chevron-up', 12)}</button>
                <button type="button" class="icon-btn" data-role="move-trial-criteria-down" data-criteria-id="${escapeHtml(c.id)}" title="Move down" ${ci === evaluationCriteria.length - 1 ? 'disabled' : ''}>${icon('chevron-down', 12)}</button>
              </div>
              <input type="text" class="trial-criteria-label-input" data-criteria-id="${escapeHtml(c.id)}" value="${escapeHtml(c.label)}" placeholder="Criteria name">
              <button type="button" class="icon-btn" data-role="remove-trial-criteria" data-criteria-id="${escapeHtml(c.id)}" title="Remove this criteria">${icon('x')}</button>
            </div>`
          : `<b>${escapeHtml(c.label)}</b>`}</td>
        ${evalTargets.map((p, i) => {
          const pd = getTrialProductData(mt, p.id);
          // Sensory Evaluation is filled in through the "Perform
          // Evaluation" wizard now (see renderEvaluationWizard), not
          // inline here -- this table always shows the combined view:
          // every evaluator's own JAR answer, listed together (see
          // combinedEvaluationEntries), not a single shared value anyone
          // could silently overwrite.
          const entries = combinedEvaluationEntries(pd, c.id, t.updatedBy);
          return `<td class="${i > 0 ? 'recipe-boundary' : ''}">${entries.length
            ? entries.map(e => `<div class="teval-overall-entry" title="${escapeHtml(jarScoreLabel(e.value))}">${escapeHtml(jarScoreDisplay(e.value))} <span class="teval-jar-meaning">${escapeHtml(jarScoreLabel(e.value))}</span></div>`).join('')
            : '<span class="overview-empty">-</span>'}</td>`;
        }).join('')}
        <td class="recipe-boundary">${noteEntries.length
          ? noteEntries.map(e => `<div class="teval-overall-entry">${e.product && evalTargets.length > 1 ? `<b>(${escapeHtml(e.product)}):</b> ` : ''}${escapeHtml(e.note)}</div>`).join('')
          : '<span class="overview-empty">-</span>'}</td>
      </tr>
    `;
    }).join('');
    // Picking a name already on file (see Reference Lists' Evaluation
    // Criteria tab) keeps wording consistent across tests instead of
    // everyone retyping their own "Appearance" vs "Appearance (Interior)"
    // -- same idea as Cooking Method's own reference-list quick-fill on
    // the Products page. A topic with Sub-items (e.g. "Taste" -> Sweetness/
    // Salty/Sour) lists each sub under its parent, formatted as "Taste
    // (Sweetness)" -- matching the exact naming convention criteria rows
    // already use -- rather than the bare parent name. Typing a brand-new
    // name in the field below still works exactly as before if it isn't on
    // the list yet.
    const criteriaPickOptionsHtml = [...metaLists.evaluationCriteria]
      .sort((a,b) => metaItemName(a).localeCompare(metaItemName(b), undefined, { sensitivity: 'base', numeric: true }))
      .map(item => {
        const name = metaItemName(item);
        const subs = item.subs || [];
        return subs.length
          ? `<optgroup label="${escapeHtml(name)}">${subs.map(s => `<option value="${escapeHtml(`${name} (${s})`)}">${escapeHtml(s)}</option>`).join('')}</optgroup>`
          : `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
      }).join('');
    const addCriteriaBtnHtml = isEditing ? `
      ${criteriaPickOptionsHtml ? `
      <div class="project-add-row" style="margin-top:8px;">
        <select class="trial-criteria-pick-select">
          <option value="">Pick a Criteria (Reference Lists)...</option>
          ${criteriaPickOptionsHtml}
        </select>
      </div>
      ` : ''}
      <div class="project-add-row" style="margin-top:8px;">
        <input type="text" class="trial-add-criteria-input" list="evaluationCriteriaDatalist" placeholder="Or type a new name...">
        <button type="button" class="btn btn-sm" data-role="add-trial-criteria">+ Add Criteria</button>
      </div>
    ` : '';
    // Test Result is a per-evaluator pick now, same as the Sensory
    // Evaluation criteria above -- filled in as the last step of each
    // product in the "Perform Evaluation" wizard. This table always
    // shows everyone's picks together (see combinedEvaluationEntries),
    // each line colored via the existing accepted/needs-revision/
    // not-accepted classes.
    const testResultRowHtml = `
      <tr>
        <td><b>Test Result</b></td>
        ${evalTargets.map((p, i) => {
          const pd = getTrialProductData(mt, p.id);
          const entries = combinedEvaluationEntries(pd, null, t.updatedBy);
          return `<td class="${i > 0 ? 'recipe-boundary' : ''}">${entries.length
            ? entries.map(e => `<div class="${TRIAL_TEST_RESULT_CLASSES[e.value] || ''}"><b>${escapeHtml(e.value)}</b></div>`).join('')
            // Print (see printing-only) still gets an empty tick list on a
            // product nobody has evaluated yet, so a paper printout has
            // all 3 options for someone outside the system to mark by
            // hand -- disabled (not readonly -- readonly has no effect on
            // radio inputs) since this isn't the editable copy.
            : `<div class="trial-testresult-radios">${TRIAL_TEST_RESULT_OPTIONS.map(o => `
                <label class="trial-testresult-radio-label">
                  <input type="radio" disabled>
                  ${o}
                </label>
              `).join('')}</div>`}</td>`;
        }).join('')}
        <td class="recipe-boundary"></td>
      </tr>
    `;
    // Overall Comments is a per-evaluator, per-product free-text remark
    // from the last step of each product's page in the "Perform
    // Evaluation" wizard -- shown here the same combined way as Test
    // Result above, so it's visible on the summary table too instead of
    // only reachable by reopening the wizard's own Review page.
    const commentsRowHtml = `
      <tr>
        <td><b>Comments</b></td>
        ${evalTargets.map((p, i) => {
          const pd = getTrialProductData(mt, p.id);
          const entries = [];
          if(pd.evaluations && typeof pd.evaluations === 'object'){
            Object.entries(pd.evaluations).forEach(([email, ans]) => {
              if(ans?.comment) entries.push({ who: email, value: ans.comment });
            });
          }
          return `<td class="${i > 0 ? 'recipe-boundary' : ''}">${entries.length
            ? entries.map(e => `<div class="teval-overall-entry">${escapeHtml(e.value)}</div>`).join('')
            : '<span class="overview-empty">-</span>'}</td>`;
        }).join('')}
        <td class="recipe-boundary"></td>
      </tr>
    `;
    // Improvement notes only make sense for a product at least one
    // evaluator flagged Needs Revision -- Accepted/Not accepted from
    // everyone is already a final call, nothing left to improve toward.
    // Locked (readonly, muted) otherwise, including not-yet-evaluated.
    const improvementCriteriaNotes = getCriteriaNotes(mt, 'criteriaImproveNotes');
    const improvementRowsHtml = evaluationCriteria.map(c => `
      <tr>
        <td><b>${escapeHtml(c.label)}</b></td>
        ${evalTargets.map((p, i) => {
          const pd = getTrialProductData(mt, p.id);
          const needsRevision = productNeedsRevision(pd);
          const stored = improvementFieldValue(pd, c.id);
          const auto = (stored || !needsRevision) ? '' : autoImprovementSuggestion(c, pd);
          const displayValue = stored || auto;
          const isAuto = !stored && !!auto;
          const autoTitle = 'Automatically suggested from this criteria\'s JAR score above — edit to write your own instead';
          return `<td class="${i > 0 ? 'recipe-boundary' : ''}${needsRevision ? '' : ' trial-improve-na'}"><textarea class="teval-improve${isAuto ? ' teval-improve-auto' : ''}" data-product-id="${escapeHtml(p.id)}" data-field="improve_${escapeHtml(c.id)}" ${(isEditing && needsRevision) ? '' : 'readonly'} placeholder="-" title="${needsRevision ? (isAuto ? autoTitle : '') : 'Only needed when Test Result is Needs Revision'}">${escapeHtml(displayValue)}</textarea></td>`;
        }).join('')}
        <td class="recipe-boundary"><textarea class="teval-criteria-note" data-bucket="criteriaImproveNotes" data-criteria-id="${escapeHtml(c.id)}" ${isEditing ? '' : 'readonly'} placeholder="-">${escapeHtml(improvementCriteriaNotes[c.id] || '')}</textarea></td>
      </tr>
    `).join('');
    // One decision per product -- separate from Test Result (which is a
    // per-evaluator sensory verdict) -- for whoever reviews the
    // Improvement Guidelines above to say whether this specific sample is
    // still worth carrying forward. Only "Continue" gets a product into
    // the Summary Test / Summary Table (see summarizeTrialProduct) --
    // "Discontinue" and not-yet-decided both stay out, so a page that's
    // meant to be a quick read doesn't keep showing samples nobody's
    // pursuing any more.
    const continueDevRowHtml = `
      <tr>
        <td><b>Continue Development?</b></td>
        ${evalTargets.map((p, i) => {
          const pd = getTrialProductData(mt, p.id);
          const val = pd.continueDevelopment || '';
          return `<td class="${i > 0 ? 'recipe-boundary' : ''}">
            <div class="trial-continue-dev-row">
              <button type="button" class="btn btn-sm trial-continue-dev-btn trial-continue-dev-yes${val === 'continue' ? ' selected' : ''}" data-role="continue-dev" data-product-id="${escapeHtml(p.id)}" data-value="continue" ${isEditing ? '' : 'disabled'}>${icon('check', 12)} Continue</button>
              <button type="button" class="btn btn-sm trial-continue-dev-btn trial-continue-dev-no${val === 'discontinue' ? ' selected' : ''}" data-role="continue-dev" data-product-id="${escapeHtml(p.id)}" data-value="discontinue" ${isEditing ? '' : 'disabled'}>${icon('x', 12)} Discontinue</button>
            </div>
          </td>`;
        }).join('')}
        <td class="recipe-boundary"></td>
      </tr>
    `;

    // 220px leading column mirrors the product-card spacer above so the two
    // grids share the same column ruler — rows are fixed now, so no
    // trailing comment/delete columns are needed any more.
    // +1 trailing col for the Note column both tables now share.
    const trialColgroup = `<colgroup><col style="width:220px;">${'<col>'.repeat(evalTargets.length)}<col style="width:180px;"></colgroup>`;

    return `
      <div class="part-block${isExpanded ? '' : ' collapsed'}" data-trial-id="${escapeHtml(t.id)}">
        <div class="part-header" style="margin-bottom:12px;">
          <button type="button" class="part-toggle-btn${isExpanded ? ' open' : ''}" title="Expand / collapse this test">${icon('chevron-right')}</button>
          ${linkedProjectImage ? `<img src="${escapeHtml(linkedProjectImage)}" class="material-thumb" alt="${escapeHtml(linkedProject.name || 'Linked project')}" title="From linked project: ${escapeHtml(linkedProject.name || 'Untitled project')}">` : ''}
          <span style="font-weight:700;font-size:14px;color:var(--primary-dark);">${escapeHtml(productLabel)}</span>
          <span class="part-header-summary">${combinedCount} product${combinedCount === 1 ? '' : 's'}${mt.testDate ? ' · Tested ' + escapeHtml(formatDateLong(mt.testDate)) : ''}</span>
          ${isEditing ? `<button class="btn btn-sm" data-role="save-trial">${icon('save')} Save</button>` : `<button class="btn btn-sm" data-role="edit-trial">${icon('pencil')} Edit</button>`}
          ${combinedCount > 0 ? `<button class="btn btn-sm" data-role="start-evaluation">${icon('clipboard-check')} Perform Evaluation</button>` : ''}
          ${combinedCount > 0 ? `<button class="btn btn-sm" data-role="open-trial-summary">${icon('file-text')} Summary Test</button>` : ''}
          <button class="btn btn-sm" data-role="print-trial">${icon('printer')} Print</button>
          <button class="btn btn-sm btn-danger" data-role="delete-trial">${icon('x')} Delete</button>
        </div>
        <div class="part-body">
          <div class="trial-part-title">Part 1</div>
          <div class="trial-header-row">
            <div class="field" style="margin-bottom:0;">
              <label>Project Name</label>
              ${isEditing
                ? `<select class="proj-select trial-linked-project">
                    <option value="">- Select a project -</option>
                    ${[...projects].sort((a,b) => (a.name||'').localeCompare(b.name||'', undefined, {sensitivity:'base'})).map(p => `<option value="${escapeHtml(p.id)}" ${p.id === mt.linkedProjectId ? 'selected' : ''}>${escapeHtml(p.name || 'Untitled project')}</option>`).join('')}
                  </select>`
                : `<input type="text" value="${escapeHtml(linkedProject?.name || '')}" placeholder="-" readonly>`}
            </div>
            <div class="field" style="margin-bottom:0;">
              <label>Customer</label>
              <input type="text" value="${escapeHtml(linkedProject?.customerName || '')}" placeholder="-" readonly title="Comes from the linked project above">
            </div>
          </div>
          ${linkedProject ? (() => {
            const req = getRequirements(linkedProject);
            return `
          <div class="compare-info-col" style="margin-bottom:16px;">
            <div class="trial-project-summary-grid">
              <div class="ci-row"><b>Destination:</b> ${escapeHtml(linkedProject.destinationCountry || '-')}</div>
              <div class="ci-row"><b>Project Owner:</b> ${escapeHtml(linkedProject.ownerSalesRep || '-')}</div>
              <div class="ci-row"><b>Responsible Person (PD):</b> ${escapeHtml(linkedProject.responsiblePerson || '-')}</div>
              <div class="ci-row"><b>Factory:</b> ${escapeHtml(linkedProject.factoryName || '-')}</div>
            </div>
            ${(() => { const certText = certificateSummaryText(req.certificate); return (req.composition || req.recipe || req.cookingCondition.some(g => g.method || g.steps.length) || req.packagingCondition || certText) ? `
            <div class="trial-project-summary-reqs">
              <div class="trial-project-summary-reqs-title">Requirements</div>
              ${req.composition ? `<div><div class="material-detail-notes-label">Composition</div><div class="material-detail-notes">${escapeHtml(req.composition)}</div></div>` : ''}
              ${req.recipe ? `<div><div class="material-detail-notes-label">Recipe</div><div class="material-detail-notes">${escapeHtml(req.recipe)}</div></div>` : ''}
              ${req.cookingCondition.filter(g => g.method || g.steps.length).map(g => `
              <div>
                <div class="material-detail-notes-label">Cooking Guidelines${g.method ? ` — ${escapeHtml(g.method)}` : ''}</div>
                ${g.steps.length ? `<ol class="cooking-steps-list">${g.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
              </div>
              `).join('')}
              ${req.packagingCondition ? `<div><div class="material-detail-notes-label">Packaging condition</div><div class="material-detail-notes">${escapeHtml(req.packagingCondition)}</div></div>` : ''}
              ${certText ? `<div><div class="material-detail-notes-label">Certificate</div><div class="material-detail-notes">${escapeHtml(certText)}</div></div>` : ''}
            </div>
            ` : ''; })()}
          </div>
          `;
          })() : ''}
          <div class="trial-header-row">
            <div class="field" style="margin-bottom:0;">
              <label>Sample Prepared By</label>
              <input type="text" class="trial-sample-prepared-by" list="salesRepDatalist" value="${escapeHtml(mt.samplePreparedBy)}" placeholder="-" ${isEditing ? '' : 'readonly'}>
            </div>
            <div class="field" style="margin-bottom:0;">
              <label>Test Date</label>
              <input type="date" class="trial-test-date" value="${escapeHtml(mt.testDate)}" ${isEditing ? '' : 'readonly'}>
            </div>
          </div>
          <div class="field" style="margin-bottom:0;margin-top:12px;">
            <label>Test Location</label>
            <input type="text" class="trial-test-location" list="customerDatalist" value="${escapeHtml(mt.testLocation)}" placeholder="-" ${isEditing ? '' : 'readonly'}>
          </div>
          <div class="field" style="margin-bottom:0;margin-top:12px;">
            <label>Test Participants</label>
            ${trialStringListHtml(mt.testParticipants, isEditing, 'trial-participant-input', 'test-participant', 'e.g. Yano-san', 'salesRepDatalist')}
          </div>
          <div class="trial-part2-box">
            <div class="trial-part-title">Part 2</div>
            <div class="field">
              <label>Cooking Method</label>
              <input type="text" class="trial-cooking-method" list="cookingMethodDatalist" value="${escapeHtml(mt.cookingMethod)}" placeholder="e.g. Microwave" ${isEditing ? '' : 'readonly'}>
              <div style="margin-top:8px;">
                ${trialStringListHtml(mt.cookingMethodSteps, isEditing, 'trial-cooking-step-input', 'cooking-step', 'e.g. Deep Fry 170°C, 5 Mins.')}
              </div>
            </div>
            <div class="field">
              <label>Products Being Compared (up to ${TRIAL_MAX_PRODUCTS})</label>
              ${productCardsGrid}
              ${isEditing ? `
                <div class="project-add-row" style="margin-top:12px;">
                  <select class="trial-add-recipe-select" ${atMax ? 'disabled' : ''}>
                    <option value="">${atMax ? `Maximum ${TRIAL_MAX_PRODUCTS} products reached` : (availableRecipes.length ? 'Select a product to add...' : 'No more recipes available')}</option>
                    ${availableRecipes.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(recipeDisplayLabel(r))}</option>`).join('')}
                  </select>
                  <button class="btn btn-sm" data-role="add-trial-recipe" ${atMax ? 'disabled' : ''}>+ Add</button>
                </div>
                <div class="project-add-row" style="margin-top:8px;">
                  <input type="text" class="trial-add-manual-input" placeholder="Or type a product name manually (e.g. a competitor sample)..." maxlength="120" ${atMax ? 'disabled' : ''}>
                  <button class="btn btn-sm" data-role="add-trial-manual" ${atMax ? 'disabled' : ''}>+ Add</button>
                </div>
              ` : ''}
            </div>
            ${activity.length ? `<div class="reflist-item-meta" style="margin:10px 0;">${activity.join(' &nbsp;|&nbsp; ')}</div>` : ''}

            <div class="field">
              <label>Sensory Evaluation</label>
              ${evalTargets.length ? `
              <div style="overflow-x:auto;">
                <table class="compare-table">
                  ${trialColgroup}
                  <thead><tr><th>Criteria</th>${evalHeaderCells}<th class="recipe-boundary">Note</th></tr></thead>
                  <tbody>${fixedCriteriaRowsHtml}${testResultRowHtml}${commentsRowHtml}</tbody>
                </table>
              </div>
              ${addCriteriaBtnHtml}
              ` : '<div class="overview-empty">Add a product above first</div>'}
            </div>

            <div class="field">
              <label>Improvement Guidelines</label>
              ${evalTargets.length ? `
              <div style="overflow-x:auto;">
                <table class="compare-table">
                  ${trialColgroup}
                  <thead><tr><th>Criteria</th>${improvementHeaderCells}<th class="recipe-boundary">Note<span class="teval-header-hint">Enter your own info (ระบุข้อมูลด้วยตัวเอง)</span></th></tr></thead>
                  <tbody>${improvementRowsHtml}${continueDevRowHtml}</tbody>
                </table>
              </div>
              ` : '<div class="overview-empty">Add a product above first</div>'}
            </div>

            <div class="field" style="margin-bottom:0;">
              <label>Note</label>
              <textarea class="trial-part2-note" ${isEditing ? '' : 'readonly'} placeholder="Anything else worth noting">${escapeHtml(mt.note)}</textarea>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.part-block[data-trial-id]').forEach(block => {
    const id = block.dataset.trialId;
    const t = trials.find(x => x.id === id);
    if(!t) return;
    const isEditing = id === trialEditingId;

    block.querySelector('.part-toggle-btn').addEventListener('click', () => {
      if(trialExpandedIds.has(id)) trialExpandedIds.delete(id);
      else trialExpandedIds.add(id);
      renderTrialsList();
    });

    if(isEditing){
      block.querySelector('[data-role="save-trial"]')?.addEventListener('click', () => {
        trialEditingId = null;
        logActivityEvent('updated', 'trial', trialLabel(t), diffMainFields(trialEditSnapshotBefore, { label: trialLabel(t) }, TRIAL_DIFF_FIELDS));
        trialEditSnapshotBefore = null;
        renderTrialsList();
      });
    }else{
      block.querySelector('[data-role="edit-trial"]')?.addEventListener('click', () => {
        trialEditingId = id;
        trialExpandedIds.add(id);
        trialEditSnapshotBefore = { label: trialLabel(t) };
        renderTrialsList();
      });
    }

    block.querySelector('[data-role="start-evaluation"]')?.addEventListener('click', () => {
      if(!currentUser?.email) return;
      const productIds = trialEvalTargets(t).map(p => p.id);
      if(!productIds.length) return;
      trialExpandedIds.add(id);
      evalWizard = { trialId: id, step: 0, productIds };
      renderTrialsList();
    });

    block.querySelector('[data-role="open-trial-summary"]')?.addEventListener('click', () => {
      trialSummaryId = id;
      renderTrialsList();
    });

    block.querySelector('[data-role="print-trial"]').addEventListener('click', () => {
      block.classList.add('printing-only');
      const cleanup = () => {
        block.classList.remove('printing-only');
        window.removeEventListener('afterprint', cleanup);
      };
      window.addEventListener('afterprint', cleanup);
      window.print();
    });

    block.querySelector('[data-role="delete-trial"]').addEventListener('click', () => {
      if(!confirm('Delete this test result? This cannot be undone.')) return;
      requestAuthConfirm(
        'Confirm Identity to Delete',
        'Enter your password to delete this test result.',
        () => {
          const deletedLabel = trialLabel(t);
          trials = trials.filter(x => x.id !== t.id);
          moveToTrash('trials', t.id, t, deletedLabel);
          deleteTrialFromCloud(t.id);
          logActivityEvent('deleted', 'trial', deletedLabel);
          renderTrialsList();
        }
      );
    });

    const combinedCountNow = () => (t.recipeIds || []).length + (t.manualProducts || []).length;

    block.querySelectorAll('[data-role="remove-trial-recipe"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const recipeId = btn.dataset.recipeId;
        t.recipeIds = (t.recipeIds || []).filter(x => x !== recipeId);
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });

    const addRecipeSelect = block.querySelector('.trial-add-recipe-select');
    block.querySelector('[data-role="add-trial-recipe"]')?.addEventListener('click', () => {
      const recipeId = addRecipeSelect.value;
      if(!recipeId || combinedCountNow() >= TRIAL_MAX_PRODUCTS) return;
      if(!Array.isArray(t.recipeIds)) t.recipeIds = [];
      t.recipeIds.push(recipeId);
      scheduleTrialSave(t);
      renderTrialsList();
    });

    block.querySelectorAll('[data-role="duplicate-trial-manual"]').forEach(btn => {
      btn.addEventListener('click', () => {
        if(combinedCountNow() >= TRIAL_MAX_PRODUCTS) return;
        const manualId = btn.dataset.manualId;
        const source = (t.manualProducts || []).find(x => x.id === manualId);
        if(!source) return;
        const copy = { ...source, id: uid() };
        if(!Array.isArray(t.manualProducts)) t.manualProducts = [];
        t.manualProducts.push(copy);
        // Photos live in t.productData keyed by product id -- deep-copy them
        // under the new id (with fresh photo ids too) so editing/removing a
        // photo on one copy never touches the other's.
        const sourcePhotos = normalizeTrialPhotos(getTrialProductData(t, manualId));
        if(sourcePhotos.length){
          getTrialProductData(t, copy.id).photos = sourcePhotos.map(p => ({ ...p, id: uid() }));
        }
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });
    block.querySelectorAll('[data-role="remove-trial-manual"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const manualId = btn.dataset.manualId;
        t.manualProducts = (t.manualProducts || []).filter(x => x.id !== manualId);
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });

    const addManualInput = block.querySelector('.trial-add-manual-input');
    const addManualEntry = () => {
      const name = (addManualInput?.value || '').trim();
      if(!name || combinedCountNow() >= TRIAL_MAX_PRODUCTS) return;
      if(!Array.isArray(t.manualProducts)) t.manualProducts = [];
      t.manualProducts.push(blankManualTrialProduct(name));
      scheduleTrialSave(t);
      renderTrialsList();
    };
    block.querySelector('[data-role="add-trial-manual"]')?.addEventListener('click', addManualEntry);
    addManualInput?.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); addManualEntry(); }
    });

    block.querySelectorAll('[data-manual-id]').forEach(card => {
      const manualId = card.dataset.manualId;
      const mp = (t.manualProducts || []).find(x => x.id === manualId);
      if(!mp) return;
      card.querySelectorAll('.tmanual-field').forEach(input => {
        input.addEventListener('change', e => {
          mp[e.target.dataset.field] = e.target.value.trim();
          scheduleTrialSave(t);
        });
      });
    });

    if(isEditing){
      block.querySelector('.trial-linked-project')?.addEventListener('change', e => {
        t.linkedProjectId = e.target.value;
        scheduleTrialSave(t);
        renderTrialsList(); // Customer field derives from the newly-picked project
      });
      block.querySelector('.trial-sample-prepared-by')?.addEventListener('change', e => { t.samplePreparedBy = e.target.value.trim(); scheduleTrialSave(t); });
      block.querySelector('.trial-test-date')?.addEventListener('change', e => { t.testDate = e.target.value; scheduleTrialSave(t); });
      block.querySelector('.trial-test-location')?.addEventListener('change', e => { t.testLocation = e.target.value.trim(); scheduleTrialSave(t); });

      // Picking a Cooking Method that has Steps on file (see Reference
      // Lists) pulls them in as a starting point — same autofill as
      // Projects' own Cooking Condition field — still a plain editable
      // step list afterward, not locked to whatever the reference list
      // says (see the add/remove/edit wiring below).
      block.querySelector('.trial-cooking-method')?.addEventListener('change', e => {
        t.cookingMethod = e.target.value.trim();
        const match = metaLists.cookingMethods.find(m => metaItemName(m) === t.cookingMethod);
        if(match && (match.steps || []).length){
          t.cookingMethodSteps = [...match.steps];
        }
        scheduleTrialSave(t);
        renderTrialsList();
      });
      block.querySelector('.trial-part2-note')?.addEventListener('change', e => {
        t.note = e.target.value.trim();
        scheduleTrialSave(t);
      });

      // Test Participants and Cooking Method are both a plain numbered list
      // of strings — same add/remove/edit wiring, just different field
      // names and data-roles (see trialStringListHtml).
      [
        { field: 'testParticipants', inputClass: 'trial-participant-input', role: 'test-participant' },
        { field: 'cookingMethodSteps', inputClass: 'trial-cooking-step-input', role: 'cooking-step' }
      ].forEach(({ field, inputClass, role }) => {
        block.querySelector(`[data-role="add-${role}"]`)?.addEventListener('click', () => {
          if(!Array.isArray(t[field])) t[field] = [];
          t[field].push('');
          scheduleTrialSave(t);
          renderTrialsList();
        });
        block.querySelectorAll(`[data-role="remove-${role}"]`).forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx, 10);
            if(!Array.isArray(t[field])) return;
            t[field].splice(idx, 1);
            scheduleTrialSave(t);
            renderTrialsList();
          });
        });
        block.querySelectorAll(`.${inputClass}`).forEach((input, idx) => {
          input.addEventListener('change', () => {
            if(!Array.isArray(t[field])) t[field] = [];
            t[field][idx] = input.value.trim();
            scheduleTrialSave(t);
          });
        });
      });
    }

    block.querySelectorAll('.trial-product-photo-input').forEach(input => {
      input.addEventListener('change', async e => {
        const file = e.target.files[0];
        e.target.value = '';
        if(!file) return;
        const pd = getTrialProductData(t, input.dataset.productId);
        const photos = normalizeTrialPhotos(pd);
        if(photos.length >= TRIAL_PHOTO_MAX) return;
        photos.push({ id: uid(), dataUrl: await resizeImageFile(file, 500), caption: file.name });
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });
    block.querySelectorAll('[data-role="remove-trial-photo"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const pd = getTrialProductData(t, btn.dataset.productId);
        const photos = normalizeTrialPhotos(pd);
        const idx = photos.findIndex(p => p.id === btn.dataset.photoId);
        if(idx !== -1) photos.splice(idx, 1);
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });
    block.querySelectorAll('.trial-photo-caption-input').forEach(input => {
      input.addEventListener('change', () => {
        const pd = getTrialProductData(t, input.dataset.productId);
        const photos = normalizeTrialPhotos(pd);
        const photo = photos.find(p => p.id === input.dataset.photoId);
        if(photo) photo.caption = input.value.trim();
        scheduleTrialSave(t);
      });
    });

    block.querySelectorAll('.teval-improve').forEach(el => {
      el.addEventListener('change', () => {
        const pd = getTrialProductData(t, el.dataset.productId);
        pd[el.dataset.field] = el.value.trim();
        scheduleTrialSave(t);
      });
    });
    block.querySelectorAll('.teval-criteria-note').forEach(el => {
      el.addEventListener('change', () => {
        const notes = getCriteriaNotes(t, el.dataset.bucket);
        notes[el.dataset.criteriaId] = el.value.trim();
        scheduleTrialSave(t);
      });
    });
    block.querySelectorAll('[data-role="continue-dev"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const pd = getTrialProductData(t, btn.dataset.productId);
        pd.continueDevelopment = pd.continueDevelopment === btn.dataset.value ? '' : btn.dataset.value;
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });
    block.querySelectorAll('.trial-criteria-label-input').forEach(input => {
      input.addEventListener('change', () => {
        const criteria = getEvaluationCriteria(t);
        const c = criteria.find(x => x.id === input.dataset.criteriaId);
        if(c) c.label = input.value.trim();
        scheduleTrialSave(t);
        renderTrialsList(); // Improvement Guidelines' read-only label mirrors this right away
      });
    });
    block.querySelectorAll('[data-role="remove-trial-criteria"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const criteria = getEvaluationCriteria(t);
        t.evaluationCriteria = criteria.filter(x => x.id !== btn.dataset.criteriaId);
        scheduleTrialSave(t);
        renderTrialsList();
      });
    });
    // Sensory Evaluation and Improvement Guidelines both read the same
    // ordered list (see getEvaluationCriteria), so reordering a row here
    // reorders both tables' rows at once.
    const moveTrialCriteria = (criteriaId, delta) => {
      const criteria = getEvaluationCriteria(t);
      const idx = criteria.findIndex(x => x.id === criteriaId);
      const target = idx + delta;
      if(idx === -1 || target < 0 || target >= criteria.length) return;
      [criteria[idx], criteria[target]] = [criteria[target], criteria[idx]];
      scheduleTrialSave(t);
      renderTrialsList();
    };
    block.querySelectorAll('[data-role="move-trial-criteria-up"]').forEach(btn => {
      btn.addEventListener('click', () => moveTrialCriteria(btn.dataset.criteriaId, -1));
    });
    block.querySelectorAll('[data-role="move-trial-criteria-down"]').forEach(btn => {
      btn.addEventListener('click', () => moveTrialCriteria(btn.dataset.criteriaId, 1));
    });
    const addCriteriaInput = block.querySelector('.trial-add-criteria-input');
    const addCriteriaEntry = explicitLabel => {
      const label = explicitLabel !== undefined ? explicitLabel : (addCriteriaInput?.value || '').trim();
      getEvaluationCriteria(t).push({ id: uid(), label });
      scheduleTrialSave(t);
      renderTrialsList();
    };
    block.querySelector('[data-role="add-trial-criteria"]')?.addEventListener('click', () => addCriteriaEntry());
    addCriteriaInput?.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); addCriteriaEntry(); }
    });
    // Picking an option adds it immediately (no separate "+ Add" click) --
    // same instant-apply feel as a native <select>, then resets back to the
    // placeholder so it's ready to pick another one right after.
    block.querySelector('.trial-criteria-pick-select')?.addEventListener('change', e => {
      if(!e.target.value) return;
      addCriteriaEntry(e.target.value);
      e.target.value = '';
    });
    // Sensory Evaluation/Test Result are filled in through the "Perform
    // Evaluation" wizard now (see renderEvaluationWizard/wireEvaluationWizard),
    // a separate body-appended overlay rather than inline cells here.
  });

  renderEvaluationWizard();
  renderTrialSummaryModal();
}

function attachTrialsListener(){
  unsubscribeTrials = onSnapshot(trialsCol, snapshot => {
    trials = snapshot.docs.map(d => d.data());
    trials.forEach(t => {
      if(!Array.isArray(t.photos)) t.photos = [];
      if(!Array.isArray(t.evaluation)) t.evaluation = [];
    });
    trialsLoaded = true;
    migrateTrialsFromRecipes();
    if(mainFeatureView === 'trials') renderTrialsList();
  }, err => {
    console.error('Forge: trials listener error', err);
    showCloudError('Failed to load test results from Firebase: ' + err.message);
  });
}

// Tears down the trials Firestore listener and resets all Trials state to
// empty — called from the shared sign-out handler in app.js, kept here so
// that handler doesn't need write access to bindings this module owns.
export function resetTrialsState(){
  if(unsubscribeTrials){ unsubscribeTrials(); unsubscribeTrials = null; }
  trialsLoaded = false;
  trialsMigrated = false;
  trials = [];
}

export { trials, trialExpandedIds, unsubscribeTrials, attachTrialsListener };
