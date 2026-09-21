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

export function blankPart(name){
  return { name, ingredients: [ { id: uid(), name:"", percent:0, weight:0, note:"" } ], parts: [] };
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
    portionWeightG: '',
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
    const oldIngredients = Array.isArray(r.ingredients) && r.ingredients.length ? r.ingredients : [{ id: uid(), name:"", percent:0, weight:0, note:"" }];
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
    // Same "never sits completely empty" safety net the drag-drop/delete
    // handlers already use elsewhere in this file -- but only when this
    // Part has no Sub-parts of its own to fall back on instead. Without
    // the p.parts check, a Part that legitimately holds only Sub-parts
    // (no direct ingredients of its own, e.g. a root Part that's just an
    // organizer for a couple of Sub-parts) got a phantom blank ingredient
    // row forced onto it on every single load.
    if((!Array.isArray(p.ingredients) || p.ingredients.length === 0) && !(Array.isArray(p.parts) && p.parts.length > 0)){
      p.ingredients = [{ id: uid(), name:"", percent:0, weight:0, note:"" }];
    } else if(!Array.isArray(p.ingredients)){
      p.ingredients = [];
    }
    p.ingredients.forEach(ing => {
      // Backfilled the same way Processes already get one above -- older
      // saved ingredients never had a stable id, which quietly broke the
      // Sub Ingredients panel's per-row expand/collapse state (it keys off
      // ing.id) and is now also needed to know whether a row's Yield came
      // from a picked library variant (see subIngredientId below).
      if(!ing.id) ing.id = uid();
    });
    const oldPartName = /^ส่วนที่ (\d+)$/.exec(p.name || '');
    if(oldPartName) p.name = `Part ${oldPartName[1]}`;
    if(!Array.isArray(p.parts)) p.parts = [];
    p.parts.forEach(migratePart);
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
  if(r.portionWeightG === undefined || r.portionWeightG === null) r.portionWeightG = '';
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
  if(r.seriesId){
    return `${r.countryCode || ''}${r.year || 'YY'}-${r.productTypeCode || 'XXX'}${r.recipeSeq || 'XX'}-T${trialNoDisplay(r.trialNo)}`;
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
export function recomputePartPercents(part){
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
export function partTotalWeight(part){
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
  const direct = (part.ingredients || []).map(ing => ({
    ing,
    prepareWt: computePrepareWeight(ing.weight, ing.prepYieldPct) * ownMultiplier
  }));
  const nested = (part.parts || []).flatMap(sub => collectIngredientsWithPrepareWeight(sub, ownMultiplier));
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
    const found = findPartByName(part.parts, name);
    if(found) return found;
  }
  return null;
}

// Scales every ingredient under a Part (including ones nested inside its
// Sub-parts) by the same factor, so weights change but every ratio between
// them — and so every %-of-parent at every level — doesn't.
export function scaleIngredientsInPart(part, factor){
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
export function siblingsWeightExcluding(siblingsCtx, part){
  const ingWeight = (siblingsCtx.ingredients || []).reduce((s,i)=>s+(parseFloat(i.weight)||0),0);
  const partsWeight = (siblingsCtx.parts || []).filter(p => p !== part).reduce((s,p)=>s+partTotalWeight(p),0);
  return ingWeight + partsWeight;
}

// Dragging a Part onto itself, or onto one of its own Sub-parts, would
// nest it inside itself — an impossible/cyclic tree. Used to reject that
// drop before it happens (see renderPartNode's drag-handle wiring).
export function isPartOrDescendant(candidate, part){
  if(candidate === part) return true;
  return (part.parts || []).some(sub => isPartOrDescendant(candidate, sub));
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
    out = out.concat(collectPartsFlat(part.parts, label + ' › '));
  });
  return out;
}
export function collectIngredientsFlat(parts, prefix){
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

export function round2(n){ return Math.round(n * 100) / 100; }

/* Read-only weight displays (totals/subtotals) get a thousands separator for
   readability at larger batch sizes — editable Weight (g) <input> fields
   stay plain numbers since type="number" inputs can't contain commas. */
export function formatWeight(n){
  return (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' g';
}

