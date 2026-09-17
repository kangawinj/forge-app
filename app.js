/* ---------- Firebase (shared cloud backend) ----------
   Every device that opens this file talks to the same Firebase project, so
   recipes and the ingredient library sync across computers automatically.
   access is controlled by Firestore security rules + Firebase Auth. */
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { APP_VERSION, renderFooter } from './app-changelog.js';
import { icon } from './app-icons.js';
// Re-exported: `icon` used to be declared directly in this file, so every
// other module in the app already imports it from './app.js' -- moving it
// to app-icons.js must not change that public surface.
export { icon };
import {
  readOnlyProcessesHtml, renderReadOnlyProcessFlowchart, readOnlyIngredientTreeHtml,
  computePrepareWeight, computeIngredientCost, isValidYieldPct, partPrepareWeight
} from './app-shared-render.js';
// Re-exported for the same reason as `icon` above -- these all used to be
// declared directly in this file.
export {
  readOnlyProcessesHtml, renderReadOnlyProcessFlowchart, readOnlyIngredientTreeHtml,
  computePrepareWeight, computeIngredientCost, isValidYieldPct, partPrepareWeight
};
import { moveToTrash, initTrashModal, purgeExpiredTrashOnLoad } from './app-trash.js';
// Re-exported for the same reason as `icon` above.
export { moveToTrash };
import { exportAll, importFromFile } from './app-backup.js';
import {
  renderDashboardHome, wireDashboardHome, refreshDashboardHome, goHome,
  setHomeCalendarPanes, renderBarList, openRecipeFromDashboard, closeDashboardWhoMenus
} from './app-dashboard.js';
// Re-exported for the same reason as `icon` above.
export { renderBarList, openRecipeFromDashboard };
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut,
  EmailAuthProvider, reauthenticateWithCredential, sendPasswordResetEmail,
  updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, writeBatch,
  query, orderBy, limit, getDocs, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { mountCompareView, setCompareSeriesPrefilter } from './compare.js';
import { mountSeriesMigrationView } from './seriesMigration.js';
import {
  mountTrialsView, renderTrialsList, trialExpandedIds, trials, attachTrialsListener,
  unsubscribeTrials, migrateTrialsFromRecipes, resetTrialsState
} from './trials.js';
import {
  ingredientMaster, mountMaterialsView, renderMaterialTable, closeMaterialDetail, openMaterialDetail,
  attachMaterialsListener, unsubscribeMaterials, resetMaterialsState, editMaterialFromDetail
} from './materials.js';
import {
  productList, mountProductsView, closeProductDetail,
  attachProductsListener, unsubscribeProducts, resetProductsState, compositionSummaryText
} from './products.js';
import {
  mountSampleSubmissionsView, attachSampleSubmissionsListener,
  unsubscribeSubmissions, resetSampleSubmissionsState
} from './sampleSubmissions.js';
import {
  metaLists, metaItemName, productTypeCode, mountRefListsView, attachMetaListsListener,
  unsubscribeMetaLists, resetRefListsState, FOOD_ALLERGEN_COLUMNS
} from './reflists.js';
import {
  mountProjectsView, guardNavigation, initUnsavedChangesGuard, attachProjectsListener,
  unsubscribeProjects, resetProjectsState, setProjectStatusFilter, closeProjectFilterMenu,
  projects, projectExpandedIds, renderProjectsList, migrateMonthlyUpdate, muPlanSummaryLine,
  monthlyUpdateStatus, getTaskStatus, daysBetween, projectHasUpdateThisMonth,
  projectProgressPct, statusPillHtml, projectNextAction, initProjectsModal,
  initMuAttachmentPreviewModal, openProjectFilterMenuKey, activeProjScrollbarProxySync,
  blankProduct, scheduleProjectSave, PROJECT_STATUS_LABELS, getRequirements, quickAddCalendarPlan,
  projectWhoMenuOpen, closeProjectWhoMenu, certificateSummaryText
} from './projects.js';
import {
  recipes, currentId, unlockedRecipeId, recipesLoaded, unsubscribeRecipes,
  RECIPE_DIFF_FIELDS, attachRecipesListener,
  refreshCodeCountryBadge, updateRecipeTitleDisplay, getCurrent, scheduleSave,
  saveNow, renderLinkedProjectSection, renderProductTypeSelect,
  refreshCodeProductTypeBadge, bindComboField,
  resetRecipesState, openRecipe, closeRecipe,
  setRecipeEditSnapshotBefore, setUnlockedRecipeId, removeRecipe,
  renderRecipeEditor
} from './recipes.js';
import {
  findProjectForRecipe, fullCode, recipeDisplayLabel, descriptionListHtml,
  yearPrefix, suggestNextRecipeSeq, blankPart, migrateRecipe, saveRecipeToCloud,
  recomputeFromWeights, allIngredientsInPart, allIngredientsInRecipe, formatWeight,
  partTotalWeight, computeFlowNodeText, DEFAULT_FLOW_NODE_W, rectOf, clipToRectEdge,
  FLOW_ARROWHEAD_DEFS
} from './recipes-data.js';
import {
  scheduleVersionCheckpoint, cancelVersionCheckpoint, autoCheckpointVersion,
  openVersionsModal, initVersionPreviewModal, initVersionsModal
} from './recipes-versions.js';
import {
  mountRecipesListView, renderRecipeCards, renderSidebarRecipeCards, renderRecipesListGrid
} from './recipes-list.js';
// metaLists/metaItemName are imported above for app.js's own use (Recipes'
// bindComboField etc.) — re-exported as-is so projects.js can import them
// from app.js too, keeping every split module's imports pointed at
// app.js only rather than at a sibling module directly.
// `projects` is also imported above (for app.js's own Recipes-linking
// code) — re-exported so trials.js can keep importing it from app.js too,
// same reasoning as metaLists/metaItemName above.
export {
  metaLists, metaItemName, projects, guardNavigation, migrateTrialsFromRecipes,
  ingredientMaster, productTypeCode, recipes, currentId, recipesLoaded,
  findProjectForRecipe, fullCode, recipeDisplayLabel, descriptionListHtml,
  blankProduct, scheduleProjectSave, recomputeFromWeights, allIngredientsInPart,
  allIngredientsInRecipe, formatWeight, PROJECT_STATUS_LABELS, getRequirements,
  isCurrentUserAdmin, isMyProject, projectMatchesName, myLinkedName, namesMatch,
  openMaterialDetail, setCompareSeriesPrefilter, productList, hasModuleAccess, compositionSummaryText,
  autoGrowTextarea, FOOD_ALLERGEN_COLUMNS, certificateSummaryText
};

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
const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
export const recipesCol = collection(db, "recipes");
// One doc per Recipe Series (e.g. "AU26-SAU06"), holding the atomic Trial-
// number counter (maxTrialNo) every "+ New Trial" runTransaction() reads
// and increments — see createNewTrial() in recipes.js. Firestore
// transactions can only read specific document references, never a query,
// so this counter doc is the only way to make Trial numbering collision-
// safe under concurrent creation.
export const recipeSeriesCol = collection(db, "recipeSeries");
export const materialsCol = collection(db, "ingredientMaster");
export const productsCol = collection(db, "productList");
export const projectsCol = collection(db, "projects");
export const trialsCol = collection(db, "trials");
export const sampleSubmissionsCol = collection(db, "sampleSubmissions");
// One doc per calendar year (id = "2026"), holding the atomic Form No.
// counter (maxSeq) every "+ New Submission"/first-save runTransaction()
// reads and increments — see issueSubmissionFormNo() in
// sampleSubmissions.js. Same collision-safe-counter reasoning as
// recipeSeriesCol above.
export const sampleSubmissionCountersCol = collection(db, "sampleSubmissionCounters");
// A full snapshot of any deleted Recipe/Ingredient/Product/Project/Trial/
// Sample Submission, kept for 30 days so a delete can be undone from the
// Trash screen (see moveToTrash/restoreFromTrash/purgeExpiredTrash in
// app-trash.js) instead of needing a full Firestore backup restore for an
// everyday mistake. Every entity's own delete flow already re-confirms
// identity (or the approver's, for Recipes/Ingredients/Products) before it
// ever runs — Trash doesn't add another gate on top of that, it's purely a
// safety net for after a delete already happened.
export const trashCol = collection(db, "trash");
// Keyed by the same string each entity's delete flow passes to
// moveToTrash — maps back to that collection's own reference so
// restoreFromTrash can write the snapshot back to exactly where it came
// from, and to a human label for the Trash list. Stays here (not moved to
// app-trash.js) since it's a plain top-level const built immediately from
// the collection refs above -- see app-trash.js's own top-of-file comment.
export const TRASH_COLLECTION_MAP = {
  recipes: { col: recipesCol, label: 'Recipe' },
  ingredientMaster: { col: materialsCol, label: 'Ingredient' },
  productList: { col: productsCol, label: 'Product' },
  projects: { col: projectsCol, label: 'Project' },
  trials: { col: trialsCol, label: 'Test Result' },
  sampleSubmissions: { col: sampleSubmissionsCol, label: 'Sample Submission' }
};
export const TRASH_RETENTION_DAYS = 30;
// Draft project submissions from the public, no-login "share a link"
// intake page (submit.html) — see the /pendingSubmissions rule in
// firestore.rules for how a random per-link token (not auth) scopes
// access there. Only ever read/written from inside the app by an
// approved team member reviewing and importing a submission.
export const pendingSubmissionsCol = collection(db, "pendingSubmissions");
// A trial's own "Share External Evaluation" link/QR (see
// renderTrialShareModal in trials.js) and the guest responses that come
// back through it -- see the matching /evaluationLinks and
// /evaluationResponses rules in firestore.rules for the token-scoped,
// no-login access model, same shape as pendingSubmissionsCol above.
export const evaluationLinksCol = collection(db, "evaluationLinks");
export const evaluationResponsesCol = collection(db, "evaluationResponses");
// Append-only audit log of sign-ins — who, and when. Read by everyone on the
// team (via the notification bell), written once per successful login/signup
// by that same user (see the Firestore rule: create is allowed only when the
// event's own email matches the signed-in requester's).
const loginEventsCol = collection(db, "loginEvents");
// Append-only audit log of adds/edits/deletes across Recipes, Projects,
// Trials, and Ingredients — merged with loginEvents in the notification
// bell (see renderNotificationsBell) so it reads as one combined feed:
// who signed in, and who added/edited/deleted what. An "edit" is logged
// once per Save/lock action, not per autosave tick — recipes/projects
// autosave on nearly every keystroke, so logging that directly would bury
// the feed in noise instead of surfacing anything useful.
export const activityEventsCol = collection(db, "activityEvents");
// One doc per Firebase Auth account (keyed by uid), tracking whether an
// admin has approved that sign-up to actually use the app — see
// firestore.rules for the matching server-side enforcement (isApproved()).
const userApprovalsCol = collection(db, "userApprovals");
// One doc per account (keyed by uid) holding My Profile's display name +
// photo — separate from Firebase Auth's own displayName/photoURL fields
// since a resized photo as a data URI can exceed what Auth's profile
// fields accept, same reason every other photo in this app (Projects,
// Trials, etc.) lives in a Firestore doc rather than Auth/Storage.
export const userProfilesCol = collection(db, "userProfiles");
// One doc per account (keyed by uid), holding just a heartbeat timestamp --
// see attachPresenceListeners/sendPresenceHeartbeat below. No Realtime
// Database in this app, so there's no true on-disconnect signal; "online"
// is approximated client-side as "this doc's lastSeen is recent enough",
// re-checked on a timer so someone reads as offline again a little after
// they actually close the tab, not just whenever the next write happens to
// land.
const presenceCol = collection(db, "presence");
/* Single shared document holding the "type to add" suggestion lists for
   Customer Name / Destination Country / Sales Rep — much lighter than a
   full master-data collection like ingredientMaster since these are just
   plain strings, not records with their own fields. */
export const metaListsDoc = doc(collection(db, "metaLists"), "shared");

/* Secondary, isolated Firebase app instance used only to verify the delete
   approver's password and perform the delete itself — signing in here never
   touches the main `auth` session, so whoever is actually browsing the app
   stays logged in as themselves throughout. */
const approverApp = initializeApp(firebaseConfig, "approver");
const approverAuth = getAuth(approverApp);
const approverDb = getFirestore(approverApp);
export const approverRecipesCol = collection(approverDb, "recipes");
export const approverMaterialsCol = collection(approverDb, "ingredientMaster");
export const approverProductsCol = collection(approverDb, "productList");

/* New sign-ups are restricted to this company email domain (plus the
   approver email below) — enforced here client-side, and again in
   Firestore security rules server-side. */
const ALLOWED_EMAIL_DOMAIN = "th-umios.com";

/* Deleting a recipe always requires this specific account's email + password,
   regardless of who is currently logged in — verified via a separate,
   isolated Firebase auth session (see approverAuth above) so it never
   disturbs the main logged-in user's session. Enforced again in Firestore
   security rules server-side (only this email may perform a delete). */
export const DELETE_APPROVER_EMAIL = "kangawin@th-umios.com";

// Same person as DELETE_APPROVER_EMAIL — separate constant because this one
// gates a broader "admin" role (approving new sign-ups, sending a member a
// password-reset email), not just deletions. Keep in sync manually with
// isAdmin() in firestore.rules if this ever changes.
const ADMIN_EMAIL = "kangawin@th-umios.com";
// New sign-ups (and the admin/test accounts, who are exempt from needing
// approval at all — see isApprovalExempt) go through this: their
// userApprovals doc must say 'approved' before they get real app access.
// Enforced again in firestore.rules server-side (isApproved()).
function isApprovalExempt(email){
  return email === ADMIN_EMAIL || email === 'forge-setup-test@example.com';
}

// Per-user access to whole nav-level modules (Projects/Trials/Ingredients/
// Reference Lists) — set by the admin in Manage Users, stored on the same
// userApprovals/{uid} doc that already holds pending/approved status (same
// doc, same admin-only write rule, so "only the admin can set this" comes
// for free). Recipes itself is deliberately NOT one of these — it's the
// app's core function with too many entry points (sidebar, notifications,
// Activities Updates links) to gate cleanly, and every approved user needs
// it anyway. This is UI-only enforcement (hides the nav tab) — it does not
// lock the underlying Firestore collections, so it's meant to declutter the
// nav for each person's role, not as a hard security boundary.
const MODULE_PERMISSIONS = [
  { key: 'recipes', label: 'Recipes', navBtnId: 'btnRecipesTab' },
  { key: 'projects', label: 'Projects', navBtnId: 'btnOpenProjects' },
  { key: 'trials', label: 'Test Results', navBtnId: 'btnOpenTrials' },
  { key: 'materials', label: 'Ingredients', navBtnId: 'btnOpenMaterialLibSidebar' },
  { key: 'productList', label: 'Products', navBtnId: 'btnOpenProductsTab' },
  { key: 'sampleSubmissions', label: 'Sample Submissions', navBtnId: 'btnOpenSampleSubmissionsTab' },
  { key: 'refLists', label: 'Reference Lists', navBtnId: 'btnOpenRefLists' }
];
// Missing/undefined defaults to true (granted) so existing approved users
// keep full access the moment this ships, with nothing to migrate — a
// module is only hidden once the admin explicitly flips it off.
function userModulePermissions(item){
  const stored = item?.permissions || {};
  const out = {};
  MODULE_PERMISSIONS.forEach(m => { out[m.key] = stored[m.key] !== false; });
  return out;
}
let myModulePermissions = null; // null = unrestricted (admin/exempt, or not loaded yet)
function hasModuleAccess(key){
  return !myModulePermissions || myModulePermissions[key] !== false;
}

// Per-project/per-activity visibility for non-admins: everyone can see
// every project's data in Firestore (this is UI-only, same caveat as
// MODULE_PERMISSIONS above), but the Projects list and the Home
// dashboard's Task Tracking / Activities Calendar only show projects and
// activities the signed-in person is actually involved in, matched
// against the free-text name fields (Owner/Factory Rep/Responsible
// Person, per-product Sales Rep, and each Activities Update's Who/Next
// Action Who) — there's no real user-account link for those fields,
// they're plain typed text. The Unassigned bucket project (see
// quickAddCalendarPlan) is always visible to everyone since it exists
// precisely for plans nobody's claimed yet.
function isCurrentUserAdmin(){
  return currentUser?.email === ADMIN_EMAIL;
}
// Case-insensitive, and tolerant of honorific/suffix differences (e.g. a
// profile named "Yano" should still match a field typed "Yano-san") via
// substring containment — guarded to at least 3 characters so a short
// name can't accidentally match everything.
function namesMatch(a, b){
  const x = (a || '').trim().toLowerCase();
  const y = (b || '').trim().toLowerCase();
  if(!x || !y) return false;
  if(x === y) return true;
  const shorter = x.length <= y.length ? x : y;
  if(shorter.length < 3) return false;
  return x.includes(y) || y.includes(x);
}
// The name to match project/activity fields against for the signed-in
// person — prefers their Contact Directory entry (Reference Lists >
// Contact Directory), looked up by matching that entry's own Email field
// against their login email, over their self-typed My Profile display
// name. This is the actual "link a user's email to a name in the Contact
// Directory" — filling in a contact's Email field with that person's
// Forge login email is what connects the two; a Contact entry is trusted
// over My Profile since it's admin/team-maintained and reused everywhere
// names are typed in Projects, so it's far less likely to drift out of
// sync than a free-text profile field nobody's told to keep in sync.
function myLinkedName(){
  const email = (currentUser?.email || '').trim().toLowerCase();
  if(email){
    const contact = (metaLists.salesReps || []).find(c => {
      const contactEmail = typeof c === 'object' ? (c.email || '') : '';
      return contactEmail.trim().toLowerCase() === email;
    });
    if(contact) return metaItemName(contact);
  }
  return myProfile.displayName;
}
function isMyName(name){
  return namesMatch(name, myLinkedName());
}
// Does this project belong to the given person, by fuzzy name match
// (see namesMatch) against every name-bearing field a project has --
// Owner/Factory Sales Rep/Responsible Person, each Product's own Sales
// Rep, and every Activities Update's Plan/Next Action Who. isMyProject
// (below) is this called with "me" (myLinkedName), plus the
// admin/Unassigned-bucket shortcuts layered on top there; the Projects
// page's Who filter (see projects.js) calls this directly for arbitrary
// colleagues, since a colleague's entry there should only ever match
// their actual name, never auto-pass for admin.
function projectMatchesName(p, name){
  if(namesMatch(p?.ownerSalesRep, name) || namesMatch(p?.factorySalesRep, name) || namesMatch(p?.responsiblePerson, name)) return true;
  if((p?.products || []).some(prod => namesMatch(prod.salesRep, name))) return true;
  if((p?.monthlyUpdates || []).map(migrateMonthlyUpdate).some(mu => namesMatch(mu.planWho, name) || namesMatch(mu.nextActionWho, name))) return true;
  return false;
}
function isMyProject(p){
  if(isCurrentUserAdmin() || p?.isUnassignedBucket) return true;
  return projectMatchesName(p, myLinkedName());
}
// A single Activities Update entry is visible if it names this person
// directly (even inside a project they're not otherwise attached to —
// e.g. covering a colleague's task) or if they're attached to the whole
// project some other way.
export function isMyActivity(p, mu){
  return isMyName(mu?.planWho) || isMyName(mu?.nextActionWho) || isMyProject(p);
}

export function showCloudError(message){
  const el = document.getElementById('cloudErrorBanner');
  if(!el) return;
  el.textContent = message;
  el.style.display = 'block';
}


/* ---------- Auth (Firebase Authentication) ----------
   Every teammate signs in with their own email/password, managed by Firebase
   — real per-user accounts shared across every device, not per-browser. */
export let currentUser = null; // Firebase User, set by onAuthStateChanged
let appView = 'auth'; // 'auth' | 'pending' | 'app'
let pendingAuthCallback = null;
// This account's own live approval status — null (not yet loaded) |
// 'pending' | 'approved' | 'rejected' | 'exempt' (admin/test account,
// see isApprovalExempt). Kept live via onSnapshot so an admin approving
// someone while they still have the "waiting" screen open unlocks it
// immediately, no re-login needed.
let myApprovalStatus = null;
let unsubscribeMyApproval = null;
// Only the admin ever attaches this — see renderUserAdminPanel — a live
// listener over every userApprovals doc so the panel can list pending
// requests and every account's status.
let unsubscribeUserApprovalsAdmin = null;
let userApprovalsAdminList = [];
// This account's own My Profile doc — kept live so the navbar name/avatar
// (and the My Profile modal, if open) always reflect the latest saved
// value without needing a manual refresh.
export let myProfile = { displayName: '', photoImage: '' };
let unsubscribeMyProfile = null;
let editingProfileImage = ''; // staged photo for the My Profile modal, same pattern as newProjectImage

// ---------- Online presence (navbar avatar cluster) ----------
// Raw presence docs (one per account that's ever signed in, keyed by uid)
// and every account's My Profile (for the photo/display name to show next
// to a presence doc) -- kept as two separate live collections rather than
// duplicating photo/name onto each presence doc, so there's exactly one
// place (My Profile) that can ever go stale.
let presenceList = [];
let allUserProfiles = {}; // uid -> { displayName, photoImage }
let unsubscribePresence = null;
let unsubscribeAllUserProfiles = null;
let presenceHeartbeatInterval = null;
let presenceRenderInterval = null;
// A presence doc's lastSeen older than this reads as "offline" -- well
// past PRESENCE_HEARTBEAT_MS so a normal gap between heartbeats never
// flickers someone offline and back.
const PRESENCE_HEARTBEAT_MS = 25000;
const PRESENCE_STALE_MS = 70000;

function authErrorMessage(err){
  const map = {
    'auth/invalid-email': 'Invalid email',
    'auth/user-not-found': 'Account not found — please sign up first',
    'auth/wrong-password': 'Incorrect email or password',
    'auth/invalid-credential': 'Incorrect email or password',
    'auth/email-already-in-use': 'This account already exists — please log in instead',
    'auth/weak-password': 'Password must be at least 6 characters'
  };
  return map[err.code] || ('Error: ' + err.message);
}

// Derives a display name + avatar initials from the account email — there's
// no separate "display name" field, so the local-part (before the @) stands
// in for one, same as the old sidebar's "Logged in as" box did.
export function accountDisplayFromEmail(email){
  const local = (email || '').split('@')[0] || '';
  const name = local ? local.charAt(0).toUpperCase() + local.slice(1) : '';
  const initials = local ? local.slice(0, 2).toUpperCase() : '';
  return { name, initials };
}

function renderApp(){
  document.getElementById('authScreen').classList.toggle('active', appView === 'auth');
  document.getElementById('pendingScreen').classList.toggle('active', appView === 'pending');
  document.getElementById('appRoot').style.display = appView === 'app' ? 'grid' : 'none';
  document.getElementById('topNavbar').style.display = appView === 'app' ? 'flex' : 'none';
  const { name, initials } = accountDisplayFromEmail(currentUser?.email);
  document.getElementById('navbarAvatarInitials').textContent = initials;
  const avatarImg = document.getElementById('navbarAvatarImg');
  if(myProfile.photoImage){
    avatarImg.src = myProfile.photoImage;
    avatarImg.style.display = 'block';
    document.getElementById('navbarAvatarInitials').style.display = 'none';
  }else{
    avatarImg.style.display = 'none';
    document.getElementById('navbarAvatarInitials').style.display = '';
  }
  document.getElementById('navbarAccountName').textContent = myProfile.displayName || name;
  document.getElementById('navbarAccountEmail').textContent = currentUser ? currentUser.email : '';
  const isAdminUser = currentUser?.email === ADMIN_EMAIL;
  document.getElementById('btnOpenUserAdmin').style.display = isAdminUser ? '' : 'none';
  document.getElementById('btnOpenSeriesMigration').style.display = isAdminUser ? '' : 'none';
  MODULE_PERMISSIONS.forEach(m => {
    const btn = document.getElementById(m.navBtnId);
    if(btn) btn.style.display = hasModuleAccess(m.key) ? '' : 'none';
  });
}

function goToAuth(){
  signOut(auth);
}

function goToApp(){
  closeRecipe();
  mainFeatureView = null;
  restoreLastView();
  appView = 'app';
  renderApp();
  renderSidebar();
  renderMain();
}

function renderPendingScreen(){
  const body = document.getElementById('pendingScreenBody');
  if(!body) return;
  if(myApprovalStatus === 'rejected'){
    body.innerHTML = `
      <div class="auth-sub" style="margin-bottom:0;">
        Your sign-up for <b>${escapeHtml(currentUser?.email || '')}</b> was not approved.
        Contact ${escapeHtml(ADMIN_EMAIL)} if you think this is a mistake.
      </div>
    `;
  }else{
    body.innerHTML = `
      <div class="auth-sub" style="margin-bottom:0;">
        Thanks for signing up! Your account (<b>${escapeHtml(currentUser?.email || '')}</b>)
        is waiting for a team admin to approve it before you can sign in.
        This page will update on its own once that happens.
      </div>
    `;
  }
}

function initAuthScreen(){
  const tabLogin = document.getElementById('tabLoginBtn');
  const tabRegister = document.getElementById('tabRegisterBtn');
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');

  tabLogin.addEventListener('click', () => {
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    loginForm.classList.add('active');
    registerForm.classList.remove('active');
  });
  tabRegister.addEventListener('click', () => {
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    registerForm.classList.add('active');
    loginForm.classList.remove('active');
  });

  loginForm.addEventListener('submit', e => {
    e.preventDefault();
    const email = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('loginError');
    errEl.textContent = '';
    document.getElementById('loginResetSent').textContent = '';
    signInWithEmailAndPassword(auth, email, password)
      .then(cred => logLoginEvent(cred.user.email))
      .catch(err => { errEl.textContent = authErrorMessage(err); });
  });

  document.getElementById('btnForgotPassword').addEventListener('click', () => {
    const errEl = document.getElementById('loginError');
    const successEl = document.getElementById('loginResetSent');
    errEl.textContent = '';
    successEl.textContent = '';
    const email = document.getElementById('login-username').value.trim();
    if(!email){
      errEl.textContent = 'Enter your email above first, then click "Forgot password?"';
      return;
    }
    sendPasswordResetEmail(auth, email)
      .then(() => { successEl.textContent = `Password reset email sent to ${email} — check your inbox.`; })
      .catch(err => { errEl.textContent = authErrorMessage(err); });
  });

  registerForm.addEventListener('submit', e => {
    e.preventDefault();
    const email = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const password2 = document.getElementById('reg-password2').value;
    const errEl = document.getElementById('registerError');

    const emailLower = email.toLowerCase();
    if(!emailLower.endsWith('@' + ALLOWED_EMAIL_DOMAIN) && emailLower !== DELETE_APPROVER_EMAIL.toLowerCase()){
      errEl.textContent = `Only @${ALLOWED_EMAIL_DOMAIN} email addresses can sign up`;
      return;
    }
    if(password.length < 6){
      errEl.textContent = 'Password must be at least 6 characters';
      return;
    }
    if(password !== password2){
      errEl.textContent = 'Passwords do not match';
      return;
    }
    errEl.textContent = '';
    createUserWithEmailAndPassword(auth, email, password)
      .then(cred => {
        logLoginEvent(cred.user.email);
        // Always created as 'pending' — Firestore rules only ever allow a
        // brand-new account to create its OWN doc with that status (never
        // 'approved', that'd be self-approval). Admin/test accounts still
        // get a doc for consistency in the admin panel's user list, but
        // isApprovalExempt() bypasses the pending-gate for them regardless
        // of what this doc says, both here client-side and in the rules.
        return setDoc(doc(userApprovalsCol, cred.user.uid), {
          email: cred.user.email,
          status: 'pending',
          requestedAt: Date.now(),
          decidedBy: '',
          decidedAt: null
        });
      })
      .catch(err => { errEl.textContent = authErrorMessage(err); });
  });

  document.getElementById('btnPendingLogout').addEventListener('click', goToAuth);
}

function logLoginEvent(email){
  return setDoc(doc(loginEventsCol, uid()), { email, timestamp: Date.now() })
    .catch(err => console.error('Forge: failed to log login event', err));
}

let pendingRequiredEmail = null;
let pendingApproverAction = null;

/* options: { requireEmail, approverAction } — when requireEmail is set, the
   modal asks for that specific account's email + password (verified via the
   isolated approverAuth session above) and runs approverAction() while still
   signed in as the approver, before signing back out. Omit both to fall back
   to the normal "confirm your own password" flow for the logged-in user. */
export function requestAuthConfirm(title, message, onSuccess, options = {}){
  document.getElementById('authConfirmTitle').textContent = title;
  document.getElementById('authConfirmMessage').textContent = message;
  document.getElementById('authConfirmForm').reset();
  document.getElementById('authConfirmError').textContent = '';
  setAuthConfirmPasswordVisible(false);
  pendingAuthCallback = onSuccess;
  pendingRequiredEmail = options.requireEmail || null;
  pendingApproverAction = options.approverAction || null;
  document.getElementById('authConfirmEmailField').style.display = pendingRequiredEmail ? 'block' : 'none';
  if(pendingRequiredEmail){
    document.getElementById('authConfirmEmail').value = pendingRequiredEmail;
  }
  document.getElementById('authConfirmModalOverlay').classList.add('open');
  document.getElementById('authConfirmPassword').focus();
}

function closeAuthConfirm(){
  document.getElementById('authConfirmModalOverlay').classList.remove('open');
  pendingAuthCallback = null;
  pendingRequiredEmail = null;
  pendingApproverAction = null;
}

// Toggles the password field between masked and plain text, so a typo
// (wrong keyboard language, stray character) can be caught by reading it
// back before submitting. Always reset to hidden when the modal opens
// (see requestAuthConfirm) so a revealed password doesn't carry over to
// the next time it's used.
function setAuthConfirmPasswordVisible(visible){
  document.getElementById('authConfirmPassword').type = visible ? 'text' : 'password';
  const btn = document.getElementById('btnToggleAuthConfirmPassword');
  btn.innerHTML = icon(visible ? 'eye-off' : 'eye', 16);
  btn.title = visible ? 'Hide password' : 'Show password';
}

function initAuthConfirmModal(){
  document.getElementById('btnCloseAuthConfirm').addEventListener('click', closeAuthConfirm);
  wireModalOverlayClose('authConfirmModalOverlay', closeAuthConfirm);
  document.getElementById('btnToggleAuthConfirmPassword').addEventListener('click', () => {
    setAuthConfirmPasswordVisible(document.getElementById('authConfirmPassword').type === 'password');
  });
  document.getElementById('authConfirmForm').addEventListener('submit', e => {
    e.preventDefault();
    const password = document.getElementById('authConfirmPassword').value;
    const errEl = document.getElementById('authConfirmError');

    if(pendingRequiredEmail){
      const enteredEmail = document.getElementById('authConfirmEmail').value.trim();
      if(enteredEmail.toLowerCase() !== pendingRequiredEmail.toLowerCase()){
        errEl.textContent = 'Incorrect email or password';
        return;
      }
      const action = pendingApproverAction;
      signInWithEmailAndPassword(approverAuth, enteredEmail, password)
        .then(() => {
          // Signed in successfully — from here on, any failure is NOT a
          // credential problem, so surface the real reason instead of the
          // generic "incorrect email or password" message.
          return Promise.resolve(action ? action() : null)
            .then(() => signOut(approverAuth))
            .then(() => {
              const callback = pendingAuthCallback;
              closeAuthConfirm();
              if(callback) callback();
            })
            .catch(err => {
              signOut(approverAuth);
              console.error('Forge: approver action failed', err);
              errEl.textContent = 'Signed in, but the action itself failed: ' + err.message;
            });
        })
        .catch(err => {
          console.error('Forge: approver sign-in failed', err);
          errEl.textContent = 'Incorrect email or password';
        });
      return;
    }

    if(!currentUser){
      errEl.textContent = 'Session expired — please log in again';
      return;
    }
    reauthenticateWithCredential(currentUser, EmailAuthProvider.credential(currentUser.email, password))
      .then(() => {
        const callback = pendingAuthCallback;
        closeAuthConfirm();
        if(callback) callback();
      })
      .catch(() => { errEl.textContent = 'Incorrect password'; });
  });
}

function initRefListsView(){
  document.getElementById('btnOpenRefLists').addEventListener('click', () => guardNavigation(() => {
    mainFeatureView = 'refLists';
    renderMain();
    renderSidebar();
  }));
}

/* ---------- Projects modal (tracks a project's products against existing
   recipes, each with a sales rep, a current stage, and an append-only
   progress log — changing a product's stage always adds a log entry, so
   the log stays the single source of truth for "what happened when"). ---------- */
export const PROJECT_STAGES = ['Requested','Formulating','Sampling','Customer Review','Approved','In Production','On Hold','Cancelled'];

// Flavor pricing (see blankFlavor) — 3-letter codes rather than symbols,

// Shared by Reference Lists' Company Directory "Locations" field and Test
// Results' Test Participants/Cooking Method (see trials.js) — a plain
// numbered list of strings, add/remove one at a time. `addRole` becomes
// both the "add-<addRole>" and "remove-<addRole>" data-role the wiring
// below listens for.
export function trialStringListHtml(items, isEditing, inputClass, addRole, placeholder, datalistId){
  const list = items || [];
  const rows = list.map((val, idx) => `
    <div class="trial-string-list-row" data-idx="${idx}">
      <span class="trial-string-list-num">${idx + 1}.</span>
      <input type="text" class="${inputClass}" value="${escapeHtml(val)}" placeholder="${escapeHtml(placeholder)}" ${datalistId ? `list="${datalistId}"` : ''} ${isEditing ? '' : 'readonly'}>
      ${isEditing ? `<button type="button" class="icon-btn" data-role="remove-${addRole}" data-idx="${idx}" title="Remove">${icon('x')}</button>` : ''}
    </div>
  `).join('');
  const empty = !list.length && !isEditing ? '<div class="overview-empty">None listed</div>' : '';
  const addBtn = isEditing ? `<button type="button" class="btn btn-sm add-row-btn" data-role="add-${addRole}">+ Add</button>` : '';
  return rows + empty + addBtn;
}

function initTrialsView(){
  document.getElementById('btnOpenTrials').addEventListener('click', () => guardNavigation(() => {
    mainFeatureView = 'trials';
    renderMain();
    renderSidebar();
  }));
}



/* ---------- Manage Users (admin-only) ----------
   Visible only to ADMIN_EMAIL (see renderApp's btnOpenUserAdmin toggle).
   Lists every userApprovals doc — pending requests up top with Approve/
   Reject, then everyone underneath with their current status and a "Send
   Reset Email" action (the closest thing to an admin-driven password reset
   this client-only app can do — see ADMIN_EMAIL's own comment). */
const USER_ADMIN_STATUS_LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };
function userAdminRowHtml(item, isPendingSection){
  const statusLabel = USER_ADMIN_STATUS_LABEL[item.status] || item.status;
  return `
    <div class="user-admin-row">
      <div class="user-admin-row-main">
        <div class="user-admin-row-email">${escapeHtml(item.email || '(no email)')}</div>
        <div class="user-admin-row-meta">
          ${isPendingSection
            ? `Requested ${escapeHtml(formatActivityDateTime(item.requestedAt) || '')}`
            : `<span class="user-admin-status user-admin-status-${escapeHtml(item.status || 'pending')}">${escapeHtml(statusLabel)}</span>${item.decidedBy ? ` &nbsp;·&nbsp; by ${escapeHtml(item.decidedBy)}` : ''}`}
        </div>
      </div>
      <div class="user-admin-row-actions">
        ${item.status !== 'approved' ? `<button class="btn btn-sm btn-primary" data-role="approve" data-uid="${escapeHtml(item.id)}">Approve</button>` : ''}
        ${item.status !== 'rejected' ? `<button class="btn btn-sm btn-danger" data-role="reject" data-uid="${escapeHtml(item.id)}">Reject</button>` : ''}
        <button class="btn btn-sm" data-role="reset-email" data-email="${escapeHtml(item.email || '')}">Send Reset Email</button>
      </div>
      ${!isPendingSection && item.email !== ADMIN_EMAIL ? `
      <div class="user-admin-permissions">
        ${MODULE_PERMISSIONS.map(m => `
          <label class="user-admin-permission-toggle">
            <input type="checkbox" data-role="toggle-permission" data-uid="${escapeHtml(item.id)}" data-module="${m.key}" ${userModulePermissions(item)[m.key] ? 'checked' : ''}>
            ${escapeHtml(m.label)}
          </label>
        `).join('')}
      </div>
      ` : ''}
    </div>
  `;
}
function renderUserAdminLists(){
  const pendingList = document.getElementById('userAdminPendingList');
  const allList = document.getElementById('userAdminAllList');
  if(!pendingList || !allList) return;
  const sorted = [...userApprovalsAdminList].sort((a, b) => (a.email || '').localeCompare(b.email || ''));
  const pending = sorted.filter(u => u.status === 'pending');
  pendingList.innerHTML = pending.length
    ? pending.map(u => userAdminRowHtml(u, true)).join('')
    : '<div class="overview-empty">Nothing pending</div>';
  allList.innerHTML = sorted.length
    ? sorted.map(u => userAdminRowHtml(u, false)).join('')
    : '<div class="overview-empty">No sign-ups yet</div>';
  document.querySelectorAll('#userAdminModalOverlay [data-role="approve"]').forEach(btn => {
    btn.addEventListener('click', () => decideUserApproval(btn.dataset.uid, 'approved'));
  });
  document.querySelectorAll('#userAdminModalOverlay [data-role="reject"]').forEach(btn => {
    btn.addEventListener('click', () => decideUserApproval(btn.dataset.uid, 'rejected'));
  });
  document.querySelectorAll('#userAdminModalOverlay [data-role="toggle-permission"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const checked = cb.checked;
      setDoc(doc(userApprovalsCol, cb.dataset.uid), { permissions: { [cb.dataset.module]: checked } }, { merge: true })
        .catch(err => { alert('Failed to update: ' + err.message); cb.checked = !checked; });
    });
  });
  document.querySelectorAll('#userAdminModalOverlay [data-role="reset-email"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const email = btn.dataset.email;
      if(!email) return;
      const originalLabel = btn.textContent;
      btn.disabled = true;
      sendPasswordResetEmail(auth, email)
        .then(() => { btn.textContent = 'Sent!'; setTimeout(() => { btn.textContent = originalLabel; btn.disabled = false; }, 2500); })
        .catch(err => { alert(authErrorMessage(err)); btn.textContent = originalLabel; btn.disabled = false; });
    });
  });
}
function decideUserApproval(uidToDecide, status){
  if(!uidToDecide) return;
  setDoc(doc(userApprovalsCol, uidToDecide), {
    status,
    decidedBy: currentUser?.email || '',
    decidedAt: Date.now()
  }, { merge: true }).catch(err => alert('Failed to update: ' + err.message));
}
function initUserAdminPanel(){
  document.getElementById('btnOpenUserAdmin').addEventListener('click', () => {
    document.getElementById('navbarAccount').classList.remove('open');
    document.getElementById('userAdminModalOverlay').classList.add('open');
    if(!unsubscribeUserApprovalsAdmin){
      unsubscribeUserApprovalsAdmin = onSnapshot(userApprovalsCol, snapshot => {
        userApprovalsAdminList = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        renderUserAdminLists();
      }, err => {
        console.error('Forge: user admin listener error', err);
        showCloudError('Failed to load user list: ' + err.message);
      });
    }
  });
  document.getElementById('btnCloseUserAdmin').addEventListener('click', () => {
    document.getElementById('userAdminModalOverlay').classList.remove('open');
  });
  document.getElementById('userAdminModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'userAdminModalOverlay') document.getElementById('userAdminModalOverlay').classList.remove('open');
  });
}

/* ---------- My Profile ---------- */
function initMyProfileModal(){
  const nameInput = document.getElementById('myProfileNameInput');
  const imageInput = document.getElementById('myProfileImageInput');
  const imagePreview = document.getElementById('myProfileImagePreview');
  const imageRemoveBtn = document.getElementById('myProfileImageRemove');
  const errEl = document.getElementById('myProfileError');
  const successEl = document.getElementById('myProfileSuccess');

  function openMyProfileModal(){
    document.getElementById('navbarAccount').classList.remove('open');
    nameInput.value = myProfile.displayName || '';
    editingProfileImage = myProfile.photoImage || '';
    if(editingProfileImage){
      imagePreview.src = editingProfileImage;
      imagePreview.style.display = '';
      imageRemoveBtn.style.display = '';
    }else{
      imagePreview.src = '';
      imagePreview.style.display = 'none';
      imageRemoveBtn.style.display = 'none';
    }
    imageInput.value = '';
    errEl.textContent = '';
    successEl.textContent = '';
    document.getElementById('myProfileModalOverlay').classList.add('open');
  }
  function closeMyProfileModal(){
    document.getElementById('myProfileModalOverlay').classList.remove('open');
  }

  document.getElementById('btnOpenMyProfile').addEventListener('click', openMyProfileModal);
  document.getElementById('btnCloseMyProfile').addEventListener('click', closeMyProfileModal);
  document.getElementById('btnCancelMyProfile').addEventListener('click', closeMyProfileModal);
  wireModalOverlayClose('myProfileModalOverlay', closeMyProfileModal);

  imageInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if(!file) return;
    try{
      editingProfileImage = await resizeImageFile(file, 300);
      imagePreview.src = editingProfileImage;
      imagePreview.style.display = '';
      imageRemoveBtn.style.display = '';
    }catch(err){
      errEl.textContent = err.message || 'Could not read that image file';
    }
  });
  imageRemoveBtn.addEventListener('click', () => {
    editingProfileImage = '';
    imageInput.value = '';
    imagePreview.src = '';
    imagePreview.style.display = 'none';
    imageRemoveBtn.style.display = 'none';
  });

  document.getElementById('btnSaveMyProfile').addEventListener('click', () => {
    errEl.textContent = '';
    setDoc(doc(userProfilesCol, currentUser.uid), {
      displayName: nameInput.value.trim(),
      photoImage: editingProfileImage,
      updatedAt: Date.now()
    }, { merge: true })
      .then(() => {
        successEl.textContent = 'Saved!';
        setTimeout(closeMyProfileModal, 800);
      })
      .catch(err => { errEl.textContent = 'Failed to save: ' + err.message; });
  });
}

/* ---------- Security (self-service Change Password) ---------- */
function initSecurityModal(){
  const form = document.getElementById('changePasswordForm');
  const errEl = document.getElementById('securityError');
  const successEl = document.getElementById('securitySuccess');

  function openSecurityModal(){
    document.getElementById('navbarAccount').classList.remove('open');
    form.reset();
    errEl.textContent = '';
    successEl.textContent = '';
    document.getElementById('securityModalOverlay').classList.add('open');
  }
  function closeSecurityModal(){
    document.getElementById('securityModalOverlay').classList.remove('open');
  }

  document.getElementById('btnOpenSecurity').addEventListener('click', openSecurityModal);
  document.getElementById('btnCloseSecurity').addEventListener('click', closeSecurityModal);
  wireModalOverlayClose('securityModalOverlay', closeSecurityModal);

  form.addEventListener('submit', e => {
    e.preventDefault();
    errEl.textContent = '';
    successEl.textContent = '';
    const currentPassword = document.getElementById('securityCurrentPassword').value;
    const newPassword = document.getElementById('securityNewPassword').value;
    const newPassword2 = document.getElementById('securityNewPassword2').value;
    if(newPassword.length < 6){
      errEl.textContent = 'New password must be at least 6 characters';
      return;
    }
    if(newPassword !== newPassword2){
      errEl.textContent = 'New passwords do not match';
      return;
    }
    reauthenticateWithCredential(currentUser, EmailAuthProvider.credential(currentUser.email, currentPassword))
      .then(() => updatePassword(currentUser, newPassword))
      .then(() => {
        successEl.textContent = 'Password changed!';
        form.reset();
      })
      .catch(err => { errEl.textContent = authErrorMessage(err); });
  });
}

/* ---------- Data Management (Export/Import, moved out of the account
   dropdown itself — see the request that split this out) ---------- */
function initDataManagementModal(){
  function openDataManagementModal(){
    document.getElementById('navbarAccount').classList.remove('open');
    document.getElementById('dataManagementModalOverlay').classList.add('open');
  }
  function closeDataManagementModal(){
    document.getElementById('dataManagementModalOverlay').classList.remove('open');
  }
  document.getElementById('btnOpenDataManagement').addEventListener('click', openDataManagementModal);
  document.getElementById('btnCloseDataManagement').addEventListener('click', closeDataManagementModal);
  wireModalOverlayClose('dataManagementModalOverlay', closeDataManagementModal);
}




function initCompareView(){
  document.getElementById('btnCompare').addEventListener('click', () => {
    setCompareSeriesPrefilter(null); // plain "Compare Recipes" entry — unfiltered, unlike "Compare Trials"
    mainFeatureView = 'compare';
    renderMain();
    renderSidebar();
  });
  // Admin-only, tucked in the account menu (same visibility gate as
  // "Manage Users" — see isAdminUser above) rather than the main navbar,
  // since this is a rare one-off tool, not a feature the whole team uses.
  document.getElementById('btnOpenSeriesMigration').addEventListener('click', () => {
    document.getElementById('navbarAccount').classList.remove('open');
    mainFeatureView = 'seriesMigration';
    renderMain();
    renderSidebar();
  });
}

// Which full-page feature (if any) currently owns #mainArea, overriding the
// normal home-dashboard/recipe-editor split. null = normal (home dashboard
// if currentId is also null, otherwise the recipe editor for currentId).
// Deliberately independent of currentId — entering a feature from inside a
// recipe (e.g. the Ingredient Library button) leaves currentId untouched,
// so closing the feature naturally resumes that recipe instead of bouncing
// to home.
export let mainFeatureView = null; // null | 'recipesList' | 'compare' | 'materials' | 'productList' | 'sampleSubmissions' | 'refLists' | 'projects' | 'trials'
// Lets a split module (e.g. projects.js's own nav-button wiring) change
// mainFeatureView from outside app.js — a plain `mainFeatureView = ...`
// assignment in an importing module isn't possible, since ES modules
// can't reassign a sibling module's imported `let` binding.
export function setMainFeatureView(v){ mainFeatureView = v; }

// Remembers which page (mainFeatureView) and, for the Recipes module, which
// recipe (currentId) was open, so a plain reload (F5, the tab waking back
// up, etc.) resumes there instead of always bouncing back to the Home
// dashboard -- only an action that actually clears site data (localStorage
// included) resets it, which is what "Hard Refresh" means for this app in
// practice, since a browser can't tell a website whether Ctrl+Shift+R was
// used instead of a plain reload. Written on every renderMain() call (the
// one place every navigation in this app already funnels through), so
// there's no need to instrument each individual "go to X" call site.
const LAST_VIEW_KEY = 'forge_lastView';
function persistLastView(){
  try {
    localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({ mainFeatureView, currentId: currentId || null }));
  } catch(e) { /* private browsing / storage disabled -- just skip persisting */ }
}
function loadLastView(){
  try {
    const raw = localStorage.getItem(LAST_VIEW_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}
// Restores the saved view on boot, but only into a module the signed-in
// account can still actually see -- permissions can change between visits,
// and a stale saved view pointing at a now-revoked module should fall back
// to Home rather than render a page this account no longer has. Same
// "recipes spans three mainFeatureView values" reasoning as the live
// permission-revoked check in onAuthStateChanged below.
function restoreLastView(){
  const last = loadLastView();
  if(!last) return;
  const view = last.mainFeatureView || null;
  const isRecipesView = view === 'recipesList' || view === 'compare' || (view === null && !!last.currentId);
  if(isRecipesView && !hasModuleAccess('recipes')) return;
  if(view && MODULE_PERMISSIONS.some(m => m.key === view) && !hasModuleAccess(view)) return;
  mainFeatureView = view;
  if(last.currentId) openRecipe(last.currentId);
}
let saveTimer = null;
// One entry per recipe with a pending "haven't clicked Save in a while"
// checkpoint — keyed by id (not a single global timer) so editing recipe A
// then switching to recipe B within the window still checkpoints each one
// independently instead of the second edit silently getting dropped. See
// scheduleVersionCheckpoint/cancelVersionCheckpoint/autoCheckpointVersion.
const versionCheckpointTimers = new Map();
let unsubscribeLoginEvents = null;
let unsubscribeActivityEvents = null;
let loginEvents = [];
let activityEvents = [];

export function uid(){ return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }


// Most-recent-50 sign-ins, newest first — bounded by the query itself
// (rather than fetching the whole ever-growing collection client-side like
// the other collections do) since this log only ever grows and never gets
// cleaned up.
function attachLoginEventsListener(){
  const q = query(loginEventsCol, orderBy('timestamp', 'desc'), limit(50));
  unsubscribeLoginEvents = onSnapshot(q, snapshot => {
    loginEvents = snapshot.docs.map(d => d.data());
    renderNotificationsBell();
  }, err => {
    console.error('Forge: login events listener error', err);
  });
}

// Most-recent-50 add/edit/delete events, newest first — same bounded-query
// shape as attachLoginEventsListener, merged with it in the notification
// bell. Fire-and-forget: a failed write here should never block the actual
// save/delete it's describing, so callers don't await this. `changes` is
// only ever populated for 'updated' events (see diffMainFields) — created/
// deleted events just pass an empty array, since "before" doesn't exist for
// a create and "after" doesn't exist for a delete.
export function logActivityEvent(type, entityType, entityName, changes){
  return setDoc(doc(activityEventsCol, uid()), {
    type, entityType,
    entityName: entityName || 'Untitled',
    by: currentUser?.email || '',
    at: Date.now(),
    changes: changes || []
  }).catch(err => console.error('Forge: failed to log activity event', err));
}
function attachActivityEventsListener(){
  const q = query(activityEventsCol, orderBy('at', 'desc'), limit(50));
  unsubscribeActivityEvents = onSnapshot(q, snapshot => {
    activityEvents = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderNotificationsBell();
  }, err => {
    console.error('Forge: activity events listener error', err);
  });
}

// ---------- Before/after field diffs (see the click handler on each
// notification item in renderNotificationsBell) ----------
// Only "main" scalar fields are tracked, not nested lists (a recipe's
// ingredients/parts/processes, a project's flavors/products/monthly
// updates, etc.) — those are complex enough that a flat field-diff would
// either be unreadable or require a much bigger structural diff engine;
// recipes already have full Version History for that level of detail.

export function snapshotMainFields(obj, fieldMap){
  const snap = {};
  Object.keys(fieldMap).forEach(key => { snap[key] = obj[key] ?? ''; });
  return snap;
}
// Compares two same-shaped snapshots (see snapshotMainFields) and returns
// only the fields that actually differ, as { field, before, after } for the
// notification's "what changed" view. `before` being null/undefined (the
// "started editing" snapshot was never captured, e.g. an old browser tab
// still open from before this feature shipped) just yields no diff rather
// than a false "everything changed."
export function diffMainFields(before, after, fieldMap){
  if(!before) return [];
  return Object.keys(fieldMap)
    .filter(key => String(before[key] ?? '') !== String((after[key]) ?? ''))
    .map(key => ({
      field: fieldMap[key],
      before: String(before[key] ?? '').trim() || '(blank)',
      after: String(after[key] ?? '').trim() || '(blank)'
    }));
}


/* Includes the vendor code so materials that share the same name (different
   vendors/codes) are distinguishable in the picker and unambiguous to match
   against — without the code, selecting between two "Modified Starch" entries
   from different vendors would always resolve to whichever one comes first. */
export function materialLabel(m){
  const base = `${m.nameEn} / ${m.nameTh}`;
  return m.vendorCode ? `${base} (${m.vendorCode})` : base;
}

function oldMaterialLabel(m){
  return `${m.nameEn} / ${m.nameTh}`;
}

/* MOQ is stored as a plain number now, but entries saved before this field
   had a fixed "kg" unit may still hold free text like "25 kg" — avoid
   double-appending the unit in that case. */
export function formatMoq(v){
  if(v === '' || v == null) return null;
  const s = String(v).trim();
  if(!s) return null;
  return /kg\s*$/i.test(s) ? s : `${s} kg`;
}

export function extractMoqNumber(v){
  if(v === '' || v == null) return '';
  const match = String(v).match(/[\d.]+/);
  return match ? match[0] : '';
}


export function findMaterialByLabel(text){
  const t = (text || '').trim();
  if(!t) return null;
  const exact = ingredientMaster.find(m => materialLabel(m) === t);
  if(exact) return exact;
  // Backward compat: ingredients linked before vendor codes were added to the
  // label were matched on "EN / TH" alone. Keep resolving those the same way
  // (still ambiguous if duplicated) until the row is re-selected from the
  // library, at which point it picks up the new, unambiguous label.
  return ingredientMaster.find(m => oldMaterialLabel(m) === t) || null;
}




/* Shrinks a photo to a small thumbnail before storing it directly in the
   Firestore document (no separate Firebase Storage setup needed) — a JPEG
   capped at 200px comfortably stays well under Firestore's 1MB doc limit. */
export function resizeImageFile(file, maxDim){
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
        // JPEG has no alpha channel — without this, a transparent PNG's
        // see-through areas default to black once flattened, instead of
        // just disappearing like they do everywhere else the PNG is used.
        // White reads as "no background" for the vast majority of logos/
        // photos this app resizes (product shots, company logos), so it's
        // a safer default than leaving the canvas's own transparent-black.
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



// One-time wiring for the persistent nested "ingredient detail" popup
// (stays a real modal, per the decision to keep small utility dialogs as
// popups) plus the two entry points into the full-page library view — the
// sidebar button, and the "Ingredient Library" button inside the recipe
// editor's ingredients card (wired here since it's part of the always-
// present sidebar/shell, not recreated per-recipe like the recipe editor's
// own controls).
function initMaterialLibrary(){
  const openMaterialsView = () => {
    mainFeatureView = 'materials';
    renderMain();
    renderSidebar();
  };
  document.getElementById('btnOpenMaterialLibSidebar').addEventListener('click', () => guardNavigation(openMaterialsView));
  document.getElementById('btnCloseMaterialDetail').addEventListener('click', closeMaterialDetail);
  wireModalOverlayClose('materialDetailModalOverlay', closeMaterialDetail);
  document.getElementById('btnEditMaterialDetail').addEventListener('click', () => guardNavigation(() => {
    closeMaterialDetail();
    openMaterialsView();
    editMaterialFromDetail();
  }));
}

function initProductsView(){
  const openProductsView = () => {
    mainFeatureView = 'productList';
    renderMain();
    renderSidebar();
  };
  document.getElementById('btnOpenProductsTab').addEventListener('click', () => guardNavigation(openProductsView));
  document.getElementById('btnCloseProductDetail').addEventListener('click', closeProductDetail);
  wireModalOverlayClose('productDetailModalOverlay', closeProductDetail);
}

function initSampleSubmissionsView(){
  const openSampleSubmissionsView = () => {
    mainFeatureView = 'sampleSubmissions';
    renderMain();
    renderSidebar();
  };
  document.getElementById('btnOpenSampleSubmissionsTab').addEventListener('click', () => guardNavigation(openSampleSubmissionsView));
}


/* ---------- Sidebar ---------- */
const FEATURE_VIEW_BUTTON_IDS = {
  compare: 'btnCompare', materials: 'btnOpenMaterialLibSidebar', productList: 'btnOpenProductsTab',
  sampleSubmissions: 'btnOpenSampleSubmissionsTab',
  refLists: 'btnOpenRefLists', projects: 'btnOpenProjects', trials: 'btnOpenTrials'
};


export function renderSidebar(){
  Object.entries(FEATURE_VIEW_BUTTON_IDS).forEach(([view, id]) => {
    document.getElementById(id)?.classList.toggle('active', mainFeatureView === view);
  });
  // The Recipes tab covers browsing (mainFeatureView === 'recipesList'),
  // Compare (nested under Recipes rather than its own destination), and
  // actively editing a specific recipe — but NOT the Home dashboard, which
  // is now its own separate destination reached via the Forge logo.
  document.getElementById('btnRecipesTab')?.classList.toggle('active',
    mainFeatureView === 'recipesList' || mainFeatureView === 'compare' || (mainFeatureView === null && !!currentId));
  renderSidebarRecipeCards(document.getElementById('recipeList'), document.getElementById('searchInput').value);
}


// ISO 3166-1 alpha-2 codes, keyed by lowercased common/short country name.
// "eu" is included because ISO 3166-1 exceptionally reserves "EU" for the
// European Union, and that's already one of this app's Destination Country
// entries even though the EU isn't itself a country.
const COUNTRY_ISO2 = {
  "abyssinia":"ET","afghanistan":"AF","aland":"AX","albania":"AL","algeria":"DZ","america":"US",
  "american samoa":"AS","andorra":"AD","angola":"AO","anguilla":"AI","antarctica":"AQ",
  "antigua and barbuda":"AG","argentina":"AR","armenia":"AM","aruba":"AW","ascension island":"AC",
  "australia":"AU","austria":"AT","azerbaijan":"AZ","bahamas":"BS","bahrain":"BH","bahrein":"BH",
  "bangladesh":"BD","barbados":"BB","basutoland":"LS","bechuanaland":"BW","belarus":"BY",
  "belgium":"BE","belize":"BZ","belorussia":"BY","benin":"BJ","bermuda":"BM","bhutan":"BT",
  "bolivia":"BO","bonaire":"BQ","bosnia and herzegovina":"BA","botswana":"BW","bouvet island":"BV",
  "brazil":"BR","britain":"GB","british honduras":"BZ","british indian ocean territory":"IO",
  "british virgin islands":"VG","brunei":"BN","bulgaria":"BG","burkina faso":"BF","burma":"MM",
  "burundi":"BI","byelorussia":"BY","cabo verde":"CV","cambodia":"KH","cameroon":"CM","canada":"CA",
  "cape verde":"CV","cayman islands":"KY","central african republic":"CF","ceylon":"LK","chad":"TD",
  "chile":"CL","china":"CN","christmas island":"CX","cocos (keeling) islands":"CC","colombia":"CO",
  "comoros":"KM","congo-brazzaville":"CG","congo-kinshasa":"CD","cook islands":"CK",
  "costa rica":"CR","cote d'ivoire":"CI","croatia":"HR","cuba":"CU","curacao":"CW","cyprus":"CY",
  "czech republic":"CZ","czechia":"CZ","dahomey":"BJ","democratic republic of the congo":"CD",
  "denmark":"DK","djibouti":"DJ","dominica":"DM","dominican republic":"DO","dprk":"KP",
  "dr congo":"CD","drc":"CD","dutch east indies":"ID","east pakistan":"BD","east timor":"TL",
  "ecuador":"EC","egypt":"EG","el salvador":"SV","ellice islands":"TV","emirates":"AE",
  "equatorial guinea":"GQ","eritrea":"ER","estonia":"EE","eswatini":"SZ","ethiopia":"ET","eu":"EU",
  "european union":"EU","falkland islands":"FK","faroe islands":"FO","fiji":"FJ","finland":"FI",
  "formosa":"TW","france":"FR","french guiana":"GF","french polynesia":"PF",
  "french southern territories":"TF","french sudan":"ML","fyrom":"MK","gabon":"GA","gambia":"GM",
  "georgia":"GE","germany":"DE","ghana":"GH","gibraltar":"GI","gilbert islands":"KI",
  "gold coast":"GH","great britain":"GB","greece":"GR","greenland":"GL","grenada":"GD",
  "guadeloupe":"GP","guam":"GU","guatemala":"GT","guernsey":"GG","guinea":"GN","guinea-bissau":"GW",
  "guyana":"GY","haiti":"HT","heard island and mcdonald islands":"HM","holland":"NL",
  "holy see":"VA","honduras":"HN","hong kong":"HK","hungary":"HU","iceland":"IS","india":"IN",
  "indonesia":"ID","iran":"IR","iraq":"IQ","ireland":"IE","isle of man":"IM","israel":"IL",
  "italy":"IT","ivory coast":"CI","jamaica":"JM","japan":"JP","jersey":"JE","jordan":"JO",
  "kampuchea":"KH","kazakhstan":"KZ","kenya":"KE","kirghizia":"KG","kiribati":"KI","kosovo":"XK",
  "kuwait":"KW","kyrgyz republic":"KG","kyrgyzstan":"KG","lao pdr":"LA","laos":"LA","latvia":"LV",
  "lebanon":"LB","lesotho":"LS","liberia":"LR","libya":"LY","liechtenstein":"LI","lithuania":"LT",
  "luxembourg":"LU","macao":"MO","macau":"MO","macedonia":"MK","madagascar":"MG","malawi":"MW",
  "malaysia":"MY","maldives":"MV","mali":"ML","malta":"MT","marshall islands":"MH",
  "martinique":"MQ","mauritania":"MR","mauritius":"MU","mayotte":"YT","mexico":"MX",
  "micronesia":"FM","moldavia":"MD","moldova":"MD","monaco":"MC","mongolia":"MN","montenegro":"ME",
  "montserrat":"MS","morocco":"MA","mozambique":"MZ","myanmar":"MM","myanmar (burma)":"MM",
  "namibia":"NA","nauru":"NR","nepal":"NP","netherlands":"NL","new caledonia":"NC",
  "new hebrides":"VU","new zealand":"NZ","nicaragua":"NI","niger":"NE","nigeria":"NG","niue":"NU",
  "norfolk island":"NF","north korea":"KP","north macedonia":"MK","northern mariana islands":"MP",
  "northern rhodesia":"ZM","norway":"NO","nyasaland":"MW","oman":"OM","pakistan":"PK","palau":"PW",
  "palestine":"PS","panama":"PA","papua new guinea":"PG","paraguay":"PY","persia":"IR","peru":"PE",
  "philippines":"PH","pitcairn islands":"PN","poland":"PL","portugal":"PT","portuguese guinea":"GW",
  "puerto rico":"PR","qatar":"QA","republic of korea":"KR","republic of the congo":"CG",
  "reunion":"RE","rhodesia":"ZW","romania":"RO","roumania":"RO","rumania":"RO","russia":"RU",
  "russian federation":"RU","rwanda":"RW","saint barthelemy":"BL","saint helena":"SH",
  "saint kitts and nevis":"KN","saint lucia":"LC","saint martin":"MF",
  "saint pierre and miquelon":"PM","saint vincent and the grenadines":"VC","samoa":"WS",
  "san marino":"SM","sao tome and principe":"ST","saudi arabia":"SA","senegal":"SN","serbia":"RS",
  "seychelles":"SC","siam":"TH","sierra leone":"SL","singapore":"SG","sint maarten":"SX",
  "slovakia":"SK","slovenia":"SI","solomon islands":"SB","somalia":"SO","south africa":"ZA",
  "south georgia and the south sandwich islands":"GS","south korea":"KR","south sudan":"SS",
  "south west africa":"NA","southern rhodesia":"ZW","spain":"ES","spanish sahara":"EH",
  "sri lanka":"LK","sudan":"SD","suriname":"SR","svalbard and jan mayen":"SJ","swaziland":"SZ",
  "sweden":"SE","switzerland":"CH","syria":"SY","syrian arab republic":"SY","taiwan":"TW",
  "tajikistan":"TJ","tanganyika":"TZ","tanzania":"TZ","thailand":"TH","togo":"TG","tokelau":"TK",
  "tonga":"TO","trinidad and tobago":"TT","tristan da cunha":"TA","tunisia":"TN","turkey":"TR",
  "turkiye":"TR","turkmenia":"TM","turkmenistan":"TM","turks and caicos islands":"TC","tuvalu":"TV",
  "türkiye":"TR","u.s. minor outlying islands":"UM","u.s. virgin islands":"VI","uae":"AE",
  "ubangi-shari":"CF","uganda":"UG","uk":"GB","ukraine":"UA","united arab emirates":"AE",
  "united kingdom":"GB","united states":"US","united states of america":"US","upper volta":"BF",
  "uruguay":"UY","us":"US","usa":"US","uzbekistan":"UZ","vanuatu":"VU","vatican":"VA",
  "vatican city":"VA","venezuela":"VE","viet nam":"VN","vietnam":"VN","wallis and futuna":"WF",
  "western sahara":"EH","yemen":"YE","zaire":"CD","zambia":"ZM","zimbabwe":"ZW",
  "česká republika":"CZ"
};

// Canonical world country/territory names (from the ISO 3166-1 list), used to
// populate #worldCountriesDatalist so Reference Lists' Destination Countries
// tab can be searched/picked rather than typed from memory.
const WORLD_COUNTRIES = [
  "Afghanistan","Aland","Albania","Algeria","American Samoa","Andorra","Angola","Anguilla",
  "Antarctica","Antigua and Barbuda","Argentina","Armenia","Aruba","Ascension Island","Australia",
  "Austria","Azerbaijan","Bahamas","Bahrain","Bangladesh","Barbados","Belarus","Belgium","Belize",
  "Benin","Bermuda","Bhutan","Bolivia","Bonaire","Bosnia and Herzegovina","Botswana",
  "Bouvet Island","Brazil","British Indian Ocean Territory","British Virgin Islands","Brunei",
  "Bulgaria","Burkina Faso","Burundi","Cabo Verde","Cambodia","Cameroon","Canada","Cayman Islands",
  "Central African Republic","Chad","Chile","China","Christmas Island","Cocos (Keeling) Islands",
  "Colombia","Comoros","Cook Islands","Costa Rica","Croatia","Cuba","Curacao","Cyprus","Czechia",
  "Democratic Republic of the Congo","Denmark","Djibouti","Dominica","Dominican Republic",
  "East Timor","Ecuador","Egypt","El Salvador","Equatorial Guinea","Eritrea","Estonia","Eswatini",
  "Ethiopia","Falkland Islands","Faroe Islands","Fiji","Finland","France","French Guiana",
  "French Polynesia","French Southern Territories","Gabon","Gambia","Georgia","Germany","Ghana",
  "Gibraltar","Greece","Greenland","Grenada","Guadeloupe","Guam","Guatemala","Guernsey","Guinea",
  "Guinea-Bissau","Guyana","Haiti","Heard Island and McDonald Islands","Honduras","Hong Kong",
  "Hungary","Iceland","India","Indonesia","Iran","Iraq","Ireland","Isle of Man","Israel","Italy",
  "Ivory Coast","Jamaica","Japan","Jersey","Jordan","Kazakhstan","Kenya","Kiribati","Kosovo",
  "Kuwait","Kyrgyzstan","Laos","Latvia","Lebanon","Lesotho","Liberia","Libya","Liechtenstein",
  "Lithuania","Luxembourg","Macao","Madagascar","Malawi","Malaysia","Maldives","Mali","Malta",
  "Marshall Islands","Martinique","Mauritania","Mauritius","Mayotte","Mexico","Micronesia",
  "Moldova","Monaco","Mongolia","Montenegro","Montserrat","Morocco","Mozambique","Myanmar",
  "Namibia","Nauru","Nepal","Netherlands","New Caledonia","New Zealand","Nicaragua","Niger",
  "Nigeria","Niue","Norfolk Island","North Korea","North Macedonia","Northern Mariana Islands",
  "Norway","Oman","Pakistan","Palau","Palestine","Panama","Papua New Guinea","Paraguay","Peru",
  "Philippines","Pitcairn Islands","Poland","Portugal","Puerto Rico","Qatar",
  "Republic of the Congo","Reunion","Romania","Russia","Rwanda","Saint Barthelemy","Saint Helena",
  "Saint Kitts and Nevis","Saint Lucia","Saint Martin","Saint Pierre and Miquelon",
  "Saint Vincent and the Grenadines","Samoa","San Marino","Sao Tome and Principe","Saudi Arabia",
  "Senegal","Serbia","Seychelles","Sierra Leone","Singapore","Sint Maarten","Slovakia","Slovenia",
  "Solomon Islands","Somalia","South Africa","South Georgia and the South Sandwich Islands",
  "South Korea","South Sudan","Spain","Sri Lanka","Sudan","Suriname","Svalbard and Jan Mayen",
  "Sweden","Switzerland","Syria","Taiwan","Tajikistan","Tanzania","Thailand","Togo","Tokelau",
  "Tonga","Trinidad and Tobago","Tristan da Cunha","Tunisia","Türkiye","Turkmenistan",
  "Turks and Caicos Islands","Tuvalu","U.S. Minor Outlying Islands","U.S. Virgin Islands","Uganda",
  "Ukraine","United Arab Emirates","United Kingdom","United States","Uruguay","Uzbekistan",
  "Vanuatu","Vatican City","Venezuela","Vietnam","Wallis and Futuna","Western Sahara","Yemen",
  "Zambia","Zimbabwe"
];
document.getElementById('worldCountriesDatalist').innerHTML =
  WORLD_COUNTRIES.map(name => `<option value="${escapeHtml(name)}"></option>`).join('');

// Destination Country is a free-text field (via Reference Lists), so entries
// often carry a parenthetical explainer, e.g. "USA (United States of
// America)" or "UK (United Kingdom of Great Britain and Northern Ireland)" —
// stripping that before lookup lets the short label alone resolve correctly.
export function countryToIso2(name){
  if(!name) return '';
  const stripped = name.replace(/\([^)]*\)/g, '').trim().toLowerCase();
  if(COUNTRY_ISO2[stripped]) return COUNTRY_ISO2[stripped];
  const full = name.trim().toLowerCase();
  return COUNTRY_ISO2[full] || '';
}

// Small circular flag badge shown before a Destination Countries entry.
// Uses actual flag images (a CDN-hosted circular-flag icon set) rather than
// Unicode flag emoji, because flag emoji rendering is unreliable across
// OS/browser combinations — many fall back to showing the bare two-letter
// code as plain text instead of a real flag glyph. An <img> with an error
// handler (wired in renderRefListItems) falls back to that same letter-code
// text if the image itself ever fails to load (e.g. "EU", which has no
// flag in this icon set since it isn't an ISO 3166-1 country).
// The EU isn't a country, so the circle-flags icon set (used for every real
// ISO country below) has no "eu" entry — drawn here by hand instead: the
// official 12 gold-star ring on blue, geometrically accurate (stars evenly
// spaced 30° apart, all upright) rather than pulled from an external image.
const EU_FLAG_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="EU flag"><circle cx="50" cy="50" r="50" fill="#039"/><defs><polygon id="eu-star" points="0,-4 0.911,-1.254 3.804,-1.236 1.474,0.479 2.351,3.236 0,1.55 -2.351,3.236 -1.474,0.479 -3.804,-1.236 -0.911,-1.254" fill="#fc0"/></defs><use href="#eu-star" x="50" y="18"/><use href="#eu-star" x="66" y="22.29"/><use href="#eu-star" x="77.71" y="34"/><use href="#eu-star" x="82" y="50"/><use href="#eu-star" x="77.71" y="66"/><use href="#eu-star" x="66" y="77.71"/><use href="#eu-star" x="50" y="82"/><use href="#eu-star" x="34" y="77.71"/><use href="#eu-star" x="22.29" y="66"/><use href="#eu-star" x="18" y="50"/><use href="#eu-star" x="22.29" y="34"/><use href="#eu-star" x="34" y="22.29"/></svg>`;

export function countryFlagBadgeHtml(name){
  const iso = countryToIso2(name);
  if(!iso) return `<span class="reflist-flag-badge" title="Unrecognized country">${icon('globe', 14)}</span>`;
  if(iso === 'EU') return `<span class="reflist-flag-badge" title="EU">${EU_FLAG_SVG}</span>`;
  return `<span class="reflist-flag-badge" title="${escapeHtml(iso)}"><img class="reflist-flag-img" data-fallback="${escapeHtml(iso)}" alt="${escapeHtml(iso)}" src="https://cdn.jsdelivr.net/gh/HatScripts/circle-flags/flags/${iso.toLowerCase()}.svg"></span>`;
}


export function formatActivityDateTime(ts){
  if(!ts) return null;
  return new Date(ts).toLocaleString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

// "10 Aug 2026" style date, for the Activities Updates timeline headers —
// distinct from formatActivityDateTime's "10/08/2026, 16:24" (used for the
// created/edited-by lines) since the timeline wants just the day, no time.
export function formatDateLong(dateStr){
  if(!dateStr) return '-';
  const d = new Date(dateStr + 'T00:00:00');
  if(isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}
export function formatTimeOnly(ts){
  if(!ts) return '';
  return new Date(ts).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
}

// "Unread" is tracked client-side only (localStorage, per browser) against
// the newest sign-in the user has actually opened this panel to see —
// there's no per-user read-state stored in Firestore for this, since it's
// just a lightweight badge count, not something that needs to sync across
// devices.
const LOGIN_EVENTS_LAST_SEEN_KEY = 'forgeLastSeenLoginEventAt';
const ACTIVITY_ENTITY_LABELS = { recipe: 'Recipe', project: 'Project', trial: 'Test', material: 'Ingredient', submission: 'Submission' };
const ACTIVITY_VERB_LABELS = { created: 'added', updated: 'edited', deleted: 'deleted', imported: 'imported', rejected: 'rejected' };
// Merges the sign-in log with the add/edit/delete activity log into one
// feed, newest first — this is the only place the two collections meet;
// everywhere else (attachLoginEventsListener/attachActivityEventsListener)
// they're loaded and stored completely separately.
function renderNotificationsBell(){
  const list = document.getElementById('navbarNotifList');
  const badge = document.getElementById('navbarNotifBadge');
  if(!list || !badge) return;
  const merged = [
    ...loginEvents.map(ev => ({ at: ev.timestamp, title: `${ev.email || 'Unknown'} signed in`, by: '', id: null, changes: [] })),
    ...activityEvents.map(ev => ({
      at: ev.at,
      title: `${ACTIVITY_ENTITY_LABELS[ev.entityType] || ev.entityType} "${ev.entityName || 'Untitled'}" ${ACTIVITY_VERB_LABELS[ev.type] || ev.type}`,
      by: `by ${ev.by || 'Unknown'}`,
      id: ev.id,
      changes: ev.changes || []
    }))
  ].sort((a, b) => b.at - a.at).slice(0, 50);
  list.innerHTML = merged.length
    ? merged.map(item => `
        <div class="navbar-notif-item${item.changes.length ? ' navbar-notif-item-clickable' : ''}" ${item.changes.length ? `data-activity-id="${escapeHtml(item.id)}"` : ''}>
          <div class="ni-email">${escapeHtml(item.title)}</div>
          ${item.by ? `<div class="ni-by">${escapeHtml(item.by)}</div>` : ''}
          <div class="ni-time">${escapeHtml(formatActivityDateTime(item.at) || '')}</div>
          ${item.changes.length ? `<div class="ni-changes-hint">${item.changes.length} field${item.changes.length === 1 ? '' : 's'} changed — click to view</div>` : ''}
        </div>
      `).join('')
    : '<div class="navbar-notif-empty">No activity recorded yet</div>';
  list.querySelectorAll('[data-activity-id]').forEach(el => {
    el.addEventListener('click', () => {
      const ev = activityEvents.find(e => e.id === el.dataset.activityId);
      if(ev) openActivityChangesModal(ev);
    });
  });
  const lastSeen = Number(localStorage.getItem(LOGIN_EVENTS_LAST_SEEN_KEY) || 0);
  const unreadCount = merged.filter(item => item.at > lastSeen).length;
  badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
  badge.style.display = unreadCount > 0 ? 'flex' : 'none';
}

// Opens the "what changed" modal for one activity event — see the
// [data-activity-id] click wiring right above, in renderNotificationsBell.
function openActivityChangesModal(ev){
  const entityLabel = ACTIVITY_ENTITY_LABELS[ev.entityType] || ev.entityType;
  document.getElementById('activityChangesTitle').textContent = `${entityLabel} "${ev.entityName || 'Untitled'}"`;
  const list = document.getElementById('activityChangesList');
  const changes = ev.changes || [];
  list.innerHTML = `
    <p style="font-size:12px;color:var(--text-dim);margin-top:0;">Edited by ${escapeHtml(ev.by || 'Unknown')} · ${escapeHtml(formatActivityDateTime(ev.at) || '')}</p>
    ${changes.length ? changes.map(c => `
      <div class="activity-change-row">
        <div class="activity-change-field">${escapeHtml(c.field)}</div>
        <div class="activity-change-values">
          <span class="activity-change-before">${escapeHtml(c.before)}</span>
          <span class="activity-change-arrow">→</span>
          <span class="activity-change-after">${escapeHtml(c.after)}</span>
        </div>
      </div>
    `).join('') : '<div class="overview-empty">No field changes recorded for this edit</div>'}
  `;
  document.getElementById('activityChangesModalOverlay').classList.add('open');
}
function initActivityChangesModal(){
  document.getElementById('btnCloseActivityChanges').addEventListener('click', () => {
    document.getElementById('activityChangesModalOverlay').classList.remove('open');
  });
  document.getElementById('activityChangesModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'activityChangesModalOverlay') document.getElementById('activityChangesModalOverlay').classList.remove('open');
  });
}


export function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Every modal closes on a click that lands on its own backdrop overlay --
// used to be wired as a plain `overlay.addEventListener('click', e => {
// if(e.target.id === overlayId) close(); })` at each of the app's ~10
// modals. That's one native `click` check, and a browser fires `click`
// based on where the mouseup lands, regardless of where the mousedown
// started -- so selecting/dragging text inside a field (e.g. a long
// Activities Update note) that overshoots past the modal's edge ends
// the drag on the backdrop, fires a `click` there, and silently closes
// the modal -- discarding whatever was being typed, with the drag never
// having been an attempt to close anything. Requiring the mousedown to
// *also* have started on the backdrop (not just the eventual mouseup/
// click) is the standard fix -- a real "click the backdrop to close"
// still starts and ends there, a drag that merely ends there doesn't.
export function wireModalOverlayClose(overlayId, closeFn){
  const overlay = document.getElementById(overlayId);
  let mousedownOnOverlay = false;
  overlay.addEventListener('mousedown', e => { mousedownOnOverlay = e.target.id === overlayId; });
  overlay.addEventListener('click', e => {
    if(mousedownOnOverlay && e.target.id === overlayId) closeFn();
    mousedownOnOverlay = false;
  });
}

// Inline Lucide icons (https://lucide.dev, ISC license) — embedded as raw
// path/shape data rather than loaded from a CDN, so the app still works
// offline and isn't a broken pile of missing icons if that CDN ever goes
// down. stroke="currentColor" means every icon just inherits whatever CSS
// color already applies to its container — no separate color wiring needed.


// Each entry mounts one of the top-navbar features into #mainArea. Checked
// first in renderMain(), ahead of the Home dashboard/recipe-editor split.
// Replays the .forge-content-transition CSS animation on an element —
// removing the class and forcing a reflow (reading offsetWidth) before
// re-adding it, since just re-adding an already-present class doesn't
// restart a CSS animation on its own. Called once per page switch (see
// renderMain/each mount*View) and per Home dashboard data refresh (see
// refreshDashboardHome), not on every fine-grained re-render.
export function playContentTransition(el){
  if(!el) return;
  el.classList.remove('forge-content-transition');
  void el.offsetWidth;
  el.classList.add('forge-content-transition');
}

const FEATURE_VIEW_MOUNTERS = {
  recipesList: mountRecipesListView,
  compare: mountCompareView,
  materials: mountMaterialsView,
  productList: mountProductsView,
  sampleSubmissions: mountSampleSubmissionsView,
  refLists: mountRefListsView,
  projects: mountProjectsView,
  trials: mountTrialsView,
  seriesMigration: mountSeriesMigrationView
};

export function renderMain(){
  persistLastView();
  const main = document.getElementById('mainArea');
  // The recipe-navigator sidebar (New Recipe / Compare / search / list) only
  // makes sense while actively viewing/editing one specific recipe — Home,
  // the full-page Recipes list, and every other feature view all get the
  // full screen width instead, with no left-hand navigator at all.
  document.body.classList.toggle('hide-recipes-nav', !(mainFeatureView === null && !!currentId));
  if(mainFeatureView && FEATURE_VIEW_MOUNTERS[mainFeatureView]){
    FEATURE_VIEW_MOUNTERS[mainFeatureView]();
    return;
  }
  const r = getCurrent();
  main.classList.remove('main-wide');
  if(!r){
    main.innerHTML = renderDashboardHome();
    wireDashboardHome();
    playContentTransition(main);
    return;
  }

  renderRecipeEditor(r);
}








/* ---------- Init ---------- */
document.getElementById('btnNew').addEventListener('click', () => guardNavigation(createNewRecipe));
document.getElementById('searchInput').addEventListener('input', renderSidebar);
document.getElementById('btnExportAll').addEventListener('click', exportAll);
document.getElementById('btnImport').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', e => {
  if(e.target.files[0]) importFromFile(e.target.files[0]);
  e.target.value = '';
});
document.getElementById('btnLogoutFromApp').addEventListener('click', goToAuth);
document.getElementById('navbarBrand').addEventListener('click', () => guardNavigation(goHome));
document.getElementById('btnRecipesTab').addEventListener('click', () => guardNavigation(() => {
  mainFeatureView = 'recipesList';
  renderMain();
  renderSidebar();
}));

document.getElementById('navbarAccount').addEventListener('click', e => {
  e.stopPropagation();
  document.getElementById('navbarAccount').classList.toggle('open');
});
// Moved out of its own navbar-right icon button (see navbarOnlineUsers,
// which took that spot) and into the account menu -- never had any real
// destination of its own (a bare "?" tooltip), so this just closes the
// menu like every other item here does, rather than adding a Help modal
// that wasn't asked for.
document.getElementById('btnNavbarHelp').addEventListener('click', () => {
  document.getElementById('navbarAccount').classList.remove('open');
});
document.getElementById('navbarNotifications').addEventListener('click', e => {
  e.stopPropagation();
  const wrap = document.getElementById('navbarNotifications');
  const opening = !wrap.classList.contains('open');
  wrap.classList.toggle('open');
  if(opening){
    localStorage.setItem(LOGIN_EVENTS_LAST_SEEN_KEY, String(Date.now()));
    renderNotificationsBell();
  }
});
document.addEventListener('click', () => {
  document.getElementById('navbarAccount').classList.remove('open');
  document.getElementById('navbarNotifications').classList.remove('open');
  document.getElementById('hdCreateMenu')?.classList.remove('open');
  document.getElementById('recipeMoreMenu')?.classList.remove('open');
  document.getElementById('projectColumnsMenu')?.classList.remove('open');
  if(openProjectFilterMenuKey){
    closeProjectFilterMenu();
    document.querySelectorAll('[data-filter-menu].open').forEach(m => m.classList.remove('open'));
  }
  closeDashboardWhoMenus();
  if(projectWhoMenuOpen) closeProjectWhoMenu();
});

window.addEventListener('resize', () => { activeProjScrollbarProxySync?.(); });

// Every textarea in the app grows to fit its content instead of scrolling
// (see the resize:none/overflow:hidden pair in style.css) -- two hooks
// cover the two ways a textarea ends up with text in it: typing (the
// delegated 'input' listener) and a re-render dropping one in already
// filled with a saved value (the MutationObserver below).
function autoGrowTextarea(el){
  el.style.height = 'auto';
  el.style.height = (el.scrollHeight + 2) + 'px';
}
document.addEventListener('input', e => {
  if(e.target.tagName === 'TEXTAREA') autoGrowTextarea(e.target);
});
new MutationObserver(mutations => {
  for(const m of mutations){
    for(const node of m.addedNodes){
      if(node.nodeType !== 1) continue;
      if(node.tagName === 'TEXTAREA') autoGrowTextarea(node);
      else node.querySelectorAll?.('textarea').forEach(autoGrowTextarea);
    }
  }
}).observe(document.body, { childList: true, subtree: true });

// Every "dropdown" in this app (Customer, Destination, Sales Rep, Cooking
// Method, etc.) is really a plain text input backed by a <datalist> -- see
// the many list="...Datalist" attributes across projects.js/reflists.js/
// trials.js. The browser only reopens that suggestion popup reliably once
// the field is empty or actively being typed into, so clicking a field
// that already has a value picked doesn't bring the list back up; the
// user would have to delete the existing text first just to see the
// options again. showPicker() force-opens the same native popup without
// touching the field's value, so a click always offers every option.
document.addEventListener('click', e => {
  const el = e.target;
  if(el.tagName === 'INPUT' && el.hasAttribute('list') && !el.readOnly && !el.disabled && typeof el.showPicker === 'function'){
    try{ el.showPicker(); }catch(err){}
  }
});

// The handful of icon spots that live in the page's static HTML (outside
// any JS-rendered template) rather than being generated fresh each render —
// those can just call icon() directly in their template string, these can't,
// so they get their icon swapped in once here at startup instead.
function applyStaticIcons(){
  const setIcon = (id, name, size) => {
    const el = document.getElementById(id);
    if(el) el.innerHTML = icon(name, size);
  };
  const prefixIcon = (id, name) => {
    const el = document.getElementById(id);
    if(el) el.innerHTML = icon(name) + ' ' + el.textContent.trim();
  };
  setIcon('btnMobileSidebarToggle', 'menu', 20);
  setIcon('btnNavbarNotifications', 'bell', 18);
  setIcon('btnSidebarClose', 'x', 16);
  setIcon('btnCloseMaterialDetail', 'x', 16);
  setIcon('btnCloseAuthConfirm', 'x', 16);
  setIcon('btnCloseVersionsModal', 'x', 16);
  setIcon('btnCloseVersionPreviewModal', 'x', 16);
  setIcon('btnCloseProductLogModal', 'x', 16);
  setIcon('btnMuEditModalTranslatePlan', 'globe', 14);
  setIcon('btnMuEditModalTranslateAction', 'globe', 14);
  setIcon('btnMuEditModalTranslateNextAction', 'globe', 14);
  prefixIcon('btnCompare', 'scale');
  prefixIcon('btnOpenUserAdmin', 'users');
  prefixIcon('btnOpenMyProfile', 'user');
  prefixIcon('btnOpenSecurity', 'lock');
  prefixIcon('btnOpenDataManagement', 'database');
  prefixIcon('btnOpenTrash', 'trash-2');
  prefixIcon('btnSaveVersion', 'save');
  prefixIcon('btnExportAll', 'download');
  prefixIcon('btnImport', 'upload');
  prefixIcon('btnLogoutFromApp', 'log-out');
  const versionsTitle = document.querySelector('#versionsModalOverlay .modal-title');
  if(versionsTitle) versionsTitle.innerHTML = icon('clock') + ' ' + versionsTitle.textContent.trim();
  const productLogTitle = document.querySelector('#productLogModalOverlay .modal-title');
  if(productLogTitle) productLogTitle.innerHTML = icon('clock') + ' ' + productLogTitle.textContent.trim();
  const accountChevron = document.querySelector('.navbar-account-chevron');
  if(accountChevron) accountChevron.innerHTML = icon('chevron-down', 12);
}
applyStaticIcons();

/* Mobile sidebar drawer: hidden off-screen by default below 800px width,
   toggled via a fixed hamburger button, closed via the backdrop, the
   in-drawer close button, or picking anything actionable inside it. */
function openMobileSidebar(){ document.body.classList.add('mobile-sidebar-open'); }
function closeMobileSidebar(){ document.body.classList.remove('mobile-sidebar-open'); }
document.getElementById('btnMobileSidebarToggle').addEventListener('click', openMobileSidebar);
document.getElementById('sidebarBackdrop').addEventListener('click', closeMobileSidebar);
document.getElementById('btnSidebarClose').addEventListener('click', closeMobileSidebar);
document.querySelector('.sidebar').addEventListener('click', e => {
  if(e.target.closest('button, .recipe-item')) closeMobileSidebar();
});

initAuthScreen();
initAuthConfirmModal();
initCompareView();
initVersionsModal();
initVersionPreviewModal();
initRefListsView();
initMaterialLibrary();
initProductsView();
initSampleSubmissionsView();
initProjectsModal();
initMuAttachmentPreviewModal();
initTrialsView();
initUnsavedChangesGuard();
initUserAdminPanel();
initMyProfileModal();
initSecurityModal();
initDataManagementModal();
initTrashModal();
initActivityChangesModal();
renderFooter();

// Scrolling the mouse wheel over a focused number input silently changes
// its value in Chrome/Edge — easy to trigger by accident just scrolling
// the page past one. Blurring it on wheel lets the page scroll normally
// and leaves the value untouched; only typing should ever change it.
document.addEventListener('wheel', e => {
  const el = document.activeElement;
  if(el && el.tagName === 'INPUT' && el.type === 'number' && el === e.target){
    el.blur();
  }
}, { passive: true });

/* Firestore listeners only attach once someone is actually signed in — the
   security rules reject reads/writes from a signed-out client anyway. */
// Attaches the recipes/materials/etc listeners and shows the real app —
// only ever called once approval status has actually resolved to
// approved/exempt, never speculatively, since Firestore rules would just
// reject those reads for a still-pending account anyway (better to not
// even try than to surface a shower of permission-denied errors).
function attachMyProfileListener(){
  unsubscribeMyProfile = onSnapshot(doc(userProfilesCol, currentUser.uid), snap => {
    const data = snap.data();
    myProfile = { displayName: data?.displayName || '', photoImage: data?.photoImage || '' };
    // The Home dashboard's Activities Calendar windows (see
    // homeCalendarPanes/saveCalendarPanes) -- who's watching which window
    // is a per-account layout choice, same document as the rest of this
    // account's own settings. Only overwrite the in-memory default if
    // this account actually has something saved; sanitized defensively
    // in case an older/malformed shape ever ends up in there.
    if(Array.isArray(data?.calendarPanes) && data.calendarPanes.length){
      setHomeCalendarPanes(data.calendarPanes);
      // renderApp() below only touches navbar chrome (avatar/name/module
      // visibility) -- it never re-renders #mainArea, so on its own this
      // update would sit correctly in memory but stay invisible until
      // something else happened to trigger a real re-render (this bit
      // the very first time: refreshing showed the old default pane,
      // and it wasn't until *clicking Add* -- which does call
      // refreshDashboardHome() -- that the actually-already-loaded saved
      // panes suddenly appeared alongside the new one). Only refresh the
      // dashboard here, and only when it's actually the visible view --
      // same guard renderMain() itself uses to decide "we're on Home" --
      // so this can't disrupt someone mid-edit on a different page.
      if(appView === 'app' && !mainFeatureView && !getCurrent()){
        refreshDashboardHome();
      }
    }
    renderApp();
  }, err => {
    console.error('Forge: profile listener error', err);
  });
}

// Writes/refreshes this account's own presence doc -- called immediately
// on sign-in, on a recurring timer while signed in, and whenever the tab
// becomes visible again (a backgrounded tab's timers can be throttled or
// paused by the browser, so a tab switch back is worth an immediate
// refresh rather than waiting for the next scheduled tick).
function sendPresenceHeartbeat(){
  if(!currentUser) return;
  setDoc(doc(presenceCol, currentUser.uid), { email: currentUser.email, lastSeen: Date.now() }, { merge: true })
    .catch(err => console.error('Forge: presence heartbeat failed', err));
}
function attachPresenceListeners(){
  sendPresenceHeartbeat();
  if(!presenceHeartbeatInterval) presenceHeartbeatInterval = setInterval(sendPresenceHeartbeat, PRESENCE_HEARTBEAT_MS);
  if(!presenceRenderInterval) presenceRenderInterval = setInterval(renderOnlineUsers, 15000);
  unsubscribePresence = onSnapshot(presenceCol, snap => {
    presenceList = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    renderOnlineUsers();
  }, err => console.error('Forge: presence listener error', err));
  unsubscribeAllUserProfiles = onSnapshot(userProfilesCol, snap => {
    const next = {};
    snap.docs.forEach(d => { next[d.id] = d.data(); });
    allUserProfiles = next;
    renderOnlineUsers();
  }, err => console.error('Forge: user profiles listener error', err));
}
// Up to this many avatars show individually; anyone past that collapses
// into one "+N" pill instead of the cluster growing unbounded as the team
// does.
const PRESENCE_MAX_AVATARS = 5;
function renderOnlineUsers(){
  const wrap = document.getElementById('navbarOnlineUsers');
  if(!wrap) return;
  const cutoff = Date.now() - PRESENCE_STALE_MS;
  const online = presenceList
    .filter(p => (p.lastSeen || 0) > cutoff)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const shown = online.slice(0, PRESENCE_MAX_AVATARS);
  const extra = online.length - shown.length;
  wrap.innerHTML = shown.map(p => {
    const profile = allUserProfiles[p.uid] || {};
    const { name, initials } = accountDisplayFromEmail(p.email);
    const displayName = profile.displayName || name;
    return `
      <div class="navbar-online-avatar" title="${escapeHtml(displayName)} — Online">
        ${profile.photoImage
          ? `<img src="${escapeHtml(profile.photoImage)}" alt="">`
          : `<span>${escapeHtml(initials)}</span>`}
        <span class="navbar-online-dot"></span>
      </div>
    `;
  }).join('') + (extra > 0 ? `<div class="navbar-online-avatar navbar-online-more" title="${extra} more online">+${extra}</div>` : '');
}
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible') sendPresenceHeartbeat();
});

function unlockAppAfterApproval(){
  if(!unsubscribeRecipes) attachRecipesListener();
  if(!unsubscribeMaterials) attachMaterialsListener();
  if(!unsubscribeProducts) attachProductsListener();
  if(!unsubscribeSubmissions) attachSampleSubmissionsListener();
  if(!unsubscribeMetaLists) attachMetaListsListener();
  if(!unsubscribeProjects) attachProjectsListener();
  if(!unsubscribeTrials) attachTrialsListener();
  if(!unsubscribeLoginEvents) attachLoginEventsListener();
  if(!unsubscribeActivityEvents) attachActivityEventsListener();
  if(!unsubscribeMyProfile) attachMyProfileListener();
  if(!unsubscribePresence) attachPresenceListeners();
  purgeExpiredTrashOnLoad();
  if(appView === 'auth' || appView === 'pending') goToApp();
}

onAuthStateChanged(auth, user => {
  if(user){
    currentUser = user;
    document.getElementById('loginForm').reset();
    document.getElementById('registerForm').reset();
    document.getElementById('loginError').textContent = '';
    document.getElementById('registerError').textContent = '';
    if(isApprovalExempt(user.email)){
      myApprovalStatus = 'exempt';
      myModulePermissions = null;
      unlockAppAfterApproval();
    }else if(!unsubscribeMyApproval){
      unsubscribeMyApproval = onSnapshot(doc(userApprovalsCol, user.uid), snap => {
        if(!snap.exists()){
          // Self-heals accounts that existed before this feature shipped —
          // they never went through the registration flow that creates
          // this doc, so without this they'd have no record at all for the
          // admin to even see, let alone approve. The write below triggers
          // another snapshot right after with the 'pending' doc now in
          // place; the fallback just below covers this exact tick too.
          setDoc(doc(userApprovalsCol, user.uid), {
            email: user.email, status: 'pending', requestedAt: Date.now(), decidedBy: '', decidedAt: null
          }).catch(err => console.error('Forge: failed to create approval record', err));
        }
        const data = snap.data();
        myApprovalStatus = data ? data.status : 'pending';
        myModulePermissions = userModulePermissions(data);
        if(myApprovalStatus === 'approved'){
          unlockAppAfterApproval();
          // Covers the admin revoking a module while this person is
          // actively sitting on that exact view — without this they'd be
          // left looking at a screen whose own nav tab just disappeared.
          // Recipes spans three mainFeatureView states (list/compare/editing
          // a specific recipe) rather than the one-value-per-module mapping
          // the other entries use, so it needs its own check here.
          const onUngatedRecipesView = !hasModuleAccess('recipes') &&
            (mainFeatureView === 'recipesList' || mainFeatureView === 'compare' || (mainFeatureView === null && !!currentId));
          if(onUngatedRecipesView){
            goHome();
          }else if(mainFeatureView && MODULE_PERMISSIONS.some(m => m.key === mainFeatureView) && !hasModuleAccess(mainFeatureView)){
            mainFeatureView = null;
            renderMain();
            renderSidebar();
          }
        }else{
          appView = 'pending';
          renderPendingScreen();
        }
        renderApp();
      }, err => {
        console.error('Forge: approval status listener error', err);
      });
    }
  }else{
    currentUser = null;
    myApprovalStatus = null;
    myModulePermissions = null;
    if(unsubscribeMyApproval){ unsubscribeMyApproval(); unsubscribeMyApproval = null; }
    resetRecipesState();
    resetMaterialsState();
    resetProductsState();
    resetSampleSubmissionsState();
    resetRefListsState();
    resetProjectsState();
    resetTrialsState();
    if(unsubscribeLoginEvents){ unsubscribeLoginEvents(); unsubscribeLoginEvents = null; }
    if(unsubscribeActivityEvents){ unsubscribeActivityEvents(); unsubscribeActivityEvents = null; }
    if(unsubscribeUserApprovalsAdmin){ unsubscribeUserApprovalsAdmin(); unsubscribeUserApprovalsAdmin = null; }
    if(unsubscribeMyProfile){ unsubscribeMyProfile(); unsubscribeMyProfile = null; }
    if(unsubscribePresence){ unsubscribePresence(); unsubscribePresence = null; }
    if(unsubscribeAllUserProfiles){ unsubscribeAllUserProfiles(); unsubscribeAllUserProfiles = null; }
    if(presenceHeartbeatInterval){ clearInterval(presenceHeartbeatInterval); presenceHeartbeatInterval = null; }
    if(presenceRenderInterval){ clearInterval(presenceRenderInterval); presenceRenderInterval = null; }
    presenceList = [];
    allUserProfiles = {};
    renderOnlineUsers();
    myProfile = { displayName: '', photoImage: '' };
    activityEvents = [];
    loginEvents = [];
    appView = 'auth';
  }
  renderApp();
});
