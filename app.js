/* ---------- Firebase (shared cloud backend) ----------
   Every device that opens this file talks to the same Firebase project, so
   recipes and the ingredient library sync across computers automatically.
   access is controlled by Firestore security rules + Firebase Auth. */
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
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
  RECIPE_DIFF_FIELDS, findProjectForRecipe, fullCode, recipeDisplayLabel,
  descriptionListHtml, attachRecipesListener, mountRecipesListView,
  renderRecipeCards, renderSidebarRecipeCards, renderRecipesListGrid, yearPrefix, suggestNextRecipeSeq,
  refreshCodeCountryBadge, updateRecipeTitleDisplay, getCurrent, scheduleSave,
  saveNow, scheduleVersionCheckpoint, cancelVersionCheckpoint,
  autoCheckpointVersion, openVersionsModal, initVersionPreviewModal,
  initVersionsModal, renderLinkedProjectSection, renderProductTypeSelect,
  refreshCodeProductTypeBadge, bindComboField, blankPart, migrateRecipe,
  saveRecipeToCloud, resetRecipesState, openRecipe, closeRecipe,
  setRecipeEditSnapshotBefore, setUnlockedRecipeId, removeRecipe,
  renderRecipeEditor, recomputeFromWeights, allIngredientsInPart,
  allIngredientsInRecipe, formatWeight, partTotalWeight, computeFlowNodeText,
  DEFAULT_FLOW_NODE_W, rectOf, clipToRectEdge, FLOW_ARROWHEAD_DEFS
} from './recipes.js';
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
// Trash screen (see moveToTrash/restoreFromTrash/purgeExpiredTrash below)
// instead of needing a full Firestore backup restore for an everyday
// mistake. Every entity's own delete flow already re-confirms identity
// (or the approver's, for Recipes/Ingredients/Products) before it ever
// runs — Trash doesn't add another gate on top of that, it's purely a
// safety net for after a delete already happened.
export const trashCol = collection(db, "trash");
// Keyed by the same string each entity's delete flow passes to
// moveToTrash — maps back to that collection's own reference so
// restoreFromTrash can write the snapshot back to exactly where it came
// from, and to a human label for the Trash list.
const TRASH_COLLECTION_MAP = {
  recipes: { col: recipesCol, label: 'Recipe' },
  ingredientMaster: { col: materialsCol, label: 'Ingredient' },
  productList: { col: productsCol, label: 'Product' },
  projects: { col: projectsCol, label: 'Project' },
  trials: { col: trialsCol, label: 'Test Result' },
  sampleSubmissions: { col: sampleSubmissionsCol, label: 'Sample Submission' }
};
export const TRASH_RETENTION_DAYS = 30;
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
// Called right before each entity's own deleteDoc, with the exact
// in-memory object about to be deleted (already proven Firestore-safe --
// it's the same shape that collection's own save function writes). Runs
// under the CURRENT user's normal session even when called from inside an
// admin-approver flow (Recipes/Ingredients/Products) -- trashCol only
// ever needs isAllowedUser(), a completely separate Firebase App/auth
// instance from the isolated approver one, so this never depends on
// (or interferes with) whichever session is active at the call site.
export function moveToTrash(sourceCollection, id, data, label){
  return setDoc(doc(trashCol, uid()), {
    sourceCollection,
    originalId: id,
    label: label || 'Untitled',
    data,
    deletedBy: currentUser?.email || '',
    deletedAt: Date.now()
  });
}
export async function restoreFromTrash(trashDoc){
  const target = TRASH_COLLECTION_MAP[trashDoc.sourceCollection];
  if(!target) throw new Error(`Unknown Trash source collection "${trashDoc.sourceCollection}"`);
  await setDoc(doc(target.col, trashDoc.originalId), trashDoc.data);
  await deleteDoc(doc(trashCol, trashDoc.id));
  logActivityEvent('restored', target.label.toLowerCase(), trashDoc.label);
}
// Lazy cleanup -- this app has no scheduled Cloud Function to run this on
// a timer, so it just runs whenever the Trash screen is opened (see
// initTrashModal below), which is exactly when stale entries would
// otherwise be seen anyway.
export async function purgeExpiredTrash(items){
  const cutoff = Date.now() - TRASH_RETENTION_MS;
  const expired = items.filter(t => (t.deletedAt || 0) < cutoff);
  await Promise.all(expired.map(t => deleteDoc(doc(trashCol, t.id))));
  return expired.map(t => t.id);
}
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
const userProfilesCol = collection(db, "userProfiles");
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
function isMyActivity(p, mu){
  return isMyName(mu?.planWho) || isMyName(mu?.nextActionWho) || isMyProject(p);
}

export function showCloudError(message){
  const el = document.getElementById('cloudErrorBanner');
  if(!el) return;
  el.textContent = message;
  el.style.display = 'block';
}

/* MAINTENANCE: every time this file is edited, add a new entry to CHANGELOG
   below (bump the version, today's date, one short line on what changed).
   The footer at the bottom of the page always displays the latest entry. */
const APP_NAME = "Forge";
const CHANGELOG = [
  { version: "1.0.0", date: "2026-07-13", note: "Renamed the program to Forge and added a version indicator in the footer" },
  { version: "1.0.1", date: "2026-07-13", note: "Renamed the file to Forge.html and translated the subtitle under the program name to English" },
  { version: "1.1.0", date: "2026-07-13", note: "Changed the logo to the letter F and updated the color scheme to navy/orange to match the logo, plus added a favicon" },
  { version: "1.2.0", date: "2026-07-13", note: "Recipe code changed to the YYYYMMDD-XX format, with the first 8 digits auto-filled from the recipe date and XX entered manually" },
  { version: "1.3.0", date: "2026-07-13", note: "Added a shared ingredient library (EN/TH name, vendor code, vendor, manufacturer, price, MOQ) — select an existing ingredient from the name field on each row, or add a new one via the ingredient library window" },
  { version: "1.4.0", date: "2026-07-13", note: "Switched to the client's actual vector logo file (Forge_Logo_Navy_Orange_Vector.svg) in both the app and the desktop icon, and locked out entering a weight for ingredients not yet in the library" },
  { version: "1.4.1", date: "2026-07-13", note: "Changed how ingredient names are displayed in the library to show the English name before the Thai name (previously Thai came first)" },
  { version: "1.5.0", date: "2026-07-13", note: "Added sign-up/login — every time the program is opened, users must log in first before reaching the start page (logo + description), and every recipe opens read-only until identity is confirmed with a password to unlock editing or deletion" },
  { version: "1.6.0", date: "2026-07-13", note: "Added a recipe comparison page — select up to 3 recipes, see basic info, ingredient % compared row by row (differences highlighted), and process steps compared side by side" },
  { version: "1.7.0", date: "2026-07-13", note: "Export/Import JSON buttons now include the ingredient library too (previously recipes only), for complete backups/machine transfers. User accounts are still excluded for security; old files still import normally" },
  { version: "2.0.0", date: "2026-07-13", note: "Moved data storage from a single machine (localStorage) to a shared Firebase backend — recipes and the ingredient library are now the same no matter which device opens the app. The account system switched to Firebase Authentication (log in with email instead of a username)" },
  { version: "2.1.0", date: "2026-07-13", note: "Show the logged-in user's email in the left sidebar, right below the program name and logo" },
  { version: "2.1.1", date: "2026-07-13", note: "Confirming identity to edit/delete a recipe now only asks for the password (no need to re-enter the email, since you're already logged in)" },
  { version: "2.2.0", date: "2026-07-13", note: "Translated the entire interface into English" },
  { version: "2.3.0", date: "2026-07-13", note: "New sign-ups restricted to @th-umios.com email addresses only, enforced both in the sign-up form and in Firestore security rules" },
  { version: "2.4.0", date: "2026-07-13", note: "Moved the Delete Recipe button to the bottom of the recipe. It's now only visible to kangawin@th-umios.com — everyone else no longer sees it at all" },
  { version: "2.5.0", date: "2026-07-13", note: "Delete Recipe is visible to everyone again, but deleting now always requires the email + password of kangawin@th-umios.com specifically, verified through an isolated sign-in that never disturbs the current user's own session" },
  { version: "2.5.1", date: "2026-07-14", note: "Fixed the delete confirmation showing \"incorrect email or password\" even when sign-in succeeded but the delete itself failed (e.g. a Firestore rules issue) — now shows the real error in that case" },
  { version: "2.6.0", date: "2026-07-14", note: "The main panel no longer auto-selects a recipe. Entering the app, and after deleting the recipe you were viewing, now shows a blank in-app homepage (logo + description) until you explicitly click a recipe in the list" },
  { version: "2.6.1", date: "2026-07-14", note: "Stopped auto-creating a blank \"Untitled recipe\" whenever the recipe list became empty (was happening on every login and after every delete). The approver email field in the delete-confirmation modal is now pre-filled and locked — only the password needs to be typed" },
  { version: "2.7.0", date: "2026-07-14", note: "Removed the separate post-login \"Home\" screen and its Manage Recipes / Log Out buttons. Logging in now goes straight to the recipe list + sidebar, with the welcome message and app description merged into the blank in-app homepage shown until a recipe is selected" },
  { version: "2.7.1", date: "2026-07-14", note: "Centered the Login and Sign Up form fields (labels and input text) so they line up with the rest of the centered auth card" },
  { version: "2.7.2", date: "2026-07-14", note: "Fixed the real cause of the misaligned Login/Sign Up input boxes: input[type=email] and input[type=password] were missing from the base input styling rule, so they rendered as tiny default browser boxes instead of full-width fields. Now styled and sized consistently with every other input in the app" },
  { version: "2.7.3", date: "2026-07-14", note: "Fixed the mobile/narrow-screen layout where the sidebar's text would overflow its box and visually overlap the recipe panel below it — the sidebar now scrolls within its own height instead of spilling over" },
  { version: "2.8.0", date: "2026-07-14", note: "Section 1: Date now sits right after Product Name, before Recipe Code. Ingredient rows show the vendor code once linked to the library. Ingredient parts collapse by default when empty (click to expand) instead of always showing all 4. Process Steps restructured into named process groups, each with its own numbered sub-steps and an Add Step button, plus an Add Process button. Compare Recipes now labels each recipe as \"Name - XX\" using the last 2 characters of its code" },
  { version: "2.8.1", date: "2026-07-14", note: "Fixed ingredient picker not distinguishing between library entries that share the same name but come from different vendors (e.g. two \"Modified Starch\" entries with different codes) — selecting either one always linked to whichever was added first. The picker list and matching now include the vendor code in the label, e.g. \"Modified Starch / แป้งดัดแปร (RM-002)\", so each option is unambiguous" },
  { version: "2.8.2", date: "2026-07-14", note: "Compare Recipes: added a \"Show ingredient codes\" checkbox to toggle the vendor code on/off in the ingredient comparison list. Fixed the Total row sometimes showing 99.99% instead of 100.00% — it was summing each ingredient's already-rounded percentage instead of deriving the total directly from weight, the same rounding-drift bug fixed earlier on the main recipe page" },
  { version: "2.9.0", date: "2026-07-14", note: "Compare Recipes: moved the \"Show ingredient codes\" checkbox to sit under the Compare Ingredients heading, and added a Compare Costing section (weight x library price/kg per ingredient, plus a Total Cost per recipe). Ingredient Library: added Edit and Copy buttons per row so entries can be corrected or used as a template for a similar ingredient, instead of only Delete" },
  { version: "2.9.1", date: "2026-07-14", note: "Relabeled the ingredient library's \"Price\" field to \"Price/kg (฿)\" and added a ฿ prefix wherever it's shown or used (library table, tooltip, Compare Costing) so the currency and unit are explicit instead of assumed" },
  { version: "2.9.2", date: "2026-07-14", note: "Added an \"Ingredient Library\" button directly in the sidebar so the library can be opened without first selecting a recipe" },
  { version: "3.0.0", date: "2026-07-14", note: "Added a large Product Name + Recipe Code title at the top of the recipe panel. The unlock banner is now green when editable and stays red when read-only (was navy before). The idle \"Ready\" save-status label is now green like \"Saved\". Clicking the Forge logo in the sidebar now returns to the blank in-app homepage" },
  { version: "3.0.1", date: "2026-07-14", note: "Enlarged the Product Name + Recipe Code title to 60px. Swapped the order of Recipe Code and Description/Concept in section 1 (Description now comes first, Recipe Code second)" },
  { version: "3.0.2", date: "2026-07-14", note: "Adjusted the Product Name + Recipe Code title size from 60px down to 54px" },
  { version: "3.0.3", date: "2026-07-14", note: "MOQ field in the Ingredient Library is now a fixed-unit \"kg\" number input (numbers only, unit shown as a suffix) instead of free text. Existing entries saved as free text (e.g. \"25 kg\") still display and edit correctly" },
  { version: "3.0.4", date: "2026-07-15", note: "Logo references now point at forge-deploy/Forge_Logo_Navy_Orange_Vector.svg instead of a duplicate copy in the main folder, removing the redundant file (the deploy sync step rewrites this path back to a plain filename for the live site)" },
  { version: "3.0.5", date: "2026-07-15", note: "Shortened the homepage description to \"Recipe development software for product development teams\"" },
  { version: "3.0.6", date: "2026-07-15", note: "Switched the logo everywhere to Forge_Logo_Navy_Orange_Vector_Large.svg (a tighter-cropped version of the same mark) and removed the old Forge_Logo_Navy_Orange_Vector.svg file" },
  { version: "3.0.7", date: "2026-07-15", note: "Compare Recipes: added a \"Cost / kg of product\" row under Compare Costing's Total Cost (Total Cost ÷ batch weight), so recipes with different batch sizes can be compared on an even footing" },
  { version: "3.0.8", date: "2026-07-15", note: "Compare Recipes: added a Print button that prints the comparison full-page (ingredients, costing, process steps) instead of being clipped by the modal's on-screen size" },
  { version: "3.0.9", date: "2026-07-15", note: "Ingredient Library: can now attach a photo to each ingredient (auto-shrunk to a small thumbnail, stored with the entry — no separate file storage needed), shown as a thumbnail in the library table" },
  { version: "3.0.10", date: "2026-07-15", note: "Recipe Overview (all parts combined) now shows each ingredient's photo (from the Ingredient Library) next to its name" },
  { version: "3.0.11", date: "2026-07-15", note: "Recipe Overview: now also shows each ingredient's vendor and manufacturer (from the Ingredient Library) as a small line under its name" },
  { version: "3.0.12", date: "2026-07-15", note: "Ingredient Library: added a \"Usage Notes\" field (handling/dosage instructions, etc.) shown in the ingredient's tooltip on the recipe page" },
  { version: "3.0.13", date: "2026-07-16", note: "Ingredient Library: clicking anywhere on a row (other than the Edit/Copy/Delete buttons) now opens a details view with the ingredient's full photo, all fields, and usage notes" },
  { version: "3.0.14", date: "2026-07-16", note: "Ingredient Library: the search box now also matches against Usage Notes, so ingredients can be found by handling/dosage instructions, not just name/code/vendor" },
  { version: "3.0.15", date: "2026-07-16", note: "Section 2 (Ingredients) is no longer fixed at 4 parts — added a \"+ Add Part\" button and a delete button per part (at least one part is always kept). Section 3 (Process Steps): each process can now be moved up/down, not just its individual steps" },
  { version: "3.0.16", date: "2026-07-16", note: "The \"+ Add Ingredient (...)\" button and \"... Subtotal\" row now follow the part's custom name (e.g. \"+ Add Ingredient (Mixed)\") instead of always showing \"Part N\", updating live as you rename the part" },
  { version: "3.0.17", date: "2026-07-16", note: "Printing now renders every table as cleanly as Recipe Overview: input/textarea fields print as plain text (no boxes), edit/copy/delete/collapse icons are hidden, and collapsed ingredient parts are force-expanded so nothing is missing from the printout" },
  { version: "3.0.18", date: "2026-07-16", note: "The ingredient Weight (g) field now always shows 2 decimal places (e.g. \"6.00\" instead of \"6\"), formatting as soon as you leave the field" },
  { version: "3.0.19", date: "2026-07-16", note: "Printing/saving a recipe as PDF now defaults the filename to \"Recipe Product Name Recipe Code Forge\" instead of the browser's generic page title" },
  { version: "3.0.20", date: "2026-07-16", note: "Printing a recipe now shows section 1 (Code/Date/Total weight/Description) in the same clean read-only card style as Compare Recipes, instead of the on-screen editable form fields" },
  { version: "3.0.21", date: "2026-07-16", note: "Printing a recipe now also shows section 3 (Process Steps) as clean orange process headers with a plain numbered step list, instead of the on-screen editable step boxes" },
  { version: "3.0.22", date: "2026-07-16", note: "Section 1: Description / Concept is now a list of separate points (+ Add Point / delete per point) instead of one text box. Added a \"Trial / Experiment Results\" area with up to 3 photos and a free-form sensory evaluation table (criteria / score / comment, add/delete rows). Ingredient Library now lists the most recently added ingredient first. Recipe Overview now numbers each ingredient row" },
  { version: "3.0.23", date: "2026-07-16", note: "The sidebar recipe list now shows the Recipe Code suffix after the product name (e.g. \"Vegan Tartar Sauce - 20\"), matching the naming already used in Compare Recipes and printing" },
  { version: "3.0.24", date: "2026-07-16", note: "\"Name - Code\" labels (sidebar, Compare Recipes) now show the full Recipe Code suffix as typed instead of always truncating to the last 2 characters (e.g. \"02A\" now shows as \"02A\", not \"2A\")" },
  { version: "3.0.25", date: "2026-07-16", note: "Compare Recipes no longer auto-selects the 3 most recently updated recipes when opened — all three picker slots start blank, so the user always chooses recipes fresh" },
  { version: "3.0.26", date: "2026-07-16", note: "Compare Recipes: the recipe dropdowns are now sorted alphabetically by product name (then by code), instead of by most recently updated" },
  { version: "3.0.27", date: "2026-07-16", note: "Clicking into an ingredient's Weight (g) field now selects the whole number, so you can type a new value right away instead of having to clear it first" },
  { version: "3.0.28", date: "2026-07-16", note: "Read-only weight totals (Total Recipe Weight, Part Subtotal, Grand Total, Recipe Overview, Compare Recipes) now show a thousands separator, e.g. \"2,000.00 g\" instead of \"2000.00 g\". The editable Weight (g) field itself is unchanged since number inputs can't contain commas" },
  { version: "3.0.29", date: "2026-07-16", note: "Each ingredient's \"% of Part\" (renamed from \"% of Recipe\") is now relative to its own part's weight, so every part's own Subtotal is always 100%. The part header still shows that part's % share of the whole recipe, next to the ingredient count. Recipe Overview, Compare Recipes, and the sidebar's overall % are unaffected — they still reflect the whole recipe" },
  { version: "3.0.30", date: "2026-07-16", note: "Each Process (section 3) now has a \"Components\" table — pick an existing Part or ingredient from the recipe to add a row (Name, Weight, ± Tolerance, auto-computed Range, %). Values are copied in once and can then be edited freely without affecting the recipe's real ingredients" },
  { version: "3.0.31", date: "2026-07-16", note: "Components now sits above the Steps list within each Process. Its % column is auto-computed from the table's own weights (always sums to 100%) instead of being freely editable. Printing a recipe now includes each process's Components table" },
  { version: "3.0.32", date: "2026-07-16", note: "Components table: added a row number (#) column and a Total row (weight + %), on-screen and when printing (empty tables are skipped when printing). Section 2 (Ingredients) no longer auto-creates 4 parts for a new recipe — it now starts empty with a \"+ Add Part\" prompt" },
  { version: "3.0.33", date: "2026-07-16", note: "Removed the separate \"Grand Total (All Parts)\" box in section 2 — the same total (% and weight) now shows as a Total row at the bottom of the Recipe Overview table instead" },
  { version: "3.0.34", date: "2026-07-16", note: "Added two BOM-style features: an Expected Yield (%) field in section 2 that shows an Adjusted Output Weight (accounting for production loss), and a Version History tool (🕒 Versions in the toolbar) to save/restore/delete named snapshots of the recipe's formulation" },
  { version: "3.0.35", date: "2026-07-17", note: "Recipes and Ingredient Library entries now track who created and last edited them, and when. Shown under the recipe title on the recipe page, and in the Ingredient Library's detail view (click a row)" },
  { version: "3.0.36", date: "2026-07-17", note: "Improved layout for narrow/mobile screens: the Product Name title and page padding shrink to fit small screens instead of wasting vertical space, the read-only/unlock banner wraps instead of crowding its button off-screen, Compare Recipes' 3-column layouts stack into one column, and the ingredient and Recipe Overview tables scroll horizontally within their own box instead of stretching the whole page" },
  { version: "3.0.37", date: "2026-07-17", note: "On narrow/mobile screens, the left sidebar (recipe list, New Recipe, Compare, Ingredient Library) is now hidden behind a ☰ menu button and slides in as an overlay when tapped, instead of always taking up space above the recipe. Tap the backdrop, the ✕ in the drawer, or pick anything inside it to close" },
  { version: "3.0.38", date: "2026-07-17", note: "Each ingredient part's \"% of recipe\" summary now shows 2 decimal places instead of 1, matching the Recipe Overview table exactly. Versions/Duplicate/Print PDF buttons are now right-aligned under the recipe title. The Subtotal/Total rows in the ingredient, Recipe Overview, and Components tables now line up in the same column as the values above them instead of sitting flush left" },
  { version: "3.0.39", date: "2026-07-17", note: "Fixed printing/PDF export picking up the new mobile layout when triggered from a narrow screen: the ☰ menu button no longer appears in the printout, the Product Name and Recipe Code always print on one line, and the \"Delete Recipe\" button no longer appears at the bottom of the printout" },
  { version: "3.0.40", date: "2026-07-17", note: "Fixed the Recipe Overview table's numbers not lining up: the Total row's % column had silently lost its column width/alignment (a JS bug overwrote its class name instead of adding to it), and the Weight column's per-ingredient rows were left-aligned while the Total was right-aligned. Every row and the Total now line up in a straight column for both % and Weight" },
  { version: "3.0.41", date: "2026-07-17", note: "Fixed a regression from 3.0.40 that broke the Parts ingredient table's row/Subtotal number alignment (on screen and when printing): the previous fix's right-align rule was too broad and added extra padding on top of the ingredient row's own boxed % / Weight fields, pushing them out of line with the Subtotal again. Narrowed the fix to only the table totals and the Recipe Overview's rows, leaving the Parts table's already-aligned row fields untouched" },
  { version: "3.0.42", date: "2026-07-17", note: "Fixed the batch-summary stats (Total Weight / Scale / Yield / Adjusted Output) laying out differently on screen vs. in print — it now always uses a fixed 2-column layout in both places instead of a width-dependent flex-wrap. Also fixed the Yield % field looking too far from its \"%\" suffix: narrowed the field to fit a percentage and right-aligned its text so the two now read as one joined pill" },
  { version: "3.0.43", date: "2026-07-17", note: "Section 1 renamed \"Product Name & Details\" → \"Product Details\", with two new fields: Destination Country and Sales Rep (responsible / requested by) — shown in the recipe page, Compare Recipes, and printouts. Description / Concept points are now numbered, and the section can now hold up to 3 reference photos alongside the trial photos" },
  { version: "3.0.44", date: "2026-07-21", note: "Added a Customer Name field (before Destination Country). Customer Name, Destination Country, and Sales Rep are now type-to-add dropdowns shared across all recipes — typing a new value saves it to a shared suggestion list, and the trash button next to each field clears that recipe's own value" },
  { version: "3.0.45", date: "2026-07-21", note: "Added a \"Reference Lists\" screen (sidebar button) for managing the Customer / Sales Rep / Destination Country suggestion lists directly — add or delete entries in one place instead of only through typing them into a recipe" },
  { version: "3.0.46", date: "2026-07-21", note: "Customer Name, Destination Country, and Sales Rep on the recipe page can no longer add new values by typing — picking a value not already in Reference Lists now warns you to add it there first. Reference Lists entries can be renamed in place, and each one now shows who added it (and when), plus who last edited it (and when)" },
  { version: "3.0.47", date: "2026-07-21", note: "Reference Lists entries now have an explicit ✏️ Edit button — names are read-only until you click Edit, instead of being editable just by clicking into them" },
  { version: "3.0.48", date: "2026-07-21", note: "Reference Lists: clicking ✏️ Edit now swaps it for a 💾 Save button, and the ✕ Delete button becomes ↩️ Cancel while editing — instead of saving automatically when you click away or press Enter" },
  { version: "3.0.49", date: "2026-07-21", note: "Deleting a Reference Lists entry now asks for confirmation first, then requires your password before it's actually removed — matching the same safeguard already used for deleting a recipe" },
  { version: "3.0.50", date: "2026-07-21", note: "Deleting a recipe now also asks for a plain Yes/No confirmation before the approver password step (it used to jump straight to the password form). Deleting an ingredient from the Ingredient Library now requires the same approver email + password as deleting a recipe, instead of just a Yes/No confirmation" },
  { version: "3.0.51", date: "2026-07-21", note: "The \"Confirm Identity\" password popup now always renders above any notification banner (e.g. a cloud connection error) and above any other open modal, instead of potentially being covered by them" },
  { version: "3.0.52", date: "2026-07-27", note: "Replaced the blank in-app homepage with a dashboard: recipe/material counts, recipes by country/customer/sales rep, most-used materials, trial evaluation score trend, most-iterated recipes, recently added materials, and recent activity" },
  { version: "3.0.53", date: "2026-07-27", note: "Restyled the app with a lighter, more rounded look — system font stack, larger corner radius, and borderless cards with softer shadows — while keeping the existing navy/orange brand colors" },
  { version: "3.0.54", date: "2026-07-27", note: "Added a Projects screen for tracking cross-recipe production projects — owner sales rep, responsible person, factory, and per-product sales rep/stage with an append-only progress log" },
  { version: "3.0.55", date: "2026-07-27", note: "Projects are now included in Export All (JSON) and Import, with recipe references remapped correctly so imported product links still point at the right recipe" },
  { version: "3.0.56", date: "2026-07-27", note: "The home dashboard now also shows total projects, products by stage, and recent project activity" },
  { version: "3.0.57", date: "2026-08-03", note: "Compare Recipes now groups ingredients by Part (matching the recipe page) and shows weight (g) next to each percentage, with a checkbox to toggle grams on/off, numbers right-aligned, and a divider between each compared recipe for easier side-by-side reading" },
  { version: "3.0.58", date: "2026-08-03", note: "Reference Lists: added Responsible Person (PD) and Factory (with Location) as new manageable list types" },
  { version: "3.0.59", date: "2026-08-03", note: "Projects: added Edit/Save/Delete buttons, a collapsible list view, and a dashboard summary (project/product counts, products by stage) at the top of the screen. New fields: Request Date, Customer Name, Destination Country, Factory Sales Rep, and Requirements/Certifications" },
  { version: "3.0.60", date: "2026-08-03", note: "Recipes can now be linked to a Project directly from the recipe page — picking a project shows its customer, destination, and sales rep info inline. The recipe's own Customer Name/Destination Country/Sales Rep fields were removed, since that information now comes from the linked Project" },
  { version: "3.0.61", date: "2026-08-03", note: "Added a standalone Trial Results screen (moved out of the recipe page) for comparing up to 4 products side by side — shared photos plus a Sensory Evaluation table scored per product, instead of a single trial tied to one recipe" },
  { version: "3.0.62", date: "2026-08-03", note: "Trial Results: product cards now line up column-for-column with the Sensory Evaluation table below them, and each trial has Edit/Save/Delete/Print buttons — fields are locked read-only until Edit is clicked, and Print outputs just that one trial" },
  { version: "3.0.63", date: "2026-08-04", note: "Recipe Code now leads with a 2-letter ISO 3166-1 country code (e.g. \"TH-20260715-02A\") based on the linked Project's Destination Country — shown wherever the recipe code appears (recipe title, sidebar, Compare Recipes, Trial Results, print). Recipes without a linked Project, or with an unrecognized destination, are unaffected" },
  { version: "3.0.64", date: "2026-08-04", note: "Reference Lists → Destination Countries now shows a small circular flag icon before each entry, resolved from the same country name → ISO code lookup used for Recipe Code. Entries that don't resolve to a real flag (e.g. \"EU\") show their code as text instead" },
  { version: "3.0.65", date: "2026-08-04", note: "Projects: the \"Owner Sales Rep\" field/label is now called \"Project Owner\" everywhere it appears (recipe page, Trial Results product cards). No data changed — same field, clearer name" },
  { version: "3.0.66", date: "2026-08-04", note: "Home dashboard: replaced \"Recipes by country\" with a \"By Country / Region\" ranked list — a flag icon (matching Reference Lists) plus a proportional bar per destination country, sourced from Projects' Destination Country instead of the recipe's own (now-unused) field" },
  { version: "3.0.67", date: "2026-08-04", note: "Fixed the EU entry in Destination Countries (and everywhere else flags show) falling back to plain \"EU\" text — it now shows an actual EU flag (the 12-gold-star ring on blue), drawn directly rather than pulled from the flag icon set, which doesn't include it since the EU isn't a country" },
  { version: "3.0.68", date: "2026-08-04", note: "Projects: added a Status field (Not Started / In Progress / Blocked-On Hold / In Review / Completed / Cancelled, English with a Thai translation) — editable via the same Edit/Save flow as the other project fields, and shown in each project's collapsed summary line" },
  { version: "3.0.69", date: "2026-08-04", note: "Projects is now a scannable table (Status, Requested, Customer, Destination, Owner, Factory Rep, PD, Factory, Reqs, Products as columns) instead of a stack of cards, so it's easy to see at a glance which projects are missing which fields — any empty field shows a red \"—\" instead of blank. Click a row's arrow to expand the full editable form below it, same as before. Saving now collapses the row back down automatically instead of leaving it expanded" },
  { version: "3.0.70", date: "2026-08-04", note: "Projects table: each project name now has a small progress bar underneath showing its Status at a glance — empty for Not Started, partway (orange) for In Progress, partway in red for Blocked/On Hold, further along (navy) for In Review, and full green for Completed; Cancelled shows full grey" },
  { version: "3.0.71", date: "2026-08-04", note: "Fixed the Projects table's Edit/Save/Delete column scrolling out of view on narrower screens (the table has enough columns that it scrolls horizontally) — that column is now pinned to the right edge so it's always reachable no matter how far the table is scrolled" },
  { version: "3.0.72", date: "2026-08-04", note: "Fixed the Projects table's horizontal scrollbar being unreachable without first scrolling all the way down past every row. The table now scrolls within its own bounded box (both directions), with the column headers pinned to the top of that box, so both scrollbars stay within reach near the top of the list instead of at the bottom of 25+ rows" },
  { version: "3.0.73", date: "2026-08-04", note: "Projects: added a Monthly Updates log to each project (below Requirements/Certifications when expanded) for reporting progress up the chain — each entry records a date, ผลการดำเนินงาน (what was accomplished), and Next Plan, plus who added it and when. Entries are listed newest-first and can be deleted individually if one was added by mistake" },
  { version: "3.0.74", date: "2026-08-04", note: "Monthly Updates: the date/results/next-plan fields now sit side by side in one row instead of stacked, and adding or deleting an entry now requires clicking Edit first (like the rest of a project's fields) instead of being editable any time the row is expanded" },
  { version: "3.0.75", date: "2026-08-04", note: "Projects: added a search box (matches name, customer, destination, owner, factory rep, PD, factory, or status) that filters the table, plus a new \"Projects by Status\" breakdown alongside \"Products by stage\" at the top of the screen" },
  { version: "3.0.76", date: "2026-08-04", note: "Moved the Projects search box below the dashboard summary, right above the table, instead of above it" },
  { version: "3.0.77", date: "2026-08-04", note: "Fixed a data-loss bug: typing a Monthly Update (date/results/next-plan) and clicking the project's main Save button — instead of the separate \"+ Add Update\" button — silently discarded what was typed. Save now captures a pending Monthly Update too, so nothing is lost regardless of which button is clicked" },
  { version: "3.0.78", date: "2026-08-06", note: "Compare Recipes, Ingredient Library, Reference Lists, Projects, and Trial Results no longer open as pop-up windows — each now takes over the main screen (with a \"← Back\" button), matching how opening a recipe already works. Smaller dialogs nested inside them (password confirm, version history, ingredient add/edit, project's product log) are unchanged" },
  { version: "3.0.79", date: "2026-08-06", note: "Projects table: added a Status filter dropdown next to the search box, and every column header (Project, Status, Requested, Customer, Destination, Owner, Factory Rep, PD, Factory, Products) is now clickable to sort the table by that column — click again to reverse the order" },
  { version: "3.0.80", date: "2026-08-06", note: "Moved the 5 feature buttons (Compare Recipes, Ingredient Library, Reference Lists, Projects, Trial Results) out of the left sidebar and into a horizontal tab bar across the top of the screen, underlined to show which one is currently open. The sidebar now holds just the logo, account info, + New Recipe, search, and the recipe list" },
  { version: "3.0.81", date: "2026-08-06", note: "Redesigned the top bar to match a standard app-navbar layout: the Forge logo moved from the sidebar to the top-left (click it to go home), a Help icon and Notifications bell were added on the top-right, and the account box + Log Out button moved out of the sidebar into an avatar/name dropdown next to them (also holding Export All / Import). The sidebar itself now only has + New Recipe, search, and the recipe list" },
  { version: "3.0.82", date: "2026-08-06", note: "Added a \"Recipes\" tab to the top bar (the Home view — click it or the Forge logo to get there) and moved \"Compare Recipes\" off the top bar into the sidebar, right below + New Recipe, since it's a function you reach for while working with recipes rather than a standalone destination. The Recipes tab stays highlighted while comparing or editing any recipe" },
  { version: "3.0.83", date: "2026-08-06", note: "The left sidebar (+ New Recipe, Compare Recipes, search, recipe list) now only shows up while in Recipes mode — every other tab (Ingredients, Reference Lists, Projects, Trials) gets the full width of the screen instead, with no sidebar at all" },
  { version: "3.0.84", date: "2026-08-06", note: "Redesigned the Home dashboard: a personal greeting + a search-and-create bar up top, 4 clickable stat cards (Active Projects, Pending Review, Needs Attention, Updated This Week), a \"Needs Attention\" list surfacing real data gaps (projects with no products yet, unscored trials, projects missing this month's update, materials with no price), a merged Recent Activity feed across recipes/projects/trials, an Active Projects table with per-project progress and next action, and a Product Pipeline funnel. All existing analytics (By Country, sales rep/materials/customer breakdowns, trial score trend, most-iterated recipes, recently added materials) stay below, unchanged" },
  { version: "3.0.85", date: "2026-08-06", note: "The Forge logo now goes to the Home dashboard specifically (no sidebar), while the \"Recipes\" tab opens a new full-page Recipes browser (also no sidebar, cards laid out in a wider grid) instead of just aliasing to Home. Opening a specific recipe from either place hands off to the compact sidebar list, which now only appears while a recipe is actually open — not on Home, and not on the Recipes browser itself" },
  { version: "3.0.86", date: "2026-08-06", note: "Compare Recipes: fixed the Recipe 1/2/3 pickers, ingredient/costing tables, and Process Steps columns not lining up with each other (the pickers and steps were missing the same leading spacer the ingredient table already used, so everything after the picker row was shifted one column to the right). Also shrunk the page-header title on Compare Recipes, Ingredient Library, Reference Lists, Projects, Trial Results, and Recipes from the same oversized 54px used for an actual recipe's title down to 26px, since these are short section labels, not a document title" },
  { version: "3.0.87", date: "2026-08-06", note: "Projects table no longer sits in its own bounded, bordered scroll box (max-height 60vh) inside the page — it now grows and scrolls with the page like the rest of the screen. Still scrolls sideways on its own for the wide column set, with Edit/Save/Delete still pinned to the right edge while doing so" },
  { version: "3.0.88", date: "2026-08-06", note: "Projects table: added a thin scrollbar pinned to the bottom of the screen (not the bottom of the table) so the sideways scroll is reachable no matter where you've scrolled down to — dragging it or the table's own scrollbar moves both together" },
  { version: "3.0.89", date: "2026-08-06", note: "Reordered the top navbar tabs to Projects, Recipes, Trials, Ingredients, Reference Lists" },
  { version: "3.0.90", date: "2026-08-06", note: "Projects table: hid the table's own horizontal scrollbar (still fully scrollable by drag/wheel/touch, just visually silent) so only the bottom-pinned proxy scrollbar shows, instead of two redundant scrollbars stacked on top of each other" },
  { version: "3.0.91", date: "2026-08-06", note: "Projects: added an optional photo per project — upload/remove it from the project's expanded edit form, shown as a thumbnail in a new Photo column in the Projects table" },
  { version: "3.0.92", date: "2026-08-06", note: "Projects: added a Duplicate button (appears once you click Edit, next to Save) that copies a project's name/photo/customer/destination/owner/requirements/products as a starting template, resetting status to Not Started, each product's stage, and clearing monthly updates — then opens the new copy straight into editing" },
  { version: "3.0.93", date: "2026-08-06", note: "Projects: \"Projects by Status\" bars are now colored by status (matching the mini status bar under each project's name in the table below) instead of every bar being the same color. Also added a clear (✕) button to the Projects search box that appears once you start typing" },
  { version: "3.0.94", date: "2026-08-07", note: "Replaced every emoji used as a UI icon (section headers, buttons, stat cards, status badges, etc.) with Lucide icons — embedded inline as SVG so the app still works offline, rather than loaded from a CDN. Emoji left untouched in changelog history text, since those are just describing what a past version looked like at the time" },
  { version: "3.0.95", date: "2026-08-07", note: "Icons are now navy by default, switching to orange only for active/selected state (the current tab, an active sort column, Compare Recipes while open). Delete/trash icons stay red as a warning color, and icons on solid navy buttons stay white for contrast" },
  { version: "3.0.96", date: "2026-08-07", note: "Recipes browser: recipe cards go back to a single-column list instead of a wrapping grid, and the page itself is back to the standard width instead of the wide layout that grid needed" },
  { version: "3.0.97", date: "2026-08-07", note: "Responsive layout: centered and widened the dashboard on laptops, added a tablet breakpoint for iPad Air, and rebuilt the compact navigation, cards, tables, modals, and safe spacing for iPhone-sized screens without page-level horizontal overflow" },
  { version: "3.0.98", date: "2026-08-07", note: "Mobile polish: stacked the Projects search and status filter at phone widths and replaced the browser-default tab focus box with a compact brand-colored keyboard focus ring" },
  { version: "3.0.99", date: "2026-08-07", note: "Installed web apps now check for a new Service Worker whenever they open or return to the foreground, then reload automatically so iPhone users receive the latest deployed version" },
  { version: "3.0.100", date: "2026-08-07", note: "Removed the redundant Back button from every full-page mode; navigation now uses the top tabs and Forge logo only" },
  { version: "3.0.101", date: "2026-08-07", note: "Fixed a leftover-emoji bug from the earlier Lucide icon conversion: the sidebar's Compare Recipes button, the Save Current as Version button, and the Version History / Progress Log modal titles were showing their new icon right next to the old emoji instead of replacing it, since the emoji was still baked into their static HTML text underneath" },
  { version: "3.0.102", date: "2026-08-07", note: "Added a sign-in log: every login/signup now records who and when to Firestore, viewable by anyone on the team from the notification bell (with an unread-count badge). Read-only audit trail — a client can only ever write its own sign-in event, never someone else's, and can't edit or delete entries once written" },
  { version: "3.0.103", date: "2026-08-07", note: "Projects table: Save/Duplicate/Cancel were plain white buttons that nearly disappeared against the white row background — Save is now a solid navy primary button, Duplicate and Cancel got a light tint so all three read clearly as buttons" },
  { version: "3.0.104", date: "2026-08-10", note: "Customers in Reference Lists can now have a Country, picked from the existing Destination Countries list (with a flag badge shown next to the name) — matches the same must-exist-in-the-list rule already used for Destination Country elsewhere in Forge" },
  { version: "3.0.105", date: "2026-08-10", note: "Adding a new Destination Country is now a search-and-pick from a full world list of ~250 countries and territories instead of free typing, so names come out consistent and correctly spelled every time" },
  { version: "3.0.106", date: "2026-08-10", note: "Projects: picking a Customer Name that already has a Country on file (Reference Lists) now auto-fills Destination Country, instead of having to type it again for every project" },
  { version: "3.0.107", date: "2026-08-10", note: "\"+ New Project\" now opens a details form right below the button instead of immediately creating a blank project row in the table — nothing is added to the Projects list until you fill it in and click Save (Cancel discards it)" },
  { version: "3.0.108", date: "2026-08-10", note: "Added a Project Photos gallery under the Projects heading, grouped by status (Not Started through Cancelled) — each photo ringed in its status color (Blocked in red, In Progress in orange, Completed in green, etc.) and shown in black-and-white with a grey ring once Cancelled" },
  { version: "3.0.109", date: "2026-08-10", note: "Recipe page: the read-only banner and the Versions/Duplicate/Print PDF buttons now share one row instead of stacking as two separate bars" },
  { version: "3.0.110", date: "2026-08-10", note: "Reference Lists: added a \"Trial Code Format\" tab explaining the trial recipe numbering structure (Country+Year-Product Type+Recipe No.-Trial No., e.g. TH26-SAU01-T01) for reference when assigning new trial codes, in English with Thai translations alongside" },
  { version: "3.0.111", date: "2026-08-10", note: "Reference Lists: added a Product Types tab — type in a name (e.g. \"Sauce\") and its trial-code abbreviation (\"SAU\") is calculated automatically from the first 3 letters, never typed by hand, with a warning if two type names would collide on the same code" },
  { version: "3.0.112", date: "2026-08-10", note: "Recipe Code changed to the new TH26-SAU01-T01 format: country + 2-digit year (both auto), a standalone Product Type field (Product Details) that the code's type segment mirrors read-only, an auto-assigned sequence number per type, and a Trial No. field replacing the old free-text suffix" },
  { version: "3.0.113", date: "2026-08-10", note: "Recipe Code row tightened up to stop wrapping onto two lines and read as glued numbers (\"TH26\", \"BRE01\") instead of separated boxes, and the sequence number segment is now fully automatic (assigned the moment Product Type is picked) instead of an editable box" },
  { version: "3.0.114", date: "2026-08-10", note: "Fixed Duplicate Recipe carrying over the original's sequence number unchanged (e.g. two recipes both \"BRE01\") — a duplicate now gets its own next number for that Product Type instead" },
  { version: "3.0.115", date: "2026-08-10", note: "Fixed Duplicate Recipe not carrying over the linked Project — the copy now shows up on the same Project (as its own fresh product entry, not the original's progress/stage)" },
  { version: "3.0.116", date: "2026-08-10", note: "Trial Results: products being compared can now be typed in manually (e.g. a competitor sample) instead of only picked from this app's Recipes — a manual entry gets the same detail fields as a linked recipe's card (Code, Date, Total weight, Customer, Destination, Project Owner, Stage), just hand-typed, and scores in the evaluation table exactly like any other product" },
  { version: "3.0.117", date: "2026-08-10", note: "Projects: a project you're just viewing (not editing) now shows a clean read-only layout — photo on the left, details as an easy-to-read list on the right — instead of a grid of disabled input boxes, matching the Ingredient Library's detail view" },
  { version: "3.0.118", date: "2026-08-10", note: "Trial Results: a manually-typed product's Customer/Destination/Project Owner fields now pick from the same shared Reference Lists as everywhere else in Forge, and Stage is a dropdown from the same fixed list Projects uses, instead of free-typed text" },
  { version: "3.0.119", date: "2026-08-10", note: "Projects: the read-only view's Requirements / Certifications was only shown when filled in — it's now always shown (with a \"-\" placeholder when empty), matching every other field in that summary" },
  { version: "3.0.120", date: "2026-08-10", note: "Projects: the Products table now respects view vs. Edit mode too — Sales Rep and Stage show as plain text (not a live input/dropdown) and the \"+ Add Product\" row is hidden while just viewing, matching the rest of the project's read-only summary" },
  { version: "3.0.121", date: "2026-08-10", note: "Projects table: long Customer/Destination/Factory names no longer force the whole table wider than the screen and needing a horizontal scrollbar — long text now wraps onto a second line instead, so every column stays visible on one screen" },
  { version: "3.0.122", date: "2026-08-10", note: "Monthly Updates: \"ผลการดำเนินงาน\" is now labeled \"Activities\" in English, each entry can now be edited (not just deleted) via a new Edit button, and Next Plan gets its own date field separate from the Activities date" },
  { version: "3.0.123", date: "2026-08-10", note: "Monthly Updates (now labeled \"Activities Updates\"): adding a new entry is now a compact \"+ Add Activities\" button instead of an always-visible form — clicking it reveals Date, Activities, Next Plan date, and Next Plan together on one line to fill in and save" },
  { version: "3.0.124", date: "2026-08-10", note: "Projects table: column headers no longer wrap into broken mid-word text (\"PHOT/O\", \"REQUE/STED\") on narrower screens, and the header row now stays pinned below the navbar while scrolling down a long list instead of scrolling out of view — data cells still wrap normally" },
  { version: "3.0.125", date: "2026-08-10", note: "Activities Updates redesigned as a timeline: each entry is now Plan / Action Taken / Next Action (was Activities / Next Plan) with its own due date, shown as a connected timeline with a status marker per entry. Checking \"Create as Plan automatically\" on a Next Action auto-creates the follow-up entry (linked back to where it came from) once the due date and text are filled in — no more retyping the same reminder as a new entry by hand. Older entries still display fine (Activities → Action Taken, Next Plan → Next Action)" },
  { version: "3.0.126", date: "2026-08-10", note: "Activities Updates cards: the PLANNED pill now sits on the same line as PLAN/AUTO-CREATED instead of its own line below, and a Next Action's due date now sits on the same line as the NEXT ACTION title (right-aligned) instead of its own line below" },
  { version: "3.0.127", date: "2026-08-11", note: "Added Task Tracking to the Home dashboard — every open Activities Updates task (a Plan with no Action Taken yet) across all projects, grouped into Overdue, Due Today, and Due Soon (next 7 days), each clickable straight to its project" },
  { version: "3.0.128", date: "2026-08-11", note: "Activities Updates entries now show a status accent (a colored left border + badge — red \"Overdue N days\", amber \"Due Today\", blue \"Upcoming\", grey \"No Due Date\") instead of changing the whole card background, so a long history doesn't turn into a wall of color. A completed entry (Action Taken filled in) always shows a calm green \"Completed\" badge with no border, regardless of its date — and an old entry's own Next Action due-date stops being highlighted once it's already been auto-chained into a new Planned entry below, so the same task doesn't read as urgent in two places at once" },
  { version: "3.0.129", date: "2026-08-11", note: "Clicking an Activities Updates status badge (Overdue / Due Today / etc.) now opens a popup to update that entry directly — Date, Plan, Action Taken, Next Action, due date, and the auto-create-next-plan checkbox — instead of needing to first switch the whole project into Edit mode" },
  { version: "3.0.130", date: "2026-08-11", note: "Activities Updates: clicking anywhere on the PLAN, ACTION TAKEN, or NEXT ACTION card (not just the status badge) now opens the same update popup" },
  { version: "3.0.131", date: "2026-08-11", note: "Fixed the Recipe Code's Run Number: it's now based on the highest number already used within that Product Type, not a raw count — a raw count could repeat an in-use number once any recipe of that type was deleted" },
  { version: "3.0.132", date: "2026-08-11", note: "Projects now capture packaging spec: Portion Weight (e.g. 30 g), Inner Packing (e.g. 30 g / pack), and Outer Packing (e.g. 24 pack / carton) — each with its own selectable unit — shown in the project's summary and editable in New Project / Edit" },
  { version: "3.0.133", date: "2026-08-11", note: "Recipe Ingredients (section 2) is now entered directly as a tree instead of a table: Total Recipe at the root, each Part underneath it showing its own share of the whole recipe, and each ingredient underneath its Part showing its share of that Part — name/weight/note are still typed in exactly as before, just laid out so the breakdown is visible while you fill it in instead of only in a separate view" },
  { version: "3.0.134", date: "2026-08-11", note: "Renamed the Ingredients tree's root label from \"Total Recipe\" to \"Formula per Portion\"" },
  { version: "3.0.135", date: "2026-08-12", note: "Each ingredient's % of Part field is now editable both ways: type a weight and the % updates, or type a % and the weight is back-calculated automatically (holding every other ingredient in that Part fixed)" },
  { version: "3.0.136", date: "2026-08-12", note: "Recipes: added an explicit Save button. If a recipe has an edit sitting unsaved for 1 minute with no manual Save, it's auto-saved AND a Version History checkpoint is taken automatically, so that auto-save is always revertible. Version History entries can now be Previewed (name, description, ingredients tree, process steps) before deciding whether to Restore. Also: scrolling the mouse wheel over a focused number field no longer changes its value anywhere in the app — only typing does" },
  { version: "3.0.137", date: "2026-08-12", note: "Clicking the recipe's Save button now also drops a Version History checkpoint by itself — no need to separately open Version History and click \"Save Current as Version\" just to have a restore point for what you saved" },
  { version: "3.0.138", date: "2026-08-12", note: "Removed the separate toolbar Save button — the lock banner's own button now does double duty: \"Unlock to Edit\" while read-only, \"Save\" once unlocked. The banner now also colors the whole header row it shares with Versions/Duplicate/Print (red while locked, green once unlocked) instead of just a small pill next to plain white buttons — everything sits together on one colored bar" },
  { version: "3.0.139", date: "2026-08-12", note: "Trimmed \"(will lock again when you switch recipes)\" off the unlocked banner message" },
  { version: "3.0.140", date: "2026-08-12", note: "Each Part's own % of recipe and weight (g) — shown in its header — are now editable the same way an ingredient's % of Part already is: type either one and every ingredient inside that Part scales proportionally to match, keeping their ratios to each other unchanged" },
  { version: "3.0.141", date: "2026-08-12", note: "Parts can now nest inside Parts, to unlimited depth — every Part gets its own \"+ Add Sub-part\" button alongside \"+ Add Ingredient\", so a Part can hold ingredients, further Sub-parts, or both. Every Sub-part has its own editable %/weight (scoped to its immediate parent) and its own Add/Delete controls, same as a top-level Part; Compare Recipes, Print, Recipe Overview, Ingredient Library usage, Trial totals, Version History, and the Process Steps component picker all now see ingredients nested inside Sub-parts too, not just a top-level Part's own direct ones" },
  { version: "3.0.142", date: "2026-08-12", note: "Press-and-hold the grip handle on a Part or an ingredient and drag it onto another Part's title to move it there — a Part becomes a Sub-part of wherever it's dropped, an ingredient moves into that Part's own ingredient list. Dropping a Part onto itself or one of its own Sub-parts is blocked (would nest it inside itself); a Part left completely empty by a move gets the same blank starter row as deleting its last ingredient by hand" },
  { version: "3.0.143", date: "2026-08-12", note: "Typing an ingredient name now shows a custom dropdown of close/similar matches from the Ingredient Library as you type — ranks an exact-start match highest, then anything containing what you typed, then a looser fuzzy match (typos/partial words still find the right ingredient), and searches the Thai name and vendor code too, not just the English name. Replaces the old browser-native suggestion list, which only did a plain substring match and looked different in every browser" },
  { version: "3.0.144", date: "2026-08-12", note: "The lock banner's Unlock/Save button now sits at the banner's right edge, right next to Versions/Duplicate/Print, in both the locked and unlocked states — instead of right after the status text with a big empty gap before the toolbar. Clicking Save now also locks the recipe back to read-only view, the same way finishing an edit and stepping away from it should feel" },
  { version: "3.0.145", date: "2026-08-12", note: "Swapped the order of an ingredient row's Note and %/Weight fields — Note now comes right after the ingredient name, with % and Weight after it" },
  { version: "3.0.146", date: "2026-08-12", note: "Added unit labels (% and g) next to each ingredient's own %-of-Part and Weight fields, matching the \"% of recipe\"/\"g\" labels a Part's own header already shows" },
  { version: "3.0.147", date: "2026-08-12", note: "A Sub-part nested inside a Part now reads like one more row in that Part's list — plain bordered name field and a compact \"%\" label, same as an ingredient row — instead of looking like its own distinct titled section. Top-level Parts keep their existing bold header look" },
  { version: "3.0.148", date: "2026-08-12", note: "A nested Sub-part's own columns (handle, name, note, %, weight, delete) now line up exactly with its sibling ingredient rows' columns — dropped the Sub-part's own card padding (which was shifting everything after it out of alignment) and matched its header's spacing to the ingredient row's" },
  { version: "3.0.149", date: "2026-08-12", note: "Swapped the order of a Sub-part's drag handle and expand/collapse chevron — drag handle now comes first, matching a top-level Part's own header" },
  { version: "3.0.150", date: "2026-08-12", note: "The grip handle on a Part or ingredient can now also reorder items up/down within the same list, not just move them into a different Part — drag it just above or below a neighboring row/header (a highlight line shows before or after) and drop to reorder; dragging onto the middle of a Part's title still moves it inside as a Sub-part like before" },
  { version: "3.0.151", date: "2026-08-12", note: "The recipe tree's total weight (top right, next to \"Formula per Portion\") is now editable — type a new total and every ingredient at every level scales to match proportionally, same as the existing \"Scale Recipe To\" field but directly where the total is already shown" },
  { version: "3.0.152", date: "2026-08-12", note: "Swapped the order of a top-level Part's ingredient count and its %/weight fields — %/weight now comes right after the Part name, with the ingredient count after it, closer to the delete button" },
  { version: "3.0.153", date: "2026-08-12", note: "Moved the \"+ Add Part\" button inside the ingredient tree's own box, right after the Parts list — instead of sitting as a separate button below/outside it, matching how \"+ Add Ingredient\" / \"+ Add Sub-part\" already sit inside each Part's own box" },
  { version: "3.0.154", date: "2026-08-12", note: "The \"Confirm Identity to Edit\" password prompt now shows a small TH/EN badge next to the Password label that updates as you type — since the field is masked, this is the only way to notice you're typing on the wrong keyboard language before getting \"Incorrect password\"" },
  { version: "3.0.155", date: "2026-08-12", note: "That TH/EN badge now shows a \"?\" placeholder (with a tooltip explaining why) before you start typing, instead of sitting blank — browsers don't expose the keyboard's current language to a web page until an actual character is typed, so the badge still can't detect it before that first keystroke, but at least it no longer looks empty/broken while waiting" },
  { version: "3.0.156", date: "2026-08-12", note: "Fixed the TH/EN badge not updating when switching keyboard language partway through typing the password — it was reading the typed character off the browser's input-event data, which isn't reliably filled in for password fields; it now reads straight from the field's own value instead, which always reflects what was actually typed" },
  { version: "3.0.157", date: "2026-08-12", note: "Removed the TH/EN keyboard-language badge from the \"Confirm Identity to Edit\" password prompt and replaced it with an eye button inside the field — click it to reveal the password as plain text and read it back before submitting, instead of guessing from a language indicator" },
  { version: "3.0.158", date: "2026-08-12", note: "Each Process's \"Select a part or ingredient to add\" is now a checklist you can tick multiple items in before clicking \"+ Add\" once to add them all as Components together, instead of only being able to pick and add one at a time" },
  { version: "3.0.159", date: "2026-08-12", note: "Fixed Printing/PDF showing the live editable Ingredients tree (input boxes, +Add buttons, delete X's, and the connector lines running through them) instead of a clean read-only version — section 2 never had a print-only view like sections 1 and 3 already did, so it printed exactly as it looks on screen while editing. Printing now shows a plain label/%/weight tree, same style as Version History's preview" },
  { version: "3.0.160", date: "2026-08-12", note: "The read-only Ingredients tree (Printing/PDF and Version Preview) is now a compact table — a Component / % / g header with % and g sitting right next to each other as two tight columns, and indentation standing in for the on-screen tree's connector lines — instead of the roomier card-style layout with \"% of Part\"/\"% of recipe\" repeated on every row" },
  { version: "3.0.161", date: "2026-08-12", note: "Fixed each ingredient's Note never showing up when printing (or in Version Preview) — the read-only Ingredients tree never had a Note column at all, on-screen table or the new compact one, so a typed-in note silently disappeared the moment you left Edit mode. Added a Note column right after the name, same position as the live editable row" },
  { version: "3.0.162", date: "2026-08-12", note: "The compact read-only Ingredients table (Printing/PDF and Version Preview) now draws proper tree connector lines (├─ └─ │) in front of each name instead of plain indentation, so the branching is still visible at a glance — a vertical line only continues past a branch if that branch actually has more items below it, so it never dangles past where a Part's contents really end" },
  { version: "3.0.163", date: "2026-08-12", note: "Recipe Overview (all parts combined) is now its own section 2, moved out from the bottom of the Ingredients tree card to right after Product Details — Ingredients, Percentage & Weight is now section 3, and Process Steps is now section 4" },
  { version: "3.0.164", date: "2026-08-12", note: "Renamed section 3 from \"Ingredients, Percentage & Weight\" to \"Components and Process\"" },
  { version: "3.0.165", date: "2026-08-12", note: "Added a Flowchart view to Process Steps (toggle next to the section 4 title, alongside the existing numbered-steps List view) — a freeform canvas where you can add labeled step nodes (A, B, C...), drag them anywhere, and draw arrows between them to show a main flow with side branches merging in. Each ingredient can now optionally link to one of these nodes (a small \"→A\" dropdown at the end of its row, only shown once the recipe has at least one flowchart node) — that link shows up both there and as a new Node column in the printed/Version Preview Ingredients table. The flowchart itself also prints/previews as a static read-only diagram matching whichever view is currently selected" },
  { version: "3.0.166", date: "2026-08-12", note: "A Flowchart node can now be linked directly to a Process from the List view (a \"Link\" dropdown on the node) — its text then stays live-synced to that Process's title and steps instead of being typed separately, so editing the List always shows up in the Flowchart automatically. Deleting a linked Process detaches the node instead of losing its content — it freezes as an ordinary free-typed node with whatever text was last shown" },
  { version: "3.0.167", date: "2026-08-12", note: "\"+ Add Process\" now creates just the process heading, with no automatic blank step underneath — click \"+ Add Step\" when you're ready to add one. Deleting a Process's last remaining step also no longer re-adds an empty one; a Process with just a title (no steps yet) is now a valid, normal state instead of always needing at least one" },
  { version: "3.0.168", date: "2026-08-12", note: "Section 3 (\"Components and Process\") is now a two-column layout, matching the classic Ingredient/Process spreadsheet format — the ingredient tree on the left, and a simple live preview of the Process List (title, then each step stacked with a ↓ arrow between them) on the right. Read-only — editing still happens in section 4's List or Flowchart view, this just mirrors it as you work on ingredients" },
  { version: "3.0.169", date: "2026-08-12", note: "Fixed ingredient rows wrapping onto two lines in section 3's new narrower half-width ingredient column — Name/Note/%/Weight now fit on one line by tightening the row's column widths, gaps, and input padding instead of the wider spacing tuned for the old full-width layout" },
  { version: "3.0.170", date: "2026-08-17", note: "Projects now capture Flavor / Filling (e.g. \"Red bean paste\") — a new field between Factory and Portion Weight in New Project, Edit, and the read-only project summary" },
  { version: "3.0.171", date: "2026-08-17", note: "Added a Translate button to each Plan / Action Taken / Next Action field in Activities Updates (both adding a new entry and editing an existing one) — click it to auto-detect Thai or English and append the translation as a new line, using a free translation service (no account or API key needed)" },
  { version: "3.0.172", date: "2026-08-17", note: "Projects now capture Target Price, Actual Price (both ฿), and MOQ (quantity + unit) — new fields between Outer Packing and Requirements / Certifications in New Project, Edit, and the read-only project summary" },
  { version: "3.0.173", date: "2026-08-17", note: "Flavor / Filling is now a list instead of one free-text field — add as many flavors as a project needs, each with its own Target Price and Actual Price (e.g. a mochi assortment can price Red bean, Matcha, and Sweet Potato separately). Replaces the single project-wide Target/Actual Price fields, which moved out of New Project (flavors are added after creating the project, same as Products) and now live in this same list in Edit and the read-only summary" },
  { version: "3.0.174", date: "2026-08-17", note: "Renamed the Reference Lists tab \"Sales Reps\" to \"Project Owner\"" },
  { version: "3.0.175", date: "2026-08-17", note: "Each Flavor / Filling's Target/Actual Price now has its own selectable Currency (THB/JPY/USD/CNY/EUR) and Per-unit basis (pcs/kg/pack/carton/case/box) instead of always being ฿ — shown as e.g. \"150 JPY / pcs\" in the read-only summary" },
  { version: "3.0.176", date: "2026-08-17", note: "Added \"pcs\" as a selectable unit for Portion Weight (and Inner Packing's own weight field, which shares the same unit list) — a portion isn't always best measured by weight; e.g. a 3-piece dessert set can now be entered as \"3 pcs\" instead of only g/kg/ml/L/oz/lb" },
  { version: "3.0.177", date: "2026-08-17", note: "Moved a project's Save/Duplicate/Cancel buttons out of the cramped summary row and into their own toolbar right above the detail form itself, once you're editing it" },
  { version: "3.0.178", date: "2026-08-17", note: "Fixed the Flavor / Filling table (and the fields around it) pushing past the edge of the project's edit panel instead of staying within it — the table now scrolls horizontally within its own boundary if it doesn't fit, instead of forcing the whole form wider" },
  { version: "3.0.179", date: "2026-08-17", note: "Portion Weight now has a \"per unit\" selector too (e.g. \"20 g / pcs\"), matching Inner/Outer Packing's own value-per-container style, instead of only being a bare weight. Also added Formula / Reference No. — a new field next to Project Name in New Project, Edit, and the read-only project summary" },
  { version: "3.0.180", date: "2026-08-17", note: "The Save/Duplicate/Cancel toolbar above a project's detail form is now right-aligned instead of flush left" },
  { version: "3.0.181", date: "2026-08-17", note: "Fixed the Flavor / Filling table's rows overlapping/stacking on top of each other — switched it to a fixed table layout with explicit column widths instead of letting the browser recalculate column sizing from every cell's content (inputs, multi-option selects), which is a much more predictable, deterministic way to lay out a row of form controls" },
  { version: "3.0.182", date: "2026-08-17", note: "Added a \"Units\" tab to Reference Lists — every unit dropdown that used to be a fixed list (Portion Weight, Inner/Outer Packing, MOQ, Flavor Per-unit, in both New Project and Edit) now types in from this same shared, editable list instead, so a unit that isn't offered yet can just be added once in Reference Lists instead of being stuck. Seeded automatically with the same units these fields already offered (g, kg, ml, L, oz, lb, pcs, pack, bag, box, sachet, pouch, tray, carton, case) so nothing changes until you add more" },
  { version: "3.0.183", date: "2026-08-17", note: "Found the real cause of the Flavor / Filling table's header floating over the wrong row (and a row appearing to go missing in Preview) — the projects list's own sticky-header styling was leaking onto this nested table's header too, since it's just a descendant CSS selector that doesn't stop at table boundaries, pinning it to a fixed scroll position instead of letting it sit above row one. The v3.0.181 table-layout change stays (it's a genuine improvement), but this is the fix that actually resolves the floating/overlapping header" },
  { version: "3.0.184", date: "2026-08-17", note: "Added a Project Timeline (Gantt chart) to the Projects dashboard — one horizontal bar per project running from its new Start Date to Target/End Date, colored by status, with month gridlines and a today marker. Projects now capture Start Date and Target/End Date (next to Request Date, in New Project, Edit, and the read-only project summary); a project only appears on the chart once both are filled in. Click a bar or its label to jump to that project below" },
  { version: "3.0.185", date: "2026-08-17", note: "Task Tracking on the Home dashboard now shows each task's project photo as a small thumbnail in front of it (a plain folder icon when the project has no photo), matching the Active Projects table's use of project photos elsewhere" },
  { version: "3.0.186", date: "2026-08-17", note: "Projects table now has 3 more filters next to Status — Owner, Factory Rep, and PD — so you can narrow the list down to only the projects a specific person handles (e.g. \"which projects is Bas the owner of\"). Each dropdown only lists names currently assigned to at least one project" },
  { version: "3.0.187", date: "2026-08-17", note: "\"Projects by Status\" on the Projects dashboard is now clickable — click any status row (e.g. \"In Progress\") to filter the table below to just that status, same as picking it from the Status dropdown, and jump straight down to it" },
  { version: "3.0.188", date: "2026-08-17", note: "Moved the Project Photos gallery — it no longer sits as its own strip above \"Projects by Status\"; each status's photos now show directly above that status's own bar inside the card instead, so the photos and the numbers they belong to stay together" },
  { version: "3.0.189", date: "2026-08-17", note: "Added a \"Columns\" picker to the Projects table — click it to show/hide Photo, Status, Requested, Customer, Destination, Owner, Factory Rep, PD, Factory, Reqs, or Products, so you can focus on just what you need. Your choice is remembered on this device for next time" },
  { version: "3.0.190", date: "2026-08-17", note: "Replaced the Status/Owner/Factory Rep/PD dropdowns above the Projects table with Excel-style filters right on each sortable column header — click the ▾ next to a column name (Project, Status, Requested, Customer, Destination, Owner, Factory Rep, PD, Factory, or Products) to check/uncheck exactly which values to show, instead of picking one value at a time" },
  { version: "3.0.191", date: "2026-08-17", note: "If you're editing a project's details (or filling in \"+ New Project\") and haven't clicked Save yet, navigating away — a navbar tab, the logo, a recipe in the sidebar, \"+ New Recipe\", or closing/refreshing the tab — now asks first: Save, Discard, or Cancel and stay, instead of silently losing what you typed" },
  { version: "3.0.192", date: "2026-08-17", note: "\"Projects by Status\" on the Projects dashboard now spans the full width of the screen instead of sharing a row with \"Products by stage\" — its photo strips had made it far taller than that card, so squeezing them side by side just left \"Products by stage\" with a big empty gap stretched to match. \"Products by stage\" now sits in its own full-width row right below it" },
  { version: "3.0.193", date: "2026-08-17", note: "Renamed the Reference Lists tab \"Project Owner\" to \"Contact Directory\" — the same shared list of names is also used for Factory Sales Rep, so \"Project Owner\" was a bit misleading as the list's own name. The Project Owner field itself (on projects and Trial Results) is unchanged, still called Project Owner" },
  { version: "3.0.194", date: "2026-08-17", note: "Contact Directory now stores real contact records, not just a name — Contact Type, Company/Organization, Country/Location, Job Title, Department, Email, and Phone Number, on top of Full Name and the usual Added/Edited by tracking. The list itself stays compact: each row shows Name — Position — Company — Contact Type — Email/Phone, with the full set of fields editable from Edit" },
  { version: "3.0.195", date: "2026-08-17", note: "Moved Formula / Reference No. off the project's header fields and down into the Flavor / Filling table as its own column, since each flavor is really its own recipe with its own code — a project with several flavors no longer has to share one Formula No. between them. Also added a Note column to the same table" },
  { version: "3.0.196", date: "2026-08-17", note: "Renamed the Reference Lists tab \"Customers\" to \"Company Directory\"" },
  { version: "3.0.197", date: "2026-08-17", note: "Contact Directory's Company / Organization field now suggests from Company Directory as you type, instead of being free-typed — same shared-list pattern used everywhere else in Forge, so a contact's company matches a real, curated entry instead of drifting into typos/duplicates" },
  { version: "3.0.198", date: "2026-08-17", note: "Company Directory entries can now have a photo/logo — upload one when adding a new company, or add/change/remove it from Edit on an existing one. Shown as a small circle next to the company's name and country flag" },
  { version: "3.0.199", date: "2026-08-17", note: "Contact Directory's Country / Location now auto-fills from the selected Company / Organization's own country on file (same auto-fill Projects already does for Customer -> Destination) — it's just a starting value, not locked, so it can still be hand-edited afterward if a contact's own location differs" },
  { version: "3.0.200", date: "2026-08-17", note: "Added account management: new sign-ups now wait for kangawin@th-umios.com to approve them (a \"Manage Users\" panel lists pending requests plus everyone's status) before they can sign in, and \"Forgot password?\" on the login screen (or \"Send Reset Email\" from the admin panel) emails a reset link so a locked-out member can set a new password themselves — this app talks to Firebase straight from the browser with no backend, so an admin can't set someone's password directly, only trigger that email" },
  { version: "3.0.201", date: "2026-08-17", note: "Company Directory: a company's photo now takes priority over its country flag in the leading circle (previously both showed at once) — the flag only steps back in as a fallback for a company that has no photo yet. Also fixed uploaded PNGs with a transparent background turning black once resized — they get a white background instead now, same as everywhere else in Forge a photo gets resized (Projects, Trials, Ingredients, Recipes)" },
  { version: "3.0.202", date: "2026-08-17", note: "Reorganized the account menu: Export All (JSON) / Import (JSON) moved out into a new \"Data Management\" page (they're whole-system data actions, not personal account ones). Added \"My Profile\" (set a display name + photo, shown in the navbar instead of your email's initials) and \"Security\" (change your own password — self-service, no admin needed) — \"Manage Users\" stays admin-only, still last before Log Out" },
  { version: "3.0.203", date: "2026-08-17", note: "Removed the \"Factories\" Reference List — a project's Factory field now suggests from Company Directory instead, same list Contact Directory's Company/Organization field already uses. Existing Factories entries aren't lost (still in the database, just no longer shown here); add them into Company Directory if you'd like them back as suggestions" },
  { version: "3.0.204", date: "2026-08-17", note: "The bell icon is now \"Notifications\", not just sign-ins — it shows who added, edited, or deleted a Recipe, Project, Trial, or Ingredient, merged into the same feed as sign-ins. An edit only counts once per Save (not per autosave tick while typing), so the feed stays readable instead of filling up with every keystroke" },
  { version: "3.0.205", date: "2026-08-17", note: "Added an \"Export Excel\" button to a recipe's toolbar (next to Print / PDF) — downloads a 3-sheet .xlsx workbook: Overview (product/project details), Ingredients (every Part and Sub-part's ingredients with %, weight, and note), and Process (each process's steps in order)" },
  { version: "3.0.206", date: "2026-08-17", note: "Reordered each Notifications line so the item's name leads and who did it follows — e.g. \"Project \\\"Takoyaki & Yakisoba\\\" edited by kangawin@th-umios.com\" instead of starting with the email" },
  { version: "3.0.207", date: "2026-08-17", note: "\"Projects by Status\" now shows every project in each status, not just the ones with a photo uploaded — a project without one gets a plain placeholder circle instead of being left out of the strip" },
  { version: "3.0.208", date: "2026-08-19", note: "Notifications: \"edited by ...\" now sits on its own line in smaller text below the item's name, instead of being crammed into the same bold line" },
  { version: "3.0.209", date: "2026-08-19", note: "Click a Notifications item for a Recipe, Project, Trial, or Ingredient edit to see exactly what changed — each main field that was different shows its value before and after, e.g. \"Status: Not Started → In Progress\"" },
  { version: "3.0.210", date: "2026-08-19", note: "\"Projects by Status\" — the status name above each photo strip (e.g. \"Not Started\") is now bold, and the status-colored ring around each project's photo is thicker and glows more clearly" },
  { version: "3.0.211", date: "2026-08-19", note: "Activities Updates entries (add, edit, and the update popup) can now link to a recipe and attach files or photos — a linked recipe shows as a clickable chip that jumps straight to it, and attachments show as small thumbnails/file chips, clickable to open or download" },
  { version: "3.0.212", date: "2026-08-19", note: "An Activities Updates entry with no Next Action recorded no longer shows an empty \"Add after recording Action taken\" placeholder card — the card is left out entirely, and PLAN / ACTION TAKEN share the row instead" },
  { version: "3.0.213", date: "2026-08-19", note: "Clicking an Activities Updates attachment now opens a Preview popup instead of downloading it straight away — photos and PDFs show inline, other file types show a Download button, and Prev/Next cycles through every attachment on that entry" },
  { version: "3.0.214", date: "2026-08-19", note: "A project's summary now has an \"Attachments\" section (below Requirements / Certifications) listing every file attached across all of its Activities Updates in one place, newest first — no need to open each update to find one. Only shown once the project has at least one attachment" },
  { version: "3.0.215", date: "2026-08-19", note: "Manage Users: the admin can now turn Projects / Trials / Ingredients / Reference Lists on or off per person — a member without access to a module simply doesn't see its tab in the navbar. Only kangawin@th-umios.com (the one admin) can set this, same as everything else in Manage Users. Recipes itself always stays on for every approved member — it's the app's core function" },
  { version: "3.0.216", date: "2026-08-19", note: "Clicking a Task Tracking item on the Home dashboard now jumps straight to that project's Activities Updates section instead of landing at the top of the project" },
  { version: "3.0.217", date: "2026-08-19", note: "Added the Translate button to the \"Update Activity\" popup's Plan / Action Taken / Next Action fields — it already existed in the inline Add/Edit forms, just missing from this popup" },
  { version: "3.0.218", date: "2026-08-19", note: "Task Tracking on the Home dashboard now groups items under a date heading (e.g. \"21 Aug 2026\") instead of repeating the same date on every row — each item's line now just shows the project it belongs to" },
  { version: "3.0.219", date: "2026-08-19", note: "Overdue date headings in Task Tracking now show how many days overdue in parentheses, e.g. \"11 Aug 2026 (-8 Days)\" — at a glance instead of having to work it out from today's date" },
  { version: "3.0.220", date: "2026-08-19", note: "Fixed Activities Updates never showing up in Notifications — adding or editing an entry (from \"+ Add Update\", the inline Edit form, or the \"Update Activity\" popup) now logs a notification too, same before/after diff view as everything else, instead of only the project's own header fields being tracked" },
  { version: "3.0.221", date: "2026-08-19", note: "Task Tracking's Due Today column now always shows today's date, even with nothing due, and a new \"Completed Today\" list right below it surfaces anything due today that's already been logged (Action Taken filled in) — previously logged entries never showed up on this dashboard at all" },
  { version: "3.0.222", date: "2026-08-19", note: "Activities Updates entries now have a \"Completed Date\" — auto-filled with today the first time Action Taken is filled in, but editable, so logging an update today for something actually finished yesterday can say so. \"Completed Today\" on the Home dashboard now goes by this date instead of the entry's own due date" },
  { version: "3.0.223", date: "2026-08-19", note: "Trial Results reworked to match a formal product test report: new Product Name / Customer / Sample Prepared By / Test Participants / Test Date / Cooking Method fields, Before/After frying photos per product (instead of 3 shared photos per trial), a fixed Sensory Evaluation table (Appearance Exterior/Interior, Odor, Taste, Texture, Test Result — colored green/red for Accepted/Not accepted) replacing the old freeform criteria list, and a new Improvement Guidelines table" },
  { version: "3.0.224", date: "2026-08-19", note: "Renamed \"Trials\" / \"Trial Results\" to \"Test Results\" everywhere it's shown — the navbar tab, page title, buttons, empty states, confirm dialogs, notifications, and the Manage Users module-access list" },
  { version: "3.0.225", date: "2026-08-19", note: "Added an Activities Calendar to the Home dashboard — a Month view (Today / ‹ › navigation) showing every Activities Update on its due date across all projects, colored the same way the update's own card already is (red overdue, amber due today, blue upcoming, green completed). Click an entry to jump straight to that project's Activities Updates" },
  { version: "3.0.226", date: "2026-08-19", note: "Fixed \"Trial evaluation score, last 6 months\" on the Home dashboard going stale for any Test Result created after the v3.0.223 report rework — it read the old free-text \"8/9\"-style score, which the new fixed Accepted/Not accepted field never fills in. Now shows Test acceptance rate instead (% Accepted), still falling back to the old score for trials from before that change" },
  { version: "3.0.227", date: "2026-08-19", note: "Test Results: \"Product Name\" is now a dropdown of Projects instead of free-typed text, and \"Customer\" is filled in automatically from the picked project instead of being typed separately" },
  { version: "3.0.228", date: "2026-08-19", note: "Fixed the Activities Calendar pushing past the edge of the screen when an entry's text was long — it now truncates to fit its day cell, and hovering over it shows the full project name and text in a small popup instead" },
  { version: "3.0.229", date: "2026-08-19", note: "Completed Today (Home dashboard's Task Tracking) now shows Plan and Done as two lines — what was asked for, then what actually got done — instead of just the end result on its own with no context for what it was answering" },
  { version: "3.0.230", date: "2026-08-19", note: "Activities Updates' Plan is now 5 fields instead of one — When (date + time), Who (from Contact Directory), What, Where (from Company Directory or typed), and How — in the Update Activity popup and both inline Add/Edit forms. Task Tracking and the Calendar now show a combined \"time · who · @ where · what\" line instead of just the old plan text" },
  { version: "3.0.231", date: "2026-08-19", note: "Test Results header reworked: \"Product Name\" is now \"Project Name\", it and Customer now span the full width of their own row instead of sharing a cramped 4-up row; Sample Prepared By and Test Date moved to a second row below. Sample Prepared By and each Test Participant now suggest from Contact Directory instead of being free-typed. Added a new \"Cooking Method\" Reference List tab, and Test Results' Cooking Method steps now suggest from it" },
  { version: "3.0.232", date: "2026-08-19", note: "Company Directory entries can now list Locations (e.g. Office, Kitchen, Factory 1, Factory 2) — add/remove as many as needed from Edit, shown as small tags on the company's card" },
  { version: "3.0.233", date: "2026-08-19", note: "The \"Update Activity\" popup now groups When/Who/What/Where/How inside one bordered \"Plan\" box, instead of reading as more of the same flat list as Action Taken/Next Action below it" },
  { version: "3.0.234", date: "2026-08-19", note: "Action Taken + Completed Date, and Next Action + Next Action Due Date, now each get their own bordered box too, matching the Plan box above them, instead of sitting as plain unboxed fields" },
  { version: "3.0.235", date: "2026-08-19", note: "Activities Updates' Where field now follows up with a location picker when the typed/picked company has Locations on file (see Company Directory's Locations) — choosing one appends it in parentheses, e.g. \"UMIOS ASIA OCEANIA CO., LTD. (Kitchen)\"" },
  { version: "3.0.236", date: "2026-08-19", note: "Fixed the combined Plan summary line (Task Tracking, Calendar) putting What after Where — a long company name in Where was pushing What off the end entirely once truncated. What now comes first" },
  { version: "3.0.237", date: "2026-08-19", note: "PLAN card detail: dropped the \"Who:\" label (just shows the name), and \"Where:\" is now \"@\" — matches how the field already reads in the combined summary line elsewhere" },
  { version: "3.0.238", date: "2026-08-19", note: "PLAN card detail: How now sits on its own line below @ Where, instead of sharing the same line separated by a dot" },
  { version: "3.0.239", date: "2026-08-19", note: "Next Action now has the same 5 fields and layout as Plan — When (date + time), Who (from Contact Directory), What, Where (from Company Directory or typed, with the location picker), and How — in the Update Activity popup and both inline Add/Edit forms, plus the same detail-line styling on the NEXT ACTION card" },
  { version: "3.0.240", date: "2026-08-19", note: "Clicking the PLAN / ACTION TAKEN / NEXT ACTION card on an Activities Update now scrolls the Update Activity popup straight to that section, instead of always opening at the top" },
  { version: "3.0.241", date: "2026-08-20", note: "Task Tracking on the Home dashboard can now be filtered by Who — a \"Who ▾\" button opens a checklist to pick more than one person at once — narrows Overdue, Due Today, Due Soon, and Completed Today all at once, with a Clear filter button to reset" },
  { version: "3.0.242", date: "2026-08-20", note: "Switching pages (Home, Recipes, Projects, Test Results, Ingredients, Reference Lists, Compare, a recipe) and the Home dashboard's own data refreshes (Task Tracking filters, Calendar month paging) now ease in with a short fade instead of snapping into place instantly" },
  { version: "3.0.243", date: "2026-08-27", note: "Pending Submissions now has a History tab alongside Pending, showing past Import/Reject/Delete decisions on submissions (who, what, when) — reuses the same activity log that already powers the notification bell" },
  { version: "3.0.244", date: "2026-08-27", note: "The public Share Link submission form (and its team review form) now includes the Product table — was previously left out of the public form, and the review form needed it too, since saving a review edit was silently wiping any products a submitter had entered" },
  { version: "3.0.245", date: "2026-08-27", note: "Cooking Guidelines can now list multiple groups per project (e.g. both Stove Top and Microwave, each with its own steps) — a \"+ Add Cooking Guidelines\" button on the New Project panel, Edit Project, and the Pending Submission review form. The public Share Link form still only supports one group" },
  { version: "3.0.246", date: "2026-08-27", note: "The Unassigned bucket project (used by the Calendar's quick-add) no longer shows a Delete button — deleting it would silently break quick-add until a fresh one gets recreated" },
  { version: "3.0.247", date: "2026-08-27", note: "The \"Update Activity\" popup's Project picker (for moving an entry off the Unassigned bucket) is now a searchable text field instead of a long dropdown to scroll" },
  { version: "3.0.248", date: "2026-08-27", note: "Projects list: everyone (admin included) now defaults to seeing only their own PD-assigned/name-matched projects, with a new \"Who\" filter button to add specific people's projects on top — replaces the old My Projects/All Projects toggle. Admin's Who instead narrows down from everyone to just the people picked, with a Select All option and an \"Unassigned\" entry for projects with no PD set" },
  { version: "3.0.249", date: "2026-08-27", note: "New Project/Edit Project's Idea/Reference Image captions now default to the uploaded file's own name (extension stripped) instead of a generic \"Idea / Ref. Photo\" label — still editable afterward" },
  { version: "3.0.250", date: "2026-08-27", note: "Recipes: removed the Process preview column next to the ingredient formula table (section 3) for now — it left too little room to type the formula. Editing Process itself is unaffected, still further down in its own section" },
  { version: "3.0.251", date: "2026-08-27", note: "Fixed the recipe editor's Save button never locking a recipe back to read-only after saving (and autosave not actually reaching the cloud) — a JS error was silently aborting every save attempt" },
  { version: "3.0.252", date: "2026-08-27", note: "Recipes: swapped the order of the Formula table and the Total Recipe Weight/Scale/Yield summary box in section 3 — Formula now comes first" },
  { version: "3.0.253", date: "2026-08-27", note: "Recipes: the linked project's info line (Customer/Destination/etc.) now also shows Factory Sales Rep and PD" },
  { version: "3.0.254", date: "2026-08-27", note: "Recipes: weight (g) now comes before % everywhere in section 3's formula tree — the recipe root row, each Part's header, and every ingredient row" },
  { version: "3.0.255", date: "2026-08-27", note: "Recipe Overview (section 2) now has a Cost (฿) column per ingredient, using each linked Ingredient Library entry's Price/kg, plus a total cost and cost per 100g in the footer row — ingredients with no price on file show as missing rather than being silently costed at zero" },
  { version: "3.0.256", date: "2026-08-27", note: "Recipe Overview: added a legend explaining the \"*\" partial-cost marker (matching Compare's own Costing legend), a new Amount per Serving (g) field, and Cost / 100g, Cost / kg, and (once a serving size is entered) Cost / Serving figures below the table, in place of the small per-100g note that used to sit inside the Total cell" },
  { version: "3.0.257", date: "2026-08-27", note: "Recipe Overview's cost stats reordered: Amount per Serving, Cost / Serving, Cost / 100g, Cost / kg" },
  { version: "3.0.258", date: "2026-08-27", note: "Recipe Overview: added Factory and Company Selling Price (per serving) — set a Min%/Max% margin for each and it shows a Min-Max price range, Factory marked up from Cost/Serving and Company marked up on top of the Factory price" },
  { version: "3.0.259", date: "2026-08-27", note: "Fixed Test Results crashing whenever a Test Result was linked to a project — a leftover reference to the old single Cooking Guidelines shape broke every render since multi-group support shipped (3.0.245)" },
  { version: "3.0.260", date: "2026-08-27", note: "A recipe's linked-project summary (section 1) now also shows the whole Requirements box from that project — Portion/Inner/Outer Packing, MOQ, Storage Condition, Shelf Life, Certificate, Packaging Condition, Composition, Recipe notes, every Cooking Guidelines group, and Note" },
  { version: "3.0.261", date: "2026-08-27", note: "Fixed Factory/Company Margin on Recipe Overview — they were calculated as a markup on cost (Price = Cost × (1 + %)); now correctly gross margin, profit as a % of the selling price (Price = Cost ÷ (1 − %)), matching how margin is normally meant" },
  { version: "3.0.262", date: "2026-08-27", note: "Recipe Overview: added a third pricing tier, Customer Margin and Customer Selling Price / Serving, cascading on top of the Company Selling Price the same way Company cascades on top of Factory" },
  { version: "3.0.263", date: "2026-08-27", note: "Factory/Company/Customer Selling Price now round up to the nearest whole Baht for a clean asking price (e.g. ฿14.99 shows as ฿15) — the Cost figures above them are unaffected, still exact" },
  { version: "3.0.264", date: "2026-08-27", note: "Factory/Company/Customer Selling Price now round up to the nearest ฿0.05 instead of the nearest whole Baht, showing two decimal places again (e.g. ฿9.07 shows as ฿9.10)" },
  { version: "3.0.265", date: "2026-08-27", note: "Factory/Company/Customer Margin on Recipe Overview switched back to markup on the tier before them (Selling Price = Base × (1 + %), e.g. 50% = ×1.5, 100% = ×2) instead of gross margin — and added an Overhead Multiplier field, a fixed × applied to Cost/Serving before Factory Margin" },
  { version: "3.0.266", date: "2026-08-27", note: "Recipe Overview: Overhead Multiplier now defaults to 1.625 (the reference Overhead value at 25%) on new recipes, and each Margin field now sits directly before its own matching Selling Price (Factory Margin → Factory Selling Price, etc.) instead of one column of margins next to a column of prices that didn't line up by tier" },
  { version: "3.0.267", date: "2026-08-27", note: "Recipe Overview: added a Currency picker (THB/USD/JPY/CNY/EUR) with a manually entered Exchange Rate and Rate Date — picking a currency other than THB converts every Cost and Selling Price figure in the section using that rate; nothing converts until a rate is entered, since this app has no live exchange-rate feed" },
  { version: "3.0.268", date: "2026-08-27", note: "Fixed every dropdown in the recipe editor (Currency, Linked Project, Product Type, and the two Process Flowchart link pickers) staying clickable on a read-only/locked recipe — the lock only ever disabled inputs/textareas/buttons, never <select> elements" },
  { version: "3.0.269", date: "2026-08-28", note: "Recipe editor's linked-project summary: PD/Factory/Stage now sit on their own line below Customer/Destination/Project Owner/Factory Sales Rep, instead of one long line that could wrap mid-field" },
  { version: "3.0.270", date: "2026-08-28", note: "Recipe Overview: merged the Overhead Multiplier's tooltip note into the main cost/pricing note and moved that note to below the whole Currency/Cost/Margin block, instead of splitting it between a note above the block and a separate hint mid-block" },
  { version: "3.0.271", date: "2026-08-28", note: "Recipe editor's linked-project Requirements box now includes the Product table (Sample Qty, Sample Request Date, Target/Actual Price, Formula/Reference No., Note) — it was missing even though the Project's own Requirements view has always shown it" },
  { version: "3.0.272", date: "2026-08-28", note: "Fixed the Product table added above breaking the Requirements box layout — it was squeezed into a single narrow auto-fit grid column alongside Portion Weight/Storage Condition instead of spanning the full width, causing overlap and severely wrapped text" },
  { version: "3.0.273", date: "2026-08-28", note: "Recipe editor: moved Recipe Code up next to Project (was paired with Description/Concept further down) so it sits beside the field it's most related to" },
  { version: "3.0.274", date: "2026-08-28", note: "Recipe editor: swapped Product Type into the row next to Recipe Code, and moved Project down to its own line below (with the linked-project info panel still following right after it)" },
  { version: "3.0.275", date: "2026-08-28", note: "Print / PDF: the empty red/green status bar above \"1. Product Details\" no longer prints — its lock-status message and toolbar buttons were already hidden, but the colored bar wrapping them wasn't. Also, the printed Product Details now include Product Type and, if linked, the Project name plus its full info panel (Customer/Destination/.../Requirements incl. the Product table) — previously it only showed Code, Date, Total weight, and Description" },
  { version: "3.0.276", date: "2026-08-28", note: "Removed the borders from the Recipe Code segments (year, product type, sequence, trial number) — kept the grey background and grouping, just without the boxed-in outline" },
  { version: "3.0.277", date: "2026-08-28", note: "Fixed an ingredient row's hint text (vendor Code, or the \"not in the library\" warning) floating out over the drag-handle column instead of lining up under the ingredient name — it's a sibling of the row, not a child of the name field, so it needed its own left offset to match" },
  { version: "3.0.278", date: "2026-08-28", note: "Ingredient Library: removed the boxed ฿/kg badges from Price/kg and MOQ/kg (the field labels already say the unit). Also added an optional Sub Ingredients table to each ingredient — English Name, Thai Name, Size, Size Unit, % Yield, with Add/Copy/Delete per row — shown in both the add/edit form and the read-only detail view" },
  { version: "3.0.279", date: "2026-08-28", note: "Recipe Overview: relabeled Cost / Serving, Cost / 100 g, and Cost / kg to Cost RM / Serving, Cost RM / 100 g, and Cost RM / kg" },
  { version: "3.0.280", date: "2026-08-28", note: "Recipe Overview's ingredient table is now sortable — click Ingredient, % of Recipe, Total Weight, or Cost to sort by that column, click again to reverse; same click-to-sort interaction as the Projects table" },
  { version: "3.0.281", date: "2026-08-28", note: "Ingredient Library's Sub Ingredients table: replaced English Name/Thai Name with a single Type column, renamed Size Unit to Unit, and added a Cooking column (preparation method/steps) — now Type / Size / Unit / Cooking / % Yield" },
  { version: "3.0.282", date: "2026-08-28", note: "Sub Ingredients table: Type's example placeholder changed to \"Dice\", and Unit / Cooking now offer a dropdown of suggestions from the Units / Cooking Method reference lists (still free text if what's needed isn't in the list, same as every other reference-list field in the app)" },
  { version: "3.0.283", date: "2026-08-28", note: "Recipe Formula tree: an ingredient row now shows a \"Sub Ingredients (N)\" toggle when its matched Ingredient Library entry has any on file — click to reveal that entry's Type/Size/Unit/Cooking/%Yield breakdown for reference, read-only, without leaving the recipe" },
  { version: "3.0.284", date: "2026-08-28", note: "Recipe Formula tree's Sub Ingredients panel is now a picker, not just a reference table — click a variant (e.g. \"Dice · 2-3 mm · Blanch\") to fill that row's Note field with it, still editable afterward" },
  { version: "3.0.285", date: "2026-08-28", note: "Sub Ingredients panel now collapses back automatically right after picking a variant, instead of staying expanded" },
  { version: "3.0.286", date: "2026-08-28", note: "Fixed the Sub Ingredients table's Size field silently discarding anything that wasn't a plain number — a number input can't hold a range like \"2-3\", so it just went blank. Changed to plain text, since sizes are commonly given as a range (e.g. \"2-3 mm\")" },
  { version: "3.0.287", date: "2026-08-28", note: "Print/PDF: \"3. Components and Process\" now shows the recipe formula on the left and a compact Process Flow (step titles connected by arrows, top to bottom) on the right, side by side — the full step detail still prints separately on its own \"4. Process Steps\" page further down" },
  { version: "3.0.288", date: "2026-08-28", note: "Print/PDF redesign: the ingredient table now highlights each Part/Sub-part as a bold total row, shows \"–\" for an empty Prep/Note, and ends with a bold Formula total row; the Process Flow is now a numbered-circle stepper connected by a vertical line instead of plain arrow text" },
  { version: "3.0.289", date: "2026-08-28", note: "Split the Currency/Cost/Margin/Selling Price block out of \"2. Recipe Overview\" into its own \"3. Costing\" card — Components and Process and Process Steps are now 4 and 5" },
  { version: "3.0.290", date: "2026-08-28", note: "Print/PDF: swapped the ingredient table's g and % columns — now Ingredient / Prep / Note / g / %" },
  { version: "3.0.291", date: "2026-08-28", note: "The full-page Recipes view now opens on a grid of Product Type categories (each with a recipe count) instead of one flat list — click a category to see just its recipes, with a back button to return. Typing a search still searches every recipe regardless of category" },
  { version: "3.0.292", date: "2026-08-28", note: "The sidebar's compact recipe list is now grouped by Product Type too, as a collapsible accordion — click a category's arrow to expand/collapse its recipes. The currently open recipe's own category always starts expanded so it's never hidden. Typing a search still shows a flat filtered list across every recipe" },
  { version: "3.0.293", date: "2026-08-28", note: "Added a Note field to \"1. Product Details\" (after Description/Photos) — shows in print/PDF too when filled in" },
  { version: "3.0.294", date: "2026-08-28", note: "Added a Translate button to Note and each Description/Concept point — free machine translation (Thai<->English, auto-detected), shown as a read-only preview under the field without changing what's typed. No API key/setup needed, but lower quality and rate-limited vs. a paid translation service — not for anything that needs to be contractually precise" },
  { version: "3.0.295", date: "2026-08-28", note: "Recipe's Translate button (Note, Description/Concept) now works the same way as Projects' Activities Updates translate button — replaces the field with the translation followed by the original in parentheses, instead of showing a separate read-only preview underneath" },
  { version: "3.0.296", date: "2026-08-28", note: "Print/PDF: Product Details' reference/description photos now print 1.5x larger (150px vs. the on-screen 100px thumbnail)" },
  { version: "3.0.297", date: "2026-08-28", note: "Removed the Export Excel button from the recipe toolbar. Added a Development Status dropdown next to the recipe title — 🟡 In Development (default), ⚪ On Hold, 🟣 Pilot, 🟢 Approved, 🔴 Discontinued, 🟠 Needs Improvement — color-coded to match" },
  { version: "3.0.298", date: "2026-08-28", note: "Restyled the Development Status dropdown to match the app's existing small soft-pill badges (e.g. Projects' Activities status badges) instead of a bordered, oversized dropdown that looked out of place" },
  { version: "3.0.299", date: "2026-08-28", note: "Project's Product table: added a Unit column next to Sample Qty (e.g. \"5 pcs\"), and the Sample Qty Unit / Per fields now select their existing text on focus, so clicking a datalist suggestion replaces it instead of needing to delete it first — across the submission review form, New Project, Edit Project, and the public submission page" },
  { version: "3.0.300", date: "2026-08-28", note: "Added Quotation and Specification document slots to the project detail view — click to upload, shows a live A4-proportioned preview (image or PDF, via the browser's own PDF viewer) with the filename captioned below, click the × to remove" },
  { version: "3.0.301", date: "2026-08-28", note: "Enlarged the Quotation/Specification document slots from 130px to 320px wide (still exact A4 proportions), matching the bigger size the reference example showed" },
  { version: "3.0.302", date: "2026-08-28", note: "Fixed a Quotation/Specification slot growing far taller than its empty sibling once a real PDF was loaded — the box's height is now a fixed pixel value instead of aspect-ratio, so it can no longer be pushed larger by the embedded PDF viewer's own rendering" },
  { version: "3.0.303", date: "2026-08-28", note: "Moved Requirements out from inside the project info column to its own full-width block below, and resized the Quotation/Specification slots to stretch-fit that column's actual height (still A4 proportions, width derived from the available height) instead of a fixed 320x453 that could run taller than a short info column and overlap into Requirements" },
  { version: "3.0.304", date: "2026-08-28", note: "Quotation/Specification slots: the small preview now hides the embedded PDF viewer's own toolbar/sidebar (which ate a third of the box), clicking a filled slot opens a full-size preview popup instead of re-triggering the file picker (a small icon replaces the file directly), and removing one now asks for confirmation first" },
  { version: "3.0.305", date: "2026-08-28", note: "Quotation/Specification slots: the PDF page now zooms to fill the whole box edge-to-edge instead of leaving a visible margin at the viewer's own default zoom, since the box itself is already A4-proportioned" },
  { version: "3.0.306", date: "2026-08-28", note: "Quotation/Specification slots: the small preview now renders a PDF's first page directly onto a canvas via pdf.js instead of embedding the browser's own PDF viewer — since the browser viewer always left a fixed margin around the page that no open-parameter could remove, the small preview now fills the box completely edge to edge with no crop-inducing gap" },
  { version: "3.0.307", date: "2026-08-28", note: "Moved the \"+ Add Update\" button from below the whole Activities Updates history to right next to the \"Activities Updates\" label at the top — the add form now opens there too, above the history, instead of at the very bottom" },
  { version: "3.0.308", date: "2026-09-01", note: "Quotation/Specification previews now render at a sharper resolution — the canvas is always drawn at least 2x the box's on-screen size (previously exactly 1x on standard, non-Retina screens), giving pdf.js's anti-aliasing more detail to work with so small print looks crisper" },
  { version: "3.0.309", date: "2026-09-02", note: "Activities Updates' Plan/Next Action fields relabeled and reorganized: Who/What/Where became Person/Activity/Location · Channel, How was removed, and two new fields — With (internal teammate involved) and Owner (who owns this record) — were added, across the Update Activity popup, the inline Add/Edit forms, and the timeline card display" },
  { version: "3.0.310", date: "2026-09-02", note: "The Add Update form's Owner field now starts pre-filled with the project's PD (Responsible Person) instead of blank — still a plain text field, so it can be changed to anyone else before saving" },
  { version: "3.0.311", date: "2026-09-03", note: "A recipe page (locked or unlocked for editing) is now capped at an actual A4 sheet's width (210mm) instead of the app's usual 960px page width, so the on-screen layout already reads like the page it prints as — every other page (Ingredient Library, Projects, etc.) keeps its own width" },
  { version: "3.0.312", date: "2026-09-03", note: "Printing a recipe now puts each numbered section — 1. Product Details, 2. Recipe Overview, 3. Costing, 4. Components and Process, 5. Process Steps — on its own separate page instead of however many happen to fit per sheet" },
  { version: "3.0.313", date: "2026-09-03", note: "Narrowed the printed page's left/right margins (10mm each, down from the browser's default of roughly an inch) so content sits closer to the paper's edge — top/bottom margins are unchanged" },
  { version: "3.0.314", date: "2026-09-03", note: "Each of a printed recipe's 5 numbered sections now has its own accent color (title text + a colored left edge on the card) — blue/green/gold/orange/red — instead of every section printing in the same plain navy, so they're easier to tell apart at a glance while flipping through the pages" },
  { version: "3.0.315", date: "2026-09-03", note: "Toned the previous version's section colors down — instead of solid colored title text and a colored border, each printed section now gets a soft pale color band behind its title bar (same light-tint style as other soft-colored UI already in the app), with the title text staying plain dark navy" },
  { version: "3.0.316", date: "2026-09-03", note: "\"4. Components and Process\"'s own group headings (Powder/Oil/Seasoning/Vinegar/Vegetable/Water) now print on the same pale-orange band as that section's title, instead of plain gray, so they stand out while scanning the table" },
  { version: "3.0.317", date: "2026-09-03", note: "Reverted the printed recipe's design back to how it looked at v3.0.310 — removed the narrowed 10mm margins, the one-section-per-page breaks, the pale color bands on each section's title, and the colored group headings in Components and Process" },
  { version: "3.0.318", date: "2026-09-03", note: "Fixed \"4. Components and Process\" printing across 2 pages with the Formula total row wrongly appearing a page early — it's now a plain last row instead of a <tfoot> (which browsers repeat on every page a table spans), the section starts on its own fresh page so it has room to fit as a whole, and its ingredient table's rows print a bit tighter" },
  { version: "3.0.319", date: "2026-09-03", note: "Restyled \"4. Components and Process\" printing: ingredient group headings (Powder/Oil/Seasoning/...) now shade in one consistent pale blue-gray with bold dark-navy text, detail rows stay plain white with a thin gray divider, and the Process Flow card picks up a matching pale blue-gray background with its step labels recolored to dark navy" },
  { version: "3.0.320", date: "2026-09-03", note: "Fit \"4. Components and Process\" onto a single printed page: the ingredient table and Process Flow card now split 62%/38% (was a fixed 320px column) with their top edges aligned and the card sized to its own content, page margins tightened to 10mm all around, and card/grid padding trimmed — all before touching font size, to keep everything legible with the Formula total row included" },
  { version: "3.0.321", date: "2026-09-03", note: "Strengthened the highlight on \"4. Components and Process\"'s group rows and Process Flow card — the previous pale-blue tint printed too close to plain white to actually stand out, so it's now a more visible blue-gray, plus a navy accent stripe down the left edge of every group row" },
  { version: "3.0.322", date: "2026-09-03", note: "Added a soft left-to-right gradient to the ingredient table's group rows and column header (instead of a flat fill) for a bit more depth on \"4. Components and Process\"" },
  { version: "3.0.323", date: "2026-09-03", note: "Fixed the group-row/table-header shading and gradient not actually showing up when printed or exported to PDF — browsers skip background colors on print by default unless told otherwise (the navy left-border still showed since borders aren't affected), now forced on with print-color-adjust:exact" },
  { version: "3.0.324", date: "2026-09-03", note: "Reverted the printed recipe's design back to v3.0.310 again — dropped the 10mm margins, one-section-per-page break, Components/Process color shading and gradient, and the 62/38 column split — while keeping the Formula-total-row fix and the print-color-adjust:exact fix from the last two versions" },
  { version: "3.0.325", date: "2026-09-03", note: "Re-fit \"4. Components and Process\" onto a single printed page — the 62%/38% ingredient-table/Process-Flow split with aligned top edges, a fresh page for the section, and tighter margins/padding are back, but this time with no color/gradient highlighting on the group rows (plain, per the last request)" },
  { version: "3.0.326", date: "2026-09-03", note: "Widened the on-screen recipe page from the 210mm (A4) cap to 1300px (same width as Compare/Projects) — the Recipe Overview table's columns felt cramped at A4 width. Printing is unaffected, it already scales to the physical paper size" },
  { version: "3.0.327", date: "2026-09-03", note: "Printed Process Flow steps now list their Components underneath each step name (English-only, the Thai half of each ingredient's bilingual name is dropped) so it's clear at a glance what goes into each step" },
  { version: "3.0.328", date: "2026-09-03", note: "Fixed Parts/Sub-parts in the ingredient tree auto-re-expanding after any drag-and-drop reorder — a manually collapsed Part now stays collapsed instead of snapping back open every time the tree re-renders" },
  { version: "3.0.329", date: "2026-09-03", note: "When a Process Step's Component is a whole Part (e.g. \"Vegan Tartar Sauce\" added as one lumped-together entry), its row now shows a read-only list of what's actually inside it — just the ingredient names as plain chips, no editable weight/tolerance/% fields, so a lumped Component's makeup is still visible at a glance" },
  { version: "3.0.330", date: "2026-09-03", note: "That read-only ingredient breakdown now shows each ingredient's Weight (g) and % too, lined up under the same columns as the main row, instead of just its name" },
  { version: "3.0.331", date: "2026-09-04", note: "Added a Preview button next to Print / PDF on the recipe page — opens the exact same print layout full-screen (sidebar and toolbar hidden) without triggering an actual print job, with a close button at the top-right to return to editing" },
  { version: "3.0.332", date: "2026-09-04", note: "Left-aligned the Component name column on the Process Steps page's Cutting/Weighing/etc. tables — it was inheriting the same right-align as the numeric Weight/Tolerance/Range/% columns next to it" },
  { version: "3.0.333", date: "2026-09-04", note: "Narrowed the # column on those same Cutting/Weighing/etc. tables (it was taking far more room than a single digit needs) and gave all the reclaimed width to the Component column, so long ingredient names wrap less" },
  { version: "3.0.334", date: "2026-09-04", note: "Each Process Step (Cutting/Weighing/Mixing 1/...) on the Process Steps page and in Version Preview now renders as its own bordered white block instead of flowing straight into the next one, so it's clear where one Step ends and the next begins" },
  { version: "3.0.335", date: "2026-09-04", note: "The read-only Process Steps page and Version Preview now show the same sub-ingredient breakdown under any Component that's a whole Part (e.g. \"Powder\") as the live editor already did — read-only names/weight/%, no editable fields" },
  { version: "3.0.336", date: "2026-09-04", note: "Recipe Overview's %/Weight/Cost columns replaced the boxed bar-and-percentage widget with a thin bar directly under each number, on all three columns instead of just %, each scaled against that column's own values" },
  { version: "3.0.337", date: "2026-09-04", note: "Those under-number bars now shrink to exactly the width of the number above them instead of stretching across the whole column, so a short value like \"0.10%\" gets a short bar and a long one like \"40.95%\" gets a longer one" },
  { version: "3.0.338", date: "2026-09-04", note: "Clicking an ingredient's photo on the Recipe Overview table now opens the same Material Detail popup the Ingredient Library page itself uses — vendor, manufacturer, price, MOQ, usage notes, all of it — instead of doing nothing" },
  { version: "3.0.339", date: "2026-09-04", note: "Added Ingredient Preparation Yield: picking a Sub Ingredient variant (Chop/Dice/etc.) now also snapshots its %Yield onto that recipe row, driving a new editable Yield (%) and an auto-calculated Prepare (gross) weight = Formula ÷ (Yield/100) next to every ingredient. Ingredient cost, Recipe Overview (new % of Recipe / Prep Yield / Prepare Wt. columns, split by Prep, plus a Preparation Total alongside Formula Total), the printed ingredient table, and Version Preview all now show and use Prepare weight; Formula weight and % of Recipe stay exactly as before. The old whole-batch \"Expected Yield\" is relabeled \"Batch Process Yield\" so the two concepts don't read as the same thing. Old recipes with no Yield set open and compute exactly as before (100%)" },
  { version: "3.0.340", date: "2026-09-05", note: "Extended Ingredient Preparation Yield to Parts and Sub-parts themselves, not just individual ingredients — each Part now has its own editable Yield (%) and Prepare (gross) weight, compounding with everything inside it (own ingredients' Yields and any nested Sub-part's own Yield). Flows through to cost, Recipe Overview's Preparation Total, the printed ingredient table, and Version Preview everywhere a Prepare weight is shown. Formula weight, % of Part, and % of Recipe stay completely unaffected; old recipes with no Part Yield set open and compute exactly as before" },
  { version: "3.0.341", date: "2026-09-05", note: "Each Process (Section 4, e.g. \"Mixing 1\") now has its own Actual Yield fields — Weight Before (g) and Weight After (g), with the Yield % calculated automatically — for recording real measured production loss, separate from every planned/calculated Yield figure elsewhere in the app. Also, adding a new Process now starts it with one blank Step already in place instead of an empty list" },
  { version: "3.0.342", date: "2026-09-05", note: "Added °Brix, %Salt, and pH readings to each Process, next to its Actual Yield fields — up to 3 replicate measurements per reading, with the average calculated automatically from whichever reps have a value entered" },
  { version: "3.0.343", date: "2026-09-05", note: "Lined up the labels across Weight Before/After, Yield, °Brix, %Salt, and pH on the same top row instead of some sitting lower than others" },
  { version: "3.0.344", date: "2026-09-05", note: "In Section 4 (Components and Process), a Part's Prepare (g) — and every ingredient's and Sub-part's Prepare (g) nested inside it — now updates live to include that Part's own Yield, cascading down through every level underneath it, instead of only showing up in Recipe Overview/Print/Version Preview. Formula weight and % figures are still completely unaffected" },
  { version: "3.0.345", date: "2026-09-05", note: "Preview / Print now shows each Process Step's Actual Yield (Weight Before/After and the calculated Yield %) and °Brix/%Salt/pH readings, matching what's entered on the edit page — previously this whole section was missing from Preview. A Process with nothing measured yet still prints without it, same as before" },
  { version: "3.0.346", date: "2026-09-05", note: "Added Recipe Series — group related Trials (T01, T02, ... T21, T22) of the same recipe together instead of each Duplicate becoming a fully separate recipe. A Series-enabled recipe gets a \"+ New Trial\" button (collision-safe Trial numbering, even if two people click it at the same instant) and a Trial History card in its header, its Recipe Code shows the Trial number as its own badge, its sidebar entry groups every Trial under one collapsible \"Series · N Trials\" row, and \"Compare Trials\" opens Compare pre-filtered to just that Series (with a one-click \"Show All Recipes\" to escape it). \"Duplicate\" moved into a new \"More\" menu and renamed \"Duplicate as New Recipe\" — it now always starts a brand-new Series at Trial 01. An admin-only Recipe Series Migration tool (Account menu) lets existing recipes be assigned to a Series via an explicit, previewed, safely-re-runnable mapping — nothing is merged automatically by name or code. Versions and Test Results are completely unaffected; recipes with no Series (every existing recipe, until migrated) work exactly as before" },
  { version: "3.0.347", date: "2026-09-05", note: "Recipe Series Migration now has a \"Find Recipe IDs\" search box — type a product name to see its recipes' actual Document IDs (with a Copy button), instead of having to dig them out of Firebase Console before you could fill in the migration mapping" },
  { version: "3.0.348", date: "2026-09-05", note: "Recipe Series Migration's Apply button no longer silently does nothing when clicked too early (before Preview, or while the Preview report still has errors) — it now always explains exactly why, so it's clear what to do next instead of looking broken" },
  { version: "3.0.349", date: "2026-09-05", note: "Recipe Series Migration's \"Find Recipe IDs\" search now has a checkbox and Trial No. field on every row (pre-filled from that recipe's existing Trial code where possible) plus \"Select All\" and \"+ Add Selected to Mapping\" — check off several matching recipes and add them all into the JSON mapping at once instead of copying each Recipe ID in by hand" },
  { version: "3.0.350", date: "2026-09-05", note: "Recipe Series Migration now jumps the mapping box to the top and drops the cursor right into the empty seriesKey field whenever it's the reason Preview or Apply won't proceed — previously that field sat scrolled out of view above the recordIds list Add Selected had just filled in, so \"Missing seriesKey\" wasn't obvious what to do about" },
  { version: "3.0.351", date: "2026-09-05", note: "Recipe Series Migration's \"Find Recipe IDs\" search now has a \"Fix\" button next to any recipe already in a Series, for correcting a mistake from an earlier Apply (e.g. a typo in Recipe No. or Country Code) — edits the Series record and every one of its Trials in one step, without needing to touch Firebase Console directly" },
  { version: "3.0.352", date: "2026-09-05", note: "The full-page Recipes view now groups a category's recipes by Recipe Series too, same as the sidebar already does — drill into a Product Type category and every Trial of the same Series collapses into one \"Series · N Trials\" row you expand to pick a specific Trial, instead of every Trial listed loose alongside unrelated recipes" },
  { version: "3.0.353", date: "2026-09-05", note: "Category recipe counts (the tiles on the Recipes view, and the sidebar's own Product Type groups) now count a Recipe Series as one recipe, not one per Trial — a Series with 6 Trials plus 1 unrelated recipe now correctly shows \"2 recipes,\" not \"7\"" },
  { version: "3.0.354", date: "2026-09-07", note: "Removed the per-ingredient Yield (%) input in Components and Process — an ingredient's own Yield now only ever comes from picking a Sub Ingredient variant in the Ingredient Library (still fully used in the Prepare weight/cost calculation, just no longer manually typed or overridden), and its Prepare (g) figure is still shown. A Sub-part's own Yield field moved to sit right after its name, with a visible \"Yield\" label, instead of appearing unlabeled further along the row" },
  { version: "3.0.355", date: "2026-09-07", note: "Fixed the printed \"4. Components and Process\" ingredient table spilling out of its own column and overlapping the Process Flow card next to it whenever an ingredient name was long (e.g. \"MC (Methylcellulose)...\") — the table now always stays within its 62% width, wrapping long names onto a second line instead of forcing the table wider" },
  { version: "3.0.356", date: "2026-09-07", note: "A top-level Part's own Yield field moved to sit right after its name, with a visible \"Yield\" label, instead of appearing further along the row past the weight/prepare/% fields — matches where a Sub-part's own Yield field already sits" },
  { version: "3.0.357", date: "2026-09-07", note: "A top-level Part's own ingredient/sub-part count (e.g. \"2 sub-parts\") moved to sit right after its name, ahead of Yield — instead of trailing at the very end of the row past weight/prepare/%. Matches where a Sub-part's own count already sits, right after its name" },
  { version: "3.0.358", date: "2026-09-07", note: "A top-level Part's \"Prepare\" label now reads before its weight (\"Prepare 475.60 g\") instead of after (\"475.60 g prepare\"), and its \"% of recipe\" label shortened to just \"%\". Also fixed a duplicated \"g\" on every Prepare weight in Components and Process (Part headers and every ingredient row) — the number already includes its own \"g\", so the extra unit label next to it was always redundant" },
  { version: "3.0.359", date: "2026-09-07", note: "Fixed a blank ingredient search row appearing automatically on any Part that only holds Sub-parts and no ingredients of its own (e.g. a Part that's just an organizer for a couple of Sub-parts) — it now only appears on a Part that truly has neither ingredients nor Sub-parts" },
  { version: "3.0.360", date: "2026-09-07", note: "Removed the \"Batch Process Yield (%)\" and \"Adjusted Output Weight\" fields from Components and Process — superseded by the per-Part Yield fields. Also moved the °Brix/%Salt/pH quality-control readings in each Process Step's Actual Yield section to the right side of the row, away from Weight Before/After/Yield, instead of sitting right up against them" },
  { version: "3.0.361", date: "2026-09-07", note: "A top-level Part's own Yield field moved to sit right in front of its weight (g) instead of leaving a wide gap between them — now sits flush against the weight/Prepare/% fields, matching how close together they already are on a Sub-part's own row" },
  { version: "3.0.362", date: "2026-09-07", note: "Swapped the top navbar's tab order so \"Ingredients\" comes before \"Test Results\"" },
  { version: "3.0.363", date: "2026-09-07", note: "A Sub-part's own Prepare weight now shows the word \"Prepare\" before its number, same as a top-level Part's already does — ingredient rows are unchanged" },
  { version: "3.0.364", date: "2026-09-07", note: "Swapped the Prepare and Weight (g) columns in Components and Process so Prepare comes first — applies to every row: top-level Parts, Sub-parts, and ingredients" },
  { version: "3.0.365", date: "2026-09-08", note: "Preview and Print now always show each Process Step's \"Actual Yield\" section (Weight Before/After, Yield, °Brix/%Salt/pH) as a blank template, even before any measurements are recorded — so it can be printed and filled in by hand on the production floor, then keyed into the system afterward" },
  { version: "3.0.366", date: "2026-09-08", note: "In Preview/Print's \"4. Components and Process\" ingredient table, moved the Yield column to sit right after the ingredient/Part name, matching where Yield sits in the live editor, and removed the Yield value from individual ingredient rows (only Parts show a Yield now, same as the live editor)" },
  { version: "3.0.367", date: "2026-09-08", note: "Widened the printed ingredient table against the Process Flow column in \"4. Components and Process\" from a 62/38 split to 70/30, giving the table more room" },
  { version: "3.0.368", date: "2026-09-08", note: "Fixed the printed ingredient table's column headers (\"Formula (g)\", \"Prepare (g)\", etc.) overlapping each other in their narrow columns — they now wrap onto a second line the same way \"Prep / Note\" already did, instead of running past their own column into the next one" },
  { version: "3.0.369", date: "2026-09-08", note: "A Project's Plan and Next Action \"Owner\" fields, when adding a new Monthly Update, now default to that Project's own Project Owner instead of its Responsible Person (PD) — fills in automatically whenever the Project Owner field has been filled in" },
  { version: "3.0.370", date: "2026-09-08", note: "Centered the column header text in the printed \"4. Components and Process\" ingredient table (Ingredient, Yield, Prep/Note, Formula (g), Prepare (g), %, % of Recipe) — was left-aligned" },
  { version: "3.0.371", date: "2026-09-08", note: "Reverted v3.0.369 — a Project's Plan and Next Action \"Owner\" fields, when adding a new Monthly Update, default to its Responsible Person (PD) again, not its Project Owner" },
  { version: "3.0.372", date: "2026-09-08", note: "Renamed the Plan and Next Action \"Owner\" field/label to \"PD\" throughout Projects (add form, edit form, summary card, activity log) — it always held the Responsible Person, so the label now matches" },
  { version: "3.0.373", date: "2026-09-08", note: "Fixed \"Create as Plan automatically\" silently doing nothing when Next Action Activity or its due date (\"When\") was left blank — checking it now shows a clear message explaining both are required, instead of no follow-up Plan appearing with no explanation" },
  { version: "3.0.374", date: "2026-09-08", note: "Fixed a Sub-part's own Yield/Prepare/Weight/% columns sitting a few px left of where the same columns land on its ingredient rows below — a mismatched row spacing value between a Sub-part's header and an ingredient row is now the same 6px, so every row's Weight and % columns line up exactly regardless of nesting depth" },
  { version: "3.0.375", date: "2026-09-08", note: "Added a new \"Products\" page — a searchable Product List (name, sample code, type, factory, size, packing, MOQ, pricing, allergens, two photos per product) with the same add/edit/copy/delete workflow as the Ingredient Library, including the same admin-approver-password confirmation before a product can be deleted" },
  { version: "3.0.376", date: "2026-09-08", note: "Added an admin-only \"Import Legacy Product List (one-time)\" button on the Products page to seed it from the ~40 real products (with photos) in the team's existing UMIOS Product List reference spreadsheet — safe to run more than once, already-imported products are overwritten, never duplicated" },
  { version: "3.0.377", date: "2026-09-09", note: "Added a new \"Sample Submissions\" page — track a shipment of product samples to a customer (delivery info, a sample-by-sample manifest with lot numbers/quantities, an auto-computed quantity summary, customer evaluation scoring with an auto-computed overall average, a follow-up decision summary, and a signable Prepared by/Received by acknowledgement). Each sample can be linked to a Product List entry — its cooking instructions, composition, allergens, factory, case pack, MOQ and price are then pulled live from there instead of being re-typed, so editing the Product later keeps every submission that references it current. Printable per-submission, same as Test Results" },
  { version: "3.0.378", date: "2026-09-09", note: "Fixed a Monthly Update's PD field showing blank when editing an existing entry that never had one filled in — it now defaults to the Project's current Responsible Person (PD), same as it already did when adding a brand-new update" },
  { version: "3.0.379", date: "2026-09-09", note: "Fixed a printed Sample Submission's wide tables (Samples included, Product specification, Customer evaluation) overlapping/overflowing instead of fitting on an A4 page — every column now shrinks and wraps to fit the printed page width, with dates displaying in full instead of getting cut off" },
  { version: "3.0.380", date: "2026-09-10", note: "Sample Submissions' Form No. is now issued automatically as \"SS-<year>-<sequence>\" (e.g. SS-2026-0001) instead of typed by hand — assigned the moment a new submission is created, collision-safe even when two people save at the same instant, kept unchanged for the life of that submission, and never reused once issued" },
  { version: "3.0.381", date: "2026-09-10", note: "Fixed Products and Sample Submissions sometimes still running yesterday's code after a Deploy — those two page files (plus the admin Series Migration tool) were missing from the app's no-cache list, so a browser could keep serving an old cached copy of them indefinitely instead of picking up new fixes" },
  { version: "3.0.382", date: "2026-09-10", note: "Sample Submission fields that match an existing Reference List now suggest from it as you type — Customer/Destination reuse the same company and country lists Projects already draws from, and Project Lead/Coordinator/Feedback Owner reuse the Contact Directory (same as the sample row's own Owner field). Fields with no matching list (Courier, Storage, Tracking No., etc.) are left as plain free text" },
  { version: "3.0.383", date: "2026-09-10", note: "Added a \"Project\" picker to Sample Submissions — pick a project and Customer, Destination, Project Lead and Coordinator fill in automatically from it (still freely editable afterward). Only visible to someone with permission to see the Projects module; a person without it never sees the picker at all" },
  { version: "3.0.384", date: "2026-09-10", note: "Reordered Sample Submission's Document and delivery information fields — Customer/Destination and Project Lead/Coordinator now lead each row, with the system-generated Form No. and Doc. Date moved to the end" },
  { version: "3.0.385", date: "2026-09-10", note: "Moved Form No. and Doc. Date up next to the Project picker on Sample Submissions, sharing its row instead of leaving an empty gap beside it — Customer/Destination and Project Lead/Coordinator follow on the rows below" },
  { version: "3.0.386", date: "2026-09-10", note: "Removed the MFG Date and Expiry Date columns from a Sample Submission's Samples table, and gave the Product column enough room to show its picker/spec-summary text without wrapping down into an unreadable 6-7 line block — the rest of the row scrolls horizontally if needed, same as other wide tables in the app" },
  { version: "3.0.387", date: "2026-09-10", note: "Fixed the Samples table's Product picker dropdown not appearing when clicking into the field — the table's own horizontal-scroll area was silently clipping it (a side effect of yesterday's fix for the cramped Product column), now positioned to float above everything else instead" },
  { version: "3.0.388", date: "2026-09-10", note: "Turned Sample Submission's free-text Docs field into a checklist — Specification, ใบเสนอราคา, Tax Invoice and เอกสารอื่นๆ. Checking Tax Invoice reveals its own 6 fields (carrier name, flight no., Port of Loading/Destination, departure/arrival date & time); checking เอกสารอื่นๆ reveals a detail field. A submission saved before this change keeps its old Docs text, carried into the เอกสารอื่นๆ field automatically" },
  { version: "3.0.389", date: "2026-09-10", note: "Moved Purpose to sit right under Project on Sample Submissions and removed the unused Ship Date field. Also fixed the Samples table's Product picker dropdown for real this time — it's now one shared dropdown appended directly to the page's body instead of nested inside the table, so it can no longer get silently misplaced or hidden by an ancestor's scroll clipping or animation" },
  { version: "3.0.390", date: "2026-09-10", note: "Fixed the Product List form's Cooking Instruction field showing a stray leftover placeholder (\"e.g. Update: 20260430 BAZZ\") — now shows a proper example instead" },
  { version: "3.0.391", date: "2026-09-10", note: "Product List's Processed Area now suggests from the full world country list as you type, and Factory now suggests from the Company Directory (Reference Lists) instead of only from factory names already typed into other products" },
  { version: "3.0.392", date: "2026-09-10", note: "Translated Sample Submissions' Docs Request checklist and Tax Invoice fields (Quotation, Other Documents, Carrier/Shipper Name, Flight No., Port dates, Other Documents Details) from Thai to English" },
  { version: "3.0.393", date: "2026-09-10", note: "Sample ID is now auto-generated on Sample Submissions instead of typed by hand — \"<Form No.>-S01\", \"-S02\", ... in the order each sample is added. Deleting or reordering rows never changes another sample's ID, a deleted number is never reused, and it works the same whether the sample is linked to a Product List item or typed in manually" },
  { version: "3.0.394", date: "2026-09-10", note: "Added a \"Food Allergens\" tab to Reference Lists — the FARRP International Regulatory Chart (43 countries x 25 allergen categories, with color-coded country-specific exceptions and a legend), reproduced from a snapshot captured today. It's not a live feed from the source site (not technically possible for this app) — ask to re-check the source and refresh it whenever it may be out of date" },
  { version: "3.0.395", date: "2026-09-10", note: "Turned a Project's Requirements \"Certificate\" field into a checklist (Halal, HACCP, GMP, BRC, Kosher, ISO 22000, Other) instead of free text — same idea as Sample Submissions' Docs Request, and available everywhere Certificate appears: the main project edit view, the New Project panel, and the Pending Submission review form. A project saved before this change keeps its old Certificate text, carried into the Other field automatically" },
  { version: "3.0.396", date: "2026-09-10", note: "Changed the Food Allergens chart's background from dark to white, matching the rest of Forge's light theme" },
  { version: "3.0.397", date: "2026-09-10", note: "Turned Products' \"Composition (Approx.)\" field into a table instead of free text — one row per main ingredient, with up to 2 sub-levels and a % column, plus Add/Remove Row. A product saved before this change keeps its old composition text as the first row. The composition summary now also shows correctly in the product detail view and in Sample Submissions' linked-product specification table" },
  { version: "3.0.398", date: "2026-09-10", note: "Added a \"Storage Condition\" tab to Reference Lists and connected it to every Storage Condition field in Projects (the main project edit view, the New Project panel, and the Pending Submission review form) so it suggests from the same curated list instead of being typed free-hand each time" },
  { version: "3.0.399", date: "2026-09-10", note: "Reference Lists' Cooking Method tab: entries now sort A-Z regardless of upper/lower case, and each entry's Steps show as a plain numbered list instead of a row of boxed input fields — the input boxes still appear when you click Edit" },
  { version: "3.0.400", date: "2026-09-10", note: "Added an optional Note field to Reference Lists' Cooking Method entries — click \"+ Note\" while editing to add a remark (e.g. \"Do not reheat more than once\") separate from the numbered Steps" },
  { version: "3.0.401", date: "2026-09-11", note: "Products' Cooking Instruction now has a \"Pick a Cooking Method\" dropdown above it, sourced from Reference Lists — picking a method that has Steps on file fills them into Cooking Instruction as a numbered starting point, same idea as Projects' Cooking Guidelines autofill" },
  { version: "3.0.402", date: "2026-09-11", note: "Moved Allergens on the Products form to right after Composition (Approx.), instead of next to EXW/Sales Price — fields renumbered accordingly" },
  { version: "3.0.403", date: "2026-09-11", note: "Fixed Products' Cooking Instruction, Description, and Remarks boxes not growing to fit their content when filled in by the Cooking Method quick-fill or when opening an existing product to edit — they now expand the same way they already do while typing" },
  { version: "3.0.404", date: "2026-09-11", note: "Products' Allergens is now a search-and-tick picker sourced from the Food Allergens reference chart's 25 categories, instead of free text — type to search, click to add as many as apply, or press Enter to add something not on the list. Shows as removable tags; saved the same way as before, so nothing else needs to change" },
  { version: "3.0.405", date: "2026-09-11", note: "Fixed the Allergens search dropdown staying open and overlapping the page below it after scrolling away — it now closes on scroll or on clicking anywhere outside it" },
  { version: "3.0.406", date: "2026-09-11", note: "Added a Duplicate button to each manually-typed product in Test Results' \"Products Being Compared\" — copies its Name, Code, and photos as a starting point for a near-identical variant, up to the usual 4-product limit" },
  { version: "3.0.407", date: "2026-09-11", note: "Split Test Results into Part 1 (test setup — Project, Sample Prepared By, Test Date/Location/Participants, Cooking Method) and Part 2 (Products Being Compared onward), with a divider between them, so the form reads as two clear sections" },
  { version: "3.0.408", date: "2026-09-11", note: "The Part 1 / Part 2 split now carries over to Test Results' Print — Part 2 starts on its own page instead of risking a mid-table split across Part 1 and the product/evaluation tables" },
  { version: "3.0.409", date: "2026-09-11", note: "Test Results' Part 2 (Products Being Compared onward) now sits in its own bordered box, same treatment as Projects' Requirements box, so it reads as a clearly separate section from Part 1 instead of just a divider line" },
  { version: "3.0.410", date: "2026-09-11", note: "Sensory Evaluation and Improvement Guidelines column headers now show a manually-typed product's Code after its name (e.g. \"Alfrado 01\") — two products sharing the same name are no longer indistinguishable columns" },
  { version: "3.0.411", date: "2026-09-11", note: "Fixed Test Results' Print not actually starting Part 2 on its own page — an existing, deliberate reset (added earlier to fix a worse blank-page bug elsewhere in print) was silently cancelling that page break; it now survives, scoped narrowly enough to not reopen the old bug" },
  { version: "3.0.412", date: "2026-09-11", note: "Added \"Needs Revision\" to Test Result's dropdown (Accepted / Needs Revision / Not accepted), with its own amber highlight alongside the existing green/red" },
  { version: "3.0.413", date: "2026-09-11", note: "Moved Cooking Method from Part 1 into Part 2 (as the first field, above Products Being Compared) on Test Results, since it applies to the products in Part 2, not the test setup fields in Part 1" },
  { version: "3.0.414", date: "2026-09-11", note: "Test Results' Sensory Evaluation criteria are now editable — rename any row, add new ones with \"+ Add Criteria\", or remove ones you don't need. \"Appearance (Exterior)\" is no longer in the default list. Improvement Guidelines now shows the exact same criteria as Sensory Evaluation instead of its own separate, shorter list, so the two always stay in sync" },
  { version: "3.0.415", date: "2026-09-11", note: "Renamed the default \"Appearance (Interior)\" criteria to just \"Appearance\" on new Test Results. An existing test's criteria are stored per-test now that they're editable, so this only applies going forward — rename it on an existing test the same way as any other criteria row" },
  { version: "3.0.416", date: "2026-09-11", note: "Test Result is now a pick-one radio choice (Accepted / Not accepted / Needs Revision) instead of a dropdown. Improvement Guidelines only accepts input for a product marked Needs Revision — Accepted and Not accepted lock that product's row as not needed, since there's nothing left to improve toward" },
  { version: "3.0.417", date: "2026-09-11", note: "Test Result: clicking the already-selected option now clears it, in case of a mis-click or you're not ready to record a result yet. Also added a Note field at the end of Part 2 for any additional comments on the test" },
  { version: "3.0.418", date: "2026-09-11", note: "Test Result's read-only view (also what Print shows) now displays the same Accepted / Not accepted / Needs Revision tick list as the edit view instead of plain text — useful for a paper printout someone outside the system can mark by hand, with whichever result is already recorded pre-ticked" },
  { version: "3.0.419", date: "2026-09-11", note: "Added a Note column to Sensory Evaluation and Improvement Guidelines — one general remark per criteria row (not tied to a single product), with the two tables keeping separate notes for the same row" },
  { version: "3.0.420", date: "2026-09-11", note: "Added \"Perform Evaluation\" to Test Results — anyone logged in can submit their own Sensory Evaluation and Test Result for a product, kept separate from everyone else's, with an Overall view showing every evaluator's answer side by side. Auto-adds you to Test Participants the first time you submit. Improvement Guidelines now unlocks if any evaluator flags Needs Revision, not just one shared pick; it stays a single shared field for whoever manages the test, same as before" },
  { version: "3.0.421", date: "2026-09-11", note: "\"Perform Evaluation\" is now a full-screen, one-sample-at-a-time wizard — score each Sensory Evaluation criteria on a 1-5 scale, add Comments, pick a Test Result, then Review every sample's answers together before Done. Replaces the previous inline table editing; the Overall view on the main page still shows every evaluator's answer side by side" },
  { version: "3.0.422", date: "2026-09-11", note: "Perform Evaluation wizard: answer text (JAR score buttons, Test Result buttons, Comments, Review values) is now pure white for better readability against the dark background" },
  { version: "3.0.423", date: "2026-09-11", note: "Perform Evaluation wizard now uses a white background matching the rest of Forge, instead of the dark theme it launched with" },
  { version: "3.0.424", date: "2026-09-11", note: "Fixed the Sensory Evaluation criteria label on tests created before \"(Interior)\" was dropped from the default — they now show \"Appearance\" instead of \"Appearance (Interior)\", same as new tests" },
  { version: "3.0.425", date: "2026-09-11", note: "Perform Evaluation wizard now shows a legend explaining what each JAR score (1-5) means, right above the questions on every sample's page" },
  { version: "3.0.426", date: "2026-09-11", note: "Test Results' Sensory Evaluation criteria can now be reordered with up/down arrows while editing — Improvement Guidelines' rows follow the same order automatically" },
  { version: "3.0.427", date: "2026-09-11", note: "Fixed the linked project's Certificate requirement showing as \"[object Object]\" on Test Results — now shows the actual checked certificates (e.g. \"Halal, HACCP\"), same as the Projects page" },
  { version: "3.0.428", date: "2026-09-14", note: "Added an \"Evaluation Criteria\" tab to Reference Lists — a reusable, editable list of Sensory Evaluation criteria names. Test Results' \"+ Add Criteria\" now has a \"Pick a Criteria\" field sourced from it, so wording stays consistent across tests instead of everyone retyping their own version" },
  { version: "3.0.429", date: "2026-09-14", note: "Evaluation Criteria (Reference Lists) can now have Sub-items — e.g. break \"Taste\" into Sweetness/Salty/Sour. Test Results' criteria picker is now a proper dropdown, grouping each topic's sub-items underneath it (added as \"Taste (Sweetness)\", matching existing naming) instead of a plain autocomplete field" },
  { version: "3.0.430", date: "2026-09-14", note: "Fixed the Perform Evaluation wizard sometimes closing itself when clicking empty space between questions — it has no separate background from its backdrop, so that click was being read as \"click outside to close\". Only the X button (and Back/Review/Done) closes it now" },
  { version: "3.0.431", date: "2026-09-14", note: "IMPORTANT DATA-SAFETY FIX: Reference Lists (Company Directory, Contact Directory, Cooking Method, etc.) all share one Firestore document. Saving an entry used to write that whole document back from memory, so a stale copy in one tab/session could wipe every OTHER list back to empty. Every save now writes only the one list actually being edited — the rest can never be touched by it, no matter what's happening in that tab" },
  { version: "3.0.432", date: "2026-09-14", note: "Reference Lists (Company Directory, Cooking Method, Evaluation Criteria, etc.) now log to the Activity feed — adding, renaming, or deleting an entry shows up in the notification bell like it already does for Projects/Recipes/Test Results" },
  { version: "3.0.433", date: "2026-09-15", note: "Removed the unused \"Responsible Persons (PD)\" tab from Reference Lists — it was never actually linked to any Person/PD field in the app (those already pull from Contact Directory), so it was dead weight with no way to reach it from anywhere" },
  { version: "3.0.434", date: "2026-09-15", note: "Clicking a project's photo in the Projects list now expands that row and shows its full details, same as clicking an ingredient's photo opens its detail view" },
  { version: "3.0.435", date: "2026-09-15", note: "Print/Edit/Delete buttons on the Projects list now only show once a project's row is expanded, instead of cluttering every collapsed row" },
  { version: "3.0.436", date: "2026-09-15", note: "A brand-new Recipe now starts its Trial Series automatically the moment you pick its Product Type — \"+ New Trial\" and Trial History are available right away, without needing to \"Duplicate as New Recipe\" first" },
  { version: "3.0.437", date: "2026-09-15", note: "Added Thai translations to the Perform Evaluation wizard's JAR scale legend (1-5 meaning)" },
  { version: "3.0.438", date: "2026-09-15", note: "Added an optional Note field to each criteria question in the Perform Evaluation wizard, separate from the overall Comments field — shows up on the Review page alongside that criteria's score" },
  { version: "3.0.439", date: "2026-09-15", note: "Removed the \"Prep Yield\" column from Recipe Overview — a lossy ingredient/part still highlights its Prepare Wt. cell, with the exact yield % now shown on hover instead of its own column" },
  { version: "3.0.440", date: "2026-09-15", note: "Perform Evaluation wizard: the selected JAR answer's meaning now shows inline right after the criteria's title, instead of below the score buttons" },
  { version: "3.0.441", date: "2026-09-15", note: "Review page: a criteria's Note now shows right after its score on the same line, instead of its own separate row below" },
  { version: "3.0.442", date: "2026-09-15", note: "Added an eye button to Recipes' Costing card to show/hide Overhead Multiplier, Margins, and Selling Price — handy for screen-sharing or a quick printout without those figures" },
  { version: "3.0.443", date: "2026-09-15", note: "Review page: score and Note are now separate columns for each criteria row, instead of the note trailing after the score in one combined column" },
  { version: "3.0.444", date: "2026-09-15", note: "Test Results' Sensory Evaluation table Note column now shows every evaluator's own per-criteria note from the Perform Evaluation wizard, instead of one separately hand-typed note only reachable via Edit mode" },
  { version: "3.0.445", date: "2026-09-15", note: "Added a Comments row to Test Results' Sensory Evaluation table, showing every evaluator's overall Comments from the Perform Evaluation wizard right on the summary table instead of only on the wizard's own Review page" },
  { version: "3.0.446", date: "2026-09-15", note: "Test Results' Sensory Evaluation table no longer shows the evaluator's name before each score, note, Test Result, and Comment — just the value itself" },
  { version: "3.0.447", date: "2026-09-15", note: "Each Process's Actual Yield section now has an Add Photo button (up to 2 photos) — Weight Before/After, Yield, and °Brix/%Salt/pH now sit to the right of the photos" },
  { version: "3.0.448", date: "2026-09-15", note: "Print/Preview: the Ingredients table vs. Process Flow column split in \"4. Components and Process\" changed from 70/30 to 75/25" },
  { version: "3.0.449", date: "2026-09-15", note: "Process Actual Yield photo thumbnails are now 3x larger (70px to 210px)" },
  { version: "3.0.450", date: "2026-09-15", note: "Print/Preview now shows each Process's Actual Yield photos, previously only visible on the live edit page" },
  { version: "3.0.451", date: "2026-09-15", note: "Print/Preview's Actual Yield photos now sit to the left of the Weight/Yield/Brix/Salt/pH table, instead of in their own row above it" },
  { version: "3.0.452", date: "2026-09-15", note: "Print/Preview's Actual Yield photos are a bit bigger (100px to 130px) and now center vertically against the taller Weight/Yield/Brix/Salt/pH table instead of hugging its top edge" },
  { version: "3.0.453", date: "2026-09-15", note: "Live edit page: each Process's °Brix/%Salt/pH readings now stack as single-line rows next to the Weight/Yield fields and photos, instead of wrapping onto their own line below the photos once those got bigger" },
  { version: "3.0.454", date: "2026-09-15", note: "Ingredient Library: added a \"Factories/Companies Using This Material\" list to the Add/Edit Ingredient form — add as many as needed, with autocomplete from Company Directory. Shows on the ingredient's detail view too" },
  { version: "3.0.455", date: "2026-09-15", note: "Recipe editor: removed the redundant \"Ingredient Library\" shortcut button above the ingredient tree (still reachable from the top Ingredients tab). Also added Formula/% of Recipe labels to every Part and Sub-part's header row, so it's clear what each number is instead of a bare g/% figure" },
  { version: "3.0.456", date: "2026-09-15", note: "Fixed the Prepare/Formula/% of Recipe labels on Part and Sub-part header rows overlapping their numbers -- each label now sits on its own line above the value instead of squeezed onto the same line" },
  { version: "3.0.457", date: "2026-09-15", note: "A Part's own Formula (g) / % of Recipe header values now line up directly above the same columns on its own ingredient rows, instead of sitting off to one side -- both use the exact same column widths now" },
  { version: "3.0.458", date: "2026-09-15", note: "Renamed Part/Sub-part header labels \"Prepare\" and \"Formula\" to \"Prepare WT.\" and \"Formula WT.\"" },
  { version: "3.0.459", date: "2026-09-15", note: "Widened the Yield % box on Part/Sub-part headers (48px to 60px) -- the number was getting clipped at the edge" },
  { version: "3.0.460", date: "2026-09-15", note: "Part/Sub-part headers: Yield now sits right next to the name/count instead of a big gap away from it, while Prepare WT./Formula WT./% of Recipe still line up with the ingredient columns beneath them" },
  { version: "3.0.461", date: "2026-09-15", note: "Print/Preview's ingredient table: renamed the ambiguous \"%\" column header to \"% of Part\", to distinguish it from the \"% of Recipe\" column next to it" },
  { version: "3.0.462", date: "2026-09-15", note: "The Costing card's eye toggle (show/hide Overhead Multiplier, Margins & Selling Price) now remembers its state across a page reload or leaving/reopening a recipe, instead of always resetting back open" },
  { version: "3.0.463", date: "2026-09-15", note: "Printed pages / PDFs now come out at 75% size automatically, matching what manually typing 75 into the browser's Print dialog Scale field used to produce -- the Scale field itself can stay at its default 100%" },
  { version: "3.0.464", date: "2026-09-15", note: "Part/Sub-part headers: closed the gap between Yield and Prepare WT. -- Name now grows to a bordered box (like a Sub-part's name always was) to absorb the row's free space instead of a gap opening up between Yield and Prepare WT., while Prepare WT./Formula WT./% of Recipe still line up with the ingredient columns beneath them" },
  { version: "3.0.465", date: "2026-09-16", note: "Added an Edit button to the Ingredient Details popup (shown when clicking an ingredient, e.g. from Recipe Overview) -- jumps straight to editing that ingredient in the Ingredient Library instead of needing to find it there manually" },
  { version: "3.0.466", date: "2026-09-16", note: "Part/Sub-part header's Name box no longer grows past half the row's width" },
  { version: "3.0.467", date: "2026-09-16", note: "Part/Sub-part header's Name box max width reduced again, from half the row's width to a quarter" },
  { version: "3.0.468", date: "2026-09-16", note: "Fixed a bug where clicking the Projects tab while a collapsed (not expanded) project row existed would silently crash mid-navigation -- the crash aborted the nav bar's own tab-highlight update, so Recipes could stay highlighted even after Projects had already loaded" },
  { version: "3.0.469", date: "2026-09-16", note: "Part/Sub-part headers: closed the remaining Yield-to-Prepare WT. gap, and moved Yield to line up roughly with the Note column on the ingredient rows beneath it -- Prepare WT./Formula WT./% of Recipe no longer line up with their own ingredient-row columns, in exchange for Yield through % of Recipe now packing together with no gaps" },
  { version: "3.0.470", date: "2026-09-16", note: "Fine-tuned Part/Sub-part header Name box width (45% to 40%) so Yield lines up more precisely with the Note column" },
  { version: "3.0.471", date: "2026-09-16", note: "Part/Sub-part header's Yield/Prepare WT./Formula WT./% of Recipe cluster now pushes flush against the row's right edge, lining % of Recipe up with the % column on the ingredient rows beneath it" },
  { version: "3.0.472", date: "2026-09-16", note: "Added Trash — deleting a Recipe, Ingredient, Product, Project, Test Result, or Sample Submission now keeps a full snapshot for 30 days (Account menu → Trash) instead of erasing it immediately, with a one-click Restore" },
  { version: "3.0.473", date: "2026-09-16", note: "Test Results' Sensory Evaluation table now shows each JAR score's meaning (e.g. \"Just right (พอดี)\") right next to the number, not just on hover" },
  { version: "3.0.474", date: "2026-09-16", note: "The Costing card's eye toggle now also hides the explanatory paragraph below the numbers, not just the Overhead Multiplier/Margins/Selling Price fields" },
  { version: "3.0.475", date: "2026-09-16", note: "Ingredient Library: added an E-Number / INS field to the Add/Edit Ingredient form — the \"INS-\" prefix is fixed, just type the number after it. Shows on the ingredient's detail view too" },
  { version: "3.0.476", date: "2026-09-16", note: "Replaced the navbar's unused \"?\" Help button with an online-users indicator — a photo (or initials) with a green dot for each teammate currently active in Forge. Help moved into the Account menu" },
  { version: "3.0.477", date: "2026-09-16", note: "Ingredient Library: added a Brand field to the Add/Edit Ingredient form and detail view" },
  { version: "3.0.478", date: "2026-09-16", note: "Ingredient Library: moved Brand to field #3 (right after the two ingredient names), renumbering everything after it — Photo's preview thumbnail now sits directly under it in the same box instead of a separate grid cell, so the numbering could stay in clean groups of 3 per row" },
  { version: "3.0.479", date: "2026-09-16", note: "Recipe editor now shows each ingredient's Brand — in the \"Recipe Overview (all parts combined)\" table's sub-label, and in the ingredient search dropdown when adding/editing an ingredient" },
  { version: "3.0.480", date: "2026-09-16", note: "Fixed: editing an ingredient's name in a recipe no longer wipes the weight you already entered for it — the field just stays disabled (greyed, value kept) until the new name matches a library ingredient again" },
  { version: "3.0.481", date: "2026-09-16", note: "Brought back \"Export Excel\" on a recipe's toolbar (next to Print/PDF), rebuilt from scratch — downloads a real, editable .xlsx workbook (Overview / Ingredients / Process sheets) styled to match the app's own Print/Preview page, not just a flat data dump" },
  { version: "3.0.482", date: "2026-09-16", note: "Export Excel now mirrors the Preview page section-for-section — added the \"2. Recipe Overview\" (grouped ingredients with Brand/Vendor, cost) and \"3. Costing\" (currency, cost/100g, cost/kg, Overhead Multiplier, Factory/Company/Customer margins) sheets that were missing, and every sheet now carries the same numbered card title (\"1. Product Details\" ... \"5. Process Steps\") as its on-screen counterpart" },
  { version: "3.0.483", date: "2026-09-16", note: "A plain refresh (F5, the tab waking back up, etc.) now resumes exactly where you left off — whichever page or recipe was open — instead of always bouncing back to Home. Only clearing the browser's site data resets it, since that's the only way a website can distinguish that from a normal refresh" },
  { version: "3.0.484", date: "2026-09-16", note: "Export Excel's \"3. Costing\" sheet now respects the Costing card's eye toggle — Overhead Multiplier, Factory/Company/Customer Margins, and the explanatory note are left out of the workbook whenever that section is currently hidden on screen, not just visually hidden" },
  { version: "3.0.485", date: "2026-09-16", note: "Moved the +New Trial / Compare Trials buttons down from the recipe header into the Trial History card, right next to the T08...T23 stepper they act on, instead of sitting up top next to Print/Export Excel" },
  { version: "3.0.486", date: "2026-09-16", note: "Fixed: the Allergens suggestion dropdown (Products form, field 17) could get stuck floating open over the page below it — a CSS rule was silently overriding the code that was already closing it correctly on scroll/click-away/blur" },
  { version: "3.0.487", date: "2026-09-16", note: "Test Results' Improvement Guidelines table now labels its two kinds of input — each sample's own column is captioned \"Automatic suggestion (คำแนะนำอัตโนมัติ)\", the trailing Note column \"Enter your own info (ระบุข้อมูลด้วยตัวเอง)\" — so it's clear which is which" },
  { version: "3.0.488", date: "2026-09-16", note: "The \"Automatic suggestion\" column is automatic now — for a sample flagged Needs Revision, it defaults to Increase/Decrease + that criteria's own JAR wording (e.g. \"Decrease Texture — Slightly more than ideal\"), derived live from the JAR score(s) in Sensory Evaluation above. Shown in italic/orange until someone types their own note, which always takes over" },
  { version: "3.0.489", date: "2026-09-16", note: "Simplified the Improvement Guidelines auto-suggestion to just the direction (e.g. \"Increase (เพิ่ม) Odor\") — dropped the trailing JAR wording, since that's already shown right above in Sensory Evaluation and just read as clutter" },
  { version: "3.0.490", date: "2026-09-16", note: "Added photo upload to the Perform Evaluation wizard — up to 4 photos of the sample right on the page you're scoring it on, the same shared gallery as Part 1's product card (add one here, it shows there too, and vice versa)" },
  { version: "3.0.491", date: "2026-09-16", note: "The Perform Evaluation wizard's photo is read-only now — uploading only happens on Part 1's product card (the form filled in before testing), the wizard just shows whatever's already there instead of offering its own Choose File button" },
  { version: "3.0.492", date: "2026-09-16", note: "Widened the JAR scale from 1-5 to 1-9 (Perform Evaluation, Sensory Evaluation, Improvement Guidelines all follow) — 5 is the new \"Just right\" midpoint. A score saved under the old 5-point scale now reads against these finer-grained anchors instead, since nothing about widening the scale can rewrite what an old answer meant at the time" },
  { version: "3.0.493", date: "2026-09-16", note: "Added an \"Idea Guideline\" to each criteria in the Perform Evaluation wizard — a -100%/+100% line with a dot showing how far off Just Right that JAR answer is (e.g. a score of 4 on the 9-point scale shows +25%), so it's clear at a glance how much to adjust and in which direction" },
  { version: "3.0.494", date: "2026-09-16", note: "Fixed the Idea Guideline's percentage label overlapping its own caption text above it — folded the percentage into the caption line instead of floating it as a separate label over the dot" },
  { version: "3.0.495", date: "2026-09-16", note: "The Perform Evaluation wizard's Review page now shows each criteria's Idea Guideline adjustment (e.g. \"+25%\") next to its score, with a note that the final improvement direction may change once the overall average and other evaluators' opinions are in" },
  { version: "3.0.496", date: "2026-09-16", note: "Test Results' Improvement Guidelines auto-suggestion now includes the adjustment percentage too (e.g. \"Increase (เพิ่ม) Appearance +50%\"), computed from the same averaged JAR score as the direction itself" },
  { version: "3.0.497", date: "2026-09-16", note: "Moved the Idea Guideline's percentage back onto the track itself — sits directly under the orange dot now instead of in the caption line above it" },
  { version: "3.0.498", date: "2026-09-16", note: "Fixed the Idea Guideline's percentage overlapping the -100%/Just right/+100% labels below it (not enough space was reserved), and the Review page now shows each JAR score's own meaning (e.g. \"Moderately less than ideal (น้อยเกินไปปานกลาง)\") next to the number, same as every other JAR score display in the app" },
  { version: "3.0.499", date: "2026-09-16", note: "The Idea Guideline's percentage now sits right on the -100%/Just right/+100% axis-label row instead of its own separate line above it" },
  { version: "3.0.500", date: "2026-09-16", note: "Fixed the Idea Guideline's reading landing directly on top of the -100%/+100% axis label at the extreme ends (a score of 1 or 9) — that axis label now hides itself in that one case instead of double-printing the same number" },
  { version: "3.0.501", date: "2026-09-16", note: "Left-aligned the score column on the Review Your Evaluation page — it was right-aligned inside its own auto-width column, so each row's score/meaning/% text started at a different, inconsistent X position instead of a shared left edge" },
  { version: "3.0.502", date: "2026-09-16", note: "Fixed the Review page's score column still not sharing one left edge across rows even after left-aligning it — each row is its own independent grid, so a fixed-width (not flexible) first column was needed to keep the criteria-name column the same width everywhere" },
  { version: "3.0.503", date: "2026-09-16", note: "The Test Results list now shows a small thumbnail from the linked Project's Idea/Reference Images (if it has one) on each test's collapsed row, next to the name" },
  { version: "3.0.504", date: "2026-09-16", note: "Added a \"Summary Test\" button to each Test Results row — a condensed, read-only readout per product showing the overall verdict and only the criteria that still need adjusting (same auto-suggested direction/% as Improvement Guidelines), instead of the full editable tables" },
  { version: "3.0.505", date: "2026-09-16", note: "Fixed the Test Results list's linked-project thumbnail to pull from the Project's own cover photo (same one the Projects list itself shows) instead of its separate Idea/Reference Images gallery" },
  { version: "3.0.506", date: "2026-09-16", note: "Summary Test now also lists which criteria are already Just Right (พอดี), not just the ones that still need adjusting, so it reads as the complete picture instead of only the problems" },
  { version: "3.0.507", date: "2026-09-16", note: "Summary Test now shows the test's own Note (same field as Part 2's Note textarea) at the bottom, when there is one" },
  { version: "3.0.508", date: "2026-09-16", note: "Added a \"Summary Table\" view to Test Results, alongside the existing List view (toggle at the top) — one row per test, sorted most-recently-updated first, with Project / PD (Responsible Person) / an inline Summary Test readout per column, for quickly scanning many tests at once" },
  { version: "3.0.509", date: "2026-09-16", note: "Summary Table now groups tests by their linked Project — Project/PD shown once per group instead of repeated on every row — with each project's own tests listed newest to oldest underneath" },
  { version: "3.0.510", date: "2026-09-16", note: "Suggested Improvements and Just Right lines (in both Summary Test and Summary Table) now show that criteria's own Improvement Guidelines Note when there is one, instead of just the direction/%" },
  { version: "3.0.511", date: "2026-09-16", note: "Added a \"Continue Development?\" row to Improvement Guidelines — a per-product Continue/Discontinue decision. Only a product marked Continue now shows up in Summary Test / Summary Table, so those pages only ever reflect samples still actively being pursued" },
  { version: "3.0.512", date: "2026-09-16", note: "Test Results' List view now groups tests by their linked Project too (same grouping as Summary Table), with a heading above each project's own tests. Also left-aligned the Summary Table's PD and Summary Test columns, which were reading as ragged right-aligned paragraphs" },
  { version: "3.0.513", date: "2026-09-16", note: "Collapsed tests in the Test Results List view are compact rows now (thin divider, no padded box) instead of full stacked cards — much tighter when a project has several tests. Expanding one still gets the full card treatment for its own detailed form" },
  { version: "3.0.514", date: "2026-09-16", note: "Fixed Test Results' sort order to go by each test's own Tested date (most recent first) instead of when the record was last saved, which could drift out of sync with it. Also changed Summary Table's Improve/Just Right from one comma-joined line into a proper bulleted list per item" },
  { version: "3.0.515", date: "2026-09-16", note: "Test Results List view: hid each row's Print/Delete buttons until the row is expanded, so the collapsed list stays uncluttered" },
  { version: "3.0.516", date: "2026-09-16", note: "Test Results List view: since the linked project's name is already shown once above a group of tests, each test row's own label now leads with its Tested date and which product(s) were tested, instead of repeating the project name" },
  { version: "3.0.517", date: "2026-09-16", note: "Test Results List view: moved each row's tested product name(s) onto their own line below the Tested date, so a long product list wraps in place instead of pushing the row's buttons off the edge" },
  { version: "3.0.518", date: "2026-09-16", note: "Added the same Translate button (Thai <-> English, no account/API key needed) used elsewhere in Forge to each criteria's Note field in the Perform Evaluation wizard (Appearance/Odor/Taste/Texture etc.)" },
  { version: "3.0.519", date: "2026-09-16", note: "Test Results List view: moved the product count next to the Tested date, and changed the tested product name(s) below it into a one-per-line list instead of one comma-separated line" },
  { version: "3.0.520", date: "2026-09-16", note: "Added the Translate button to Improvement Guidelines' per-criteria Note column and Part 2's own Note field, same as the Perform Evaluation wizard's criteria notes" },
  { version: "3.0.521", date: "2026-09-16", note: "Added an Export Excel button to Test Results' Summary Table view, producing a workbook formatted to match the on-screen table exactly (Project/PD grouping, verdict colors, Improve/Just Right bullet lists)" },
  { version: "3.0.522", date: "2026-09-16", note: "Test Results' Summary Table: moved the Tested date out of the Summary Test column into its own Tested Date column, on-screen and in the Excel export" },
  { version: "3.0.523", date: "2026-09-16", note: "Perform Evaluation wizard: Back/Next Sample/Review now scroll back to the top of the page, instead of opening the next sample's questions still scrolled to wherever the previous page was left" },
  { version: "3.0.524", date: "2026-09-16", note: "Added \"Share External Evaluation\" to Test Results: generate a link + QR code (expires after 24 hours, usable by any number of people at once, no account needed) that opens a standalone evaluate.html survey for that test; incoming guest responses can be reviewed and imported into that test's own Sensory Evaluation with one click" },
  { version: "3.0.525", date: "2026-09-16", note: "Printing a Test Result: hid every other project's own group heading (was showing above/below the one trial being printed) and hid empty fields' placeholder hint text (e.g. \"e.g. Microwave\") and the Translate button, none of which belong on a printed page" },
  { version: "3.0.526", date: "2026-09-16", note: "Share External Evaluation: added Preview (view a guest response, with an Edit + Save to fix it before importing) and Dismiss (keep the response, just stop offering to import it) to each guest response, plus a pending-count badge on the Share External Evaluation button for responses nobody's decided on yet" },
  { version: "3.0.527", date: "2026-09-16", note: "Rebuilt the guest evaluate.html survey to walk through one product per page (Back/Next Sample), same as the Perform Evaluation wizard, ending on a Review page listing every answer with its own Back button so a guest can fix a wrong tap before the one and only Submit" },
  { version: "3.0.528", date: "2026-09-16", note: "Made a Dismissed guest response clickable to undo -- asks for your password first, same as deleting a test result, since restoring it puts it back in front of Import" },
  { version: "3.0.529", date: "2026-09-16", note: "Guest evaluate.html: added the Idea Guideline widget under each JAR question, same as the real Perform Evaluation wizard, and a \"Back to Edit\" button on the Thank You page that returns to the Review page to fix and resend an answer" },
  { version: "3.0.530", date: "2026-09-16", note: "Fixed the password confirmation dialog appearing behind (not in front of) Perform Evaluation / Summary Test / Share External Evaluation / Response Preview when triggered from inside one of them, e.g. undismissing a guest response" },
  { version: "3.0.531", date: "2026-09-16", note: "Optimized the JAR (1-9) and Test Result buttons for narrow phone screens (e.g. 402x873) -- switched from an unevenly-wrapping row to a clean 3x3 grid / single column instead of stretched leftover buttons, and tightened extra empty space above Back/Next Sample" },
  { version: "3.0.532", date: "2026-09-17", note: "Gave the \"Dismissed\" guest response button a gray fill (not white like the other buttons) so its off/inactive state is visible at a glance" },
  { version: "3.0.533", date: "2026-09-17", note: "Per follow-up feedback, changed the JAR (1-9) buttons on narrow phone screens from a 3x3 grid back to one single row (same as desktop), just narrower per button, since 3 rows read as more boxes to scan than a quick 1-9 row" },
  { version: "3.0.534", date: "2026-09-17", note: "Fixed evaluate.html zooming in and staying zoomed after typing into Your Name/Comments/Note on a phone -- iOS Safari auto-zooms any text field smaller than 16px on focus, so those fields are now 16px on narrow screens" },
  { version: "3.0.535", date: "2026-09-17", note: "evaluate.html: pressing and sliding a finger across the 1-9 buttons now scrubs through scores like a slider, instead of needing to lift and re-tap each one" },
  { version: "3.0.536", date: "2026-09-17", note: "Fixed a light-colored band getting stuck on the last button touched after a press-and-drag score selection on a phone -- that was the JAR button's own :hover style, which mobile browsers can leave stuck on after a touch ends; now only applies on real pointer devices (mouse/trackpad)" },
  { version: "3.0.537", date: "2026-09-17", note: "evaluate.html: moved each product's Comments field from its own step page onto the Review page (before Submit), and added an optional reference photo (up to 2 per product) alongside it there" },
  { version: "3.0.538", date: "2026-09-17", note: "Fixed the JAR press-and-drag picking up an ordinary page-scroll that merely passed over the 1-9 buttons and silently changing whatever score was under the finger -- a gesture is no longer treated as a drag until it's clearly moving more horizontally than vertically" },
  { version: "3.0.539", date: "2026-09-17", note: "Perform Evaluation and External Evaluation: consolidated Comments from one-per-product into a single field covering the whole test, asked once on the Review page, and added an optional reference photo there (up to 2) to both" },
  { version: "3.0.540", date: "2026-09-17", note: "Made an already-Imported guest response clickable to remove its scores/comment/photo from the test's results -- asks for your password first, same as Undismiss; the response itself is kept and can be imported again" }
];
const APP_VERSION = CHANGELOG[CHANGELOG.length - 1].version;
const APP_UPDATED = CHANGELOG[CHANGELOG.length - 1].date;

function renderFooter(){
  const el = document.getElementById('appFooter');
  if(!el) return;
  const history = CHANGELOG.slice().reverse()
    .map(c => `v${c.version} (${c.date}): ${c.note}`)
    .join('\n');
  el.title = history;
  el.innerHTML = `
    <span>${escapeHtml(APP_NAME)}</span>
    <span class="fv-version">v${escapeHtml(APP_VERSION)}</span>
    <span class="fv-dot">·</span>
    <span>Last updated ${escapeHtml(APP_UPDATED)}</span>
  `;
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
function accountDisplayFromEmail(email){
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

/* ---------- Trash (recover a deleted Recipe/Ingredient/Product/Project/
   Test Result/Sample Submission within 30 days) ----------
   Fetched fresh with a plain getDocs every time the modal opens rather
   than a persistent onSnapshot listener -- Trash is checked rarely, so
   there's no reason for every session to carry an always-on listener for
   it the way recipes/materials/etc. need. */
let trashItemsCache = [];
async function loadAndRenderTrash(){
  const listEl = document.getElementById('trashList');
  listEl.innerHTML = '<div class="overview-empty">Loading…</div>';
  try{
    const snap = await getDocs(trashCol);
    let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const purgedIds = await purgeExpiredTrash(items);
    if(purgedIds.length) items = items.filter(t => !purgedIds.includes(t.id));
    items.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    trashItemsCache = items;
    renderTrashList(items);
  }catch(err){
    console.error('Forge: loading Trash failed', err);
    listEl.innerHTML = `<div class="overview-empty">Could not load Trash: ${escapeHtml(err.message)}</div>`;
  }
}
function renderTrashList(items){
  const listEl = document.getElementById('trashList');
  if(!items.length){
    listEl.innerHTML = '<div class="overview-empty">Trash is empty</div>';
    return;
  }
  listEl.innerHTML = items.map(t => {
    const typeLabel = (TRASH_COLLECTION_MAP[t.sourceCollection] || {}).label || t.sourceCollection;
    const daysLeft = Math.max(0, Math.ceil((TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000 - (Date.now() - (t.deletedAt || 0))) / (24 * 60 * 60 * 1000)));
    return `
      <div class="trash-row" data-trash-id="${escapeHtml(t.id)}">
        <div class="trash-row-main">
          <div class="trash-row-label"><b>${escapeHtml(t.label)}</b> <span class="trash-row-type">${escapeHtml(typeLabel)}</span></div>
          <div class="trash-row-meta">Deleted by ${escapeHtml(t.deletedBy || 'Unknown')} · ${escapeHtml(formatActivityDateTime(t.deletedAt) || '')} · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left</div>
        </div>
        <button type="button" class="btn btn-sm" data-role="restore-trash">Restore</button>
      </div>
    `;
  }).join('');
  listEl.querySelectorAll('[data-role="restore-trash"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-trash-id]')?.dataset.trashId;
      const t = trashItemsCache.find(x => x.id === id);
      if(!t) return;
      btn.disabled = true;
      btn.textContent = 'Restoring…';
      try{
        await restoreFromTrash(t);
        trashItemsCache = trashItemsCache.filter(x => x.id !== id);
        renderTrashList(trashItemsCache);
      }catch(err){
        console.error('Forge: restore from Trash failed', err);
        alert('Could not restore this item: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Restore';
      }
    });
  });
}
function initTrashModal(){
  function openTrashModal(){
    document.getElementById('navbarAccount').classList.remove('open');
    document.getElementById('trashModalOverlay').classList.add('open');
    loadAndRenderTrash();
  }
  function closeTrashModal(){
    document.getElementById('trashModalOverlay').classList.remove('open');
  }
  document.getElementById('btnOpenTrash').addEventListener('click', openTrashModal);
  document.getElementById('btnCloseTrash').addEventListener('click', closeTrashModal);
  wireModalOverlayClose('trashModalOverlay', closeTrashModal);
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
const LUCIDE_ICONS = {
  'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" />',
  'bell': '<path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />',
  'book-open': '<path d="M12 5v16" /><path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z" />',
  'check': '<path d="M20 6 9 17l-5-5" />',
  'clipboard-check': '<rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="m9 14 2 2 4-4" />',
  'chevron-down': '<path d="m6 9 6 6 6-6" />',
  'chevron-right': '<path d="m9 18 6-6-6-6" />',
  'chevron-up': '<path d="m18 15-6-6-6 6" />',
  'clock': '<circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />',
  'copy': '<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />',
  'download': '<path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" />',
  'eye': '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" />',
  'eye-off': '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" /><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" /><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" /><path d="m2 2 20 20" />',
  'file-text': '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />',
  'flask-conical': '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2" /><path d="M6.453 15h11.094" /><path d="M8.5 2h7" />',
  'folder': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />',
  'git-branch': '<line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />',
  'globe': '<circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />',
  'grip-vertical': '<circle cx="9" cy="5" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="19" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="19" r="1" />',
  'link': '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />',
  'list': '<path d="M3 5h.01" /><path d="M3 12h.01" /><path d="M3 19h.01" /><path d="M8 5h13" /><path d="M8 12h13" /><path d="M8 19h13" />',
  'lock': '<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />',
  'log-out': '<path d="m16 17 5-5-5-5" /><path d="M21 12H9" /><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />',
  'paperclip': '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />',
  'package': '<path d="M16.5 9.4 7.55 4.24" /><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="M3.29 7 12 12l8.71-5" /><path d="M12 22V12" />',
  'menu': '<path d="M4 5h16" /><path d="M4 12h16" /><path d="M4 19h16" />',
  'move': '<path d="M12 2v20" /><path d="m15 19-3 3-3-3" /><path d="m19 9 3 3-3 3" /><path d="M2 12h20" /><path d="m5 9-3 3 3 3" /><path d="m9 5 3-3 3 3" />',
  'party-popper': '<path d="M5.8 11.3 2 22l10.7-3.79" /><path d="M4 3h.01" /><path d="M22 8h.01" /><path d="M15 2h.01" /><path d="M22 20h.01" /><path d="m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10" /><path d="m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17" /><path d="m11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7" /><path d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z" />',
  'pencil': '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" />',
  'plus': '<path d="M5 12h14" /><path d="M12 5v14" />',
  'printer': '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" /><rect x="6" y="14" width="12" height="8" rx="1" />',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />',
  'save': '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /><path d="M7 3v4a1 1 0 0 0 1 1h7" />',
  'share-2': '<circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" x2="15.42" y1="13.51" y2="17.49" /><line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />',
  'sliders-horizontal': '<line x1="21" x2="14" y1="4" y2="4" /><line x1="10" x2="3" y1="4" y2="4" /><line x1="21" x2="12" y1="12" y2="12" /><line x1="8" x2="3" y1="12" y2="12" /><line x1="21" x2="16" y1="20" y2="20" /><line x1="12" x2="3" y1="20" y2="20" /><line x1="14" x2="14" y1="2" y2="6" /><line x1="8" x2="8" y1="10" y2="14" /><line x1="16" x2="16" y1="18" y2="22" />',
  'scale': '<path d="M12 3v18" /><path d="m19 8 3 8a5 5 0 0 1-6 0zV7" /><path d="M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1" /><path d="m5 8 3 8a5 5 0 0 1-6 0zV7" /><path d="M7 21h10" />',
  'trash-2': '<path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />',
  'undo-2': '<path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />',
  'unlock': '<rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" />',
  'users': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />',
  'user': '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />',
  'database': '<ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5V19A9 3 0 0 0 21 19V5" /><path d="M3 12A9 3 0 0 0 21 12" />',
  'upload': '<path d="M12 3v12" /><path d="m17 8-5-5-5 5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />',
  'x': '<path d="M18 6 6 18" /><path d="m6 6 12 12" />'
};
export function icon(name, size){
  const inner = LUCIDE_ICONS[name];
  if(!inner) return '';
  return `<svg class="lucide-icon" width="${size||16}" height="${size||16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

/* ---------- Main render ---------- */
/* Groups items by keyFn into descending counts, keeping only the top
   `limit` labels and folding everything past that into a single "Others"
   bucket — keeps bar lists readable regardless of how many distinct
   countries/customers/reps/materials exist. */
function topGroups(items, keyFn, limit){
  const counts = new Map();
  items.forEach(item => {
    const key = (keyFn(item) || '').trim();
    if(!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const sorted = [...counts.entries()].sort((a,b) => b[1] - a[1]);
  const top = sorted.slice(0, limit);
  const othersCount = sorted.slice(limit).reduce((s,[,c]) => s + c, 0);
  if(othersCount > 0) top.push(['Others', othersCount]);
  return top.map(([label,count]) => ({ label, count }));
}

/* Trial evaluation scores are free text (e.g. "8/9") rather than a fixed
   scale, so only entries that actually match a number/number pattern can
   be turned into a comparable ratio — anything else is silently skipped. */
function parseScoreRatio(s){
  const m = String(s || '').trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if(!m) return null;
  const num = parseFloat(m[1]), den = parseFloat(m[2]);
  if(!den) return null;
  return num / den;
}

// Trial Results (see v3.0.223) replaced the old freeform "N/M" evaluation
// score with a fixed Accepted/Not accepted Test Result per product — a
// trial made after that rework has no `evaluation` scores to read any
// more, so this prefers the new field (acceptance rate) and only falls
// back to the legacy ratio for trials from before the format changed, so
// the trend below doesn't just go permanently blank from that point on.
function trialAvgScoreRatio(t){
  const results = Object.values(t.productData || {}).map(pd => pd.testResult).filter(Boolean);
  if(results.length){
    return results.filter(r => r === 'Accepted').length / results.length;
  }
  const ratios = (t.evaluation || []).map(e => parseScoreRatio(e.score)).filter(v => v !== null);
  if(!ratios.length) return null;
  return ratios.reduce((s,v) => s+v, 0) / ratios.length;
}

function computeDashboardData(){
  const now = Date.now();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  const nowDate = new Date();
  const curMonth = nowDate.getMonth(), curYear = nowDate.getFullYear();

  const newThisMonth = recipes.filter(r => r.createdAt &&
    new Date(r.createdAt).getMonth() === curMonth && new Date(r.createdAt).getFullYear() === curYear).length;
  const updatedThisWeek = recipes.filter(r => r.updatedAt && (now - r.updatedAt) <= oneWeekMs).length;

  const yields = recipes.map(r => parseFloat(r.yieldPct)).filter(v => !isNaN(v));
  const avgYield = yields.length ? yields.reduce((s,v) => s+v, 0) / yields.length : null;

  const totalVersions = recipes.reduce((s,r) => s + (Array.isArray(r.versions) ? r.versions.length : 0), 0);

  // Sourced from Projects (not recipes) — Destination Country now lives on
  // the Project since recipes link to a Project instead of carrying their
  // own copy of it (see findProjectForRecipe). Uncapped (no "Others" bucket)
  // since the world-map card plots every country individually.
  const byCountry = topGroups(projects, p => p.destinationCountry, 999);
  const byCustomer = topGroups(recipes, r => r.customerName, 4);
  const bySalesRep = topGroups(recipes, r => r.salesRep, 4);

  const allIngredientRows = recipes.flatMap(r => allIngredientsInRecipe(r));
  const materialUsage = topGroups(allIngredientRows, ing => {
    if(ing.materialId){
      const m = ingredientMaster.find(x => x.id === ing.materialId);
      if(m) return m.nameEn;
    }
    return ing.name;
  }, 5);

  const mostIterated = [...recipes]
    .filter(r => Array.isArray(r.versions) && r.versions.length > 0)
    .sort((a,b) => b.versions.length - a.versions.length)
    .slice(0, 3)
    .map(r => ({ label: recipeDisplayLabel(r), count: r.versions.length }));

  const recentMaterials = [...ingredientMaster]
    .filter(m => m.createdAt)
    .sort((a,b) => b.createdAt - a.createdAt)
    .slice(0, 3);

  const recentActivity = [...recipes]
    .filter(r => r.updatedAt)
    .sort((a,b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);

  const months = [];
  for(let i = 5; i >= 0; i--){
    const d = new Date(curYear, curMonth - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth(), label: d.toLocaleString('en-US',{month:'short'}) });
  }
  const perTrialScore = trials.map(t => ({ t, ratio: trialAvgScoreRatio(t) })).filter(x => x.ratio !== null);
  const trend = months.map(mo => {
    const inMonth = perTrialScore.filter(({t}) => {
      const basis = t.createdAt ? new Date(t.createdAt) : null;
      return basis && basis.getFullYear() === mo.year && basis.getMonth() === mo.month;
    });
    const avg = inMonth.length ? inMonth.reduce((s,{ratio}) => s+ratio, 0) / inMonth.length : null;
    return { label: mo.label, avg };
  });
  const avgTrialScorePct = perTrialScore.length
    ? Math.round(perTrialScore.reduce((s,x) => s+x.ratio, 0) / perTrialScore.length * 100)
    : null;

  const allProducts = projects.flatMap(p => p.products || []);
  // Kept in pipeline order (Requested -> ... -> Cancelled) rather than
  // sorted by count — for a stage funnel, the natural sequence matters more
  // than which stage currently has the most products.
  const productsByStage = PROJECT_STAGES
    .map(stage => ({ label: stage, count: allProducts.filter(prod => prod.stage === stage).length }))
    .filter(g => g.count > 0);

  const recentProjects = [...projects]
    .filter(p => p.updatedAt)
    .sort((a,b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);

  const activeProjectsCount = projects.filter(p => p.status === 'In Progress').length;
  const inReviewProjectsCount = projects.filter(p => p.status === 'In Review').length;
  const updatedThisWeekAll = updatedThisWeek
    + projects.filter(p => p.updatedAt && (now - p.updatedAt) <= oneWeekMs).length
    + trials.filter(t => t.updatedAt && (now - t.updatedAt) <= oneWeekMs).length;

  const topActiveProjects = projects
    .filter(p => p.status === 'In Progress')
    .sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0))
    .slice(0, 5);

  // A single merged feed across all 3 editable record types, newest first —
  // there's no "recently opened" tracking anywhere in Forge, so this is
  // built from real edit timestamps instead of fabricating a view-history
  // feature that doesn't exist.
  const mergedRecentActivity = [
    ...recipes.filter(r => r.updatedAt).map(r => ({ type: 'recipe', icon: 'file-text', id: r.id, name: recipeDisplayLabel(r), updatedAt: r.updatedAt })),
    ...projects.filter(p => p.updatedAt).map(p => ({ type: 'project', icon: 'folder', id: p.id, name: p.name || 'Untitled project', updatedAt: p.updatedAt })),
    ...trials.filter(t => t.updatedAt).map(t => ({ type: 'trial', icon: 'flask-conical', id: t.id, name: (t.recipeIds||[]).map(id => recipes.find(r=>r.id===id)).filter(Boolean).map(recipeDisplayLabel).join(', ') || 'Untitled test', updatedAt: t.updatedAt }))
  ].sort((a,b) => b.updatedAt - a.updatedAt).slice(0, 5);

  return {
    totalRecipes: recipes.length, totalMaterials: ingredientMaster.length, totalProjects: projects.length,
    newThisMonth, updatedThisWeek, avgYield, totalVersions,
    byCountry, byCustomer, bySalesRep, materialUsage, mostIterated, recentMaterials, recentActivity,
    trend, avgTrialScorePct, productsByStage, recentProjects,
    activeProjectsCount, inReviewProjectsCount, updatedThisWeekAll, topActiveProjects, mergedRecentActivity
  };
}

export function renderBarList(groups, altClass){
  if(!groups.length) return '<div class="dash-empty">No data yet</div>';
  const max = Math.max(...groups.map(g => g.count));
  return groups.map(g => `
    <div class="dash-bar-item">
      <div class="dash-bar-label-row"><span>${escapeHtml(g.label)}</span><span class="dbl-count">${g.count}</span></div>
      <div class="dash-bar-track"><div class="dash-bar-fill${altClass ? ' '+altClass : ''}" style="width:${Math.max(4, Math.round(g.count/max*100))}%"></div></div>
    </div>
  `).join('');
}


// Same flag-badge component used on the Reference Lists page (see
// countryFlagBadgeHtml), reused here so a country reads the same way in
// both places — a ranked bar list rather than a map, sized/ordered by
// project count (topGroups already sorts descending).
function renderCountryBarList(groups){
  if(!groups.length) return '<div class="dash-empty">No data yet</div>';
  const max = Math.max(...groups.map(g => g.count));
  return groups.map(g => {
    const shortLabel = g.label.replace(/\([^)]*\)/g, '').trim() || g.label;
    return `
      <div class="dash-country-row">
        ${countryFlagBadgeHtml(g.label)}
        <div class="dash-country-main">
          <div class="dash-bar-label-row"><span>${escapeHtml(shortLabel)}</span><span class="dbl-count">${g.count}</span></div>
          <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${Math.max(4, Math.round(g.count/max*100))}%"></div></div>
        </div>
      </div>
    `;
  }).join('');
}

// Real, derivable "needs attention" signals — deliberately NOT a fabricated
// due-date/task system (Forge has no due-date field anywhere), just honest
// gaps in data that already exists: projects with no products yet, trials
// nobody has scored, active projects missing this month's update, and
// materials with no price on file (which silently breaks Compare Costing).
// Sorted by severity so the dashboard card can show the most pressing first.
const ACTION_SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
function computeActionItems(){
  const items = [];
  projects.forEach(p => {
    if(!(p.products || []).length){
      items.push({ severity: 'high', title: 'Add a product to this project', subjectIcon: 'folder', subject: p.name || 'Untitled project', itemType: 'project', itemId: p.id });
    }
  });
  trials.forEach(t => {
    if((t.recipeIds || []).length && trialAvgScoreRatio(t) === null){
      const label = (t.recipeIds || []).map(id => recipes.find(r => r.id === id)).filter(Boolean).map(recipeDisplayLabel).join(', ') || 'Untitled test';
      items.push({ severity: 'medium', title: 'Score this test', subjectIcon: 'flask-conical', subject: label, itemType: 'trial', itemId: t.id });
    }
  });
  projects.forEach(p => {
    if(p.status === 'In Progress' && (p.products || []).length && !projectHasUpdateThisMonth(p)){
      items.push({ severity: 'medium', title: "Add this month's update", subjectIcon: 'folder', subject: p.name || 'Untitled project', itemType: 'project', itemId: p.id });
    }
  });
  ingredientMaster.forEach(m => {
    if(m.price === '' || m.price == null){
      items.push({ severity: 'low', title: 'Add a price', subjectIcon: 'book-open', subject: m.nameEn || 'Untitled material', itemType: 'material', itemId: m.id });
    }
  });
  return items.sort((a, b) => ACTION_SEVERITY_ORDER[a.severity] - ACTION_SEVERITY_ORDER[b.severity]);
}

// Cross-project view of open tasks — every Activities Updates entry that's
// still "planned" (see monthlyUpdateStatus: no Action Taken recorded yet)
// has a Plan and a date, which together are exactly "a task with a due
// date." Reuses that data instead of a separate task system, bucketed by
// how urgent the date is so a project manager can see what's overdue or
// coming up without opening every project one at a time.
function computeTaskTracking(){
  const todayStr = new Date().toISOString().slice(0, 10);
  const soonCutoffDate = new Date();
  soonCutoffDate.setDate(soonCutoffDate.getDate() + 7);
  const soonCutoffStr = soonCutoffDate.toISOString().slice(0, 10);

  const overdue = [], dueToday = [], dueSoon = [], completedToday = [];
  projects.forEach(p => {
    (p.monthlyUpdates || []).map(migrateMonthlyUpdate).forEach(mu => {
      if(!mu.date) return;
      if(!isMyActivity(p, mu)) return;
      // Uses the entry's own Completed Date (see resolveMuCompletedDate),
      // not its due date — a task logged today that was actually finished
      // yesterday shows up under yesterday, not here, once that date is
      // corrected on the entry itself.
      if(monthlyUpdateStatus(mu) === 'logged'){
        if(mu.completedDate === todayStr){
          // planText set (Task Tracking's other 3 lists never set it) is
          // what tells taskRowHtml to show the Plan → Done two-line format
          // instead of a single line — so it's clear what was asked for
          // and what actually got done, not just the end result alone.
          completedToday.push({ projectId: p.id, projectName: p.name || 'Untitled project', projectImage: p.image || '', text: mu.actionTaken || mu.plan || 'Untitled task', planText: muPlanSummaryLine(mu), date: mu.date, who: mu.planWho || '' });
        }
        return;
      }
      const task = { projectId: p.id, projectName: p.name || 'Untitled project', projectImage: p.image || '', text: muPlanSummaryLine(mu) || 'Untitled task', date: mu.date, who: mu.planWho || '' };
      if(mu.date < todayStr) overdue.push(task);
      else if(mu.date === todayStr) dueToday.push(task);
      else if(mu.date <= soonCutoffStr) dueSoon.push(task);
    });
  });
  overdue.sort((a, b) => a.date.localeCompare(b.date));
  dueSoon.sort((a, b) => a.date.localeCompare(b.date));
  return { overdue, dueToday, dueSoon, completedToday };
}

// Tracks which date the Home dashboard's Activities Calendar is currently
// showing — which fields of it matter depends on homeCalendarViewMode
// (e.g. Month view only reads year/month, Day view reads the full date).
// Reset to today by the Today button; otherwise carried forward across
// re-renders so paging doesn't snap back to the current period every time
// something else on the dashboard changes.
let homeCalendarViewDate = new Date();
// One of 'day' | 'week' | 'month' | 'year' — same carry-forward-across-
// re-renders treatment as homeCalendarViewDate, right above.
let homeCalendarViewMode = 'month';
// Which people's events the calendar shows — a Set of mu.planWho values,
// empty meaning "everyone" — plus whether its checklist popover is open.
// Same pattern (and carry-forward treatment) as Task Tracking's own Who
// filter (taskTrackingWhoFilters/taskTrackingWhoMenuOpen below); kept as
// a separate Set since filtering the calendar to one person shouldn't
// also filter the Task Tracking lists, or vice versa.
let homeCalendarWhoFilters = new Set();
let homeCalendarWhoMenuOpen = false;
// Stand-in for '' (no planWho) in the Who filter's Set/checkbox values --
// an actual empty string is awkward to carry through a checkbox's value
// attribute and back reliably, and doubles as a value CAL_WHO_UNASSIGNED
// itself would never collide with a real person's name.
const CAL_WHO_UNASSIGNED = '__unassigned__';
// A pane's "show everyone" <select> value -- same reasoning as
// CAL_WHO_UNASSIGNED above (an empty <option value=""> is easy to
// mishandle), kept as a separate sentinel from it since they mean
// opposite things (all vs. specifically nobody).
const CAL_PANE_ALL = '__all__';
// Side-by-side calendar "windows", each independently showing one
// person's events (or everyone's) so a few people can be monitored at a
// glance -- they all share the same nav (homeCalendarViewDate) and view
// mode (homeCalendarViewMode) above, only the person shown differs per
// pane. Starts with a single All pane, which alone renders identically
// to the old single-calendar layout; +Add window appends more.
let homeCalendarPanes = [{ id: 'cal-pane-default', who: CAL_PANE_ALL }];

// Task Tracking's Who filter — a Set of names (empty Set means "all"),
// since more than one person can be selected at once. Carried forward
// across re-renders (dashboard stat card clicks, calendar paging, etc.)
// the same way homeCalendarViewDate is, so picking a filter doesn't get
// silently reset by an unrelated dashboard refresh.
let taskTrackingWhoFilters = new Set();
// Whether the Who filter's checklist popover is currently open — kept as
// its own flag (rather than a pure DOM class toggle) so it survives the
// full refreshDashboardHome() re-render a checkbox click triggers, same
// pattern as openProjectFilterMenuKey for the Projects table's column
// filters.
let taskTrackingWhoMenuOpen = false;

// Every Activities Update with a due date, across every project — same
// source Task Tracking reads (see computeTaskTracking), just not filtered
// down to planned/overdue/soon since the calendar shows a whole month at
// once regardless of status.
function computeCalendarEvents(){
  const events = [];
  projects.forEach(p => {
    (p.monthlyUpdates || []).map(migrateMonthlyUpdate).forEach(mu => {
      if(!mu.date) return;
      if(!isMyActivity(p, mu)) return;
      events.push({
        projectId: p.id,
        projectName: p.name || 'Untitled project',
        text: muPlanSummaryLine(mu) || mu.actionTaken || 'Untitled task',
        date: mu.date,
        who: mu.planWho || '',
        // Added via an empty-cell click and not yet moved to a real
        // project (see quickAddCalendarPlan) -- flagged so the chip can
        // show a distinct marker (dashed border, see calEventChipHtml)
        // for "still needs a project", without touching the existing
        // status colors (overdue/today/upcoming/completed) it's shown
        // alongside.
        isUnassigned: !!p.isUnassignedBucket,
        mu
      });
    });
  });
  return events;
}
// Builds a date string from a Date's own local Y/M/D components — never
// through toISOString() here, since that converts local midnight to UTC
// and can silently shift the date backward a day in positive-offset
// timezones. mu.date itself is already a plain "YYYY-MM-DD" string (from a
// <input type=date>, no timezone attached), so this has to match that
// exactly for day cells to line up with the right events.
function calGridDateStr(d){
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const CAL_DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CAL_VIEW_MODES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
function calWeekStart(d){
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
}
// Prev/Next steps by a whole period at once — which one depends on
// whatever view is currently showing, so Month view still pages by
// month, Week view by week, etc.
function calStepView(date, mode, dir){
  const d = new Date(date);
  if(mode === 'day') d.setDate(d.getDate() + dir);
  else if(mode === 'week') d.setDate(d.getDate() + dir * 7);
  else if(mode === 'year') d.setFullYear(d.getFullYear() + dir);
  else d.setMonth(d.getMonth() + dir);
  return d;
}
function calHeaderLabel(viewDate, mode){
  if(mode === 'day') return viewDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if(mode === 'year') return String(viewDate.getFullYear());
  if(mode === 'week'){
    const start = calWeekStart(viewDate);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    // toLocaleDateString with {day, year} but no month isn't a reliably
    // supported Intl combination (some ICU builds return garbled output
    // for it) -- build the same-month "22, 2026" tail by hand instead.
    const endLabel = sameMonth
      ? `${end.getDate()}, ${end.getFullYear()}`
      : end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${startLabel} – ${endLabel}`;
  }
  return viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
// Shared by Month/Week views -- one day's worth of event chips, each
// opening the project's Activities Updates on click, with a hover
// tooltip carrying the full project name + text (see .cal-event-tooltip)
// since the chip itself truncates to fit the cell.
function calEventChipHtml(ev, todayStr){
  const status = getTaskStatus(ev.mu, todayStr);
  return `
    <div class="cal-event-wrap">
      <button type="button" class="cal-event cal-event-${status}${ev.isUnassigned ? ' cal-event-unassigned' : ''} action-go-btn" data-item-type="project" data-item-id="${escapeHtml(ev.projectId)}" data-focus-section="activities">${escapeHtml(ev.text)}</button>
      <div class="cal-event-tooltip"><b>${escapeHtml(ev.projectName)}</b><br>${escapeHtml(ev.text)}${ev.isUnassigned ? '<br><i>Not yet on a project</i>' : ''}</div>
    </div>
  `;
}
function renderCalMonthGrid(viewDate, eventsByDate, todayStr){
  const year = viewDate.getFullYear(), month = viewDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startDow = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;
  const gridStart = new Date(year, month, 1 - startDow);

  let cellsHtml = '';
  for(let i = 0; i < totalCells; i++){
    const cellDate = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const dStr = calGridDateStr(cellDate);
    const inMonth = cellDate.getMonth() === month;
    const isToday = dStr === todayStr;
    const dayEvents = (eventsByDate[dStr] || []).sort((a, b) => (a.projectName || '').localeCompare(b.projectName || ''));
    const dayLabel = cellDate.getDate() === 1
      ? `${cellDate.toLocaleDateString('en-US', { month: 'short' })} ${cellDate.getDate()}`
      : String(cellDate.getDate());
    cellsHtml += `
      <div class="cal-cell cal-cell-clickable${inMonth ? '' : ' cal-cell-outmonth'}${isToday ? ' cal-cell-today' : ''}" data-cal-date="${dStr}">
        <div class="cal-cell-date">${escapeHtml(dayLabel)}</div>
        <div class="cal-cell-events">${dayEvents.map(ev => calEventChipHtml(ev, todayStr)).join('')}</div>
      </div>
    `;
  }
  return `
    <div class="cal-dow-row">${CAL_DOW_NAMES.map(n => `<div class="cal-dow">${n}</div>`).join('')}</div>
    <div class="cal-grid">${cellsHtml}</div>
  `;
}
// One row, one week -- same cell markup as Month view (taller, via
// .cal-grid-week) so a busier week has more room per day to show text
// instead of truncating as aggressively.
function renderCalWeekGrid(viewDate, eventsByDate, todayStr){
  const start = calWeekStart(viewDate);
  let cellsHtml = '';
  for(let i = 0; i < 7; i++){
    const cellDate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const dStr = calGridDateStr(cellDate);
    const isToday = dStr === todayStr;
    const dayEvents = (eventsByDate[dStr] || []).sort((a, b) => (a.projectName || '').localeCompare(b.projectName || ''));
    cellsHtml += `
      <div class="cal-cell cal-cell-clickable${isToday ? ' cal-cell-today' : ''}" data-cal-date="${dStr}">
        <div class="cal-cell-date">${escapeHtml(cellDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</div>
        <div class="cal-cell-events">${dayEvents.map(ev => calEventChipHtml(ev, todayStr)).join('')}</div>
      </div>
    `;
  }
  return `
    <div class="cal-dow-row">${CAL_DOW_NAMES.map(n => `<div class="cal-dow">${n}</div>`).join('')}</div>
    <div class="cal-grid cal-grid-week">${cellsHtml}</div>
  `;
}
// A single day's events as a plain agenda list -- there's only one day's
// worth of room to fill, so full project name + text both show without
// needing the Month/Week chip's hover tooltip.
function renderCalDayAgenda(viewDate, eventsByDate, todayStr){
  const dStr = calGridDateStr(viewDate);
  const dayEvents = (eventsByDate[dStr] || []).sort((a, b) => (a.projectName || '').localeCompare(b.projectName || ''));
  const addBtnHtml = `<button type="button" class="btn btn-sm cal-day-add-btn" data-cal-date="${dStr}">${icon('plus', 14)} Add Plan</button>`;
  if(!dayEvents.length) return `<div class="cal-day-agenda-empty">No activities on this day${addBtnHtml}</div>`;
  return `
    <div class="cal-day-agenda">
      ${dayEvents.map(ev => {
        const status = getTaskStatus(ev.mu, todayStr);
        return `
          <button type="button" class="cal-day-event cal-day-event-${status}${ev.isUnassigned ? ' cal-day-event-unassigned' : ''} action-go-btn" data-item-type="project" data-item-id="${escapeHtml(ev.projectId)}" data-focus-section="activities">
            <span class="cal-day-event-project">${escapeHtml(ev.projectName)}${ev.isUnassigned ? ' <i>(no project yet)</i>' : ''}</span>
            <span class="cal-day-event-text">${escapeHtml(ev.text)}</span>
          </button>
        `;
      }).join('')}
      ${addBtnHtml}
    </div>
  `;
}
// 12 read-only mini-months, each day just a dot for "something's due"
// rather than real event chips (nowhere near enough room to show text at
// this scale) -- click a month to jump into Month view for it.
function renderCalYearGrid(viewDate, eventsByDate){
  const year = viewDate.getFullYear();
  let monthsHtml = '';
  for(let m = 0; m < 12; m++){
    const firstOfMonth = new Date(year, m, 1);
    const startDow = firstOfMonth.getDay();
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;
    const gridStart = new Date(year, m, 1 - startDow);
    let dayCellsHtml = '';
    for(let i = 0; i < totalCells; i++){
      const cellDate = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const inMonth = cellDate.getMonth() === m;
      const hasEvents = inMonth && (eventsByDate[calGridDateStr(cellDate)] || []).length > 0;
      dayCellsHtml += `<div class="cal-mini-cell${inMonth ? '' : ' cal-mini-cell-outmonth'}${hasEvents ? ' cal-mini-cell-has-events' : ''}">${inMonth ? cellDate.getDate() : ''}</div>`;
    }
    monthsHtml += `
      <button type="button" class="cal-mini-month" data-cal-jump-month="${m}">
        <div class="cal-mini-month-title">${escapeHtml(firstOfMonth.toLocaleDateString('en-US', { month: 'long' }))}</div>
        <div class="cal-mini-grid">${dayCellsHtml}</div>
      </button>
    `;
  }
  return `<div class="cal-year-grid">${monthsHtml}</div>`;
}
// One pane's <select> options: All, then every named person, then
// Unassigned if there's anyone to show there -- same three-way split
// renderCalendarCardHtml's Who filter already uses.
function renderCalPaneWhoOptionsHtml(selected, namedWhoOptions, hasUnassignedEvents){
  return `
    <option value="${CAL_PANE_ALL}" ${selected === CAL_PANE_ALL ? 'selected' : ''}>All</option>
    ${namedWhoOptions.map(w => `<option value="${escapeHtml(w)}" ${selected === w ? 'selected' : ''}>${escapeHtml(w)}</option>`).join('')}
    ${hasUnassignedEvents ? `<option value="${CAL_WHO_UNASSIGNED}" ${selected === CAL_WHO_UNASSIGNED ? 'selected' : ''}>Unassigned</option>` : ''}
  `;
}
// filteredEvents has already been through the shared Who checklist filter
// above -- a pane just narrows that further to the one person (or
// Unassigned, or nobody further narrowed at all for All) it's set to.
function renderCalPaneHtml(pane, viewDate, filteredEvents, mode, todayStr, namedWhoOptions, hasUnassignedEvents, canRemove){
  const paneEvents = pane.who === CAL_PANE_ALL
    ? filteredEvents
    : filteredEvents.filter(ev => (ev.who || CAL_WHO_UNASSIGNED) === pane.who);
  const eventsByDate = {};
  paneEvents.forEach(ev => {
    (eventsByDate[ev.date] || (eventsByDate[ev.date] = [])).push(ev);
  });
  const bodyHtml = mode === 'day' ? renderCalDayAgenda(viewDate, eventsByDate, todayStr)
    : mode === 'week' ? renderCalWeekGrid(viewDate, eventsByDate, todayStr)
    : mode === 'year' ? renderCalYearGrid(viewDate, eventsByDate)
    : renderCalMonthGrid(viewDate, eventsByDate, todayStr);
  return `
    <div class="cal-pane${pane.expanded ? ' cal-pane-expanded' : ''}">
      <div class="cal-pane-header">
        <select class="cal-pane-who-select" data-cal-pane-id="${escapeHtml(pane.id)}">
          ${renderCalPaneWhoOptionsHtml(pane.who, namedWhoOptions, hasUnassignedEvents)}
        </select>
        <button type="button" class="icon-btn cal-pane-expand-toggle" data-cal-pane-id="${escapeHtml(pane.id)}" title="${pane.expanded ? 'Restore to half width' : 'Expand to full width'}">${pane.expanded ? '⤡' : '⤢'}</button>
        ${canRemove ? `<button type="button" class="icon-btn cal-pane-remove" data-cal-pane-id="${escapeHtml(pane.id)}" title="Remove this window">${icon('x', 14)}</button>` : ''}
      </div>
      ${bodyHtml}
    </div>
  `;
}
function renderCalendarCardHtml(viewDate, events){
  // Matches the rest of the app's existing (if imperfect in far-west
  // timezones) "today" convention — see getTaskStatus/computeTaskTracking
  // — so a task the calendar colors as overdue agrees with Task Tracking.
  const todayStr = new Date().toISOString().slice(0, 10);
  const mode = homeCalendarViewMode;
  // Options list comes from *every* event, before filtering -- same as
  // Task Tracking's Who options -- so picking one person doesn't make
  // the others disappear from the list. Events with no assignee get their
  // own checkbox too (CAL_WHO_UNASSIGNED stands in for '' as the Set
  // member/checkbox value, since an empty checkbox value is awkward to
  // read back reliably) rather than just being dropped from the filter
  // entirely.
  const namedWhoOptions = [...new Set(events.map(ev => ev.who).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const hasUnassignedEvents = events.some(ev => !ev.who);
  const allWhoValues = hasUnassignedEvents ? [...namedWhoOptions, CAL_WHO_UNASSIGNED] : namedWhoOptions;
  const allWhoSelected = allWhoValues.length > 0 && allWhoValues.every(v => homeCalendarWhoFilters.has(v));
  const filteredEvents = homeCalendarWhoFilters.size
    ? events.filter(ev => homeCalendarWhoFilters.has(ev.who || CAL_WHO_UNASSIGNED))
    : events;

  const panesHtml = homeCalendarPanes.map(pane =>
    renderCalPaneHtml(pane, viewDate, filteredEvents, mode, todayStr, namedWhoOptions, hasUnassignedEvents, homeCalendarPanes.length > 1)
  ).join('');

  return `
    <div class="dash-card" id="activitiesCalendarCard" style="margin-bottom:14px;">
      <div class="cal-header-bar">
        <div class="dash-card-title" style="margin-bottom:0;">Activities Calendar</div>
        <div class="cal-nav">
          <div class="task-tracking-who-filter-wrap">
            <button type="button" class="btn btn-sm${homeCalendarWhoFilters.size ? ' active' : ''}" id="calWhoTrigger">
              Who${homeCalendarWhoFilters.size ? ` (${homeCalendarWhoFilters.size})` : ''} ${icon('chevron-down', 12)}
            </button>
            <div class="proj-col-filter-menu${homeCalendarWhoMenuOpen ? ' open' : ''}" id="calWhoMenu">
              ${allWhoValues.length ? `
              <label class="proj-col-filter-item proj-col-filter-selectall">
                <input type="checkbox" id="calWhoSelectAll" ${allWhoSelected ? 'checked' : ''}>
                <b>(Select All)</b>
              </label>
              <div class="proj-col-filter-values">
                ${namedWhoOptions.map(w => `
                  <label class="proj-col-filter-item">
                    <input type="checkbox" class="cal-who-cb" value="${escapeHtml(w)}" ${homeCalendarWhoFilters.has(w) ? 'checked' : ''}>
                    ${escapeHtml(w)}
                  </label>
                `).join('')}
                ${hasUnassignedEvents ? `
                  <label class="proj-col-filter-item">
                    <input type="checkbox" class="cal-who-cb" value="${CAL_WHO_UNASSIGNED}" ${homeCalendarWhoFilters.has(CAL_WHO_UNASSIGNED) ? 'checked' : ''}>
                    Unassigned
                  </label>
                ` : ''}
              </div>
              ${homeCalendarWhoFilters.size ? `<button type="button" class="btn btn-sm" id="calClearWhoFilters" style="margin-top:6px;width:100%;">Clear filter</button>` : ''}
              ` : `<div class="dash-empty" style="padding:4px;">No one assigned yet</div>`}
            </div>
          </div>
          <div class="cal-view-switch">
            ${CAL_VIEW_MODES.map(([key, label]) => `<button type="button" class="cal-view-btn${mode === key ? ' active' : ''}" data-cal-view="${key}">${label}</button>`).join('')}
          </div>
          <button type="button" class="btn btn-sm" id="calToday">Today</button>
          <button type="button" class="icon-btn" id="calPrevPeriod" title="Previous">‹</button>
          <span class="cal-month-label">${escapeHtml(calHeaderLabel(viewDate, mode))}</span>
          <button type="button" class="icon-btn" id="calNextPeriod" title="Next">›</button>
        </div>
      </div>
      <div class="cal-panes-grid${homeCalendarPanes.length === 1 ? ' cal-panes-grid-single' : ''}">${panesHtml}</div>
      <button type="button" class="btn btn-sm cal-add-pane-btn" id="calAddPane">${icon('plus', 14)} Add window</button>
    </div>
  `;
}

function renderDashboardHome(){
  const d = computeDashboardData();
  const actionItems = computeActionItems();
  const taskTracking = computeTaskTracking();
  // The Who filter's option list is built from every task currently on the
  // board (all 4 lists, before filtering) — so selecting one person never
  // makes the others disappear from the toggle row.
  const allTaskTrackingItems = [...taskTracking.overdue, ...taskTracking.dueToday, ...taskTracking.dueSoon, ...taskTracking.completedToday];
  const taskTrackingWhoOptions = [...new Set(allTaskTrackingItems.map(t => t.who).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const taskTrackingMatchesFilter = t => !taskTrackingWhoFilters.size || taskTrackingWhoFilters.has(t.who);
  taskTracking.overdue = taskTracking.overdue.filter(taskTrackingMatchesFilter);
  taskTracking.dueToday = taskTracking.dueToday.filter(taskTrackingMatchesFilter);
  taskTracking.dueSoon = taskTracking.dueSoon.filter(taskTrackingMatchesFilter);
  taskTracking.completedToday = taskTracking.completedToday.filter(taskTrackingMatchesFilter);

  const metrics = [
    { label:'Recipes', value:d.totalRecipes },
    { label:'Projects', value:d.totalProjects },
    { label:'Materials', value:d.totalMaterials },
    { label:'New this month', value:d.newThisMonth },
    { label:'Avg yield', value:d.avgYield != null ? `${d.avgYield.toFixed(1)}<span class="dm-suffix">%</span>` : '-' },
    { label:'Versions saved', value:d.totalVersions }
  ];

  const trendMax = Math.max(0.0001, ...d.trend.map(t => t.avg || 0));
  const trendHtml = d.trend.map((t,i) => `
    <div class="dash-trend-bar-wrap">
      <div class="dash-trend-bar${i === d.trend.length-1 ? ' current' : ''}" style="height:${t.avg != null ? Math.max(4, Math.round(t.avg/trendMax*100)) : 2}%"></div>
      <div class="dash-trend-label">${escapeHtml(t.label)}</div>
    </div>
  `).join('');

  const recentMaterialsHtml = d.recentMaterials.length
    ? d.recentMaterials.map(m => `<div class="dash-list-row"><span>${escapeHtml(m.nameEn || 'Untitled')}</span><span class="dbl-count">${escapeHtml(formatActivityDateTime(m.createdAt) || '')}</span></div>`).join('')
    : '<div class="dash-empty">No materials yet</div>';

  const mostIteratedHtml = d.mostIterated.length
    ? d.mostIterated.map(x => `<div class="dash-list-row"><span>${escapeHtml(x.label)}</span><span class="dbl-count">${x.count} version${x.count === 1 ? '' : 's'}</span></div>`).join('')
    : '<div class="dash-empty">No saved versions yet</div>';

  const { name: greetingName } = accountDisplayFromEmail(currentUser?.email);
  const todayLabel = new Date().toLocaleDateString('en-US', { day:'numeric', month:'long', year:'numeric' });

  const statCards = [
    { icon:'folder', label:'Active Projects', value:d.activeProjectsCount, action:'filter-in-progress' },
    { icon:'clipboard-check', label:'Pending Review', value:d.inReviewProjectsCount, action:'filter-in-review' },
    { icon:'alert-triangle', label:'Needs Attention', value:actionItems.length, action:'scroll-attention' },
    { icon:'refresh-cw', label:'Updated This Week', value:d.updatedThisWeekAll, action:'scroll-activity' }
  ];
  const statCardsHtml = statCards.map(s => `
    <button type="button" class="hd2-stat-card" data-stat-action="${s.action}">
      <span class="hd2-stat-icon">${icon(s.icon, 20)}</span>
      <span class="hd2-stat-text">
        <span class="hd2-stat-label">${escapeHtml(s.label)}</span>
        <span class="hd2-stat-value">${s.value}</span>
      </span>
      <span class="hd2-stat-arrow">${icon('chevron-right', 16)}</span>
    </button>
  `).join('');

  // These are honest data gaps (missing products/scores/updates/prices),
  // not date-driven — see computeActionItems() for exactly what each one
  // checks. Actual due-date tracking lives in Task Tracking below instead
  // (see computeTaskTracking), sourced from Activities Updates' Next
  // Action due dates rather than being a separate fabricated system.
  const SEVERITY_DOT_COLOR = { high:'var(--danger)', medium:'var(--accent)', low:'var(--text-dim)' };
  const taskRowHtml = t => `
    <div class="task-tracking-row action-go-btn" data-item-type="project" data-item-id="${escapeHtml(t.projectId)}" data-focus-section="activities">
      ${t.projectImage
        ? `<img class="task-tracking-thumb" src="${escapeHtml(t.projectImage)}" alt="">`
        : `<span class="task-tracking-thumb task-tracking-thumb-empty">${icon('folder', 14)}</span>`}
      <div class="task-tracking-body">
        ${t.planText ? `
          <div class="task-tracking-plan-line"><span class="task-tracking-line-label">Plan:</span> ${escapeHtml(t.planText)}</div>
          <div class="task-tracking-done-line"><span class="task-tracking-line-label">Done:</span> ${escapeHtml(t.text)}</div>
        ` : `<div class="task-tracking-text">${escapeHtml(t.text)}</div>`}
        <div class="task-tracking-meta">${icon('folder', 12)} ${escapeHtml(t.projectName)}</div>
      </div>
    </div>
  `;
  // Items already arrive sorted by date (see computeTaskTracking), so a
  // group heading only needs to go in front of each run of same-date
  // items — the per-row date this replaced was repeating the same date
  // over and over down a run, this says it once per group instead.
  const taskTrackingTodayStr = new Date().toISOString().slice(0, 10);
  const taskColumnItemsHtml = (items, showOverdueDays) => {
    let html = '', lastDate = null;
    items.forEach(t => {
      if(t.date !== lastDate){
        const overdueDayCount = daysBetween(t.date, taskTrackingTodayStr);
        const overdueSuffix = showOverdueDays ? ` <span class="task-tracking-overdue-days">(-${overdueDayCount} Day${overdueDayCount === 1 ? '' : 's'})</span>` : '';
        html += `<div class="task-tracking-date-heading">${escapeHtml(formatDateLong(t.date))}${overdueSuffix}</div>`;
        lastDate = t.date;
      }
      html += taskRowHtml(t);
    });
    return html;
  };
  const taskTrackingCols = [
    { key: 'overdue', label: 'Overdue', color: 'var(--danger)', empty: 'Nothing overdue' },
    { key: 'dueSoon', label: 'Due Soon (7 days)', color: 'var(--primary-dark)', empty: 'Nothing due soon' }
  ];
  const renderTaskTrackingCol = col => `
    <div class="task-tracking-col">
      <div class="task-tracking-col-title" style="color:${col.color};">${escapeHtml(col.label)} <span class="dbl-count">${taskTracking[col.key].length}</span></div>
      ${taskTracking[col.key].length ? taskColumnItemsHtml(taskTracking[col.key], col.key === 'overdue') : `<div class="dash-empty">${escapeHtml(col.empty)}</div>`}
    </div>
  `;
  // "Due Today" always has exactly one possible date (today), unlike the
  // other two columns, so its heading shows even with nothing due — and it
  // gets a second, separate list right below for entries due today that
  // are already logged (see completedToday in computeTaskTracking), so the
  // column reads as "today's full picture", not just what's still open.
  const dueTodayColHtml = `
    <div class="task-tracking-col">
      <div class="task-tracking-col-title" style="color:var(--accent);">Due Today <span class="dbl-count">${taskTracking.dueToday.length}</span></div>
      <div class="task-tracking-date-heading">${escapeHtml(formatDateLong(taskTrackingTodayStr))}</div>
      ${taskTracking.dueToday.length ? taskTracking.dueToday.map(taskRowHtml).join('') : `<div class="dash-empty">Nothing due today</div>`}
      ${taskTracking.completedToday.length ? `
      <div class="task-tracking-completed-heading">${icon('check', 12)} Completed Today <span class="dbl-count">${taskTracking.completedToday.length}</span></div>
      ${taskTracking.completedToday.map(taskRowHtml).join('')}
      ` : ''}
    </div>
  `;
  const taskTrackingHtml = renderTaskTrackingCol(taskTrackingCols[0]) + dueTodayColHtml + renderTaskTrackingCol(taskTrackingCols[1]);
  const shownActionItems = actionItems.slice(0, 5);
  const actionItemsHtml = shownActionItems.length
    ? shownActionItems.map(item => `
        <div class="action-item">
          <span class="action-dot" style="background:${SEVERITY_DOT_COLOR[item.severity]};"></span>
          <div class="action-item-body">
            <div class="action-item-title">${escapeHtml(item.title)}</div>
            <div class="action-item-subject">${icon(item.subjectIcon, 14)} ${escapeHtml(item.subject)}</div>
          </div>
          <button class="btn btn-sm action-go-btn" data-item-type="${escapeHtml(item.itemType)}" data-item-id="${escapeHtml(item.itemId)}">Go</button>
        </div>
      `).join('') + (actionItems.length > shownActionItems.length ? `<div class="dash-empty">+${actionItems.length - shownActionItems.length} more</div>` : '')
    : `<div class="dash-empty">Nothing needs attention right now ${icon('party-popper', 14)}</div>`;

  const mergedActivityHtml = d.mergedRecentActivity.length
    ? d.mergedRecentActivity.map(item => `
        <div class="dash-activity-row action-go-btn" data-item-type="${item.type}" data-item-id="${escapeHtml(item.id)}" style="cursor:pointer;">
          <div class="dash-activity-name">${icon(item.icon, 14)} ${escapeHtml(item.name)}</div>
          <div class="dash-activity-time">${escapeHtml(formatActivityDateTime(item.updatedAt) || '')}</div>
        </div>
      `).join('')
    : '<div class="dash-empty">No activity yet</div>';

  const activeProjectsTableHtml = d.topActiveProjects.length
    ? `
      <div class="dash-table-scroll">
      <table class="dash-projects-table">
        <thead><tr><th>Project</th><th>Customer</th><th>Progress</th><th>Status</th><th>Next action</th><th></th></tr></thead>
        <tbody>
          ${d.topActiveProjects.map(p => `
            <tr>
              <td><b>${escapeHtml(p.name || 'Untitled project')}</b></td>
              <td>${escapeHtml(p.customerName || '—')}</td>
              <td>
                <div class="proj-status-bar-track" style="max-width:120px;"><div class="proj-status-bar-fill" style="width:${projectProgressPct(p)}%;background:var(--accent);"></div></div>
                <span class="dash-progress-pct">${projectProgressPct(p)}%</span>
              </td>
              <td>${statusPillHtml(p.status)}</td>
              <td class="dash-next-action">${escapeHtml(projectNextAction(p))}</td>
              <td><button class="btn btn-sm action-go-btn" data-item-type="project" data-item-id="${escapeHtml(p.id)}">View</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      </div>
    `
    : '<div class="dash-empty">No active projects right now</div>';

  const pipelineHtml = d.productsByStage.length
    ? `<div class="pipeline-funnel">${d.productsByStage.map((g,i) => `
        ${i > 0 ? '<div class="pipeline-chevron">›</div>' : ''}
        <div class="pipeline-step">
          <div class="pipeline-step-count">${g.count}</div>
          <div class="pipeline-step-label">${escapeHtml(g.label)}</div>
        </div>
      `).join('')}</div>`
    : '<div class="dash-empty">No products in the pipeline yet</div>';

  return `
    <div class="home-dashboard">
      <div class="hd2-greeting">
        <div class="hd2-hello">Hello, ${escapeHtml(greetingName || 'there')}</div>
        <div class="hd2-sub">Your work overview · ${escapeHtml(todayLabel)}</div>
      </div>

      <div class="hd2-searchrow">
        <input type="text" class="hd2-search" id="hdSearchInput" placeholder="Search recipes, projects, materials...">
        <div class="hd2-create-wrap">
          <button type="button" class="btn btn-primary" id="hdCreateBtn">+ Create ${icon('chevron-down', 14)}</button>
          <div class="hd2-create-menu" id="hdCreateMenu">
            <button type="button" class="navbar-account-menu-item" id="hdCreateRecipeBtn">${icon('file-text')} New Recipe</button>
            <button type="button" class="navbar-account-menu-item" id="hdCreateProjectBtn">${icon('folder')} New Project</button>
          </div>
        </div>
      </div>

      <div class="hd2-stats">${statCardsHtml}</div>

      <div class="dash-card" id="taskTrackingCard" style="margin-bottom:14px;">
        <div class="cal-header-bar">
          <div class="dash-card-title" style="margin-bottom:0;">Task Tracking</div>
          <div class="cal-nav">
            <button type="button" class="btn btn-sm btn-primary" id="taskTrackingAddBtn" title="Add a new task/activity, due today">${icon('plus', 12)} Add Task</button>
            <div class="task-tracking-who-filter-wrap">
              <button type="button" class="btn btn-sm${taskTrackingWhoFilters.size ? ' active' : ''}" id="taskTrackingWhoTrigger">
                Who${taskTrackingWhoFilters.size ? ` (${taskTrackingWhoFilters.size})` : ''} ${icon('chevron-down', 12)}
              </button>
              <div class="proj-col-filter-menu${taskTrackingWhoMenuOpen ? ' open' : ''}" id="taskTrackingWhoMenu">
                ${taskTrackingWhoOptions.length ? `
                <div class="proj-col-filter-values">
                  ${taskTrackingWhoOptions.map(w => `
                    <label class="proj-col-filter-item">
                      <input type="checkbox" class="task-tracking-who-cb" value="${escapeHtml(w)}" ${taskTrackingWhoFilters.has(w) ? 'checked' : ''}>
                      ${escapeHtml(w)}
                    </label>
                  `).join('')}
                </div>
                ${taskTrackingWhoFilters.size ? `<button type="button" class="btn btn-sm" id="taskTrackingClearFilters" style="margin-top:6px;width:100%;">Clear filter</button>` : ''}
                ` : `<div class="dash-empty" style="padding:4px;">No one assigned yet</div>`}
              </div>
            </div>
          </div>
        </div>
        <div class="task-tracking-grid">${taskTrackingHtml}</div>
      </div>

      ${renderCalendarCardHtml(homeCalendarViewDate, computeCalendarEvents())}

      <div class="dash-row">
        <div class="dash-card" id="needsAttentionCard">
          <div class="dash-card-title">Needs Attention</div>
          ${actionItemsHtml}
        </div>
        <div class="dash-card" id="recentActivityCard">
          <div class="dash-card-title">Recent Activity</div>
          ${mergedActivityHtml}
        </div>
      </div>

      <div class="dash-card" style="margin-bottom:14px;">
        <div class="dash-card-title">Active Projects</div>
        ${activeProjectsTableHtml}
      </div>

      <div class="dash-card" style="margin-bottom:14px;">
        <div class="dash-card-title">Product Pipeline</div>
        ${pipelineHtml}
      </div>

      <div class="dash-metrics">
        ${metrics.map(m => `
          <div class="dash-metric">
            <div class="dash-metric-label">${escapeHtml(m.label)}</div>
            <div class="dash-metric-value">${m.value}</div>
          </div>
        `).join('')}
      </div>

      <div class="dash-row">
        <div class="dash-card">
          <div class="dash-card-title">By Country / Region</div>
          ${renderCountryBarList(d.byCountry)}
        </div>
      </div>

      <div class="dash-row">
        <div class="dash-card">
          <div class="dash-card-title">Recipes by sales rep</div>
          ${renderBarList(d.bySalesRep)}
        </div>
        <div class="dash-card">
          <div class="dash-card-title">Most-used materials</div>
          ${renderBarList(d.materialUsage, 'alt')}
        </div>
        <div class="dash-card">
          <div class="dash-card-title">Top customers</div>
          ${renderBarList(d.byCustomer, 'alt')}
        </div>
      </div>

      <div class="dash-row">
        <div class="dash-card">
          <div class="dash-card-title">Test acceptance rate, last 6 months${d.avgTrialScorePct != null ? ` <span class="dbl-count">(avg ${d.avgTrialScorePct}%)</span>` : ''}</div>
          ${d.trend.some(t => t.avg != null) ? `<div class="dash-trend">${trendHtml}</div>` : '<div class="dash-empty">No scored test results yet</div>'}
        </div>
        <div class="dash-card">
          <div class="dash-card-title">Most-iterated recipes</div>
          ${mostIteratedHtml}
        </div>
      </div>

      <div class="dash-row">
        <div class="dash-card">
          <div class="dash-card-title">Recently added materials</div>
          ${recentMaterialsHtml}
        </div>
      </div>
    </div>
  `;
}

function refreshDashboardHome(){
  const main = document.getElementById('mainArea');
  main.innerHTML = renderDashboardHome();
  wireDashboardHome();
  playContentTransition(main);
}

function wireDashboardHome(){
  const main = document.getElementById('mainArea');

  document.getElementById('calToday')?.addEventListener('click', () => {
    homeCalendarViewDate = new Date();
    refreshDashboardHome();
  });
  document.getElementById('calPrevPeriod')?.addEventListener('click', () => {
    homeCalendarViewDate = calStepView(homeCalendarViewDate, homeCalendarViewMode, -1);
    refreshDashboardHome();
  });
  document.getElementById('calNextPeriod')?.addEventListener('click', () => {
    homeCalendarViewDate = calStepView(homeCalendarViewDate, homeCalendarViewMode, 1);
    refreshDashboardHome();
  });
  document.querySelectorAll('[data-cal-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      homeCalendarViewMode = btn.dataset.calView;
      refreshDashboardHome();
    });
  });
  document.querySelectorAll('[data-cal-jump-month]').forEach(btn => {
    btn.addEventListener('click', () => {
      homeCalendarViewDate = new Date(homeCalendarViewDate.getFullYear(), parseInt(btn.dataset.calJumpMonth, 10), 1);
      homeCalendarViewMode = 'month';
      refreshDashboardHome();
    });
  });
  document.getElementById('calWhoTrigger')?.addEventListener('click', e => {
    e.stopPropagation();
    homeCalendarWhoMenuOpen = !homeCalendarWhoMenuOpen;
    refreshDashboardHome();
  });
  document.getElementById('calWhoMenu')?.addEventListener('click', e => e.stopPropagation());
  main.querySelectorAll('.cal-who-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if(cb.checked) homeCalendarWhoFilters.add(cb.value);
      else homeCalendarWhoFilters.delete(cb.value);
      refreshDashboardHome();
    });
  });
  document.getElementById('calWhoSelectAll')?.addEventListener('change', e => {
    // Reads the checkboxes already on the page (== allWhoValues) rather
    // than recomputing that list here -- same set either way, but this
    // way there's only one place (renderCalendarCardHtml) that decides
    // what counts as "everyone".
    const allValues = [...main.querySelectorAll('.cal-who-cb')].map(cb => cb.value);
    if(e.target.checked) allValues.forEach(v => homeCalendarWhoFilters.add(v));
    else homeCalendarWhoFilters.clear();
    refreshDashboardHome();
  });
  document.getElementById('calClearWhoFilters')?.addEventListener('click', () => {
    homeCalendarWhoFilters.clear();
    refreshDashboardHome();
  });
  main.querySelectorAll('.cal-pane-who-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const pane = homeCalendarPanes.find(p => p.id === sel.dataset.calPaneId);
      if(pane) pane.who = sel.value;
      saveCalendarPanes();
      refreshDashboardHome();
    });
  });
  main.querySelectorAll('.cal-pane-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      homeCalendarPanes = homeCalendarPanes.filter(p => p.id !== btn.dataset.calPaneId);
      saveCalendarPanes();
      refreshDashboardHome();
    });
  });
  main.querySelectorAll('.cal-pane-expand-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const pane = homeCalendarPanes.find(p => p.id === btn.dataset.calPaneId);
      if(pane) pane.expanded = !pane.expanded;
      saveCalendarPanes();
      refreshDashboardHome();
    });
  });
  document.getElementById('calAddPane')?.addEventListener('click', () => {
    homeCalendarPanes.push({ id: uid(), who: CAL_PANE_ALL });
    saveCalendarPanes();
    refreshDashboardHome();
  });
  // Month/Week's day cells (empty space, not an existing event chip --
  // those already navigate to their own project via .action-go-btn) and
  // Day view's own "+ Add Plan" button both start the same quick-add flow
  // (see quickAddCalendarPlan in projects.js): a blank entry on the
  // Unassigned bucket project, opened straight into the Update Activity
  // popup to fill in. Delegated on `main` (not queried per-cell) since a
  // click on a chip still bubbles up through its cell.
  main.querySelectorAll('.cal-cell-clickable').forEach(cell => {
    cell.addEventListener('click', e => {
      if(e.target.closest('.cal-event-wrap')) return;
      quickAddCalendarPlan(cell.dataset.calDate);
    });
  });
  main.querySelectorAll('.cal-day-add-btn').forEach(btn => {
    btn.addEventListener('click', () => quickAddCalendarPlan(btn.dataset.calDate));
  });

  // Same quick-add flow as clicking an empty calendar cell (see the
  // .cal-cell-clickable/.cal-day-add-btn wiring right above) -- a blank
  // entry on the Unassigned bucket project, dated today since there's no
  // specific cell to take the date from here, opened straight into the
  // Update Activity popup to fill in (including moving it off Unassigned
  // once a project's picked).
  document.getElementById('taskTrackingAddBtn')?.addEventListener('click', () => {
    quickAddCalendarPlan(new Date().toISOString().slice(0, 10));
  });
  document.getElementById('taskTrackingWhoTrigger')?.addEventListener('click', e => {
    e.stopPropagation();
    taskTrackingWhoMenuOpen = !taskTrackingWhoMenuOpen;
    refreshDashboardHome();
  });
  document.getElementById('taskTrackingWhoMenu')?.addEventListener('click', e => e.stopPropagation());
  main.querySelectorAll('.task-tracking-who-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      if(cb.checked) taskTrackingWhoFilters.add(cb.value);
      else taskTrackingWhoFilters.delete(cb.value);
      refreshDashboardHome();
    });
  });
  document.getElementById('taskTrackingClearFilters')?.addEventListener('click', () => {
    taskTrackingWhoFilters.clear();
    refreshDashboardHome();
  });

  main.querySelectorAll('.action-go-btn').forEach(el => {
    el.addEventListener('click', () => {
      const type = el.dataset.itemType, id = el.dataset.itemId;
      if(type === 'project') openProjectFromDashboard(id, el.dataset.focusSection);
      else if(type === 'trial') openTrialFromDashboard(id);
      else if(type === 'material') openMaterialFromDashboard(id);
      else if(type === 'recipe') openRecipeFromDashboard(id);
    });
  });

  main.querySelectorAll('.hd2-stat-card').forEach(el => {
    el.addEventListener('click', () => {
      const action = el.dataset.statAction;
      if(action === 'filter-in-progress' || action === 'filter-in-review'){
        setProjectStatusFilter(action === 'filter-in-progress' ? 'In Progress' : 'In Review');
        mainFeatureView = 'projects';
        renderMain();
        renderSidebar();
      }else if(action === 'scroll-attention'){
        document.getElementById('needsAttentionCard')?.scrollIntoView({ behavior:'smooth', block:'start' });
      }else if(action === 'scroll-activity'){
        document.getElementById('recentActivityCard')?.scrollIntoView({ behavior:'smooth', block:'start' });
      }
    });
  });

  // The sidebar is hidden on the Home dashboard now, so this can't just
  // mirror into it like before — instead it hands off to the full-page
  // Recipes view on the first keystroke and refocuses that view's own
  // search box so typing can continue uninterrupted.
  const searchInputHome = document.getElementById('hdSearchInput');
  searchInputHome?.addEventListener('input', () => {
    const query = searchInputHome.value;
    mainFeatureView = 'recipesList';
    renderMain();
    renderSidebar();
    const newInput = document.getElementById('recipesListSearchInput');
    if(newInput){
      newInput.value = query;
      newInput.focus();
      newInput.setSelectionRange(query.length, query.length);
      renderRecipesListGrid();
    }
  });

  const createBtn = document.getElementById('hdCreateBtn');
  const createMenu = document.getElementById('hdCreateMenu');
  createBtn?.addEventListener('click', e => {
    e.stopPropagation();
    createMenu.classList.toggle('open');
  });
  document.getElementById('hdCreateRecipeBtn')?.addEventListener('click', () => {
    createMenu.classList.remove('open');
    createNewRecipe();
  });
  document.getElementById('hdCreateProjectBtn')?.addEventListener('click', () => {
    createMenu.classList.remove('open');
    mainFeatureView = 'projects';
    renderMain();
    renderSidebar();
    document.getElementById('btnAddProject')?.click();
  });
}

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

// "Go" targets for dashboard action items / the Active Projects table —
// open the relevant feature view already expanded (and, for a project,
// filtered down to it) instead of just dropping the user on an unfiltered
// list they'd have to search through themselves.
function openProjectFromDashboard(projectId, focusSection){
  const p = projects.find(x => x.id === projectId);
  mainFeatureView = 'projects';
  renderMain();
  renderSidebar();
  projectExpandedIds.add(projectId);
  const input = document.getElementById('projectSearchInput');
  if(input && p && p.name) input.value = p.name;
  renderProjectsList();
  if(focusSection === 'activities'){
    document.getElementById(`activities-updates-${projectId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
function openTrialFromDashboard(trialId){
  mainFeatureView = 'trials';
  renderMain();
  renderSidebar();
  trialExpandedIds.add(trialId);
  renderTrialsList();
}
function openMaterialFromDashboard(materialId){
  const m = ingredientMaster.find(x => x.id === materialId);
  mainFeatureView = 'materials';
  renderMain();
  renderSidebar();
  const input = document.getElementById('materialSearchInput');
  if(input && m && m.nameEn) input.value = m.nameEn;
  renderMaterialTable();
}
export function openRecipeFromDashboard(recipeId){
  openRecipe(recipeId);
  mainFeatureView = null;
  renderMain();
  renderSidebar();
}

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





// Finds a Part anywhere in the recipe's tree (including nested Sub-parts)
// by name -- a local copy of recipes.js's own findPartByName (not shared
// directly since recipes.js already imports things FROM this file, and
// the reverse would be circular). Used below to look up what's actually
// inside a Process Step's Component when that Component is a whole Part
// added as one lumped entry, same idea as the live editor's own Process
// Steps Components table (see renderComponentRows in recipes.js).
function findPartByNameForProcessView(parts, name){
  for(const part of (parts || [])){
    if((part.name || '').trim() === name) return part;
    const found = findPartByNameForProcessView(part.parts, name);
    if(found) return found;
  }
  return null;
}

// Shared by the print view and the Version Preview modal — a process list
// (title + optional components table + numbered steps) rendered read-only,
// fed from either the live recipe or a frozen version snapshot. `parts` is
// the recipe/snapshot's own ingredient tree, only needed for the Part-
// based Component ingredient breakdown below — optional so any other
// caller that doesn't have it handy can just omit it.
export function readOnlyProcessesHtml(processes, parts){
  const list = (processes || []).filter(p =>
    (p.title||'').trim() !== '' ||
    (p.steps||[]).some(s => (s||'').trim() !== '') ||
    (p.components||[]).length > 0
  );
  if(list.length === 0) return '<div class="compare-missing">No processes yet</div>';
  // Each Process Step (Cutting/Weighing/Mixing 1/...) gets its own bordered
  // white block instead of just flowing straight into the next one -- on
  // the parent .compare-steps-col's own gray background, that's the only
  // thing that actually reads as "here's where one Step ends and the next
  // begins" when there can be many of them stacked in a row.
  // Always rendered, filled in or not -- printed as a blank template a
  // production run can jot real measurements onto by hand, then have
  // someone key in afterward. A rep only shows an actual number once it
  // holds one; blank slots print as "—" so there's still a labeled spot to
  // write each one in on paper.
  const fmtReps = (arr) => (arr || []).map(v => { const n = parseFloat(v); return isFinite(n) ? n.toFixed(2) : null; });
  const avgOf = (nums) => nums.length ? (nums.reduce((s,n)=>s+n,0) / nums.length).toFixed(2) : null;

  return list.map(p => {
    const steps = (p.steps || []).filter(s => (s||'').trim() !== '');
    const components = p.components || [];

    const wtBefore = parseFloat(p.weightBefore);
    const wtAfter = parseFloat(p.weightAfter);
    const actualYieldPct = (isFinite(wtBefore) && wtBefore > 0 && isFinite(wtAfter)) ? (wtAfter / wtBefore * 100).toFixed(2) + '%' : '—';

    const qcRows = ['brix','salt','ph'].map(field => {
      const reps = fmtReps(Array.isArray(p[field]) ? p[field] : [null, null, null]);
      const validReps = reps.filter(v => v != null);
      const label = field === 'brix' ? '°Brix' : field === 'salt' ? '%Salt' : 'pH';
      return `<tr><td>${label}</td><td>${reps.map(v => v != null ? v : '—').join(', ')}</td><td>Avg ${avgOf(validReps.map(Number)) || '—'}</td></tr>`;
    }).join('');

    // Photos sit to the left of the Weight/Yield/QC table (same idea as the
    // live edit page's own photos-then-fields row) instead of their own row
    // above it, so the data reads right where a glance at the photo lands.
    const photosHtml = (p.photos && p.photos.length) ? `
      <div class="trial-photos-row">${p.photos.map((photo, idx) => `
        <div class="trial-photo-thumb"><img src="${escapeHtml(photo)}" alt="Process photo ${idx+1}"></div>
      `).join('')}</div>
    ` : '';

    const actualYieldHtml = `
      <div class="process-view-yield-title">Actual Yield</div>
      <div class="process-view-yield-row">
        ${photosHtml}
        <table class="compare-table process-view-yield-table">
          <tbody>
            <tr><td>Weight Before / After</td><td>${isFinite(wtBefore) ? formatWeight(wtBefore) : '—'} → ${isFinite(wtAfter) ? formatWeight(wtAfter) : '—'}</td><td>Yield ${actualYieldPct}</td></tr>
            ${qcRows}
          </tbody>
        </table>
      </div>
    `;

    return `
      <div class="process-view-step-block">
        <div class="compare-process-title">${escapeHtml(p.title || 'Untitled process')}</div>
        ${components.length ? `
          <table class="compare-table process-view-comp-table" style="margin-bottom:10px;">
            <thead><tr><th>#</th><th>Component</th><th>Weight (g)</th><th>Tolerance</th><th>Range</th><th>%</th></tr></thead>
            <tbody>${components.map((c, cIdx) => {
              const wt = parseFloat(c.weight) || 0;
              const tol = parseFloat(c.tolerance) || 0;
              const mainRow = `<tr><td>${cIdx+1}</td><td>${escapeHtml(c.name||'')}</td><td>${formatWeight(wt)}</td><td>±${tol}</td><td>${(wt-tol).toFixed(2)}-${(wt+tol).toFixed(2)} g</td><td>${(parseFloat(c.percent)||0).toFixed(2)}%</td></tr>`;
              // If this Component is a whole Part (not a single
              // ingredient), show what's actually inside it underneath --
              // same read-only, one-row-per-ingredient breakdown as the
              // live editor's own Components table.
              const matchedPart = findPartByNameForProcessView(parts, (c.name || '').trim());
              const innerIngredients = matchedPart
                ? allIngredientsInPart(matchedPart).filter(i => (i.name||'').trim() !== '')
                : [];
              const subRows = innerIngredients.map(ing => `
                <tr class="comp-sublist-row">
                  <td></td>
                  <td class="comp-sublist-name">${escapeHtml(ing.name)}</td>
                  <td class="comp-sublist-num">${formatWeight(parseFloat(ing.weight) || 0)}</td>
                  <td></td>
                  <td></td>
                  <td class="comp-sublist-num">${(parseFloat(ing.percent) || 0).toFixed(2)}%</td>
                </tr>
              `).join('');
              return mainRow + subRows;
            }).join('')}</tbody>
            <tfoot><tr class="total-row">
              <td></td><td>Total</td>
              <td>${formatWeight(components.reduce((s,c)=>s+(parseFloat(c.weight)||0),0))}</td>
              <td></td><td></td>
              <td>${components.reduce((s,c)=>s+(parseFloat(c.percent)||0),0).toFixed(2)}%</td>
            </tr></tfoot>
          </table>
        ` : ''}
        ${actualYieldHtml}
        ${steps.length ? `<ol>${steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : '<div class="compare-missing">No steps yet</div>'}
      </div>
    `;
  }).join('');
}

// Static, non-interactive mirror of the live Process Flowchart canvas (see
// renderProcessFlowchart) for Printing and Version Preview — reuses the
// exact stored node x/y/w so the read-only view matches what was actually
// designed, just without drag handles/connector dots/delete buttons.
// containerEl-scoped rather than a fixed global id, since Print and
// Version Preview can both hold their own copy in the document at once.
function readOnlyProcessFlowchartHtml(flowchart, processes){
  const nodes = (flowchart && flowchart.nodes) || [];
  if(nodes.length === 0) return '<div class="compare-missing">No flowchart yet</div>';
  const nodesHtml = nodes.map(n => `
    <div class="ro-flow-node" data-node-id="${escapeHtml(n.id)}" style="left:${n.x}px;top:${n.y}px;width:${n.w || DEFAULT_FLOW_NODE_W}px;">
      <div class="flow-node-label">${escapeHtml(n.label || '')}</div>
      <div class="flow-node-text">${escapeHtml(computeFlowNodeText(n, processes))}</div>
    </div>
  `).join('');
  return `
    <div class="flow-canvas-scroll">
      <div class="flow-canvas ro-flow-canvas">
        <svg class="flow-edges-svg"></svg>
        <div class="flow-nodes-layer">${nodesHtml}</div>
      </div>
    </div>
  `;
}

// Measures the just-rendered static nodes (only valid once containerEl is
// actually laid out — see withTemporaryVisibility) and draws the edges +
// sizes the canvas to fit, mirroring redrawFlowEdges/resizeFlowCanvasToFitNodes
// but read-only (no hit-stroke, no click handler, no ghost line).
function finalizeReadOnlyFlowchartEdges(containerEl, flowchart){
  const svg = containerEl.querySelector('.flow-edges-svg');
  const canvas = containerEl.querySelector('.ro-flow-canvas');
  if(!svg || !canvas) return;
  let maxRight = 0, maxBottom = 0;
  canvas.querySelectorAll('.ro-flow-node').forEach(el => {
    maxRight = Math.max(maxRight, el.offsetLeft + el.offsetWidth);
    maxBottom = Math.max(maxBottom, el.offsetTop + el.offsetHeight);
  });
  canvas.style.width = (maxRight + 40) + 'px';
  canvas.style.height = (maxBottom + 40) + 'px';

  let html = FLOW_ARROWHEAD_DEFS;
  ((flowchart && flowchart.edges) || []).forEach(edge => {
    const fromEl = canvas.querySelector(`[data-node-id="${edge.from}"]`);
    const toEl = canvas.querySelector(`[data-node-id="${edge.to}"]`);
    if(!fromEl || !toEl) return;
    const fromRect = rectOf(fromEl), toRect = rectOf(toEl);
    const fromCenter = { x: fromRect.x + fromRect.w/2, y: fromRect.y + fromRect.h/2 };
    const toCenter = { x: toRect.x + toRect.w/2, y: toRect.y + toRect.h/2 };
    const start = clipToRectEdge(fromRect, toCenter);
    const end = clipToRectEdge(toRect, fromCenter);
    html += `<path class="flow-edge-line" d="M${start.x},${start.y} L${end.x},${end.y}" marker-end="url(#flowArrowhead)"></path>`;
  });
  svg.innerHTML = html;
}

export function renderReadOnlyProcessFlowchart(containerEl, flowchart, processes){
  containerEl.innerHTML = readOnlyProcessFlowchartHtml(flowchart, processes);
  if(((flowchart && flowchart.nodes) || []).length > 0){
    finalizeReadOnlyFlowchartEdges(containerEl, flowchart);
  }
}


// ---------- Ingredient Preparation Yield ----------
// Shared by Recipe Overview, the Components/Process ingredient row, the
// Print ingredient table, and Version Preview -- one place for "Prepare
// (gross) weight = Formula (net) weight / (Yield% / 100)" so it's never
// re-derived slightly differently in four places. An invalid/empty/zero/
// negative yield is always silently treated as 100% here (never NaN or
// Infinity) -- the Yield input's own validation state (see
// isValidYieldPct) is what actually surfaces a problem to the user; this
// function's job is just to never crash regardless of what's in the data.
export function computePrepareWeight(formulaWeight, yieldPct){
  const fw = parseFloat(formulaWeight) || 0;
  const y = parseFloat(yieldPct);
  const effectiveYield = (isFinite(y) && y > 0) ? y : 100;
  return fw / (effectiveYield / 100);
}
// Ingredient cost is now based on Prepare (gross) weight, not Formula
// weight -- the Price/kg in the Library is the as-purchased price, so the
// amount actually bought (and paid for) is the gross amount, not the net
// amount that ends up in the batch after trimming/draining loss.
export function computeIngredientCost(prepareWeight, pricePerKg){
  return pricePerKg != null ? (prepareWeight / 1000) * pricePerKg : null;
}
// Only for the Yield input's own error-state styling/message -- never
// gates computePrepareWeight, which always falls back safely regardless.
// Empty/null passes (an empty field just means "not set yet", not invalid).
export function isValidYieldPct(v){
  if(v === '' || v == null) return true;
  const y = parseFloat(v);
  return isFinite(y) && y >= 0.01 && y <= 999.99;
}
// Same recursive shape as partTotalWeight (recipes.js) but summing each
// ingredient's Prepare (gross) weight instead of its Formula weight, then
// dividing by the Part's OWN Yield too -- so a Part/Sub-part can carry its
// own independent prep loss (e.g. the finished sub-assembly itself gets
// strained/reduced) on top of whatever its individual ingredients already
// lose. Compounds naturally through nesting since each level's own division
// happens after summing children that have already had theirs applied.
// Shared by the live editor (recipes.js), Print (recipes.js), and this
// file's own read-only tree -- one place so all three always agree.
export function partPrepareWeight(part){
  const childrenSum = (part.ingredients || []).reduce((s,i) => s + computePrepareWeight(i.weight, i.prepYieldPct), 0)
    + (part.parts || []).reduce((s,sub) => s + partPrepareWeight(sub), 0);
  return computePrepareWeight(childrenSum, part.prepYieldPct);
}

// Shared by the Version Preview modal and Printing — the same Parts ->
// Sub-parts -> Ingredients hierarchy as the live editable form (see
// renderParts/renderPartNode), but as a compact read-only table (name,
// prefixed with box-drawing tree-connector characters, plus %/g as two
// neighboring columns) instead of the on-screen card layout — dense enough
// that a deep recipe still fits on a printed page or in the preview modal,
// while still visually reading as a tree the way the on-screen elbow-line
// artwork does. Recursive so nested Sub-parts show up too, not just each
// top-level Part's direct ingredients.
export function readOnlyIngredientTreeHtml(parts, totalWeight, flowNodes){
  const namedParts = (parts || []).filter(part => allIngredientsInPart(part).some(i => (i.name||'').trim() !== ''));
  if(namedParts.length === 0) return '<div class="overview-empty">No ingredients</div>';
  // The whole Node column is omitted entirely (not just left blank) unless
  // the recipe actually has flowchart nodes, so recipes that never touch
  // that feature get byte-identical print/preview output to before it
  // existed.
  const nodeLabelById = new Map((flowNodes || []).map(n => [n.id, n.label || '?']));
  const showNodeCol = nodeLabelById.size > 0;
  const totalPrepareWeight = namedParts.reduce((s,p)=>s+partPrepareWeight(p), 0);
  const rootRow = `
    <tr class="ro-tree-row ro-tree-root">
      <td class="ro-tree-name">Formula per Portion</td>
      <td class="ro-tree-note"></td>
      <td class="ro-tree-pct">100.00%</td>
      <td class="ro-tree-wt">${fmtNum(totalWeight)}</td>
      <td class="ro-tree-yield"></td>
      <td class="ro-tree-wt">${fmtNum(totalPrepareWeight)}</td>
      <td class="ro-tree-pct">100.00%</td>
      ${showNodeCol ? '<td class="ro-tree-nodecol"></td>' : ''}
    </tr>
  `;
  const bodyRows = namedParts.map((part, idx) =>
    readOnlyPartBranchRows(part, false, totalWeight, totalWeight, [], idx === namedParts.length - 1, nodeLabelById, 1)
  ).join('');
  return `
    <table class="ro-tree-table">
      <thead><tr><th class="ro-tree-name">Component</th><th class="ro-tree-note">Note</th><th class="ro-tree-pct">%</th><th class="ro-tree-wt">Formula (g)</th><th class="ro-tree-yield">Yield</th><th class="ro-tree-wt">Prepare (g)</th><th class="ro-tree-pct">% of Recipe</th>${showNodeCol ? '<th class="ro-tree-nodecol">Node</th>' : ''}</tr></thead>
      <tbody>${rootRow}${bodyRows}</tbody>
    </table>
  `;
}

// Plain number, no unit suffix — the table's own "g" column header carries
// the unit once instead of repeating it on every row (see formatWeight,
// which is used everywhere else that a weight stands alone).
function fmtNum(n){
  return (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Box-drawing tree connector for one row: one "│  "/"   " segment per
// ancestor level (drawn only when that ancestor still has more siblings
// below it, so the vertical line doesn't dangle past where a branch
// actually ends), then this row's own "├─ " (more siblings follow) or
// "└─ " (last child at this level) elbow.
function treeGuideHtml(ancestorContinues, isLast){
  const guide = ancestorContinues.map(cont => cont ? '│  ' : '   ').join('') + (isLast ? '└─ ' : '├─ ');
  return `<span class="ro-tree-guide">${guide}</span>`;
}

// One Part's row (name/%/weight) plus, recursively, a row for every named
// ingredient AND every Sub-part nested inside it, all as siblings in the
// same table, ingredients first then Sub-parts (matching the on-screen
// order) so "last child at this level" — and therefore whether this
// branch's own connector lines keep running down past it — is computed
// against that combined, correctly-ordered list. `ancestorContinues` is
// one boolean per ancestor level, carried down and extended by each level
// as it recurses; `isLast` says whether THIS node is the last among its
// own siblings. `parentTotal` is the immediate parent's own total weight
// (the recipe root's total for a top-level Part, or the containing Part's
// total for a nested Sub-part) — % is always computed fresh from the
// actual weights rather than trusting a stored .percent, since older
// versions saved before Sub-parts existed never had one on their Part
// objects.
function readOnlyPartBranchRows(part, isNested, parentTotal, grandTotal, ancestorContinues, isLast, nodeLabelById, ancestorMultiplier){
  const namedIngredients = (part.ingredients||[]).filter(i => (i.name||'').trim() !== '');
  const namedSubParts = (part.parts||[]).filter(sub => allIngredientsInPart(sub).some(i => (i.name||'').trim() !== ''));
  const label = (part.name||'').trim() || 'Unnamed part';
  const partWeight = partTotalWeight(part);
  const partPct = parentTotal > 0 ? (partWeight / parentTotal * 100) : 0;
  const partPctOfRecipe = grandTotal > 0 ? (partWeight / grandTotal * 100) : 0;
  const showNodeCol = nodeLabelById && nodeLabelById.size > 0;
  // A Part can now carry its own Yield too (on top of any of its
  // ingredients' own) -- shown here, and its Prepare column is this Part's
  // own local rollup (partPrepareWeight), not further multiplied by any
  // ancestor Part's yield -- that further loss shows on the ANCESTOR's own
  // row instead, the same way %-of-Part and %-of-Recipe already coexist as
  // two distinct, both-correct figures for the same row.
  const ownMultiplier = computePrepareWeight(1, part.prepYieldPct);
  const py = parseFloat(part.prepYieldPct);
  const partYieldDisplay = (isFinite(py) && py > 0) ? py : 100;
  const partRow = `
    <tr class="ro-tree-row ro-tree-part">
      <td class="ro-tree-name">${treeGuideHtml(ancestorContinues, isLast)}${escapeHtml(label)}</td>
      <td class="ro-tree-note"></td>
      <td class="ro-tree-pct">${partPct.toFixed(2)}%</td>
      <td class="ro-tree-wt">${fmtNum(partWeight)}</td>
      <td class="ro-tree-yield">${partYieldDisplay.toFixed(2)}%</td>
      <td class="ro-tree-wt">${fmtNum(partPrepareWeight(part))}</td>
      <td class="ro-tree-pct">${partPctOfRecipe.toFixed(2)}%</td>
      ${showNodeCol ? '<td class="ro-tree-nodecol"></td>' : ''}
    </tr>
  `;
  const childAncestorContinues = [...ancestorContinues, !isLast];
  const childCount = namedIngredients.length + namedSubParts.length;
  const childMultiplier = ancestorMultiplier * ownMultiplier;
  const ingRows = namedIngredients.map((ing, idx) => {
    const childIsLast = idx === childCount - 1;
    const nodeLabel = showNodeCol && ing.flowNodeId ? nodeLabelById.get(ing.flowNodeId) : null;
    const formulaWt = parseFloat(ing.weight) || 0;
    const y = parseFloat(ing.prepYieldPct);
    const yieldDisplay = (isFinite(y) && y > 0) ? y : 100;
    const pctOfRecipe = grandTotal > 0 ? (formulaWt / grandTotal * 100) : 0;
    return `
      <tr class="ro-tree-row ro-tree-ing">
        <td class="ro-tree-name">${treeGuideHtml(childAncestorContinues, childIsLast)}${escapeHtml(ing.name)}</td>
        <td class="ro-tree-note">${escapeHtml(ing.note || '')}</td>
        <td class="ro-tree-pct">${(parseFloat(ing.percent)||0).toFixed(2)}%</td>
        <td class="ro-tree-wt">${fmtNum(formulaWt)}</td>
        <td class="ro-tree-yield">${yieldDisplay.toFixed(2)}%</td>
        <td class="ro-tree-wt">${fmtNum(computePrepareWeight(formulaWt, ing.prepYieldPct) * childMultiplier)}</td>
        <td class="ro-tree-pct">${pctOfRecipe.toFixed(2)}%</td>
        ${showNodeCol ? `<td class="ro-tree-nodecol">${nodeLabel ? '→' + escapeHtml(nodeLabel) : ''}</td>` : ''}
      </tr>
    `;
  }).join('');
  const subRows = namedSubParts.map((sub, idx) => {
    const childIsLast = namedIngredients.length + idx === childCount - 1;
    return readOnlyPartBranchRows(sub, true, partWeight, grandTotal, childAncestorContinues, childIsLast, nodeLabelById, childMultiplier);
  }).join('');
  return partRow + ingRows + subRows;
}


/* ---------- Import / Export ----------
   Exports recipes + the ingredient library together so a backup / move to
   another computer restores both. User accounts are deliberately excluded
   (plaintext passwords shouldn't travel in a shareable JSON backup file). */
function exportAll(){
  const payload = {
    forgeExport: true,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    recipes: recipes,
    ingredientMaster: ingredientMaster,
    projects: projects,
    trials: trials
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `forge-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importFromFile(file){
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const data = JSON.parse(e.target.result);

      let importedRecipes = [];
      let importedMaterials = [];
      let importedProjects = [];
      let importedTrials = [];

      if(Array.isArray(data)){
        importedRecipes = data; // old format: plain array of recipes
      }else if(data && Array.isArray(data.recipes)){
        importedRecipes = data.recipes; // new format: {recipes, ingredientMaster, projects, trials}
        if(Array.isArray(data.ingredientMaster)) importedMaterials = data.ingredientMaster;
        if(Array.isArray(data.projects)) importedProjects = data.projects;
        if(Array.isArray(data.trials)) importedTrials = data.trials;
      }else if(data && typeof data === 'object'){
        importedRecipes = [data]; // old format: a single recipe object
      }

      const batch = writeBatch(db);

      // Every imported recipe gets a fresh id (so it can't collide with what's
      // already in the library) — recorded here so any imported project's
      // product.recipeId can be rewritten to match, since it was captured
      // against the recipe's old id at export time.
      const recipeIdMap = {};
      importedRecipes.forEach(item => {
        const oldId = item.id;
        item.id = uid();
        if(oldId) recipeIdMap[oldId] = item.id;
        item.updatedAt = Date.now();
        migrateRecipe(item);
        recomputeFromWeights(item);
        recipes.push(item);
        batch.set(doc(recipesCol, item.id), item);
      });

      let addedMaterials = 0;
      importedMaterials.forEach(m => {
        const exists = ingredientMaster.some(x =>
          (x.nameEn||'').trim().toLowerCase() === (m.nameEn||'').trim().toLowerCase() &&
          (x.nameTh||'').trim().toLowerCase() === (m.nameTh||'').trim().toLowerCase()
        );
        if(!exists && (m.nameEn||'').trim() && (m.nameTh||'').trim()){
          const material = {
            id: uid(),
            nameEn: m.nameEn,
            nameTh: m.nameTh,
            vendorCode: m.vendorCode || '',
            vendorName: m.vendorName || '',
            manufacturer: m.manufacturer || '',
            price: m.price || '',
            moq: m.moq || ''
          };
          ingredientMaster.push(material);
          batch.set(doc(materialsCol, material.id), material);
          addedMaterials++;
        }
      });

      importedProjects.forEach(p => {
        p.id = uid();
        p.updatedAt = Date.now();
        if(!Array.isArray(p.products)) p.products = [];
        p.products.forEach(prod => {
          prod.recipeId = recipeIdMap[prod.recipeId] || prod.recipeId;
          if(!Array.isArray(prod.log)) prod.log = [];
        });
        projects.push(p);
        batch.set(doc(projectsCol, p.id), p);
      });

      importedTrials.forEach(t => {
        t.id = uid();
        t.updatedAt = Date.now();
        const legacyIds = Array.isArray(t.recipeIds) ? t.recipeIds : (t.recipeId ? [t.recipeId] : []);
        t.recipeIds = legacyIds.map(rid => recipeIdMap[rid] || rid);
        delete t.recipeId;
        delete t.productName;
        if(!Array.isArray(t.photos)) t.photos = [];
        if(!Array.isArray(t.evaluation)) t.evaluation = [];
        trials.push(t);
        batch.set(doc(trialsCol, t.id), t);
      });

      if(importedRecipes.length){
        openRecipe(recipes[recipes.length-1].id);
        mainFeatureView = null;
      }
      batch.commit();
      if(mainFeatureView === 'projects') renderProjectsList();
      if(mainFeatureView === 'trials') renderTrialsList();
      renderSidebar();
      renderMain();
      alert(`Import successful: ${importedRecipes.length} recipe(s), added ${addedMaterials} new ingredient(s) to the library (duplicates skipped), ${importedProjects.length} project(s), ${importedTrials.length} test result(s)`);
    }catch(err){
      alert('Could not read file: ' + err.message);
    }
  };
  reader.readAsText(file);
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
function goHome(){
  closeRecipe();
  mainFeatureView = null;
  renderMain();
  renderSidebar();
}
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
  if(taskTrackingWhoMenuOpen){
    taskTrackingWhoMenuOpen = false;
    document.getElementById('taskTrackingWhoMenu')?.classList.remove('open');
  }
  if(homeCalendarWhoMenuOpen){
    homeCalendarWhoMenuOpen = false;
    document.getElementById('calWhoMenu')?.classList.remove('open');
  }
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
      homeCalendarPanes = data.calendarPanes.map(p => ({
        id: p?.id || uid(),
        who: typeof p?.who === 'string' && p.who ? p.who : CAL_PANE_ALL,
        expanded: !!p?.expanded
      }));
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
// Persists homeCalendarPanes to this account's own My Profile doc --
// called after every add/remove/who-change/expand-toggle so the layout
// survives a refresh or switching devices, same document
// attachMyProfileListener reads it back from. Silently a no-op while
// signed out (shouldn't happen in practice, since the calendar only
// renders once signed in, but cheap to guard anyway).
function saveCalendarPanes(){
  if(!currentUser) return;
  setDoc(doc(userProfilesCol, currentUser.uid), { calendarPanes: homeCalendarPanes }, { merge: true })
    .catch(err => console.error('Forge: failed to save calendar panes', err));
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
