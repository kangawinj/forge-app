// Pure data/model/geometry helpers for Recipes -- no DOM rendering. Split
// out of recipes.js (which grew past 5,200 lines) -- see recipes.js's own
// top-of-file comment for the overall file split.
import {
  uid, currentUser, escapeHtml, recipesCol, projects, metaLists, metaItemName, productTypeCode,
  countryToIso2, computePrepareWeight
} from './app.js';
import {
  setDoc, doc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const PART_COUNT = 4;

// A Part's own children -- ingredients AND Sub-parts -- live together in
// one ordered `items` array (each tagged `kind`), instead of two separate
// arrays, so a Sub-part can be dragged to sit between specific ingredients
// instead of always trailing after every one of them. `partIngredients`/
// `partSubParts` below are the read-only "give me just this kind" views
// used everywhere that doesn't care about relative order (weight/cost
// math, lookups) -- code that DOES care about order (the live editor,
// Print, Excel) walks `part.items` directly instead.
export function blankIngredient(){
  return { kind: 'ingredient', id: uid(), name:"", percent:0, weight:0, note:"" };
}
export function blankPart(name){
  return { kind: 'part', name, items: [ blankIngredient() ], prepYieldPct: null, percent: 0 };
}
export function partIngredients(part){
  return (part.items || []).filter(i => i.kind === 'ingredient');
}
export function partSubParts(part){
  return (part.items || []).filter(i => i.kind === 'part');
}
// An ingredient item's own weight, or a Sub-part item's recursive total
// (see partTotalWeight below) -- lets code that sums a Part's children
// treat every item the same regardless of kind.
export function itemWeight(item){
  return item.kind === 'part' ? partTotalWeight(item) : (parseFloat(item.weight) || 0);
}

export function blankRecipe(){
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
    note: "",
    devStatus: "In Development",
    batchWeight: 1000,
    parts: [],
    processes: [ { id: uid(), title: "", steps: [], components: [] } ],
    yieldPct: '',
    servingSizeG: '',
    pricingCurrency: 'THB',
    exchangeRate: '',
    exchangeRateDate: '',
    overheadMultiplier: 1.625,
    factoryMarginMin: 20,
    factoryMarginMax: 30,
    companyMarginMin: 10,
    companyMarginMax: 20,
    customerMarginMin: 20,
    customerMarginMax: 30,
    versions: [],
    portionComponents: [],
    portionYieldPct: '',
    // Recipe Series / Trial identity -- absent (null/'') means "legacy,
    // no Series" everywhere this is checked (fullCode, recipeDisplayLabel,
    // the Recipe Detail header/toolbar, sidebar grouping). Only ever set
    // by createNewTrial(), duplicateAsNewRecipe(), or the Series migration
    // tool -- never by ordinary editing. See recipes.js's "Recipe Series"
    // section below for the full mechanism.
    seriesId: null,
    seriesKey: '',
    countryCode: '',
    year: '',
    productTypeCode: '',
    trialNo: null,
    sourceTrialId: null,
    legacyRecipeCode: '',
    createdBy: currentUser?.email || '',
    createdAt: Date.now(),
    updatedBy: currentUser?.email || '',
    updatedAt: Date.now()
  };
}

export function migrateRecipe(r){
  if(!Array.isArray(r.parts)){
    const oldIngredients = Array.isArray(r.ingredients) && r.ingredients.length ? r.ingredients : [blankIngredient()];
    r.parts = [ { name:"Part 1", items: oldIngredients } ];
    for(let i = r.parts.length; i < PART_COUNT; i++){
      r.parts.push(blankPart(`Part ${i+1}`));
    }
    delete r.ingredients;
  }
  // Recursive so it also normalizes Sub-parts nested arbitrarily deep
  // inside a Part. Mutates `p` IN PLACE rather than replacing it --
  // recipes.js's manualPartCollapseState WeakMap is keyed by Part object
  // reference and needs that reference to survive migration unchanged.
  // Idempotent: a Part already on the current items-based shape (p.items
  // already an array, e.g. anything created via blankPart) just gets its
  // own children recursed into, nothing rebuilt.
  function migratePart(p){
    if(!Array.isArray(p.items)){
      // Older saved Part -- was two separate arrays (ingredients, parts),
      // or (further back still) just ingredients with no parts key at
      // all. Combine into one ordered list, ingredients first, exactly
      // matching what was already on screen before this feature existed,
      // so migrating existing data never visibly reorders anything.
      const oldIngredients = Array.isArray(p.ingredients) ? p.ingredients : [];
      const oldSubParts = Array.isArray(p.parts) ? p.parts : [];
      oldIngredients.forEach(ing => { ing.kind = 'ingredient'; });
      oldSubParts.forEach(sp => { sp.kind = 'part'; });
      p.items = [...oldIngredients, ...oldSubParts];
      delete p.ingredients;
      delete p.parts;
    }
    p.kind = 'part';
    // Same "never sits completely empty" safety net the drag-drop/delete
    // handlers already use elsewhere in this file.
    if(p.items.length === 0) p.items.push(blankIngredient());
    p.items.forEach(item => {
      if(item.kind === 'part'){
        migratePart(item);
      } else {
        item.kind = 'ingredient';
        // Backfilled the same way Processes already get one above -- older
        // saved ingredients never had a stable id, which quietly broke the
        // Sub Ingredients panel's per-row expand/collapse state (it keys off
        // ing.id) and is now also needed to know whether a row's Yield came
        // from a picked library variant (see subIngredientId below).
        if(!item.id) item.id = uid();
      }
    });
    const oldPartName = /^ส่วนที่ (\d+)$/.exec(p.name || '');
    if(oldPartName) p.name = `Part ${oldPartName[1]}`;
  }
  r.parts.forEach(migratePart);

  if(!Array.isArray(r.processes)){
    const oldSteps = Array.isArray(r.steps) ? r.steps.filter(s => (s||'').trim() !== '') : [];
    r.processes = [ { id: uid(), title: "", steps: oldSteps.length > 0 ? oldSteps : [''] } ];
    delete r.steps;
  }
  if(r.processes.length === 0){
    r.processes.push({ id: uid(), title: "", steps: [''], components: [] });
  }
  r.processes.forEach(p => {
    // Backfilled -- older saved Processes never had a stable id, which an
    // array index can't replace once Processes get reordered or one
    // before it is deleted.
    if(!p.id) p.id = uid();
    // A Process is valid with just a title and no steps yet — no longer
    // force a blank placeholder step just to have something to render.
    if(!Array.isArray(p.steps)) p.steps = [];
    if(!Array.isArray(p.components)) p.components = [];
  });

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
  // Margin defaults -- only backfilled while still genuinely unset (never
  // overwrites a value the user already typed, including 0), same as every
  // other backfill in this function.
  if(r.factoryMarginMin === undefined || r.factoryMarginMin === null || r.factoryMarginMin === '') r.factoryMarginMin = 20;
  if(r.factoryMarginMax === undefined || r.factoryMarginMax === null || r.factoryMarginMax === '') r.factoryMarginMax = 30;
  if(r.companyMarginMin === undefined || r.companyMarginMin === null || r.companyMarginMin === '') r.companyMarginMin = 10;
  if(r.companyMarginMax === undefined || r.companyMarginMax === null || r.companyMarginMax === '') r.companyMarginMax = 20;
  if(r.customerMarginMin === undefined || r.customerMarginMin === null || r.customerMarginMin === '') r.customerMarginMin = 20;
  if(r.customerMarginMax === undefined || r.customerMarginMax === null || r.customerMarginMax === '') r.customerMarginMax = 30;
  if(!Array.isArray(r.portionComponents)) r.portionComponents = [];
  r.portionComponents.forEach(c => { if(!c.id) c.id = uid(); });
  if(r.portionYieldPct === undefined || r.portionYieldPct === null) r.portionYieldPct = '';

  // Older recipes saved before activity tracking existed won't have these —
  // leave them blank rather than guessing a creator/date that isn't real.
  if(r.createdBy === undefined) r.createdBy = '';
  if(r.createdAt === undefined) r.createdAt = null;
  if(r.updatedBy === undefined) r.updatedBy = '';

  // Recipe Series / Trial identity -- purely defensive, same as every
  // backfill above: an old doc simply never has these, so it lands as
  // "no Series" (seriesId absent), which every consumer already treats as
  // "render exactly like before this feature existed." Actually assigning
  // a recipe TO a Series is a separate, explicit, human-approved step (see
  // the Series migration tool), never done automatically here.
  if(r.seriesId === undefined) r.seriesId = null;
  if(r.seriesKey === undefined) r.seriesKey = '';
  if(r.countryCode === undefined) r.countryCode = '';
  if(r.year === undefined) r.year = '';
  if(r.productTypeCode === undefined) r.productTypeCode = '';
  if(r.trialNo === undefined) r.trialNo = null;
  if(r.sourceTrialId === undefined) r.sourceTrialId = null;
  if(r.legacyRecipeCode === undefined) r.legacyRecipeCode = '';

  return r;
}

export function saveRecipeToCloud(r){
  return setDoc(doc(recipesCol, r.id), r);
}

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

// r.date is always "YYYY-MM-DD" (a <input type="date"> value), so the year
// is always its first 4 characters — the code format only keeps the last 2.
export function yearPrefix(dateStr){
  return dateStr && dateStr.length >= 4 ? dateStr.slice(2, 4) : 'YY';
}

export function recipeDestinationIso2(r){
  const link = findProjectForRecipe(r.id);
  return link ? countryToIso2(link.project.destinationCountry) : '';
}

// Looked up fresh from Reference Lists > Product Types each time (rather
// than duplicated onto the recipe) so a renamed type's code — always
// recalculated from its new name, see productTypeCode — stays correct
// everywhere it's referenced instead of going stale.
export function recipeProductTypeCode(r){
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
export function suggestNextRecipeSeq(recipesList, productTypeName, excludeId){
  const maxSeq = recipesList
    .filter(x => x.id !== excludeId && (x.productType || '') === productTypeName)
    .reduce((max, x) => Math.max(max, parseInt(x.recipeSeq, 10) || 0), 0);
  return String(maxSeq + 1).padStart(2, '0');
}

// Trial number display padding — at least 2 digits (5 -> "05"), and grows
// naturally past that for T100+ since padStart is a no-op once the string
// is already at/above the target length. Shared by fullCode and the Trial
// History / sidebar UI so every "T21"/"T05"/"T100" reads identically
// everywhere.
export function trialNoDisplay(trialNo){
  return String(trialNo ?? 0).padStart(2, '0');
}

export function fullCode(r){
  // Series path: every segment is a value FROZEN at Series/Trial-creation
  // time (see createNewTrial/duplicateAsNewRecipe/the Series migration
  // tool) rather than live-derived — required so every Trial in a Series
  // keeps showing the identical country/year/product-type/Recipe No. even
  // if, say, the linked Project's destination country is edited later.
  // countryCode specifically falls back to a live lookup ONLY while it's
  // still genuinely blank (e.g. the Project's Destination Country hadn't
  // been set yet the moment the Series was minted) -- once it holds any
  // real value, that value wins and stays frozen exactly as before. This
  // is a display-time fallback only (nothing gets written back), so a
  // Series born blank starts showing its country the moment Destination is
  // filled in, without needing an admin trip to Series Migration.
  if(r.seriesId){
    const countryCode = r.countryCode || recipeDestinationIso2(r) || '';
    return `${countryCode}${r.year || 'YY'}-${r.productTypeCode || 'XXX'}${r.recipeSeq || 'XX'}-T${trialNoDisplay(r.trialNo)}`;
  }
  // Legacy path — unchanged, byte-for-byte identical to before this
  // feature: every segment live-derived every time this is called.
  const yy = yearPrefix(r.date);
  const typeCode = recipeProductTypeCode(r);
  const seq = (r.recipeSeq || '').trim();
  const trial = (r.code || '').trim();
  if(yy === 'YY' && !typeCode && !seq && !trial) return '';
  const iso = recipeDestinationIso2(r);
  return (iso || '') + yy + '-' + (typeCode || 'XXX') + (seq || 'XX') + '-T' + (trial || 'XX');
}

// The sidebar/list's Series group header shows the Series' own stored
// seriesKey (e.g. "TH26-BRE05"), not any one Trial's fullCode() -- so it
// didn't get fullCode()'s same blank-countryCode fallback above, and kept
// showing a Series minted before its Destination was set with no country
// prefix even after every Trial underneath it started showing one. Rebuilds
// the key the same way it was originally assembled (see
// startTrialSeriesForRecipe/duplicateAsNewRecipe) whenever countryCode is
// still blank; a Series with any real countryCode already set (or a
// seriesKey an admin customized through Series Migration) is returned
// untouched.
export function seriesKeyDisplay(seriesKey, sampleTrial){
  if(!sampleTrial || sampleTrial.countryCode) return seriesKey || '';
  const countryCode = recipeDestinationIso2(sampleTrial) || '';
  if(!countryCode) return seriesKey || '';
  return `${countryCode}${sampleTrial.year || 'YY'}-${sampleTrial.productTypeCode || 'XXX'}${sampleTrial.recipeSeq || 'XX'}`;
}

/* Product name with the last 2 characters of the recipe code suffix appended,
   e.g. "Vegan Tartar Sauce - 19" — used anywhere recipes are picked/labeled
   so near-duplicate names stay distinguishable at a glance. */
export function recipeDisplayLabel(r){
  const name = r.name || 'Untitled recipe';
  if(r.seriesId) return `${name} - T${trialNoDisplay(r.trialNo)}`;
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

export function recomputeFromWeights(r){
  // recomputePartPercents(part) assigns .percent to `part`'s own CHILDREN,
  // not to `part` itself — for a nested Sub-part that assignment happens
  // one level up, in its parent's own call. Top-level Parts have no such
  // parent (the recipe root isn't a Part), so their own .percent has to be
  // assigned explicitly here, the same way, against the recipe total.
  const partTotals = (r.parts || []).map(part => recomputePartPercents(part));
  const totalWeight = partTotals.reduce((s,w)=>s+w,0);
  (r.parts || []).forEach((part, idx) => {
    part.percent = totalWeight > 0 ? round4(partTotals[idx] / totalWeight * 100) : 0;
  });
  r.batchWeight = round2(totalWeight);
  return totalWeight;
}

// Recursively totals one Part (its own children's weights, ingredient or
// Sub-part alike), then assigns each direct child item its own .percent
// share of that total — then recurses into any Sub-part child so it does
// the same for its own children. Returns the Part's own total weight.
export function recomputePartPercents(part){
  const weights = (part.items || []).map(itemWeight);
  const total = weights.reduce((s,w)=>s+w,0);
  (part.items || []).forEach((item, idx) => {
    item.percent = total > 0 ? round4(weights[idx] / total * 100) : 0;
    if(item.kind === 'part') recomputePartPercents(item);
  });
  return round4(total);
}

// A Part's own weight, recursively summing every child item's own weight
// (an ingredient's own weight, or a Sub-part's own recursive total).
export function partTotalWeight(part){
  return (part.items || []).reduce((s,item)=>s+itemWeight(item),0);
}

// Every ingredient under a Part, including ones nested inside its
// Sub-parts — used anywhere that just needs "the full ingredient list"
// (Compare Recipes, Print, Recipe Overview, Ingredient Library usage,
// Trial totals) without needing to also show the nesting itself.
export function allIngredientsInPart(part){
  return [...partIngredients(part), ...partSubParts(part).flatMap(allIngredientsInPart)];
}
export function allIngredientsInRecipe(r){
  return (r.parts || []).flatMap(allIngredientsInPart);
}

// Same tree as allIngredientsInPart, but pairs each ingredient with its
// fully-compounded Prepare (gross) weight -- own Yield AND every ancestor
// Part's own Yield, chained -- since Recipe Overview groups a flattened
// list across Part boundaries and needs each instance's own effective
// value, not just a single Part-level aggregate. `ancestorMultiplier`
// carries "1 / (ancestor Part's Yield / 100)" down the recursion, one
// level compounding onto the next; computePrepareWeight is reused to fold
// this Part's own Yield into it, treating the running multiplier itself as
// a "weight" being divided -- same fallback-safe math, no new logic.
// Mathematically equal, leaf by leaf, to partPrepareWeight's own bottom-up
// recursion (app.js), so the two always agree.
export function collectIngredientsWithPrepareWeight(part, ancestorMultiplier = 1){
  const ownMultiplier = computePrepareWeight(ancestorMultiplier, part.prepYieldPct);
  const direct = partIngredients(part).map(ing => ({
    ing,
    prepareWt: computePrepareWeight(ing.weight, ing.prepYieldPct) * ownMultiplier
  }));
  const nested = partSubParts(part).flatMap(sub => collectIngredientsWithPrepareWeight(sub, ownMultiplier));
  return [...direct, ...nested];
}

// Finds a Part anywhere in the recipe's tree (including nested Sub-parts)
// by name -- used to look up what's actually inside a Process Step's
// Component when that Component is a whole Part added as one lump entry
// (see the "Add Component" picker's Parts group). Only ever a name match
// against CURRENT live data, not something recorded at the time the
// Component was added, since a Component only ever stores a name/weight/
// tolerance snapshot, not a reference back to the Part itself.
export function findPartByName(parts, name){
  for(const part of (parts || [])){
    if((part.name || '').trim() === name) return part;
    const found = findPartByName(partSubParts(part), name);
    if(found) return found;
  }
  return null;
}

// Scales every ingredient under a Part (including ones nested inside its
// Sub-parts) by the same factor, so weights change but every ratio between
// them — and so every %-of-parent at every level — doesn't.
export function scaleIngredientsInPart(part, factor){
  partIngredients(part).forEach(ing => { ing.weight = round4((parseFloat(ing.weight)||0) * factor); });
  partSubParts(part).forEach(sub => scaleIngredientsInPart(sub, factor));
}

// "Everything else at this Part's own level" — `siblingsArray` is the
// array `part` itself lives in (r.parts for top-level, or parentPart.items
// when nested). Used to back-solve a Part's weight from a typed %, the
// same way an ingredient's own % field already does one level down.
export function siblingsWeightExcluding(siblingsArray, part){
  return (siblingsArray || []).filter(p => p !== part).reduce((s,p)=>s+itemWeight(p),0);
}

// Dragging a Part onto itself, or onto one of its own Sub-parts, would
// nest it inside itself — an impossible/cyclic tree. Used to reject that
// drop before it happens (see renderPartNode's drag-handle wiring).
export function isPartOrDescendant(candidate, part){
  if(candidate === part) return true;
  return partSubParts(part).some(sub => isPartOrDescendant(candidate, sub));
}

// Every Part, at any depth, as one flat list — used by Process Steps'
// "Add Component" picker so a single flat <option> index can address a
// Part or ingredient at any nesting depth instead of needing a multi-level
// path. `label` is a breadcrumb ("Filling › Spicy Sauce") so a nested
// Sub-part or its ingredients still read unambiguously in the dropdown.
export function collectPartsFlat(parts, prefix){
  let out = [];
  (parts || []).forEach((part, idx) => {
    const label = prefix + (part.name || `Part ${idx+1}`);
    out.push({ part, label });
    out = out.concat(collectPartsFlat(partSubParts(part), label + ' › '));
  });
  return out;
}
export function collectIngredientsFlat(parts, prefix){
  let out = [];
  (parts || []).forEach((part, idx) => {
    const label = prefix + (part.name || `Part ${idx+1}`);
    partIngredients(part).filter(i => (i.name||'').trim() !== '').forEach(ing => {
      out.push({ ing, label: `${label} › ${ing.name}` });
    });
    out = out.concat(collectIngredientsFlat(partSubParts(part), label + ' › '));
  });
  return out;
}

export function round2(n){ return Math.round(n * 100) / 100; }
// Weight/% are stored at 4-decimal precision (screens still only ever
// SHOW 2 -- see setPrecisionField in recipes.js, which puts the fuller
// figure in the field's own hover tooltip) so rounding a value derived
// from many small ingredients doesn't lose real precision, and so
// rounding error doesn't compound across deeply nested Sub-parts the way
// it would rounding to 2 decimals at every level of the recursion.
// Math.round rounds half up, same as round2 -- both always deal in
// non-negative weights/percentages here, so there's no negative-number
// half-rounds-toward-zero edge case to account for.
export function round4(n){ return Math.round(n * 10000) / 10000; }

/* Read-only weight displays (totals/subtotals) get a thousands separator for
   readability at larger batch sizes — editable Weight (g) <input> fields
   stay plain numbers since type="number" inputs can't contain commas. */
export function formatWeight(n){
  return (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' g';
}

