// "Share External Evaluation" -- a no-login link/QR that lets someone
// outside the org submit a Perform-Evaluation-shaped survey for one trial
// from their own phone, without an account -- plus the team-side guest
// response list (Import/Dismiss/Undismiss/Remove Imported) and the guest
// response preview/edit modal. Split out of trials.js (which grew past
// 2,600 lines) -- see trials.js's own top-of-file comment for the overall
// file split.
import {
  icon, escapeHtml, uid, currentUser, resizeImageFile, formatActivityDateTime,
  requestAuthConfirm, showCloudError, evaluationLinksCol, evaluationResponsesCol,
  mainFeatureView
} from './app.js';
import {
  setDoc, doc, deleteDoc, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  trialLabel, getEvaluationCriteria, trialEvalTargets, getTrialProductData,
  normalizeTrialPhotos, scheduleTrialSave, JAR_SCALE, jarScoreLabel,
  EVAL_WIZARD_RESULT_CLASSES, TRIAL_TEST_RESULT_OPTIONS, EVAL_COMMENT_PHOTO_MAX
} from './trials-data.js';
// Circular import back to core trials.js -- safe, see trials-wizard.js's
// own comment on this same pattern.
import { trials, renderTrialsList } from './trials.js';

// Holds the trial id while "Share External Evaluation" is open, null when
// closed; trialShareResponses is that trial's guest submissions, fetched
// fresh (not a live listener) each time the modal opens or "Refresh" is
// clicked -- see loadShareResponses.
let trialShareId = null;
let trialShareResponses = [];
const EVAL_LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;

// Opens the Share External Evaluation modal for a trial -- replaces
// trials.js's old inline `trialShareId = id; trialShareResponses = [];`
// block, since an imported `let` binding is read-only to importers in ES
// modules. Keeps the exact same follow-up sequence the old inline handler
// used.
export async function openTrialShareModal(trialId){
  trialShareId = trialId;
  trialShareResponses = [];
  renderTrialsList();
  await loadShareResponses(trialId);
  renderTrialShareModal();
}

// Same 192-bit CSPRNG token shape as submit.js's own generateToken (the
// public "share a link" project intake page) -- not derivable/enumerable,
// so the token itself (not a login) is what Firestore's rules use to scope
// access to exactly one trial's evaluationLinks doc. Kept as its own copy
// here for the same "these two public-link pages don't import each other"
// reason as every other duplicated helper in this file.
function generateShareToken(){
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function evaluateShareUrl(shareToken){
  return `${location.origin}/evaluate.html?token=${shareToken}`;
}
// Mints a fresh evaluationLinks doc holding a read-only SNAPSHOT of exactly
// what a guest evaluator needs (product list + photos + criteria) -- never
// a reference to the live /trials doc, see the firestore.rules comment on
// /evaluationLinks for why. The trial itself only remembers the token/
// expiry (t.shareToken/t.shareExpiresAt) so this panel can tell at a
// glance whether a link is still live without an extra query -- generating
// a new one simply overwrites those two fields; the old evaluationLinks
// doc is left alone and just quietly expires on its own.
async function generateShareLink(t){
  const shareToken = generateShareToken();
  const criteria = getEvaluationCriteria(t);
  const products = trialEvalTargets(t).map(p => ({
    id: p.id,
    label: p.label,
    photos: normalizeTrialPhotos(getTrialProductData(t, p.id)).map(ph => ({ dataUrl: ph.dataUrl, caption: ph.caption || '' }))
  }));
  const createdAt = Date.now();
  const expiresAt = createdAt + EVAL_LINK_LIFETIME_MS;
  try{
    await setDoc(doc(evaluationLinksCol, shareToken), {
      trialId: t.id,
      createdAt,
      expiresAt,
      createdBy: currentUser?.email || '',
      trialLabel: trialLabel(t),
      testDate: t.testDate || '',
      products,
      criteria: criteria.map(c => ({ id: c.id, label: c.label }))
    });
  }catch(err){
    console.error('Forge: failed to create share link', err);
    showCloudError('Failed to create the share link: ' + err.message);
    return;
  }
  // Best-effort: clean up the PREVIOUS link's own doc now that this trial
  // no longer points to it, so repeatedly regenerating doesn't leave a
  // trail of dead evaluationLinks docs behind forever. Only when it's
  // already expired, though -- a guest could still have that old link/QR
  // open mid-submission right up until its own real expiry, and deleting
  // it out from under them here would break a perfectly legitimate
  // in-flight submission that has nothing to do with this regenerate.
  // (Their /evaluationResponses aren't affected either way -- Import/
  // Dismiss/Preview all look them up by trialId, never by linkToken.)
  const oldToken = t.shareToken;
  const oldExpired = t.shareExpiresAt && t.shareExpiresAt <= Date.now();
  t.shareToken = shareToken;
  t.shareExpiresAt = expiresAt;
  scheduleTrialSave(t);
  if(oldToken && oldExpired){
    try{
      await deleteDoc(doc(evaluationLinksCol, oldToken));
    }catch(err){
      console.error('Forge: failed to delete previous share link', err);
    }
  }
}
// Fetched fresh (not a live listener) each time the modal opens or
// "Refresh" is clicked -- a guest survey isn't the kind of thing someone's
// expected to watch update in real time the way the rest of this app does,
// and a plain getDocs keeps this panel from needing its own listener
// teardown when the modal closes.
async function loadShareResponses(trialId){
  try{
    const snap = await getDocs(query(evaluationResponsesCol, where('trialId', '==', trialId)));
    trialShareResponses = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
  }catch(err){
    console.error('Forge: failed to load guest evaluation responses', err);
    showCloudError('Failed to load guest responses from Firebase: ' + err.message);
  }
}
// Folds one guest response into the trial's own data the exact same shape
// a real evaluator's answers take (pd.evaluations[someKey]) -- so every
// existing reader (combinedEvaluationEntries, criteriaAverageJarScore,
// combinedVerdict, the Summary Test/Table) picks it up automatically with
// no changes of its own, the same way it already handles any number of
// real evaluators. Keyed "guest:<name>:<responseId>" rather than an email
// so it reads clearly as an outside opinion wherever evaluator names show
// up. Marks the response imported (both locally and in Firestore) so
// re-opening this panel doesn't offer to import the same answers twice.
async function importShareResponse(t, resp){
  const guestKey = `guest:${resp.guestName || 'Guest'}:${resp.id}`;
  Object.entries(resp.answers || {}).forEach(([productId, answers]) => {
    const target = trialEvalTargets(t).find(p => p.id === productId);
    if(!target) return;
    const pd = getTrialProductData(t, productId);
    if(!pd.evaluations || typeof pd.evaluations !== 'object') pd.evaluations = {};
    pd.evaluations[guestKey] = answers;
  });
  // Comments + reference photo are the guest's own overall remark about
  // the whole test (see evaluate.js's Review page), same one-per-
  // evaluator shape real evaluators' answers take (t.evaluatorComments/
  // evaluatorPhotos) -- imported under the same guestKey as their scores
  // above so both end up attributed to the same "who" in the Comments
  // block.
  if((resp.comment || '').trim()){
    if(!t.evaluatorComments || typeof t.evaluatorComments !== 'object') t.evaluatorComments = {};
    t.evaluatorComments[guestKey] = resp.comment.trim();
  }
  if((resp.photos || []).length){
    if(!t.evaluatorPhotos || typeof t.evaluatorPhotos !== 'object') t.evaluatorPhotos = {};
    t.evaluatorPhotos[guestKey] = resp.photos;
  }
  scheduleTrialSave(t);
  try{
    await setDoc(doc(evaluationResponsesCol, resp.id), { imported: true }, { merge: true });
  }catch(err){
    console.error('Forge: failed to mark guest response as imported', err);
    showCloudError('The response was imported into this test, but could not be marked as imported in Firebase (it may look importable again next time): ' + err.message);
  }
  resp.imported = true;
  loadSharePendingCounts();
  renderTrialsList();
}
// Undoes an Import -- the exact reverse of importShareResponse above,
// deleting the same guestKey entries it wrote (per-product
// pd.evaluations, plus the trial-level evaluatorComments/evaluatorPhotos)
// so this response's scores/comment/photo stop counting toward the test's
// real results. The response itself and everything it holds is untouched
// (imported flips back to false in Firestore, so it reappears as pending
// -- offering Import again or Dismiss instead). Gated behind the same
// password re-entry as Undismiss, since this removes data that may
// already be reflected in Improvement Guidelines/Summary elsewhere.
async function removeImportedResponse(t, resp){
  const guestKey = `guest:${resp.guestName || 'Guest'}:${resp.id}`;
  Object.keys(resp.answers || {}).forEach(productId => {
    const pd = getTrialProductData(t, productId);
    if(pd.evaluations && typeof pd.evaluations === 'object') delete pd.evaluations[guestKey];
  });
  if(t.evaluatorComments && typeof t.evaluatorComments === 'object') delete t.evaluatorComments[guestKey];
  if(t.evaluatorPhotos && typeof t.evaluatorPhotos === 'object') delete t.evaluatorPhotos[guestKey];
  scheduleTrialSave(t);
  try{
    await setDoc(doc(evaluationResponsesCol, resp.id), { imported: false }, { merge: true });
  }catch(err){
    console.error('Forge: failed to mark guest response as no longer imported', err);
    showCloudError('The response was removed from this test\'s results, but could not be updated in Firebase (it may still show as Imported next time): ' + err.message);
  }
  resp.imported = false;
  loadSharePendingCounts();
  renderTrialsList();
}
// "Skip this one" -- keeps the response (and everything in it) exactly as
// submitted, just stops it from counting toward the pending badge or
// offering an Import button, for a response nobody's going to want folded
// into this test's real scores (spam, a duplicate, clearly the wrong
// test). Never deletes anything, so it's always still visible via Preview
// if someone needs to double-check that call later.
async function dismissShareResponse(resp){
  try{
    await setDoc(doc(evaluationResponsesCol, resp.id), { dismissed: true }, { merge: true });
  }catch(err){
    console.error('Forge: failed to dismiss guest response', err);
    showCloudError('Failed to dismiss this response: ' + err.message);
    return;
  }
  resp.dismissed = true;
  loadSharePendingCounts();
}
// Undoes a Dismiss -- gated behind the same password re-entry as deleting
// a trial (see requestAuthConfirm at the "Dismissed" button's own click
// handler below), since restoring one back to "pending" is the one action
// here that puts it back in front of Import, where a moment's carelessness
// could fold something that was deliberately excluded into the test's real
// scores.
async function undismissShareResponse(resp){
  try{
    await setDoc(doc(evaluationResponsesCol, resp.id), { dismissed: false }, { merge: true });
  }catch(err){
    console.error('Forge: failed to restore dismissed guest response', err);
    showCloudError('Failed to restore this response: ' + err.message);
    return;
  }
  resp.dismissed = false;
  loadSharePendingCounts();
}
// One trialId -> count of guest responses still awaiting a decision
// (neither imported nor dismissed), shown as a small badge on each row's
// own "Share External Evaluation" button so a pending response is
// noticeable without opening every trial's panel to check. Loaded once via
// a single query (not one query per trial) whenever Test Results is
// mounted, and refreshed after any Import/Dismiss action changes the
// count -- not a live listener, so a response submitted while this page is
// already open won't bump the badge until the page is revisited or an
// action here triggers a refresh; acceptable for what's meant as a "check
// when you're back in the app" nudge, not a push notification.
export let trialSharePendingCounts = {};
export async function loadSharePendingCounts(){
  try{
    const snap = await getDocs(query(evaluationResponsesCol, where('imported', '==', false)));
    const counts = {};
    snap.docs.forEach(d => {
      const data = d.data();
      if(data.dismissed) return;
      counts[data.trialId] = (counts[data.trialId] || 0) + 1;
    });
    trialSharePendingCounts = counts;
  }catch(err){
    console.error('Forge: failed to load pending guest response counts', err);
  }
  if(mainFeatureView === 'trials') renderTrialsList();
}
function renderTrialShareModal(){
  const existing = document.getElementById('trialShareOverlay');
  if(!trialShareId){ existing?.remove(); return; }
  const t = trials.find(x => x.id === trialShareId);
  if(!t){ trialShareId = null; existing?.remove(); return; }

  const overlay = existing || document.createElement('div');
  overlay.id = 'trialShareOverlay';
  overlay.className = 'eval-wizard-overlay';
  if(!existing){
    document.body.appendChild(overlay);
    // Read-only/link-management content, same click-outside-closes shape
    // as the Summary Test modal above (nothing here can be lost by an
    // accidental close -- Refresh just re-fetches).
    let mousedownOnOverlay = false;
    overlay.addEventListener('mousedown', e => { mousedownOnOverlay = e.target === overlay; });
    overlay.addEventListener('click', e => {
      if(mousedownOnOverlay && e.target === overlay){ trialShareId = null; renderTrialShareModal(); }
      mousedownOnOverlay = false;
    });
  }

  const hasActiveLink = t.shareToken && t.shareExpiresAt > Date.now();
  const shareUrl = hasActiveLink ? evaluateShareUrl(t.shareToken) : '';

  overlay.innerHTML = `
    <div class="eval-wizard-card">
      <div class="eval-wizard-header">
        <div class="eval-wizard-title">Forge · Share External Evaluation</div>
        <button type="button" class="eval-wizard-close" data-role="share-close" title="Close">${icon('x')}</button>
      </div>
      <div class="trial-share-intro">Anyone with this link or QR code can submit a sensory evaluation for this test from their own phone — no Forge account needed. It works for 24 hours from when it's generated, and any number of people can use it at once, each landing on their own independent response.</div>
      ${hasActiveLink ? `
        <div class="trial-share-link-box">
          <div class="trial-share-qr" id="trialShareQr"></div>
          <div class="trial-share-link-details">
            <div class="trial-share-link-url">${escapeHtml(shareUrl)}</div>
            <div class="trial-share-actions-row">
              <button type="button" class="btn btn-sm" data-role="copy-share-link">${icon('copy', 14)} Copy Link</button>
              <button type="button" class="btn btn-sm" data-role="generate-share-link">${icon('refresh-cw', 14)} Generate New Link</button>
            </div>
            <div class="trial-share-expiry">Expires ${escapeHtml(formatActivityDateTime(t.shareExpiresAt))}</div>
          </div>
        </div>
      ` : `
        <button type="button" class="btn btn-primary btn-sm" data-role="generate-share-link">${icon('share-2', 14)} Generate Link</button>
        ${t.shareToken ? '<div class="trial-share-expiry">The previous link has expired.</div>' : ''}
      `}
      <div class="trial-share-responses">
        <div class="trial-share-responses-head">
          <div class="trial-share-responses-title">Guest Responses (${trialShareResponses.length})</div>
          <button type="button" class="btn btn-sm" data-role="refresh-share-responses">${icon('refresh-cw', 14)} Refresh</button>
        </div>
        ${trialShareResponses.length === 0 ? '<div class="overview-empty">No responses yet.</div>' : trialShareResponses.map(resp => `
          <div class="trial-share-response-row">
            <div class="trial-share-response-main">
              <b>${escapeHtml(resp.guestName || 'Guest')}</b>
              <span class="trial-share-response-meta">${resp.submittedAt ? escapeHtml(formatActivityDateTime(resp.submittedAt)) : ''}</span>
            </div>
            <div class="trial-share-response-actions">
              <button type="button" class="btn btn-sm" data-role="preview-share-response" data-response-id="${escapeHtml(resp.id)}">${icon('eye', 14)} Preview</button>
              ${resp.imported
                ? `<button type="button" class="btn btn-sm trial-share-response-imported" data-role="remove-imported-response" data-response-id="${escapeHtml(resp.id)}" title="Click to remove this response's data from the test results (asks for your password first)">${icon('check', 14)} Imported</button>`
                : resp.dismissed
                  ? `<button type="button" class="btn btn-sm trial-share-response-dismissed" data-role="undismiss-share-response" data-response-id="${escapeHtml(resp.id)}" title="Click to un-dismiss (asks for your password first)">${icon('eye-off', 14)} Dismissed</button>`
                  : `
                    <button type="button" class="btn btn-sm" data-role="dismiss-share-response" data-response-id="${escapeHtml(resp.id)}" title="Keep the response, but stop offering to import it">${icon('eye-off', 14)} Dismiss</button>
                    <button type="button" class="btn btn-sm" data-role="import-share-response" data-response-id="${escapeHtml(resp.id)}">Import</button>
                  `}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  if(hasActiveLink){
    const qrEl = document.getElementById('trialShareQr');
    if(qrEl && window.QRCode) new window.QRCode(qrEl, { text: shareUrl, width: 160, height: 160 });
  }

  overlay.querySelector('[data-role="share-close"]')?.addEventListener('click', () => {
    trialShareId = null;
    renderTrialShareModal();
    renderShareResponsePreviewModal();
  });
  overlay.querySelector('[data-role="copy-share-link"]')?.addEventListener('click', async () => {
    try{ await navigator.clipboard.writeText(shareUrl); }catch{}
  });
  overlay.querySelector('[data-role="generate-share-link"]')?.addEventListener('click', async e => {
    e.target.disabled = true;
    await generateShareLink(t);
    renderTrialsList();
  });
  overlay.querySelector('[data-role="refresh-share-responses"]')?.addEventListener('click', async () => {
    await loadShareResponses(t.id);
    renderTrialShareModal();
  });
  overlay.querySelectorAll('[data-role="import-share-response"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const resp = trialShareResponses.find(r => r.id === btn.dataset.responseId);
      if(resp) await importShareResponse(t, resp);
      renderTrialShareModal();
    });
  });
  overlay.querySelectorAll('[data-role="dismiss-share-response"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const resp = trialShareResponses.find(r => r.id === btn.dataset.responseId);
      if(resp) await dismissShareResponse(resp);
      renderTrialShareModal();
    });
  });
  overlay.querySelectorAll('[data-role="undismiss-share-response"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const resp = trialShareResponses.find(r => r.id === btn.dataset.responseId);
      if(!resp) return;
      requestAuthConfirm(
        'Confirm Identity to Undismiss',
        'Enter your password to bring this response back as pending (so it offers Import again).',
        async () => {
          await undismissShareResponse(resp);
          renderTrialShareModal();
        }
      );
    });
  });
  overlay.querySelectorAll('[data-role="remove-imported-response"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const resp = trialShareResponses.find(r => r.id === btn.dataset.responseId);
      if(!resp) return;
      requestAuthConfirm(
        'Confirm Identity to Remove',
        'Enter your password to remove this response\'s scores/comment/photo from this test\'s results (the response itself is kept, and can be imported again).',
        async () => {
          await removeImportedResponse(t, resp);
          renderTrialShareModal();
        }
      );
    });
  });
  overlay.querySelectorAll('[data-role="preview-share-response"]').forEach(btn => {
    btn.addEventListener('click', () => {
      trialSharePreviewId = btn.dataset.responseId;
      trialSharePreviewEditing = false;
      renderShareResponsePreviewModal();
    });
  });
}
export { renderTrialShareModal };

// Read-only by default, an Edit button switches every JAR/note/Comments/
// Test Result field to the exact same interactive markup the real Perform
// Evaluation wizard uses (see renderEvalWizardStep) -- Save writes the
// edited answers back onto this one evaluationResponses doc, so a typo or
// a stray tap a guest made on their phone can be fixed before Import folds
// it into the test's real Sensory Evaluation. Edits the response in place;
// doesn't touch pd.evaluations at all until Import is actually clicked.
let trialSharePreviewId = null;
let trialSharePreviewEditing = false;
function renderShareResponsePreviewModal(){
  const existing = document.getElementById('shareResponsePreviewOverlay');
  if(!trialSharePreviewId){ existing?.remove(); return; }
  const t = trials.find(x => x.id === trialShareId);
  const resp = trialShareResponses.find(r => r.id === trialSharePreviewId);
  if(!t || !resp){ trialSharePreviewId = null; trialSharePreviewEditing = false; existing?.remove(); return; }
  const criteria = getEvaluationCriteria(t);
  const isEditing = trialSharePreviewEditing;

  const overlay = existing || document.createElement('div');
  overlay.id = 'shareResponsePreviewOverlay';
  overlay.className = 'eval-wizard-overlay';
  if(!existing){
    document.body.appendChild(overlay);
    let mousedownOnOverlay = false;
    overlay.addEventListener('mousedown', e => { mousedownOnOverlay = e.target === overlay; });
    overlay.addEventListener('click', e => {
      if(mousedownOnOverlay && e.target === overlay){ trialSharePreviewId = null; trialSharePreviewEditing = false; renderShareResponsePreviewModal(); }
      mousedownOnOverlay = false;
    });
  }

  const productRowsHtml = Object.entries(resp.answers || {}).map(([productId, ans]) => {
    const product = trialEvalTargets(t).find(p => p.id === productId);
    const label = product ? product.label : 'Unknown product (no longer on this test)';
    return `
      <div class="eval-wizard-product-name">${escapeHtml(label)}</div>
      ${criteria.map(c => `
        <div class="eval-wizard-question">
          <div class="eval-wizard-question-label">${escapeHtml(c.label)} <span class="eval-wizard-jar-caption">${ans[c.id] ? escapeHtml(jarScoreLabel(ans[c.id])) : 'Not answered'}</span></div>
          <div class="eval-wizard-jar-row">
            ${JAR_SCALE.map(s => `<button type="button" class="eval-wizard-jar-btn${ans[c.id] === s.value ? ' selected' : ''}" data-role="preview-jar" data-product-id="${escapeHtml(productId)}" data-criteria-id="${escapeHtml(c.id)}" data-value="${s.value}" ${isEditing ? '' : 'disabled'}>${s.value}</button>`).join('')}
          </div>
          <textarea class="eval-wizard-criteria-note" data-role="preview-note" data-product-id="${escapeHtml(productId)}" data-criteria-id="${escapeHtml(c.id)}" ${isEditing ? '' : 'readonly'} placeholder="Note for ${escapeHtml(c.label)} (optional)">${escapeHtml(ans[`${c.id}_note`] || '')}</textarea>
        </div>
      `).join('')}
      <div class="eval-wizard-question">
        <div class="eval-wizard-question-label">Test Result</div>
        <div class="eval-wizard-testresult-row">
          ${TRIAL_TEST_RESULT_OPTIONS.map(o => `<button type="button" class="eval-wizard-testresult-btn${ans.testResult === o ? ' selected ' + (EVAL_WIZARD_RESULT_CLASSES[o] || '') : ''}" data-role="preview-testresult" data-product-id="${escapeHtml(productId)}" data-value="${escapeHtml(o)}" ${isEditing ? '' : 'disabled'}>${escapeHtml(o)}</button>`).join('')}
        </div>
      </div>
    `;
  }).join('');

  // Comments + reference photo are one shared thing for the whole
  // response now (see evaluate.js's own Review page), not one per
  // product -- resp.comment/resp.photos are top-level fields on the
  // response doc, same shape importShareResponse folds into
  // t.evaluatorComments/evaluatorPhotos on Import.
  const photos = Array.isArray(resp.photos) ? resp.photos : [];
  const commentSectionHtml = `
    <div class="eval-wizard-question" style="margin-top:14px;">
      <div class="eval-wizard-question-label">Comments</div>
      <textarea class="eval-wizard-comment" data-role="preview-overall-comment" ${isEditing ? '' : 'readonly'} placeholder="Anything else worth noting">${escapeHtml(resp.comment || '')}</textarea>
      <div class="eval-wizard-question-label" style="margin-top:12px;margin-bottom:6px;">Reference Photo</div>
      ${photos.length ? `<div class="proj-ref-images-grid">${photos.map(ph => `
        <div class="proj-ref-image-item">
          <div class="proj-ref-image-thumb-wrap">
            <img src="${escapeHtml(ph.dataUrl)}" class="proj-ref-image-thumb" alt="Reference photo">
            ${isEditing ? `<button type="button" class="proj-ref-image-remove" data-role="preview-remove-photo" data-photo-id="${escapeHtml(ph.id)}" title="Remove">${icon('x', 12)}</button>` : ''}
          </div>
        </div>
      `).join('')}</div>` : '<div class="overview-empty">No photo attached.</div>'}
      ${isEditing && photos.length < EVAL_COMMENT_PHOTO_MAX ? `<input type="file" class="preview-photo-input" accept="image/*" style="margin-top:8px;">` : ''}
    </div>
  `;

  overlay.innerHTML = `
    <div class="eval-wizard-card">
      <div class="eval-wizard-header">
        <div class="eval-wizard-title">Forge · Guest Response Preview</div>
        <button type="button" class="eval-wizard-close" data-role="preview-close" title="Close">${icon('x')}</button>
      </div>
      <div class="trial-share-response-meta" style="margin-bottom:16px;font-size:13px;">
        <b>${escapeHtml(resp.guestName || 'Guest')}</b> · ${resp.submittedAt ? escapeHtml(formatActivityDateTime(resp.submittedAt)) : ''}
      </div>
      ${productRowsHtml || '<div class="overview-empty">No answers submitted.</div>'}
      ${commentSectionHtml}
      <div class="eval-wizard-nav">
        ${isEditing
          ? `<button type="button" class="btn btn-sm btn-primary" data-role="preview-save">${icon('save', 14)} Save</button>`
          : `<button type="button" class="btn btn-sm" data-role="preview-edit">${icon('pencil', 14)} Edit</button>`}
      </div>
    </div>
  `;

  overlay.querySelector('[data-role="preview-close"]')?.addEventListener('click', () => {
    trialSharePreviewId = null;
    trialSharePreviewEditing = false;
    renderShareResponsePreviewModal();
  });
  overlay.querySelector('[data-role="preview-edit"]')?.addEventListener('click', () => {
    trialSharePreviewEditing = true;
    renderShareResponsePreviewModal();
  });
  overlay.querySelectorAll('[data-role="preview-jar"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ans = resp.answers[btn.dataset.productId];
      ans[btn.dataset.criteriaId] = ans[btn.dataset.criteriaId] === btn.dataset.value ? '' : btn.dataset.value;
      renderShareResponsePreviewModal();
    });
  });
  overlay.querySelectorAll('[data-role="preview-note"]').forEach(el => {
    el.addEventListener('change', () => {
      resp.answers[el.dataset.productId][`${el.dataset.criteriaId}_note`] = el.value.trim();
    });
  });
  overlay.querySelector('[data-role="preview-overall-comment"]')?.addEventListener('change', e => {
    resp.comment = e.target.value.trim();
  });
  overlay.querySelector('.preview-photo-input')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if(!file) return;
    if(!Array.isArray(resp.photos)) resp.photos = [];
    if(resp.photos.length >= EVAL_COMMENT_PHOTO_MAX) return;
    resp.photos.push({ id: uid(), dataUrl: await resizeImageFile(file, 500) });
    renderShareResponsePreviewModal();
  });
  overlay.querySelectorAll('[data-role="preview-remove-photo"]').forEach(btn => {
    btn.addEventListener('click', () => {
      if(!Array.isArray(resp.photos)) return;
      const idx = resp.photos.findIndex(ph => ph.id === btn.dataset.photoId);
      if(idx !== -1) resp.photos.splice(idx, 1);
      renderShareResponsePreviewModal();
    });
  });
  overlay.querySelectorAll('[data-role="preview-testresult"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ans = resp.answers[btn.dataset.productId];
      ans.testResult = ans.testResult === btn.dataset.value ? '' : btn.dataset.value;
      renderShareResponsePreviewModal();
    });
  });
  overlay.querySelector('[data-role="preview-save"]')?.addEventListener('click', async e => {
    e.target.disabled = true;
    try{
      await setDoc(doc(evaluationResponsesCol, resp.id), { answers: resp.answers, comment: resp.comment || '', photos: resp.photos || [] }, { merge: true });
      trialSharePreviewEditing = false;
      renderShareResponsePreviewModal();
    }catch(err){
      console.error('Forge: failed to save edited guest response', err);
      showCloudError('Failed to save changes to this response: ' + err.message);
      e.target.disabled = false;
    }
  });
}
export { renderShareResponsePreviewModal };

// A deleted trial has no cascade delete of its own in Firestore -- without
// this, any evaluationLinks/evaluationResponses docs it ever generated
// (see generateShareLink/save in evaluate.js) would become permanently
// orphaned, referencing a trialId nothing points to any more. Best-effort
// and fire-and-forget, same as the trial delete itself: if this fails, the
// worst case is a harmless orphaned doc, exactly the pre-existing behavior
// this is meant to improve on, not a regression.
export async function deleteTrialShareArtifacts(trialId){
  try{
    const [linksSnap, responsesSnap] = await Promise.all([
      getDocs(query(evaluationLinksCol, where('trialId', '==', trialId))),
      getDocs(query(evaluationResponsesCol, where('trialId', '==', trialId)))
    ]);
    await Promise.all([
      ...linksSnap.docs.map(d => deleteDoc(d.ref)),
      ...responsesSnap.docs.map(d => deleteDoc(d.ref))
    ]);
  }catch(err){
    console.error('Forge: failed to clean up this trial\'s share links/responses', err);
  }
}
