// Pure data/model helpers for Test Results (trials) -- no DOM rendering,
// no module-level mutable UI state. Split out of trials.js (which grew
// past 2,600 lines) so both trials.js itself and the wizard/summary/share
// files below share one copy of this logic instead of each needing their
// own. See trials.js's own top-of-file comment for the overall file split.
import {
  recipes, recipeDisplayLabel, uid, currentUser, fullCode, trialsCol
} from './app.js';
import {
  setDoc, doc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const TRIAL_MAX_PRODUCTS = 4;

// A trial has no name of its own — it's a comparison of recipes — so its
// label is just whichever recipes it's comparing, joined together.
export function trialLabel(t){
  return (t.recipeIds || []).map(id => recipes.find(r => r.id === id)).filter(Boolean).map(recipeDisplayLabel).join(', ') || 'Untitled test';
}

export function blankTrial(){
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
export function migrateTrial(t){
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
export function getTrialProductData(t, productId){
  if(!t.productData || typeof t.productData !== 'object') t.productData = {};
  if(!t.productData[productId]) t.productData[productId] = {};
  return t.productData[productId];
}
// Sensory Evaluation and Test Result are personal opinions now -- each
// evaluator's own answers live under pd.evaluations[email], never
// overwriting anyone else's (see the "Perform Evaluation" wiring below).
// Mutates `t`/`pd` in place, same lazy-init shape as getTrialProductData.
export function getMyEvaluation(pd){
  if(!currentUser?.email) return {};
  if(!pd.evaluations || typeof pd.evaluations !== 'object') pd.evaluations = {};
  if(!pd.evaluations[currentUser.email]) pd.evaluations[currentUser.email] = {};
  return pd.evaluations[currentUser.email];
}
// Per request, Comments is now one shared remark per evaluator covering
// the whole test (every product), not a separate one per product -- lives
// at the trial level (sibling to productData), same lazy-init shape as
// getMyEvaluation just above, just keyed straight by email since there's
// no per-product dimension to it any more.
export function getMyEvaluatorComment(t){
  if(!currentUser?.email) return '';
  if(!t.evaluatorComments || typeof t.evaluatorComments !== 'object') t.evaluatorComments = {};
  return t.evaluatorComments[currentUser.email] || '';
}
// Optional reference photos to go with the comment above -- e.g. a
// competitor sample or something else worth pointing at -- same one-set-
// per-evaluator-per-trial shape, capped at EVAL_COMMENT_PHOTO_MAX.
export const EVAL_COMMENT_PHOTO_MAX = 2;
export function getMyEvaluatorPhotos(t){
  if(!currentUser?.email) return [];
  if(!t.evaluatorPhotos || typeof t.evaluatorPhotos !== 'object') t.evaluatorPhotos = {};
  if(!Array.isArray(t.evaluatorPhotos[currentUser.email])) t.evaluatorPhotos[currentUser.email] = [];
  return t.evaluatorPhotos[currentUser.email];
}
// One { who, value } per person who has weighed in on this product's
// given criteria (or Test Result, when criteriaId is null) -- feeds the
// combined "Overall" view. A trial saved before this feature has its
// Sensory Evaluation/Test Result as a flat pd[criteriaId]/pd.testResult
// value instead of pd.evaluations -- rather than silently dropping that
// history, it's folded in as one more entry (attributed to whoever the
// trial's updatedBy was, the closest thing to "who" that data has)
// unless a real evaluator already recorded the exact same value.
export function combinedEvaluationEntries(pd, criteriaId, legacyAttributedTo){
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
export function shortEvaluatorName(who){
  return (who || '').split('@')[0] || who || 'Unspecified';
}
// Improvement Guidelines gates on whether *anyone* flagged Needs Revision
// now that Test Result is per-evaluator -- one taster catching a problem
// is enough to need an improvement note, even if others accepted it.
export function productNeedsRevision(pd){
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
export function getCriteriaNotes(t, bucket){
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
export const TRIAL_PHOTO_MAX = 4;
export function normalizeTrialPhotos(pd){
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
export function blankEvaluationCriteria(){
  return [
    { id: 'appearanceInterior', label: 'Appearance' },
    { id: 'odor', label: 'Odor' },
    { id: 'taste', label: 'Taste' },
    { id: 'texture', label: 'Texture' }
  ];
}
export function getEvaluationCriteria(t){
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
export const LEGACY_IMPROVEMENT_KEYS = { appearanceInterior: 'improveAppearanceInterior', odor: 'improveOdor', texture: 'improveTexture' };
export function improvementFieldValue(pd, criteriaId){
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
export function criteriaAverageJarScore(c, pd){
  const entries = combinedEvaluationEntries(pd, c.id, null);
  const nums = entries.map(e => parseInt(e.value, 10)).filter(n => n >= 1 && n <= JAR_SCALE.length);
  if(!nums.length) return null;
  return Math.round(nums.reduce((s,n)=>s+n,0) / nums.length);
}
export function autoImprovementSuggestion(c, pd){
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
export const TRIAL_TEST_RESULT_OPTIONS = ['Accepted', 'Not accepted', 'Needs Revision'];
export const TRIAL_TEST_RESULT_CLASSES = {
  'Accepted': 'trial-result-accepted',
  'Needs Revision': 'trial-result-needs-revision',
  'Not accepted': 'trial-result-not-accepted'
};
// Wizard buttons need their own selected-state coloring (not the light-
// theme .trial-result-* chip classes above, whose padding/margin are tuned
// for the small Overall-view chips, not a full-width dark button).
export const EVAL_WIZARD_RESULT_CLASSES = {
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
export const JAR_SCALE = [
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
export function jarScoreLabel(value){
  const found = JAR_SCALE.find(s => s.value === value);
  return found ? found.label : (value || '');
}
// A legacy free-text answer (from before this JAR redesign) shows as-is
// rather than crashing on the "N/9" format.
export function jarScoreDisplay(value){
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
export function jarAdjustmentPercent(value){
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
export function trialEvalTargets(t){
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
export function registerEvaluationParticipant(t){
  if(!currentUser?.email) return;
  if(!Array.isArray(t.testParticipants)) t.testParticipants = [];
  const already = t.testParticipants.some(name => name === currentUser.email || name === shortEvaluatorName(currentUser.email));
  if(!already) t.testParticipants.push(shortEvaluatorName(currentUser.email));
}

// Combines every evaluator's Test Result answers for a product into one
// headline verdict -- Needs Revision if even one flagged it (same "one
// taster's catch is enough" rule as productNeedsRevision), Accepted only
// if every answer that exists agrees, Not accepted if any answer does
// and none needed revision, or null if nobody's answered yet at all.
export function combinedVerdict(pd){
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
export const TRIAL_SUMMARY_VERDICT_CLASSES = {
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
export function summarizeTrialProduct(t, criteria, p){
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
// shared project to group them by). Shared by the Summary Table below and
// the List view's own card layout (see renderTrialsList) -- both group the
// same already-recency-sorted input the same way, so a project's tests
// stay together and in the same order regardless of which view is active.
export function groupTrialsByProject(sortedTrials){
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
  return groups;
}

// A product being compared that isn't one of this app's own Recipes — a
// competitor sample, a customer's existing product, anything typed in by
// name rather than picked from the list. Same detail fields as a linked
// Recipe's card (see the compare-info-col markup below) but hand-typed
// instead of pulled from the recipe/project record.
export function blankManualTrialProduct(name){
  return { id: uid(), name: (name || '').trim(), code: '', date: '', totalWeight: '', customer: '', destination: '', owner: '', stage: '' };
}

export function saveTrialToCloud(t){
  return setDoc(doc(trialsCol, t.id), t);
}
export function scheduleTrialSave(t){
  t.updatedAt = Date.now();
  t.updatedBy = currentUser?.email || '';
  saveTrialToCloud(t);
}

// Same pattern as Recipes' Note/Description translate button (see
// guessRecipeTranslateTargetLang/translateRecipeText/wireRecipeTranslateButton
// in recipes.js, itself copied from Projects' Activities Updates) -- free,
// keyless machine translation via the same public endpoint
// translate.google.com's own web page calls (client=gtx), an unofficial use
// of it so it could be rate-limited or blocked without notice. Kept as its
// own copy here rather than imported, since trials.js doesn't otherwise
// depend on recipes.js/projects.js internals -- if this ever needs to
// change, the same edit has to be made in all three places. Used both by
// the "Perform Evaluation" wizard and by the main trial card's own
// criteria-note fields, so it lives here rather than in trials-wizard.js.
export function guessTrialTranslateTargetLang(text){
  return /[฀-๿]/.test(text) ? 'en' : 'th';
}
export async function translateTrialText(text, targetLang){
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Translation service unavailable');
  const data = await res.json();
  return data[0].map(chunk => chunk[0]).join('');
}
// Puts the translated text first with the original following in
// parentheses, replacing the field's own content. Dispatches a real
// 'change' event (not 'input') after setting the value, since the criteria
// note textarea this wraps only saves on 'change' (see
// .eval-wizard-criteria-note's own listener above), not on every keystroke.
export function wireTrialTranslateButton(wrapEl){
  const textarea = wrapEl.querySelector('textarea');
  const btn = wrapEl.querySelector('.mu-translate-btn');
  if(!textarea || !btn) return;
  btn.addEventListener('click', async () => {
    const original = textarea.value.trim();
    if(!original) return;
    btn.classList.add('loading');
    try{
      const translated = await translateTrialText(original, guessTrialTranslateTargetLang(original));
      textarea.value = `${translated}\n(${original})`;
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }catch(err){
      console.error('Forge: translation failed', err);
      alert('Translation failed — the free translation service may be temporarily unavailable. Please try again in a moment.');
    }finally{
      btn.classList.remove('loading');
    }
  });
}
