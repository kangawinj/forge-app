import {
  escapeHtml, icon, resizeImageFile, requestAuthConfirm, playContentTransition,
  formatActivityDateTime, formatDateLong, formatTimeOnly, currentUser, uid,
  mainFeatureView, setMainFeatureView, recipesLoaded, currentId, renderMain, renderSidebar,
  recipes, recipeDisplayLabel, fullCode, logActivityEvent, diffMainFields, snapshotMainFields,
  renderBarList, openRecipeFromDashboard, metaLists, metaItemName, projectsCol, PROJECT_STAGES,
  showCloudError, trialStringListHtml, isCurrentUserAdmin,
  pendingSubmissionsCol, myProfile, activityEventsCol, projectMatchesName, myLinkedName, namesMatch,
  moveToTrash
} from './app.js';
import {
  onSnapshot, setDoc, deleteDoc, doc, getDoc, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  PROJ_REF_IMAGE_MAX, fileToProjRefImage,
  projRefImagesHtml, blankCookingCondition, getCookingConditions, parseLegacyRequirements,
  CERTIFICATE_TYPES, blankCertificate, getCertificate, certificateSummaryText,
  certificateChecklistHtml, wireCertificateChecklist, readCertificateChecklist, getRequirements
} from './projects-requirements.js';
import {
  CURRENCY_OPTIONS, PROJECT_STATUSES, PROJECT_STATUS_LABELS, PROJECT_STATUS_BAR,
  projectStatusBarHtml, projectPhotoStatusColor, TASK_STATUS_META, migrateMonthlyUpdate,
  muPlanSummaryLine, monthlyUpdateStatus, getTaskStatus, daysBetween, projectHasUpdateThisMonth,
  projectProgressPct, statusPillHtml, projectNextAction, blankProject, blankFlavor,
  selectTextOnFocus, blankProduct, formatPortionWeight, formatInnerPacking, formatOuterPacking,
  formatProjectMoq, duplicateProject, saveProjectToCloud, deleteProjectFromCloud,
  scheduleProjectSave, PROJECT_DIFF_FIELDS, MU_DIFF_FIELDS, resolveMuCompletedDate
} from './projects-data.js';
import {
  attachPendingSubmissionsListener, toggleSharePanel, renderSharePanel,
  togglePendingSubmissionsPanel, reviewingSubmission, readSubmissionReviewForm,
  currentUserDisplayLabel, completeSubmissionImport, resetPendingSubmissionsState,
  pendingSubmissionsCount
} from './projects-submissions.js';
import {
  projectDocSlotHtml, wireProjectDocSlots, muAttachmentChipsHtml,
  allProjectAttachments, wireMuAttachmentEditor, openMuAttachmentPreview, initMuAttachmentPreviewModal
} from './projects-attachments.js';
// Re-exported: app.js already imports this from projects.js directly.
export { initMuAttachmentPreviewModal };
// Circular import back from the Product Log + MU Edit modal split out
// below -- safe, same pattern proven throughout this session's splits.
import { openProductLogModal, openMuEditModal, renderProductLog, wireProjectModals } from './projects-mu-modal.js';

// Guesses which way to translate an Activities Updates field: Thai
// detected anywhere in it (same Thai Unicode block test as the password
// prompt's keyboard-language badge) translates to English, anything else
// translates to Thai — covers the common case of drafting mostly in
// English with no Thai typed yet too.
function guessTranslateTargetLang(text){
  return /[฀-๿]/.test(text) ? 'en' : 'th';
}

// Free, keyless machine translation via the same public endpoint
// translate.google.com's own web page calls (client=gtx) — no API key or
// signup needed, unlike the official paid Google Cloud Translation API.
// This is an unofficial, undocumented use of that endpoint (there's no
// terms-of-service-sanctioned "no key needed" tier of Google Translate),
// so it could be rate-limited or blocked without notice; if that ever
// happens, this is the one function to swap for a paid API call — nothing
// else needs to change, see wireMuTranslateButton below.
async function translateText(text, targetLang){
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Translation service unavailable');
  const data = await res.json();
  // Response shape: [[[translatedChunk, originalChunk, ...], ...], ...] —
  // one translated chunk per sentence/segment; stitched back into one string.
  return data[0].map(chunk => chunk[0]).join('');
}

// Puts the translated text first with the original following in
// parentheses — an Activities Updates entry then reads bilingually, led
// by whichever language was just translated to, instead of losing
// whatever was typed first. Shared by both the "Add Update" panel and
// the "Edit entry" popup, since both use the exact same
// .mu-field-with-translate + .mu-translate-btn markup pair.
export function wireMuTranslateButton(wrapEl){
  const textarea = wrapEl.querySelector('textarea');
  const btn = wrapEl.querySelector('.mu-translate-btn');
  if(!textarea || !btn) return;
  btn.addEventListener('click', async () => {
    const original = textarea.value.trim();
    if(!original) return;
    btn.classList.add('loading');
    try{
      const translated = await translateText(original, guessTranslateTargetLang(original));
      textarea.value = `${translated}\n(${original})`;
    }catch(err){
      console.error('Forge: translation failed', err);
      alert('Translation failed — the free translation service may be temporarily unavailable. Please try again in a moment.');
    }finally{
      btn.classList.remove('loading');
    }
  });
}

// If "Create as Plan automatically" was checked and there's a Next Action
// with a due date, chains a new Planned entry whose Plan is that Next
// Action text — the follow-up shows up ready to log once it's actually
// acted on, instead of retyping the same reminder as a new entry by hand.
// Called after every save of an entry (new or edited), so if a linked
// Plan entry already exists (found via sourceUpdateId) this re-syncs its
// date/time/who/plan/where/how from the source's current Next Action
// fields instead of creating a second one — editing the original Next
// Action later keeps the auto-created entry showing the same thing,
// rather than leaving it frozen at whatever it said at creation time.
// Returns false only when the checkbox was checked but nothing could be
// auto-created because Next Action Activity and/or its due date ("When")
// are still blank — the caller alerts on that, since silently doing
// nothing left the checkbox looking broken with no explanation.
export function maybeAutoCreateNextPlan(p, mu){
  if(!Array.isArray(p.monthlyUpdates)) p.monthlyUpdates = [];
  const existing = p.monthlyUpdates.find(x => x.sourceUpdateId === mu.id);
  if(existing){
    if(mu.nextAction && mu.nextActionDue){
      existing.date = mu.nextActionDue;
      existing.time = mu.nextActionTime || '';
      existing.planWho = mu.nextActionWho || '';
      existing.plan = mu.nextAction;
      existing.planWhere = mu.nextActionWhere || '';
      existing.planWith = mu.nextActionWith || '';
      existing.planOwner = mu.nextActionOwner || '';
    }
    return true;
  }
  if(!mu.autoCreatePlan) return true;
  if(!mu.nextAction || !mu.nextActionDue) return false;
  p.monthlyUpdates.push({
    id: uid(), date: mu.nextActionDue, time: mu.nextActionTime || '',
    planWho: mu.nextActionWho || '', plan: mu.nextAction, planWhere: mu.nextActionWhere || '',
    planWith: mu.nextActionWith || '', planOwner: mu.nextActionOwner || '',
    actionTaken: '', nextAction: '', nextActionDue: '',
    autoCreatePlan: false, sourceUpdateId: mu.id,
    createdBy: currentUser?.email || '', createdAt: Date.now()
  });
  return true;
}

function captureMonthlyUpdateDraft(p, block){
  const dateInput = block.querySelector('.proj-mu-date');
  const timeInput = block.querySelector('.proj-mu-time');
  const whoInput = block.querySelector('.proj-mu-who');
  const planInput = block.querySelector('.proj-mu-plan');
  const whereInput = block.querySelector('.proj-mu-where');
  const withInput = block.querySelector('.proj-mu-with');
  const ownerInput = block.querySelector('.proj-mu-owner');
  const actionInput = block.querySelector('.proj-mu-action');
  const nextActionTimeInput = block.querySelector('.proj-mu-nextaction-time');
  const nextActionWhoInput = block.querySelector('.proj-mu-nextaction-who');
  const nextActionInput = block.querySelector('.proj-mu-nextaction');
  const nextActionWhereInput = block.querySelector('.proj-mu-nextaction-where');
  const nextActionWithInput = block.querySelector('.proj-mu-nextaction-with');
  const nextActionOwnerInput = block.querySelector('.proj-mu-nextaction-owner');
  const nextActionDueInput = block.querySelector('.proj-mu-nextaction-due');
  const autoCreateInput = block.querySelector('.proj-mu-autocreate');
  const recipeInput = block.querySelector('.proj-mu-recipe');
  const completedDateInput = block.querySelector('.proj-mu-completed-date');
  if(!dateInput) return false;
  const date = dateInput.value;
  const time = timeInput?.value || '';
  const planWho = whoInput?.value.trim() || '';
  const plan = planInput.value.trim();
  const planWhere = whereInput?.value.trim() || '';
  const planWith = withInput?.value.trim() || '';
  const planOwner = ownerInput?.value.trim() || '';
  const actionTaken = actionInput.value.trim();
  const nextActionTime = nextActionTimeInput?.value || '';
  const nextActionWho = nextActionWhoInput?.value.trim() || '';
  const nextAction = nextActionInput.value.trim();
  const nextActionWhere = nextActionWhereInput?.value.trim() || '';
  const nextActionWith = nextActionWithInput?.value.trim() || '';
  const nextActionOwner = nextActionOwnerInput?.value.trim() || '';
  const nextActionDue = nextActionDueInput.value;
  const autoCreatePlan = !!autoCreateInput?.checked;
  const linkedRecipeId = recipeInput?.value || '';
  const completedDate = resolveMuCompletedDate(actionTaken, completedDateInput?.value || '', new Date().toISOString().slice(0, 10));
  if(!date || (!plan && !actionTaken && !nextAction)) return false;
  if(!Array.isArray(p.monthlyUpdates)) p.monthlyUpdates = [];
  const mu = {
    id: uid(), date, time, planWho, plan, planWhere, planWith, planOwner, actionTaken,
    nextActionTime, nextActionWho, nextAction, nextActionWhere, nextActionWith, nextActionOwner, nextActionDue, autoCreatePlan,
    linkedRecipeId, attachments: monthlyUpdateDraftAttachments, completedDate,
    sourceUpdateId: '', createdBy: currentUser?.email || '', createdAt: Date.now()
  };
  monthlyUpdateDraftAttachments = [];
  p.monthlyUpdates.push(mu);
  // Left for the caller to invoke -- callers need maybeAutoCreateNextPlan's
  // own return value (whether it actually skipped auto-creating anything)
  // to decide whether to warn the user, which calling it in here and
  // discarding the result can't do.
  return mu;
}


// A single shared holding pen for Activities Updates added straight from
// the Calendar's empty-cell click (see quickAddCalendarPlan below), before
// they've been sorted into a real project. Lazily created the first time
// anyone actually uses that feature -- most teams may never need it at
// all -- and found again after that by the isUnassignedBucket flag rather
// than by name, so nothing breaks if someone renames it or a real project
// happens to also be called "Unassigned".
function getOrCreateUnassignedProject(){
  const existing = projects.find(p => p.isUnassignedBucket);
  if(existing) return existing;
  const p = blankProject();
  p.name = 'Unassigned';
  p.isUnassignedBucket = true;
  projects.push(p);
  saveProjectToCloud(p);
  return p;
}
// Clicking an empty calendar cell shouldn't force picking a project
// first -- that's exactly the friction this is meant to remove -- so it
// creates a blank entry on the Unassigned bucket project and opens the
// same "Update Activity" popup already used everywhere else to fill it
// in (including, while it's still on that bucket project, a "Project"
// picker at the top to move it once one's known -- see
// openMuEditModal/saveMuEditModal). createdFromCalendar marks it so
// closeMuEditModal can quietly remove it again if the popup gets closed
// without anything ever being filled in, instead of leaving a permanent
// blank stub on the calendar.
export function quickAddCalendarPlan(dateStr){
  const p = getOrCreateUnassignedProject();
  const mu = {
    id: uid(), date: dateStr, time: '', planWho: '', plan: '', planWhere: '', planWith: '', planOwner: '',
    actionTaken: '', nextAction: '', nextActionDue: '', nextActionTime: '', nextActionWho: '',
    nextActionWhere: '', nextActionWith: '', nextActionOwner: '', autoCreatePlan: false, sourceUpdateId: '',
    linkedRecipeId: '', attachments: [], completedDate: '', createdFromCalendar: true
  };
  if(!Array.isArray(p.monthlyUpdates)) p.monthlyUpdates = [];
  p.monthlyUpdates.push(mu);
  scheduleProjectSave(p);
  openMuEditModal(p.id, mu.id);
}
export function addProductLogEntry(product, stage, note){
  product.log.push({ id: uid(), date: Date.now(), stage, note: (note || '').trim(), by: currentUser?.email || '' });
  product.stage = stage;
  product.updatedAt = Date.now();
}

// ---------- Share Link: public, no-login project intake (submit.html) ----------
// One fixed URL (no per-recipient token) -- share it once, reuse forever.
// Whoever opens it clicks "+ Add Request Project" themselves and fills in
// a project's details without ever logging in (see submit.html's own
// comment, and the /pendingSubmissions rule in firestore.rules, for how a
// random per-*request* token, generated by that page itself rather than
// handed out from here, scopes what a given submitter can touch). A
// submission only ever becomes a real project once someone on the team
// reviews and imports it from the panel below -- nothing from the public
// page reaches /projects directly.
// Kept in core (not moved to projects-submissions.js with the rest of the
// review workflow) since converting a submission into a pre-filled New
// Project draft means writing straight into this file's own New Project
// panel editing state (newProjectOpen/newProjectFlavors/etc) and calling
// renderNewProjectPanel() -- projects-submissions.js's own state is only
// touched at the very end, via completeSubmissionImport.
async function importSubmission(){
  const btn = document.getElementById('btnImportSubmission');
  btn.disabled = true;
  const submissionId = reviewingSubmission.id;
  const data = readSubmissionReviewForm();
  try{
    await setDoc(doc(pendingSubmissionsCol, submissionId), {
      ...data, submissionStatus: 'imported', createdAt: reviewingSubmission.createdAt || Date.now(), updatedAt: Date.now(),
      decidedBy: currentUserDisplayLabel(), decidedAt: Date.now()
    });
    logActivityEvent('imported', 'submission', data.name || 'Untitled submission');
  }catch(err){
    alert('Could not lock this submission as imported: ' + (err.message || err));
    btn.disabled = false;
    return;
  }
  newProjectOpen = true;
  newProjectImage = '';
  referenceImagesEditing = [];
  recipeAttachmentsEditing = [];
  newProjectFlavors = (data.flavors || []).map(f => ({ ...f, id: f.id || uid() }));
  cookingGuidelinesEditing = data.requirements.cookingCondition.map(g => ({ id: uid(), method: g.method, steps: [...g.steps] }));
  renderNewProjectPanel();
  const setVal = (id, v) => { const el = document.getElementById(id); if(el) el.value = v || ''; };
  setVal('newProjName', data.name);
  setVal('newProjStatus', data.status);
  setVal('newProjRequestDate', data.requestDate);
  setVal('newProjStartDate', data.startDate);
  setVal('newProjTargetEndDate', data.targetEndDate);
  setVal('newProjCustomer', data.customerName);
  setVal('newProjDestination', data.destinationCountry);
  setVal('newProjOwner', data.ownerSalesRep);
  setVal('newProjFactoryRep', data.factorySalesRep);
  setVal('newProjResponsible', data.responsiblePerson);
  setVal('newProjFactory', data.factoryName);
  setVal('newProjPortionQty', data.portionWeightQty);
  setVal('newProjPortionUnit', data.portionWeightUnit);
  setVal('newProjPortionPerUnit', data.portionPerUnit);
  setVal('newProjInnerQty', data.innerPackQty);
  setVal('newProjInnerWeightUnit', data.innerPackWeightUnit);
  setVal('newProjInnerPackUnit', data.innerPackUnit);
  setVal('newProjOuterQty', data.outerPackQty);
  setVal('newProjOuterPackUnit', data.outerPackUnit);
  setVal('newProjOuterContainerUnit', data.outerPackContainerUnit);
  setVal('newProjMoqQty', data.moqQty);
  setVal('newProjMoqUnit', data.moqUnit);
  setVal('newProjReqPackaging', data.requirements.packagingCondition);
  setVal('newProjReqStorageCondition', data.requirements.storageCondition);
  setVal('newProjReqShelfLife', data.requirements.shelfLife);
  setVal('newProjReqComposition', data.requirements.composition);
  setVal('newProjReqRecipe', data.requirements.recipe);
  setVal('newProjReqNote', data.requirements.note);
  // Not a plain setVal -- the panel just rendered a blank checklist (it
  // has no way to know about this imported data at render time), so the
  // imported certificate is applied straight onto the checkboxes/text
  // field afterward, same "render then patch" order as everything else
  // in this import flow.
  const certWrap = document.querySelector('#newProjectPanel .proj-cert-wrap');
  if(certWrap){
    const cert = getCertificate(data.requirements.certificate);
    certWrap.querySelectorAll('.proj-cert-check').forEach(cb => { cb.checked = !!cert[cb.dataset.cert]; });
    const otherField = certWrap.querySelector('.proj-cert-other-field');
    otherField.value = cert.otherDetails || '';
    otherField.style.display = cert.other ? '' : 'none';
  }
  completeSubmissionImport(submissionId);
  document.getElementById('newProjectPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function mountProjectsView(){
  const main = document.getElementById('mainArea');
  main.classList.add('main-wide');
  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('folder', 24)} Projects</div>
    </div>
    <div class="card">
      <button class="btn btn-primary btn-sm" id="btnAddProject" style="margin-bottom:16px;">+ New Project</button>
      <button type="button" class="btn btn-sm" id="btnShareLink" style="margin-bottom:16px;margin-left:8px;" title="Get a link anyone can fill in without logging in">Share Link</button>
      <button type="button" class="btn btn-sm" id="btnTogglePendingSubmissions" style="margin-bottom:16px;margin-left:8px;">
        Pending Submissions
        <span id="pendingSubmissionsBadge" style="display:${pendingSubmissionsCount ? 'inline-flex' : 'none'};margin-left:6px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--danger);color:#fff;font-size:10px;font-weight:700;align-items:center;justify-content:center;line-height:16px;">${pendingSubmissionsCount}</span>
      </button>
      <div id="shareLinkPanel"></div>
      <div id="pendingSubmissionsPanel"></div>
      <div id="newProjectPanel"></div>
      <div id="projectsDashboard"></div>
      <div id="projectsToolbar" style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
        <div class="search-box" style="margin:0;flex:1;min-width:200px;position:relative;">
          <input type="text" id="projectSearchInput" style="padding-right:28px;" placeholder="Search projects (name, customer, destination, owner, factory...)">
          <button type="button" class="search-clear-btn" id="btnClearProjectSearch" title="Clear search" style="display:none;">${icon('x', 14)}</button>
        </div>
        <div class="task-tracking-who-filter-wrap" id="projectWhoFilterWrap"></div>
        <div class="col-toggle-wrap">
          <button type="button" class="btn btn-sm" id="btnProjectColumns">${icon('sliders-horizontal', 14)} Columns</button>
          <div class="col-toggle-menu" id="projectColumnsMenu">
            ${PROJECT_TOGGLE_COLUMNS.map(c => `
              <label class="col-toggle-item">
                <input type="checkbox" data-col-key="${escapeHtml(c.key)}" ${projectHiddenColumns.has(c.key) ? '' : 'checked'}>
                ${escapeHtml(c.label)}
              </label>
            `).join('')}
          </div>
        </div>
      </div>
      <div id="projectsList"></div>
    </div>
  `;

  document.getElementById('btnAddProject').addEventListener('click', () => {
    newProjectOpen = true;
    newProjectImage = '';
    // Reuses the same staged-edit variables an existing project's own
    // Requirements editor uses (referenceImagesEditing/
    // cookingGuidelinesEditing/recipeAttachmentsEditing) so the New Project
    // panel can render the identical Reference Images / Recipe attachment /
    // Cooking Guidelines steps UI -- reset here since a previous session
    // (or a cancelled edit elsewhere) could otherwise leak stale staged
    // values into a fresh new-project draft. newProjectFlavors is the one
    // genuinely new piece of state, standing in for p.flavors since there's
    // no real project yet for that array to live on.
    referenceImagesEditing = [];
    cookingGuidelinesEditing = [blankCookingCondition()];
    recipeAttachmentsEditing = [];
    newProjectFlavors = [];
    renderNewProjectPanel();
  });
  document.getElementById('btnShareLink').addEventListener('click', toggleSharePanel);
  document.getElementById('btnTogglePendingSubmissions').addEventListener('click', togglePendingSubmissionsPanel);
  renderNewProjectPanel();
  const projectSearchInputEl = document.getElementById('projectSearchInput');
  const clearProjectSearchBtn = document.getElementById('btnClearProjectSearch');
  function updateClearProjectSearchBtn(){
    clearProjectSearchBtn.style.display = projectSearchInputEl.value ? 'flex' : 'none';
  }
  updateClearProjectSearchBtn();
  projectSearchInputEl.addEventListener('input', () => {
    updateClearProjectSearchBtn();
    renderProjectsList();
  });
  clearProjectSearchBtn.addEventListener('click', () => {
    projectSearchInputEl.value = '';
    updateClearProjectSearchBtn();
    projectSearchInputEl.focus();
    renderProjectsList();
  });
  renderProjectWhoFilter();
  const columnsMenu = document.getElementById('projectColumnsMenu');
  document.getElementById('btnProjectColumns').addEventListener('click', e => {
    e.stopPropagation();
    columnsMenu.classList.toggle('open');
  });
  columnsMenu.addEventListener('click', e => e.stopPropagation());
  columnsMenu.querySelectorAll('[data-col-key]').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.colKey;
      if(cb.checked) projectHiddenColumns.delete(key);
      else projectHiddenColumns.add(key);
      localStorage.setItem(PROJECT_HIDDEN_COLUMNS_KEY, JSON.stringify(Array.from(projectHiddenColumns)));
      applyProjectColumnVisibility();
      activeProjScrollbarProxySync?.();
    });
  });

  renderProjectsList();
  playContentTransition(main);
}

let projectEditingId = null;
// Staged, uncommitted edits for the currently-open Cooking Condition steps
// list -- kept separate from p.requirements itself (same reasoning as
// Reference Lists' refListEditingSteps) so Cancel discards them like every
// other Requirements field does, instead of the live-save behavior
// Flavor/Filling rows use.
// Staged Cooking Guidelines groups for whichever project is currently
// being edited (New Project panel or an existing project's edit-in-place
// row -- same shared variable, same deferred-edit reasoning as above).
// Each group is its own {id, method, steps}; always at least one so
// there's a first row to edit into (see blankCookingCondition/
// getCookingConditions).
let cookingGuidelinesEditing = [blankCookingCondition()];
// Same deferred-edit reasoning, for the Requirements box's Idea / Reference
// Images gallery.
let referenceImagesEditing = [];
// ...and for the Recipe field's file/photo attachments (see
// fileToMuAttachment / wireMuAttachmentEditor -- same shared attachment
// system Activities Updates already uses, just a different staged array).
let recipeAttachmentsEditing = [];
let monthlyUpdateEditingId = null;
let monthlyUpdateAddOpen = false;
// Staged attachments for whichever Activities Updates inline form (add or
// edit) is currently open — only one can be open at a time (see
// monthlyUpdateEditingId / monthlyUpdateAddOpen above), so one shared array
// is enough. Reset to [] on open/cancel, read into the entry on Save.
let monthlyUpdateDraftAttachments = [];
let muEditModalAttachments = [];
let projectExpandedIds = new Set();
let editingProjectImage = ''; // staged photo as a data URL for whichever project is being edited
let newProjectOpen = false; // whether the "+ New Project" entry panel is showing, below the button
let newProjectImage = ''; // staged photo as a data URL for the not-yet-saved new-project draft
// Staged Flavor / Filling rows for the not-yet-saved new-project draft --
// mirrors p.flavors (see blankFlavor), just with nowhere to live yet since
// there's no real project until Save. Reset alongside the other New
// Project staged-edit variables in btnAddProject's click handler.
let newProjectFlavors = [];
// Everyone (admin included) lands on just their own name-matched
// projects every fresh login/page load (this is a plain module-level
// let, so it naturally resets whenever the app itself reloads); the Who
// filter (see renderProjectWhoFilter) adds specific colleagues' projects
// on top, one at a time -- switching back and forth within the same
// session (navigating away from Projects and back) keeps whichever names
// were last added, since mountProjectsView() reads this current value
// rather than clearing it every time it rebuilds the toolbar.
let projectVisibilityWho = new Set();
// Whether the Who filter's dropdown panel is currently open -- see
// renderProjectWhoFilter/closeProjectWhoMenu.
let projectWhoMenuOpen = false;
// Stands in for "no PD set" as a Set member/checkbox value in the Who
// filter, same trick the Calendar's own Who filter uses for events with
// no assignee (see CAL_WHO_UNASSIGNED in app.js) -- an empty checkbox
// value is awkward to read back reliably.
const PROJECT_WHO_UNASSIGNED = '__unassigned_pd__';
// Does this project's PD (Responsible Person) match the given Who
// filter value -- PROJECT_WHO_UNASSIGNED matches a project with no PD
// set at all, anything else is a fuzzy name match against that one
// field only (unlike projectMatchesName, which checks every role a
// project has).
function projectMatchesWhoValue(p, value){
  const pd = (p?.responsiblePerson || '').trim();
  if(value === PROJECT_WHO_UNASSIGNED) return !pd;
  return namesMatch(pd, value);
}
// Single source of truth for "can the signed-in person currently see this
// project" -- always true for the Unassigned bucket (see
// getOrCreateUnassignedProject). Admin defaults to seeing every project
// (the Who filter narrows that down to just the checked PDs, same
// empty-means-everyone/checked-means-only-them semantics as Task
// Tracking's own Who filter); everyone else defaults to just their own
// name-matched projects (myLinkedName, any role -- not just PD), with
// the Who filter adding specific PDs' projects on top instead of
// narrowing. Used everywhere a project might be shown outside the main
// table (status/PD galleries, the Gantt chart, column filter value
// lists) so the Who filter actually reveals everything consistently
// instead of just the table rows.
function isProjectCurrentlyVisible(p){
  if(p?.isUnassignedBucket) return true;
  if(isCurrentUserAdmin()){
    if(!projectVisibilityWho.size) return true;
    for(const value of projectVisibilityWho){
      if(projectMatchesWhoValue(p, value)) return true;
    }
    return false;
  }
  if(projectMatchesName(p, myLinkedName())) return true;
  for(const value of projectVisibilityWho){
    if(projectMatchesWhoValue(p, value)) return true;
  }
  return false;
}
// The Who filter's checkbox list -- every distinct PD (Responsible
// Person) name currently set on any real project (the Unassigned bucket
// project itself is excluded, since it's always shown regardless and
// never has a PD anyway), plus a PROJECT_WHO_UNASSIGNED pseudo-entry for
// projects with no PD set, so "no one assigned yet" is something you can
// filter by too instead of being silently left out of the list. For
// everyone except admin, the signed-in person's own name is left out of
// the named options (their projects are always shown regardless of this
// filter already) -- admin has no such baseline (see
// isProjectCurrentlyVisible), so their own name stays in the list too.
function projectWhoFilterOptions(){
  const myName = myLinkedName();
  const excludeMine = !isCurrentUserAdmin();
  const named = new Set();
  let hasUnassigned = false;
  projects.forEach(p => {
    if(p.isUnassignedBucket) return;
    const pd = (p.responsiblePerson || '').trim();
    if(pd) named.add(pd); else hasUnassigned = true;
  });
  const namedOptions = [...named].filter(n => !excludeMine || !namesMatch(n, myName)).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return { namedOptions, hasUnassigned };
}
// Renders (or re-renders) the "Who" button + its dropdown panel into
// #projectWhoFilterWrap -- a small self-contained component, same
// pattern as renderPendingSubmissionsPanel/renderSharePanel, so a
// checkbox change can refresh just this piece (picking up any project
// added/edited since it last rendered) without disturbing the rest of
// the toolbar or losing focus/scroll elsewhere on the page.
function renderProjectWhoFilter(){
  const wrap = document.getElementById('projectWhoFilterWrap');
  if(!wrap) return;
  const isAdmin = isCurrentUserAdmin();
  const { namedOptions, hasUnassigned } = projectWhoFilterOptions();
  const allValues = hasUnassigned ? [...namedOptions, PROJECT_WHO_UNASSIGNED] : namedOptions;
  const allSelected = allValues.length > 0 && allValues.every(v => projectVisibilityWho.has(v));
  wrap.innerHTML = `
    <button type="button" class="btn btn-sm${projectVisibilityWho.size ? ' active' : ''}" id="projectWhoTrigger">
      Who${projectVisibilityWho.size ? ` (${isAdmin ? '' : '+'}${projectVisibilityWho.size})` : ''} ${icon('chevron-down', 12)}
    </button>
    <div class="proj-col-filter-menu${projectWhoMenuOpen ? ' open' : ''}" id="projectWhoMenu">
      ${allValues.length ? `
      <label class="proj-col-filter-item proj-col-filter-selectall">
        <input type="checkbox" id="projectWhoSelectAll" ${allSelected ? 'checked' : ''}>
        <b>(Select All)</b>
      </label>
      <div class="proj-col-filter-values">
        ${namedOptions.map(w => `
          <label class="proj-col-filter-item">
            <input type="checkbox" class="project-who-cb" value="${escapeHtml(w)}" ${projectVisibilityWho.has(w) ? 'checked' : ''}>
            ${escapeHtml(w)}
          </label>
        `).join('')}
        ${hasUnassigned ? `
          <label class="proj-col-filter-item">
            <input type="checkbox" class="project-who-cb" value="${PROJECT_WHO_UNASSIGNED}" ${projectVisibilityWho.has(PROJECT_WHO_UNASSIGNED) ? 'checked' : ''}>
            Unassigned
          </label>
        ` : ''}
      </div>
      ${projectVisibilityWho.size ? `<button type="button" class="btn btn-sm" id="projectClearWhoFilters" style="margin-top:6px;width:100%;">Clear${isAdmin ? ' filter' : ''}</button>` : ''}
      ` : `<div class="dash-empty" style="padding:4px;">No PD assigned yet</div>`}
    </div>
  `;
  document.getElementById('projectWhoTrigger').addEventListener('click', e => {
    e.stopPropagation();
    projectWhoMenuOpen = !projectWhoMenuOpen;
    renderProjectWhoFilter();
  });
  document.getElementById('projectWhoMenu').addEventListener('click', e => e.stopPropagation());
  wrap.querySelectorAll('.project-who-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if(cb.checked) projectVisibilityWho.add(cb.value);
      else projectVisibilityWho.delete(cb.value);
      renderProjectWhoFilter();
      renderProjectsList();
    });
  });
  document.getElementById('projectWhoSelectAll')?.addEventListener('change', e => {
    // Reads the checkboxes already on the page (== allValues) rather than
    // recomputing that list here -- same set either way, but this way
    // there's only one place (this function) that decides what counts as
    // "everyone", same trick the Calendar's own Who filter uses.
    const values = [...wrap.querySelectorAll('.project-who-cb')].map(cb => cb.value);
    if(e.target.checked) values.forEach(v => projectVisibilityWho.add(v));
    else values.forEach(v => projectVisibilityWho.delete(v));
    renderProjectWhoFilter();
    renderProjectsList();
  });
  document.getElementById('projectClearWhoFilters')?.addEventListener('click', () => {
    projectVisibilityWho.clear();
    renderProjectWhoFilter();
    renderProjectsList();
  });
}
// Excel-style per-column value filters for the projects table — see the "▾"
// button sortableProjectHeader() adds to every sortable column. Keyed by
// the same field key as PROJECT_SORT_ACCESSORS/PROJECT_FILTER_ACCESSORS; a
// missing key means that column isn't filtered (shows every value). Holding
// a Set of the specific raw values still checked, not a single value, is
// what makes this multi-select rather than the old single-choice dropdowns
// it replaced.
let projectColumnFilters = {};
// Which single column's filter popover is currently open, if any — kept in
// module state (not just a DOM class) because renderProjectsList() rebuilds
// the whole table on every filter click, and without this the popover would
// visibly close after every single checkbox click instead of staying open
// while you check off several values in a row.
let openProjectFilterMenuKey = null;
// Which statuses count toward the "Projects by Responsible Person (PD)"
// workload card — a Set of PROJECT_STATUSES values, empty meaning "every
// status" (so Completed/Cancelled projects still weigh down someone's
// count unless explicitly narrowed down, e.g. to just the active ones).
// Deliberately separate from projectColumnFilters.status: that filters
// the table itself, this only narrows what this one card tallies — same
// "dashboard summary ignores the table's own filters" split the rest of
// this dashboard already has. Its open/close state piggybacks on
// openProjectFilterMenuKey above (via the 'pdWorkloadStatus' key) so it
// gets the same stay-open-across-re-renders and click-outside-to-close
// behavior as every other filter popover on this page for free.
let responsibleStatusFilters = new Set();
let projectSortKey = 'updatedAt';
let projectSortDir = 'desc';
// Whichever renderProjectsList() call is most recent owns this — see the
// single persistent window resize listener wired near the bottom of the
// script, which just calls whatever this currently points at.
let activeProjScrollbarProxySync = null;

/* ---------- Unsaved-changes guard (Projects only) ----------
   Recipe edits autosave within ~400ms of any change (see scheduleSave), and
   Trial edits save on every field's own 'change' event — neither can lose
   real work by navigating away. A project's main fields are different: they
   only get read out of the DOM and saved when the row's own Save button is
   clicked (see the [data-role="save-project"] handler), so typing into an
   open edit row or the "+ New Project" panel and then clicking a navbar tab
   or a different recipe would silently throw that away. This guard catches
   exactly that gap — see guardNavigation, wired onto every persistent
   navbar/sidebar click that can navigate away while Projects is open. */
function hasUnsavedProjectEdit(){
  if(projectEditingId) return true;
  if(newProjectOpen && document.getElementById('newProjName')?.value.trim()) return true;
  return false;
}
let pendingGuardedNavigation = null;
export function guardNavigation(action){
  if(!hasUnsavedProjectEdit()){ action(); return; }
  pendingGuardedNavigation = action;
  document.getElementById('unsavedChangesModalOverlay').classList.add('open');
}
function closeUnsavedChangesModal(){
  document.getElementById('unsavedChangesModalOverlay').classList.remove('open');
  pendingGuardedNavigation = null;
}
export function initUnsavedChangesGuard(){
  document.getElementById('btnCloseUnsavedChanges').addEventListener('click', closeUnsavedChangesModal);
  document.getElementById('btnUnsavedCancel').addEventListener('click', closeUnsavedChangesModal);
  // Reuses the real Save/Cancel buttons already wired on the open edit row
  // or the "+ New Project" panel instead of duplicating their logic — a
  // plain click() dispatch runs the exact same handler a manual click would.
  document.getElementById('btnUnsavedSave').addEventListener('click', () => {
    document.querySelector('[data-role="save-project"]')?.click();
    document.getElementById('btnSaveNewProject')?.click();
    const action = pendingGuardedNavigation;
    closeUnsavedChangesModal();
    action?.();
  });
  document.getElementById('btnUnsavedDiscard').addEventListener('click', () => {
    document.querySelector('[data-role="cancel-project"]')?.click();
    document.getElementById('btnCancelNewProject')?.click();
    const action = pendingGuardedNavigation;
    closeUnsavedChangesModal();
    action?.();
  });
  window.addEventListener('beforeunload', e => {
    if(!hasUnsavedProjectEdit()) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// Accessor per sortable column — keeps the header-click handler and the
// comparator working off the same single source of truth for "what does
// this column's value mean," text columns lowercased so sorting isn't
// case-sensitive.
const PROJECT_SORT_ACCESSORS = {
  name: p => (p.name || '').toLowerCase(),
  status: p => p.status || PROJECT_STATUSES[0],
  requestDate: p => p.requestDate || '',
  customerName: p => (p.customerName || '').toLowerCase(),
  destinationCountry: p => (p.destinationCountry || '').toLowerCase(),
  ownerSalesRep: p => (p.ownerSalesRep || '').toLowerCase(),
  factorySalesRep: p => (p.factorySalesRep || '').toLowerCase(),
  responsiblePerson: p => (p.responsiblePerson || '').toLowerCase(),
  factoryName: p => (p.factoryName || '').toLowerCase(),
  productCount: p => p.products.length,
  updatedAt: p => p.updatedAt || 0
};
function compareProjects(a, b){
  const accessor = PROJECT_SORT_ACCESSORS[projectSortKey] || PROJECT_SORT_ACCESSORS.updatedAt;
  const av = accessor(a), bv = accessor(b);
  const cmp = (typeof av === 'number' && typeof bv === 'number') ? av - bv : String(av).localeCompare(String(bv));
  return projectSortDir === 'asc' ? cmp : -cmp;
}

// Same fields as PROJECT_SORT_ACCESSORS, but the *raw* display value (not
// lowercased, numbers turned into strings) — this is what actually shows up
// as a checkbox label in a column's filter popover and what a project's
// value is compared against, so it needs to read the same as the cell
// itself rather than the folded-for-sorting version.
const PROJECT_FILTER_ACCESSORS = {
  name: p => p.name || '',
  status: p => p.status || PROJECT_STATUSES[0],
  requestDate: p => p.requestDate || '',
  customerName: p => p.customerName || '',
  destinationCountry: p => p.destinationCountry || '',
  ownerSalesRep: p => p.ownerSalesRep || '',
  factorySalesRep: p => p.factorySalesRep || '',
  responsiblePerson: p => p.responsiblePerson || '',
  factoryName: p => p.factoryName || '',
  productCount: p => String(p.products.length)
};

// The checkbox-list popover for one column's "▾" filter button — every
// distinct value currently in use across ALL projects (not narrowed by any
// other active filter; each column's list is independent, simpler than
// Excel's cross-narrowing behavior and avoids a recursive-filtering class
// of bugs for what's a fairly small table). A blank/missing value gets its
// own "(Blank)" entry rather than being silently dropped from the list.
function projectColumnFilterMenuHtml(key){
  const accessor = PROJECT_FILTER_ACCESSORS[key];
  const filterableProjects = projects.filter(isProjectCurrentlyVisible);
  const allValues = Array.from(new Set(filterableProjects.map(accessor))).sort((a, b) => {
    return key === 'productCount' ? Number(a) - Number(b) : a.localeCompare(b);
  });
  const activeFilter = projectColumnFilters[key];
  const isChecked = v => !activeFilter || activeFilter.has(v);
  const allChecked = !activeFilter;
  return `
    <div class="proj-col-filter-menu" data-filter-menu="${key}">
      <label class="proj-col-filter-item proj-col-filter-selectall">
        <input type="checkbox" class="filter-select-all" ${allChecked ? 'checked' : ''}>
        <b>(Select All)</b>
      </label>
      <div class="proj-col-filter-values">
        ${allValues.map(v => `
          <label class="proj-col-filter-item">
            <input type="checkbox" class="filter-value-cb" value="${escapeHtml(v)}" ${isChecked(v) ? 'checked' : ''}>
            ${v === '' ? '<i>(Blank)</i>' : escapeHtml(v)}
          </label>
        `).join('')}
      </div>
      ${activeFilter ? `<button type="button" class="btn btn-sm proj-col-filter-clear" data-clear-filter="${key}" style="margin-top:6px;width:100%;">Clear filter</button>` : ''}
    </div>
  `;
}
// Same popover shell as projectColumnFilterMenuHtml above (reuses its
// data-filter-menu="pdWorkloadStatus" key so it gets the exact same
// open/close/reopen-after-render behavior for free), but backed by
// responsibleStatusFilters instead of projectColumnFilters -- see that
// state's own comment for why it's kept separate from the table's status
// column filter. Wired by its own dedicated handlers (not the generic
// PROJECT_FILTER_ACCESSORS-driven loop) since there's no table column
// behind this one.
function pdWorkloadStatusFilterMenuHtml(){
  const isChecked = s => !responsibleStatusFilters.size || responsibleStatusFilters.has(s);
  return `
    <div class="proj-col-filter-menu" data-filter-menu="pdWorkloadStatus">
      <label class="proj-col-filter-item proj-col-filter-selectall">
        <input type="checkbox" class="pd-status-select-all" ${!responsibleStatusFilters.size ? 'checked' : ''}>
        <b>(Select All)</b>
      </label>
      <div class="proj-col-filter-values">
        ${PROJECT_STATUSES.map(s => `
          <label class="proj-col-filter-item">
            <input type="checkbox" class="pd-status-cb" value="${escapeHtml(s)}" ${isChecked(s) ? 'checked' : ''}>
            ${escapeHtml(s)}
          </label>
        `).join('')}
      </div>
      ${responsibleStatusFilters.size ? `<button type="button" class="btn btn-sm" id="pdWorkloadStatusClear" style="margin-top:6px;width:100%;">Clear filter</button>` : ''}
    </div>
  `;
}
function sortableProjectHeader(label, key){
  const active = projectSortKey === key;
  const arrow = active ? icon(projectSortDir === 'asc' ? 'chevron-up' : 'chevron-down', 12) : '';
  const hasFilter = !!projectColumnFilters[key];
  return `
    <th class="proj-th-sortable${active ? ' active' : ''}" data-col="${key}">
      <span class="proj-th-label" data-sort-key="${key}">${escapeHtml(label)} ${arrow}</span>
      <button type="button" class="proj-th-filter-btn${hasFilter ? ' active' : ''}" data-filter-trigger="${key}" title="Filter ${escapeHtml(label)}">${icon('chevron-down', 12)}</button>
      ${projectColumnFilterMenuHtml(key)}
    </th>
  `;
}

// Which projects-table columns can be hidden via the "Columns" picker —
// Project (name), the expand arrow, and the Edit/Delete actions column are
// left out on purpose: hiding the row's own identity or its only actions
// would make the table useless rather than just less cluttered.
// PROJECT_TABLE_TOTAL_COLUMNS is every <th>/<td> the summary row actually
// has (including those 3 non-toggleable ones) — used to size the expanded
// detail row's colspan (see projectDetailColspan below) so it always spans
// exactly however many columns are currently visible.
const PROJECT_TOGGLE_COLUMNS = [
  { key: 'photo', label: 'Photo' },
  { key: 'status', label: 'Status' },
  { key: 'requestDate', label: 'Requested' },
  { key: 'customerName', label: 'Customer' },
  { key: 'destinationCountry', label: 'Destination' },
  { key: 'ownerSalesRep', label: 'Owner' },
  { key: 'factorySalesRep', label: 'Factory Rep' },
  { key: 'responsiblePerson', label: 'PD' },
  { key: 'factoryName', label: 'Factory' },
  { key: 'requirements', label: 'Reqs' },
  { key: 'productCount', label: 'Products' }
];
const PROJECT_TABLE_TOTAL_COLUMNS = 14;
const PROJECT_HIDDEN_COLUMNS_KEY = 'forgeProjectHiddenColumns';
let projectHiddenColumns = new Set();
try{
  const saved = JSON.parse(localStorage.getItem(PROJECT_HIDDEN_COLUMNS_KEY) || '[]');
  if(Array.isArray(saved)) projectHiddenColumns = new Set(saved);
}catch(e){ /* ignore corrupt/old localStorage value, just start with nothing hidden */ }
function projectDetailColspan(){
  return PROJECT_TABLE_TOTAL_COLUMNS - projectHiddenColumns.size;
}
// Applies the current hidden-column set to whatever the projects table's
// DOM looks like right now — every [data-col] header/cell gets display:none
// if its key is hidden, and every expanded detail row's colspan is kept in
// sync so it still spans exactly the visible columns (not the full 14).
// Called after every full table rebuild and after each individual toggle,
// so it never needs a full renderProjectsList() just to show/hide a column.
function applyProjectColumnVisibility(){
  document.querySelectorAll('.proj-overview-table [data-col]').forEach(el => {
    el.style.display = projectHiddenColumns.has(el.dataset.col) ? 'none' : '';
  });
  const colspan = projectDetailColspan();
  document.querySelectorAll('.proj-overview-table .proj-detail-row > td[colspan]').forEach(td => {
    td.colSpan = colspan;
  });
}

// The "+ New Project" entry form — shown inline right below the button and
// kept out of the `projects` array (and Firestore) entirely until Save is
// clicked, so just opening the panel never creates a stray blank project.
function renderNewProjectPanel(){
  const panel = document.getElementById('newProjectPanel');
  if(!panel) return;
  if(!newProjectOpen){
    panel.innerHTML = '';
    return;
  }
  panel.innerHTML = `
    <div class="card" style="margin:0 0 16px;background:var(--bg);">
      <div class="requirements-box" style="margin-top:0;">
        <div class="requirements-box-title">Project Information</div>
        <div class="project-header-grid">
          <div class="field" style="margin-bottom:0;">
            <label>Project Name</label>
            <input type="text" id="newProjName" placeholder="e.g. Sunrise Foods Q3 Launch">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Photo (optional)</label>
            <input type="file" id="newProjImageInput" accept="image/*">
            <div style="display:flex;align-items:center;gap:10px;margin-top:6px;">
              <img id="newProjImagePreview" src="${newProjectImage ? escapeHtml(newProjectImage) : ''}" style="${newProjectImage ? '' : 'display:none;'}width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--border);">
              <button type="button" class="btn btn-sm" id="newProjImageRemove" style="${newProjectImage ? '' : 'display:none;'}">Remove photo</button>
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Status</label>
            <select class="proj-select" id="newProjStatus">
              ${PROJECT_STATUSES.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(PROJECT_STATUS_LABELS[s])}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Request Date</label>
            <input type="date" id="newProjRequestDate" value="${escapeHtml(new Date().toISOString().slice(0,10))}">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Start Date</label>
            <input type="date" id="newProjStartDate">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Target / End Date</label>
            <input type="date" id="newProjTargetEndDate">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Customer Name</label>
            <input type="text" id="newProjCustomer" list="customerDatalist" placeholder="e.g. ABC Trading Co.">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Destination Country</label>
            <input type="text" id="newProjDestination" list="destinationDatalist" placeholder="e.g. Japan">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Project Owner</label>
            <input type="text" id="newProjOwner" list="salesRepDatalist" placeholder="e.g. Somchai">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Factory Sales Rep</label>
            <input type="text" id="newProjFactoryRep" list="salesRepDatalist" placeholder="e.g. Preecha">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Responsible Person (PD)</label>
            <input type="text" id="newProjResponsible" list="salesRepDatalist" placeholder="e.g. Kanya">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Factory</label>
            <input type="text" id="newProjFactory" list="customerDatalist" placeholder="e.g. Rayong Plant 2">
          </div>
        </div>
      </div>
      <div class="requirements-box">
        <div class="requirements-box-title">Requirements</div>
        <div class="field" style="margin-bottom:8px;">
          <label>Idea / Reference Images (optional, up to ${PROJ_REF_IMAGE_MAX})</label>
          ${projRefImagesHtml(referenceImagesEditing, true)}
          ${referenceImagesEditing.length < PROJ_REF_IMAGE_MAX ? `<input type="file" class="proj-ref-image-input" accept="image/*">` : ''}
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Product</label>
          <div class="flavor-table-scroll">
          <table class="flavor-table flavor-table-edit">
            <thead><tr><th>Product</th><th>Sample Qty</th><th>Unit</th><th>Sample Request Date</th><th>Target Price</th><th>Actual Price</th><th>Currency</th><th>Per</th><th>Formula / Reference No.</th><th>Note</th><th></th></tr></thead>
            <tbody class="proj-flavors-tbody">${newProjectFlavors.map(f => `
              <tr data-flavor-id="${escapeHtml(f.id)}">
                <td><input type="text" class="flavor-name" value="${escapeHtml(f.name||'')}" placeholder="e.g. Red bean"></td>
                <td><input type="number" class="flavor-sample-qty" value="${escapeHtml(f.sampleQty||'')}" step="any" min="0" placeholder="e.g. 50"></td>
                <td><input type="text" class="flavor-sample-qty-unit" list="unitsDatalist" value="${escapeHtml(f.sampleQtyUnit||'')}" placeholder="e.g. pcs"></td>
                <td><input type="date" class="flavor-sample-request-date" value="${escapeHtml(f.sampleRequestDate||'')}"></td>
                <td><input type="number" class="flavor-target-price" value="${escapeHtml(f.targetPrice||'')}" step="any" min="0"></td>
                <td><input type="number" class="flavor-actual-price" value="${escapeHtml(f.actualPrice||'')}" step="any" min="0"></td>
                <td><select class="proj-select flavor-currency">${CURRENCY_OPTIONS.map(c => `<option value="${c}" ${c === (f.priceCurrency || 'THB') ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
                <td><input type="text" class="flavor-unit" list="unitsDatalist" value="${escapeHtml(f.priceUnit || 'kg')}" placeholder="unit"></td>
                <td><input type="text" class="flavor-formula-ref" value="${escapeHtml(f.formulaRefCode||'')}" placeholder="e.g. JPN01-25"></td>
                <td><input type="text" class="flavor-note" value="${escapeHtml(f.note||'')}" placeholder="Note"></td>
                <td><button type="button" class="icon-btn" title="Delete this product" data-role="remove-flavor">${icon('x')}</button></td>
              </tr>
            `).join('')}</tbody>
          </table>
          </div>
          <button type="button" class="btn btn-sm add-row-btn" data-role="add-flavor">+ Add Product</button>
        </div>
        <div class="project-header-grid" style="margin-bottom:8px;">
          <div class="field" style="margin-bottom:0;">
            <label>Portion Weight</label>
            <div class="combo-row">
              <input type="number" id="newProjPortionQty" placeholder="e.g. 20" step="any" min="0">
              <input type="text" id="newProjPortionUnit" list="unitsDatalist" placeholder="e.g. g">
              <span>/</span>
              <input type="text" id="newProjPortionPerUnit" list="unitsDatalist" placeholder="e.g. pcs">
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Inner Packing</label>
            <div class="combo-row">
              <input type="number" id="newProjInnerQty" placeholder="e.g. 30" step="any" min="0">
              <input type="text" id="newProjInnerWeightUnit" list="unitsDatalist" placeholder="e.g. g">
              <span>/</span>
              <input type="text" id="newProjInnerPackUnit" list="unitsDatalist" placeholder="e.g. pack">
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Outer Packing</label>
            <div class="combo-row">
              <input type="number" id="newProjOuterQty" placeholder="e.g. 24" step="any" min="0">
              <input type="text" id="newProjOuterPackUnit" list="unitsDatalist" placeholder="e.g. pack">
              <span>/</span>
              <input type="text" id="newProjOuterContainerUnit" list="unitsDatalist" placeholder="e.g. carton">
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>MOQ</label>
            <div class="combo-row">
              <input type="number" id="newProjMoqQty" placeholder="e.g. 500" step="any" min="0">
              <input type="text" id="newProjMoqUnit" list="unitsDatalist" placeholder="e.g. pcs">
            </div>
          </div>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Packaging condition</label>
          <textarea id="newProjReqPackaging" placeholder="e.g. Microwaveable black plastic tray"></textarea>
        </div>
        <div class="project-header-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:8px;">
          <div class="field" style="margin-bottom:0;">
            <label>Storage Condition</label>
            <input type="text" id="newProjReqStorageCondition" list="storageConditionDatalist" placeholder="e.g. Keep frozen at -18°C">
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Shelf Life (from production date)</label>
            <input type="text" id="newProjReqShelfLife" placeholder="e.g. 12 months">
          </div>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Composition</label>
          <textarea id="newProjReqComposition" placeholder="e.g. Teriyaki Sauce: Soy Sauce 40%, Mirin 25%, Sugar 20%, Sake 15%"></textarea>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Recipe</label>
          <textarea id="newProjReqRecipe" placeholder="Reference / attachment notes"></textarea>
          <div class="mu-attachments-editor proj-recipe-attachments" style="margin-top:8px;">
            <div class="mu-attachments-chiplist"></div>
            <label class="btn btn-sm mu-attach-btn">${icon('paperclip', 14)} Attach file/photo<input type="file" class="mu-attach-input" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv" multiple style="display:none;"></label>
          </div>
        </div>
        <div class="field requirements-box-divider-below" style="margin-bottom:8px;">
          <label>Cooking Guidelines</label>
          <div class="cooking-guidelines-editor">${cookingGuidelinesEditing.map((g, gi) => `
            <div class="cooking-guideline-group" data-group-idx="${gi}" style="${gi < cookingGuidelinesEditing.length - 1 ? 'margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border);' : ''}">
              <div style="display:flex;gap:8px;align-items:center;">
                <input type="text" class="proj-req-cooking-method" list="cookingMethodDatalist" value="${escapeHtml(g.method)}" placeholder="e.g. Microwave" style="flex:1;">
                ${cookingGuidelinesEditing.length > 1 ? `<button type="button" class="icon-btn" data-role="remove-cooking-guideline" title="Remove this guideline">${icon('x')}</button>` : ''}
              </div>
              <div style="margin-top:8px;">
                ${trialStringListHtml(g.steps, true, 'proj-cooking-step-input', 'cooking-step', 'e.g. Reheat from frozen, 2-3 minutes')}
              </div>
            </div>
          `).join('')}</div>
          <button type="button" class="btn btn-sm add-row-btn" data-role="add-cooking-guideline">+ Add Cooking Guidelines</button>
        </div>
        <div class="field" style="margin-bottom:8px;">
          <label>Note</label>
          <textarea id="newProjReqNote" placeholder="Anything else not covered above"></textarea>
        </div>
        <div class="field requirements-box-divider" style="margin-bottom:0;">
          <label>Certificate</label>
          ${certificateChecklistHtml(blankCertificate(), true)}
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn btn-primary btn-sm" id="btnSaveNewProject">${icon('save')} Save</button>
        <button class="btn btn-sm proj-action-cancel" id="btnCancelNewProject">${icon('undo-2')} Cancel</button>
      </div>
    </div>
  `;

  const imageInput = document.getElementById('newProjImageInput');
  const imagePreview = document.getElementById('newProjImagePreview');
  const imageRemoveBtn = document.getElementById('newProjImageRemove');
  imageInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if(!file) return;
    try{
      newProjectImage = await resizeImageFile(file, 400);
      imagePreview.src = newProjectImage;
      imagePreview.style.display = 'block';
      imageRemoveBtn.style.display = 'inline-flex';
    }catch(err){
      alert(err.message || 'Could not read that image file');
    }
  });
  imageRemoveBtn.addEventListener('click', () => {
    newProjectImage = '';
    imageInput.value = '';
    imagePreview.src = '';
    imagePreview.style.display = 'none';
    imageRemoveBtn.style.display = 'none';
  });

  // Same customer-country auto-fill as the edit-row form (see the
  // .proj-customer 'change' listener below) — kept as a separate, small
  // duplicate here since this panel isn't part of the projects table.
  document.getElementById('newProjCustomer').addEventListener('change', e => {
    const match = metaLists.customers.find(c => metaItemName(c) === e.target.value.trim());
    if(match && match.country){
      document.getElementById('newProjDestination').value = match.country;
    }
  });

  // Cooking Guidelines: one or more groups, each its own Method + Steps
  // list (see cookingGuidelinesEditing) -- every group's controls are
  // queried scoped to that group's own container so the same
  // add/remove-step data-role can repeat across groups without
  // colliding. Picking a Cooking Method that has Steps on file pulls
  // them in as a starting point for that group, same as before.
  panel.querySelectorAll('.cooking-guideline-group').forEach((groupEl, gi) => {
    const group = cookingGuidelinesEditing[gi];
    if(!group) return;
    groupEl.querySelector('.proj-req-cooking-method').addEventListener('change', e => {
      group.method = e.target.value.trim();
      const match = metaLists.cookingMethods.find(m => metaItemName(m) === group.method);
      if(match && (match.steps || []).length){
        group.steps = [...match.steps];
      }
      renderNewProjectPanel();
    });
    groupEl.querySelector('[data-role="add-cooking-step"]')?.addEventListener('click', () => {
      group.steps.push('');
      renderNewProjectPanel();
    });
    groupEl.querySelectorAll('[data-role="remove-cooking-step"]').forEach(btn => {
      btn.addEventListener('click', () => {
        group.steps.splice(parseInt(btn.dataset.idx, 10), 1);
        renderNewProjectPanel();
      });
    });
    groupEl.querySelectorAll('.proj-cooking-step-input').forEach((inp, idx) => {
      inp.addEventListener('change', () => { group.steps[idx] = inp.value.trim(); });
    });
    groupEl.querySelector('[data-role="remove-cooking-guideline"]')?.addEventListener('click', () => {
      cookingGuidelinesEditing.splice(gi, 1);
      renderNewProjectPanel();
    });
  });
  panel.querySelector('[data-role="add-cooking-guideline"]')?.addEventListener('click', () => {
    cookingGuidelinesEditing.push(blankCookingCondition());
    renderNewProjectPanel();
  });
  wireCertificateChecklist(panel);

  // Idea / Reference Images -- same upload/remove/caption wiring as the
  // main edit form, scoped to this panel and sharing the same
  // referenceImagesEditing staged array.
  panel.querySelector('.proj-ref-image-input')?.addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if(!file || referenceImagesEditing.length >= PROJ_REF_IMAGE_MAX) return;
    try{
      referenceImagesEditing.push(await fileToProjRefImage(file));
      renderNewProjectPanel();
    }catch(err){
      alert(err.message || 'Could not read that image file');
    }
  });
  panel.querySelectorAll('[data-role="remove-ref-image"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = referenceImagesEditing.findIndex(img => img.id === btn.dataset.refImageId);
      if(idx !== -1) referenceImagesEditing.splice(idx, 1);
      renderNewProjectPanel();
    });
  });
  panel.querySelectorAll('.proj-ref-image-caption-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const img = referenceImagesEditing.find(x => x.id === inp.dataset.refImageId);
      if(img) img.caption = inp.value.trim();
    });
  });

  // Recipe attachments -- the same generic editor the main edit form's
  // Recipe field uses, pointed at the same staged recipeAttachmentsEditing
  // array so it survives this panel re-rendering (upload/remove) without
  // needing its own bespoke storage.
  const recipeAttachEditorEl = panel.querySelector('.proj-recipe-attachments');
  if(recipeAttachEditorEl) wireMuAttachmentEditor(recipeAttachEditorEl, () => recipeAttachmentsEditing);

  // Flavor / Filling table -- same fields/columns as the main edit form,
  // just against newProjectFlavors (no scheduleProjectSave -- there's no
  // real project to save until the Save button below creates one).
  panel.querySelectorAll('.proj-flavors-tbody tr[data-flavor-id]').forEach(row => {
    const flavorId = row.dataset.flavorId;
    const flavor = newProjectFlavors.find(x => x.id === flavorId);
    if(!flavor) return;
    row.querySelector('.flavor-name').addEventListener('change', e => { flavor.name = e.target.value.trim(); });
    row.querySelector('.flavor-sample-qty').addEventListener('change', e => { flavor.sampleQty = e.target.value.trim(); });
    row.querySelector('.flavor-sample-qty-unit').addEventListener('change', e => { flavor.sampleQtyUnit = e.target.value.trim(); });
    row.querySelector('.flavor-sample-request-date').addEventListener('change', e => { flavor.sampleRequestDate = e.target.value; });
    row.querySelector('.flavor-target-price').addEventListener('change', e => { flavor.targetPrice = e.target.value.trim(); });
    row.querySelector('.flavor-actual-price').addEventListener('change', e => { flavor.actualPrice = e.target.value.trim(); });
    row.querySelector('.flavor-formula-ref').addEventListener('change', e => { flavor.formulaRefCode = e.target.value.trim(); });
    row.querySelector('.flavor-note').addEventListener('change', e => { flavor.note = e.target.value.trim(); });
    row.querySelector('.flavor-currency').addEventListener('change', e => { flavor.priceCurrency = e.target.value; });
    row.querySelector('.flavor-unit').addEventListener('change', e => { flavor.priceUnit = e.target.value.trim(); });
    selectTextOnFocus(row.querySelector('.flavor-sample-qty-unit'));
    selectTextOnFocus(row.querySelector('.flavor-unit'));
    row.querySelector('[data-role="remove-flavor"]').addEventListener('click', () => {
      newProjectFlavors = newProjectFlavors.filter(x => x.id !== flavorId);
      renderNewProjectPanel();
    });
  });
  panel.querySelector('[data-role="add-flavor"]')?.addEventListener('click', () => {
    newProjectFlavors.push(blankFlavor());
    renderNewProjectPanel();
  });

  document.getElementById('btnCancelNewProject').addEventListener('click', () => {
    newProjectOpen = false;
    newProjectImage = '';
    cookingGuidelinesEditing = [blankCookingCondition()];
    referenceImagesEditing = [];
    recipeAttachmentsEditing = [];
    newProjectFlavors = [];
    renderNewProjectPanel();
  });

  document.getElementById('btnSaveNewProject').addEventListener('click', () => {
    const p = blankProject();
    p.name = document.getElementById('newProjName').value.trim();
    p.image = newProjectImage;
    p.status = document.getElementById('newProjStatus').value;
    p.requestDate = document.getElementById('newProjRequestDate').value;
    p.startDate = document.getElementById('newProjStartDate').value;
    p.targetEndDate = document.getElementById('newProjTargetEndDate').value;
    p.customerName = document.getElementById('newProjCustomer').value.trim();
    p.destinationCountry = document.getElementById('newProjDestination').value.trim();
    p.ownerSalesRep = document.getElementById('newProjOwner').value.trim();
    p.factorySalesRep = document.getElementById('newProjFactoryRep').value.trim();
    p.responsiblePerson = document.getElementById('newProjResponsible').value.trim();
    p.factoryName = document.getElementById('newProjFactory').value.trim();
    p.portionWeightQty = document.getElementById('newProjPortionQty').value.trim();
    p.portionWeightUnit = document.getElementById('newProjPortionUnit').value.trim();
    p.portionPerUnit = document.getElementById('newProjPortionPerUnit').value.trim();
    p.innerPackQty = document.getElementById('newProjInnerQty').value.trim();
    p.innerPackWeightUnit = document.getElementById('newProjInnerWeightUnit').value.trim();
    p.innerPackUnit = document.getElementById('newProjInnerPackUnit').value.trim();
    p.outerPackQty = document.getElementById('newProjOuterQty').value.trim();
    p.outerPackUnit = document.getElementById('newProjOuterPackUnit').value.trim();
    p.outerPackContainerUnit = document.getElementById('newProjOuterContainerUnit').value.trim();
    p.moqQty = document.getElementById('newProjMoqQty').value.trim();
    p.moqUnit = document.getElementById('newProjMoqUnit').value.trim();
    p.flavors = newProjectFlavors;
    p.requirements = {
      // No longer an editable field on this panel either (the Flavor /
      // Filling table above now covers this, same as the main edit form) --
      // left blank rather than removed from the data shape, matching how
      // the main edit form preserves an existing project's old value.
      flavorFilling: '',
      composition: document.getElementById('newProjReqComposition').value.trim(),
      recipe: document.getElementById('newProjReqRecipe').value.trim(),
      packagingCondition: document.getElementById('newProjReqPackaging').value.trim(),
      storageCondition: document.getElementById('newProjReqStorageCondition').value.trim(),
      shelfLife: document.getElementById('newProjReqShelfLife').value.trim(),
      cookingCondition: [...panel.querySelectorAll('.cooking-guideline-group')].map(g => ({
        method: g.querySelector('.proj-req-cooking-method').value.trim(),
        steps: [...g.querySelectorAll('.proj-cooking-step-input')].map(el => el.value.trim()).filter(Boolean)
      })),
      certificate: readCertificateChecklist(panel.querySelector('.proj-cert-wrap')),
      note: document.getElementById('newProjReqNote').value.trim(),
      referenceImages: referenceImagesEditing,
      recipeAttachments: recipeAttachmentsEditing
    };
    projects.push(p);
    saveProjectToCloud(p);
    logActivityEvent('created', 'project', p.name || 'Untitled project');
    newProjectOpen = false;
    newProjectImage = '';
    cookingGuidelinesEditing = [blankCookingCondition()];
    referenceImagesEditing = [];
    recipeAttachmentsEditing = [];
    newProjectFlavors = [];
    projectEditingId = p.id;
    projectExpandedIds.add(p.id);
    renderNewProjectPanel();
    renderProjectsList();
  });
}

// Wires up a click handler shared by both kinds of clickable element inside
// the "Projects by Status" card: a project's own photo (jump to + expand
// that one project) and a status bar/row (filter the table to that status).
// Called once after every dashboardContainer rebuild, same as the Gantt
// chart's own click wiring right above it.
function wireProjectsByStatusCardClicks(dashboardContainer){
  dashboardContainer.querySelectorAll('[data-gallery-project-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.galleryProjectId;
      projectExpandedIds.add(id);
      renderProjectsList();
      document.querySelector(`tbody[data-project-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
  dashboardContainer.querySelectorAll('[data-status-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      projectColumnFilters = { ...projectColumnFilters, status: new Set([btn.dataset.statusFilter]) };
      renderProjectsList();
      document.getElementById('projectsList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  dashboardContainer.querySelectorAll('[data-responsible-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      projectColumnFilters = { ...projectColumnFilters, responsiblePerson: new Set([btn.dataset.responsibleFilter]) };
      renderProjectsList();
      document.getElementById('projectsList')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  // "Status" popover on the Responsible Person (PD) card — which
  // statuses count toward each person's workload total. Same
  // open/close/stay-open-across-re-renders wiring as the table's own
  // column filters (see the [data-filter-trigger]/[data-filter-menu]
  // loops above), just against responsibleStatusFilters instead of
  // projectColumnFilters since there's no table column behind it.
  dashboardContainer.querySelectorAll('[data-filter-trigger]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key = btn.dataset.filterTrigger;
      openProjectFilterMenuKey = openProjectFilterMenuKey === key ? null : key;
      dashboardContainer.querySelectorAll('[data-filter-menu]').forEach(m => {
        m.classList.toggle('open', m.dataset.filterMenu === openProjectFilterMenuKey);
      });
    });
  });
  const pdStatusMenu = dashboardContainer.querySelector('[data-filter-menu="pdWorkloadStatus"]');
  if(pdStatusMenu){
    if(openProjectFilterMenuKey === 'pdWorkloadStatus') pdStatusMenu.classList.add('open');
    pdStatusMenu.addEventListener('click', e => e.stopPropagation());
    const allStatuses = PROJECT_STATUSES;
    const selectAllCb = pdStatusMenu.querySelector('.pd-status-select-all');
    selectAllCb.addEventListener('change', () => {
      responsibleStatusFilters = selectAllCb.checked ? new Set() : new Set(allStatuses);
      renderProjectsList();
    });
    pdStatusMenu.querySelectorAll('.pd-status-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const current = new Set(responsibleStatusFilters.size ? responsibleStatusFilters : allStatuses);
        if(cb.checked) current.add(cb.value); else current.delete(cb.value);
        responsibleStatusFilters = current.size === allStatuses.length ? new Set() : current;
        renderProjectsList();
      });
    });
    pdStatusMenu.querySelector('#pdWorkloadStatusClear')?.addEventListener('click', () => {
      responsibleStatusFilters = new Set();
      renderProjectsList();
    });
  }
}

// A horizontal timeline bar per project running from Start Date to Target/
// End Date, colored by status (same palette as the photo gallery ring).
// Always reflects ALL projects (not the search/status filter), same as the
// rest of the dashboard summary above the table. Projects missing either
// date are simply left off the chart — there's no meaningful bar to draw
// for them, and forcing a fallback (e.g. Request Date as a stand-in) would
// misrepresent a project that was never actually scheduled.
function renderProjectGanttChart(){
  const container = document.getElementById('projectGanttChart');
  if(!container) return;
  const withDates = projects
    .filter(p => p.startDate && p.targetEndDate && isProjectCurrentlyVisible(p))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  if(!withDates.length){
    container.innerHTML = `
      <div class="dash-card-title">Project Timeline</div>
      <div class="dash-empty">No projects have both a Start Date and Target/End Date yet — add them in a project's details to see the Gantt chart here</div>
    `;
    return;
  }

  const DAY = 86400000;
  const PX_PER_DAY = 8;
  const ROW_H = 30;
  const toTime = s => new Date(s + 'T00:00:00').getTime();
  const minStart = Math.min(...withDates.map(p => toTime(p.startDate)));
  const maxEnd = Math.max(...withDates.map(p => toTime(p.targetEndDate)));
  // Pad both ends by a few days so the first/last bar isn't flush against
  // the chart edge, and guard a tiny (or single-project, same-day) range
  // from producing a near-zero-width timeline.
  const rangeStart = minStart - 3 * DAY;
  const rangeEnd = Math.max(maxEnd + 3 * DAY, rangeStart + 14 * DAY);
  const totalDays = Math.ceil((rangeEnd - rangeStart) / DAY);
  const timelineWidth = totalDays * PX_PER_DAY;
  const xOf = t => Math.round((t - rangeStart) / DAY * PX_PER_DAY);

  // Month tick marks across the padded range, snapped to the 1st of each
  // month so labels land on a predictable, evenly-spaced grid.
  const months = [];
  const cursor = new Date(rangeStart);
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  while(cursor.getTime() <= rangeEnd){
    months.push(new Date(cursor.getTime()));
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const now = Date.now();
  const showToday = now >= rangeStart && now <= rangeEnd;
  const gridlinesHtml = months.map(m => `<div class="gantt-gridline" style="left:${xOf(m.getTime())}px"></div>`).join('')
    + (showToday ? `<div class="gantt-today-line" style="left:${xOf(now)}px" title="Today"></div>` : '');
  const monthLabelsHtml = months.map(m => `<div class="gantt-month-label" style="left:${xOf(m.getTime())}px">${escapeHtml(m.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }))}</div>`).join('');

  const barsHtml = withDates.map((p, i) => {
    const left = xOf(toTime(p.startDate));
    const width = Math.max(4, xOf(toTime(p.targetEndDate)) - left);
    const color = projectPhotoStatusColor(p.status);
    const name = p.name || 'Untitled project';
    return `<div class="gantt-bar" data-gantt-project-id="${escapeHtml(p.id)}" style="top:${i * ROW_H + 5}px;left:${left}px;width:${width}px;background:${color};" title="${escapeHtml(name)} — ${escapeHtml(p.startDate)} → ${escapeHtml(p.targetEndDate)}"></div>`;
  }).join('');
  const labelsHtml = withDates.map(p => `<div class="gantt-label-row" data-gantt-project-id="${escapeHtml(p.id)}" style="height:${ROW_H}px;" title="${escapeHtml(p.name || 'Untitled project')}">${escapeHtml(p.name || 'Untitled project')}</div>`).join('');

  container.innerHTML = `
    <div class="dash-card-title">Project Timeline</div>
    <div class="gantt-body">
      <div class="gantt-labels">
        <div class="gantt-labels-header"></div>
        ${labelsHtml}
      </div>
      <div class="gantt-scroll">
        <div class="gantt-timeline" style="width:${timelineWidth}px;">
          <div class="gantt-timeline-header">${monthLabelsHtml}</div>
          <div class="gantt-timeline-body" style="height:${withDates.length * ROW_H}px;">
            ${gridlinesHtml}
            ${barsHtml}
          </div>
        </div>
      </div>
    </div>
  `;

  container.querySelectorAll('[data-gantt-project-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.ganttProjectId;
      projectExpandedIds.add(id);
      renderProjectsList();
      document.querySelector(`tbody[data-project-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

export function renderProjectsList(){
  const container = document.getElementById('projectsList');
  const dashboardContainer = document.getElementById('projectsDashboard');
  if(!container) return;
  // Everyone defaults to only their own projects (by name match against
  // Owner/Factory Rep/Responsible Person/product Sales Rep/Activities
  // Updates Who fields, see projectMatchesName in app.js) plus the
  // Unassigned bucket, which always stays visible to everyone. The Who
  // filter (projectVisibilityWho, see renderProjectWhoFilter) lets them
  // add specific colleagues' projects too within the same session,
  // without changing what a fresh login defaults back to.
  const visibleProjects = projects.filter(isProjectCurrentlyVisible);
  if(visibleProjects.length === 0){
    if(dashboardContainer) dashboardContainer.innerHTML = '';
    container.innerHTML = '<div class="overview-empty">No projects yet — click "+ New Project" above to start one</div>';
    return;
  }

  // The search box lives outside both #projectsDashboard and #projectsList
  // (a sibling, static element) so re-rendering these containers on every
  // keystroke never destroys/recreates the input itself — the cursor and
  // focus just stay put, same trick the recipe sidebar search already uses.
  const searchQuery = (document.getElementById('projectSearchInput')?.value || '').trim().toLowerCase();
  const matchesSearch = p => {
    if(!searchQuery) return true;
    const haystack = [
      p.name, p.customerName, p.destinationCountry, p.ownerSalesRep,
      p.factorySalesRep, p.responsiblePerson, p.factoryName,
      p.status || PROJECT_STATUSES[0]
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(searchQuery);
  };
  // Excel-style per-column value filters (see the "▾" button on every
  // sortable header) — a column only shows up here once at least one of
  // its values has been unchecked; an absent key means "show everything"
  // for that column, same idea as the old "All statuses"-style dropdowns
  // this replaced.
  const matchesColumnFilters = p => Object.entries(projectColumnFilters).every(([key, allowed]) => {
    const accessor = PROJECT_FILTER_ACCESSORS[key];
    return accessor ? allowed.has(accessor(p)) : true;
  });
  const sorted = visibleProjects.filter(p => matchesSearch(p) && matchesColumnFilters(p)).sort(compareProjects);

  // Dashboard summary always reflects ALL *visible* projects (not the
  // search filter) — searching narrows the table below, not the overview
  // stats above it.
  const allProductsGlobal = visibleProjects.flatMap(pr => pr.products || []);
  const productsByStage = PROJECT_STAGES
    .map(stage => ({ label: stage, count: allProductsGlobal.filter(x => x.stage === stage).length }))
    .filter(g => g.count > 0);
  const projectsByStatus = PROJECT_STATUSES
    .map(status => ({ label: status, count: visibleProjects.filter(pr => (pr.status || PROJECT_STATUSES[0]) === status).length }))
    .filter(g => g.count > 0);
  // Workload-by-person overview -- how many projects each Responsible
  // Person (PD) currently has, plus a highlighted group for projects with
  // no PD set at all so gaps are easy to spot. Grouped from the raw
  // responsiblePerson value (key) separately from its display label,
  // since the empty-string key needs to round-trip through the column
  // filter click below exactly the way PROJECT_FILTER_ACCESSORS.
  // responsiblePerson already treats "no PD" elsewhere in this file.
  const responsibleCounts = new Map();
  visibleProjects
    .filter(p => !responsibleStatusFilters.size || responsibleStatusFilters.has(p.status || PROJECT_STATUSES[0]))
    .forEach(p => {
      // Matches PROJECT_FILTER_ACCESSORS.responsiblePerson exactly (no
      // trim) so a click-to-filter here lands on the same set of projects
      // the column filter itself would show.
      const key = PROJECT_FILTER_ACCESSORS.responsiblePerson(p);
      responsibleCounts.set(key, (responsibleCounts.get(key) || 0) + 1);
    });
  const projectsByResponsible = Array.from(responsibleCounts.entries())
    .map(([key, count]) => ({ key, label: key || '(Not assigned)', count }))
    .sort((a, b) => {
      if((a.key === '') !== (b.key === '')) return a.key === '' ? -1 : 1;
      return b.count - a.count || a.label.localeCompare(b.label);
    });
  if(dashboardContainer){
    dashboardContainer.innerHTML = `
      <div class="dash-metrics" style="margin-bottom:14px;">
        <div class="dash-metric">
          <div class="dash-metric-label">Projects</div>
          <div class="dash-metric-value">${visibleProjects.length}</div>
        </div>
        <div class="dash-metric">
          <div class="dash-metric-label">Products</div>
          <div class="dash-metric-value">${allProductsGlobal.length}</div>
        </div>
      </div>
      <div class="dash-card" style="margin-bottom:16px;">
        <div class="dash-card-title">Projects by Status</div>
        ${renderStatusBarList(projectsByStatus)}
      </div>
      <div class="dash-card" style="margin-bottom:16px;">
        <div class="dash-card-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span>Projects by Responsible Person (PD)</span>
          <div class="task-tracking-who-filter-wrap">
            <button type="button" class="btn btn-sm${responsibleStatusFilters.size ? ' active' : ''}" data-filter-trigger="pdWorkloadStatus" title="Choose which statuses count toward these totals">
              Status${responsibleStatusFilters.size ? ` (${responsibleStatusFilters.size})` : ''} ${icon('chevron-down', 12)}
            </button>
            ${pdWorkloadStatusFilterMenuHtml()}
          </div>
        </div>
        ${renderResponsibleBarList(projectsByResponsible)}
      </div>
      <div class="dash-card" style="margin-bottom:16px;">
        <div class="dash-card-title">Products by stage</div>
        ${renderBarList(productsByStage)}
      </div>
      <div class="dash-card" style="margin-bottom:16px;" id="projectGanttChart"></div>
    `;
    renderProjectGanttChart();
    wireProjectsByStatusCardClicks(dashboardContainer);
  }

  if(sorted.length === 0){
    const q = document.getElementById('projectSearchInput').value.trim();
    const label = q ? `No projects match "${escapeHtml(q)}"` : 'No projects match the selected filters';
    const hasColumnFilters = Object.keys(projectColumnFilters).length > 0;
    // Zero matches means the table (and with it, every column's own "▾"
    // filter button, the only other place a filter can be cleared from)
    // doesn't render at all -- with no active filters left visible
    // anywhere, there was no way back to a non-empty view short of
    // reloading the page. A blanket "Clear filters" right here covers
    // both filter kinds (column filters and the search box) at once.
    container.innerHTML = `
      <div class="overview-empty">
        ${label}
        ${(q || hasColumnFilters) ? `<div style="margin-top:10px;"><button type="button" class="btn btn-sm" id="btnClearAllProjectFilters">Clear filters</button></div>` : ''}
      </div>
    `;
    document.getElementById('btnClearAllProjectFilters')?.addEventListener('click', () => {
      projectColumnFilters = {};
      const searchInput = document.getElementById('projectSearchInput');
      searchInput.value = '';
      document.getElementById('btnClearProjectSearch').style.display = 'none';
      renderProjectsList();
    });
    return;
  }

  // Empty-value marker for the overview table — a plain blank cell reads as
  // "nothing to report", but a project missing Customer/Destination/etc. is
  // usually a data gap that needs following up on, so it's flagged in
  // --danger red instead of just left blank.
  const missingCell = v => v ? escapeHtml(v) : '<span class="proj-missing" title="Missing">—</span>';

  container.innerHTML = `
    <div class="proj-table-scroll">
    <table class="proj-overview-table">
      <thead>
        <tr>
          <th></th>
          <th data-col="photo">Photo</th>
          ${sortableProjectHeader('Project', 'name')}
          ${sortableProjectHeader('Status', 'status')}
          ${sortableProjectHeader('Requested', 'requestDate')}
          ${sortableProjectHeader('Customer', 'customerName')}
          ${sortableProjectHeader('Destination', 'destinationCountry')}
          ${sortableProjectHeader('Owner', 'ownerSalesRep')}
          ${sortableProjectHeader('Factory Rep', 'factorySalesRep')}
          ${sortableProjectHeader('PD', 'responsiblePerson')}
          ${sortableProjectHeader('Factory', 'factoryName')}
          <th data-col="requirements">Reqs</th>
          ${sortableProjectHeader('Products', 'productCount')}
          <th class="proj-actions-cell"></th>
        </tr>
      </thead>
      ${sorted.map(p => {
        const isEditing = p.id === projectEditingId;
        const isExpanded = isEditing || projectExpandedIds.has(p.id);
        const ro = isEditing ? '' : 'readonly';
        const usedRecipeIds = new Set(p.products.map(prod => prod.recipeId));
        const availableRecipes = recipes.filter(r => !usedRecipeIds.has(r.id));
        const activity = [];
        if(p.createdBy) activity.push(`Created by ${escapeHtml(p.createdBy)}${p.createdAt ? ' · ' + escapeHtml(formatActivityDateTime(p.createdAt)) : ''}`);
        if(p.updatedBy && p.updatedAt !== p.createdAt) activity.push(`Last edited by ${escapeHtml(p.updatedBy)}${p.updatedAt ? ' · ' + escapeHtml(formatActivityDateTime(p.updatedAt)) : ''}`);

        // Same edit/view split as the project header above — read-only
        // means read-only, so Sales Rep and Stage show as plain text here
        // too instead of an always-live input/select a viewer could
        // accidentally change without ever clicking Edit.
        const rows = p.products.map(prod => {
          const r = recipes.find(x => x.id === prod.recipeId);
          const label = r
            ? `${escapeHtml(recipeDisplayLabel(r))}${fullCode(r) ? ' · ' + escapeHtml(fullCode(r)) : ''}`
            : '<span style="color:var(--danger);">Recipe not found (deleted?)</span>';
          if(!isEditing){
            return `
              <tr data-product-id="${escapeHtml(prod.id)}">
                <td>${label}</td>
                <td>${escapeHtml(prod.salesRep || '-')}</td>
                <td>${escapeHtml(prod.stage || PROJECT_STAGES[0])}</td>
                <td style="font-size:12px;color:var(--text-dim);white-space:nowrap;">${escapeHtml(formatActivityDateTime(prod.updatedAt) || '')}</td>
                <td style="white-space:nowrap;">
                  <button class="icon-btn" title="Progress log" data-role="open-log">${icon('clock')}</button>
                </td>
              </tr>
            `;
          }
          return `
            <tr data-product-id="${escapeHtml(prod.id)}">
              <td>${label}</td>
              <td><input type="text" class="proj-product-rep" list="salesRepDatalist" value="${escapeHtml(prod.salesRep)}" placeholder="Sales rep"></td>
              <td>
                <select class="proj-select proj-product-stage">
                  ${PROJECT_STAGES.map(s => `<option value="${escapeHtml(s)}" ${s === prod.stage ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
                </select>
              </td>
              <td style="font-size:12px;color:var(--text-dim);white-space:nowrap;">${escapeHtml(formatActivityDateTime(prod.updatedAt) || '')}</td>
              <td style="white-space:nowrap;">
                <button class="icon-btn" title="Progress log" data-role="open-log">${icon('clock')}</button>
                <button class="icon-btn" title="Remove product" data-role="remove-product">${icon('x')}</button>
              </td>
            </tr>
          `;
        }).join('');

        const productCount = p.products.length;
        const req = getRequirements(p);

        // Append-only activity timeline (Plan / Action Taken / Next Action
        // per entry) — separate from the per-product progress log, since
        // this is a project-level summary meant for handing straight to a
        // supervisor, not tied to any one product's pipeline stage. An
        // entry with no Action Taken yet reads as "Planned" (see
        // monthlyUpdateStatus) — normally one auto-created by a previous
        // entry's "Create as Plan automatically" checkbox.
        const rawUpdates = p.monthlyUpdates || [];
        const migratedUpdates = rawUpdates.map(migrateMonthlyUpdate);
        const todayStr = new Date().toISOString().slice(0, 10);
        const monthlyUpdatesHtml = migratedUpdates.length
          ? [...migratedUpdates].sort((a,b) => (b.date||'').localeCompare(a.date||'') || (b.createdAt||0) - (a.createdAt||0)).map((mu, idx, sorted) => {
              if(isEditing && mu.id === monthlyUpdateEditingId){
                return `
                  <div class="mu-entry" data-update-id="${escapeHtml(mu.id)}">
                    <div class="mu-entry-marker"></div>
                    <div class="mu-entry-body">
                      <div class="proj-monthly-add">
                        <div class="mu-plan-box">
                          <div class="mu-plan-box-title">Plan</div>
                          <div class="field">
                            <label>When</label>
                            <div class="mu-when-group">
                              <input type="date" class="proj-mu-edit-date" value="${escapeHtml(mu.date || '')}">
                              <input type="time" class="proj-mu-edit-time" value="${escapeHtml(mu.time || '')}">
                            </div>
                          </div>
                          <div class="field">
                            <label>Person</label>
                            <input type="text" class="proj-mu-edit-who" list="salesRepDatalist" placeholder="e.g. Yano-san" value="${escapeHtml(mu.planWho || '')}">
                          </div>
                          <div class="field">
                            <label>Activity</label>
                            <div class="mu-field-with-translate" style="width:auto;">
                              <textarea class="proj-mu-edit-plan" placeholder="Activity">${escapeHtml(mu.plan || '')}</textarea>
                              <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                            </div>
                          </div>
                          <div class="field">
                            <label>With</label>
                            <input type="text" class="proj-mu-edit-with" list="salesRepDatalist" placeholder="e.g. Tanaka-san" value="${escapeHtml(mu.planWith || '')}">
                          </div>
                          <div class="field">
                            <label>Location / Channel</label>
                            <input type="text" class="proj-mu-edit-where" list="customerDatalist" placeholder="e.g. UMIOS Office" value="${escapeHtml(mu.planWhere || '')}">
                            <select class="proj-select proj-mu-edit-where-location" style="display:none;margin-top:6px;"></select>
                          </div>
                          <div class="field" style="margin-bottom:0;">
                            <label>PD</label>
                            <input type="text" class="proj-mu-edit-owner" list="salesRepDatalist" placeholder="e.g. Yano-san" value="${escapeHtml(mu.planOwner || p.responsiblePerson || '')}">
                          </div>
                        </div>
                        <div class="mu-plan-box">
                          <div class="mu-plan-box-title">Action Taken</div>
                          <div class="field">
                            <label>Action Taken</label>
                            <div class="mu-field-with-translate" style="width:auto;">
                              <textarea class="proj-mu-edit-action" placeholder="Action Taken">${escapeHtml(mu.actionTaken || '')}</textarea>
                              <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                            </div>
                          </div>
                          <div class="field" style="margin-bottom:0;">
                            <label>Completed Date (optional)</label>
                            <input type="date" class="proj-mu-edit-completed-date" value="${escapeHtml(mu.completedDate || '')}" title="Completed date — defaults to today once Action Taken is filled in, edit if it was actually finished on a different day">
                          </div>
                        </div>
                        <div class="mu-plan-box">
                          <div class="mu-plan-box-title">Next Action</div>
                          <div class="field">
                            <label>When</label>
                            <div class="mu-when-group">
                              <input type="date" class="proj-mu-edit-nextaction-due" value="${escapeHtml(mu.nextActionDue || '')}" title="Next Action due date">
                              <input type="time" class="proj-mu-edit-nextaction-time" value="${escapeHtml(mu.nextActionTime || '')}">
                            </div>
                          </div>
                          <div class="field">
                            <label>Person</label>
                            <input type="text" class="proj-mu-edit-nextaction-who" list="salesRepDatalist" placeholder="e.g. Yano-san" value="${escapeHtml(mu.nextActionWho || '')}">
                          </div>
                          <div class="field">
                            <label>Activity</label>
                            <div class="mu-field-with-translate" style="width:auto;">
                              <textarea class="proj-mu-edit-nextaction" placeholder="Activity">${escapeHtml(mu.nextAction || '')}</textarea>
                              <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                            </div>
                          </div>
                          <div class="field">
                            <label>With</label>
                            <input type="text" class="proj-mu-edit-nextaction-with" list="salesRepDatalist" placeholder="e.g. Tanaka-san" value="${escapeHtml(mu.nextActionWith || '')}">
                          </div>
                          <div class="field">
                            <label>Location / Channel</label>
                            <input type="text" class="proj-mu-edit-nextaction-where" list="customerDatalist" placeholder="e.g. UMIOS Office" value="${escapeHtml(mu.nextActionWhere || '')}">
                            <select class="proj-select proj-mu-edit-nextaction-where-location" style="display:none;margin-top:6px;"></select>
                          </div>
                          <div class="field" style="margin-bottom:0;">
                            <label>PD</label>
                            <input type="text" class="proj-mu-edit-nextaction-owner" list="salesRepDatalist" placeholder="e.g. Yano-san" value="${escapeHtml(mu.nextActionOwner || p.responsiblePerson || '')}">
                          </div>
                        </div>
                        <div class="field">
                          <label>Linked Recipe (optional)</label>
                          <select class="proj-select proj-mu-edit-recipe">${muRecipeOptionsHtml(mu.linkedRecipeId)}</select>
                        </div>
                        <div class="field">
                          <label>Attachments (optional)</label>
                          <div class="mu-attachments-editor">
                            <div class="mu-attachments-chiplist"></div>
                            <label class="btn btn-sm mu-attach-btn">${icon('paperclip', 14)} Attach file/photo<input type="file" class="mu-attach-input" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv" multiple style="display:none;"></label>
                          </div>
                        </div>
                        <label class="mu-autocreate-label"><input type="checkbox" class="proj-mu-edit-autocreate" ${mu.autoCreatePlan ? 'checked' : ''}> Create as Plan automatically</label>
                        <div style="display:flex;gap:8px;">
                          <button class="btn btn-sm btn-primary" data-role="save-monthly-update-edit">${icon('save')} Save</button>
                          <button class="btn btn-sm proj-action-cancel" data-role="cancel-monthly-update-edit">${icon('undo-2')} Cancel</button>
                        </div>
                      </div>
                    </div>
                  </div>
                `;
              }
              const status = monthlyUpdateStatus(mu);
              const source = mu.sourceUpdateId ? migratedUpdates.find(x => x.id === mu.sourceUpdateId) : null;
              // Full status (overdue/today/upcoming/completed/nodate) for
              // the left-border accent + badge — separate from the
              // planned/logged split above, which only drives the timeline
              // marker and the PLANNED pill.
              const taskStatus = getTaskStatus(mu, todayStr);
              const meta = TASK_STATUS_META[taskStatus];
              const nextActionSuperseded = mu.nextActionDue && migratedUpdates.some(x => x.sourceUpdateId === mu.id);
              const linkedRecipe = mu.linkedRecipeId ? recipes.find(r => r.id === mu.linkedRecipeId) : null;
              return `
              <div class="mu-entry${idx === sorted.length - 1 ? ' mu-entry-last' : ''}" data-update-id="${escapeHtml(mu.id)}">
                <div class="mu-entry-marker${status === 'planned' ? ' mu-marker-planned' : ''}"></div>
                <div class="mu-entry-body mu-status-${taskStatus}">
                  <div class="mu-entry-header">
                    <span class="mu-entry-date">${escapeHtml(formatDateLong(mu.date))} · ${status === 'logged' ? escapeHtml(formatTimeOnly(mu.createdAt)) : '<span class="mu-planned-label">Planned</span>'}</span>
                    <span class="mu-status-badge">${meta.icon} ${escapeHtml(meta.label(mu, todayStr))}</span>
                    ${isEditing ? `<button class="icon-btn" title="Edit this update" data-role="edit-monthly-update" style="float:right;">${icon('pencil')}</button><button class="icon-btn" title="Delete this update" data-role="delete-monthly-update" style="float:right;">${icon('x')}</button>` : ''}
                    <div class="mu-entry-by">${mu.createdBy ? escapeHtml(mu.createdBy) : ''}</div>
                  </div>
                  <div class="mu-card-grid"${mu.nextAction ? '' : ' style="grid-template-columns:repeat(2,1fr);"'}>
                    <div class="mu-card mu-card-clickable" data-section="plan" title="Click to update">
                      <div class="mu-card-title">${icon('file-text', 14)} PLAN${source ? ' <span class="mu-badge">AUTO-CREATED</span>' : ''}${status === 'planned' ? ' <span class="mu-status-pill">PLANNED</span>' : ''}</div>
                      ${(mu.time || mu.planWho) ? `<div class="mu-plan-detail-line">${mu.time ? `<b>When:</b> ${escapeHtml(mu.time)}` : ''}${mu.time && mu.planWho ? ' &nbsp;·&nbsp; ' : ''}${mu.planWho ? escapeHtml(mu.planWho) : ''}</div>` : ''}
                      <div class="mu-card-text">${mu.plan ? escapeHtml(mu.plan) : '<span class="mu-empty">No plan recorded</span>'}</div>
                      ${mu.planWith ? `<div class="mu-plan-detail-line"><b>With:</b> ${escapeHtml(mu.planWith)}</div>` : ''}
                      ${mu.planWhere ? `<div class="mu-plan-detail-line"><b>@</b> ${escapeHtml(mu.planWhere)}</div>` : ''}
                      ${mu.planOwner ? `<div class="mu-plan-detail-line"><b>PD:</b> ${escapeHtml(mu.planOwner)}</div>` : ''}
                      ${source ? `<div class="mu-source-link">${icon('undo-2', 12)} From Next action · ${escapeHtml(formatDateLong(source.date))}${source.createdAt ? ', ' + escapeHtml(formatTimeOnly(source.createdAt)) : ''}</div>` : ''}
                    </div>
                    <div class="mu-card mu-card-clickable" data-section="action" title="Click to update">
                      <div class="mu-card-title">${icon('check', 14)} ACTION TAKEN</div>
                      <div class="mu-card-text">${mu.actionTaken ? escapeHtml(mu.actionTaken) : '<span class="mu-empty">Not yet taken action</span>'}</div>
                    </div>
                    ${mu.nextAction ? `
                    <div class="mu-card mu-card-clickable" data-section="nextaction" title="Click to update">
                      <div class="mu-card-title">${icon('clock', 14)} NEXT ACTION${mu.nextActionDue ? `<span class="mu-due-inline${nextActionSuperseded ? ' mu-due-superseded' : ''}">Due ${escapeHtml(formatDateLong(mu.nextActionDue))}</span>` : ''}</div>
                      ${(mu.nextActionTime || mu.nextActionWho) ? `<div class="mu-plan-detail-line">${mu.nextActionTime ? `<b>When:</b> ${escapeHtml(mu.nextActionTime)}` : ''}${mu.nextActionTime && mu.nextActionWho ? ' &nbsp;·&nbsp; ' : ''}${mu.nextActionWho ? escapeHtml(mu.nextActionWho) : ''}</div>` : ''}
                      <div class="mu-card-text">${escapeHtml(mu.nextAction)}</div>
                      ${mu.nextActionWith ? `<div class="mu-plan-detail-line"><b>With:</b> ${escapeHtml(mu.nextActionWith)}</div>` : ''}
                      ${mu.nextActionWhere ? `<div class="mu-plan-detail-line"><b>@</b> ${escapeHtml(mu.nextActionWhere)}</div>` : ''}
                      ${mu.nextActionOwner ? `<div class="mu-plan-detail-line"><b>PD:</b> ${escapeHtml(mu.nextActionOwner)}</div>` : ''}
                    </div>
                    ` : ''}
                  </div>
                  ${(linkedRecipe || mu.attachments.length) ? `
                  <div class="mu-entry-extras">
                    ${linkedRecipe ? `<button type="button" class="mu-recipe-link" data-role="open-mu-recipe" data-recipe-id="${escapeHtml(linkedRecipe.id)}">${icon('link', 12)} ${escapeHtml(recipeDisplayLabel(linkedRecipe))}</button>` : ''}
                    ${muAttachmentChipsHtml(mu.attachments, false)}
                  </div>
                  ` : ''}
                </div>
              </div>
            `;
            }).join('')
          : '<div class="overview-empty">No activities updates yet</div>';

        const summaryRow = `
          <tr class="proj-row">
            <td><button type="button" class="part-toggle-btn${isExpanded ? ' open' : ''}" title="Expand / collapse this project">${icon('chevron-right')}</button></td>
            <td data-col="photo"><button type="button" class="proj-row-photo-btn" title="Expand this project">${p.image ? `<img src="${escapeHtml(p.image)}" class="material-thumb" alt="${escapeHtml(p.name || 'Project photo')}">` : '<div class="material-thumb material-thumb-empty"></div>'}</button></td>
            <td><b>${escapeHtml(p.name || 'Untitled project')}</b>${projectStatusBarHtml(p.status)}</td>
            <td data-col="status">${escapeHtml(p.status || PROJECT_STATUSES[0])}</td>
            <td data-col="requestDate">${missingCell(p.requestDate)}</td>
            <td data-col="customerName">${missingCell(p.customerName)}</td>
            <td data-col="destinationCountry">${missingCell(p.destinationCountry)}</td>
            <td data-col="ownerSalesRep">${missingCell(p.ownerSalesRep)}</td>
            <td data-col="factorySalesRep">${missingCell(p.factorySalesRep)}</td>
            <td data-col="responsiblePerson">${missingCell(p.responsiblePerson)}</td>
            <td data-col="factoryName">${missingCell(p.factoryName)}</td>
            <td data-col="requirements">${Object.entries(req).some(([k, v]) => {
              if(k === 'cookingCondition') return v.some(g => g.method || g.steps.length);
              if(k === 'referenceImages' || k === 'recipeAttachments') return v.length > 0;
              if(k === 'certificate') return CERTIFICATE_TYPES.some(t => v[t.key]) || v.other;
              return (v || '').trim();
            }) ? icon('check', 14) : '<span class="proj-missing" title="Missing">—</span>'}</td>
            <td data-col="productCount">${productCount === 0 ? '<span class="proj-missing" title="No products yet">0</span>' : productCount}</td>
            <td class="proj-actions-cell" style="white-space:nowrap;">
              ${(isExpanded && !isEditing)
                ? `<button class="btn btn-sm" data-role="print-project" title="Print this project">${icon('printer')}</button><button class="btn btn-sm" data-role="edit-project">${icon('pencil')} Edit</button>${p.isUnassignedBucket ? '' : `<button class="btn btn-sm btn-danger" data-role="delete-project">${icon('x')} Delete</button>`}`
                : ''}
            </td>
          </tr>
        `;

        // Read-only view: photo on the left, a clean label/value list on the
        // right (same dt/dd styling as the Ingredient Library's detail
        // view) — replaces the disabled-input grid so a project you're just
        // looking at (not editing) reads like a document, not a form.
        const detailRowsHtml = rows => rows.map(([label, value]) => `
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value || '-')}</dd>
        `).join('');
        // Split around the Flavor/Filling table (below) so it lands exactly
        // where it visually used to sit as a single field — right after
        // Factory, before Portion Weight — even though it's no longer part
        // of the flat label/value list itself.
        const readOnlyDetailRowsBefore = detailRowsHtml([
          ['Status', PROJECT_STATUS_LABELS[p.status] || p.status || PROJECT_STATUSES[0]],
          ['Request Date', p.requestDate],
          ['Start Date', p.startDate],
          ['Target / End Date', p.targetEndDate],
          ['Customer Name', p.customerName],
          ['Destination Country', p.destinationCountry],
          ['Project Owner', p.ownerSalesRep],
          ['Factory Sales Rep', p.factorySalesRep],
          ['Responsible Person (PD)', p.responsiblePerson],
          ['Factory', p.factoryName]
        ]);
        const readOnlyDetailRowsAfter = detailRowsHtml([
          ['Portion Weight', p.portionWeightQty ? formatPortionWeight(p) : ''],
          ['Inner Packing', p.innerPackQty ? formatInnerPacking(p) : ''],
          ['Outer Packing', p.outerPackQty ? formatOuterPacking(p) : ''],
          ['MOQ', p.moqQty ? formatProjectMoq(p) : '']
        ]);
        const flavors = p.flavors || [];
        const formatFlavorPrice = (f, price) => price ? `${escapeHtml(price)} ${escapeHtml(f.priceCurrency || 'THB')} / ${escapeHtml(f.priceUnit || 'kg')}` : '-';
        const readOnlyFlavorsHtml = flavors.length ? `
          <div class="flavor-table-scroll">
          <table class="flavor-table">
            <thead><tr><th>Product</th><th>Sample Qty</th><th>Sample Request Date</th><th>Target Price</th><th>Actual Price</th><th>Formula / Reference No.</th><th>Note</th></tr></thead>
            <tbody>${flavors.map(f => `
              <tr>
                <td>${escapeHtml(f.name || 'Untitled product')}</td>
                <td>${f.sampleQty ? `${escapeHtml(f.sampleQty)}${f.sampleQtyUnit ? ' ' + escapeHtml(f.sampleQtyUnit) : ''}` : '-'}</td>
                <td>${escapeHtml(f.sampleRequestDate || '-')}</td>
                <td>${formatFlavorPrice(f, f.targetPrice)}</td>
                <td>${formatFlavorPrice(f, f.actualPrice)}</td>
                <td>${escapeHtml(f.formulaRefCode || '-')}</td>
                <td>${escapeHtml(f.note || '-')}</td>
              </tr>
            `).join('')}</tbody>
          </table>
          </div>
        ` : '<div class="overview-empty">No products yet</div>';
        const allAttachments = allProjectAttachments(p);
        const readOnlyRequirementsHtml = `
          <div class="requirements-box">
            <div class="requirements-box-title">Requirements</div>
            ${projRefImagesHtml(req.referenceImages, false)}
            <div class="material-detail-notes-label">Product</div>
            ${readOnlyFlavorsHtml}
            ${(req.storageCondition || req.shelfLife) ? `
              <dl class="material-detail-list">${detailRowsHtml([
                ['Storage Condition', req.storageCondition],
                ['Shelf Life (from production date)', req.shelfLife]
              ])}</dl>
            ` : ''}
            ${req.composition ? `<div class="material-detail-notes-label">Composition</div><div class="material-detail-notes">${escapeHtml(req.composition)}</div>` : ''}
            ${(req.recipe || req.recipeAttachments.length) ? `
              <div class="material-detail-notes-label">Recipe</div>
              ${req.recipe ? `<div class="material-detail-notes">${escapeHtml(req.recipe)}</div>` : ''}
              ${req.recipeAttachments.length ? `<div class="mu-entry-extras" style="margin-top:6px;">${muAttachmentChipsHtml(req.recipeAttachments, false)}</div>` : ''}
            ` : ''}
            ${req.cookingCondition.some(g => g.method || g.steps.length) ? `
              <div class="material-detail-notes-label">Cooking Guidelines</div>
              ${req.cookingCondition.filter(g => g.method || g.steps.length).map(g => `
                <div style="margin-bottom:8px;">
                  ${g.method ? `<div style="font-size:12px;font-weight:600;margin-bottom:2px;">${escapeHtml(g.method)}</div>` : ''}
                  ${g.steps.length ? `<ol class="cooking-steps-list">${g.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
                </div>
              `).join('')}
            ` : ''}
            ${req.packagingCondition ? `<div class="material-detail-notes-label">Packaging condition</div><div class="material-detail-notes">${escapeHtml(req.packagingCondition)}</div>` : ''}
            ${req.note ? `<div class="material-detail-notes-label">Note</div><div class="material-detail-notes">${escapeHtml(req.note)}</div>` : ''}
            <dl class="material-detail-list requirements-box-divider">${detailRowsHtml([
              ['Certificate', certificateSummaryText(req.certificate)]
            ])}</dl>
          </div>
        `;
        const readOnlyDetailView = `
          <div class="project-detail-view">
            <div class="project-detail-photo">
              ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name || 'Project photo')}">` : '<div class="project-detail-photo-empty"></div>'}
            </div>
            <div class="project-detail-info">
              <div class="project-detail-title">${escapeHtml(p.name || 'Untitled project')}</div>
              <dl class="material-detail-list">${readOnlyDetailRowsBefore}${readOnlyDetailRowsAfter}</dl>
            </div>
            ${projectDocSlotHtml(p.quotationAttachment, 'quotationAttachment', 'Quotation')}
            ${projectDocSlotHtml(p.specAttachment, 'specAttachment', 'Specification')}
          </div>
          ${readOnlyRequirementsHtml}
          ${allAttachments.length ? `
          <div class="material-detail-notes-label">Attachments (${allAttachments.length})</div>
          <div class="project-all-attachments mu-entry-extras" style="margin-top:0;">${muAttachmentChipsHtml(allAttachments, false)}</div>
          ` : ''}
        `;

        const detailRow = isExpanded ? `
          <tr class="proj-detail-row">
            <td colspan="${projectDetailColspan()}">
              ${isEditing ? `
              <div class="proj-edit-toolbar">
                <button class="btn btn-primary btn-sm" data-role="save-project">${icon('save')} Save</button>
                <button class="btn btn-sm proj-action-duplicate" data-role="duplicate-project">${icon('copy')} Duplicate</button>
                <button class="btn btn-sm proj-action-cancel" data-role="cancel-project">${icon('undo-2')} Cancel</button>
              </div>
              <div class="requirements-box" style="margin-top:0;">
                <div class="requirements-box-title">Project Information</div>
                <div class="project-header-grid">
                  <div class="field" style="margin-bottom:0;">
                    <label>Project Name</label>
                    <input type="text" class="proj-name" ${ro} value="${escapeHtml(p.name)}" placeholder="e.g. Sunrise Foods Q3 Launch">
                  </div>
                  <div class="field" style="margin-bottom:0;">
                    <label>Photo (optional)</label>
                    ${isEditing ? `<input type="file" class="proj-image-input" accept="image/*">` : ''}
                    <div style="display:flex;align-items:center;gap:10px;margin-top:6px;">
                      <img class="proj-image-preview" src="${p.image ? escapeHtml(p.image) : ''}" style="${p.image ? '' : 'display:none;'}width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--border);">
                      ${isEditing ? `<button type="button" class="btn btn-sm proj-image-remove" style="${p.image ? '' : 'display:none;'}">Remove photo</button>` : ''}
                    </div>
                  </div>
                  <div class="field" style="margin-bottom:0;">
                    <label>Status</label>
                    <select class="proj-select proj-status" ${isEditing ? '' : 'disabled'}>
                      ${PROJECT_STATUSES.map(s => `<option value="${escapeHtml(s)}" ${s === (p.status || PROJECT_STATUSES[0]) ? 'selected' : ''}>${escapeHtml(PROJECT_STATUS_LABELS[s])}</option>`).join('')}
                    </select>
                  </div>
                  <div class="field" style="margin-bottom:0;">
                    <label>Request Date</label>
                    <input type="date" class="proj-request-date" ${ro} value="${escapeHtml(p.requestDate || '')}">
                  </div>
                  <div class="field" style="margin-bottom:0;">
                    <label>Start Date</label>
                    <input type="date" class="proj-start-date" ${ro} value="${escapeHtml(p.startDate || '')}">
                  </div>
                  <div class="field" style="margin-bottom:0;">
                    <label>Target / End Date</label>
                    <input type="date" class="proj-target-end-date" ${ro} value="${escapeHtml(p.targetEndDate || '')}">
                  </div>
                  <div class="field" style="margin-bottom:0;">
                    <label>Customer Name</label>
                    <input type="text" class="proj-customer" list="customerDatalist" ${ro} value="${escapeHtml(p.customerName)}" placeholder="e.g. ABC Trading Co.">
                  </div>
                  <div class="field" style="margin-bottom:0;">
                    <label>Destination Country</label>
                    <input type="text" class="proj-destination" list="destinationDatalist" ${ro} value="${escapeHtml(p.destinationCountry)}" placeholder="e.g. Japan">
                  </div>
                  <div class="field" style="margin-bottom:0;">
                    <label>Project Owner</label>
                    <input type="text" class="proj-owner" list="salesRepDatalist" ${ro} value="${escapeHtml(p.ownerSalesRep)}" placeholder="e.g. Somchai">
                  </div>
                  <div class="field" style="margin-bottom:0;">
                    <label>Factory Sales Rep</label>
                    <input type="text" class="proj-factory-rep" list="salesRepDatalist" ${ro} value="${escapeHtml(p.factorySalesRep)}" placeholder="e.g. Preecha">
                  </div>
                  <div class="field" style="margin-bottom:0;">
                    <label>Responsible Person (PD)</label>
                    <input type="text" class="proj-responsible" list="salesRepDatalist" ${ro} value="${escapeHtml(p.responsiblePerson)}" placeholder="e.g. Kanya">
                  </div>
                  <div class="field" style="margin-bottom:0;">
                    <label>Factory</label>
                    <input type="text" class="proj-factory" list="customerDatalist" ${ro} value="${escapeHtml(p.factoryName)}" placeholder="e.g. Rayong Plant 2">
                  </div>
                </div>
              </div>
              <div class="requirements-box">
                    <div class="requirements-box-title">Requirements</div>
                    <div class="field" style="margin-bottom:8px;">
                      <label>Idea / Reference Images (optional, up to ${PROJ_REF_IMAGE_MAX})</label>
                      ${projRefImagesHtml(referenceImagesEditing, true)}
                      ${isEditing && referenceImagesEditing.length < PROJ_REF_IMAGE_MAX ? `<input type="file" class="proj-ref-image-input" accept="image/*">` : ''}
                    </div>
                    <div class="field" style="margin-bottom:8px;">
                      <label>Product</label>
                      <div class="flavor-table-scroll">
                      <table class="flavor-table flavor-table-edit">
                        <thead><tr><th>Product</th><th>Sample Qty</th><th>Unit</th><th>Sample Request Date</th><th>Target Price</th><th>Actual Price</th><th>Currency</th><th>Per</th><th>Formula / Reference No.</th><th>Note</th><th></th></tr></thead>
                        <tbody class="proj-flavors-tbody">${(p.flavors||[]).map(f => `
                          <tr data-flavor-id="${escapeHtml(f.id)}">
                            <td><input type="text" class="flavor-name" ${ro} value="${escapeHtml(f.name||'')}" placeholder="e.g. Red bean"></td>
                            <td><input type="number" class="flavor-sample-qty" ${ro} value="${escapeHtml(f.sampleQty||'')}" step="any" min="0" placeholder="e.g. 50"></td>
                            <td><input type="text" class="flavor-sample-qty-unit" list="unitsDatalist" ${ro} value="${escapeHtml(f.sampleQtyUnit||'')}" placeholder="e.g. pcs"></td>
                            <td><input type="date" class="flavor-sample-request-date" ${ro} value="${escapeHtml(f.sampleRequestDate||'')}"></td>
                            <td><input type="number" class="flavor-target-price" ${ro} value="${escapeHtml(f.targetPrice||'')}" step="any" min="0"></td>
                            <td><input type="number" class="flavor-actual-price" ${ro} value="${escapeHtml(f.actualPrice||'')}" step="any" min="0"></td>
                            <td><select class="proj-select flavor-currency" ${isEditing ? '' : 'disabled'}>${CURRENCY_OPTIONS.map(c => `<option value="${c}" ${c === (f.priceCurrency || 'THB') ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
                            <td><input type="text" class="flavor-unit" list="unitsDatalist" ${ro} value="${escapeHtml(f.priceUnit || 'kg')}" placeholder="unit"></td>
                            <td><input type="text" class="flavor-formula-ref" ${ro} value="${escapeHtml(f.formulaRefCode||'')}" placeholder="e.g. JPN01-25"></td>
                            <td><input type="text" class="flavor-note" ${ro} value="${escapeHtml(f.note||'')}" placeholder="Note"></td>
                            <td>${isEditing ? `<button type="button" class="icon-btn" title="Delete this product" data-role="remove-flavor">${icon('x')}</button>` : ''}</td>
                          </tr>
                        `).join('')}</tbody>
                      </table>
                      </div>
                      ${isEditing ? `<button type="button" class="btn btn-sm add-row-btn" data-role="add-flavor">+ Add Product</button>` : ((p.flavors||[]).length ? '' : '<div class="overview-empty">No products yet</div>')}
                    </div>
                    <div class="project-header-grid" style="margin-bottom:8px;">
                      <div class="field" style="margin-bottom:0;">
                        <label>Portion Weight</label>
                        <div class="combo-row">
                          <input type="number" class="proj-portion-qty" ${ro} value="${escapeHtml(p.portionWeightQty || '')}" placeholder="e.g. 20" step="any" min="0">
                          <input type="text" class="proj-portion-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.portionWeightUnit || '')}" placeholder="e.g. g">
                          <span>/</span>
                          <input type="text" class="proj-portion-per-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.portionPerUnit || '')}" placeholder="e.g. pcs">
                        </div>
                      </div>
                      <div class="field" style="margin-bottom:0;">
                        <label>Inner Packing</label>
                        <div class="combo-row">
                          <input type="number" class="proj-inner-qty" ${ro} value="${escapeHtml(p.innerPackQty || '')}" placeholder="e.g. 30" step="any" min="0">
                          <input type="text" class="proj-inner-weight-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.innerPackWeightUnit || '')}" placeholder="e.g. g">
                          <span>/</span>
                          <input type="text" class="proj-inner-pack-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.innerPackUnit || '')}" placeholder="e.g. pack">
                        </div>
                      </div>
                      <div class="field" style="margin-bottom:0;">
                        <label>Outer Packing</label>
                        <div class="combo-row">
                          <input type="number" class="proj-outer-qty" ${ro} value="${escapeHtml(p.outerPackQty || '')}" placeholder="e.g. 24" step="any" min="0">
                          <input type="text" class="proj-outer-pack-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.outerPackUnit || '')}" placeholder="e.g. pack">
                          <span>/</span>
                          <input type="text" class="proj-outer-container-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.outerPackContainerUnit || '')}" placeholder="e.g. carton">
                        </div>
                      </div>
                      <div class="field" style="margin-bottom:0;">
                        <label>MOQ</label>
                        <div class="combo-row">
                          <input type="number" class="proj-moq-qty" ${ro} value="${escapeHtml(p.moqQty || '')}" placeholder="e.g. 500" step="any" min="0">
                          <input type="text" class="proj-moq-unit" list="unitsDatalist" ${ro} value="${escapeHtml(p.moqUnit || '')}" placeholder="e.g. pcs">
                        </div>
                      </div>
                    </div>
                    <div class="field" style="margin-bottom:8px;">
                      <label>Packaging condition</label>
                      <textarea class="proj-req-packaging" ${ro} placeholder="e.g. Microwaveable black plastic tray">${escapeHtml(req.packagingCondition)}</textarea>
                    </div>
                    <div class="project-header-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:8px;">
                      <div class="field" style="margin-bottom:0;">
                        <label>Storage Condition</label>
                        <input type="text" class="proj-req-storage-condition" list="storageConditionDatalist" ${ro} value="${escapeHtml(req.storageCondition)}" placeholder="e.g. Keep frozen at -18°C">
                      </div>
                      <div class="field" style="margin-bottom:0;">
                        <label>Shelf Life (from production date)</label>
                        <input type="text" class="proj-req-shelf-life" ${ro} value="${escapeHtml(req.shelfLife)}" placeholder="e.g. 12 months">
                      </div>
                    </div>
                    <div class="field" style="margin-bottom:8px;">
                      <label>Composition</label>
                      <textarea class="proj-req-composition" ${ro} placeholder="e.g. Teriyaki Sauce: Soy Sauce 40%, Mirin 25%, Sugar 20%, Sake 15%">${escapeHtml(req.composition)}</textarea>
                    </div>
                    <div class="field" style="margin-bottom:8px;">
                      <label>Recipe</label>
                      <textarea class="proj-req-recipe" ${ro} placeholder="Reference / attachment notes">${escapeHtml(req.recipe)}</textarea>
                      ${isEditing ? `
                      <div class="mu-attachments-editor proj-recipe-attachments" style="margin-top:8px;">
                        <div class="mu-attachments-chiplist"></div>
                        <label class="btn btn-sm mu-attach-btn">${icon('paperclip', 14)} Attach file/photo<input type="file" class="mu-attach-input" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv" multiple style="display:none;"></label>
                      </div>
                      ` : ''}
                    </div>
                    <div class="field requirements-box-divider-below" style="margin-bottom:8px;">
                      <label>Cooking Guidelines</label>
                      <div class="cooking-guidelines-editor">${cookingGuidelinesEditing.map((g, gi) => `
                        <div class="cooking-guideline-group" data-group-idx="${gi}" style="${gi < cookingGuidelinesEditing.length - 1 ? 'margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border);' : ''}">
                          <div style="display:flex;gap:8px;align-items:center;">
                            <input type="text" class="proj-req-cooking-method" list="cookingMethodDatalist" value="${escapeHtml(g.method)}" placeholder="e.g. Microwave" style="flex:1;">
                            ${cookingGuidelinesEditing.length > 1 ? `<button type="button" class="icon-btn" data-role="remove-cooking-guideline" title="Remove this guideline">${icon('x')}</button>` : ''}
                          </div>
                          <div style="margin-top:8px;">
                            ${trialStringListHtml(g.steps, true, 'proj-cooking-step-input', 'cooking-step', 'e.g. Reheat from frozen, 2-3 minutes')}
                          </div>
                        </div>
                      `).join('')}</div>
                      <button type="button" class="btn btn-sm add-row-btn" data-role="add-cooking-guideline">+ Add Cooking Guidelines</button>
                    </div>
                    <div class="field" style="margin-bottom:8px;">
                      <label>Note</label>
                      <textarea class="proj-req-note" ${ro} placeholder="Anything else not covered above">${escapeHtml(req.note)}</textarea>
                    </div>
                    <div class="field requirements-box-divider" style="margin-bottom:0;">
                      <label>Certificate</label>
                      ${certificateChecklistHtml(req.certificate, isEditing)}
                    </div>
                  </div>
              ` : readOnlyDetailView}
              ${activity.length ? `<div class="reflist-item-meta" style="margin:10px 0;">${activity.join(' &nbsp;|&nbsp; ')}</div>` : ''}

              ${p.products.length ? `
              <table>
                <thead><tr><th>Product</th><th>Sales Rep</th><th>Stage</th><th>Last Update</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
              ` : `<div class="overview-empty">No products yet${isEditing ? ' — add one below' : ''}</div>`}

              ${isEditing ? `
              <div class="project-add-row" style="margin-top:12px;">
                <select class="proj-select add-product-select">
                  <option value="">${availableRecipes.length ? 'Select a recipe to add...' : 'All recipes already added'}</option>
                  ${availableRecipes.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(recipeDisplayLabel(r))}${fullCode(r) ? ' · ' + escapeHtml(fullCode(r)) : ''}</option>`).join('')}
                </select>
                <button class="btn btn-sm" data-role="add-product">+ Add Product</button>
              </div>
              ` : ''}

              <div class="field" style="margin-bottom:0;margin-top:16px;" id="activities-updates-${escapeHtml(p.id)}">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                  <label style="margin-bottom:0;">Activities Updates</label>
                  ${(isEditing && !monthlyUpdateAddOpen) ? `<button class="btn btn-sm" data-role="open-add-monthly-update">+ Add Update</button>` : ''}
                </div>
                ${isEditing && monthlyUpdateAddOpen ? `
                  <div class="proj-monthly-add">
                    <div class="mu-plan-box">
                      <div class="mu-plan-box-title">Plan</div>
                      <div class="field">
                        <label>When</label>
                        <div class="mu-when-group">
                          <input type="date" class="proj-mu-date" value="${escapeHtml(new Date().toISOString().slice(0,10))}">
                          <input type="time" class="proj-mu-time">
                        </div>
                      </div>
                      <div class="field">
                        <label>Person</label>
                        <input type="text" class="proj-mu-who" list="salesRepDatalist" placeholder="e.g. Yano-san">
                      </div>
                      <div class="field">
                        <label>Activity</label>
                        <div class="mu-field-with-translate" style="width:auto;">
                          <textarea class="proj-mu-plan" placeholder="Activity"></textarea>
                          <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                        </div>
                      </div>
                      <div class="field">
                        <label>With</label>
                        <input type="text" class="proj-mu-with" list="salesRepDatalist" placeholder="e.g. Tanaka-san">
                      </div>
                      <div class="field">
                        <label>Location / Channel</label>
                        <input type="text" class="proj-mu-where" list="customerDatalist" placeholder="e.g. UMIOS Office">
                        <select class="proj-select proj-mu-where-location" style="display:none;margin-top:6px;"></select>
                      </div>
                      <div class="field" style="margin-bottom:0;">
                        <label>PD</label>
                        <input type="text" class="proj-mu-owner" list="salesRepDatalist" placeholder="e.g. Yano-san" value="${escapeHtml(p.responsiblePerson || '')}">
                      </div>
                    </div>
                    <div class="mu-plan-box">
                      <div class="mu-plan-box-title">Action Taken</div>
                      <div class="field">
                        <label>Action Taken</label>
                        <div class="mu-field-with-translate" style="width:auto;">
                          <textarea class="proj-mu-action" placeholder="Action Taken"></textarea>
                          <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                        </div>
                      </div>
                      <div class="field" style="margin-bottom:0;">
                        <label>Completed Date (optional)</label>
                        <input type="date" class="proj-mu-completed-date" title="Completed date — defaults to today once Action Taken is filled in, edit if it was actually finished on a different day">
                      </div>
                    </div>
                    <div class="mu-plan-box">
                      <div class="mu-plan-box-title">Next Action</div>
                      <div class="field">
                        <label>When</label>
                        <div class="mu-when-group">
                          <input type="date" class="proj-mu-nextaction-due" title="Next Action due date">
                          <input type="time" class="proj-mu-nextaction-time">
                        </div>
                      </div>
                      <div class="field">
                        <label>Person</label>
                        <input type="text" class="proj-mu-nextaction-who" list="salesRepDatalist" placeholder="e.g. Yano-san">
                      </div>
                      <div class="field">
                        <label>Activity</label>
                        <div class="mu-field-with-translate" style="width:auto;">
                          <textarea class="proj-mu-nextaction" placeholder="Activity"></textarea>
                          <button type="button" class="mu-translate-btn" title="Translate (Thai ⇄ English)">${icon('globe', 14)}</button>
                        </div>
                      </div>
                      <div class="field">
                        <label>With</label>
                        <input type="text" class="proj-mu-nextaction-with" list="salesRepDatalist" placeholder="e.g. Tanaka-san">
                      </div>
                      <div class="field">
                        <label>Location / Channel</label>
                        <input type="text" class="proj-mu-nextaction-where" list="customerDatalist" placeholder="e.g. UMIOS Office">
                        <select class="proj-select proj-mu-nextaction-where-location" style="display:none;margin-top:6px;"></select>
                      </div>
                      <div class="field" style="margin-bottom:0;">
                        <label>PD</label>
                        <input type="text" class="proj-mu-nextaction-owner" list="salesRepDatalist" placeholder="e.g. Yano-san" value="${escapeHtml(p.responsiblePerson || '')}">
                      </div>
                    </div>
                    <div class="field">
                      <label>Linked Recipe (optional)</label>
                      <select class="proj-select proj-mu-recipe">${muRecipeOptionsHtml('')}</select>
                    </div>
                    <div class="field">
                      <label>Attachments (optional)</label>
                      <div class="mu-attachments-editor">
                        <div class="mu-attachments-chiplist"></div>
                        <label class="btn btn-sm mu-attach-btn">${icon('paperclip', 14)} Attach file/photo<input type="file" class="mu-attach-input" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv" multiple style="display:none;"></label>
                      </div>
                    </div>
                    <label class="mu-autocreate-label"><input type="checkbox" class="proj-mu-autocreate"> Create as Plan automatically</label>
                    <div style="display:flex;gap:8px;">
                      <button class="btn btn-sm btn-primary" data-role="add-monthly-update">${icon('save')} Save</button>
                      <button class="btn btn-sm proj-action-cancel" data-role="cancel-add-monthly-update">${icon('undo-2')} Cancel</button>
                    </div>
                  </div>
                ` : ''}
                <div class="mu-timeline proj-monthly-list">${monthlyUpdatesHtml}</div>
              </div>
            </td>
          </tr>
        ` : '';

        return `<tbody data-project-id="${escapeHtml(p.id)}">${summaryRow}${detailRow}</tbody>`;
      }).join('')}
    </table>
    </div>
    <div class="proj-scrollbar-proxy" id="projScrollbarProxy"><div id="projScrollbarProxyInner"></div></div>
  `;
  applyProjectColumnVisibility();

  // The table scrolls sideways within the page now (no bounded vertical
  // box), which means its own horizontal scrollbar sits at the bottom of
  // the (long) row list — not reachable without scrolling all the way down
  // first. This thin proxy bar stays pinned to the bottom of the viewport
  // while any part of the table is on screen, and its scroll position stays
  // in sync with the real table so dragging either one moves both.
  const tableScroll = container.querySelector('.proj-table-scroll');
  const scrollbarProxy = document.getElementById('projScrollbarProxy');
  const scrollbarProxyInner = document.getElementById('projScrollbarProxyInner');
  function syncProjScrollbarProxy(){
    const needsScroll = tableScroll.scrollWidth > tableScroll.clientWidth + 1;
    scrollbarProxy.style.display = needsScroll ? 'block' : 'none';
    scrollbarProxyInner.style.width = tableScroll.scrollWidth + 'px';
  }
  syncProjScrollbarProxy();
  // renderProjectsList() re-runs on every search/sort/edit, which would
  // otherwise stack up a new window resize listener each time — routing
  // through this single persistent listener (attached once, below) instead
  // just reassigns which sync function it calls.
  activeProjScrollbarProxySync = syncProjScrollbarProxy;
  tableScroll.addEventListener('scroll', () => { scrollbarProxy.scrollLeft = tableScroll.scrollLeft; });
  scrollbarProxy.addEventListener('scroll', () => { tableScroll.scrollLeft = scrollbarProxy.scrollLeft; });

  container.querySelectorAll('.proj-th-label').forEach(labelEl => {
    labelEl.addEventListener('click', () => {
      const key = labelEl.dataset.sortKey;
      if(projectSortKey === key){
        projectSortDir = projectSortDir === 'asc' ? 'desc' : 'asc';
      }else{
        projectSortKey = key;
        projectSortDir = 'asc';
      }
      renderProjectsList();
    });
  });

  // Excel-style per-column filter popovers — the "▾" button next to each
  // sortable header's label. Opening/closing is a pure DOM class toggle (no
  // re-render needed just to show/hide the popover); checking or
  // unchecking a value actually changes projectColumnFilters, which does
  // need a full renderProjectsList() to re-filter the rows — and since that
  // rebuilds the whole table, openProjectFilterMenuKey is what makes the
  // same popover reappear open afterward instead of the click silently
  // closing it.
  container.querySelectorAll('[data-filter-trigger]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key = btn.dataset.filterTrigger;
      openProjectFilterMenuKey = openProjectFilterMenuKey === key ? null : key;
      container.querySelectorAll('[data-filter-menu]').forEach(m => {
        m.classList.toggle('open', m.dataset.filterMenu === openProjectFilterMenuKey);
      });
    });
  });
  container.querySelectorAll('[data-filter-menu]').forEach(menu => {
    menu.addEventListener('click', e => e.stopPropagation());
    const key = menu.dataset.filterMenu;
    const accessor = PROJECT_FILTER_ACCESSORS[key];
    // pdWorkloadStatus (see wireProjectsByStatusCardClicks) has no table
    // column behind it, so it has no accessor here -- it's wired
    // separately, this loop is only for real column filters.
    if(!accessor) return;
    const filterableProjects = projects.filter(isProjectCurrentlyVisible);
    const allValues = Array.from(new Set(filterableProjects.map(accessor)));
    const selectAllCb = menu.querySelector('.filter-select-all');
    selectAllCb.addEventListener('change', () => {
      if(selectAllCb.checked) delete projectColumnFilters[key];
      else projectColumnFilters[key] = new Set();
      renderProjectsList();
    });
    menu.querySelectorAll('.filter-value-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const current = new Set(projectColumnFilters[key] || allValues);
        if(cb.checked) current.add(cb.value); else current.delete(cb.value);
        if(current.size === allValues.length) delete projectColumnFilters[key];
        else projectColumnFilters[key] = current;
        renderProjectsList();
      });
    });
    menu.querySelector('[data-clear-filter]')?.addEventListener('click', () => {
      delete projectColumnFilters[key];
      renderProjectsList();
    });
  });
  if(openProjectFilterMenuKey){
    container.querySelector(`[data-filter-menu="${CSS.escape(openProjectFilterMenuKey)}"]`)?.classList.add('open');
  }

  container.querySelectorAll('tbody[data-project-id]').forEach(block => {
    const id = block.dataset.projectId;
    const p = projects.find(x => x.id === id);
    if(!p) return;
    const isEditing = id === projectEditingId;
    const isExpanded = isEditing || projectExpandedIds.has(id);

    const toggleProjectExpanded = () => {
      if(projectExpandedIds.has(id)) projectExpandedIds.delete(id);
      else projectExpandedIds.add(id);
      renderProjectsList();
    };
    block.querySelector('.part-toggle-btn').addEventListener('click', toggleProjectExpanded);
    // Clicking the photo expands the row too, same as clicking a material's
    // thumbnail opens its detail (see openMaterialDetail in materials.js) --
    // projects don't have a separate detail modal, so the existing expand/
    // collapse (which already reveals every field, Requirements, Products,
    // Activities Updates) is the equivalent "show me more" here.
    block.querySelector('.proj-row-photo-btn')?.addEventListener('click', toggleProjectExpanded);

    wireProjectDocSlots(block, p);

    // Prints the whole expanded project detail (fields, Requirements,
    // Flavor/Filling table, Products, Activities Updates) as a one-off
    // read-only page -- expands the row first if it wasn't already, then
    // scopes @media print (see style.css) to just this project's tbody via
    // the .printing-project marker, cleaning both up once printing ends.
    block.querySelector('[data-role="print-project"]')?.addEventListener('click', () => {
      projectExpandedIds.add(id);
      renderProjectsList();
      requestAnimationFrame(() => {
        const printTarget = document.querySelector(`#projectsList tbody[data-project-id="${id}"]`);
        if(!printTarget) return;
        printTarget.classList.add('printing-project');
        const originalTitle = document.title;
        document.title = `Project ${p.name || 'Untitled project'} Forge`.replace(/[\\/:*?"<>|]/g, '-');
        const cleanup = () => {
          printTarget.classList.remove('printing-project');
          document.title = originalTitle;
          window.removeEventListener('afterprint', cleanup);
        };
        window.addEventListener('afterprint', cleanup);
        window.print();
      });
    });

    if(isEditing){
      editingProjectImage = p.image || '';
      const projImageInput = block.querySelector('.proj-image-input');
      const projImagePreview = block.querySelector('.proj-image-preview');
      const projImageRemoveBtn = block.querySelector('.proj-image-remove');
      projImageInput?.addEventListener('change', async e => {
        const file = e.target.files[0];
        if(!file) return;
        try{
          editingProjectImage = await resizeImageFile(file, 400);
          projImagePreview.src = editingProjectImage;
          projImagePreview.style.display = 'block';
          projImageRemoveBtn.style.display = 'inline-flex';
        }catch(err){
          alert(err.message || 'Could not read that image file');
        }
      });
      projImageRemoveBtn?.addEventListener('click', () => {
        editingProjectImage = '';
        projImageInput.value = '';
        projImagePreview.src = '';
        projImagePreview.style.display = 'none';
        projImageRemoveBtn.style.display = 'none';
      });

      // Customers can carry a Country in Reference Lists (see addNewEntry /
      // saveEdit in renderRefListItems) — picking a customer that has one
      // on file saves re-typing the same destination on every project.
      block.querySelector('.proj-customer').addEventListener('change', e => {
        const match = metaLists.customers.find(c => metaItemName(c) === e.target.value.trim());
        if(match && match.country){
          block.querySelector('.proj-destination').value = match.country;
        }
      });

      // Cooking Guidelines: one or more groups (see cookingGuidelinesEditing
      // and the identical wiring in renderNewProjectPanel above). Picking a
      // Cooking Method that has Steps on file (see Reference Lists) pulls
      // them in as a starting point for that group -- still a plain
      // editable step list afterward, not locked to whatever the
      // reference list says.
      block.querySelectorAll('.cooking-guideline-group').forEach((groupEl, gi) => {
        const group = cookingGuidelinesEditing[gi];
        if(!group) return;
        groupEl.querySelector('.proj-req-cooking-method').addEventListener('change', e => {
          group.method = e.target.value.trim();
          const match = metaLists.cookingMethods.find(m => metaItemName(m) === group.method);
          if(match && (match.steps || []).length){
            group.steps = [...match.steps];
          }
          renderProjectsList();
        });
        groupEl.querySelector('[data-role="add-cooking-step"]')?.addEventListener('click', () => {
          group.steps.push('');
          renderProjectsList();
        });
        groupEl.querySelectorAll('[data-role="remove-cooking-step"]').forEach(btn => {
          btn.addEventListener('click', () => {
            group.steps.splice(parseInt(btn.dataset.idx, 10), 1);
            renderProjectsList();
          });
        });
        groupEl.querySelectorAll('.proj-cooking-step-input').forEach((inp, idx) => {
          inp.addEventListener('change', () => { group.steps[idx] = inp.value.trim(); });
        });
        groupEl.querySelector('[data-role="remove-cooking-guideline"]')?.addEventListener('click', () => {
          cookingGuidelinesEditing.splice(gi, 1);
          renderProjectsList();
        });
      });
      block.querySelector('[data-role="add-cooking-guideline"]')?.addEventListener('click', () => {
        cookingGuidelinesEditing.push(blankCookingCondition());
        renderProjectsList();
      });
      wireCertificateChecklist(block);

      block.querySelector('.proj-ref-image-input')?.addEventListener('change', async e => {
        const file = e.target.files[0];
        e.target.value = '';
        if(!file || referenceImagesEditing.length >= PROJ_REF_IMAGE_MAX) return;
        try{
          referenceImagesEditing.push(await fileToProjRefImage(file));
          renderProjectsList();
        }catch(err){
          alert(err.message || 'Could not read that image file');
        }
      });
      block.querySelectorAll('[data-role="remove-ref-image"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = referenceImagesEditing.findIndex(img => img.id === btn.dataset.refImageId);
          if(idx !== -1) referenceImagesEditing.splice(idx, 1);
          renderProjectsList();
        });
      });
      block.querySelectorAll('.proj-ref-image-caption-input').forEach(inp => {
        inp.addEventListener('change', () => {
          const img = referenceImagesEditing.find(x => x.id === inp.dataset.refImageId);
          if(img) img.caption = inp.value.trim();
        });
      });

      block.querySelector('[data-role="save-project"]').addEventListener('click', () => {
        p.name = block.querySelector('.proj-name').value.trim();
        p.image = editingProjectImage;
        p.status = block.querySelector('.proj-status').value;
        p.requestDate = block.querySelector('.proj-request-date').value;
        p.startDate = block.querySelector('.proj-start-date').value;
        p.targetEndDate = block.querySelector('.proj-target-end-date').value;
        p.customerName = block.querySelector('.proj-customer').value.trim();
        p.destinationCountry = block.querySelector('.proj-destination').value.trim();
        p.ownerSalesRep = block.querySelector('.proj-owner').value.trim();
        p.factorySalesRep = block.querySelector('.proj-factory-rep').value.trim();
        p.responsiblePerson = block.querySelector('.proj-responsible').value.trim();
        p.factoryName = block.querySelector('.proj-factory').value.trim();
        p.portionWeightQty = block.querySelector('.proj-portion-qty').value.trim();
        p.portionWeightUnit = block.querySelector('.proj-portion-unit').value.trim();
        p.portionPerUnit = block.querySelector('.proj-portion-per-unit').value.trim();
        p.innerPackQty = block.querySelector('.proj-inner-qty').value.trim();
        p.innerPackWeightUnit = block.querySelector('.proj-inner-weight-unit').value.trim();
        p.innerPackUnit = block.querySelector('.proj-inner-pack-unit').value.trim();
        p.outerPackQty = block.querySelector('.proj-outer-qty').value.trim();
        p.outerPackUnit = block.querySelector('.proj-outer-pack-unit').value.trim();
        p.outerPackContainerUnit = block.querySelector('.proj-outer-container-unit').value.trim();
        p.moqQty = block.querySelector('.proj-moq-qty').value.trim();
        p.moqUnit = block.querySelector('.proj-moq-unit').value.trim();
        p.requirements = {
          // No longer an editable field (the "Flavor / Filling" table below
          // already covers this) -- preserved as-is rather than dropped, in
          // case older data still has it set.
          flavorFilling: getRequirements(p).flavorFilling,
          composition: block.querySelector('.proj-req-composition').value.trim(),
          recipe: block.querySelector('.proj-req-recipe').value.trim(),
          packagingCondition: block.querySelector('.proj-req-packaging').value.trim(),
          storageCondition: block.querySelector('.proj-req-storage-condition').value.trim(),
          shelfLife: block.querySelector('.proj-req-shelf-life').value.trim(),
          cookingCondition: [...block.querySelectorAll('.cooking-guideline-group')].map(g => ({
            method: g.querySelector('.proj-req-cooking-method').value.trim(),
            steps: [...g.querySelectorAll('.proj-cooking-step-input')].map(el => el.value.trim()).filter(Boolean)
          })),
          certificate: readCertificateChecklist(block.querySelector('.proj-cert-wrap')),
          note: block.querySelector('.proj-req-note').value.trim(),
          referenceImages: referenceImagesEditing,
          recipeAttachments: recipeAttachmentsEditing
        };
        // Also picks up a Monthly Update draft — otherwise clicking Save
        // (top-right, for the header fields) while text sits in the
        // date/results/next-plan boxes silently throws that text away,
        // since Save re-renders the row and only "+ Add Update" used to
        // actually commit it.
        const newMuFromSave = captureMonthlyUpdateDraft(p, block);
        const autoCreateOk = newMuFromSave ? maybeAutoCreateNextPlan(p, newMuFromSave) : true;
        projectEditingId = null;
        monthlyUpdateEditingId = null;
        monthlyUpdateAddOpen = false;
        cookingGuidelinesEditing = [blankCookingCondition()];
        referenceImagesEditing = [];
        recipeAttachmentsEditing = [];
        projectExpandedIds.delete(p.id);
        scheduleProjectSave(p);
        logActivityEvent('updated', 'project', p.name || 'Untitled project', diffMainFields(projectEditSnapshotBefore, p, PROJECT_DIFF_FIELDS));
        if(newMuFromSave) logMuAddedEvent(p, newMuFromSave);
        if(!autoCreateOk) alert('"Create as Plan automatically" was checked, but no follow-up Plan was created — Next Action Activity and its due date ("When") must both be filled in first.');
        projectEditSnapshotBefore = null;
        renderProjectsList();
      });
      block.querySelector('[data-role="duplicate-project"]').addEventListener('click', () => {
        const copy = duplicateProject(p);
        projects.push(copy);
        saveProjectToCloud(copy);
        logActivityEvent('created', 'project', copy.name || 'Untitled project');
        projectEditingId = copy.id;
        projectExpandedIds.add(copy.id);
        renderProjectsList();
      });
      block.querySelector('[data-role="cancel-project"]').addEventListener('click', () => {
        projectEditingId = null;
        monthlyUpdateEditingId = null;
        monthlyUpdateAddOpen = false;
        projectEditSnapshotBefore = null;
        cookingGuidelinesEditing = [blankCookingCondition()];
        referenceImagesEditing = [];
        recipeAttachmentsEditing = [];
        projectExpandedIds.add(p.id);
        renderProjectsList();
      });

      block.querySelector('[data-role="open-add-monthly-update"]')?.addEventListener('click', () => {
        monthlyUpdateAddOpen = true;
        monthlyUpdateDraftAttachments = [];
        renderProjectsList();
      });
      block.querySelector('[data-role="cancel-add-monthly-update"]')?.addEventListener('click', () => {
        monthlyUpdateAddOpen = false;
        monthlyUpdateDraftAttachments = [];
        renderProjectsList();
      });
      // Whichever of the Add-Update panel or an Edit-entry popup is
      // currently open (only one at a time), wire up its Plan/Action
      // Taken/Next Action translate buttons and its attachment editor. The
      // Recipe field's own attachment editor (below) is always present
      // while editing, independent of that -- excluded here so this
      // selector can't grab the wrong one when both are on screen at once.
      block.querySelectorAll('.mu-field-with-translate').forEach(wireMuTranslateButton);
      const muAttachEditorEl = block.querySelector('.mu-attachments-editor:not(.proj-recipe-attachments)');
      if(muAttachEditorEl) wireMuAttachmentEditor(muAttachEditorEl, () => monthlyUpdateDraftAttachments);
      const recipeAttachEditorEl = block.querySelector('.proj-recipe-attachments');
      if(recipeAttachEditorEl) wireMuAttachmentEditor(recipeAttachEditorEl, () => recipeAttachmentsEditing);
      wireWhereLocationPicker(
        block.querySelector('.proj-mu-where, .proj-mu-edit-where'),
        block.querySelector('.proj-mu-where-location, .proj-mu-edit-where-location')
      );
      wireWhereLocationPicker(
        block.querySelector('.proj-mu-nextaction-where, .proj-mu-edit-nextaction-where'),
        block.querySelector('.proj-mu-nextaction-where-location, .proj-mu-edit-nextaction-where-location')
      );
      block.querySelector('[data-role="add-monthly-update"]')?.addEventListener('click', () => {
        const newMu = captureMonthlyUpdateDraft(p, block);
        if(!newMu){
          alert('Please pick a date and fill in at least one of What / Action Taken / Next Action.');
          return;
        }
        const autoCreateOk = maybeAutoCreateNextPlan(p, newMu);
        monthlyUpdateAddOpen = false;
        scheduleProjectSave(p);
        logMuAddedEvent(p, newMu);
        renderProjectsList();
        if(!autoCreateOk) alert('"Create as Plan automatically" was checked, but no follow-up Plan was created — Next Action Activity and its due date ("When") must both be filled in first.');
      });

      block.querySelectorAll('[data-role="delete-monthly-update"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const updateId = btn.closest('[data-update-id]').dataset.updateId;
          if(!confirm('Delete this activity update? This cannot be undone.')) return;
          p.monthlyUpdates = (p.monthlyUpdates || []).filter(mu => mu.id !== updateId);
          scheduleProjectSave(p);
          renderProjectsList();
        });
      });

      block.querySelectorAll('[data-role="edit-monthly-update"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const updateId = btn.closest('[data-update-id]').dataset.updateId;
          const mu = (p.monthlyUpdates || []).find(x => x.id === updateId);
          monthlyUpdateEditingId = updateId;
          monthlyUpdateDraftAttachments = mu ? (mu.attachments || []).map(a => ({...a})) : [];
          muEditSnapshotBefore = mu ? snapshotMainFields(mu, MU_DIFF_FIELDS) : null;
          renderProjectsList();
        });
      });

      block.querySelector('[data-role="save-monthly-update-edit"]')?.addEventListener('click', () => {
        const entry = block.querySelector('[data-update-id="' + CSS.escape(monthlyUpdateEditingId) + '"]');
        const mu = (p.monthlyUpdates || []).find(x => x.id === monthlyUpdateEditingId);
        if(!entry || !mu) return;
        const date = entry.querySelector('.proj-mu-edit-date').value;
        const time = entry.querySelector('.proj-mu-edit-time')?.value || '';
        const planWho = entry.querySelector('.proj-mu-edit-who')?.value.trim() || '';
        const plan = entry.querySelector('.proj-mu-edit-plan').value.trim();
        const planWhere = entry.querySelector('.proj-mu-edit-where')?.value.trim() || '';
        const planWith = entry.querySelector('.proj-mu-edit-with')?.value.trim() || '';
        const planOwner = entry.querySelector('.proj-mu-edit-owner')?.value.trim() || '';
        const actionTaken = entry.querySelector('.proj-mu-edit-action').value.trim();
        const nextActionTime = entry.querySelector('.proj-mu-edit-nextaction-time')?.value || '';
        const nextActionWho = entry.querySelector('.proj-mu-edit-nextaction-who')?.value.trim() || '';
        const nextAction = entry.querySelector('.proj-mu-edit-nextaction').value.trim();
        const nextActionWhere = entry.querySelector('.proj-mu-edit-nextaction-where')?.value.trim() || '';
        const nextActionWith = entry.querySelector('.proj-mu-edit-nextaction-with')?.value.trim() || '';
        const nextActionOwner = entry.querySelector('.proj-mu-edit-nextaction-owner')?.value.trim() || '';
        const nextActionDue = entry.querySelector('.proj-mu-edit-nextaction-due').value;
        const autoCreatePlan = !!entry.querySelector('.proj-mu-edit-autocreate')?.checked;
        const linkedRecipeId = entry.querySelector('.proj-mu-edit-recipe')?.value || '';
        const completedDate = resolveMuCompletedDate(actionTaken, entry.querySelector('.proj-mu-edit-completed-date')?.value || '', new Date().toISOString().slice(0, 10));
        if(!date || (!plan && !actionTaken && !nextAction)){
          alert('Please pick a date and fill in at least one of What / Action Taken / Next Action.');
          return;
        }
        mu.date = date;
        mu.time = time;
        mu.planWho = planWho;
        mu.plan = plan;
        mu.planWhere = planWhere;
        mu.planWith = planWith;
        mu.planOwner = planOwner;
        mu.actionTaken = actionTaken;
        mu.nextActionTime = nextActionTime;
        mu.nextActionWho = nextActionWho;
        mu.nextAction = nextAction;
        mu.nextActionWhere = nextActionWhere;
        mu.nextActionWith = nextActionWith;
        mu.nextActionOwner = nextActionOwner;
        mu.nextActionDue = nextActionDue;
        mu.autoCreatePlan = autoCreatePlan;
        mu.linkedRecipeId = linkedRecipeId;
        mu.attachments = monthlyUpdateDraftAttachments;
        mu.completedDate = completedDate;
        const muChanges = diffMainFields(muEditSnapshotBefore, mu, MU_DIFF_FIELDS);
        monthlyUpdateEditingId = null;
        monthlyUpdateDraftAttachments = [];
        muEditSnapshotBefore = null;
        const autoCreateOk = maybeAutoCreateNextPlan(p, mu);
        scheduleProjectSave(p);
        logActivityEvent('updated', 'project', p.name || 'Untitled project', muChanges);
        renderProjectsList();
        if(!autoCreateOk) alert('"Create as Plan automatically" was checked, but no follow-up Plan was created — Next Action Activity and its due date ("When") must both be filled in first.');
      });
      block.querySelector('[data-role="cancel-monthly-update-edit"]')?.addEventListener('click', () => {
        monthlyUpdateEditingId = null;
        monthlyUpdateDraftAttachments = [];
        muEditSnapshotBefore = null;
        renderProjectsList();
      });
    }else{
      block.querySelector('[data-role="edit-project"]')?.addEventListener('click', () => {
        projectEditingId = p.id;
        monthlyUpdateEditingId = null;
        monthlyUpdateAddOpen = false;
        projectEditSnapshotBefore = snapshotMainFields(p, PROJECT_DIFF_FIELDS);
        cookingGuidelinesEditing = getRequirements(p).cookingCondition.map(g => ({ id: g.id || uid(), method: g.method, steps: [...g.steps] }));
        referenceImagesEditing = getRequirements(p).referenceImages.map(img => ({...img}));
        recipeAttachmentsEditing = getRequirements(p).recipeAttachments.map(a => ({...a}));
        renderProjectsList();
      });
    }

    // Everything below only exists in the DOM when the detail row is
    // rendered (isExpanded) — unlike the old always-rendered-but-hidden
    // .part-body, the table's detail <tr> is only emitted at all when
    // expanded, so these queries would hit null while collapsed.
    if(isExpanded){
      block.querySelectorAll('tr[data-product-id]').forEach(row => {
        const prodId = row.dataset.productId;
        const prod = p.products.find(x => x.id === prodId);
        if(!prod) return;

        if(isEditing){
          row.querySelector('.proj-product-rep').addEventListener('change', e => { prod.salesRep = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.proj-product-stage').addEventListener('change', e => {
            addProductLogEntry(prod, e.target.value, '');
            scheduleProjectSave(p);
            renderProjectsList();
          });
          row.querySelector('[data-role="remove-product"]').addEventListener('click', () => {
            const r = recipes.find(x => x.id === prod.recipeId);
            if(!confirm(`Remove "${r ? recipeDisplayLabel(r) : 'this product'}" from the project? Its progress log will be lost.`)) return;
            p.products = p.products.filter(x => x.id !== prodId);
            scheduleProjectSave(p);
            renderProjectsList();
          });
        }
        row.querySelector('[data-role="open-log"]').addEventListener('click', () => openProductLogModal(p.id, prod.id));
      });

      if(isEditing){
        const addSelect = block.querySelector('.add-product-select');
        block.querySelector('[data-role="add-product"]').addEventListener('click', () => {
          const recipeId = addSelect.value;
          if(!recipeId) return;
          p.products.push(blankProduct(recipeId));
          scheduleProjectSave(p);
          renderProjectsList();
        });
      }

      if(isEditing){
        block.querySelectorAll('.proj-flavors-tbody tr[data-flavor-id]').forEach(row => {
          const flavorId = row.dataset.flavorId;
          const flavor = (p.flavors || []).find(x => x.id === flavorId);
          if(!flavor) return;
          row.querySelector('.flavor-name').addEventListener('change', e => { flavor.name = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.flavor-sample-qty').addEventListener('change', e => { flavor.sampleQty = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.flavor-sample-qty-unit').addEventListener('change', e => { flavor.sampleQtyUnit = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.flavor-sample-request-date').addEventListener('change', e => { flavor.sampleRequestDate = e.target.value; scheduleProjectSave(p); });
          row.querySelector('.flavor-target-price').addEventListener('change', e => { flavor.targetPrice = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.flavor-actual-price').addEventListener('change', e => { flavor.actualPrice = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.flavor-formula-ref').addEventListener('change', e => { flavor.formulaRefCode = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.flavor-note').addEventListener('change', e => { flavor.note = e.target.value.trim(); scheduleProjectSave(p); });
          row.querySelector('.flavor-currency').addEventListener('change', e => { flavor.priceCurrency = e.target.value; scheduleProjectSave(p); });
          row.querySelector('.flavor-unit').addEventListener('change', e => { flavor.priceUnit = e.target.value.trim(); scheduleProjectSave(p); });
          selectTextOnFocus(row.querySelector('.flavor-sample-qty-unit'));
          selectTextOnFocus(row.querySelector('.flavor-unit'));
          row.querySelector('[data-role="remove-flavor"]').addEventListener('click', () => {
            p.flavors = p.flavors.filter(x => x.id !== flavorId);
            scheduleProjectSave(p);
            renderProjectsList();
          });
        });
        block.querySelector('[data-role="add-flavor"]')?.addEventListener('click', () => {
          if(!Array.isArray(p.flavors)) p.flavors = [];
          p.flavors.push(blankFlavor());
          scheduleProjectSave(p);
          renderProjectsList();
        });
      }

      // Status badge and the PLAN / ACTION TAKEN / NEXT ACTION cards all
      // open the same update-popup — works whether or not the project
      // itself is currently in Edit mode, same as Progress Log's
      // "open-log" button above.
      block.querySelectorAll('.mu-status-badge, .mu-card-clickable').forEach(el => {
        el.addEventListener('click', () => {
          const updateId = el.closest('[data-update-id]')?.dataset.updateId;
          if(updateId) openMuEditModal(p.id, updateId, el.dataset.section || null);
        });
      });
      block.querySelectorAll('[data-role="open-mu-recipe"]').forEach(btn => {
        btn.addEventListener('click', () => openRecipeFromDashboard(btn.dataset.recipeId));
      });
      block.querySelectorAll('[data-update-id] .mu-entry-extras [data-role="open-mu-attachment-preview"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const updateId = btn.closest('[data-update-id]')?.dataset.updateId;
          const mu = migrateMonthlyUpdate((p.monthlyUpdates || []).find(x => x.id === updateId) || {});
          const idx = mu.attachments.findIndex(a => a.id === btn.dataset.attachmentId);
          if(idx !== -1) openMuAttachmentPreview(mu.attachments, idx);
        });
      });
      // Same preview popup from the project summary's consolidated
      // "Attachments" section — cycles through every attachment on the
      // project (all updates combined), not just one entry's.
      block.querySelectorAll('.project-all-attachments [data-role="open-mu-attachment-preview"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const all = allProjectAttachments(p);
          const idx = all.findIndex(a => a.id === btn.dataset.attachmentId);
          if(idx !== -1) openMuAttachmentPreview(all, idx);
        });
      });
    }

    block.querySelector('[data-role="delete-project"]')?.addEventListener('click', () => {
      // Defense in depth -- the button itself is already hidden for this
      // project (see the isUnassignedBucket check on the actions cell
      // above), since deleting it would silently break the Calendar's
      // "quick add" bucket until getOrCreateUnassignedProject re-creates
      // a fresh, empty one on next use.
      if(p.isUnassignedBucket) return;
      if(!confirm(`Delete project "${p.name || 'Untitled project'}"? This removes all its products and progress logs. This cannot be undone.`)) return;
      requestAuthConfirm(
        'Confirm Identity to Delete',
        `Enter your password to delete "${p.name || 'Untitled project'}".`,
        () => {
          projects = projects.filter(x => x.id !== p.id);
          moveToTrash('projects', p.id, p, p.name || 'Untitled project');
          deleteProjectFromCloud(p.id);
          logActivityEvent('deleted', 'project', p.name || 'Untitled project');
          renderProjectsList();
        }
      );
    });
  });
}


// One-time wiring for the sidebar entry point plus the persistent nested
// "product progress log" popup + Monthly Update Edit modal (both moved to
// projects-mu-modal.js -- see wireProjectModals there).
export function initProjectsModal(){
  document.getElementById('btnOpenProjects').addEventListener('click', () => guardNavigation(() => {
    setMainFeatureView('projects');
    renderMain();
    renderSidebar();
  }));
  wireProjectModals();
}

/* ---------- Projects: cross-recipe production tracking (shared via Firestore) ---------- */
export let projects = [];

export function attachProjectsListener(){
  unsubscribeProjects = onSnapshot(projectsCol, snapshot => {
    projects = snapshot.docs.map(d => d.data());
    projects.forEach(p => {
      if(!Array.isArray(p.products)) p.products = [];
      p.products.forEach(prod => { if(!Array.isArray(prod.log)) prod.log = []; });
      if(p.image === undefined) p.image = '';
      if(p.startDate === undefined) p.startDate = '';
      if(p.targetEndDate === undefined) p.targetEndDate = '';
    });
    projectsLoaded = true;
    if(mainFeatureView === 'projects') renderProjectsList();
    if(document.getElementById('productLogModalOverlay').classList.contains('open')) renderProductLog();
    if(!currentId && !mainFeatureView && recipesLoaded) renderMain();
  }, err => {
    console.error('Forge: projects listener error', err);
    showCloudError('Failed to load projects from Firebase: ' + err.message);
  });
  attachPendingSubmissionsListener();
}


let projectEditSnapshotBefore = null;
export let muEditSnapshotBefore = null;
// projects-mu-modal.js's MU Edit modal reassigns this too (it shares the
// variable with the inline "edit-monthly-update" row flow above) -- an
// importing module can't reassign another module's `let` directly, same
// fix used for costingMarginVisible/overviewSortKey in the recipes.js split.
export function setMuEditSnapshotBefore(v){ muEditSnapshotBefore = v; }

// A brand new Activities Update entry has no "before" state to diff against
// (see diffMainFields's null-before short-circuit), so it gets its own
// one-line "Added: ..." notification instead of a field-by-field diff.
function logMuAddedEvent(p, mu){
  logActivityEvent('updated', 'project', p.name || 'Untitled project', [{
    field: 'Activities Updates',
    before: '(no entry)',
    after: `Added: "${(mu.plan || mu.actionTaken || mu.nextAction || 'Untitled').trim()}" (${mu.date})`
  }]);
}

// A Where field's value matching a Company Directory entry that has its
// own Locations (see Company Directory's Locations feature) triggers a
// follow-up location picker right below it — selecting one appends
// "(Location)" onto the company name already typed, e.g. "UMIOS ASIA
// OCEANIA CO., LTD. (Office)". Re-recognizes an already-"Company
// (Location)" value on re-edit by stripping the trailing "(...)" before
// matching, so the picker still offers to change it, not just append a
// second one.
export function wireWhereLocationPicker(whereInput, locationSelect){
  if(!whereInput || !locationSelect) return;
  const sync = () => {
    const raw = whereInput.value.trim();
    const companyName = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const company = companyName ? metaLists.customers.find(c => metaItemName(c) === companyName) : null;
    const locations = company?.locations || [];
    if(locations.length){
      locationSelect.innerHTML = `<option value="">- Select location -</option>${locations.map(loc => `<option value="${escapeHtml(loc)}">${escapeHtml(loc)}</option>`).join('')}`;
      locationSelect.style.display = '';
      locationSelect.dataset.companyName = companyName;
    }else{
      locationSelect.style.display = 'none';
      locationSelect.innerHTML = '';
    }
  };
  whereInput.addEventListener('input', sync);
  locationSelect.addEventListener('change', () => {
    const loc = locationSelect.value;
    const companyName = locationSelect.dataset.companyName || '';
    if(loc && companyName) whereInput.value = `${companyName} (${loc})`;
    locationSelect.style.display = 'none';
  });
  sync(); // covers the field already having a value when this wires (editing an existing entry)
}
export function muRecipeOptionsHtml(selectedId){
  return `<option value="">No linked recipe</option>` +
    recipes.slice().sort((a,b) => (a.name||'').localeCompare(b.name||'')).map(r =>
      `<option value="${escapeHtml(r.id)}" ${r.id === selectedId ? 'selected' : ''}>${escapeHtml(recipeDisplayLabel(r))}${fullCode(r) ? ' · ' + escapeHtml(fullCode(r)) : ''}</option>`
    ).join('');
}

// Same layout as renderBarList, but each bar is colored by its own status
// (via PROJECT_STATUS_BAR) instead of one flat color for every bar — so
// "Projects by Status" reads the same way the mini status bar under each
// project's name in the table already does. Every status with at least one
// project gets a strip of every one of its projects shown directly above
// its own bar (formerly a single combined gallery above this whole card —
// moved here so each status's projects sit with that status's own numbers)
// — a project with no photo yet still gets a plain placeholder circle
// rather than being left out of the strip entirely, so the strip's own
// count always matches the status's real project count.
// Both the bar/row and each individual photo are clickable — see
// wireProjectsByStatusCardClicks, wired once after this HTML is inserted
// into the dashboard.
function renderStatusBarList(groups){
  if(!groups.length) return '<div class="dash-empty">No data yet</div>';
  const max = Math.max(...groups.map(g => g.count));
  return groups.map(g => {
    const color = (PROJECT_STATUS_BAR[g.label] || PROJECT_STATUS_BAR['Not Started']).color;
    const projectsForStatus = projects.filter(p => (p.status || PROJECT_STATUSES[0]) === g.label && isProjectCurrentlyVisible(p));
    const photosHtml = projectsForStatus.length ? `
      <div class="proj-gallery-grid" style="margin-bottom:6px;">
        ${projectsForStatus.map(p => `
          <button type="button" class="proj-gallery-item" data-gallery-project-id="${escapeHtml(p.id)}" title="${escapeHtml(p.name || 'Untitled project')}">
            ${p.image
              ? `<img class="proj-gallery-thumb" src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name || 'Project photo')}" style="border-color:${projectPhotoStatusColor(p.status)};box-shadow:0 0 10px ${projectPhotoStatusColor(p.status)};${g.label === 'Cancelled' ? 'filter:grayscale(100%);' : ''}">`
              : `<span class="proj-gallery-thumb proj-gallery-thumb-empty" style="border-color:${projectPhotoStatusColor(p.status)};box-shadow:0 0 10px ${projectPhotoStatusColor(p.status)};${g.label === 'Cancelled' ? 'filter:grayscale(100%);' : ''}">${icon('folder', 22)}</span>`}
            <span class="proj-gallery-name">${escapeHtml(p.name || 'Untitled project')}</span>
          </button>
        `).join('')}
      </div>
    ` : '';
    return `
      <div class="dash-status-group">
        ${photosHtml}
        <button type="button" class="dash-bar-item dash-bar-item-clickable" data-status-filter="${escapeHtml(g.label)}" title="Filter the projects table to ${escapeHtml(g.label)}">
          <div class="dash-bar-label-row"><span>${escapeHtml(g.label)}</span><span class="dbl-count">${g.count}</span></div>
          <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${Math.max(4, Math.round(g.count/max*100))}%;background:${color};"></div></div>
        </button>
      </div>
    `;
  }).join('');
}
// Workload-by-person bar list (see projectsByResponsible above) — same
// dash-bar-item markup/click-to-filter pattern as renderStatusBarList,
// minus the photo gallery, since this is about counts per person rather
// than browsing the projects themselves. The "(Not assigned)" group (key
// === '') is colored danger-red so a PD gap actually stands out instead
// of just being another bar in the list.
function renderResponsibleBarList(groups){
  if(!groups.length) return '<div class="dash-empty">No data yet</div>';
  const max = Math.max(...groups.map(g => g.count));
  return groups.map(g => `
    <button type="button" class="dash-bar-item dash-bar-item-clickable" data-responsible-filter="${escapeHtml(g.key)}" title="Filter the projects table to ${escapeHtml(g.label)}">
      <div class="dash-bar-label-row"><span>${escapeHtml(g.label)}</span><span class="dbl-count">${g.count}</span></div>
      <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${Math.max(4, Math.round(g.count/max*100))}%;background:${g.key === '' ? 'var(--danger)' : 'var(--primary)'};"></div></div>
    </button>
  `).join('');
}


let unsubscribeProjects = null;
let projectsLoaded = false;

// Tears down the projects Firestore listener and resets its load-state to
// empty — called from the shared sign-out handler in app.js, kept here so
// that handler doesn't need write access to bindings this module owns
// (same pattern as resetMaterialsState/resetTrialsState/resetRefListsState).
// Only resets load-state, not UI-transient editing state (projectEditingId,
// projectColumnFilters, etc.) — same convention the other three follow.
export function resetProjectsState(){
  if(unsubscribeProjects){ unsubscribeProjects(); unsubscribeProjects = null; }
  resetPendingSubmissionsState();
  projectsLoaded = false;
  projects = [];
}

// Small exported setters for the two places app.js's own Dashboard code
// needs to change Projects-owned state from outside this module (a plain
// `projectColumnFilters = ...`/`openProjectFilterMenuKey = ...` assignment
// from app.js isn't possible — ES modules can't reassign a sibling
// module's `let` binding from outside it).
export function setProjectStatusFilter(status){
  projectColumnFilters = { status: new Set([status]) };
}
export function closeProjectFilterMenu(){
  openProjectFilterMenuKey = null;
}
// Same reasoning, for the Projects toolbar's own Who filter panel (see
// renderProjectWhoFilter) -- also removes the 'open' class itself, since
// (unlike openProjectFilterMenuKey's menus) nothing else re-renders
// #projectWhoFilterWrap on a plain outside click.
export function closeProjectWhoMenu(){
  if(!projectWhoMenuOpen) return;
  projectWhoMenuOpen = false;
  document.getElementById('projectWhoMenu')?.classList.remove('open');
}

// Re-exported here (rather than importers pulling them from
// projects-data.js/projects-requirements.js directly) since app.js and
// app-dashboard.js already import these from projects.js and that public
// surface shouldn't change just because the split moved where each name
// is actually declared.
export {
  projectExpandedIds, unsubscribeProjects, openProjectFilterMenuKey, activeProjScrollbarProxySync,
  PROJECT_STATUS_LABELS, getRequirements, projectWhoMenuOpen, migrateMonthlyUpdate, muPlanSummaryLine,
  monthlyUpdateStatus, getTaskStatus, daysBetween, projectHasUpdateThisMonth, projectProgressPct,
  statusPillHtml, projectNextAction, blankProduct, scheduleProjectSave, certificateSummaryText
};
