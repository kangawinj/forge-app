// Recipe/Trial lifecycle actions -- New Trial, Duplicate as New Recipe,
// starting a Trial Series for a Series-less recipe, and deleting the
// current recipe after approver confirmation. Split out of recipes.js
// (which grew past 3,400 lines even after its first split) -- see
// recipes.js's own top-of-file comment for the overall file split.
import {
  currentUser, uid, recipesCol, recipeSeriesCol, db, logActivityEvent,
  renderSidebar, renderMain, blankProduct, scheduleProjectSave
} from './app.js';
import {
  doc, setDoc, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  saveRecipeToCloud, findProjectForRecipe, yearPrefix, recipeDestinationIso2,
  recipeProductTypeCode, suggestNextRecipeSeq, trialNoDisplay
} from './recipes-data.js';
// Circular import back to core recipes.js -- safe, same pattern proven
// throughout this session's other splits: every cross-call below happens
// inside an event handler, never at module-evaluation time. `recipes` is
// the live array binding -- .push()/.filter() on it are fine; only
// reassigning it would need a core-owned setter, and that stays in core's
// own removeRecipe.
import {
  recipes, getCurrent, openRecipe, setUnlockedRecipeId, removeRecipe, closeRecipe
} from './recipes.js';

/* ---------- Recipe actions ---------- */

/* ---------- Recipe Series / Trials ----------
   A "Trial" is just a regular recipe document, enriched with 8 identity
   fields (see blankRecipe/migrateRecipe above) that group it under a
   Recipe Series (a separate recipeSeries/{seriesId} doc holding the
   collision-safe Trial-number counter, since Firestore transactions can
   only read a specific document reference, never a query). Versions
   (edit-history snapshots) and Test Results (the separate `trials`
   collection, referencing recipes by their own r.id) are both completely
   untouched by any of this -- see snapshotRecipeCore's whitelist above and
   trials.js, respectively. */

// Deep-clones a source recipe into a new Trial/Recipe document, applying
// the same copy/don't-copy split every "branch off this recipe" action in
// this app needs (New Trial and Duplicate as New Recipe both call this,
// only their `overrides` differ) -- identity fields (seriesId/seriesKey/
// countryCode/year/productTypeCode/recipeSeq/trialNo/sourceTrialId) always
// come from `overrides`, never from the source's own live values, so a
// Trial can never silently drift from its Series' frozen identity.
function buildTrialClone(r, newId, overrides){
  const clone = JSON.parse(JSON.stringify(r));
  clone.id = newId;
  // Never carried forward: each Trial/new Recipe gets its own edit history,
  // its own (initially empty) free-text legacy code, and no inherited
  // photos/audit trail from the source.
  clone.versions = [];
  clone.code = '';
  clone.descPhotos = [];
  clone.legacyRecipeCode = '';
  clone.createdBy = currentUser?.email || '';
  clone.createdAt = Date.now();
  clone.updatedBy = currentUser?.email || '';
  clone.updatedAt = Date.now();
  // Identity — always frozen from the Series, per overrides.
  clone.seriesId = overrides.seriesId;
  clone.seriesKey = overrides.seriesKey;
  clone.countryCode = overrides.countryCode;
  clone.year = overrides.year;
  clone.productTypeCode = overrides.productTypeCode;
  clone.recipeSeq = overrides.recipeSeqOverride;
  clone.trialNo = overrides.trialNo;
  clone.sourceTrialId = overrides.sourceTrialId;
  return clone;
}

// The atomic "+ New Trial" write. Firestore transactions can only tx.get()
// a specific document reference (never run a query), so "the next Trial
// number in this Series" has to come from a dedicated counter document
// (recipeSeries.maxTrialNo) that this transaction reads AND increments in
// the same atomic step -- two concurrent calls both read the current
// value, but Firestore serializes the writes and auto-retries whichever
// transaction loses the race, so its retried read picks up the winner's
// new maxTrialNo. This is deliberately NOT the same pattern
// suggestNextRecipeSeq uses for Recipe No. -- that one scans the
// in-memory `recipes` array with no lock, which is fine for the low-stakes
// "two people duplicate into the same Product Type at the same instant"
// case but not for a number this feature explicitly requires to never
// collide.
async function createNewTrial(r){
  const newId = uid();
  const seriesRef = doc(recipeSeriesCol, r.seriesId);
  const newRecipeRef = doc(recipesCol, newId);
  return runTransaction(db, async (tx) => {
    const seriesSnap = await tx.get(seriesRef);
    if(!seriesSnap.exists()) throw new Error('SERIES_NOT_FOUND');
    const nextTrialNo = (seriesSnap.data().maxTrialNo || 0) + 1;
    const clone = buildTrialClone(r, newId, {
      trialNo: nextTrialNo,
      sourceTrialId: r.id,
      seriesId: r.seriesId,
      seriesKey: r.seriesKey,
      countryCode: r.countryCode,
      year: r.year,
      productTypeCode: r.productTypeCode,
      recipeSeqOverride: r.recipeSeq
    });
    tx.update(seriesRef, { maxTrialNo: nextTrialNo });
    tx.set(newRecipeRef, clone);
    return clone;
  });
}

// Double-click guard shared by every call site (just the Trial History
// card's "+ T22" pill and the toolbar's "+ New Trial" button today).
let newTrialInFlight = false;

async function handleNewTrialClick(r){
  if(newTrialInFlight || !r.seriesId) return;
  newTrialInFlight = true;
  const btn = document.getElementById('btnNewTrial');
  const originalLabel = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; btn.textContent = 'Creating...'; }
  try{
    const newTrial = await createNewTrial(r);
    recipes.push(newTrial);
    // The Project link isn't stored on the recipe itself (see
    // findProjectForRecipe) -- it's the Project's own products list
    // pointing back at a recipeId -- so the new Trial doc alone never
    // carries it over. Same carry-forward duplicateAsNewRecipe already does
    // for its own copy, just missing here until now.
    const oldLink = findProjectForRecipe(r.id);
    if(oldLink && !oldLink.project.products.some(x => x.recipeId === newTrial.id)){
      oldLink.project.products.push(blankProduct(newTrial.id));
      scheduleProjectSave(oldLink.project);
    }
    openRecipe(newTrial.id);
    setUnlockedRecipeId(newTrial.id);
    logActivityEvent('created', 'recipe', newTrial.name || 'Untitled recipe');
    renderSidebar();
    renderMain();
    alert(`Created Trial T${trialNoDisplay(newTrial.trialNo)} in ${newTrial.seriesKey}.`);
  } catch(err){
    console.error('Forge: New Trial failed', err);
    alert('Could not create the new Trial. Please try again.' + (err && err.message === 'SERIES_NOT_FOUND' ? ' (This recipe\'s Series record is missing.)' : ''));
  } finally {
    newTrialInFlight = false;
    if(btn){ btn.disabled = false; btn.textContent = originalLabel || '+ New Trial'; }
  }
}

// Shows Source Trial + a best-effort expected new number (the true number
// can only be guaranteed once the transaction actually commits — see
// createNewTrial) before creating anything, per spec.
export function confirmAndCreateNewTrial(r){
  if(!r.seriesId) return;
  const seriesTrials = recipes.filter(x => x.seriesId === r.seriesId);
  const bestGuessNext = Math.max(0, ...seriesTrials.map(x => x.trialNo || 0)) + 1;
  const ok = confirm(
    `Create a new Trial in ${r.seriesKey}?\n\n` +
    `Source: Trial T${trialNoDisplay(r.trialNo)}\n` +
    `New Trial (expected): T${trialNoDisplay(bestGuessNext)}\n\n` +
    `Ingredients, process steps, yield, and the linked project will be copied.\n` +
    `Versions, Test Results, and trial photos will NOT be copied.`
  );
  if(ok) handleNewTrialClick(r);
}

// Moved to the recipe editor's "More" menu as "Duplicate as New Recipe" —
// unlike New Trial, this always mints a BRAND NEW Series (fresh random
// seriesId, maxTrialNo starting at 1), so two simultaneous clicks can never
// collide with each other and no transaction is needed here (nothing
// shared to contend over). Still reuses the same existing
// suggestNextRecipeSeq race-condition-accepted pattern for the Recipe No.
// itself, exactly as this function always has.
export function duplicateAsNewRecipe(){
  const r = getCurrent();
  if(!r) return;
  const newId = uid();
  const newSeq = suggestNextRecipeSeq(recipes, r.productType, r.id);
  const seriesRef = doc(recipeSeriesCol, uid());
  // If the source is itself already Series-enabled, carry its frozen
  // country/year/type forward (a duplicate of a Trial stays under the same
  // country/product-type family); otherwise derive them once, live, from
  // the source recipe exactly as fullCode() would today, then freeze them.
  const countryCode = r.seriesId ? r.countryCode : (recipeDestinationIso2(r) || '');
  const year = r.seriesId ? r.year : yearPrefix(r.date);
  const prodTypeCode = r.seriesId ? r.productTypeCode : recipeProductTypeCode(r);
  const seriesKey = `${countryCode}${year}-${prodTypeCode}${newSeq}`;
  const seriesDoc = {
    id: seriesRef.id, seriesKey, countryCode, year, productTypeCode: prodTypeCode,
    productType: r.productType || '', recipeSeq: newSeq, maxTrialNo: 1,
    firstTrialId: newId, createdAt: Date.now(), createdBy: currentUser?.email || ''
  };
  const copy = buildTrialClone(r, newId, {
    trialNo: 1, sourceTrialId: null, seriesId: seriesRef.id, seriesKey,
    countryCode, year, productTypeCode: prodTypeCode, recipeSeqOverride: newSeq
  });
  copy.name = (r.name || 'Untitled recipe') + ' (Copy)';
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
  setDoc(seriesRef, seriesDoc);
  openRecipe(copy.id);
  setUnlockedRecipeId(copy.id);
  saveRecipeToCloud(copy);
  logActivityEvent('created', 'recipe', copy.name || 'Untitled recipe');
  renderSidebar();
  renderMain();
}

// A plain "+ New Recipe" starts Series-less (see blankRecipe) so Product
// Type stays pickable — a Series recipe has that picker locked (see the
// f-productTypeMain change handler above), which would permanently freeze
// it at "not chosen yet" if a Series existed before the first pick. This
// mints the Series in place (no new document, unlike duplicateAsNewRecipe)
// the moment a Series-less recipe's Product Type is picked for the first
// time, so a brand-new recipe reaches "+ New Trial" without ever needing a
// separate Duplicate step. Same derivation as duplicateAsNewRecipe, just
// freezing the current recipe's own live values instead of a clone's.
export function startTrialSeriesForRecipe(r){
  if(r.seriesId) return;
  const newSeq = suggestNextRecipeSeq(recipes, r.productType, r.id);
  const countryCode = recipeDestinationIso2(r) || '';
  const year = yearPrefix(r.date);
  const prodTypeCode = recipeProductTypeCode(r);
  const seriesKey = `${countryCode}${year}-${prodTypeCode}${newSeq}`;
  const seriesRef = doc(recipeSeriesCol, uid());
  const seriesDoc = {
    id: seriesRef.id, seriesKey, countryCode, year, productTypeCode: prodTypeCode,
    productType: r.productType || '', recipeSeq: newSeq, maxTrialNo: 1,
    firstTrialId: r.id, createdAt: Date.now(), createdBy: currentUser?.email || ''
  };
  r.seriesId = seriesRef.id;
  r.seriesKey = seriesKey;
  r.countryCode = countryCode;
  r.year = year;
  r.productTypeCode = prodTypeCode;
  r.recipeSeq = newSeq;
  r.trialNo = 1;
  r.sourceTrialId = null;
  setDoc(seriesRef, seriesDoc);
}

/* Called after the approver's credentials have already been verified and the
   recipe already deleted from Firestore (via approverAction) — this just
   updates local state and the UI to match. */
export function deleteCurrent(){
  const r = getCurrent();
  if(!r) return;
  const deletedId = r.id;
  removeRecipe(deletedId);
  closeRecipe();
  renderSidebar();
  renderMain();
}
