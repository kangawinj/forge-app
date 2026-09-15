import {
  escapeHtml, icon, requestAuthConfirm,
  DELETE_APPROVER_EMAIL, approverProductsCol, logActivityEvent, currentUser, uid,
  diffMainFields, snapshotMainFields, playContentTransition, resizeImageFile,
  formatActivityDateTime, mainFeatureView, currentId, recipesLoaded, renderMain,
  productsCol, showCloudError, isCurrentUserAdmin, db, metaLists, metaItemName, autoGrowTextarea,
  FOOD_ALLERGEN_COLUMNS, moveToTrash
} from './app.js';
import {
  onSnapshot, setDoc, doc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export let productList = [];
let unsubscribeProducts = null;
let productsLoaded = false;
let editingProductId = null;
let editingRmImage = null; // staged photo as a data URL, or null for no photo
let editingIdeaMenuImage = null;

// Composition (Approx.) -- a table of rows instead of free text, per the
// user's request: each row is one composition item, optionally broken
// down into up to 2 further sub-ingredient levels (e.g. Main="Sauce Mix",
// Sub 1="Soy Sauce", Sub 2="Dark Soy Sauce", %=15), plus its own %. Staged
// in this array while the add/edit form is open, same "editing draft"
// pattern as editingRmImage/editingIdeaMenuImage above -- there's only
// ever one Product form on screen at a time (materials.js's "always-open
// single form" pattern), so one module-level array is enough.
let compositionRowsEditing = [];
function blankCompositionRow(){
  return { id: uid(), main: '', sub1: '', sub2: '', pct: '' };
}
// A product saved before Composition became a table has it as a plain
// string -- carried forward as a single row's Main Ingredient (with Sub
// 1/Sub 2/% left blank) rather than dropped, same treatment Sample
// Submissions' Docs and Projects' Certificate give their own
// pre-checklist/table values.
function getComposition(comp){
  if(Array.isArray(comp)){
    return comp.length ? comp.map(r => ({ id: r?.id || uid(), main: r?.main || '', sub1: r?.sub1 || '', sub2: r?.sub2 || '', pct: r?.pct ?? '' })) : [blankCompositionRow()];
  }
  if(typeof comp === 'string' && comp.trim()) return [{ id: uid(), main: comp, sub1: '', sub2: '', pct: '' }];
  return [blankCompositionRow()];
}
// Plain-text summary for the read-only detail modal.
function compositionSummaryText(comp){
  return getComposition(comp)
    .filter(r => r.main || r.sub1 || r.sub2 || r.pct !== '')
    .map(r => {
      const name = [r.main, r.sub1, r.sub2].filter(Boolean).join(' > ');
      return (r.pct !== '' && r.pct != null) ? `${name} ${r.pct}%` : name;
    })
    .join(', ');
}
function renderCompositionRows(){
  const body = document.getElementById('pf-compositionRows');
  if(!body) return;
  body.innerHTML = compositionRowsEditing.map(row => `
    <tr data-row-id="${escapeHtml(row.id)}">
      <td><input type="text" class="pf-comp-field" data-field="main" value="${escapeHtml(row.main)}" placeholder="e.g. Sauce Mix"></td>
      <td><input type="text" class="pf-comp-field" data-field="sub1" value="${escapeHtml(row.sub1)}" placeholder="e.g. Soy Sauce"></td>
      <td><input type="text" class="pf-comp-field" data-field="sub2" value="${escapeHtml(row.sub2)}" placeholder="optional"></td>
      <td><input type="number" class="pf-comp-field" data-field="pct" value="${escapeHtml(row.pct)}" min="0" max="100" step="any" placeholder="%"></td>
      <td>${compositionRowsEditing.length > 1 ? `<button type="button" class="icon-btn" data-role="remove-composition-row" title="Remove this row">${icon('x')}</button>` : ''}</td>
    </tr>
  `).join('');
  body.querySelectorAll('.pf-comp-field').forEach(el => {
    el.addEventListener('change', () => {
      const row = compositionRowsEditing.find(r => r.id === el.closest('tr').dataset.rowId);
      if(row) row[el.dataset.field] = el.value.trim();
    });
  });
  body.querySelectorAll('[data-role="remove-composition-row"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const rowId = btn.closest('tr').dataset.rowId;
      compositionRowsEditing = compositionRowsEditing.filter(r => r.id !== rowId);
      if(!compositionRowsEditing.length) compositionRowsEditing = [blankCompositionRow()];
      renderCompositionRows();
    });
  });
}

// Allergens -- a search + multi-tick picker sourced from the Food
// Allergens reference chart's 25 categories (see FOOD_ALLERGEN_COLUMNS
// in reflists.js), plus free text for anything not on that list. Kept
// as a comma-joined string on save -- the same shape this field always
// saved as, so nothing downstream that reads p.allergens as plain text
// (Sample Submissions' spec table, the product detail view) needs to
// change. Staged the same "editing draft" way as compositionRowsEditing.
let allergensEditing = [];
function getAllergens(allergens){
  if(Array.isArray(allergens)) return allergens.filter(Boolean);
  if(typeof allergens === 'string' && allergens.trim()) return allergens.split(',').map(a => a.trim()).filter(Boolean);
  return [];
}
function renderAllergenChips(){
  const wrap = document.getElementById('pf-allergenChips');
  if(!wrap) return;
  wrap.innerHTML = allergensEditing.map((a, idx) => `
    <span class="pf-allergen-chip">${escapeHtml(a)}<button type="button" class="pf-allergen-chip-remove" data-idx="${idx}" title="Remove">${icon('x', 12)}</button></span>
  `).join('');
  wrap.querySelectorAll('.pf-allergen-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      allergensEditing.splice(parseInt(btn.dataset.idx, 10), 1);
      renderAllergenChips();
    });
  });
}
function addAllergen(name){
  const v = (name || '').trim();
  if(!v || allergensEditing.some(a => a.toLowerCase() === v.toLowerCase())) return;
  allergensEditing.push(v);
  renderAllergenChips();
}
// Suggestions are the 25 reference categories that match what's typed
// (or all of them, focused with nothing typed yet) and aren't already
// picked -- clicking one adds it without closing the field, so several
// can be ticked in a row.
function renderAllergenSuggestions(query){
  const box = document.getElementById('pf-allergenSuggestions');
  if(!box) return;
  const q = (query || '').trim().toLowerCase();
  const matches = FOOD_ALLERGEN_COLUMNS.filter(c =>
    !allergensEditing.some(a => a.toLowerCase() === c.toLowerCase()) &&
    (!q || c.toLowerCase().includes(q))
  ).slice(0, 8);
  if(!matches.length){ box.hidden = true; box.innerHTML = ''; return; }
  box.innerHTML = matches.map(c => `<button type="button" class="pf-allergen-suggestion" data-name="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('');
  box.hidden = false;
  box.querySelectorAll('.pf-allergen-suggestion').forEach(btn => {
    btn.addEventListener('mousedown', e => {
      // preventDefault keeps focus in the search input instead of letting
      // it blur first, which would hide this dropdown before the click lands.
      e.preventDefault();
      addAllergen(btn.dataset.name);
      document.getElementById('pf-allergenSearch').value = '';
      renderAllergenSuggestions('');
    });
  });
}
// The suggestions box only reliably closes on blur when focus actually
// moves to another focusable element -- scrolling the page doesn't blur
// the search input, so without this a still-open dropdown stays pinned in
// place (position:absolute tracks the page, not the viewport) and ends up
// overlapping whatever the user scrolled down to see. Registered once at
// module load, same "global delegated listener" shape as app.js's
// autoGrowTextarea input listener, rather than re-added on every mount.
window.addEventListener('scroll', () => {
  const box = document.getElementById('pf-allergenSuggestions');
  if(box && !box.hidden) box.hidden = true;
}, { passive: true, capture: true });
// Belt-and-suspenders alongside the scroll listener above: closes it on a
// click anywhere outside the picker too, independent of scroll mechanics.
// Capture phase, and deliberately BEFORE any bubble-phase handler on the
// clicked element runs -- a suggestion button's own mousedown handler
// replaces box.innerHTML (to re-render with that item now picked), which
// detaches the clicked button and breaks its .closest() chain; checking
// in capture phase (top-down, ahead of the target's own bubble-phase
// handler) reads the still-attached DOM instead of a torn-down one.
document.addEventListener('mousedown', e => {
  if(e.target.closest('.pf-allergen-picker')) return;
  const box = document.getElementById('pf-allergenSuggestions');
  if(box && !box.hidden) box.hidden = true;
}, true);

const PRODUCT_FORM_FIELD_IDS = [
  'pf-name', 'pf-sampleCode', 'pf-productType', 'pf-ideaMenuName', 'pf-description',
  'pf-cookingInstruction', 'pf-processedArea',
  'pf-factory', 'pf-size', 'pf-packingStyle', 'pf-moq', 'pf-exwPrice', 'pf-salesPrice', 'pf-remarks'
];
// composition is deliberately not in PRODUCT_DIFF_FIELDS -- it's a
// structured array of rows now (see getComposition below), and
// diffMainFields' generic String(before) !== String(after) comparison
// would just show "[object Object]" for it, same reasoning as Sample
// Submissions leaving its own checklist-shaped docs field out of its diff.
const PRODUCT_DIFF_FIELDS = {
  name: 'Product Name', sampleCode: 'Sample Code', productType: 'Product Type',
  ideaMenuName: 'Product (Idea Menu)', description: 'Description', cookingInstruction: 'Cooking Instruction',
  allergens: 'Allergens', processedArea: 'Processed Area', factory: 'Factory',
  size: 'Size', packingStyle: 'Standards/Packing Style', moq: 'MOQ', exwPrice: 'EXW Price (THB)',
  salesPrice: 'Sales Price', remarks: 'Remarks'
};
let productEditSnapshotBefore = null;

/* Product's own display code (e.g. "PD01") -- frozen on the doc at
   creation, never recomputed later, so it stays stable even after other
   products are added/removed (same reasoning as a Recipe's own recipeSeq).
   Non-atomic (reads the in-memory count, no transaction) -- same accepted
   race as suggestNextRecipeSeq elsewhere in this app; this is an
   admin-curated list, not a high-concurrency one. */
function nextProductCode(){
  let max = 0;
  productList.forEach(p => {
    const match = /^PD(\d+)$/.exec(p.code || '');
    if(match) max = Math.max(max, parseInt(match[1], 10));
  });
  return 'PD' + String(max + 1).padStart(2, '0');
}

export function productLabel(p){
  return p.code ? `${p.code} — ${p.name}` : (p.name || 'Untitled product');
}

function saveProductToCloud(p){
  return setDoc(doc(productsCol, p.id), p);
}

export function attachProductsListener(){
  unsubscribeProducts = onSnapshot(productsCol, snapshot => {
    productList = snapshot.docs.map(d => d.data());
    productsLoaded = true;
    if(mainFeatureView === 'productList') renderProductTable();
    if(!currentId && !mainFeatureView && recipesLoaded) renderMain();
  }, err => {
    console.error('Forge: products listener error', err);
    showCloudError('Failed to load the product list from Firebase: ' + err.message);
  });
}

export function renderProductTable(){
  const body = document.getElementById('productTableBody');
  if(!body) return;
  const q = (document.getElementById('productSearchInput').value || '').trim().toLowerCase();
  const filtered = productList.filter(p => {
    if(!q) return true;
    return [p.code, p.name, p.sampleCode, p.productType, p.factory, p.ideaMenuName]
      .some(v => (v || '').toLowerCase().includes(q));
  });
  // Most recently added first, same reasoning as the Ingredient Library
  // (ids are "r" + a base36 timestamp + random suffix, so sorting ids
  // descending sorts by creation time).
  filtered.sort((a, b) => (b.id || '').localeCompare(a.id || ''));

  if(filtered.length === 0){
    body.innerHTML = `<tr><td colspan="8"><div class="material-empty">${productList.length === 0 ? 'No products in the list yet — add the first one above' : 'No matching products found'}</div></td></tr>`;
    return;
  }

  body.innerHTML = filtered.map(p => `
    <tr data-view-product="${escapeHtml(p.id)}">
      <td>${p.rmImage ? `<img src="${escapeHtml(p.rmImage)}" class="material-thumb" alt="${escapeHtml(p.name)}">` : '<div class="material-thumb material-thumb-empty"></div>'}</td>
      <td>${escapeHtml(p.code || '-')}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.sampleCode || '-')}</td>
      <td>${escapeHtml(p.productType || '-')}</td>
      <td>${escapeHtml(p.factory || '-')}</td>
      <td>${p.exwPrice !== '' && p.exwPrice != null ? '฿' + escapeHtml(String(p.exwPrice)) : '-'}</td>
      <td>
        <button class="icon-btn" data-edit-product="${escapeHtml(p.id)}" title="Edit this product">${icon('pencil')}</button>
        <button class="icon-btn" data-copy-product="${escapeHtml(p.id)}" title="Copy as a new product">${icon('copy')}</button>
        <button class="icon-btn" data-del-product="${escapeHtml(p.id)}" title="Remove this product from the list">${icon('x')}</button>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-edit-product]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-edit-product');
      const p = productList.find(x => x.id === id);
      if(p) startEditProduct(p);
    });
  });
  body.querySelectorAll('[data-copy-product]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-copy-product');
      const p = productList.find(x => x.id === id);
      if(p) startCopyProduct(p);
    });
  });
  body.querySelectorAll('[data-del-product]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-del-product');
      const p = productList.find(x => x.id === id);
      if(!p) return;
      if(!confirm(`Permanently remove "${productLabel(p)}" from the product list?`)) return;
      requestAuthConfirm(
        'Confirm Deletion',
        `Enter the approver's email and password to permanently remove "${productLabel(p)}" from the product list`,
        () => {},
        {
          requireEmail: DELETE_APPROVER_EMAIL,
          approverAction: () => moveToTrash('productList', id, p, productLabel(p))
            .then(() => deleteDoc(doc(approverProductsCol, id)))
            .then(() => logActivityEvent('deleted', 'product', productLabel(p)))
        }
      );
    });
  });
  body.querySelectorAll('[data-view-product]').forEach(tr => {
    tr.addEventListener('click', e => {
      if(e.target.closest('button')) return; // let edit/copy/delete handle their own click
      const id = tr.getAttribute('data-view-product');
      const p = productList.find(x => x.id === id);
      if(p) openProductDetail(p);
    });
  });
}

export function mountProductsView(){
  const main = document.getElementById('mainArea');
  main.classList.remove('main-wide');
  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('package', 24)} Product List</div>
    </div>
    <div class="card">
      <div class="material-add-form">
        <div class="card-title" id="productFormTitle" style="font-size:13px;margin-bottom:10px;">+ Add New Product</div>
        <div class="grid-3">
          <div class="field">
            <label>1. Product Name*</label>
            <input type="text" id="pf-name" placeholder="e.g. Tom Yum Goong (Shrimp)">
          </div>
          <div class="field">
            <label>2. Sample Code</label>
            <input type="text" id="pf-sampleCode" placeholder="e.g. BVC26-N087/375-01">
          </div>
          <div class="field">
            <label>3. Product Type</label>
            <input type="text" id="pf-productType" list="productListTypeDatalist" placeholder="e.g. Existing Product">
          </div>
        </div>
        <div class="grid-3">
          <div class="field">
            <label>4. Product (Idea Menu)</label>
            <input type="text" id="pf-ideaMenuName" placeholder="e.g. Appetizer">
          </div>
          <div class="field">
            <label>5. Processed Area</label>
            <input type="text" id="pf-processedArea" list="worldCountriesDatalist" placeholder="e.g. Thailand">
          </div>
          <div class="field">
            <label>6. Factory</label>
            <input type="text" id="pf-factory" list="customerDatalist" placeholder="e.g. KF Food">
          </div>
        </div>
        <div class="grid-3">
          <div class="field">
            <label>7. Size</label>
            <input type="text" id="pf-size" placeholder="e.g. 160g/bag">
          </div>
          <div class="field">
            <label>8. Standards/Packing Style</label>
            <input type="text" id="pf-packingStyle" placeholder="e.g. 160g./bag x 36bags/carton">
          </div>
          <div class="field">
            <label>9. MOQ</label>
            <input type="text" id="pf-moq" placeholder="e.g. about 200ctn">
          </div>
        </div>
        <div class="grid-3">
          <div class="field">
            <label>10. EXW Price (THB)</label>
            <input type="number" id="pf-exwPrice" min="0" step="0.01" placeholder="0.00">
          </div>
          <div class="field">
            <label>11. Sales Price</label>
            <input type="text" id="pf-salesPrice" placeholder="e.g. 120">
          </div>
        </div>
        <div class="grid-2-photos">
          <div class="field">
            <label>12. Photo — Raw Material (optional)</label>
            <input type="file" id="pf-rmImage" accept="image/*">
            <div class="material-photo-preview-row">
              <img id="pf-rmImagePreview" style="display:none;width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--border);">
              <button type="button" class="btn btn-sm" id="btnRemoveRmImage" style="display:none;">Remove photo</button>
            </div>
          </div>
          <div class="field">
            <label>13. Photo — Idea Menu (optional)</label>
            <input type="file" id="pf-ideaMenuImage" accept="image/*">
            <div class="material-photo-preview-row">
              <img id="pf-ideaMenuImagePreview" style="display:none;width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--border);">
              <button type="button" class="btn btn-sm" id="btnRemoveIdeaMenuImage" style="display:none;">Remove photo</button>
            </div>
          </div>
        </div>
        <div class="field">
          <label>14. Description</label>
          <textarea id="pf-description" rows="2" placeholder="e.g. A classic Thai hot and sour soup with succulent shrimp..."></textarea>
        </div>
        <div class="field">
          <label>15. Cooking Instruction</label>
          <input type="text" id="pf-cookingMethodPick" list="cookingMethodDatalist" placeholder="Pick a Cooking Method (Reference Lists) to fill in its Steps below" style="margin-bottom:6px;">
          <textarea id="pf-cookingInstruction" rows="2" placeholder="e.g. ต้มในน้ำเดือด 10-15 นาที โดยไม่ต้องละลายสินค้า"></textarea>
        </div>
        <div class="field">
          <label>16. Composition (Approx.)</label>
          <div style="overflow-x:auto;">
            <table class="compare-table pf-composition-table">
              <thead><tr><th>Main Ingredient</th><th>Sub 1</th><th>Sub 2</th><th>%</th><th></th></tr></thead>
              <tbody id="pf-compositionRows"></tbody>
            </table>
          </div>
          <button type="button" class="btn btn-sm add-row-btn" id="btnAddCompositionRow" style="margin-top:6px;">+ Add Row</button>
        </div>
        <div class="field">
          <label>17. Allergens</label>
          <div class="pf-allergen-picker">
            <div class="pf-allergen-chips" id="pf-allergenChips"></div>
            <input type="text" id="pf-allergenSearch" placeholder="Search allergens (e.g. Shrimp, Wheat, Soy) or type your own and press Enter" autocomplete="off">
            <div class="pf-allergen-suggestions" id="pf-allergenSuggestions" hidden></div>
          </div>
        </div>
        <div class="field">
          <label>18. Remarks</label>
          <textarea id="pf-remarks" rows="2" placeholder="Anything else worth noting"></textarea>
        </div>
        <button class="btn btn-primary btn-sm" id="btnAddProduct">+ Add to Product List</button>
        <button class="btn btn-sm" id="btnCancelEditProduct" style="display:none;">Cancel</button>
        <span class="ing-hint" id="productFormError"></span>
      </div>

      ${isCurrentUserAdmin() ? `
      <div style="margin-bottom:12px;">
        <button type="button" class="btn btn-sm" id="btnImportLegacyProducts">${icon('upload', 14)} Import Legacy Product List (one-time)</button>
        <span id="productImportStatus" class="ing-hint"></span>
      </div>
      ` : ''}
      <div class="material-search">
        <input type="text" id="productSearchInput" placeholder="Search products (name / code / sample code / type / factory)...">
      </div>
      <div style="overflow-x:auto;">
        <table class="material-table">
          <thead>
            <tr>
              <th>Photo</th>
              <th>No.</th>
              <th>Product Name</th>
              <th>Sample Code</th>
              <th>Type</th>
              <th>Factory</th>
              <th>EXW Price (฿)</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="productTableBody"></tbody>
        </table>
      </div>
    </div>
    <datalist id="productListTypeDatalist">
      <option value="Existing Product">
      <option value="New Development">
    </datalist>
  `;

  document.getElementById('productSearchInput').addEventListener('input', renderProductTable);
  document.getElementById('btnCancelEditProduct').addEventListener('click', cancelEditProduct);
  document.getElementById('btnImportLegacyProducts')?.addEventListener('click', importLegacyProducts);
  document.getElementById('btnAddCompositionRow').addEventListener('click', () => {
    compositionRowsEditing.push(blankCompositionRow());
    renderCompositionRows();
  });
  // Cooking Method quick-fill -- picking a method that has Steps on file
  // (Reference Lists) fills them into Cooking Instruction as a starting
  // point, same idea as Projects' Cooking Guidelines autofill. It's just a
  // one-shot helper, not a saved field, so it's not in
  // PRODUCT_FORM_FIELD_IDS/PRODUCT_DIFF_FIELDS -- cancelEditProduct clears
  // it manually instead.
  document.getElementById('pf-cookingMethodPick').addEventListener('change', e => {
    const picked = e.target.value.trim();
    const match = metaLists.cookingMethods.find(m => metaItemName(m) === picked);
    if(match && (match.steps || []).length){
      const instrEl = document.getElementById('pf-cookingInstruction');
      instrEl.value = match.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
      // Setting .value directly doesn't fire 'input', so it wouldn't
      // trigger the app-wide autoGrowTextarea listener on its own -- grow
      // it explicitly instead of leaving the filled-in Steps clipped to
      // the textarea's default 2 rows.
      autoGrowTextarea(instrEl);
    }
  });
  const allergenSearch = document.getElementById('pf-allergenSearch');
  allergenSearch.addEventListener('input', () => renderAllergenSuggestions(allergenSearch.value));
  allergenSearch.addEventListener('focus', () => renderAllergenSuggestions(allergenSearch.value));
  allergenSearch.addEventListener('blur', () => {
    // Delayed so a suggestion's own mousedown (which already preventDefault
    // stops the blur that would otherwise race it) still has a moment to
    // register as a click before this hides the dropdown.
    setTimeout(() => { document.getElementById('pf-allergenSuggestions').hidden = true; }, 150);
  });
  allergenSearch.addEventListener('keydown', e => {
    if(e.key === 'Enter'){
      e.preventDefault();
      addAllergen(allergenSearch.value);
      allergenSearch.value = '';
      renderAllergenSuggestions('');
    }
  });
  document.getElementById('pf-rmImage').addEventListener('change', async e => {
    const file = e.target.files[0];
    if(!file) return;
    const errEl = document.getElementById('productFormError');
    try{
      setProductImagePreview('rm', await resizeImageFile(file, 600));
      errEl.textContent = '';
    }catch(err){
      errEl.textContent = err.message || 'Could not read that image file';
    }
  });
  document.getElementById('btnRemoveRmImage').addEventListener('click', () => {
    document.getElementById('pf-rmImage').value = '';
    setProductImagePreview('rm', null);
  });
  document.getElementById('pf-ideaMenuImage').addEventListener('change', async e => {
    const file = e.target.files[0];
    if(!file) return;
    const errEl = document.getElementById('productFormError');
    try{
      setProductImagePreview('ideaMenu', await resizeImageFile(file, 600));
      errEl.textContent = '';
    }catch(err){
      errEl.textContent = err.message || 'Could not read that image file';
    }
  });
  document.getElementById('btnRemoveIdeaMenuImage').addEventListener('click', () => {
    document.getElementById('pf-ideaMenuImage').value = '';
    setProductImagePreview('ideaMenu', null);
  });
  document.getElementById('btnAddProduct').addEventListener('click', () => {
    const name = document.getElementById('pf-name').value.trim();
    const errEl = document.getElementById('productFormError');
    if(!name){
      errEl.textContent = 'Please enter the product name';
      return;
    }
    errEl.textContent = '';
    const existing = editingProductId ? productList.find(p => p.id === editingProductId) : null;
    const productAfter = {
      id: editingProductId || uid(),
      code: existing?.code || nextProductCode(),
      name,
      sampleCode: document.getElementById('pf-sampleCode').value.trim(),
      productType: document.getElementById('pf-productType').value.trim(),
      ideaMenuName: document.getElementById('pf-ideaMenuName').value.trim(),
      description: document.getElementById('pf-description').value.trim(),
      cookingInstruction: document.getElementById('pf-cookingInstruction').value.trim(),
      composition: compositionRowsEditing
        .filter(r => r.main || r.sub1 || r.sub2 || r.pct !== '')
        .map(r => ({ main: r.main, sub1: r.sub1, sub2: r.sub2, pct: r.pct })),
      allergens: allergensEditing.join(', '),
      processedArea: document.getElementById('pf-processedArea').value.trim(),
      factory: document.getElementById('pf-factory').value.trim(),
      size: document.getElementById('pf-size').value.trim(),
      packingStyle: document.getElementById('pf-packingStyle').value.trim(),
      moq: document.getElementById('pf-moq').value.trim(),
      exwPrice: document.getElementById('pf-exwPrice').value.trim(),
      salesPrice: document.getElementById('pf-salesPrice').value.trim(),
      remarks: document.getElementById('pf-remarks').value.trim(),
      rmImage: editingRmImage || '',
      ideaMenuImage: editingIdeaMenuImage || '',
      createdBy: existing?.createdBy || currentUser?.email || '',
      createdAt: existing?.createdAt || Date.now(),
      updatedBy: currentUser?.email || '',
      updatedAt: Date.now()
    };
    saveProductToCloud(productAfter);
    logActivityEvent(existing ? 'updated' : 'created', 'product', productLabel(productAfter), existing ? diffMainFields(productEditSnapshotBefore, productAfter, PRODUCT_DIFF_FIELDS) : []);
    cancelEditProduct();
  });

  cancelEditProduct();
  renderProductTable();
  playContentTransition(main);
}

// One-time admin tool: seeds the product list from the user's original
// "UMIOS Product List & Information" reference spreadsheet (~40 real
// products with photos, extracted and pre-resized offline into
// products-import.json, deployed alongside the app as a temporary asset
// and deleted once the import is confirmed). Each imported doc gets a
// stable id derived from its own "PD01"-style code (not uid()) so
// re-clicking this button is always safe -- already-imported products are
// just overwritten with the same data instead of duplicating.
async function importLegacyProducts(){
  const statusEl = document.getElementById('productImportStatus');
  const btn = document.getElementById('btnImportLegacyProducts');
  statusEl.textContent = 'Loading products-import.json...';
  let items;
  try{
    const res = await fetch('./products-import.json');
    if(!res.ok) throw new Error('HTTP ' + res.status);
    items = await res.json();
  }catch(err){
    statusEl.textContent = 'products-import.json not found (already removed, or this is a fresh checkout) — nothing to import.';
    return;
  }
  if(!Array.isArray(items) || !items.length){
    statusEl.textContent = 'products-import.json has no rows.';
    return;
  }
  if(!confirm(`Import ${items.length} legacy products (with photos) into the Product List? Safe to run more than once -- already-imported products are just overwritten, never duplicated.`)) return;
  btn.disabled = true;
  statusEl.textContent = `Importing ${items.length} products...`;
  const now = Date.now();
  const batch = writeBatch(db);
  items.forEach(item => {
    const id = 'legacy-' + (item.code || uid());
    batch.set(doc(productsCol, id), {
      ...item,
      id,
      createdBy: currentUser?.email || '',
      createdAt: now,
      updatedBy: currentUser?.email || '',
      updatedAt: now
    });
  });
  try{
    await batch.commit();
    logActivityEvent('created', 'product', `Imported ${items.length} legacy products`);
    statusEl.textContent = `Done — imported ${items.length} products.`;
  }catch(err){
    console.error('Forge: legacy product import failed', err);
    statusEl.textContent = 'Import failed: ' + err.message;
  }
  btn.disabled = false;
}

export function openProductDetail(p){
  const body = document.getElementById('productDetailBody');
  const rows = [
    ['Sample Code', p.sampleCode],
    ['Product Type', p.productType],
    ['Product (Idea Menu)', p.ideaMenuName],
    ['Processed Area', p.processedArea],
    ['Factory', p.factory],
    ['Size', p.size],
    ['Standards/Packing Style', p.packingStyle],
    ['MOQ', p.moq],
    ['EXW Price (THB)', p.exwPrice !== '' && p.exwPrice != null ? `฿${p.exwPrice}` : ''],
    ['Sales Price', p.salesPrice],
    ['Allergens', p.allergens]
  ].map(([label, value]) => `
    <dt>${escapeHtml(label)}</dt>
    <dd>${escapeHtml(value || '-')}</dd>
  `).join('');

  const notesBlock = (label, value) => value ? `
    <div class="material-detail-notes-label">${escapeHtml(label)}</div>
    <div class="material-detail-notes">${escapeHtml(value)}</div>
  ` : '';

  body.innerHTML = `
    <div class="product-detail-photos">
      <div class="material-detail-photo">
        ${p.rmImage ? `<img src="${escapeHtml(p.rmImage)}" alt="${escapeHtml(p.name)} - RM">` : '<div class="material-detail-photo-empty"></div>'}
      </div>
      <div class="material-detail-photo">
        ${p.ideaMenuImage ? `<img src="${escapeHtml(p.ideaMenuImage)}" alt="${escapeHtml(p.name)} - Idea Menu">` : '<div class="material-detail-photo-empty"></div>'}
      </div>
    </div>
    <div class="material-detail-title">${escapeHtml(p.code || '')} ${escapeHtml(p.name)}</div>
    <dl class="material-detail-list">${rows}</dl>
    ${notesBlock('Description', p.description)}
    ${notesBlock('Cooking Instruction', p.cookingInstruction)}
    ${notesBlock('Composition (Approx.)', compositionSummaryText(p.composition))}
    ${notesBlock('Remarks', p.remarks)}
    <div class="material-detail-activity">
      ${p.createdBy ? `<div>Created by ${escapeHtml(p.createdBy)}${p.createdAt ? ' · ' + escapeHtml(formatActivityDateTime(p.createdAt)) : ''}</div>` : ''}
      ${p.updatedBy ? `<div>Last edited by ${escapeHtml(p.updatedBy)}${p.updatedAt ? ' · ' + escapeHtml(formatActivityDateTime(p.updatedAt)) : ''}</div>` : ''}
    </div>
  `;
  document.getElementById('productDetailModalOverlay').classList.add('open');
}

export function closeProductDetail(){
  document.getElementById('productDetailModalOverlay').classList.remove('open');
}

function setProductImagePreview(which, dataUrl){
  const img = document.getElementById(which === 'rm' ? 'pf-rmImagePreview' : 'pf-ideaMenuImagePreview');
  const removeBtn = document.getElementById(which === 'rm' ? 'btnRemoveRmImage' : 'btnRemoveIdeaMenuImage');
  if(which === 'rm') editingRmImage = dataUrl || null;
  else editingIdeaMenuImage = dataUrl || null;
  if(dataUrl){
    img.src = dataUrl;
    img.style.display = 'block';
    removeBtn.style.display = 'inline-flex';
  } else {
    img.src = '';
    img.style.display = 'none';
    removeBtn.style.display = 'none';
  }
}

function fillProductForm(p){
  document.getElementById('pf-cookingMethodPick').value = '';
  document.getElementById('pf-name').value = p.name || '';
  document.getElementById('pf-sampleCode').value = p.sampleCode || '';
  document.getElementById('pf-productType').value = p.productType || '';
  document.getElementById('pf-ideaMenuName').value = p.ideaMenuName || '';
  document.getElementById('pf-description').value = p.description || '';
  document.getElementById('pf-cookingInstruction').value = p.cookingInstruction || '';
  compositionRowsEditing = getComposition(p.composition);
  renderCompositionRows();
  allergensEditing = getAllergens(p.allergens);
  renderAllergenChips();
  document.getElementById('pf-allergenSearch').value = '';
  renderAllergenSuggestions('');
  document.getElementById('pf-processedArea').value = p.processedArea || '';
  document.getElementById('pf-factory').value = p.factory || '';
  document.getElementById('pf-size').value = p.size || '';
  document.getElementById('pf-packingStyle').value = p.packingStyle || '';
  document.getElementById('pf-moq').value = p.moq || '';
  document.getElementById('pf-exwPrice').value = p.exwPrice || '';
  document.getElementById('pf-salesPrice').value = p.salesPrice || '';
  document.getElementById('pf-remarks').value = p.remarks || '';
  document.getElementById('pf-rmImage').value = '';
  document.getElementById('pf-ideaMenuImage').value = '';
  setProductImagePreview('rm', p.rmImage || null);
  setProductImagePreview('ideaMenu', p.ideaMenuImage || null);
  // Setting .value directly above doesn't fire 'input', so it wouldn't
  // trigger the app-wide autoGrowTextarea listener on its own -- grow
  // each textarea explicitly so a long saved value isn't clipped to its
  // default 2 rows when editing an existing product.
  ['pf-description', 'pf-cookingInstruction', 'pf-remarks'].forEach(id => autoGrowTextarea(document.getElementById(id)));
}

function startEditProduct(p){
  editingProductId = p.id;
  productEditSnapshotBefore = snapshotMainFields(p, PRODUCT_DIFF_FIELDS);
  fillProductForm(p);
  document.getElementById('productFormTitle').innerHTML = `${icon('pencil')} Editing: ${escapeHtml(productLabel(p))}`;
  document.getElementById('btnAddProduct').textContent = 'Save Changes';
  document.getElementById('btnCancelEditProduct').style.display = 'inline-flex';
  document.getElementById('productFormError').textContent = '';
  document.getElementById('pf-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('pf-name').focus();
}

function startCopyProduct(p){
  editingProductId = null;
  fillProductForm(p);
  document.getElementById('pf-sampleCode').value = '';
  document.getElementById('productFormTitle').innerHTML = `${icon('copy')} Copy of "${escapeHtml(productLabel(p))}" — review and add as new`;
  document.getElementById('btnAddProduct').textContent = '+ Add to Product List';
  document.getElementById('btnCancelEditProduct').style.display = 'inline-flex';
  document.getElementById('productFormError').textContent = '';
  document.getElementById('pf-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('pf-name').focus();
}

function cancelEditProduct(){
  editingProductId = null;
  productEditSnapshotBefore = null;
  PRODUCT_FORM_FIELD_IDS.forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('pf-cookingMethodPick').value = '';
  compositionRowsEditing = [blankCompositionRow()];
  renderCompositionRows();
  allergensEditing = [];
  renderAllergenChips();
  document.getElementById('pf-allergenSearch').value = '';
  renderAllergenSuggestions('');
  document.getElementById('pf-rmImage').value = '';
  document.getElementById('pf-ideaMenuImage').value = '';
  setProductImagePreview('rm', null);
  setProductImagePreview('ideaMenu', null);
  document.getElementById('productFormTitle').textContent = '+ Add New Product';
  document.getElementById('btnAddProduct').textContent = '+ Add to Product List';
  document.getElementById('btnCancelEditProduct').style.display = 'none';
  document.getElementById('productFormError').textContent = '';
}

// Tears down the products Firestore listener and resets all Product List
// state to empty — called from the shared sign-out handler in app.js, same
// pattern as resetMaterialsState.
export function resetProductsState(){
  if(unsubscribeProducts){ unsubscribeProducts(); unsubscribeProducts = null; }
  productsLoaded = false;
  productList = [];
}

export { unsubscribeProducts, compositionSummaryText };
