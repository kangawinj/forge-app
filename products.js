import {
  escapeHtml, icon, requestAuthConfirm,
  DELETE_APPROVER_EMAIL, approverProductsCol, logActivityEvent, currentUser, uid,
  diffMainFields, snapshotMainFields, playContentTransition, resizeImageFile,
  formatActivityDateTime, mainFeatureView, currentId, recipesLoaded, renderMain,
  productsCol, showCloudError
} from './app.js';
import {
  onSnapshot, setDoc, doc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export let productList = [];
let unsubscribeProducts = null;
let productsLoaded = false;
let editingProductId = null;
let editingRmImage = null; // staged photo as a data URL, or null for no photo
let editingIdeaMenuImage = null;

const PRODUCT_FORM_FIELD_IDS = [
  'pf-name', 'pf-sampleCode', 'pf-productType', 'pf-ideaMenuName', 'pf-description',
  'pf-cookingInstruction', 'pf-composition', 'pf-allergens', 'pf-processedArea',
  'pf-factory', 'pf-size', 'pf-packingStyle', 'pf-moq', 'pf-exwPrice', 'pf-salesPrice', 'pf-remarks'
];
const PRODUCT_DIFF_FIELDS = {
  name: 'Product Name', sampleCode: 'Sample Code', productType: 'Product Type',
  ideaMenuName: 'Product (Idea Menu)', description: 'Description', cookingInstruction: 'Cooking Instruction',
  composition: 'Composition', allergens: 'Allergens', processedArea: 'Processed Area', factory: 'Factory',
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
          approverAction: () => deleteDoc(doc(approverProductsCol, id))
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
            <input type="text" id="pf-processedArea" placeholder="e.g. Thailand">
          </div>
          <div class="field">
            <label>6. Factory</label>
            <input type="text" id="pf-factory" list="productListFactoryDatalist" placeholder="e.g. KF Food">
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
          <div class="field">
            <label>12. Allergens</label>
            <input type="text" id="pf-allergens" placeholder="e.g. Shrimp, Wheat, Soy bean">
          </div>
        </div>
        <div class="grid-2-photos">
          <div class="field">
            <label>13. Photo — Raw Material (optional)</label>
            <input type="file" id="pf-rmImage" accept="image/*">
            <div class="material-photo-preview-row">
              <img id="pf-rmImagePreview" style="display:none;width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--border);">
              <button type="button" class="btn btn-sm" id="btnRemoveRmImage" style="display:none;">Remove photo</button>
            </div>
          </div>
          <div class="field">
            <label>14. Photo — Idea Menu (optional)</label>
            <input type="file" id="pf-ideaMenuImage" accept="image/*">
            <div class="material-photo-preview-row">
              <img id="pf-ideaMenuImagePreview" style="display:none;width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--border);">
              <button type="button" class="btn btn-sm" id="btnRemoveIdeaMenuImage" style="display:none;">Remove photo</button>
            </div>
          </div>
        </div>
        <div class="field">
          <label>15. Description</label>
          <textarea id="pf-description" rows="2" placeholder="e.g. A classic Thai hot and sour soup with succulent shrimp..."></textarea>
        </div>
        <div class="field">
          <label>16. Cooking Instruction</label>
          <textarea id="pf-cookingInstruction" rows="2" placeholder="e.g. Update: 20260430 BAZZ"></textarea>
        </div>
        <div class="field">
          <label>17. Composition (Approx.)</label>
          <textarea id="pf-composition" rows="2" placeholder="Approximate composition breakdown"></textarea>
        </div>
        <div class="field">
          <label>18. Remarks</label>
          <textarea id="pf-remarks" rows="2" placeholder="Anything else worth noting"></textarea>
        </div>
        <button class="btn btn-primary btn-sm" id="btnAddProduct">+ Add to Product List</button>
        <button class="btn btn-sm" id="btnCancelEditProduct" style="display:none;">Cancel</button>
        <span class="ing-hint" id="productFormError"></span>
      </div>

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
    <datalist id="productListFactoryDatalist">
      ${[...new Set(productList.map(p => p.factory).filter(Boolean))].map(f => `<option value="${escapeHtml(f)}">`).join('')}
    </datalist>
  `;

  document.getElementById('productSearchInput').addEventListener('input', renderProductTable);
  document.getElementById('btnCancelEditProduct').addEventListener('click', cancelEditProduct);
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
      composition: document.getElementById('pf-composition').value.trim(),
      allergens: document.getElementById('pf-allergens').value.trim(),
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
    ${notesBlock('Composition (Approx.)', p.composition)}
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
  document.getElementById('pf-name').value = p.name || '';
  document.getElementById('pf-sampleCode').value = p.sampleCode || '';
  document.getElementById('pf-productType').value = p.productType || '';
  document.getElementById('pf-ideaMenuName').value = p.ideaMenuName || '';
  document.getElementById('pf-description').value = p.description || '';
  document.getElementById('pf-cookingInstruction').value = p.cookingInstruction || '';
  document.getElementById('pf-composition').value = p.composition || '';
  document.getElementById('pf-allergens').value = p.allergens || '';
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

export { unsubscribeProducts };
