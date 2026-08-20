import {
  escapeHtml, icon, formatMoq, materialLabel, extractMoqNumber, requestAuthConfirm,
  DELETE_APPROVER_EMAIL, approverMaterialsCol, logActivityEvent, currentUser, uid,
  diffMainFields, snapshotMainFields, playContentTransition, resizeImageFile,
  formatActivityDateTime, mainFeatureView, currentId, recipesLoaded, renderMain,
  materialsCol, showCloudError
} from './app.js';
import {
  onSnapshot, setDoc, doc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let ingredientMaster = [];
let unsubscribeMaterials = null;
let materialsLoaded = false;
let editingMaterialId = null;
let editingMaterialImage = null; // staged photo as a data URL, or null for no photo
const MATERIAL_FORM_FIELD_IDS = ['mf-nameEn','mf-nameTh','mf-vendorCode','mf-vendorName','mf-manufacturer','mf-price','mf-moq','mf-usageNotes'];
const MATERIAL_DIFF_FIELDS = { nameEn: 'Name (EN)', nameTh: 'Name (TH)', vendorCode: 'Vendor Code', vendorName: 'Vendor Name', manufacturer: 'Manufacturer', price: 'Price', moq: 'MOQ', usageNotes: 'Usage Notes' };
let materialEditSnapshotBefore = null;

function saveMaterialToCloud(m){
  return setDoc(doc(materialsCol, m.id), m);
}

function deleteMaterialFromCloud(id){
  return deleteDoc(doc(materialsCol, id));
}

export function attachMaterialsListener(){
  unsubscribeMaterials = onSnapshot(materialsCol, snapshot => {
    ingredientMaster = snapshot.docs.map(d => d.data());
    materialsLoaded = true;
    if(mainFeatureView === 'materials') renderMaterialTable();
    if(!currentId && !mainFeatureView && recipesLoaded) renderMain();
  }, err => {
    console.error('Forge: materials listener error', err);
    showCloudError('Failed to load the ingredient library from Firebase: ' + err.message);
  });
}

export function renderMaterialTable(){
  const body = document.getElementById('materialTableBody');
  if(!body) return;
  const q = (document.getElementById('materialSearchInput').value || '').trim().toLowerCase();
  const filtered = ingredientMaster.filter(m => {
    if(!q) return true;
    return [m.nameEn, m.nameTh, m.vendorCode, m.vendorName, m.manufacturer, m.usageNotes]
      .some(v => (v || '').toLowerCase().includes(q));
  });
  // Most recently added first — ids are generated as "r" + a base36 timestamp
  // + random suffix, so sorting ids descending sorts by creation time.
  filtered.sort((a, b) => (b.id || '').localeCompare(a.id || ''));

  if(filtered.length === 0){
    body.innerHTML = `<tr><td colspan="9"><div class="material-empty">${ingredientMaster.length === 0 ? 'No ingredients in the library yet — add the first one above' : 'No matching ingredients found'}</div></td></tr>`;
    return;
  }

  body.innerHTML = filtered.map(m => `
    <tr data-view-material="${escapeHtml(m.id)}">
      <td>${m.image ? `<img src="${escapeHtml(m.image)}" class="material-thumb" alt="${escapeHtml(m.nameEn)}">` : '<div class="material-thumb material-thumb-empty"></div>'}</td>
      <td>${escapeHtml(m.nameEn)}</td>
      <td>${escapeHtml(m.nameTh)}</td>
      <td>${escapeHtml(m.vendorCode || '-')}</td>
      <td>${escapeHtml(m.vendorName || '-')}</td>
      <td>${escapeHtml(m.manufacturer || '-')}</td>
      <td>${m.price !== '' && m.price != null ? '฿' + escapeHtml(String(m.price)) : '-'}</td>
      <td>${escapeHtml(formatMoq(m.moq) || '-')}</td>
      <td>
        <button class="icon-btn" data-edit-material="${escapeHtml(m.id)}" title="Edit this ingredient">${icon('pencil')}</button>
        <button class="icon-btn" data-copy-material="${escapeHtml(m.id)}" title="Copy as a new ingredient">${icon('copy')}</button>
        <button class="icon-btn" data-del-material="${escapeHtml(m.id)}" title="Remove this ingredient from the library">${icon('x')}</button>
      </td>
    </tr>
  `).join('');

  body.querySelectorAll('[data-edit-material]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-edit-material');
      const m = ingredientMaster.find(x => x.id === id);
      if(m) startEditMaterial(m);
    });
  });
  body.querySelectorAll('[data-copy-material]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-copy-material');
      const m = ingredientMaster.find(x => x.id === id);
      if(m) startCopyMaterial(m);
    });
  });
  body.querySelectorAll('[data-del-material]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-del-material');
      const m = ingredientMaster.find(x => x.id === id);
      if(!m) return;
      if(!confirm(`Permanently remove "${materialLabel(m)}" from the ingredient library?`)) return;
      requestAuthConfirm(
        'Confirm Deletion',
        `Enter the approver's email and password to permanently remove "${materialLabel(m)}" from the ingredient library`,
        () => {},
        {
          requireEmail: DELETE_APPROVER_EMAIL,
          approverAction: () => deleteDoc(doc(approverMaterialsCol, id))
            .then(() => logActivityEvent('deleted', 'material', materialLabel(m)))
        }
      );
    });
  });
  body.querySelectorAll('[data-view-material]').forEach(tr => {
    tr.addEventListener('click', e => {
      if(e.target.closest('button')) return; // let edit/copy/delete handle their own click
      const id = tr.getAttribute('data-view-material');
      const m = ingredientMaster.find(x => x.id === id);
      if(m) openMaterialDetail(m);
    });
  });
}

export function mountMaterialsView(){
  const main = document.getElementById('mainArea');
  main.classList.remove('main-wide');
  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('book-open', 24)} Ingredient Library</div>
    </div>
    <div class="card">
      <div class="material-add-form">
        <div class="card-title" id="materialFormTitle" style="font-size:13px;margin-bottom:10px;">+ Add New Ingredient</div>
        <div class="grid-3">
          <div class="field">
            <label>1. Ingredient Name (English)*</label>
            <input type="text" id="mf-nameEn" placeholder="e.g. Vegan Mayonnaise">
          </div>
          <div class="field">
            <label>2. Ingredient Name (Thai)*</label>
            <input type="text" id="mf-nameTh" placeholder="Thai name">
          </div>
          <div class="field">
            <label>3. Vendor Code (from supplier)</label>
            <input type="text" id="mf-vendorCode" placeholder="e.g. RM-00123">
          </div>
        </div>
        <div class="grid-3">
          <div class="field">
            <label>4. Vendor Name</label>
            <input type="text" id="mf-vendorName" placeholder="e.g. ABC Co., Ltd.">
          </div>
          <div class="field">
            <label>5. Manufacturer Name (if any)</label>
            <input type="text" id="mf-manufacturer" placeholder="e.g. XYZ Manufacturing">
          </div>
          <div class="field">
            <label>6. Price/kg (฿)</label>
            <div class="code-row">
              <span class="code-prefix">฿</span>
              <input type="number" id="mf-price" min="0" step="0.01" placeholder="0.00" class="code-suffix">
            </div>
          </div>
        </div>
        <div class="grid-3">
          <div class="field">
            <label>7. MOQ/kg (if any)</label>
            <div class="code-row">
              <input type="number" id="mf-moq" min="0" step="0.01" placeholder="e.g. 25" class="unit-input">
              <span class="unit-suffix">kg</span>
            </div>
          </div>
          <div class="field">
            <label>8. Photo (optional)</label>
            <input type="file" id="mf-image" accept="image/*">
          </div>
          <div class="field" style="display:flex;align-items:center;gap:10px;">
            <img id="mf-imagePreview" style="display:none;width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--border);">
            <button type="button" class="btn btn-sm" id="btnRemoveMaterialImage" style="display:none;">Remove photo</button>
          </div>
        </div>
        <div class="field">
          <label>9. Usage Notes (optional)</label>
          <textarea id="mf-usageNotes" rows="2" placeholder="e.g. Hydrate for 10 min before mixing; max 2% of batch weight"></textarea>
        </div>
        <button class="btn btn-primary btn-sm" id="btnAddMaterial">+ Add to Library</button>
        <button class="btn btn-sm" id="btnCancelEditMaterial" style="display:none;">Cancel</button>
        <span class="ing-hint" id="materialFormError"></span>
      </div>

      <div class="material-search">
        <input type="text" id="materialSearchInput" placeholder="Search existing ingredients (Thai name / English name / code / vendor / usage notes)...">
      </div>
      <div style="overflow-x:auto;">
        <table class="material-table">
          <thead>
            <tr>
              <th>Photo</th>
              <th>English</th>
              <th>Thai</th>
              <th>Code</th>
              <th>Vendor</th>
              <th>Manufacturer</th>
              <th>Price/kg (฿)</th>
              <th>MOQ</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="materialTableBody"></tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('materialSearchInput').addEventListener('input', renderMaterialTable);
  document.getElementById('btnCancelEditMaterial').addEventListener('click', cancelEditMaterial);
  document.getElementById('mf-image').addEventListener('change', async e => {
    const file = e.target.files[0];
    if(!file) return;
    const errEl = document.getElementById('materialFormError');
    try{
      setMaterialImagePreview(await resizeImageFile(file, 200));
      errEl.textContent = '';
    }catch(err){
      errEl.textContent = err.message || 'Could not read that image file';
    }
  });
  document.getElementById('btnRemoveMaterialImage').addEventListener('click', () => {
    document.getElementById('mf-image').value = '';
    setMaterialImagePreview(null);
  });
  document.getElementById('btnAddMaterial').addEventListener('click', () => {
    const nameEn = document.getElementById('mf-nameEn').value.trim();
    const nameTh = document.getElementById('mf-nameTh').value.trim();
    const errEl = document.getElementById('materialFormError');
    if(!nameEn || !nameTh){
      errEl.textContent = 'Please enter both the English and Thai ingredient names';
      return;
    }
    errEl.textContent = '';
    const existing = editingMaterialId ? ingredientMaster.find(m => m.id === editingMaterialId) : null;
    const materialAfter = {
      id: editingMaterialId || uid(),
      nameEn,
      nameTh,
      vendorCode: document.getElementById('mf-vendorCode').value.trim(),
      vendorName: document.getElementById('mf-vendorName').value.trim(),
      manufacturer: document.getElementById('mf-manufacturer').value.trim(),
      price: document.getElementById('mf-price').value.trim(),
      moq: document.getElementById('mf-moq').value.trim(),
      usageNotes: document.getElementById('mf-usageNotes').value.trim(),
      image: editingMaterialImage || '',
      createdBy: existing?.createdBy || currentUser?.email || '',
      createdAt: existing?.createdAt || Date.now(),
      updatedBy: currentUser?.email || '',
      updatedAt: Date.now()
    };
    saveMaterialToCloud(materialAfter);
    logActivityEvent(existing ? 'updated' : 'created', 'material', materialLabel(materialAfter), existing ? diffMainFields(materialEditSnapshotBefore, materialAfter, MATERIAL_DIFF_FIELDS) : []);
    cancelEditMaterial();
  });

  cancelEditMaterial();
  renderMaterialTable();
  playContentTransition(main);
}

function openMaterialDetail(m){
  const body = document.getElementById('materialDetailBody');
  const rows = [
    ['Vendor Code', m.vendorCode],
    ['Vendor Name', m.vendorName],
    ['Manufacturer', m.manufacturer],
    ['Price/kg', (m.price !== '' && m.price != null) ? `฿${m.price}` : ''],
    ['MOQ', formatMoq(m.moq)]
  ].map(([label, value]) => `
    <dt>${escapeHtml(label)}</dt>
    <dd>${escapeHtml(value || '-')}</dd>
  `).join('');

  body.innerHTML = `
    <div class="material-detail-photo">
      ${m.image ? `<img src="${escapeHtml(m.image)}" alt="${escapeHtml(m.nameEn)}">` : '<div class="material-detail-photo-empty"></div>'}
    </div>
    <div class="material-detail-title">${escapeHtml(m.nameEn)} / ${escapeHtml(m.nameTh)}</div>
    <dl class="material-detail-list">${rows}</dl>
    ${m.usageNotes ? `
      <div class="material-detail-notes-label">Usage Notes</div>
      <div class="material-detail-notes">${escapeHtml(m.usageNotes)}</div>
    ` : ''}
    <div class="material-detail-activity">
      ${m.createdBy ? `<div>Created by ${escapeHtml(m.createdBy)}${m.createdAt ? ' · ' + escapeHtml(formatActivityDateTime(m.createdAt)) : ''}</div>` : ''}
      ${m.updatedBy ? `<div>Last edited by ${escapeHtml(m.updatedBy)}${m.updatedAt ? ' · ' + escapeHtml(formatActivityDateTime(m.updatedAt)) : ''}</div>` : ''}
    </div>
  `;
  document.getElementById('materialDetailModalOverlay').classList.add('open');
}

export function closeMaterialDetail(){
  document.getElementById('materialDetailModalOverlay').classList.remove('open');
}

function setMaterialImagePreview(dataUrl){
  const img = document.getElementById('mf-imagePreview');
  const removeBtn = document.getElementById('btnRemoveMaterialImage');
  editingMaterialImage = dataUrl || null;
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

function fillMaterialForm(m){
  document.getElementById('mf-nameEn').value = m.nameEn || '';
  document.getElementById('mf-nameTh').value = m.nameTh || '';
  document.getElementById('mf-vendorCode').value = m.vendorCode || '';
  document.getElementById('mf-vendorName').value = m.vendorName || '';
  document.getElementById('mf-manufacturer').value = m.manufacturer || '';
  document.getElementById('mf-price').value = m.price || '';
  document.getElementById('mf-moq').value = extractMoqNumber(m.moq);
  document.getElementById('mf-usageNotes').value = m.usageNotes || '';
  document.getElementById('mf-image').value = '';
  setMaterialImagePreview(m.image || null);
}

function startEditMaterial(m){
  editingMaterialId = m.id;
  materialEditSnapshotBefore = snapshotMainFields(m, MATERIAL_DIFF_FIELDS);
  fillMaterialForm(m);
  document.getElementById('materialFormTitle').innerHTML = `${icon('pencil')} Editing: ${escapeHtml(materialLabel(m))}`;
  document.getElementById('btnAddMaterial').textContent = 'Save Changes';
  document.getElementById('btnCancelEditMaterial').style.display = 'inline-flex';
  document.getElementById('materialFormError').textContent = '';
  document.getElementById('mf-nameEn').scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('mf-nameEn').focus();
}

function startCopyMaterial(m){
  editingMaterialId = null;
  fillMaterialForm(m);
  document.getElementById('materialFormTitle').innerHTML = `${icon('copy')} Copy of "${escapeHtml(materialLabel(m))}" — review and add as new`;
  document.getElementById('btnAddMaterial').textContent = '+ Add to Library';
  document.getElementById('btnCancelEditMaterial').style.display = 'inline-flex';
  document.getElementById('materialFormError').textContent = '';
  document.getElementById('mf-nameEn').scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('mf-nameEn').focus();
}

function cancelEditMaterial(){
  editingMaterialId = null;
  materialEditSnapshotBefore = null;
  MATERIAL_FORM_FIELD_IDS.forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('mf-image').value = '';
  setMaterialImagePreview(null);
  document.getElementById('materialFormTitle').textContent = '+ Add New Ingredient';
  document.getElementById('btnAddMaterial').textContent = '+ Add to Library';
  document.getElementById('btnCancelEditMaterial').style.display = 'none';
  document.getElementById('materialFormError').textContent = '';
}

// Tears down the materials Firestore listener and resets all Materials
// state to empty — called from the shared sign-out handler in app.js, kept
// here so that handler doesn't need write access to bindings this module
// owns (same pattern as trials.js's resetTrialsState).
export function resetMaterialsState(){
  if(unsubscribeMaterials){ unsubscribeMaterials(); unsubscribeMaterials = null; }
  materialsLoaded = false;
  ingredientMaster = [];
}

export { ingredientMaster, unsubscribeMaterials };
