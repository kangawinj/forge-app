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
  query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { mountCompareView } from './compare.js';
import {
  mountTrialsView, renderTrialsList, trialExpandedIds, trials, attachTrialsListener,
  unsubscribeTrials, migrateTrialsFromRecipes, resetTrialsState
} from './trials.js';
import {
  ingredientMaster, mountMaterialsView, renderMaterialTable, closeMaterialDetail,
  attachMaterialsListener, unsubscribeMaterials, resetMaterialsState
} from './materials.js';
import {
  metaLists, metaItemName, productTypeCode, mountRefListsView, attachMetaListsListener,
  unsubscribeMetaLists, resetRefListsState
} from './reflists.js';
import {
  mountProjectsView, guardNavigation, initUnsavedChangesGuard, attachProjectsListener,
  unsubscribeProjects, resetProjectsState, setProjectStatusFilter, closeProjectFilterMenu,
  projects, projectExpandedIds, renderProjectsList, migrateMonthlyUpdate, muPlanSummaryLine,
  monthlyUpdateStatus, getTaskStatus, daysBetween, projectHasUpdateThisMonth,
  projectProgressPct, statusPillHtml, projectNextAction, initProjectsModal,
  initMuAttachmentPreviewModal, openProjectFilterMenuKey, activeProjScrollbarProxySync,
  blankProduct, scheduleProjectSave
} from './projects.js';
// metaLists/metaItemName are imported above for app.js's own use (Recipes'
// bindComboField etc.) — re-exported as-is so projects.js can import them
// from app.js too, keeping every split module's imports pointed at
// app.js only rather than at a sibling module directly.
// `projects` is also imported above (for app.js's own Recipes-linking
// code) — re-exported so trials.js can keep importing it from app.js too,
// same reasoning as metaLists/metaItemName above.
export { metaLists, metaItemName, projects };

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
const db = getFirestore(firebaseApp);
const recipesCol = collection(db, "recipes");
export const materialsCol = collection(db, "ingredientMaster");
export const projectsCol = collection(db, "projects");
export const trialsCol = collection(db, "trials");
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
const activityEventsCol = collection(db, "activityEvents");
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
const approverRecipesCol = collection(approverDb, "recipes");
export const approverMaterialsCol = collection(approverDb, "ingredientMaster");

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
  { key: 'projects', label: 'Projects', navBtnId: 'btnOpenProjects' },
  { key: 'trials', label: 'Test Results', navBtnId: 'btnOpenTrials' },
  { key: 'materials', label: 'Ingredients', navBtnId: 'btnOpenMaterialLibSidebar' },
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
  { version: "3.0.242", date: "2026-08-20", note: "Switching pages (Home, Recipes, Projects, Test Results, Ingredients, Reference Lists, Compare, a recipe) and the Home dashboard's own data refreshes (Task Tracking filters, Calendar month paging) now ease in with a short fade instead of snapping into place instantly" }
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
let unlockedRecipeId = null;
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
let myProfile = { displayName: '', photoImage: '' };
let unsubscribeMyProfile = null;
let editingProfileImage = ''; // staged photo for the My Profile modal, same pattern as newProjectImage

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
  MODULE_PERMISSIONS.forEach(m => {
    const btn = document.getElementById(m.navBtnId);
    if(btn) btn.style.display = hasModuleAccess(m.key) ? '' : 'none';
  });
}

function goToAuth(){
  signOut(auth);
}

function goToApp(){
  currentId = null;
  unlockedRecipeId = null;
  mainFeatureView = null;
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
  document.getElementById('authConfirmModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'authConfirmModalOverlay') closeAuthConfirm();
  });
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

/* ---------- Version History (snapshot & restore the recipe's formulation) ---------- */
let versionsModalRecipe = null;

/* Only the BOM-relevant fields are snapshotted — trial photos are excluded
   to keep each version small (photos alone could approach Firestore's 1MB
   doc limit across a few saved versions). */
function snapshotRecipeCore(r){
  return {
    name: r.name,
    code: r.code,
    date: r.date,
    description: JSON.parse(JSON.stringify(r.description)),
    batchWeight: r.batchWeight,
    parts: JSON.parse(JSON.stringify(r.parts)),
    processes: JSON.parse(JSON.stringify(r.processes)),
    processFlowchart: r.processFlowchart ? JSON.parse(JSON.stringify(r.processFlowchart)) : { nodes: [], edges: [] },
    processViewMode: r.processViewMode || 'list',
    yieldPct: r.yieldPct
  };
}

function openVersionsModal(r){
  versionsModalRecipe = r;
  document.getElementById('versionLabelInput').value = '';
  renderVersionsList(r);
  document.getElementById('versionsModalOverlay').classList.add('open');
}

function closeVersionsModal(){
  document.getElementById('versionsModalOverlay').classList.remove('open');
}

function renderVersionsList(r){
  const listEl = document.getElementById('versionsList');
  if(!Array.isArray(r.versions) || r.versions.length === 0){
    listEl.innerHTML = '<div class="overview-empty">No versions saved yet</div>';
    return;
  }
  const sorted = [...r.versions].sort((a,b) => b.savedAt - a.savedAt);
  listEl.innerHTML = sorted.map(v => `
    <div class="version-item" data-id="${escapeHtml(v.id)}">
      <div>
        <div class="version-item-label">${escapeHtml(v.label || 'Untitled version')}</div>
        <div class="version-item-date">${escapeHtml(new Date(v.savedAt).toLocaleString())}</div>
      </div>
      <div class="version-item-actions">
        <button class="btn btn-sm" data-role="preview-version">Preview</button>
        <button class="btn btn-sm" data-role="restore-version">Restore</button>
        <button class="icon-btn" data-role="delete-version" title="Delete this version">${icon('x')}</button>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('[data-role="preview-version"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.version-item').dataset.id;
      const v = r.versions.find(x => x.id === id);
      if(v) openVersionPreview(r, v);
    });
  });
  listEl.querySelectorAll('[data-role="restore-version"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.version-item').dataset.id;
      const v = r.versions.find(x => x.id === id);
      if(v) restoreVersion(r, v);
    });
  });
  listEl.querySelectorAll('[data-role="delete-version"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.version-item').dataset.id;
      r.versions = r.versions.filter(x => x.id !== id);
      renderVersionsList(r);
      scheduleSave();
    });
  });
}

// Shared by the Versions list's own Restore button and the Preview modal's
// Restore button, so restoring a version behaves identically regardless of
// which one the user reached it from.
function restoreVersion(r, v){
  if(!confirm(`Restore version "${v.label || 'Untitled version'}"? This overwrites the recipe's current name, description, ingredients, process steps/components, and yield (trial photos are not affected).`)) return;
  Object.assign(r, JSON.parse(JSON.stringify(v.snapshot)));
  migrateRecipe(r);
  closeVersionPreview();
  closeVersionsModal();
  renderMain();
  scheduleSave();
}

let versionPreviewContext = null;

// Read-only look at a saved version before committing to Restore — reuses
// the same tree/process markup as the live editor and the print view, just
// fed from the version's frozen snapshot instead of the live recipe.
function openVersionPreview(r, v){
  versionPreviewContext = { recipe: r, version: v };
  const snap = v.snapshot || {};
  const totalWt = allIngredientsInRecipe(snap).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);

  const snapFlowchart = snap.processFlowchart || { nodes: [], edges: [] };
  const isFlowMode = snap.processViewMode === 'flowchart' && snapFlowchart.nodes.length > 0;

  document.getElementById('versionPreviewTitle').textContent = v.label || 'Untitled version';
  document.getElementById('versionPreviewContent').innerHTML = `
    <div class="reflist-item-meta" style="margin-bottom:12px;">Saved ${escapeHtml(new Date(v.savedAt).toLocaleString())}</div>
    <div class="compare-info-col">
      <div class="ci-name">${escapeHtml(snap.name || 'Untitled recipe')}</div>
      <div class="ci-row"><b>Code:</b> ${escapeHtml(snap.code || '-')}</div>
      <div class="ci-row"><b>Date:</b> ${escapeHtml(snap.date || '-')}</div>
      <div class="ci-row"><b>Total weight:</b> ${formatWeight(totalWt)}</div>
      ${descriptionListHtml(snap)}
    </div>
    <div class="overview-title" style="margin-top:16px;">Ingredients</div>
    ${readOnlyIngredientTreeHtml(snap.parts, totalWt, snapFlowchart.nodes)}
    <div class="overview-title" style="margin-top:16px;">Process Steps</div>
    ${isFlowMode ? '<div id="versionPreviewFlowchart"></div>' : `<div class="compare-steps-col">${readOnlyProcessesHtml(snap.processes)}</div>`}
  `;
  document.getElementById('versionPreviewModalOverlay').classList.add('open');
  if(isFlowMode){
    renderReadOnlyProcessFlowchart(document.getElementById('versionPreviewFlowchart'), snapFlowchart, snap.processes);
  }
}

function closeVersionPreview(){
  document.getElementById('versionPreviewModalOverlay').classList.remove('open');
  versionPreviewContext = null;
}

function initVersionPreviewModal(){
  document.getElementById('btnCloseVersionPreviewModal').addEventListener('click', closeVersionPreview);
  document.getElementById('btnCloseVersionPreviewModal2').addEventListener('click', closeVersionPreview);
  document.getElementById('versionPreviewModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'versionPreviewModalOverlay') closeVersionPreview();
  });
  document.getElementById('btnRestoreFromPreview').addEventListener('click', () => {
    if(!versionPreviewContext) return;
    restoreVersion(versionPreviewContext.recipe, versionPreviewContext.version);
  });
}

function initVersionsModal(){
  document.getElementById('btnCloseVersionsModal').addEventListener('click', closeVersionsModal);
  document.getElementById('versionsModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'versionsModalOverlay') closeVersionsModal();
  });
  document.getElementById('btnSaveVersion').addEventListener('click', () => {
    const r = versionsModalRecipe;
    if(!r) return;
    const label = document.getElementById('versionLabelInput').value.trim();
    pushVersionCheckpoint(r, label);
    document.getElementById('versionLabelInput').value = '';
    renderVersionsList(r);
    scheduleSave();
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
  document.getElementById('myProfileModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'myProfileModalOverlay') closeMyProfileModal();
  });

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
  document.getElementById('securityModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'securityModalOverlay') closeSecurityModal();
  });

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
  document.getElementById('dataManagementModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'dataManagementModalOverlay') closeDataManagementModal();
  });
}



function initCompareView(){
  document.getElementById('btnCompare').addEventListener('click', () => {
    mainFeatureView = 'compare';
    renderMain();
    renderSidebar();
  });
}

export let recipes = [];
export let currentId = null;
// Which full-page feature (if any) currently owns #mainArea, overriding the
// normal home-dashboard/recipe-editor split. null = normal (home dashboard
// if currentId is also null, otherwise the recipe editor for currentId).
// Deliberately independent of currentId — entering a feature from inside a
// recipe (e.g. the Ingredient Library button) leaves currentId untouched,
// so closing the feature naturally resumes that recipe instead of bouncing
// to home.
export let mainFeatureView = null; // null | 'recipesList' | 'compare' | 'materials' | 'refLists' | 'projects' | 'trials'
// Lets a split module (e.g. projects.js's own nav-button wiring) change
// mainFeatureView from outside app.js — a plain `mainFeatureView = ...`
// assignment in an importing module isn't possible, since ES modules
// can't reassign a sibling module's imported `let` binding.
export function setMainFeatureView(v){ mainFeatureView = v; }
let saveTimer = null;
// One entry per recipe with a pending "haven't clicked Save in a while"
// checkpoint — keyed by id (not a single global timer) so editing recipe A
// then switching to recipe B within the window still checkpoints each one
// independently instead of the second edit silently getting dropped. See
// scheduleVersionCheckpoint/cancelVersionCheckpoint/autoCheckpointVersion.
const versionCheckpointTimers = new Map();
// Set on dragstart (see renderPartNode/renderRows' drag-handle wiring),
// read by whichever Part header the item gets dropped on, cleared on
// dragend/drop either way. A plain module-level variable is enough since
// only one drag can be in flight in the whole document at a time.
let dragPayload = null;
let unsubscribeRecipes = null;
let unsubscribeLoginEvents = null;
let unsubscribeActivityEvents = null;
export let recipesLoaded = false;
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
const RECIPE_DIFF_FIELDS = { name: 'Product Name', code: 'Trial/Reference Code', productType: 'Product Type', recipeSeq: 'Recipe Sequence', date: 'Date', batchWeight: 'Batch Weight', yieldPct: 'Yield %' };

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
let recipeEditSnapshotBefore = null;

/* Wires a "pick from the shared list" field (Customer Name, Destination
   Country, Sales Rep). New values can no longer be added by just typing
   them here — that used to silently grow the shared list from free text,
   which the Reference Lists screen is meant to curate deliberately.
   Typing something not already in the list reverts the field and points
   the user at 📇 Reference Lists instead. The trash button just clears
   this recipe's own field. */
/* A recipe's link to a Project isn't a field on the recipe itself - it's
   read from whichever Project (if any) has a product entry whose recipeId
   matches, so the Project's own products list stays the single source of
   truth instead of two places that could drift out of sync. */
export function findProjectForRecipe(recipeId){
  for(const proj of projects){
    const prod = (proj.products || []).find(x => x.recipeId === recipeId);
    if(prod) return { project: proj, product: prod };
  }
  return null;
}

function renderLinkedProjectSection(r){
  const select = document.getElementById('f-linkedProject');
  if(!select) return;
  const link = findProjectForRecipe(r.id);
  const sortedProjects = [...projects].sort((a,b) => (a.name||'').localeCompare(b.name||'', undefined, {sensitivity:'base'}));
  select.innerHTML = `<option value="">— Not linked —</option>` +
    sortedProjects.map(p => `<option value="${escapeHtml(p.id)}" ${link && link.project.id === p.id ? 'selected' : ''}>${escapeHtml(p.name || 'Untitled project')}</option>`).join('');

  const infoEl = document.getElementById('linkedProjectInfo');
  if(!link){
    infoEl.innerHTML = '';
    return;
  }
  const { project, product } = link;
  const facts = [
    project.customerName ? `<b>Customer:</b> ${escapeHtml(project.customerName)}` : '',
    project.destinationCountry ? `<b>Destination:</b> ${escapeHtml(project.destinationCountry)}` : '',
    project.ownerSalesRep ? `<b>Project Owner:</b> ${escapeHtml(project.ownerSalesRep)}` : '',
    project.factoryName ? `<b>Factory:</b> ${escapeHtml(project.factoryName)}` : '',
    `<b>Stage:</b> ${escapeHtml(product.stage || '-')}`
  ].filter(Boolean);
  infoEl.innerHTML = `<div class="ci-row" style="margin-top:6px;">${facts.join(' &nbsp;|&nbsp; ')}</div>`;
}

function renderProductTypeSelect(r){
  const select = document.getElementById('f-productTypeMain');
  if(!select) return;
  const sortedTypes = [...metaLists.productTypes].sort((a,b) => metaItemName(a).localeCompare(metaItemName(b)));
  select.innerHTML = `<option value="">— Select —</option>` +
    sortedTypes.map(t => `<option value="${escapeHtml(metaItemName(t))}" ${metaItemName(t) === (r.productType || '') ? 'selected' : ''}>${escapeHtml(metaItemName(t))} (${escapeHtml(t.code || productTypeCode(metaItemName(t)))})</option>`).join('');
}

// The Recipe Code row's Product Type segment is a read-only badge, not its
// own picker — it always mirrors whatever's chosen in the Product Type
// field above (see f-productTypeMain), the same way codeYearDisplay mirrors
// the Date field instead of being independently editable.
function refreshCodeProductTypeBadge(r){
  const badge = document.getElementById('codeProductTypeDisplay');
  if(!badge) return;
  badge.textContent = recipeProductTypeCode(r) || 'TTT';
}

function bindComboField(r, fieldKey, inputId, deleteBtnId, metaKey){
  const input = document.getElementById(inputId);
  input.value = r[fieldKey] || '';
  let lastValidValue = r[fieldKey] || '';
  input.addEventListener('input', e => {
    r[fieldKey] = e.target.value;
    scheduleSave();
  });
  input.addEventListener('change', () => {
    const v = input.value.trim();
    const exists = v === '' || metaLists[metaKey].some(item => metaItemName(item) === v);
    if(!exists){
      alert(`"${v}" is not in the list yet. Please add it via Reference Lists first, then pick it here.`);
      input.value = lastValidValue;
      r[fieldKey] = lastValidValue;
      scheduleSave();
      return;
    }
    lastValidValue = v;
  });
  document.getElementById(deleteBtnId).addEventListener('click', () => {
    input.value = '';
    r[fieldKey] = '';
    lastValidValue = '';
    scheduleSave();
  });
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

function materialTooltip(m){
  const lines = [
    `EN: ${m.nameEn}`,
    `TH: ${m.nameTh}`,
    m.vendorCode ? `Code: ${m.vendorCode}` : null,
    m.vendorName ? `Vendor: ${m.vendorName}` : null,
    m.manufacturer ? `Manufacturer: ${m.manufacturer}` : null,
    (m.price !== '' && m.price != null) ? `Price/kg: ฿${m.price}` : null,
    formatMoq(m.moq) ? `MOQ: ${formatMoq(m.moq)}` : null,
    m.usageNotes ? `Usage: ${m.usageNotes}` : null
  ].filter(Boolean);
  return lines.join('\n');
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

function hasUnresolvedIngredient(part){
  return part.ingredients.some(i => (i.name || '').trim() !== '' && !i.materialId);
}

// True if every character of `query` appears in `text`, in order, letting
// anything else sit between them — classic fuzzy-search matching (e.g.
// "ckn brst" matches "chicken breast"). Case handling is the caller's job.
function isSubsequence(query, text){
  let qi = 0;
  for(let i = 0; i < text.length && qi < query.length; i++){
    if(text[i] === query[qi]) qi++;
  }
  return qi === query.length;
}

// Ranks the library by closeness to what's been typed so far — an exact
// prefix match ("chi" -> "Chicken...") ranks above a plain substring match
// ("hic" -> "Chicken..."), which ranks above a looser fuzzy/subsequence
// match, so the most likely intended ingredient sits at the top. Matches
// against the same combined "EN / TH (code)" label shown in the field
// itself, so searching in Thai, English, or by vendor code all work.
function fuzzyMaterialMatches(query, limit){
  const q = (query || '').trim().toLowerCase();
  if(!q) return [];
  const scored = ingredientMaster.map(m => {
    const label = materialLabel(m).toLowerCase();
    let score = 0;
    if(label.startsWith(q)) score = 3;
    else if(label.includes(q)) score = 2;
    else if(isSubsequence(q, label)) score = 1;
    return { m, score, label };
  }).filter(x => x.score > 0);
  scored.sort((a,b) => b.score - a.score || a.label.localeCompare(b.label));
  return scored.slice(0, limit || 8).map(x => x.m);
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
  document.getElementById('materialDetailModalOverlay').addEventListener('click', e => {
    if(e.target.id === 'materialDetailModalOverlay') closeMaterialDetail();
  });
}

const PART_COUNT = 4;

function blankPart(name){
  return { name, ingredients: [ { name:"", percent:0, weight:0, note:"" } ], parts: [] };
}

function blankRecipe(){
  return {
    id: uid(),
    name: "",
    code: "",
    productType: "",
    recipeSeq: "",
    date: new Date().toISOString().slice(0,10),
    customerName: "",
    destinationCountry: "",
    salesRep: "",
    description: [],
    descPhotos: [],
    batchWeight: 1000,
    parts: [],
    processes: [ { id: uid(), title: "", steps: [], components: [] } ],
    processFlowchart: { nodes: [], edges: [] },
    processViewMode: 'list',
    yieldPct: '',
    versions: [],
    createdBy: currentUser?.email || '',
    createdAt: Date.now(),
    updatedBy: currentUser?.email || '',
    updatedAt: Date.now()
  };
}

function migrateRecipe(r){
  if(!Array.isArray(r.parts)){
    const oldIngredients = Array.isArray(r.ingredients) && r.ingredients.length ? r.ingredients : [{ name:"", percent:0, weight:0, note:"" }];
    r.parts = [ { name:"Part 1", ingredients: oldIngredients } ];
    for(let i = r.parts.length; i < PART_COUNT; i++){
      r.parts.push(blankPart(`Part ${i+1}`));
    }
    delete r.ingredients;
  }
  // Recursive so it also normalizes Sub-parts nested arbitrarily deep
  // inside a Part — older saved recipes never had Sub-parts at all, so
  // `p.parts` simply won't exist on them yet; this backfills it as empty.
  function migratePart(p){
    if(!Array.isArray(p.ingredients) || p.ingredients.length === 0){
      p.ingredients = [{ name:"", percent:0, weight:0, note:"" }];
    }
    p.ingredients.forEach(ing => { if(ing.flowNodeId === undefined) ing.flowNodeId = null; });
    const oldPartName = /^ส่วนที่ (\d+)$/.exec(p.name || '');
    if(oldPartName) p.name = `Part ${oldPartName[1]}`;
    if(!Array.isArray(p.parts)) p.parts = [];
    p.parts.forEach(migratePart);
  }
  r.parts.forEach(migratePart);

  if(!Array.isArray(r.processes)){
    const oldSteps = Array.isArray(r.steps) ? r.steps.filter(s => (s||'').trim() !== '') : [];
    r.processes = [ { id: uid(), title: "", steps: oldSteps } ];
    delete r.steps;
  }
  if(r.processes.length === 0){
    r.processes.push({ id: uid(), title: "", steps: [], components: [] });
  }
  r.processes.forEach(p => {
    // Backfilled so Process Flowchart nodes can live-link to a specific
    // Process by a stable id — an array index would break the moment
    // Processes get reordered or one before it is deleted.
    if(!p.id) p.id = uid();
    // A Process is valid with just a title and no steps yet — no longer
    // force a blank placeholder step just to have something to render.
    if(!Array.isArray(p.steps)) p.steps = [];
    if(!Array.isArray(p.components)) p.components = [];
  });

  if(!r.processFlowchart || typeof r.processFlowchart !== 'object'){
    r.processFlowchart = { nodes: [], edges: [] };
  }
  if(!Array.isArray(r.processFlowchart.nodes)) r.processFlowchart.nodes = [];
  if(!Array.isArray(r.processFlowchart.edges)) r.processFlowchart.edges = [];
  // Normalizes any missing/garbage value to 'list' too, not just undefined.
  if(r.processViewMode !== 'flowchart') r.processViewMode = 'list';

  // Description used to be a single free-text field — upgrade it to a list
  // of separate points (characteristics, selling points, etc.).
  if(!Array.isArray(r.description)){
    r.description = (r.description || '').trim() ? [r.description] : [];
  }
  if(!Array.isArray(r.descPhotos)) r.descPhotos = [];
  if(r.customerName === undefined) r.customerName = '';
  if(r.destinationCountry === undefined) r.destinationCountry = '';
  if(r.salesRep === undefined) r.salesRep = '';

  if(r.yieldPct === undefined || r.yieldPct === null) r.yieldPct = '';
  if(!Array.isArray(r.versions)) r.versions = [];

  // Older recipes saved before activity tracking existed won't have these —
  // leave them blank rather than guessing a creator/date that isn't real.
  if(r.createdBy === undefined) r.createdBy = '';
  if(r.createdAt === undefined) r.createdAt = null;
  if(r.updatedBy === undefined) r.updatedBy = '';

  return r;
}

function saveRecipeToCloud(r){
  return setDoc(doc(recipesCol, r.id), r);
}

/* Firestore is the source of truth, but while a recipe is open for editing we
   keep its in-memory object identity stable across snapshot updates — the
   input handlers below mutate that object directly on every keystroke, and
   swapping in a fresh object from an incoming snapshot mid-edit would silently
   drop whatever the user just typed. Every other recipe still refreshes freely. */
function attachRecipesListener(){
  unsubscribeRecipes = onSnapshot(recipesCol, snapshot => {
    const previousCurrent = recipes.find(r => r.id === currentId);
    const incoming = snapshot.docs.map(d => d.data());
    incoming.forEach(r => { migrateRecipe(r); recomputeFromWeights(r); });

    if(previousCurrent && incoming.some(r => r.id === currentId)){
      recipes = incoming.map(r => r.id === currentId ? previousCurrent : r);
    }else{
      recipes = incoming;
    }

    const firstLoad = !recipesLoaded;
    recipesLoaded = true;
    migrateTrialsFromRecipes();

    if(currentId && !recipes.some(r => r.id === currentId)){
      // the recipe being viewed no longer exists (deleted) -> back to the homepage
      currentId = null;
      unlockedRecipeId = null;
      renderMain();
    }else if(firstLoad || (!currentId && !mainFeatureView)){
      // no recipe is open and no full-page feature view is active (home
      // dashboard is showing) -> safe to re-render on every update, since
      // there's no in-progress edit/selection whose state needs preserving.
      // The mainFeatureView check matters now that Compare/Materials/
      // RefLists/Projects/Trials live in #mainArea too — re-mounting one of
      // those from scratch (like this branch does) would silently wipe out
      // whatever the user had picked/typed there, which used to be
      // impossible when they were separate, always-persistent modals.
      renderMain();
    }

    renderSidebar();
  }, err => {
    console.error('Forge: recipes listener error', err);
    showCloudError('Failed to load recipe data from Firebase: ' + err.message);
  });
}

function getCurrent(){
  return recipes.find(r => r.id === currentId);
}

function performSave(r){
  if(!r) return;
  r.updatedAt = Date.now();
  r.updatedBy = currentUser?.email || '';
  saveRecipeToCloud(r);
  renderSidebar();
  if(r.id === currentId){
    updateRecipeTitleDisplay(r); // refresh "Last edited by/at" now that it's current
    const s = document.getElementById('saveStatus');
    if(s){
      s.textContent = 'Saved ' + new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
      s.classList.add('saved');
    }
  }
}

function scheduleSave(){
  // Captured now (while the edit that triggered this call is still the
  // current recipe) rather than inside the timeout — otherwise switching
  // recipes within the debounce window would save whatever recipe happens
  // to be open 400ms later instead of the one actually edited.
  const r = getCurrent();
  const status = document.getElementById('saveStatus');
  if(status){ status.textContent = 'Saving...'; status.classList.remove('saved'); }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => performSave(r), 400);
  if(r) scheduleVersionCheckpoint(r);
}

// Shared by every path that should leave a Version History entry (manual
// Save, the 1-minute idle auto-checkpoint, and "Save Current as Version" in
// the modal) — same snapshot shape, same 5-version cap, one place to change.
function pushVersionCheckpoint(r, label){
  if(!Array.isArray(r.versions)) r.versions = [];
  r.versions.push({ id: uid(), label, savedAt: Date.now(), snapshot: snapshotRecipeCore(r) });
  if(r.versions.length > 5) r.versions = r.versions.slice(r.versions.length - 5);
}

// Manual Save button — flushes the pending debounced save immediately,
// cancels this recipe's pending idle auto-checkpoint (redundant now that
// we're checkpointing right here), takes its own Version History
// checkpoint — so clicking Save is enough on its own; there's no separate
// "Save Current as Version" step needed for a plain save to be revertible
// — and locks the recipe back to read-only view, the same way finishing an
// edit and stepping away from it should feel: Save = "I'm done for now."
function saveNow(){
  const r = getCurrent();
  if(!r) return;
  clearTimeout(saveTimer);
  cancelVersionCheckpoint(r);
  pushVersionCheckpoint(r, 'Saved');
  performSave(r);
  logActivityEvent('updated', 'recipe', r.name || 'Untitled recipe', diffMainFields(recipeEditSnapshotBefore, r, RECIPE_DIFF_FIELDS));
  recipeEditSnapshotBefore = null;
  if(versionsModalRecipe === r) renderVersionsList(r);
  unlockedRecipeId = null;
  renderMain();
}

// Idle auto-checkpoint: if a recipe has an edit sitting for 60s with no
// manual Save click, snapshot it into Version History so that auto-save is
// always revertible, then arms again on the next edit — so a long
// uninterrupted editing session still gets a checkpoint roughly once a
// minute, not just once total.
function scheduleVersionCheckpoint(r){
  let entry = versionCheckpointTimers.get(r.id);
  if(!entry){
    entry = { timer: null, dirty: false };
    versionCheckpointTimers.set(r.id, entry);
  }
  entry.dirty = true;
  if(entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if(!entry.dirty) return;
    entry.dirty = false;
    autoCheckpointVersion(r);
  }, 60000);
}

function cancelVersionCheckpoint(r){
  const entry = versionCheckpointTimers.get(r.id);
  if(!entry) return;
  clearTimeout(entry.timer);
  entry.timer = null;
  entry.dirty = false;
}

function autoCheckpointVersion(r){
  pushVersionCheckpoint(r, 'Auto-saved (unsaved for 1 min)');
  performSave(r);
  if(versionsModalRecipe === r) renderVersionsList(r);
}

/* ---------- Sidebar ---------- */
const FEATURE_VIEW_BUTTON_IDS = {
  compare: 'btnCompare', materials: 'btnOpenMaterialLibSidebar',
  refLists: 'btnOpenRefLists', projects: 'btnOpenProjects', trials: 'btnOpenTrials'
};

// Shared by the compact sidebar list (shown while a recipe is open) and the
// full-page Recipes view (shown from the "Recipes" tab) — same cards, same
// click-to-open behavior, just mounted into whichever container is visible
// right now so the two never have to duplicate this logic separately.
function renderRecipeCards(container, query){
  if(!container) return;
  const q = (query || '').trim().toLowerCase();
  const sorted = [...recipes].sort((a,b)=>b.updatedAt-a.updatedAt);
  container.innerHTML = '';
  sorted.filter(r => !q || (r.name||'Untitled').toLowerCase().includes(q))
    .forEach(r => {
      const div = document.createElement('div');
      div.className = 'recipe-item' + (r.id === currentId ? ' active' : '');
      const allIngredients = allIngredientsInRecipe(r);
      // % is always weight / totalWeight, so it's exactly 100% by
      // construction whenever there's any weight at all (ing.percent is now
      // per-part, so it can't be summed directly to check this).
      const hasWeight = allIngredients.some(i => (parseFloat(i.weight)||0) > 0);
      const totalPct = hasWeight ? 100 : 0;
      const codeDisplay = fullCode(r);
      div.innerHTML = `
        <div class="r-name">${escapeHtml(recipeDisplayLabel(r))}</div>
        <div class="r-meta">${codeDisplay ? escapeHtml(codeDisplay)+' · ' : ''}${totalPct.toFixed(1)}% · ${allIngredients.length} ingredients</div>
      `;
      div.addEventListener('click', () => guardNavigation(() => {
        if(r.id !== currentId) unlockedRecipeId = null;
        currentId = r.id;
        mainFeatureView = null;
        renderMain();
        renderSidebar();
      }));
      container.appendChild(div);
    });
}

function createNewRecipe(){
  const r = blankRecipe();
  recipes.push(r);
  currentId = r.id;
  unlockedRecipeId = r.id;
  mainFeatureView = null;
  saveRecipeToCloud(r);
  logActivityEvent('created', 'recipe', r.name || 'Untitled recipe');
  renderSidebar();
  renderMain();
}

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
  renderRecipeCards(document.getElementById('recipeList'), document.getElementById('searchInput').value);
}

// The "Recipes" tab's full-page view — browsing recipes without committing
// to one yet. Opening a specific recipe from here hands off to the compact
// sidebar list instead (see renderMain()'s hide-recipes-nav toggle), so
// these two recipe lists are never both on screen at once.
function mountRecipesListView(){
  const main = document.getElementById('mainArea');
  main.classList.remove('main-wide');
  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('file-text', 24)} Recipes</div>
    </div>
    <div class="card">
      <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
        <button class="btn btn-primary" id="btnNewFromRecipesList">+ New Recipe</button>
        <button class="btn" id="btnCompareFromRecipesList">${icon('scale')} Compare Recipes</button>
      </div>
      <div class="search-box" style="margin:0 0 16px;">
        <input type="text" id="recipesListSearchInput" placeholder="Search product name...">
      </div>
      <div class="recipe-list" id="recipesListGrid"></div>
    </div>
  `;

  document.getElementById('btnNewFromRecipesList').addEventListener('click', createNewRecipe);
  document.getElementById('btnCompareFromRecipesList').addEventListener('click', () => {
    mainFeatureView = 'compare';
    renderMain();
    renderSidebar();
  });
  document.getElementById('recipesListSearchInput').addEventListener('input', renderRecipesListGrid);

  renderRecipesListGrid();
  playContentTransition(main);
}
function renderRecipesListGrid(){
  renderRecipeCards(document.getElementById('recipesListGrid'), document.getElementById('recipesListSearchInput')?.value);
}

// r.date is always "YYYY-MM-DD" (a <input type="date"> value), so the year
// is always its first 4 characters — the code format only keeps the last 2.
function yearPrefix(dateStr){
  return dateStr && dateStr.length >= 4 ? dateStr.slice(2, 4) : 'YY';
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
function countryToIso2(name){
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

// The recipe's own Destination Country field was removed in favor of linking
// a Project (see findProjectForRecipe) — that link is now the single source
// of truth for where a recipe is headed.
function recipeDestinationIso2(r){
  const link = findProjectForRecipe(r.id);
  return link ? countryToIso2(link.project.destinationCountry) : '';
}

// Looked up fresh from Reference Lists > Product Types each time (rather
// than duplicated onto the recipe) so a renamed type's code — always
// recalculated from its new name, see productTypeCode — stays correct
// everywhere it's referenced instead of going stale.
function recipeProductTypeCode(r){
  const item = metaLists.productTypes.find(x => metaItemName(x) === (r.productType || ''));
  return item ? (item.code || productTypeCode(metaItemName(item))) : '';
}

// Auto-assigned recipe sequence number (see codeRecipeSeqDisplay, not
// manually editable) — one past the highest number already used by this
// product type. Deliberately max-based rather than count-based: a raw
// count of same-type recipes collides with an in-use number as soon as one
// same-type recipe is deleted (e.g. type has 01/02/03, delete 02 → a
// count-based calc for the next new one gives 03 again, colliding with the
// existing 03; max-based correctly gives 04).
function suggestNextRecipeSeq(productTypeName, excludeId){
  const maxSeq = recipes
    .filter(x => x.id !== excludeId && (x.productType || '') === productTypeName)
    .reduce((max, x) => Math.max(max, parseInt(x.recipeSeq, 10) || 0), 0);
  return String(maxSeq + 1).padStart(2, '0');
}

export function fullCode(r){
  const yy = yearPrefix(r.date);
  const typeCode = recipeProductTypeCode(r);
  const seq = (r.recipeSeq || '').trim();
  const trial = (r.code || '').trim();
  if(yy === 'YY' && !typeCode && !seq && !trial) return '';
  const iso = recipeDestinationIso2(r);
  return (iso || '') + yy + '-' + (typeCode || 'XXX') + (seq || 'XX') + '-T' + (trial || 'XX');
}

/* Product name with the last 2 characters of the recipe code suffix appended,
   e.g. "Vegan Tartar Sauce - 19" — used anywhere recipes are picked/labeled
   so near-duplicate names stay distinguishable at a glance. */
export function recipeDisplayLabel(r){
  const name = r.name || 'Untitled recipe';
  const suffix = (r.code || '').trim();
  return suffix ? `${name} - ${suffix}` : name;
}

/* Shared by the Compare Recipes info card and the print info card — renders
   the Description/Concept points (an array) as a small bullet list. */
export function descriptionListHtml(r){
  const points = (r.description || []).filter(p => (p||'').trim() !== '');
  if(points.length === 0) return '<div class="ci-row"><b>Description:</b> -</div>';
  return `
    <div class="ci-row"><b>Description:</b></div>
    <ol class="ci-desc-list">${points.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ol>
  `;
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
const ACTIVITY_ENTITY_LABELS = { recipe: 'Recipe', project: 'Project', trial: 'Test', material: 'Ingredient' };
const ACTIVITY_VERB_LABELS = { created: 'added', updated: 'edited', deleted: 'deleted' };
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

function refreshCodeCountryBadge(r){
  const row = document.getElementById('codeYearDisplay')?.closest('.code-row');
  const badge = document.getElementById('codeCountryDisplay');
  if(!row || !badge) return;
  const iso = recipeDestinationIso2(r);
  row.classList.toggle('has-country-badge', !!iso);
  badge.style.display = iso ? '' : 'none';
  badge.textContent = iso;
}

function updateRecipeTitleDisplay(r){
  const el = document.getElementById('recipeTitleDisplay');
  if(!el) return;
  const code = fullCode(r);
  el.innerHTML = `${escapeHtml(r.name || 'Untitled recipe')}${code ? `<span class="rt-code">${escapeHtml(code)}</span>` : ''}`;

  const activityEl = document.getElementById('recipeActivityDisplay');
  if(activityEl){
    const parts = [];
    if(r.createdBy) parts.push(`Created by ${r.createdBy}${r.createdAt ? ' · ' + formatActivityDateTime(r.createdAt) : ''}`);
    if(r.updatedBy) parts.push(`Last edited by ${r.updatedBy}${r.updatedAt ? ' · ' + formatActivityDateTime(r.updatedAt) : ''}`);
    activityEl.textContent = parts.join('   |   ');
  }
}

export function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
  'menu': '<path d="M4 5h16" /><path d="M4 12h16" /><path d="M4 19h16" />',
  'move': '<path d="M12 2v20" /><path d="m15 19-3 3-3-3" /><path d="m19 9 3 3-3 3" /><path d="M2 12h20" /><path d="m5 9-3 3 3 3" /><path d="m9 5 3-3 3 3" />',
  'party-popper': '<path d="M5.8 11.3 2 22l10.7-3.79" /><path d="M4 3h.01" /><path d="M22 8h.01" /><path d="M15 2h.01" /><path d="M22 20h.01" /><path d="m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10" /><path d="m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17" /><path d="m11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7" /><path d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z" />',
  'pencil': '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" />',
  'plus': '<path d="M5 12h14" /><path d="M12 5v14" />',
  'printer': '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" /><rect x="6" y="14" width="12" height="8" rx="1" />',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />',
  'save': '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" /><path d="M7 3v4a1 1 0 0 0 1 1h7" />',
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

// Tracks which month the Home dashboard's Activities Calendar is currently
// showing — any date within that month works, only year/month are read.
// Reset to the real current month by the Today button; otherwise carried
// forward across re-renders so paging doesn't snap back to the current
// month every time something else on the dashboard changes.
let homeCalendarViewDate = new Date();

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
      events.push({
        projectId: p.id,
        projectName: p.name || 'Untitled project',
        text: muPlanSummaryLine(mu) || mu.actionTaken || 'Untitled task',
        date: mu.date,
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
function renderCalendarCardHtml(viewDate, events){
  const year = viewDate.getFullYear(), month = viewDate.getMonth();
  // Matches the rest of the app's existing (if imperfect in far-west
  // timezones) "today" convention — see getTaskStatus/computeTaskTracking
  // — so a task the calendar colors as overdue agrees with Task Tracking.
  const todayStr = new Date().toISOString().slice(0, 10);
  const firstOfMonth = new Date(year, month, 1);
  const startDow = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;
  const gridStart = new Date(year, month, 1 - startDow);

  const eventsByDate = {};
  events.forEach(ev => {
    (eventsByDate[ev.date] || (eventsByDate[ev.date] = [])).push(ev);
  });

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
      <div class="cal-cell${inMonth ? '' : ' cal-cell-outmonth'}${isToday ? ' cal-cell-today' : ''}">
        <div class="cal-cell-date">${escapeHtml(dayLabel)}</div>
        <div class="cal-cell-events">
          ${dayEvents.map(ev => {
            const status = getTaskStatus(ev.mu, todayStr);
            return `
              <div class="cal-event-wrap">
                <button type="button" class="cal-event cal-event-${status} action-go-btn" data-item-type="project" data-item-id="${escapeHtml(ev.projectId)}" data-focus-section="activities">${escapeHtml(ev.text)}</button>
                <div class="cal-event-tooltip"><b>${escapeHtml(ev.projectName)}</b><br>${escapeHtml(ev.text)}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  return `
    <div class="dash-card" id="activitiesCalendarCard" style="margin-bottom:14px;">
      <div class="cal-header-bar">
        <div class="dash-card-title" style="margin-bottom:0;">Activities Calendar</div>
        <div class="cal-nav">
          <button type="button" class="btn btn-sm" id="calToday">Today</button>
          <button type="button" class="icon-btn" id="calPrevMonth" title="Previous month">‹</button>
          <span class="cal-month-label">${escapeHtml(viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))}</span>
          <button type="button" class="icon-btn" id="calNextMonth" title="Next month">›</button>
        </div>
      </div>
      <div class="cal-dow-row">${CAL_DOW_NAMES.map(n => `<div class="cal-dow">${n}</div>`).join('')}</div>
      <div class="cal-grid">${cellsHtml}</div>
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
  document.getElementById('calPrevMonth')?.addEventListener('click', () => {
    homeCalendarViewDate = new Date(homeCalendarViewDate.getFullYear(), homeCalendarViewDate.getMonth() - 1, 1);
    refreshDashboardHome();
  });
  document.getElementById('calNextMonth')?.addEventListener('click', () => {
    homeCalendarViewDate = new Date(homeCalendarViewDate.getFullYear(), homeCalendarViewDate.getMonth() + 1, 1);
    refreshDashboardHome();
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
  refLists: mountRefListsView,
  projects: mountProjectsView,
  trials: mountTrialsView
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
  if(recipeId !== currentId) unlockedRecipeId = null;
  currentId = recipeId;
  mainFeatureView = null;
  renderMain();
  renderSidebar();
}

export function renderMain(){
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

  main.innerHTML = `
    <div class="main-header">
      <div>
        <div class="recipe-title-display" id="recipeTitleDisplay"></div>
        <div class="save-status saved" id="saveStatus">Ready</div>
        <div class="recipe-activity-display" id="recipeActivityDisplay"></div>
      </div>
    </div>

    <div class="recipe-header-actions">
      <div class="lock-banner" id="lockBanner"></div>
      <div class="toolbar">
        <button class="btn" id="btnVersions">${icon('clock')} Versions</button>
        <button class="btn" id="btnDuplicate">${icon('copy')} Duplicate</button>
        <button class="btn" id="btnPrint">${icon('printer')} Print / PDF</button>
        <button class="btn" id="btnExportExcel">${icon('download')} Export Excel</button>
      </div>
    </div>

    <div id="recipeCards">
    <div class="card">
      <div class="card-title">1. Product Details</div>
      <div class="recipe-fields-edit">
        <div class="grid-2">
          <div class="field">
            <label>Product Name</label>
            <input type="text" id="f-name" placeholder="e.g. Vegan Tartar Sauce">
          </div>
          <div class="field">
            <label>Date</label>
            <input type="date" id="f-date">
          </div>
        </div>
        <div class="field">
          <label>Project</label>
          <select id="f-linkedProject" class="proj-select"></select>
          <div id="linkedProjectInfo"></div>
        </div>
        <div class="field">
          <label>Product Type</label>
          <select id="f-productTypeMain" class="proj-select"></select>
        </div>
        <div class="grid-2">
          <div class="field">
            <label>Description / Concept</label>
            <div class="desc-points-list" id="descPointsList"></div>
            <button class="btn btn-sm add-row-btn" type="button" id="btnAddDescPoint">+ Add Point</button>
            <div class="desc-photos-label">Photos (up to 3)</div>
            <div class="trial-photos-row" id="descPhotosRow"></div>
            <input type="file" id="descPhotoInput" accept="image/*">
          </div>
          <div class="field">
            <label>Recipe Code — CCYY-TTTNN-TNN</label>
            <div class="code-row">
              <span class="code-prefix" id="codeCountryDisplay" style="display:none;" title="Country code auto-filled from the linked Project's Destination Country"></span>
              <span class="code-prefix" id="codeYearDisplay">YY</span>
              <span class="code-sep">-</span>
              <span class="code-prefix" id="codeProductTypeDisplay" title="From the Product Type field above">TTT</span>
              <span class="code-prefix" id="codeRecipeSeqDisplay" title="Recipe sequence number for this product type — assigned automatically">NN</span>
              <span class="code-sep">-</span>
              <span class="code-prefix">T</span>
              <input type="text" id="f-codeSuffix" class="code-suffix code-suffix-sm" placeholder="01" maxlength="6" title="Trial number for this recipe">
            </div>
          </div>
        </div>
      </div>
      <div id="printInfoCard" class="print-only compare-info-col"></div>
    </div>

    <div class="card">
      <div class="card-title">2. Recipe Overview (all parts combined)</div>
      <div class="overview-block">
        <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th class="col-no">#</th>
              <th>Ingredient</th>
              <th class="col-pct">% of Recipe</th>
              <th class="col-wt">Total Weight (g)</th>
            </tr>
          </thead>
          <tbody id="overviewBody"></tbody>
          <tfoot>
            <tr>
              <td></td>
              <td>Total</td>
              <td class="col-pct" id="grandTotalPct"></td>
              <td class="col-wt" id="grandTotalWt"></td>
            </tr>
          </tfoot>
        </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">3. Components and Process</div>
      <div class="components-process-grid">
      <div class="ingredients-edit-view">
      <button class="btn btn-sm material-lib-btn" id="btnOpenMaterialLib">${icon('book-open')} Ingredient Library (select existing / add new)</button>
      <div class="batch-summary">
        <div>
          <div class="batch-stat-label">Total Recipe Weight (auto-calculated from all ingredient weights)</div>
          <div class="batch-stat-value" id="batchTotalDisplay">0.00 g</div>
        </div>
        <div>
          <div class="batch-stat-label">Scale Recipe To (g)</div>
          <div class="batch-scale-row">
            <input type="number" id="f-scaleTo" min="0" step="0.01" placeholder="e.g. 1000">
            <button class="btn btn-sm" id="btnScale">Scale</button>
          </div>
        </div>
        <div>
          <div class="batch-stat-label">Expected Yield (%) — production loss, e.g. cooking/trim</div>
          <div class="batch-scale-row">
            <input type="number" id="f-yieldPct" min="0" max="100" step="0.01" placeholder="e.g. 95" class="unit-input">
            <span class="unit-suffix">%</span>
          </div>
        </div>
        <div>
          <div class="batch-stat-label">Adjusted Output Weight (after yield loss)</div>
          <div class="batch-stat-value" id="yieldAdjustedDisplay">—</div>
        </div>
      </div>
      <div class="ingredient-tree">
        <div class="tree-node tree-root-node">
          <span class="tree-node-label">Formula per Portion</span>
          <span class="tree-node-pct">100.00%</span>
          <span class="tree-node-wt tree-root-wt-wrap">
            <input type="number" class="num-input tree-root-wt-input" id="treeRootWt" step="0.01" min="0" title="Type a total weight (g) to scale the whole recipe proportionally">
            <span class="ing-unit">g</span>
          </span>
        </div>
        <div id="partsContainer" class="tree-children"></div>
        <button class="btn btn-sm add-row-btn" id="btnAddPart">+ Add Part</button>
      </div>
      </div>
      <div class="simple-process-col">
        <div class="simple-process-col-title">Process</div>
        <div id="simpleProcessPreview"></div>
      </div>
      </div>
      <div id="printIngredientTree" class="print-only"></div>
    </div>

    <div class="card">
      <div class="card-title">
        4. Process Steps
        <div class="view-mode-toggle" id="processViewToggle">
          <button type="button" class="btn btn-sm view-mode-btn" data-mode="list">${icon('list', 14)} List</button>
          <button type="button" class="btn btn-sm view-mode-btn" data-mode="flowchart">${icon('git-branch', 14)} Flowchart</button>
        </div>
      </div>
      <div id="processesListWrap">
        <div class="processes-list" id="processesList"></div>
        <button class="btn btn-sm add-row-btn" id="btnAddProcess">+ Add Process</button>
      </div>

      <div class="flow-canvas-wrap process-view-hidden" id="flowchartCanvasWrap">
        <div class="flow-toolbar">
          <button type="button" class="btn btn-sm" id="btnAddFlowNode">${icon('plus', 14)} Add Node</button>
        </div>
        <div class="flow-canvas-scroll" id="flowchartCanvasScroll">
          <div class="flow-canvas" id="flowchartCanvas">
            <svg class="flow-edges-svg" id="flowEdgesSvg"></svg>
            <div class="flow-nodes-layer" id="flowNodesLayer"></div>
          </div>
        </div>
      </div>

      <div id="printProcessesView" class="print-only compare-steps-col"></div>
      <div id="printProcessFlowchart" class="print-only"></div>
    </div>
    </div>

    <div class="danger-zone">
      <button class="btn btn-danger btn-block" id="btnDelete">${icon('trash-2')} Delete Recipe</button>
    </div>
  `;

  document.getElementById('f-name').value = r.name || '';
  document.getElementById('f-codeSuffix').value = r.code || '';
  // Safety net: a recipe that already has a Product Type but somehow never
  // got a sequence number (shouldn't normally happen, since picking a Type
  // always assigns one — see the change handler below) gets one now rather
  // than showing blank forever, since this field is never manually editable.
  if(r.productType && !r.recipeSeq){
    r.recipeSeq = suggestNextRecipeSeq(r.productType, r.id);
    scheduleSave();
  }
  document.getElementById('codeRecipeSeqDisplay').textContent = r.recipeSeq || 'NN';
  document.getElementById('codeYearDisplay').textContent = yearPrefix(r.date);
  document.getElementById('f-date').value = r.date || '';
  renderProductTypeSelect(r);
  refreshCodeProductTypeBadge(r);
  renderLinkedProjectSection(r);
  refreshCodeCountryBadge(r);
  document.getElementById('f-linkedProject').addEventListener('change', e => {
    const newProjectId = e.target.value;
    const oldLink = findProjectForRecipe(r.id);
    if(oldLink && oldLink.project.id !== newProjectId){
      oldLink.project.products = oldLink.project.products.filter(x => x.recipeId !== r.id);
      scheduleProjectSave(oldLink.project);
    }
    if(newProjectId && (!oldLink || oldLink.project.id !== newProjectId)){
      const newProject = projects.find(p => p.id === newProjectId);
      if(newProject && !newProject.products.some(x => x.recipeId === r.id)){
        newProject.products.push(blankProduct(r.id));
        scheduleProjectSave(newProject);
      }
    }
    renderLinkedProjectSection(r);
    refreshCodeCountryBadge(r);
    updateRecipeTitleDisplay(r);
  });
  updateRecipeTitleDisplay(r);
  renderDescPoints(r);
  renderDescPhotos(r);

  document.getElementById('f-name').addEventListener('input', e => {
    r.name = e.target.value;
    updateRecipeTitleDisplay(r);
    scheduleSave();
  });
  document.getElementById('f-codeSuffix').addEventListener('input', e => {
    r.code = e.target.value;
    updateRecipeTitleDisplay(r);
    scheduleSave();
  });
  document.getElementById('f-productTypeMain').addEventListener('change', e => {
    r.productType = e.target.value;
    refreshCodeProductTypeBadge(r);
    // Re-assign the sequence number for the newly-picked type — whatever
    // number belonged to the old type wouldn't mean anything for this one.
    // Not manually editable, so this is the only place it's ever set.
    r.recipeSeq = r.productType ? suggestNextRecipeSeq(r.productType, r.id) : '';
    document.getElementById('codeRecipeSeqDisplay').textContent = r.recipeSeq || 'NN';
    updateRecipeTitleDisplay(r);
    scheduleSave();
  });
  document.getElementById('descPhotoInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if(!file || r.descPhotos.length >= 3) return;
    r.descPhotos.push(await resizeImageFile(file, 500));
    renderDescPhotos(r);
    scheduleSave();
  });
  document.getElementById('btnAddDescPoint').addEventListener('click', () => {
    r.description.push('');
    renderDescPoints(r);
    scheduleSave();
  });
  document.getElementById('f-date').addEventListener('input', e => {
    r.date = e.target.value;
    document.getElementById('codeYearDisplay').textContent = yearPrefix(r.date);
    updateRecipeTitleDisplay(r);
    scheduleSave();
  });

  document.getElementById('btnOpenMaterialLib').addEventListener('click', () => {
    mainFeatureView = 'materials';
    renderMain();
    renderSidebar();
  });

  document.getElementById('btnScale').addEventListener('click', () => {
    const target = parseFloat(document.getElementById('f-scaleTo').value) || 0;
    const currentTotal = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
    if(target <= 0){ alert('Please enter a target weight greater than 0'); return; }
    if(currentTotal <= 0){ alert('Please enter at least one ingredient weight before scaling the recipe'); return; }
    const factor = target / currentTotal;
    r.parts.forEach(part => scaleIngredientsInPart(part, factor));
    recomputeFromWeights(r);
    renderParts(r);
    scheduleSave();
  });

  // The tree root's own weight (g) — always 100% of the recipe by
  // definition, so there's no % field to edit, just weight. Typing here
  // scales every top-level Part (and everything nested inside it)
  // proportionally, same math as the "Scale Recipe To" button above, just
  // inline where the total is already shown. A no-op with nothing yet
  // weighed in (0g total) since there's no ratio to scale from.
  const treeRootWtInput = document.getElementById('treeRootWt');
  function scaleRecipeTo(targetWeight){
    const currentTotal = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
    if(targetWeight < 0 || currentTotal <= 0) return;
    const factor = targetWeight / currentTotal;
    r.parts.forEach(part => scaleIngredientsInPart(part, factor));
  }
  treeRootWtInput.addEventListener('input', e => {
    const target = parseFloat(e.target.value);
    if(!isNaN(target)) scaleRecipeTo(target);
    refreshDisplays(r);
    scheduleSave();
  });
  treeRootWtInput.addEventListener('blur', () => {
    treeRootWtInput.value = (r.batchWeight || 0).toFixed(2);
  });
  let treeRootWtJustFocused = false;
  treeRootWtInput.addEventListener('mousedown', () => { treeRootWtJustFocused = document.activeElement !== treeRootWtInput; });
  treeRootWtInput.addEventListener('focus', () => treeRootWtInput.select());
  treeRootWtInput.addEventListener('mouseup', e => { if(treeRootWtJustFocused){ e.preventDefault(); treeRootWtJustFocused = false; } });

  document.getElementById('f-yieldPct').value = r.yieldPct ?? '';
  document.getElementById('f-yieldPct').addEventListener('input', e => {
    r.yieldPct = e.target.value === '' ? '' : parseFloat(e.target.value) || 0;
    updateYieldDisplay(r);
    scheduleSave();
  });

  renderParts(r);
  renderProcesses(r);
  refreshProcessViewMode(r);
  document.getElementById('processViewToggle').addEventListener('click', e => {
    const btn = e.target.closest('.view-mode-btn');
    if(btn) setProcessViewMode(r, btn.dataset.mode);
  });
  document.getElementById('btnAddFlowNode').addEventListener('click', () => addFlowNode(r));
  document.getElementById('flowEdgesSvg').addEventListener('click', e => {
    if(e.target.classList.contains('flow-edge-hit')) deleteFlowEdge(r, e.target.dataset.edgeId);
  });

  document.getElementById('btnAddPart').addEventListener('click', () => {
    r.parts.push(blankPart(`Part ${r.parts.length+1}`));
    renderParts(r);
    renderProcesses(r); // refresh the "Add Component" picker with the new part
    scheduleSave();
  });

  document.getElementById('btnAddProcess').addEventListener('click', () => {
    r.processes.push({ id: uid(), title: '', steps: [], components: [] });
    renderProcesses(r);
    scheduleSave();
  });

  document.getElementById('btnVersions').addEventListener('click', () => openVersionsModal(r));
  document.getElementById('btnDuplicate').addEventListener('click', duplicateCurrent);
  document.getElementById('btnDelete').addEventListener('click', () => {
    const deletingId = r.id;
    if(!confirm(`Delete "${r.name || 'Untitled recipe'}"? This cannot be undone.`)) return;
    requestAuthConfirm(
      'Confirm Deletion',
      `Enter the approver's email and password to permanently delete the recipe "${r.name || 'Untitled recipe'}"`,
      () => deleteCurrent(),
      {
        requireEmail: DELETE_APPROVER_EMAIL,
        approverAction: () => deleteDoc(doc(approverRecipesCol, deletingId))
          .then(() => logActivityEvent('deleted', 'recipe', r.name || 'Untitled recipe'))
      }
    );
  });
  document.getElementById('btnPrint').addEventListener('click', () => {
    renderPrintView(r);
    // Browsers default the "Save as PDF" filename to document.title, so set
    // it to "Recipe Product Name Recipe Code Forge" just for the print, then
    // restore the real page title afterwards.
    const originalTitle = document.title;
    const code = fullCode(r);
    const namePart = [r.name || 'Untitled recipe', code].filter(Boolean).join(' ');
    document.title = `Recipe ${namePart} Forge`.replace(/[\\/:*?"<>|]/g, '-');
    const restoreTitle = () => {
      document.title = originalTitle;
      window.removeEventListener('afterprint', restoreTitle);
    };
    window.addEventListener('afterprint', restoreTitle);
    window.print();
  });

  document.getElementById('btnExportExcel').addEventListener('click', () => exportRecipeToExcel(r));

  renderLockState(r);
  playContentTransition(main);
}

function renderLockState(r){
  const banner = document.getElementById('lockBanner');
  const cards = document.getElementById('recipeCards');
  const isUnlocked = unlockedRecipeId === r.id;

  if(isUnlocked){
    banner.className = 'lock-banner unlocked';
    banner.innerHTML = `${icon('unlock')} This recipe is unlocked for editing <button class="btn btn-sm btn-primary lock-banner-action" id="btnSaveRecipe">${icon('save')} Save</button>`;
    document.getElementById('btnSaveRecipe').addEventListener('click', saveNow);
  }else{
    banner.className = 'lock-banner locked';
    banner.innerHTML = `${icon('lock')} This recipe is read-only <button class="btn btn-sm btn-primary lock-banner-action" id="btnUnlockEdit">${icon('unlock')} Unlock to Edit</button>`;
    document.getElementById('btnUnlockEdit').addEventListener('click', () => {
      requestAuthConfirm(
        'Confirm Identity to Edit',
        `Enter your password to unlock editing for the recipe "${r.name || 'Untitled recipe'}"`,
        () => {
          unlockedRecipeId = r.id;
          recipeEditSnapshotBefore = snapshotMainFields(r, RECIPE_DIFF_FIELDS);
          renderMain();
        }
      );
    });
    cards.querySelectorAll('input, textarea, button').forEach(el => { el.disabled = true; });
  }
}

/* ---------- Ingredients (Parts, arbitrarily nestable via Sub-parts) ----------
   Weight (g) is the single source of truth per ingredient — a Part never
   stores its own weight, it's always the recursive sum of what's inside it.
   Each ingredient's/Sub-part's % is of its own immediate parent, so every
   Part's own direct children are mathematically guaranteed to sum to 100%
   of that Part. A top-level Part's % is therefore "% of recipe"; a nested
   Sub-part's % is "% of Part" (its immediate parent), exactly like an
   ingredient's % already is. */
function recomputeFromWeights(r){
  // recomputePartPercents(part) assigns .percent to `part`'s own CHILDREN,
  // not to `part` itself — for a nested Sub-part that assignment happens
  // one level up, in its parent's own call. Top-level Parts have no such
  // parent (the recipe root isn't a Part), so their own .percent has to be
  // assigned explicitly here, the same way, against the recipe total.
  const partTotals = (r.parts || []).map(part => recomputePartPercents(part));
  const totalWeight = partTotals.reduce((s,w)=>s+w,0);
  (r.parts || []).forEach((part, idx) => {
    part.percent = totalWeight > 0 ? round2(partTotals[idx] / totalWeight * 100) : 0;
  });
  r.batchWeight = round2(totalWeight);
  return totalWeight;
}

// Recursively totals one Part (its own ingredients' weights + every
// Sub-part's own recursive total), then assigns each direct child (each
// ingredient's .percent, each Sub-part's own .percent) its share of that
// total — then recurses so every Sub-part does the same for its own
// children. Returns the Part's own total weight.
function recomputePartPercents(part){
  const ingWeights = (part.ingredients || []).map(i => parseFloat(i.weight) || 0);
  const subTotals = (part.parts || []).map(sub => recomputePartPercents(sub));
  const total = ingWeights.reduce((s,w)=>s+w,0) + subTotals.reduce((s,w)=>s+w,0);
  (part.ingredients || []).forEach((ing, idx) => {
    ing.percent = total > 0 ? round2(ingWeights[idx] / total * 100) : 0;
  });
  (part.parts || []).forEach((sub, idx) => {
    sub.percent = total > 0 ? round2(subTotals[idx] / total * 100) : 0;
  });
  return round2(total);
}

// A Part's own weight, recursively summing its direct ingredients plus
// every Sub-part's own recursive total.
function partTotalWeight(part){
  const direct = (part.ingredients || []).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
  const nested = (part.parts || []).reduce((s,sub)=>s+partTotalWeight(sub),0);
  return direct + nested;
}

// Every ingredient under a Part, including ones nested inside its
// Sub-parts — used anywhere that just needs "the full ingredient list"
// (Compare Recipes, Print, Recipe Overview, Ingredient Library usage,
// Trial totals) without needing to also show the nesting itself.
export function allIngredientsInPart(part){
  return [...(part.ingredients || []), ...(part.parts || []).flatMap(allIngredientsInPart)];
}
export function allIngredientsInRecipe(r){
  return (r.parts || []).flatMap(allIngredientsInPart);
}

// Same idea as allIngredientsInPart, but keeps each ingredient's Part path
// (e.g. "Part 1 > Sauce Sub-part") instead of flattening it away — the
// export sheet needs to show which Part/Sub-part an ingredient belongs to,
// which allIngredientsInPart's callers never needed.
function flattenPartForExcel(part, pathPrefix){
  const path = pathPrefix ? `${pathPrefix} > ${part.name || 'Untitled part'}` : (part.name || 'Untitled part');
  const rows = (part.ingredients || []).map(ing => ({
    part: path,
    name: ing.name || '',
    percent: ing.percent === '' || ing.percent == null ? '' : Number(ing.percent),
    weight: ing.weight === '' || ing.weight == null ? '' : Number(ing.weight),
    note: ing.note || ''
  }));
  return [...rows, ...(part.parts || []).flatMap(sub => flattenPartForExcel(sub, path))];
}
// Top-level entry point — r.parts has no shared parent of its own, so each
// top-level Part starts its own path fresh rather than being wrapped in a
// fake parent (which would wrongly prepend "Untitled part" to every row).
function flattenRecipePartsForExcel(parts){
  return (parts || []).flatMap(part => flattenPartForExcel(part, ''));
}

// Exports the current recipe as a 3-sheet .xlsx workbook (Overview,
// Ingredients, Process) via SheetJS (loaded as a plain global — see the
// <script> tag right before the main module script). Excel/XLSX rather
// than CSV specifically because a real workbook keeps Thai characters
// correct without a manual BOM/encoding workaround and can hold more than
// one sheet.
function exportRecipeToExcel(r){
  if(typeof XLSX === 'undefined'){
    alert('Could not load the Excel export library — check your internet connection and try again.');
    return;
  }
  const link = findProjectForRecipe(r.id);
  const overviewRows = [
    ['Product Name', r.name || 'Untitled recipe'],
    ['Recipe Code', fullCode(r) || '-'],
    ['Date', r.date || '-'],
    ['Product Type', r.productType || '-'],
    ['Batch Weight (g)', r.batchWeight || ''],
    ['Yield %', r.yieldPct || ''],
    ['Project', link ? (link.project.name || 'Untitled project') : '-'],
    ['Customer', link ? (link.project.customerName || '-') : '-'],
    ['Destination', link ? (link.project.destinationCountry || '-') : '-'],
    ['Stage', link ? (link.product.stage || '-') : '-'],
    ['Created By', r.createdBy || '-'],
    ['Created At', formatActivityDateTime(r.createdAt) || '-'],
    ['Last Edited By', r.updatedBy || '-'],
    ['Last Edited At', formatActivityDateTime(r.updatedAt) || '-'],
    [],
    ['Description / Concept'],
    ...(r.description || []).map(pt => [pt])
  ];
  const ingredientRows = flattenRecipePartsForExcel(r.parts)
    .map(row => ({ Part: row.part, Ingredient: row.name, '%': row.percent, 'Weight (g)': row.weight, Note: row.note }));
  const processRows = (r.processes || []).flatMap((proc, pIdx) =>
    (proc.steps && proc.steps.length ? proc.steps : ['']).map((step, sIdx) => ({
      'Process #': pIdx + 1,
      'Process Name': proc.title || `Process ${pIdx + 1}`,
      'Step #': sIdx + 1,
      'Step': step || ''
    }))
  );

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(overviewRows), 'Overview');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ingredientRows), 'Ingredients');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(processRows), 'Process');

  const filenameBase = [r.name || 'Untitled recipe', fullCode(r)].filter(Boolean).join(' ').replace(/[\\/:*?"<>|]/g, '-');
  XLSX.writeFile(wb, `${filenameBase}.xlsx`);
}

// Scales every ingredient under a Part (including ones nested inside its
// Sub-parts) by the same factor, so weights change but every ratio between
// them — and so every %-of-parent at every level — doesn't.
function scaleIngredientsInPart(part, factor){
  (part.ingredients || []).forEach(ing => { ing.weight = round2((parseFloat(ing.weight)||0) * factor); });
  (part.parts || []).forEach(sub => scaleIngredientsInPart(sub, factor));
}

// "Everything else at this Part's own level" — siblingsCtx.ingredients is
// the sibling ingredients array (null for a top-level Part, since the
// recipe root holds no ingredients directly), siblingsCtx.parts is the
// sibling Parts array `part` itself lives in (r.parts for top-level,
// or parentPart.parts when nested). Used to back-solve a Part's weight
// from a typed %, the same way an ingredient's own % field already does
// one level down.
function siblingsWeightExcluding(siblingsCtx, part){
  const ingWeight = (siblingsCtx.ingredients || []).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
  const partsWeight = (siblingsCtx.parts || []).filter(p => p !== part).reduce((s,p)=>s+partTotalWeight(p),0);
  return ingWeight + partsWeight;
}

// Dragging a Part onto itself, or onto one of its own Sub-parts, would
// nest it inside itself — an impossible/cyclic tree. Used to reject that
// drop before it happens (see renderPartNode's drag-handle wiring).
function isPartOrDescendant(candidate, part){
  if(candidate === part) return true;
  return (part.parts || []).some(sub => isPartOrDescendant(candidate, sub));
}

// Every Part, at any depth, as one flat list — used by Process Steps'
// "Add Component" picker so a single flat <option> index can address a
// Part or ingredient at any nesting depth instead of needing a multi-level
// path. `label` is a breadcrumb ("Filling › Spicy Sauce") so a nested
// Sub-part or its ingredients still read unambiguously in the dropdown.
function collectPartsFlat(parts, prefix){
  let out = [];
  (parts || []).forEach((part, idx) => {
    const label = prefix + (part.name || `Part ${idx+1}`);
    out.push({ part, label });
    out = out.concat(collectPartsFlat(part.parts, label + ' › '));
  });
  return out;
}
function collectIngredientsFlat(parts, prefix){
  let out = [];
  (parts || []).forEach((part, idx) => {
    const label = prefix + (part.name || `Part ${idx+1}`);
    (part.ingredients || []).filter(i => (i.name||'').trim() !== '').forEach(ing => {
      out.push({ ing, label: `${label} › ${ing.name}` });
    });
    out = out.concat(collectIngredientsFlat(part.parts, label + ' › '));
  });
  return out;
}

function round2(n){ return Math.round(n * 100) / 100; }

/* Read-only weight displays (totals/subtotals) get a thousands separator for
   readability at larger batch sizes — editable Weight (g) <input> fields
   stay plain numbers since type="number" inputs can't contain commas. */
export function formatWeight(n){
  return (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' g';
}

function updateYieldDisplay(r){
  const el = document.getElementById('yieldAdjustedDisplay');
  if(!el) return;
  const yieldPct = parseFloat(r.yieldPct);
  if(!yieldPct || yieldPct <= 0){ el.textContent = '—'; return; }
  el.textContent = formatWeight((r.batchWeight||0) * yieldPct / 100);
}

// One entry per rendered Part (at ANY depth — top-level or nested inside
// another Part), pushed by renderPartNode as it builds each block. Rebuilt
// from scratch on every full renderParts(r) call. Using per-part closures
// instead of a flat DOM requery-by-index is what makes live-updating an
// arbitrarily deep tree tractable: each Part already knows exactly which
// DOM nodes are its own (not a descendant Sub-part's), no re-matching needed.
let partDisplayUpdaters = [];

function refreshDisplays(r){
  const totalWeight = recomputeFromWeights(r);
  const batchEl = document.getElementById('batchTotalDisplay');
  if(batchEl) batchEl.textContent = formatWeight(totalWeight);
  updateYieldDisplay(r);

  partDisplayUpdaters.forEach(fn => fn());

  updateGrandTotal(r);
  updateTreeRoot(r);
}

// The ingredient form IS the tree now (see renderParts/renderRows below) —
// every Part is a branch under this root and every ingredient a leaf under
// its Part, so the only thing the root itself still needs refreshed on
// every edit is its own weight (it's always 100% of itself by definition).
function updateTreeRoot(r){
  const wtEl = document.getElementById('treeRootWt');
  if(wtEl && document.activeElement !== wtEl) wtEl.value = (r.batchWeight || 0).toFixed(2);
}

function renderParts(r){
  recomputeFromWeights(r);

  const batchEl = document.getElementById('batchTotalDisplay');
  if(batchEl) batchEl.textContent = formatWeight(r.batchWeight);
  updateYieldDisplay(r);

  partDisplayUpdaters = [];
  const container = document.getElementById('partsContainer');
  container.innerHTML = '';
  if(r.parts.length === 0){
    container.innerHTML = '<div class="overview-empty">No parts yet — click "+ Add Part" below to add the first one</div>';
  }
  r.parts.forEach(part => {
    renderPartNode(r, part, container, { ingredients: null, parts: r.parts });
  });

  updateGrandTotal(r);
  updateTreeRoot(r);
}

// Renders one Part — and, recursively, every Sub-part nested inside it — as
// a branch of the tree. The exact same function handles a top-level Part
// (siblingsCtx = { ingredients: null, parts: r.parts }, since the recipe
// root holds no ingredients of its own) and a Sub-part nested inside
// another Part (siblingsCtx = { ingredients: parentPart.ingredients, parts:
// parentPart.parts }) — the %/weight math only cares about "everything
// else at my own level", not whether that level happens to be the recipe
// root or another Part.
function renderPartNode(r, part, container, siblingsCtx){
  const isNested = siblingsCtx.ingredients !== null;

  // A nested Sub-part's header uses the exact same column wrappers
  // (.row-handle-col/.row-value-col) as an ingredient row so the two line
  // up as one table — see the shared CSS above renderParts. A top-level
  // Part has no sibling ingredient row to line up with (the recipe root
  // only ever holds Parts), so it keeps its original, wider "section
  // header" layout (verbose "% of recipe" label, fields grouped and
  // right-aligned via margin-left:auto) unchanged.
  const headerInnerHtml = isNested ? `
      <div class="row-handle-col">
        <span class="drag-handle" draggable="true" title="Drag onto another Part's title to move this Part (and everything inside it) there">${icon('grip-vertical', 14)}</span>
        <button type="button" class="part-toggle-btn" title="Expand / collapse this part">${icon('chevron-right')}</button>
      </div>
      <input type="text" class="part-name" placeholder="Part name">
      <span class="part-ing-count"></span>
      <div class="row-value-col">
        <input type="number" class="part-pct-display num-input" step="0.01" min="0" max="100" title="Type a % or a weight (g) — scales everything inside this Part proportionally">
        <span class="ing-unit">%</span>
      </div>
      <div class="row-value-col row-value-wt">
        <input type="number" class="part-wt-display num-input" step="0.01" min="0">
        <span class="ing-unit">g</span>
      </div>
      <button class="icon-btn" title="Delete this part">${icon('x')}</button>
    ` : `
      <span class="drag-handle" draggable="true" title="Drag onto another Part's title to move this Part (and everything inside it) there">${icon('grip-vertical', 14)}</span>
      <button type="button" class="part-toggle-btn" title="Expand / collapse this part">${icon('chevron-right')}</button>
      <input type="text" class="part-name" placeholder="Part name">
      <div class="part-header-fields">
        <input type="number" class="part-pct-display num-input" step="0.01" min="0" max="100" title="Type a % or a weight (g) — scales everything inside this Part proportionally">
        <span>% of recipe</span>
        <input type="number" class="part-wt-display num-input" step="0.01" min="0">
        <span>g</span>
        <span class="part-ing-count"></span>
      </div>
      <button class="icon-btn" title="Delete this part">${icon('x')}</button>
    `;

  const block = document.createElement('div');
  block.className = 'part-block tree-branch' + (isNested ? ' sub-part-row' : '');
  block.innerHTML = `
    <div class="part-header">${headerInnerHtml}</div>
    <div class="part-body">
      <div class="ing-rows tree-children"></div>
      <div class="sub-parts tree-children"></div>
      <div class="part-body-actions">
        <button class="btn btn-sm add-row-btn" data-role="add-ing"></button>
        <button class="btn btn-sm add-row-btn" data-role="add-subpart"></button>
      </div>
    </div>
  `;

  const nameField = block.querySelector('.part-name');
  const addIngBtn = block.querySelector('[data-role="add-ing"]');
  const addSubpartBtn = block.querySelector('[data-role="add-subpart"]');
  const headerEl = block.querySelector('.part-header');
  const dragHandle = headerEl.querySelector('.drag-handle');

  // Drag SOURCE: picking this Part up. dataTransfer.setData is required for
  // some browsers (Firefox) to allow the drop at all, even though the
  // actual payload travels via the module-level `dragPayload` — a real
  // DataTransfer can't hold live object references, only serializable data.
  dragHandle.addEventListener('dragstart', e => {
    dragPayload = { type: 'part', item: part, sourceArray: siblingsCtx.parts };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'part');
    block.classList.add('dragging');
  });
  dragHandle.addEventListener('dragend', () => {
    block.classList.remove('dragging');
    dragPayload = null;
  });

  // Drop TARGET: this Part's title bar. Dragging an ingredient here always
  // just adds it to this Part's own list (no "before/after" — an
  // ingredient can't be positioned relative to a Part, they're different
  // lists). Dragging a Part is split into three vertical zones so both
  // "move up/down" and "nest inside" are reachable from the same target:
  // the top slice inserts the dragged Part as a sibling BEFORE this one,
  // the bottom slice AFTER, and the middle nests it inside as a Sub-part
  // (the original behavior).
  function partDropZone(e){
    const rect = headerEl.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / rect.height;
    if(relY < 0.3) return 'before';
    if(relY > 0.7) return 'after';
    return 'into';
  }

  headerEl.addEventListener('dragover', e => {
    if(!dragPayload) return;
    // Dropping a Part onto ITSELF or onto one of ITS OWN descendants would
    // nest it inside itself — check whether the drop TARGET (this `part`)
    // is the dragged Part or reachable by descending from it, not the
    // other way around. Applies to all three zones alike: inserting
    // draggedPart as a sibling of one of its own descendants is exactly as
    // cyclic as nesting it inside one directly.
    if(dragPayload.type === 'part' && isPartOrDescendant(part, dragPayload.item)) return;
    if(dragPayload.type === 'ingredient' && dragPayload.sourcePart === part) return; // already here
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    headerEl.classList.remove('drop-target', 'drop-before', 'drop-after');
    if(dragPayload.type === 'part'){
      const zone = partDropZone(e);
      headerEl.classList.add(zone === 'before' ? 'drop-before' : zone === 'after' ? 'drop-after' : 'drop-target');
    } else {
      headerEl.classList.add('drop-target');
    }
  });
  headerEl.addEventListener('dragleave', () => {
    headerEl.classList.remove('drop-target', 'drop-before', 'drop-after');
  });
  headerEl.addEventListener('drop', e => {
    e.preventDefault();
    const zone = (dragPayload && dragPayload.type === 'part') ? partDropZone(e) : 'into';
    headerEl.classList.remove('drop-target', 'drop-before', 'drop-after');
    if(!dragPayload) return;
    if(dragPayload.type === 'part'){
      const draggedPart = dragPayload.item;
      if(isPartOrDescendant(part, draggedPart)){ dragPayload = null; return; }
      const idx = dragPayload.sourceArray.indexOf(draggedPart);
      if(idx === -1){ dragPayload = null; return; }
      dragPayload.sourceArray.splice(idx, 1);
      if(zone === 'into'){
        part.parts.push(draggedPart);
      } else {
        // Insert as a sibling of `part` within its own containing array —
        // re-found by reference AFTER the removal above, since if
        // draggedPart came from this very array, `part`'s own index may
        // have shifted down by one.
        let targetIdx = siblingsCtx.parts.indexOf(part);
        if(zone === 'after') targetIdx += 1;
        siblingsCtx.parts.splice(targetIdx, 0, draggedPart);
      }
    } else if(dragPayload.type === 'ingredient'){
      const draggedIng = dragPayload.item;
      const sourcePart = dragPayload.sourcePart;
      if(sourcePart === part){ dragPayload = null; return; }
      const idx = sourcePart.ingredients.indexOf(draggedIng);
      if(idx === -1){ dragPayload = null; return; }
      sourcePart.ingredients.splice(idx, 1);
      // Same safety net as deleting the last ingredient by hand — a Part
      // never sits completely empty, always at least one blank row to type
      // into, unless it still has Sub-parts of its own.
      if(sourcePart.ingredients.length === 0 && sourcePart.parts.length === 0){
        sourcePart.ingredients.push({ name:'', percent:0, weight:0, note:'' });
      }
      part.ingredients.push(draggedIng);
    }
    dragPayload = null;
    renderParts(r);
    renderProcesses(r); // the moved ingredient/Part changes which Part it's grouped under in the "Add Component" picker
    scheduleSave();
  });

  function partLabel(){
    return (part.name || '').trim() || 'this part';
  }
  function updatePartLabels(){
    addIngBtn.textContent = `+ Add Ingredient (${partLabel()})`;
    addSubpartBtn.textContent = `+ Add Sub-part (${partLabel()})`;
  }
  updatePartLabels();

  nameField.value = part.name || '';
  nameField.addEventListener('input', e => { part.name = e.target.value; updatePartLabels(); renderProcesses(r); scheduleSave(); });

  const body = block.querySelector('.ing-rows');
  const subPartsContainer = block.querySelector('.sub-parts');
  const countEl = block.querySelector('.part-ing-count');
  const partPctInput = block.querySelector('.part-pct-display');
  const partWtInput = block.querySelector('.part-wt-display');
  const toggleBtn = block.querySelector('.part-toggle-btn');

  // Scales everything currently inside this Part — its own ingredients AND
  // every ingredient nested inside its Sub-parts — by the same factor, so
  // weights change but every ratio between them (at every depth) doesn't.
  // Silently a no-op when there's nothing to scale from (empty, or
  // everything inside is still 0g): with no known ratio, there's no
  // defensible way to distribute a new total.
  function scalePartTo(targetWeight){
    const currentWeight = partTotalWeight(part);
    if(targetWeight < 0 || currentWeight <= 0) return;
    const factor = targetWeight / currentWeight;
    scaleIngredientsInPart(part, factor);
  }

  partWtInput.addEventListener('input', e => {
    const target = parseFloat(e.target.value);
    if(!isNaN(target)) scalePartTo(target);
    refreshDisplays(r);
    scheduleSave();
  });
  partWtInput.addEventListener('blur', () => {
    partWtInput.value = partTotalWeight(part).toFixed(2);
  });
  let partWtJustFocused = false;
  partWtInput.addEventListener('mousedown', () => { partWtJustFocused = document.activeElement !== partWtInput; });
  partWtInput.addEventListener('focus', () => partWtInput.select());
  partWtInput.addEventListener('mouseup', e => { if(partWtJustFocused){ e.preventDefault(); partWtJustFocused = false; } });

  // Same back-solve as an ingredient's own % field (see ing-edit-row
  // below), just at whatever level this Part itself lives at: holds every
  // OTHER sibling (ingredient or Part) at this same level fixed, solves for
  // this Part's total, then scales everything inside it to hit it.
  partPctInput.addEventListener('input', e => {
    const targetPct = parseFloat(e.target.value);
    if(isNaN(targetPct) || targetPct < 0) return;
    const othersWeight = siblingsWeightExcluding(siblingsCtx, part);
    const f = targetPct / 100;
    if(othersWeight > 0 && f < 1){
      scalePartTo(f * othersWeight / (1 - f));
    }
    refreshDisplays(r);
    scheduleSave();
  });
  partPctInput.addEventListener('blur', () => {
    partPctInput.value = (part.percent || 0).toFixed(2);
  });
  let partPctJustFocused = false;
  partPctInput.addEventListener('mousedown', () => { partPctJustFocused = document.activeElement !== partPctInput; });
  partPctInput.addEventListener('focus', () => partPctInput.select());
  partPctInput.addEventListener('mouseup', e => { if(partPctJustFocused){ e.preventDefault(); partPctJustFocused = false; } });

  function setCollapsed(collapsed){
    block.classList.toggle('collapsed', collapsed);
    toggleBtn.classList.toggle('open', !collapsed);
    toggleBtn.innerHTML = icon(collapsed ? 'chevron-right' : 'chevron-down');
  }

  toggleBtn.addEventListener('click', () => {
    setCollapsed(!block.classList.contains('collapsed'));
  });

  const hasContent = part.ingredients.some(i => (i.name || '').trim() !== '') || part.parts.length > 0;
  setCollapsed(!hasContent);

  function renderRows(){
    body.innerHTML = '';
    part.ingredients.forEach((ing, idx) => {
      const branch = document.createElement('div');
      branch.className = 'tree-branch';
      branch.innerHTML = `
        <div class="tree-node tree-ing-node ing-edit-row">
          <div class="row-handle-col">
            <span class="drag-handle" draggable="true" title="Drag onto a Part's title to move this ingredient there">${icon('grip-vertical', 14)}</span>
          </div>
          <div class="ing-name-wrap">
            <input type="text" class="ing-name" placeholder="Search the library or type a new ingredient name" autocomplete="off">
            <div class="ing-suggestions"></div>
          </div>
          <input type="text" class="ing-note" placeholder="Note">
          <div class="row-value-col">
            <input type="number" class="ing-pct-display num-input" step="0.01" min="0" max="100" title="Type a % or a weight (g) — the other one is calculated automatically">
            <span class="ing-unit">%</span>
          </div>
          <div class="row-value-col row-value-wt">
            <input type="number" class="ing-wt num-input" step="0.01" min="0">
            <span class="ing-unit">g</span>
          </div>
          <button class="icon-btn" title="Delete">${icon('x')}</button>
          <div class="ing-flow-link-wrap">
            <span class="ing-flow-link-arrow">→</span>
            <select class="ing-flow-link" title="Link this ingredient to a Process Flowchart node"></select>
          </div>
        </div>
        <div class="ing-hint"></div>
      `;
      const ingDragHandle = branch.querySelector('.drag-handle');
      const nameInput = branch.querySelector('.ing-name');
      const suggestBox = branch.querySelector('.ing-suggestions');
      const hintEl = branch.querySelector('.ing-hint');
      const pctDisplay = branch.querySelector('.ing-pct-display');
      const wtInput = branch.querySelector('.ing-wt');
      const noteInput = branch.querySelector('.ing-note');
      const delBtn = branch.querySelector('.icon-btn');

      // Optional link to a Process Flowchart node (see the Process
      // Flowchart section) — e.g. "this ingredient goes into step B".
      // Hidden entirely (not just left blank) until the recipe actually
      // has at least one flowchart node, so recipes that never touch that
      // feature see zero visual change to this row.
      const flowLinkWrap = branch.querySelector('.ing-flow-link-wrap');
      const flowLinkSelect = branch.querySelector('.ing-flow-link');
      const flowNodes = (r.processFlowchart && r.processFlowchart.nodes) || [];
      flowLinkWrap.classList.toggle('hidden-if-empty', flowNodes.length === 0);
      flowLinkSelect.innerHTML = `<option value="">—</option>` +
        flowNodes.map(n => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.label || '?')}</option>`).join('');
      flowLinkSelect.value = ing.flowNodeId || '';
      flowLinkSelect.addEventListener('change', e => {
        ing.flowNodeId = e.target.value || null;
        scheduleSave();
      });

      ingDragHandle.addEventListener('dragstart', e => {
        dragPayload = { type: 'ingredient', item: ing, sourcePart: part };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'ingredient');
        branch.classList.add('dragging');
      });
      ingDragHandle.addEventListener('dragend', () => {
        branch.classList.remove('dragging');
        dragPayload = null;
      });

      // Drop TARGET: an ingredient row only ever means "reorder relative
      // to this one" — top half of the row inserts the dragged ingredient
      // just before it, bottom half just after. Works the same whether the
      // dragged ingredient started in this same Part (a plain reorder) or
      // a different one (moves it here, landing at this exact position,
      // rather than always at the end the way dropping on a Part's title
      // does).
      const rowEl = branch.querySelector('.ing-edit-row');
      rowEl.addEventListener('dragover', e => {
        if(!dragPayload || dragPayload.type !== 'ingredient' || dragPayload.item === ing) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = rowEl.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        rowEl.classList.toggle('drop-before', before);
        rowEl.classList.toggle('drop-after', !before);
      });
      rowEl.addEventListener('dragleave', () => {
        rowEl.classList.remove('drop-before', 'drop-after');
      });
      rowEl.addEventListener('drop', e => {
        e.preventDefault();
        const rect = rowEl.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        rowEl.classList.remove('drop-before', 'drop-after');
        if(!dragPayload || dragPayload.type !== 'ingredient') return;
        const draggedIng = dragPayload.item;
        if(draggedIng === ing){ dragPayload = null; return; }
        const sourcePart = dragPayload.sourcePart;
        const sourceIdx = sourcePart.ingredients.indexOf(draggedIng);
        if(sourceIdx === -1){ dragPayload = null; return; }
        sourcePart.ingredients.splice(sourceIdx, 1);
        if(sourcePart.ingredients.length === 0 && sourcePart.parts.length === 0){
          sourcePart.ingredients.push({ name:'', percent:0, weight:0, note:'' });
        }
        // Re-found by reference AFTER the removal above, since if the
        // dragged ingredient came from this same Part, this row's own
        // index may have shifted down by one.
        let targetIdx = part.ingredients.indexOf(ing);
        if(!before) targetIdx += 1;
        part.ingredients.splice(targetIdx, 0, draggedIng);
        dragPayload = null;
        renderParts(r);
        renderProcesses(r);
        scheduleSave();
      });

      nameInput.value = ing.name || '';
      pctDisplay.value = (ing.percent||0).toFixed(2);
      wtInput.value = (parseFloat(ing.weight) || 0).toFixed(2);
      noteInput.value = ing.note || '';

      function syncMaterialLink(resetWeightIfUnlinked){
        const matched = findMaterialByLabel(nameInput.value);
        ing.materialId = matched ? matched.id : null;
        wtInput.disabled = !matched;
        pctDisplay.disabled = !matched;
        nameInput.classList.remove('ing-linked', 'invalid');
        if(matched){
          nameInput.classList.add('ing-linked');
          nameInput.title = materialTooltip(matched);
          hintEl.textContent = matched.vendorCode ? `Code: ${matched.vendorCode}` : '';
          hintEl.className = 'ing-hint ing-hint-code';
        }else{
          nameInput.title = '';
          if(nameInput.value.trim()){
            nameInput.classList.add('invalid');
            hintEl.textContent = 'This ingredient is not in the library — open "Ingredient Library" above to add it before entering a weight';
            hintEl.className = 'ing-hint hint-block';
          }else{
            hintEl.textContent = 'Select an ingredient from the library first before entering a weight';
            hintEl.className = 'ing-hint';
          }
          if(resetWeightIfUnlinked && (parseFloat(ing.weight) || 0) !== 0){
            ing.weight = 0;
            wtInput.value = (0).toFixed(2);
            pctDisplay.value = (0).toFixed(2);
          }
        }
      }
      syncMaterialLink(false);

      // Custom fuzzy-search dropdown — replaces the old native <datalist>,
      // which only ever did a plain substring match and looked/behaved
      // differently across browsers. Ranked matches (see
      // fuzzyMaterialMatches) so close/similar names surface even with a
      // typo or a partial word, not just an exact substring.
      function renderSuggestions(){
        if(document.activeElement !== nameInput){
          suggestBox.innerHTML = '';
          suggestBox.classList.remove('open');
          return;
        }
        const matches = fuzzyMaterialMatches(nameInput.value, 8);
        if(matches.length === 0){
          suggestBox.innerHTML = '';
          suggestBox.classList.remove('open');
          return;
        }
        suggestBox.innerHTML = matches.map(m => `
          <div class="ing-suggestion-item" data-id="${escapeHtml(m.id)}">
            <span class="ing-suggestion-name">${escapeHtml(materialLabel(m))}</span>
          </div>
        `).join('');
        suggestBox.classList.add('open');
        suggestBox.querySelectorAll('.ing-suggestion-item').forEach(item => {
          // mousedown (not click) fires before the input's blur, so the
          // selection registers before renderSuggestions()'s own blur
          // handler would otherwise have already wiped the list out.
          item.addEventListener('mousedown', e => {
            e.preventDefault();
            const matched = ingredientMaster.find(x => x.id === item.dataset.id);
            if(matched){
              nameInput.value = materialLabel(matched);
              nameInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            suggestBox.innerHTML = '';
            suggestBox.classList.remove('open');
          });
        });
      }

      nameInput.addEventListener('input', e => {
        ing.name = e.target.value;
        syncMaterialLink(true);
        refreshDisplays(r);
        renderProcesses(r); // keep the "Add Component" picker's ingredient list current
        scheduleSave();
        renderSuggestions();
      });
      nameInput.addEventListener('focus', renderSuggestions);
      nameInput.addEventListener('blur', () => {
        suggestBox.innerHTML = '';
        suggestBox.classList.remove('open');
      });
      noteInput.addEventListener('input', e => { ing.note = e.target.value; scheduleSave(); });

      wtInput.addEventListener('input', e => {
        ing.weight = parseFloat(e.target.value) || 0;
        refreshDisplays(r);
        scheduleSave();
      });
      wtInput.addEventListener('blur', () => {
        wtInput.value = (parseFloat(ing.weight) || 0).toFixed(2);
      });
      // Select the whole number on focus so a click lets you type a new
      // value straight away — Chrome otherwise collapses the selection on
      // mouseup, so the first click's mouseup is suppressed once to let it stick.
      let wtJustFocused = false;
      wtInput.addEventListener('mousedown', () => { wtJustFocused = document.activeElement !== wtInput; });
      wtInput.addEventListener('focus', () => wtInput.select());
      wtInput.addEventListener('mouseup', e => {
        if(wtJustFocused){ e.preventDefault(); wtJustFocused = false; }
      });

      // Typing a % back-solves this ingredient's weight, holding every
      // other ingredient AND every Sub-part in the Part fixed: pct = w /
      // (w + others), so w = pct * others / (1 - pct). others === 0 (the
      // only thing in the Part) has no solution — it's already 100% at any
      // weight — so that case is left alone and just snaps back on blur.
      pctDisplay.addEventListener('input', e => {
        const targetPct = parseFloat(e.target.value);
        if(isNaN(targetPct) || targetPct < 0) return;
        const othersIngWeight = part.ingredients.reduce((s,i,i2) => i2 === idx ? s : s+(parseFloat(i.weight)||0), 0);
        const othersSubPartsWeight = (part.parts||[]).reduce((s,sub)=>s+partTotalWeight(sub),0);
        const othersWeight = othersIngWeight + othersSubPartsWeight;
        const f = targetPct / 100;
        if(othersWeight > 0 && f < 1){
          ing.weight = round2(f * othersWeight / (1 - f));
          wtInput.value = (parseFloat(ing.weight) || 0).toFixed(2);
        }
        refreshDisplays(r);
        scheduleSave();
      });
      pctDisplay.addEventListener('blur', () => {
        pctDisplay.value = (ing.percent || 0).toFixed(2);
      });
      let pctJustFocused = false;
      pctDisplay.addEventListener('mousedown', () => { pctJustFocused = document.activeElement !== pctDisplay; });
      pctDisplay.addEventListener('focus', () => pctDisplay.select());
      pctDisplay.addEventListener('mouseup', e => {
        if(pctJustFocused){ e.preventDefault(); pctJustFocused = false; }
      });

      delBtn.addEventListener('click', () => {
        part.ingredients.splice(idx, 1);
        if(part.ingredients.length === 0 && part.parts.length === 0) part.ingredients.push({ name:'', percent:0, weight:0, note:'' });
        renderRows();
        refreshDisplays(r);
        renderProcesses(r); // drop the deleted ingredient from the "Add Component" picker
        scheduleSave();
      });

      body.appendChild(branch);
    });
    updatePartSubtotal();
  }

  function updatePartSubtotal(){
    const namedCount = part.ingredients.filter(i => (i.name||'').trim() !== '').length;
    const subCount = part.parts.length;
    const label = [];
    if(namedCount) label.push(`${namedCount} ingredient${namedCount === 1 ? '' : 's'}`);
    if(subCount) label.push(`${subCount} sub-part${subCount === 1 ? '' : 's'}`);
    countEl.textContent = label.length ? label.join(' · ') : 'Empty';
    if(document.activeElement !== partPctInput) partPctInput.value = (part.percent || 0).toFixed(2);
    if(document.activeElement !== partWtInput) partWtInput.value = partTotalWeight(part).toFixed(2);
  }

  renderRows();

  function renderSubParts(){
    subPartsContainer.innerHTML = '';
    part.parts.forEach(sub => renderPartNode(r, sub, subPartsContainer, { ingredients: part.ingredients, parts: part.parts }));
  }
  renderSubParts();

  addIngBtn.addEventListener('click', () => {
    if(hasUnresolvedIngredient(part)){
      alert('This part has an ingredient that is not yet in the library. Please select from the library or add it first before adding the next row.');
      return;
    }
    part.ingredients.push({ name:'', percent:0, weight:0, note:'' });
    renderRows();
    refreshDisplays(r);
    scheduleSave();
  });

  addSubpartBtn.addEventListener('click', () => {
    part.parts.push(blankPart(''));
    renderParts(r);
    renderProcesses(r); // add the new sub-part's ingredients to the "Add Component" picker
    scheduleSave();
  });

  const deletePartBtn = block.querySelector('.part-header .icon-btn');
  if(!isNested && siblingsCtx.parts.length <= 1){
    // A recipe always needs at least one top-level Part to hold anything —
    // Sub-parts nested inside a Part have no such floor, since that Part
    // can always fall back to its own direct ingredients instead.
    deletePartBtn.style.display = 'none';
  } else {
    deletePartBtn.addEventListener('click', () => {
      if(!confirm(`Delete "${part.name || 'this part'}" and everything inside it?`)) return;
      const idx = siblingsCtx.parts.indexOf(part);
      if(idx !== -1) siblingsCtx.parts.splice(idx, 1);
      renderParts(r);
      renderProcesses(r); // drop the deleted part's ingredients from the "Add Component" picker
      scheduleSave();
    });
  }

  partDisplayUpdaters.push(() => {
    updatePartSubtotal();
    const pctEls = body.querySelectorAll('.ing-pct-display');
    const wtEls = body.querySelectorAll('.ing-wt');
    part.ingredients.forEach((ing, idx) => {
      // Skip the field the user is actively typing into — reformatting it
      // mid-keystroke (e.g. "30" -> "30.00" before they can type "30.5")
      // would fight with their typing. It gets its own precise value on
      // blur instead (see the pctDisplay/wtInput 'blur' handlers above).
      // Weight also needs refreshing here (not just %): scaling this Part
      // from its own header field, or a sibling ingredient's own % field,
      // changes every ingredient's weight without ever touching its own
      // <input> directly, so nothing else would ever push that new value in.
      const pctEl = pctEls[idx];
      if(pctEl && document.activeElement !== pctEl) pctEl.value = (ing.percent||0).toFixed(2);
      const wtEl = wtEls[idx];
      if(wtEl && document.activeElement !== wtEl) wtEl.value = (parseFloat(ing.weight)||0).toFixed(2);
    });
  });

  container.appendChild(block);
}

function updateGrandTotal(r){
  const allIngredients = allIngredientsInRecipe(r);
  const totalWt = allIngredients.reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
  // % is always weight / totalWeight, so the grand total is exactly 100% by
  // construction whenever there's any weight entered — no rounding drift.
  const totalPct = totalWt > 0 ? 100 : 0;
  const pctEl = document.getElementById('grandTotalPct');
  const wtEl = document.getElementById('grandTotalWt');
  pctEl.textContent = totalPct.toFixed(2) + '%';
  pctEl.className = 'col-pct totals-ok';
  wtEl.textContent = formatWeight(totalWt);

  renderOverview(allIngredients);
}

function renderOverview(allIngredients){
  const body = document.getElementById('overviewBody');
  if(!body) return;
  body.innerHTML = '';

  const named = allIngredients.filter(i => (i.name||'').trim() !== '');
  if(named.length === 0){
    body.innerHTML = '<tr><td colspan="4"><div class="overview-empty">No ingredient names entered yet</div></td></tr>';
    return;
  }

  const groups = new Map();
  named.forEach(i => {
    const key = i.name.trim().toLowerCase();
    if(!groups.has(key)){
      const material = i.materialId ? ingredientMaster.find(m => m.id === i.materialId) : null;
      groups.set(key, {
        name: i.name.trim(),
        pct: 0,
        wt: 0,
        image: material ? material.image : '',
        vendorName: material ? material.vendorName : '',
        manufacturer: material ? material.manufacturer : ''
      });
    }
    const g = groups.get(key);
    g.wt += parseFloat(i.weight) || 0;
  });

  // % here is always of the whole recipe (not the ingredient's own part),
  // so it's computed straight from weight rather than summing the now
  // per-part ing.percent values.
  const totalRecipeWeight = allIngredients.reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
  groups.forEach(g => { g.pct = totalRecipeWeight > 0 ? (g.wt / totalRecipeWeight * 100) : 0; });

  const rows = [...groups.values()].sort((a,b) => b.pct - a.pct);
  const maxPct = Math.max(...rows.map(g => g.pct), 100);

  rows.forEach((g, idx) => {
    const tr = document.createElement('tr');
    const barPct = Math.min(100, (g.pct / maxPct) * 100);
    tr.innerHTML = `
      <td class="col-no">${idx+1}</td>
      <td>
        <div class="overview-ing-cell">
          ${g.image ? `<img src="${escapeHtml(g.image)}" class="overview-thumb" alt="${escapeHtml(g.name)}">` : '<div class="overview-thumb overview-thumb-empty"></div>'}
          <div class="overview-ing-info">
            <span>${escapeHtml(g.name)}</span>
            ${(g.vendorName || g.manufacturer) ? `<span class="overview-ing-sub">${escapeHtml([g.vendorName, g.manufacturer].filter(Boolean).join(' · '))}</span>` : ''}
          </div>
        </div>
      </td>
      <td class="col-pct">
        <div class="overview-bar-wrap">
          <div class="overview-bar-track"><div class="overview-bar-fill" style="width:${barPct}%"></div></div>
          <span>${g.pct.toFixed(2)}%</span>
        </div>
      </td>
      <td class="col-wt">${formatWeight(g.wt)}</td>
    `;
    body.appendChild(tr);
  });
}

/* ---------- Process Steps (grouped: a process title + its own numbered steps) ---------- */
function renderProcesses(r){
  const list = document.getElementById('processesList');
  list.innerHTML = '';

  r.processes.forEach((proc, pIdx) => {
    const block = document.createElement('div');
    block.className = 'process-block';
    block.innerHTML = `
      <div class="process-header">
        <div class="step-badge">${pIdx+1}</div>
        <input type="text" class="process-title" placeholder="Process ${pIdx+1} name (e.g. Mixing)">
        <button class="icon-btn" title="Move this process up">${icon('chevron-up')}</button>
        <button class="icon-btn" title="Move this process down">${icon('chevron-down')}</button>
        <button class="icon-btn" title="Delete this process">${icon('x')}</button>
      </div>
      <div class="process-components">
        <div class="process-components-title">Components</div>
        <div class="process-comp-add-row">
          <div class="comp-multiselect">
            <button type="button" class="comp-multiselect-toggle">— Select parts/ingredients to add —</button>
            <div class="comp-multiselect-panel"></div>
          </div>
          <button class="btn btn-sm" type="button" data-role="add-component">+ Add</button>
        </div>
        <div style="overflow-x:auto;">
          <table class="process-comp-table">
            <thead>
              <tr>
                <th class="col-no">#</th>
                <th>Name</th>
                <th class="col-wt">Weight (g)</th>
                <th class="col-tol">Tolerance (±)</th>
                <th class="col-range">Range</th>
                <th class="col-pct">% (auto)</th>
                <th class="col-del"></th>
              </tr>
            </thead>
            <tbody></tbody>
            <tfoot>
              <tr>
                <td></td>
                <td>Total</td>
                <td class="col-wt process-comp-total-wt"></td>
                <td></td>
                <td></td>
                <td class="col-pct process-comp-total-pct"></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div class="process-steps-list"></div>
      <button class="btn btn-sm add-row-btn" data-role="add-step">+ Add Step</button>
    `;

    const titleInput = block.querySelector('.process-title');
    titleInput.value = proc.title || '';
    titleInput.addEventListener('input', e => { proc.title = e.target.value; scheduleSave(); });

    const stepsListEl = block.querySelector('.process-steps-list');

    function renderStepRows(){
      stepsListEl.innerHTML = '';
      proc.steps.forEach((step, idx) => {
        const row = document.createElement('div');
        row.className = 'step-row';
        row.innerHTML = `
          <div class="step-badge">${idx+1}</div>
          <div class="step-body"><textarea placeholder="Describe step ${idx+1}..."></textarea></div>
          <div class="step-controls">
            <button class="icon-btn" title="Move up">${icon('chevron-up')}</button>
            <button class="icon-btn" title="Move down">${icon('chevron-down')}</button>
            <button class="icon-btn" title="Delete">${icon('x')}</button>
          </div>
        `;
        const ta = row.querySelector('textarea');
        ta.value = step;
        ta.addEventListener('input', e => { proc.steps[idx] = e.target.value; scheduleSave(); });

        const [upBtn, downBtn, delBtn] = row.querySelectorAll('.icon-btn');
        upBtn.addEventListener('click', () => {
          if(idx === 0) return;
          [proc.steps[idx-1], proc.steps[idx]] = [proc.steps[idx], proc.steps[idx-1]];
          renderStepRows(); scheduleSave();
        });
        downBtn.addEventListener('click', () => {
          if(idx === proc.steps.length-1) return;
          [proc.steps[idx+1], proc.steps[idx]] = [proc.steps[idx], proc.steps[idx+1]];
          renderStepRows(); scheduleSave();
        });
        delBtn.addEventListener('click', () => {
          proc.steps.splice(idx,1);
          renderStepRows(); scheduleSave();
        });

        stepsListEl.appendChild(row);
      });
    }
    renderStepRows();

    block.querySelector('[data-role="add-step"]').addEventListener('click', () => {
      proc.steps.push('');
      renderStepRows();
      scheduleSave();
    });

    // --- Components (snapshot a Part or an existing ingredient into a
    //     reference table for this process: weight, ± tolerance, %).
    //     Name/weight/tolerance are copied in once and then fully editable —
    //     they don't stay linked to the source, so editing them later never
    //     touches the recipe's real ingredients/parts. % is the exception:
    //     it's always auto-computed from this table's own weights, so the
    //     components in a process always sum to 100%. ---
    if(!Array.isArray(proc.components)) proc.components = [];
    const compToggle = block.querySelector('.comp-multiselect-toggle');
    const compPanel = block.querySelector('.comp-multiselect-panel');
    const compBody = block.querySelector('.process-comp-table tbody');
    const compFoot = block.querySelector('.process-comp-table tfoot');
    const totalWtEl = block.querySelector('.process-comp-total-wt');
    const totalPctEl = block.querySelector('.process-comp-total-pct');

    // Flat index into these two arrays (not a "partIdx.ingredientIdx" path)
    // is what lets the checklist address a Part or ingredient at ANY
    // nesting depth — see collectPartsFlat/collectIngredientsFlat.
    // Recomputed fresh on every render, and the "Add" handler below
    // re-derives the exact same two arrays, so the flat index it reads
    // back always lines up with what's currently checked.
    const flatParts = collectPartsFlat(r.parts, '');
    const flatIngredients = collectIngredientsFlat(r.parts, '');

    // Several items can be checked off before a single "+ Add" snapshots
    // all of them at once — cleared after every Add (and whenever the
    // process list re-renders) rather than persisted, since it's just a
    // staging pick-list, not part of the recipe data itself.
    const selectedKeys = new Set();

    function updateToggleLabel(){
      const n = selectedKeys.size;
      compToggle.textContent = n === 0 ? '— Select parts/ingredients to add —' : `${n} selected`;
      compToggle.classList.toggle('has-selection', n > 0);
    }

    function itemRow(value, label){
      return `
        <label class="comp-multiselect-item">
          <input type="checkbox" value="${escapeHtml(value)}">
          <span>${escapeHtml(label)}</span>
        </label>
      `;
    }
    const partItems = flatParts.map((entry, idx) => itemRow(`part:${idx}`, entry.label)).join('');
    const ingItems = flatIngredients.map((entry, idx) => itemRow(`ing:${idx}`, entry.label)).join('');
    compPanel.innerHTML = (partItems || ingItems) ? `
      ${partItems ? `<div class="comp-multiselect-group-label">Parts</div>${partItems}` : ''}
      ${ingItems ? `<div class="comp-multiselect-group-label">Ingredients</div>${ingItems}` : ''}
    ` : '<div class="comp-multiselect-empty">Nothing to add yet</div>';

    compPanel.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.checked = selectedKeys.has(cb.value);
      cb.addEventListener('change', () => {
        if(cb.checked) selectedKeys.add(cb.value); else selectedKeys.delete(cb.value);
        updateToggleLabel();
      });
    });

    compToggle.addEventListener('click', () => {
      compPanel.classList.toggle('open');
    });
    // Closes the panel once focus moves somewhere outside this widget —
    // a listener scoped to the widget itself (via focusout's bubbling +
    // relatedTarget) rather than a document-level one, so it doesn't need
    // manual cleanup and can't pile up across the repeated re-renders
    // renderProcesses() goes through on every edit.
    block.querySelector('.comp-multiselect').addEventListener('focusout', e => {
      if(e.currentTarget.contains(e.relatedTarget)) return;
      compPanel.classList.remove('open');
    });

    function renderComponentRows(){
      compBody.innerHTML = '';
      if(proc.components.length === 0){
        compBody.innerHTML = '<tr><td colspan="7"><div class="overview-empty">No components added yet</div></td></tr>';
        if(compFoot) compFoot.style.display = 'none';
        return;
      }
      if(compFoot) compFoot.style.display = '';
      const pctDisplays = [];

      function recalcAllPercents(){
        const totalWt = proc.components.reduce((s,c)=>s+(parseFloat(c.weight)||0),0);
        proc.components.forEach((c, i) => {
          c.percent = totalWt > 0 ? round2((parseFloat(c.weight)||0)/totalWt*100) : 0;
          if(pctDisplays[i]) pctDisplays[i].textContent = c.percent.toFixed(2) + '%';
        });
        if(totalWtEl) totalWtEl.textContent = formatWeight(totalWt);
        if(totalPctEl){
          const totalPct = proc.components.reduce((s,c)=>s+(parseFloat(c.percent)||0),0);
          totalPctEl.textContent = totalPct.toFixed(2) + '%';
        }
      }

      proc.components.forEach((comp, cIdx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="col-no">${cIdx+1}</td>
          <td><input type="text" class="comp-name"></td>
          <td class="col-wt"><input type="number" class="comp-wt num-input" step="0.01"></td>
          <td class="col-tol"><input type="number" class="comp-tol num-input" step="0.01" min="0"></td>
          <td class="col-range comp-range"></td>
          <td class="col-pct"><span class="comp-pct-display" title="Calculated automatically from weight"></span></td>
          <td class="col-del"><button class="icon-btn" title="Delete">${icon('x')}</button></td>
        `;
        const nameInput = tr.querySelector('.comp-name');
        const wtInput = tr.querySelector('.comp-wt');
        const tolInput = tr.querySelector('.comp-tol');
        const rangeCell = tr.querySelector('.comp-range');
        const pctDisplay = tr.querySelector('.comp-pct-display');
        pctDisplays.push(pctDisplay);
        nameInput.value = comp.name || '';
        wtInput.value = comp.weight ?? 0;
        tolInput.value = comp.tolerance ?? 0;

        function updateRange(){
          const wt = parseFloat(wtInput.value) || 0;
          const tol = parseFloat(tolInput.value) || 0;
          rangeCell.textContent = `${(wt-tol).toFixed(2)}-${(wt+tol).toFixed(2)} g`;
        }
        updateRange();

        nameInput.addEventListener('input', e => { comp.name = e.target.value; scheduleSave(); });
        wtInput.addEventListener('input', e => { comp.weight = parseFloat(e.target.value) || 0; updateRange(); recalcAllPercents(); scheduleSave(); });
        tolInput.addEventListener('input', e => { comp.tolerance = parseFloat(e.target.value) || 0; updateRange(); scheduleSave(); });
        tr.querySelector('.icon-btn').addEventListener('click', () => {
          proc.components.splice(cIdx, 1);
          renderComponentRows();
          scheduleSave();
        });

        compBody.appendChild(tr);
      });

      recalcAllPercents();
    }
    renderComponentRows();

    block.querySelector('[data-role="add-component"]').addEventListener('click', () => {
      if(selectedKeys.size === 0) return;
      selectedKeys.forEach(val => {
        const [kind, a] = val.split(':');
        let name, weight;
        if(kind === 'part'){
          const entry = flatParts[+a];
          if(!entry) return;
          name = entry.part.name || 'Untitled part';
          weight = partTotalWeight(entry.part);
        } else {
          const entry = flatIngredients[+a];
          if(!entry) return;
          name = entry.ing.name;
          weight = parseFloat(entry.ing.weight) || 0;
        }
        proc.components.push({ name, weight: round2(weight), tolerance: 0, percent: 0 });
      });
      selectedKeys.clear();
      compPanel.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
      updateToggleLabel();
      compPanel.classList.remove('open');
      renderComponentRows();
      scheduleSave();
    });

    const [moveUpBtn, moveDownBtn, deleteProcessBtn] = block.querySelectorAll('.process-header .icon-btn');
    moveUpBtn.addEventListener('click', () => {
      if(pIdx === 0) return;
      [r.processes[pIdx-1], r.processes[pIdx]] = [r.processes[pIdx], r.processes[pIdx-1]];
      renderProcesses(r);
      scheduleSave();
    });
    moveDownBtn.addEventListener('click', () => {
      if(pIdx === r.processes.length-1) return;
      [r.processes[pIdx+1], r.processes[pIdx]] = [r.processes[pIdx], r.processes[pIdx+1]];
      renderProcesses(r);
      scheduleSave();
    });
    deleteProcessBtn.addEventListener('click', () => {
      const deletedProc = r.processes[pIdx];
      r.processes.splice(pIdx, 1);
      if(r.processes.length === 0) r.processes.push({ id: uid(), title: '', steps: [], components: [] });
      // Any Process Flowchart node currently live-linked to this Process
      // (see computeFlowNodeText) gets detached rather than losing its
      // content silently — its last-shown text is frozen as an ordinary
      // free-typed node instead.
      (r.processFlowchart.nodes || []).forEach(node => {
        if(node.linkedProcessId === deletedProc.id){
          node.text = computeFlowNodeText({ linkedProcessId: deletedProc.id, text: node.text }, [deletedProc]);
          node.linkedProcessId = null;
        }
      });
      renderProcesses(r);
      scheduleSave();
    });

    list.appendChild(block);
  });

  renderSimpleProcessPreview(r);
}

// A plain, non-editable "title, then each step stacked with a ↓ arrow
// between them" preview — the simple two-column Ingredient|Process layout
// the user's own reference spreadsheet uses, shown live in section 3 next
// to the ingredient tree. Read-only: the actual editing still happens in
// section 4's List view (or the Flowchart view) — this just mirrors
// whatever's there right now, refreshed on every renderProcesses(r) call
// so it never goes stale. No connector arrows between separate Process
// entries, only between a Process's own consecutive steps, matching the
// reference layout's visually distinct titled groups.
function renderSimpleProcessPreview(r){
  const el = document.getElementById('simpleProcessPreview');
  if(!el) return;
  const list = (r.processes || []).filter(p =>
    (p.title||'').trim() !== '' || (p.steps||[]).some(s => (s||'').trim() !== '')
  );
  if(list.length === 0){
    el.innerHTML = '<div class="overview-empty">No process steps yet</div>';
    return;
  }
  el.innerHTML = list.map(p => {
    const steps = (p.steps || []).filter(s => (s||'').trim() !== '');
    return `
      <div class="simple-process-block">
        <div class="simple-process-title">${escapeHtml(p.title || 'Untitled process')}</div>
        ${steps.map((s, idx) => `
          ${idx > 0 ? '<div class="simple-process-arrow">↓</div>' : ''}
          <div class="simple-process-step">${escapeHtml(s)}</div>
        `).join('')}
      </div>
    `;
  }).join('');
}

/* ---------- Process Flowchart (freeform alternative to the numbered Steps
   list — one shared canvas per recipe, not per Process entry) ----------
   The first freeform/draggable-node/connector-line UI in this app; there's
   no existing precedent to extend, so the drag and edge-drawing mechanics
   below are built from scratch. Everything else (data shape, save-on-edit,
   full-rebuild render style) follows the same conventions as the rest of
   the file. */

const DEFAULT_FLOW_NODE_W = 170;

// Module-level "what's currently being manipulated" state, same discipline
// as dragPayload above: always reset to null on every exit path (success
// or cancel) of its gesture, never left dangling.
let flowNodeDrag = null; // { r, node, el, startClientX, startClientY, startX, startY }
let flowEdgeDraw = null; // { r, fromNode, fromEl, currentClientX, currentClientY }

// Spreadsheet-style column labels (A, B, ... Z, AA, AB, ...) — picks the
// first one not already used by an existing node, so a deleted node's
// letter can be reused by the next Add, and existing labels are never
// renumbered out from under an ingredient that already links to them.
function excelColumnLabel(i){
  let n = i + 1, label = '';
  while(n > 0){
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}
function nextFlowNodeLabel(nodes){
  const used = new Set((nodes || []).map(n => (n.label || '').trim().toUpperCase()).filter(Boolean));
  for(let i = 0; i < 18278; i++){ // A..Z, AA..ZZ, AAA..ZZZ — far more than any real recipe needs
    const label = excelColumnLabel(i);
    if(!used.has(label)) return label;
  }
  return 'X' + (nodes.length + 1); // astronomically unlikely fallback
}

function blankFlowNode(label, x, y){
  return { id: uid(), x: Math.round(x), y: Math.round(y), w: DEFAULT_FLOW_NODE_W, label, text: '', linkedProcessId: null };
}

// A node's displayed text is either its own free-typed .text, or — when
// linked to a Process (see the node's "Link" dropdown) — live-derived
// fresh from that Process's current title + steps every time this is
// called, so editing the List always shows up the next time the
// Flowchart is rendered without any separate push-sync step. Falls back
// to whatever .text was last set if the linked Process no longer exists
// (shouldn't normally happen — Process deletion detaches the link and
// freezes the text instead — but never crash on a dangling reference).
function computeFlowNodeText(node, processes){
  if(!node.linkedProcessId) return node.text || '';
  const proc = (processes || []).find(p => p.id === node.linkedProcessId);
  if(!proc) return node.text || '';
  const steps = (proc.steps || []).filter(s => (s||'').trim() !== '');
  return [proc.title || 'Untitled process', ...steps].join('\n');
}

function addFlowNode(r){
  const scrollEl = document.getElementById('flowchartCanvasScroll');
  let x = 40, y = 40;
  if(scrollEl){
    // Drops the new node inside whatever part of the canvas is currently
    // scrolled into view, cascading slightly on repeated clicks so new
    // nodes don't stack exactly on top of each other.
    const count = r.processFlowchart.nodes.length;
    x = scrollEl.scrollLeft + 40 + (count % 5) * 24;
    y = scrollEl.scrollTop + 40 + (count % 5) * 24;
  }
  r.processFlowchart.nodes.push(blankFlowNode(nextFlowNodeLabel(r.processFlowchart.nodes), x, y));
  renderProcessFlowchart(r);
  renderParts(r); // refreshes every ingredient row's link-selector options
  scheduleSave();
}

// Recursive (mirrors migratePart's own recursion) so a node deleted while
// linked from an ingredient nested inside a Sub-part still gets cleared.
function clearFlowLinksToNode(parts, nodeId){
  (parts || []).forEach(part => {
    (part.ingredients || []).forEach(ing => {
      if(ing.flowNodeId === nodeId) ing.flowNodeId = null;
    });
    clearFlowLinksToNode(part.parts, nodeId);
  });
}

function deleteFlowNode(r, nodeId){
  const idx = r.processFlowchart.nodes.findIndex(n => n.id === nodeId);
  if(idx === -1) return;
  r.processFlowchart.nodes.splice(idx, 1);
  r.processFlowchart.edges = r.processFlowchart.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
  clearFlowLinksToNode(r.parts, nodeId);
  renderProcessFlowchart(r);
  renderParts(r);
  scheduleSave();
}

function addFlowEdge(r, fromId, toId){
  if(!fromId || !toId || fromId === toId) return;
  const exists = r.processFlowchart.edges.some(e => e.from === fromId && e.to === toId);
  if(exists) return;
  r.processFlowchart.edges.push({ id: uid(), from: fromId, to: toId });
}

function deleteFlowEdge(r, edgeId){
  const idx = r.processFlowchart.edges.findIndex(e => e.id === edgeId);
  if(idx === -1) return;
  r.processFlowchart.edges.splice(idx, 1);
  redrawFlowEdges(r);
  scheduleSave();
}

// Every node div is position:absolute inside #flowchartCanvas (itself
// position:relative), so offsetLeft/offsetTop are ALREADY canvas-local
// coordinates — no viewport/scroll conversion needed for node-to-node
// geometry, only for the one case that needs a real pointer position (the
// live ghost-edge preview line, handled separately in redrawFlowEdges).
function rectOf(el){
  return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
}

// Where a straight line from a rect's center to `target` crosses that
// rect's own border — used to clip an edge so it visually starts/ends at
// a node's edge instead of its center.
function clipToRectEdge(rect, target){
  const cx = rect.x + rect.w/2, cy = rect.y + rect.h/2;
  const dx = target.x - cx, dy = target.y - cy;
  if(dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min((rect.w/2) / Math.abs(dx || 1e-6), (rect.h/2) / Math.abs(dy || 1e-6));
  return { x: cx + dx*scale, y: cy + dy*scale };
}

const FLOW_ARROWHEAD_DEFS = `<defs><marker id="flowArrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--primary)"></path></marker></defs>`;

// Recomputes every edge's SVG path from the CURRENT rendered node
// positions (so a dragged node's edges always follow it, with no separate
// "commit" step) — cheap enough to just redo all of them on every move
// rather than tracking which edges touch the node being dragged. Pass
// `ghost` (the in-progress flowEdgeDraw state) while a new edge is being
// drawn, to also show a dashed preview line following the pointer.
function redrawFlowEdges(r, ghost){
  const svg = document.getElementById('flowEdgesSvg');
  const layer = document.getElementById('flowNodesLayer');
  if(!svg || !layer) return;
  let html = FLOW_ARROWHEAD_DEFS;
  (r.processFlowchart.edges || []).forEach(edge => {
    const fromEl = layer.querySelector(`[data-node-id="${edge.from}"]`);
    const toEl = layer.querySelector(`[data-node-id="${edge.to}"]`);
    if(!fromEl || !toEl) return; // defensive: a dangling edge shouldn't be possible, but never crash on one
    const fromRect = rectOf(fromEl), toRect = rectOf(toEl);
    const fromCenter = { x: fromRect.x + fromRect.w/2, y: fromRect.y + fromRect.h/2 };
    const toCenter = { x: toRect.x + toRect.w/2, y: toRect.y + toRect.h/2 };
    const start = clipToRectEdge(fromRect, toCenter);
    const end = clipToRectEdge(toRect, fromCenter);
    // Two overlapping paths per edge: a wide invisible one first (an easy
    // click target, via CSS pointer-events:stroke) then the thin visible
    // line on top — a CSS ":hover + selector" rule alone highlights the
    // visible line on hover, no JS hover wiring needed.
    html += `<path class="flow-edge-hit" data-edge-id="${edge.id}" d="M${start.x},${start.y} L${end.x},${end.y}"></path>`;
    html += `<path class="flow-edge-line" d="M${start.x},${start.y} L${end.x},${end.y}" marker-end="url(#flowArrowhead)"></path>`;
  });
  if(ghost){
    const scrollEl = document.getElementById('flowchartCanvasScroll');
    const scrollRect = scrollEl.getBoundingClientRect();
    const endX = ghost.currentClientX - scrollRect.left + scrollEl.scrollLeft;
    const endY = ghost.currentClientY - scrollRect.top + scrollEl.scrollTop;
    const start = clipToRectEdge(rectOf(ghost.fromEl), { x: endX, y: endY });
    html += `<path class="flow-ghost-edge" d="M${start.x},${start.y} L${endX},${endY}"></path>`;
  }
  svg.innerHTML = html;
}

// Grows the canvas surface to fit every node + margin. Coordinates never
// go negative (see onFlowPointerMove) so growth is always one-directional
// (right/down) — the surface only re-tightens back down on the next full
// renderProcessFlowchart() rebuild, not instantly as a node is dragged
// back toward the origin.
function resizeFlowCanvasToFitNodes(){
  const canvas = document.getElementById('flowchartCanvas');
  const scrollEl = document.getElementById('flowchartCanvasScroll');
  if(!canvas || !scrollEl) return;
  let maxRight = 0, maxBottom = 0;
  canvas.querySelectorAll('.flow-node').forEach(el => {
    maxRight = Math.max(maxRight, el.offsetLeft + el.offsetWidth);
    maxBottom = Math.max(maxBottom, el.offsetTop + el.offsetHeight);
  });
  canvas.style.width = Math.max(maxRight + 200, scrollEl.clientWidth) + 'px';
  canvas.style.height = Math.max(maxBottom + 200, 400) + 'px';
}

// Full rebuild of the nodes layer + edges — deliberately lazy: bails out
// unless Flowchart view is genuinely visible right now. offsetWidth/
// offsetHeight all read 0 on elements inside a display:none ancestor, so
// building this eagerly while List view is active would silently draw
// every node collapsed at 0x0. refreshProcessViewMode always flips
// visibility BEFORE calling this, so by the time it runs the container is
// real and measurable.
function renderProcessFlowchart(r){
  const layer = document.getElementById('flowNodesLayer');
  if(!layer || r.processViewMode !== 'flowchart') return;

  layer.innerHTML = '';
  (r.processFlowchart.nodes || []).forEach(node => {
    const el = document.createElement('div');
    el.className = 'flow-node';
    el.dataset.nodeId = node.id;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    el.style.width = (node.w || DEFAULT_FLOW_NODE_W) + 'px';
    el.innerHTML = `
      <div class="flow-connector-dot top"></div>
      <div class="flow-connector-dot right"></div>
      <div class="flow-connector-dot bottom"></div>
      <div class="flow-connector-dot left"></div>
      <div class="flow-node-strip">
        ${icon('move', 12)}
        <input type="text" class="flow-node-label" maxlength="6">
        <button type="button" class="icon-btn" title="Delete this node">${icon('x')}</button>
      </div>
      <select class="flow-node-link" title="Link this node to a Process from the List view — its text then stays in sync with that Process's title/steps"></select>
      <textarea class="flow-node-text" rows="1" placeholder="Step / group name..."></textarea>
    `;
    // Appended before any scrollHeight-dependent measurement below — a
    // detached element (not yet in the document) can't report real layout.
    layer.appendChild(el);

    const labelInput = el.querySelector('.flow-node-label');
    labelInput.value = node.label || '';
    labelInput.addEventListener('input', e => {
      node.label = e.target.value;
      renderParts(r); // keeps every ingredient row's link-selector option text in sync
      scheduleSave();
    });

    const textArea = el.querySelector('.flow-node-text');
    function autoGrowFlowTextarea(){
      textArea.style.height = 'auto';
      textArea.style.height = textArea.scrollHeight + 'px';
    }
    // Reflects the node's current linked/unlinked state: linked shows the
    // live-derived text read-only (edit the actual Process in List view
    // instead — editing it here would just be silently overwritten the
    // next render), unlinked is a normal free-typed field.
    function refreshTextAreaFromLinkState(){
      textArea.value = computeFlowNodeText(node, r.processes);
      textArea.disabled = !!node.linkedProcessId;
      autoGrowFlowTextarea();
    }
    refreshTextAreaFromLinkState();
    textArea.addEventListener('input', e => {
      node.text = e.target.value;
      autoGrowFlowTextarea();
      resizeFlowCanvasToFitNodes();
      redrawFlowEdges(r);
      scheduleSave();
    });

    const linkSelect = el.querySelector('.flow-node-link');
    linkSelect.innerHTML = `<option value="">— Free text —</option>` +
      (r.processes || []).map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.title || 'Untitled process')}</option>`).join('');
    linkSelect.value = node.linkedProcessId || '';
    linkSelect.addEventListener('change', e => {
      node.linkedProcessId = e.target.value || null;
      refreshTextAreaFromLinkState();
      resizeFlowCanvasToFitNodes();
      redrawFlowEdges(r);
      scheduleSave();
    });

    el.querySelector('.flow-node-strip').addEventListener('pointerdown', e => {
      if(e.target.closest('.flow-node-label, .icon-btn')) return;
      startFlowNodeDrag(r, node, el, e);
    });
    el.querySelectorAll('.flow-connector-dot').forEach(dot => {
      dot.addEventListener('pointerdown', e => {
        e.stopPropagation(); // don't also start a node-drag from the same pointerdown
        startFlowEdgeDraw(r, node, el, e);
      });
    });
    el.querySelector('.icon-btn').addEventListener('click', () => deleteFlowNode(r, node.id));
  });

  resizeFlowCanvasToFitNodes();
  redrawFlowEdges(r);
}

function startFlowNodeDrag(r, node, el, e){
  flowNodeDrag = { r, node, el, startClientX: e.clientX, startClientY: e.clientY, startX: node.x, startY: node.y };
  el.classList.add('dragging');
}

function startFlowEdgeDraw(r, node, el, e){
  flowEdgeDraw = { r, fromNode: node, fromEl: el, currentClientX: e.clientX, currentClientY: e.clientY };
}

function onFlowPointerMove(e){
  if(flowNodeDrag){
    const d = flowNodeDrag;
    d.node.x = Math.max(0, Math.round(d.startX + (e.clientX - d.startClientX)));
    d.node.y = Math.max(0, Math.round(d.startY + (e.clientY - d.startClientY)));
    d.el.style.left = d.node.x + 'px';
    d.el.style.top = d.node.y + 'px';
    resizeFlowCanvasToFitNodes();
    redrawFlowEdges(d.r);
  } else if(flowEdgeDraw){
    flowEdgeDraw.currentClientX = e.clientX;
    flowEdgeDraw.currentClientY = e.clientY;
    redrawFlowEdges(flowEdgeDraw.r, flowEdgeDraw);
  }
}
function onFlowPointerUp(e){
  if(flowNodeDrag){
    flowNodeDrag.el.classList.remove('dragging');
    flowNodeDrag = null;
    scheduleSave();
  } else if(flowEdgeDraw){
    const { r, fromNode } = flowEdgeDraw;
    const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.flow-node');
    flowEdgeDraw = null; // cleared before branching, so it can never leak on an early return
    const toId = targetEl?.dataset.nodeId;
    if(toId && toId !== fromNode.id) addFlowEdge(r, fromNode.id, toId);
    redrawFlowEdges(r);
    scheduleSave();
  }
}
document.addEventListener('pointermove', onFlowPointerMove);
document.addEventListener('pointerup', onFlowPointerUp);

function setProcessViewMode(r, mode){
  r.processViewMode = mode;
  refreshProcessViewMode(r);
  scheduleSave();
}

function refreshProcessViewMode(r){
  const listWrap = document.getElementById('processesListWrap');
  const flowWrap = document.getElementById('flowchartCanvasWrap');
  const toggleWrap = document.getElementById('processViewToggle');
  if(!listWrap || !flowWrap) return;
  const isFlow = r.processViewMode === 'flowchart';
  listWrap.classList.toggle('process-view-hidden', isFlow);
  flowWrap.classList.toggle('process-view-hidden', !isFlow);
  if(toggleWrap){
    toggleWrap.querySelectorAll('.view-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === r.processViewMode);
    });
  }
  if(isFlow) renderProcessFlowchart(r); // container is now genuinely visible — safe to measure/build
}

/* ---------- Description points (Description / Concept, as a bullet list) ---------- */
function renderDescPoints(r){
  const list = document.getElementById('descPointsList');
  if(!list) return;
  list.innerHTML = '';
  r.description.forEach((point, idx) => {
    const row = document.createElement('div');
    row.className = 'desc-point-row';
    row.innerHTML = `
      <span class="step-badge">${idx+1}</span>
      <textarea rows="2" placeholder="e.g. Product characteristics, selling point, target audience..."></textarea>
      <button class="icon-btn" title="Delete">${icon('x')}</button>
    `;
    const ta = row.querySelector('textarea');
    ta.value = point;
    ta.addEventListener('input', e => { r.description[idx] = e.target.value; scheduleSave(); });
    row.querySelector('.icon-btn').addEventListener('click', () => {
      r.description.splice(idx, 1);
      renderDescPoints(r);
      scheduleSave();
    });
    list.appendChild(row);
  });
}

/* Up to 3 reference photos attached to Description / Concept — same pattern
   as the Trial Photos row (resize on upload, thumbnail grid, click to
   remove), just a separate array so the two photo sets don't mix. */
function renderDescPhotos(r){
  const row = document.getElementById('descPhotosRow');
  const input = document.getElementById('descPhotoInput');
  if(!row) return;
  row.innerHTML = r.descPhotos.map((photo, idx) => `
    <div class="trial-photo-thumb" data-idx="${idx}">
      <img src="${escapeHtml(photo)}" alt="Description photo ${idx+1}">
      <button title="Remove this photo">${icon('x')}</button>
    </div>
  `).join('');
  row.querySelectorAll('.trial-photo-thumb button').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.closest('.trial-photo-thumb').dataset.idx, 10);
      r.descPhotos.splice(idx, 1);
      renderDescPhotos(r);
      scheduleSave();
    });
  });
  if(input) input.style.display = r.descPhotos.length >= 3 ? 'none' : '';
}

// Shared by the print view and the Version Preview modal — a process list
// (title + optional components table + numbered steps) rendered read-only,
// fed from either the live recipe or a frozen version snapshot.
function readOnlyProcessesHtml(processes){
  const list = (processes || []).filter(p =>
    (p.title||'').trim() !== '' ||
    (p.steps||[]).some(s => (s||'').trim() !== '') ||
    (p.components||[]).length > 0
  );
  if(list.length === 0) return '<div class="compare-missing">No processes yet</div>';
  return list.map(p => {
    const steps = (p.steps || []).filter(s => (s||'').trim() !== '');
    const components = p.components || [];
    return `
      <div class="compare-process-title">${escapeHtml(p.title || 'Untitled process')}</div>
      ${components.length ? `
        <table class="compare-table" style="margin-bottom:10px;">
          <thead><tr><th>#</th><th>Component</th><th>Weight (g)</th><th>Tolerance</th><th>Range</th><th>%</th></tr></thead>
          <tbody>${components.map((c, cIdx) => {
            const wt = parseFloat(c.weight) || 0;
            const tol = parseFloat(c.tolerance) || 0;
            return `<tr><td>${cIdx+1}</td><td>${escapeHtml(c.name||'')}</td><td>${formatWeight(wt)}</td><td>±${tol}</td><td>${(wt-tol).toFixed(2)}-${(wt+tol).toFixed(2)} g</td><td>${(parseFloat(c.percent)||0).toFixed(2)}%</td></tr>`;
          }).join('')}</tbody>
          <tfoot><tr class="total-row">
            <td></td><td>Total</td>
            <td>${formatWeight(components.reduce((s,c)=>s+(parseFloat(c.weight)||0),0))}</td>
            <td></td><td></td>
            <td>${components.reduce((s,c)=>s+(parseFloat(c.percent)||0),0).toFixed(2)}%</td>
          </tr></tfoot>
        </table>
      ` : ''}
      ${steps.length ? `<ol>${steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : '<div class="compare-missing">No steps yet</div>'}
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

function renderReadOnlyProcessFlowchart(containerEl, flowchart, processes){
  containerEl.innerHTML = readOnlyProcessFlowchartHtml(flowchart, processes);
  if(((flowchart && flowchart.nodes) || []).length > 0){
    finalizeReadOnlyFlowchartEdges(containerEl, flowchart);
  }
}

// offsetHeight/offsetWidth all read 0 on elements inside a display:none
// ancestor — #printProcessFlowchart is display:none on-screen by default
// (only shown via the print media query at real print time), so measuring
// it immediately after setting its innerHTML would draw every edge
// collapsed to a point. This temporarily forces it genuinely laid out but
// off-viewport, runs the measure-and-draw step, then restores it — letting
// the normal .print-only CSS (and the print media query's own !important)
// keep governing its visibility for both screen and actual print output.
function withTemporaryVisibility(el, fn){
  const prevCss = el.style.cssText;
  el.style.cssText = 'display:block !important;position:absolute;left:-9999px;top:-9999px;visibility:visible;';
  fn();
  el.style.cssText = prevCss;
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
function readOnlyIngredientTreeHtml(parts, totalWeight, flowNodes){
  const namedParts = (parts || []).filter(part => allIngredientsInPart(part).some(i => (i.name||'').trim() !== ''));
  if(namedParts.length === 0) return '<div class="overview-empty">No ingredients</div>';
  // The whole Node column is omitted entirely (not just left blank) unless
  // the recipe actually has flowchart nodes, so recipes that never touch
  // that feature get byte-identical print/preview output to before it
  // existed.
  const nodeLabelById = new Map((flowNodes || []).map(n => [n.id, n.label || '?']));
  const showNodeCol = nodeLabelById.size > 0;
  const rootRow = `
    <tr class="ro-tree-row ro-tree-root">
      <td class="ro-tree-name">Formula per Portion</td>
      <td class="ro-tree-note"></td>
      <td class="ro-tree-pct">100.00%</td>
      <td class="ro-tree-wt">${fmtNum(totalWeight)}</td>
      ${showNodeCol ? '<td class="ro-tree-nodecol"></td>' : ''}
    </tr>
  `;
  const bodyRows = namedParts.map((part, idx) =>
    readOnlyPartBranchRows(part, false, totalWeight, [], idx === namedParts.length - 1, nodeLabelById)
  ).join('');
  return `
    <table class="ro-tree-table">
      <thead><tr><th class="ro-tree-name">Component</th><th class="ro-tree-note">Note</th><th class="ro-tree-pct">%</th><th class="ro-tree-wt">g</th>${showNodeCol ? '<th class="ro-tree-nodecol">Node</th>' : ''}</tr></thead>
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
function readOnlyPartBranchRows(part, isNested, parentTotal, ancestorContinues, isLast, nodeLabelById){
  const namedIngredients = (part.ingredients||[]).filter(i => (i.name||'').trim() !== '');
  const namedSubParts = (part.parts||[]).filter(sub => allIngredientsInPart(sub).some(i => (i.name||'').trim() !== ''));
  const label = (part.name||'').trim() || 'Unnamed part';
  const partWeight = partTotalWeight(part);
  const partPct = parentTotal > 0 ? (partWeight / parentTotal * 100) : 0;
  const showNodeCol = nodeLabelById && nodeLabelById.size > 0;
  const partRow = `
    <tr class="ro-tree-row ro-tree-part">
      <td class="ro-tree-name">${treeGuideHtml(ancestorContinues, isLast)}${escapeHtml(label)}</td>
      <td class="ro-tree-note"></td>
      <td class="ro-tree-pct">${partPct.toFixed(2)}%</td>
      <td class="ro-tree-wt">${fmtNum(partWeight)}</td>
      ${showNodeCol ? '<td class="ro-tree-nodecol"></td>' : ''}
    </tr>
  `;
  const childAncestorContinues = [...ancestorContinues, !isLast];
  const childCount = namedIngredients.length + namedSubParts.length;
  const ingRows = namedIngredients.map((ing, idx) => {
    const childIsLast = idx === childCount - 1;
    const nodeLabel = showNodeCol && ing.flowNodeId ? nodeLabelById.get(ing.flowNodeId) : null;
    return `
      <tr class="ro-tree-row ro-tree-ing">
        <td class="ro-tree-name">${treeGuideHtml(childAncestorContinues, childIsLast)}${escapeHtml(ing.name)}</td>
        <td class="ro-tree-note">${escapeHtml(ing.note || '')}</td>
        <td class="ro-tree-pct">${(parseFloat(ing.percent)||0).toFixed(2)}%</td>
        <td class="ro-tree-wt">${fmtNum(parseFloat(ing.weight)||0)}</td>
        ${showNodeCol ? `<td class="ro-tree-nodecol">${nodeLabel ? '→' + escapeHtml(nodeLabel) : ''}</td>` : ''}
      </tr>
    `;
  }).join('');
  const subRows = namedSubParts.map((sub, idx) => {
    const childIsLast = namedIngredients.length + idx === childCount - 1;
    return readOnlyPartBranchRows(sub, true, partWeight, childAncestorContinues, childIsLast, nodeLabelById);
  }).join('');
  return partRow + ingRows + subRows;
}

/* Read-only print layout for section 1 (info card) and section 3 (process
   steps as a plain numbered list) — reuses the same look as Compare Recipes
   instead of the on-screen editable form/step-badge styling. Filled in right
   before printing so it's always current regardless of what was last edited. */
function renderPrintView(r){
  const infoEl = document.getElementById('printInfoCard');
  if(infoEl){
    const totalWt = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
    infoEl.innerHTML = `
      <div class="ci-name">${escapeHtml(r.name || 'Untitled recipe')}</div>
      <div class="ci-row"><b>Code:</b> ${escapeHtml(fullCode(r) || '-')}</div>
      <div class="ci-row"><b>Date:</b> ${escapeHtml(r.date || '-')}</div>
      <div class="ci-row"><b>Total weight:</b> ${formatWeight(totalWt)}</div>
      ${r.customerName ? `<div class="ci-row"><b>Customer:</b> ${escapeHtml(r.customerName)}</div>` : ''}
      ${r.destinationCountry ? `<div class="ci-row"><b>Destination country:</b> ${escapeHtml(r.destinationCountry)}</div>` : ''}
      ${r.salesRep ? `<div class="ci-row"><b>Sales rep:</b> ${escapeHtml(r.salesRep)}</div>` : ''}
      ${descriptionListHtml(r)}
    `;
  }

  const treeEl = document.getElementById('printIngredientTree');
  if(treeEl){
    const totalWt = allIngredientsInRecipe(r).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
    treeEl.innerHTML = readOnlyIngredientTreeHtml(r.parts, totalWt, r.processFlowchart.nodes);
  }

  // Mutually exclusive with the flowchart print view below, matching
  // whichever mode is currently selected on-screen (see processViewMode).
  const isFlowMode = r.processViewMode === 'flowchart' && r.processFlowchart.nodes.length > 0;
  const procEl = document.getElementById('printProcessesView');
  if(procEl) procEl.innerHTML = isFlowMode ? '' : readOnlyProcessesHtml(r.processes);

  const flowEl = document.getElementById('printProcessFlowchart');
  if(flowEl){
    if(isFlowMode){
      withTemporaryVisibility(flowEl, () => renderReadOnlyProcessFlowchart(flowEl, r.processFlowchart, r.processes));
    } else {
      flowEl.innerHTML = '';
    }
  }
}

/* ---------- Recipe actions ---------- */
function duplicateCurrent(){
  const r = getCurrent();
  if(!r) return;
  const copy = JSON.parse(JSON.stringify(r));
  copy.id = uid();
  copy.name = (r.name || 'Untitled recipe') + ' (Copy)';
  copy.createdBy = currentUser?.email || '';
  copy.createdAt = Date.now();
  copy.updatedBy = currentUser?.email || '';
  copy.updatedAt = Date.now();
  // A duplicate is a distinct recipe, not the same one — carrying over the
  // original's sequence number would give two recipes the identical code
  // (e.g. both "BRE01"). Computed now, before push, so the count below
  // doesn't include this copy — the original recipe (still in `recipes`)
  // is what makes this land one past it.
  if(copy.productType) copy.recipeSeq = suggestNextRecipeSeq(copy.productType, copy.id);
  recipes.push(copy);
  // The Project link isn't stored on the recipe itself (see
  // findProjectForRecipe) — it's the Project's own products list pointing
  // back at a recipeId — so duplicating the recipe object alone never
  // carried it over. Add the copy as a fresh product entry (its own stage/
  // log, not the original's progress) on that same Project.
  const oldLink = findProjectForRecipe(r.id);
  if(oldLink && !oldLink.project.products.some(x => x.recipeId === copy.id)){
    oldLink.project.products.push(blankProduct(copy.id));
    scheduleProjectSave(oldLink.project);
  }
  currentId = copy.id;
  unlockedRecipeId = copy.id;
  saveRecipeToCloud(copy);
  logActivityEvent('created', 'recipe', copy.name || 'Untitled recipe');
  renderSidebar();
  renderMain();
}

/* Called after the approver's credentials have already been verified and the
   recipe already deleted from Firestore (via approverAction) — this just
   updates local state and the UI to match. */
function deleteCurrent(){
  const r = getCurrent();
  if(!r) return;
  const deletedId = r.id;
  recipes = recipes.filter(x => x.id !== deletedId);
  currentId = null;
  unlockedRecipeId = null;
  renderSidebar();
  renderMain();
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
        currentId = recipes[recipes.length-1].id;
        unlockedRecipeId = null;
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
  currentId = null;
  unlockedRecipeId = null;
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
  document.getElementById('projectColumnsMenu')?.classList.remove('open');
  if(openProjectFilterMenuKey){
    closeProjectFilterMenu();
    document.querySelectorAll('[data-filter-menu].open').forEach(m => m.classList.remove('open'));
  }
  if(taskTrackingWhoMenuOpen){
    taskTrackingWhoMenuOpen = false;
    document.getElementById('taskTrackingWhoMenu')?.classList.remove('open');
  }
});

window.addEventListener('resize', () => { activeProjScrollbarProxySync?.(); });

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
  setIcon('btnMuEditModalTranslateHow', 'globe', 14);
  setIcon('btnMuEditModalTranslateNextAction', 'globe', 14);
  setIcon('btnMuEditModalTranslateNextActionHow', 'globe', 14);
  prefixIcon('btnCompare', 'scale');
  prefixIcon('btnOpenUserAdmin', 'users');
  prefixIcon('btnOpenMyProfile', 'user');
  prefixIcon('btnOpenSecurity', 'lock');
  prefixIcon('btnOpenDataManagement', 'database');
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
initProjectsModal();
initMuAttachmentPreviewModal();
initTrialsView();
initUnsavedChangesGuard();
initUserAdminPanel();
initMyProfileModal();
initSecurityModal();
initDataManagementModal();
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
    renderApp();
  }, err => {
    console.error('Forge: profile listener error', err);
  });
}

function unlockAppAfterApproval(){
  if(!unsubscribeRecipes) attachRecipesListener();
  if(!unsubscribeMaterials) attachMaterialsListener();
  if(!unsubscribeMetaLists) attachMetaListsListener();
  if(!unsubscribeProjects) attachProjectsListener();
  if(!unsubscribeTrials) attachTrialsListener();
  if(!unsubscribeLoginEvents) attachLoginEventsListener();
  if(!unsubscribeActivityEvents) attachActivityEventsListener();
  if(!unsubscribeMyProfile) attachMyProfileListener();
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
          if(mainFeatureView && MODULE_PERMISSIONS.some(m => m.key === mainFeatureView) && !hasModuleAccess(mainFeatureView)){
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
    if(unsubscribeRecipes){ unsubscribeRecipes(); unsubscribeRecipes = null; }
    resetMaterialsState();
    resetRefListsState();
    resetProjectsState();
    resetTrialsState();
    if(unsubscribeLoginEvents){ unsubscribeLoginEvents(); unsubscribeLoginEvents = null; }
    if(unsubscribeActivityEvents){ unsubscribeActivityEvents(); unsubscribeActivityEvents = null; }
    if(unsubscribeUserApprovalsAdmin){ unsubscribeUserApprovalsAdmin(); unsubscribeUserApprovalsAdmin = null; }
    if(unsubscribeMyProfile){ unsubscribeMyProfile(); unsubscribeMyProfile = null; }
    myProfile = { displayName: '', photoImage: '' };
    activityEvents = [];
    recipesLoaded = false;
    recipes = [];
    loginEvents = [];
    currentId = null;
    unlockedRecipeId = null;
    appView = 'auth';
  }
  renderApp();
});
