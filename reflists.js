import {
  escapeHtml, icon, resizeImageFile, requestAuthConfirm, playContentTransition,
  formatActivityDateTime, trialStringListHtml, currentUser, uid, mainFeatureView,
  countryFlagBadgeHtml, metaListsDoc
} from './app.js';
import {
  onSnapshot, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------- Reference Lists modal (Customers / Sales Reps / Destination Countries) ---------- */
let refListActiveTab = 'customers';
let refListEditingId = null;
// Company Directory's optional logo/photo — staged as a data URL, same
// staging-until-saved pattern as newProjectImage/editingProjectImage on the
// Projects side. refListNewCustomerImage holds the not-yet-added draft's
// photo; refListEditingCustomerImage holds whichever existing entry is
// currently being edited (there's only ever one, since refListEditingId
// already enforces single-row editing).
let refListNewCustomerImage = '';
let refListEditingCustomerImage = null;
// Staged like refListEditingCustomerImage — a Company Directory entry's
// Locations (Office/Kitchen/Factory 1/...) are edited as a live add/remove
// list, so a full renderRefListItems() mid-edit (adding/removing one row)
// needs somewhere to hold the in-progress array instead of re-reading it
// fresh from item.locations, which would just show the last-saved state.
let refListEditingLocations = [];
let refListEditingSteps = [];

export function mountRefListsView(){
  const main = document.getElementById('mainArea');
  main.classList.remove('main-wide');
  refListEditingId = null;
  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('list', 24)} Reference Lists</div>
    </div>
    <div class="card">
      <div class="reflist-tabs">
        <button class="reflist-tab-btn active" data-key="customers">Company Directory</button>
        <button class="reflist-tab-btn" data-key="salesReps">Contact Directory</button>
        <button class="reflist-tab-btn" data-key="destinationCountries">Destination Countries</button>
        <button class="reflist-tab-btn" data-key="responsiblePersons">Responsible Persons (PD)</button>
        <button class="reflist-tab-btn" data-key="productTypes">Product Types</button>
        <button class="reflist-tab-btn" data-key="units">Units</button>
        <button class="reflist-tab-btn" data-key="cookingMethods">Cooking Method</button>
        <button class="reflist-tab-btn" data-key="codeGuide">Trial Code Format</button>
      </div>
      <div class="reflist-add-row" id="refListAddRow">
        <input type="text" id="refListNewInput" placeholder="Add a new entry...">
        <input type="text" id="refListNewCountryInput" list="destinationDatalist" placeholder="Country (optional)" style="display:none;max-width:180px;">
        <input type="file" id="refListNewImageInput" accept="image/*" style="display:none;max-width:160px;">
        <img id="refListNewImagePreview" src="" alt="" style="display:none;width:32px;height:32px;object-fit:cover;border-radius:50%;border:1px solid var(--border);">
        <button type="button" class="btn btn-sm" id="refListNewImageRemove" style="display:none;">Remove</button>
        <span class="reflist-code-preview" id="refListCodePreview" style="display:none;">Code: <b id="refListCodePreviewValue">—</b></span>
        <button class="btn btn-primary btn-sm" id="btnRefListAdd">+ Add</button>
      </div>
      <div class="reflist-contact-grid" id="refListContactFields" style="display:none;">
        <input type="text" id="contactNewType" list="contactTypeDatalist" placeholder="Contact Type (e.g. Internal, Customer)">
        <input type="text" id="contactNewCompany" list="customerDatalist" placeholder="Company / Organization">
        <input type="text" id="contactNewCountry" list="destinationDatalist" placeholder="Country / Location">
        <input type="text" id="contactNewJobTitle" placeholder="Job Title / Position">
        <input type="text" id="contactNewDepartment" placeholder="Department">
        <input type="email" id="contactNewEmail" placeholder="Email">
        <input type="tel" id="contactNewPhone" placeholder="Phone Number">
      </div>
      <div id="refListItems"></div>
    </div>
  `;

  const updateAddRowFields = () => {
    // Trial Code Format is a static reference page, not an editable list —
    // there's nothing to add, so the whole add-row hides for that tab.
    document.getElementById('refListAddRow').style.display = refListActiveTab === 'codeGuide' ? 'none' : '';
    document.getElementById('refListNewCountryInput').style.display = refListActiveTab === 'customers' ? '' : 'none';
    const isCustomersTab = refListActiveTab === 'customers';
    document.getElementById('refListNewImageInput').style.display = isCustomersTab ? '' : 'none';
    document.getElementById('refListNewImagePreview').style.display = (isCustomersTab && refListNewCustomerImage) ? '' : 'none';
    document.getElementById('refListNewImageRemove').style.display = (isCustomersTab && refListNewCustomerImage) ? '' : 'none';
    document.getElementById('refListCodePreview').style.display = refListActiveTab === 'productTypes' ? '' : 'none';
    document.getElementById('refListContactFields').style.display = refListActiveTab === 'salesReps' ? '' : 'none';
    const isDestinationsTab = refListActiveTab === 'destinationCountries';
    const newInput = document.getElementById('refListNewInput');
    if(isDestinationsTab) newInput.setAttribute('list', 'worldCountriesDatalist');
    else newInput.removeAttribute('list');
    if(refListActiveTab === 'productTypes') newInput.placeholder = 'e.g. Sauce';
    else if(refListActiveTab === 'units') newInput.placeholder = 'e.g. kg, pcs, carton...';
    else if(refListActiveTab === 'salesReps') newInput.placeholder = 'Full Name';
    else if(refListActiveTab === 'cookingMethods') newInput.placeholder = 'e.g. Deep Fry, Steam, Microwave...';
    else newInput.placeholder = isDestinationsTab ? 'Search world countries...' : 'Add a new entry...';
  };
  document.querySelectorAll('.reflist-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.key === refListActiveTab);
    btn.addEventListener('click', () => {
      document.querySelectorAll('.reflist-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      refListActiveTab = btn.dataset.key;
      refListEditingId = null;
      updateAddRowFields();
      renderRefListItems();
    });
  });
  updateAddRowFields();
  const addNewEntry = () => {
    const input = document.getElementById('refListNewInput');
    const countryInput = document.getElementById('refListNewCountryInput');
    let extra = {};
    if(refListActiveTab === 'customers'){
      const country = countryInput.value.trim();
      if(country && !metaLists.destinationCountries.some(item => metaItemName(item) === country)){
        alert(`"${country}" is not in Destination Countries yet. Please add it there first, then pick it here.`);
        return;
      }
      extra = { country, image: refListNewCustomerImage };
    }else if(refListActiveTab === 'productTypes'){
      const code = productTypeCode(input.value);
      if(metaLists.productTypes.some(item => (item.code || '') === code)){
        alert(`The first 3 letters of "${input.value.trim()}" give the code "${code}", which is already used by another product type. Please use a different name.`);
        return;
      }
      extra = { code };
    }else if(refListActiveTab === 'salesReps'){
      extra = {
        contactType: document.getElementById('contactNewType').value.trim(),
        company: document.getElementById('contactNewCompany').value.trim(),
        country: document.getElementById('contactNewCountry').value.trim(),
        jobTitle: document.getElementById('contactNewJobTitle').value.trim(),
        department: document.getElementById('contactNewDepartment').value.trim(),
        email: document.getElementById('contactNewEmail').value.trim(),
        phone: document.getElementById('contactNewPhone').value.trim()
      };
    }
    addMetaListValue(refListActiveTab, input.value, extra);
    input.value = '';
    countryInput.value = '';
    refListNewCustomerImage = '';
    document.getElementById('refListNewImageInput').value = '';
    document.getElementById('refListNewImagePreview').src = '';
    document.getElementById('refListNewImagePreview').style.display = 'none';
    document.getElementById('refListNewImageRemove').style.display = 'none';
    document.getElementById('refListCodePreviewValue').textContent = '—';
    document.querySelectorAll('#refListContactFields input').forEach(el => { el.value = ''; });
    renderRefListItems();
  };
  document.getElementById('btnRefListAdd').addEventListener('click', addNewEntry);
  document.getElementById('refListNewImageInput').addEventListener('change', async e => {
    const file = e.target.files[0];
    if(!file) return;
    try{
      refListNewCustomerImage = await resizeImageFile(file, 200);
      document.getElementById('refListNewImagePreview').src = refListNewCustomerImage;
      document.getElementById('refListNewImagePreview').style.display = '';
      document.getElementById('refListNewImageRemove').style.display = '';
    }catch(err){
      alert(err.message || 'Could not read that image file');
    }
  });
  document.getElementById('refListNewImageRemove').addEventListener('click', () => {
    refListNewCustomerImage = '';
    document.getElementById('refListNewImageInput').value = '';
    document.getElementById('refListNewImagePreview').src = '';
    document.getElementById('refListNewImagePreview').style.display = 'none';
    document.getElementById('refListNewImageRemove').style.display = 'none';
  });
  // Same company-country auto-fill Projects already does for Customer ->
  // Destination (see .proj-customer 'change' below) — just sets the value,
  // doesn't lock the field, so it's still free to hand-edit afterward if
  // the contact's own location differs from the company's on file.
  document.getElementById('contactNewCompany').addEventListener('change', e => {
    const match = metaLists.customers.find(c => metaItemName(c) === e.target.value.trim());
    if(match && match.country){
      document.getElementById('contactNewCountry').value = match.country;
    }
  });
  document.getElementById('refListNewInput').addEventListener('input', e => {
    if(refListActiveTab === 'productTypes'){
      document.getElementById('refListCodePreviewValue').textContent = productTypeCode(e.target.value) || '—';
    }
  });
  document.getElementById('refListNewInput').addEventListener('keydown', e => {
    if(e.key === 'Enter'){ e.preventDefault(); addNewEntry(); }
  });
  document.getElementById('refListNewCountryInput').addEventListener('keydown', e => {
    if(e.key === 'Enter'){ e.preventDefault(); addNewEntry(); }
  });
  document.querySelectorAll('#refListContactFields input').forEach(el => {
    el.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); addNewEntry(); }
    });
  });

  renderRefListItems();
  playContentTransition(main);
}
// Static reference/documentation — not backed by metaLists like the other
// tabs, since there's nothing to add/edit/delete here. It exists purely so
// staff have the trial-code structure to look up while typing one in.
const TRIAL_CODE_GUIDE_ROWS = [
  { part: 'TH', meaning: "Customer's destination country (ประเทศลูกค้าปลายทาง)", example: 'Thailand' },
  { part: '26', meaning: 'Recipe creation year, 2 digits, YY (ปีที่สร้างสูตร 2 หลัก)', example: '2026' },
  { part: 'SAU', meaning: 'Product type code (รหัสประเภทสินค้า)', example: 'Sauce' },
  { part: '01', meaning: 'Recipe sequence number, counted separately per product type (ลำดับสูตร นับแยกเฉพาะประเภทสินค้านั้น)', example: '1st Sauce recipe (สูตรซอสลำดับที่ 1)' },
  { part: 'T01', meaning: 'Trial sequence number for the recipe (ลำดับการทดลองของสูตร)', example: 'Trial #1 (การทดลองครั้งที่ 1)' }
];
function renderTrialCodeGuide(container){
  container.innerHTML = `
    <div class="reflist-code-guide">
      <div class="reflist-code-guide-example">TH26-SAU01-T01</div>
      <div class="reflist-code-guide-structure">Code structure: [Country][Year]-[Product Type][Recipe No.]-Trial No. — no dash within a group, only between the 3 groups (โครงสร้างรหัส: [ประเทศ][ปี]-[ประเภทสินค้า][ลำดับสูตร]-ลำดับทดลอง — ไม่มีขีดคั่นภายในกลุ่ม มีขีดคั่นเฉพาะระหว่าง 3 กลุ่มหลัก)</div>
      <table>
        <thead><tr><th>Component (ส่วนประกอบ)</th><th>Meaning (ความหมาย)</th><th>Example (ตัวอย่าง)</th></tr></thead>
        <tbody>
          ${TRIAL_CODE_GUIDE_ROWS.map(row => `
            <tr><td><b>${escapeHtml(row.part)}</b></td><td>${escapeHtml(row.meaning)}</td><td>${escapeHtml(row.example)}</td></tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// The Contact Directory's fields beyond Full Name (which just reuses the
// shared "name" field every other list already has) — one place to list
// them so the add form, the edit grid, and the "did anything actually
// change" check in saveEdit all stay in sync with each other.
const CONTACT_EXTRA_FIELDS = ['contactType', 'company', 'country', 'jobTitle', 'department', 'email', 'phone'];

export function renderRefListItems(){
  const container = document.getElementById('refListItems');
  if(!container) return;
  if(refListActiveTab === 'codeGuide'){
    renderTrialCodeGuide(container);
    return;
  }
  const isDestinations = refListActiveTab === 'destinationCountries';
  const isCustomers = refListActiveTab === 'customers';
  const isProductTypes = refListActiveTab === 'productTypes';
  const isContacts = refListActiveTab === 'salesReps';
  const isCookingMethods = refListActiveTab === 'cookingMethods';
  const items = [...(metaLists[refListActiveTab] || [])].sort((a,b) => metaItemName(a).localeCompare(metaItemName(b)));
  if(items.length === 0){
    container.innerHTML = `<div class="overview-empty">No ${META_LIST_LABELS[refListActiveTab].toLowerCase()} yet — add one above</div>`;
    return;
  }
  container.innerHTML = items.map(item => {
    const isEditing = item.id === refListEditingId;
    const activity = [];
    if(item.createdBy) activity.push(`Added by ${escapeHtml(item.createdBy)}${item.createdAt ? ' · ' + escapeHtml(formatActivityDateTime(item.createdAt)) : ''}`);
    if(item.updatedBy && item.updatedAt !== item.createdAt) activity.push(`Edited by ${escapeHtml(item.updatedBy)}${item.updatedAt ? ' · ' + escapeHtml(formatActivityDateTime(item.updatedAt)) : ''}`);
    // Compact summary line: Position — Company — Contact Type — Email/Phone
    // (email preferred, phone as a fallback) — Country and Department are
    // still there, just not worth cluttering this one-line summary with;
    // both are editable in the full grid below once you click Edit.
    const contactSummaryHtml = isContacts && !isEditing
      ? `<div class="reflist-contact-summary">${
          [item.jobTitle, item.company, item.contactType, (item.email || item.phone)].filter(Boolean).map(escapeHtml).join(' &nbsp;·&nbsp; ')
          || '<span class="reflist-contact-summary-empty">No additional details yet — click Edit to add</span>'
        }</div>`
      : '';
    const contactEditGridHtml = isContacts && isEditing ? `
      <div class="reflist-contact-grid">
        <input type="text" class="reflist-contact-type-input" list="contactTypeDatalist" placeholder="Contact Type (e.g. Internal, Customer)" value="${escapeHtml(item.contactType || '')}">
        <input type="text" class="reflist-contact-company-input" list="customerDatalist" placeholder="Company / Organization" value="${escapeHtml(item.company || '')}">
        <input type="text" class="reflist-contact-country-input" list="destinationDatalist" placeholder="Country / Location" value="${escapeHtml(item.country || '')}">
        <input type="text" class="reflist-contact-jobtitle-input" placeholder="Job Title / Position" value="${escapeHtml(item.jobTitle || '')}">
        <input type="text" class="reflist-contact-department-input" placeholder="Department" value="${escapeHtml(item.department || '')}">
        <input type="email" class="reflist-contact-email-input" placeholder="Email" value="${escapeHtml(item.email || '')}">
        <input type="tel" class="reflist-contact-phone-input" placeholder="Phone Number" value="${escapeHtml(item.phone || '')}">
      </div>
    ` : '';
    // Steps (Cooking Method only) — an ordered, add/remove-one-at-a-time
    // list, same wiring shape as Company Directory's Locations and Test
    // Results' Cooking Method steps (see trialStringListHtml).
    const cookingStepsHtml = isCookingMethods ? `
      <div class="reflist-locations-edit">
        <label class="reflist-locations-label">Steps (optional)</label>
        ${trialStringListHtml(isEditing ? refListEditingSteps : (item.steps || []), isEditing, 'reflist-cooking-step-input', 'cooking-method-step', 'e.g. Deep fry 170°C, 5 min')}
      </div>
    ` : '';
    // Company Directory's optional logo — a plain preview circle when not
    // editing, or a small upload/remove control (reading from
    // refListEditingCustomerImage, staged the same way editingProjectImage
    // is on the Projects side) when this row is the one being edited.
    const companyLogoImg = isEditing ? refListEditingCustomerImage : item.image;
    const companyLogoHtml = isCustomers && !isEditing && item.image
      ? `<span class="reflist-company-logo"><img src="${escapeHtml(item.image)}" alt=""></span>`
      : '';
    const companyLogoEditHtml = isCustomers && isEditing ? `
      <div class="reflist-company-logo-edit">
        ${companyLogoImg ? `<img class="reflist-company-logo-edit-preview" src="${escapeHtml(companyLogoImg)}" alt="">` : ''}
        <input type="file" class="reflist-company-logo-input" accept="image/*">
        ${companyLogoImg ? `<button type="button" class="btn btn-sm reflist-company-logo-remove">Remove photo</button>` : ''}
      </div>
    ` : '';
    // Company Directory's leading circle is the photo when there is one —
    // the country flag only steps in as a fallback for a company that
    // doesn't have a photo yet, rather than both showing side by side.
    const companyFlagHtml = isCustomers && item.country && !(!isEditing && item.image)
      ? countryFlagBadgeHtml(item.country)
      : '';
    return `
    <div class="reflist-item" data-id="${escapeHtml(item.id)}">
      ${companyLogoHtml}
      ${isDestinations ? countryFlagBadgeHtml(item.name) : ''}
      ${companyFlagHtml}
      <div class="reflist-item-main">
        <input type="text" class="reflist-item-name-input" value="${escapeHtml(item.name)}" ${isEditing ? '' : 'readonly'}>
        ${isCustomers ? `<input type="text" class="reflist-item-country-input" list="destinationDatalist" placeholder="Country (optional)" value="${escapeHtml(item.country || '')}" ${isEditing ? '' : 'readonly'}>` : ''}
        ${isCustomers && isEditing ? `
          <div class="reflist-locations-edit">
            <label class="reflist-locations-label">Locations (optional)</label>
            ${trialStringListHtml(refListEditingLocations, true, 'reflist-location-input', 'company-location', 'e.g. Office, Kitchen, Factory 1')}
          </div>
        ` : ''}
        ${isCustomers && !isEditing && (item.locations || []).length ? `
          <div class="reflist-company-locations">
            ${item.locations.map(loc => `<span class="reflist-location-chip">${escapeHtml(loc)}</span>`).join('')}
          </div>
        ` : ''}
        ${companyLogoEditHtml}
        ${contactSummaryHtml}
        ${contactEditGridHtml}
        ${cookingStepsHtml}
        ${activity.length ? `<div class="reflist-item-meta">${activity.join(' &nbsp;|&nbsp; ')}</div>` : ''}
      </div>
      ${isProductTypes ? `<span class="reflist-code-badge" data-code-badge>${escapeHtml(item.code || productTypeCode(item.name))}</span>` : ''}
      ${isEditing
        ? `<button class="icon-btn" title="Save" data-role="save">${icon('save')}</button><button class="icon-btn" title="Cancel" data-role="cancel">${icon('undo-2')}</button>`
        : `<button class="icon-btn" title="Edit" data-role="edit">${icon('pencil')}</button><button class="icon-btn" title="Delete" data-role="delete">${icon('x')}</button>`}
    </div>
  `;
  }).join('');

  if(isProductTypes){
    container.querySelectorAll('.reflist-item').forEach(row => {
      const nameInput = row.querySelector('.reflist-item-name-input');
      const badge = row.querySelector('[data-code-badge]');
      nameInput.addEventListener('input', () => { badge.textContent = productTypeCode(nameInput.value) || '—'; });
    });
  }

  container.querySelectorAll('.reflist-flag-img').forEach(img => {
    img.addEventListener('error', () => {
      img.replaceWith(Object.assign(document.createElement('span'), { className: 'reflist-flag-fallback', textContent: img.dataset.fallback }));
    }, { once: true });
  });

  container.querySelectorAll('.reflist-company-logo-input').forEach(inp => {
    inp.addEventListener('change', async e => {
      const file = e.target.files[0];
      if(!file) return;
      try{
        refListEditingCustomerImage = await resizeImageFile(file, 200);
        renderRefListItems();
      }catch(err){
        alert(err.message || 'Could not read that image file');
      }
    });
  });
  container.querySelectorAll('.reflist-company-logo-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      refListEditingCustomerImage = '';
      renderRefListItems();
    });
  });

  // Same company-country auto-fill as the "+ Add" form above — see
  // contactNewCompany's own 'change' listener in mountRefListsView.
  container.querySelectorAll('.reflist-contact-company-input').forEach(inp => {
    inp.addEventListener('change', e => {
      const match = metaLists.customers.find(c => metaItemName(c) === e.target.value.trim());
      if(match && match.country){
        inp.closest('.reflist-item').querySelector('.reflist-contact-country-input').value = match.country;
      }
    });
  });

  container.querySelectorAll('[data-role="edit"]').forEach(btn => {
    btn.addEventListener('click', () => {
      refListEditingId = btn.closest('.reflist-item').dataset.id;
      const editingItem = metaLists[refListActiveTab].find(x => x.id === refListEditingId);
      refListEditingCustomerImage = editingItem ? (editingItem.image || '') : '';
      refListEditingLocations = editingItem ? [...(editingItem.locations || [])] : [];
      refListEditingSteps = editingItem ? [...(editingItem.steps || [])] : [];
      renderRefListItems();
      const inp = container.querySelector(`.reflist-item[data-id="${CSS.escape(refListEditingId)}"] .reflist-item-name-input`);
      if(inp){ inp.focus(); inp.select(); }
    });
  });
  const saveEdit = row => {
    const id = row.dataset.id;
    const item = metaLists[refListActiveTab].find(x => x.id === id);
    const newVal = row.querySelector('.reflist-item-name-input').value.trim();
    const newCountry = isCustomers ? row.querySelector('.reflist-item-country-input').value.trim() : undefined;
    // Read straight from the row's own DOM rather than trusting
    // refListEditingLocations to be fully up to date — its change-event
    // sync (below) can miss the very last keystroke if Enter triggers this
    // save before a location input's blur fires.
    const newLocations = isCustomers
      ? [...row.querySelectorAll('.reflist-location-input')].map(el => el.value.trim()).filter(Boolean)
      : undefined;
    const newContact = isContacts ? {
      contactType: row.querySelector('.reflist-contact-type-input').value.trim(),
      company: row.querySelector('.reflist-contact-company-input').value.trim(),
      country: row.querySelector('.reflist-contact-country-input').value.trim(),
      jobTitle: row.querySelector('.reflist-contact-jobtitle-input').value.trim(),
      department: row.querySelector('.reflist-contact-department-input').value.trim(),
      email: row.querySelector('.reflist-contact-email-input').value.trim(),
      phone: row.querySelector('.reflist-contact-phone-input').value.trim()
    } : undefined;
    const newSteps = isCookingMethods
      ? [...row.querySelectorAll('.reflist-cooking-step-input')].map(el => el.value.trim()).filter(Boolean)
      : undefined;
    if(isCustomers && newCountry && !metaLists.destinationCountries.some(x => metaItemName(x) === newCountry)){
      alert(`"${newCountry}" is not in Destination Countries yet. Please add it there first, then pick it here.`);
      return; // stay in edit mode so the country can be fixed
    }
    const newCode = isProductTypes ? productTypeCode(newVal) : undefined;
    if(isProductTypes && metaLists.productTypes.some(x => x.id !== id && (x.code || '') === newCode)){
      alert(`The first 3 letters of "${newVal}" give the code "${newCode}", which is already used by another product type. Please use a different name.`);
      return; // stay in edit mode so the name can be fixed
    }
    const extra = isCustomers ? { country: newCountry, image: refListEditingCustomerImage, locations: newLocations } : (isProductTypes ? { code: newCode } : (isContacts ? newContact : (isCookingMethods ? { steps: newSteps } : {})));
    const contactUnchanged = !isContacts || CONTACT_EXTRA_FIELDS.every(f => newContact[f] === (item[f] || ''));
    const imageUnchanged = !isCustomers || refListEditingCustomerImage === (item.image || '');
    const locationsUnchanged = !isCustomers || JSON.stringify(newLocations) === JSON.stringify(item.locations || []);
    const stepsUnchanged = !isCookingMethods || JSON.stringify(newSteps) === JSON.stringify(item.steps || []);
    if(!newVal || (newVal === item.name && (!isCustomers || newCountry === (item.country || '')) && imageUnchanged && contactUnchanged && locationsUnchanged && stepsUnchanged)){
      refListEditingId = null; refListEditingCustomerImage = null; refListEditingLocations = []; refListEditingSteps = []; renderRefListItems(); return;
    }
    if(!renameMetaListItem(refListActiveTab, id, newVal, extra)){
      alert(`"${newVal}" is already in this list.`);
      return; // stay in edit mode so the name can be fixed
    }
    refListEditingId = null;
    refListEditingCustomerImage = null;
    refListEditingLocations = [];
    refListEditingSteps = [];
    renderRefListItems();
  };
  container.querySelectorAll('[data-role="save"]').forEach(btn => {
    btn.addEventListener('click', () => saveEdit(btn.closest('.reflist-item')));
  });
  container.querySelectorAll('[data-role="cancel"]').forEach(btn => {
    btn.addEventListener('click', () => { refListEditingId = null; refListEditingCustomerImage = null; refListEditingLocations = []; refListEditingSteps = []; renderRefListItems(); });
  });
  container.querySelectorAll('.reflist-item-name-input, .reflist-item-country-input, .reflist-contact-type-input, .reflist-contact-company-input, .reflist-contact-country-input, .reflist-contact-jobtitle-input, .reflist-contact-department-input, .reflist-contact-email-input, .reflist-contact-phone-input').forEach(inp => {
    inp.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); saveEdit(inp.closest('.reflist-item')); }
      else if(e.key === 'Escape'){ refListEditingId = null; refListEditingCustomerImage = null; refListEditingLocations = []; refListEditingSteps = []; renderRefListItems(); }
    });
  });
  // Locations (Company Directory only) — a live add/remove list, same
  // wiring shape as Trial Results' Test Participants/Cooking Method.
  container.querySelector('[data-role="add-company-location"]')?.addEventListener('click', () => {
    refListEditingLocations.push('');
    renderRefListItems();
  });
  container.querySelectorAll('[data-role="remove-company-location"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      refListEditingLocations.splice(idx, 1);
      renderRefListItems();
    });
  });
  container.querySelectorAll('.reflist-location-input').forEach((inp, idx) => {
    inp.addEventListener('change', () => { refListEditingLocations[idx] = inp.value.trim(); });
    inp.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); saveEdit(inp.closest('.reflist-item')); }
      else if(e.key === 'Escape'){ refListEditingId = null; refListEditingCustomerImage = null; refListEditingLocations = []; refListEditingSteps = []; renderRefListItems(); }
    });
  });
  // Steps (Cooking Method only) — same live add/remove list wiring as
  // Locations above.
  container.querySelector('[data-role="add-cooking-method-step"]')?.addEventListener('click', () => {
    refListEditingSteps.push('');
    renderRefListItems();
  });
  container.querySelectorAll('[data-role="remove-cooking-method-step"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      refListEditingSteps.splice(idx, 1);
      renderRefListItems();
    });
  });
  container.querySelectorAll('.reflist-cooking-step-input').forEach((inp, idx) => {
    inp.addEventListener('change', () => { refListEditingSteps[idx] = inp.value.trim(); });
    inp.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); saveEdit(inp.closest('.reflist-item')); }
      else if(e.key === 'Escape'){ refListEditingId = null; refListEditingCustomerImage = null; refListEditingLocations = []; refListEditingSteps = []; renderRefListItems(); }
    });
  });
  container.querySelectorAll('[data-role="delete"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.reflist-item').dataset.id;
      const item = metaLists[refListActiveTab].find(x => x.id === id);
      if(!item) return;
      if(!confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
      requestAuthConfirm(
        'Confirm Identity to Delete',
        `Enter your password to delete "${item.name}" from the list.`,
        () => {
          removeMetaListItem(refListActiveTab, id);
          renderRefListItems();
        }
      );
    });
  });
}

/* ---------- Reference Lists: Customers / Sales Reps / Destination Countries ---------- */
/* Each list holds { id, name } records rather than plain strings, so future
   fields (contact info, region, etc.) can be added per entry later without
   another data migration. */
let metaLists = { customers: [], destinationCountries: [], salesReps: [], responsiblePersons: [], productTypes: [], units: [], cookingMethods: [] };
const META_LIST_LABELS = { customers: 'Company Directory', salesReps: 'Contact Directory', destinationCountries: 'Destination Countries', responsiblePersons: 'Responsible Persons (PD)', productTypes: 'Product Types', units: 'Units', cookingMethods: 'Cooking Method' };
// Seeded into metaLists.units the first time it's ever missing from the
// saved doc (see attachMetaListsListener) — the exact same values every
// Portion Weight/Packing/MOQ/Flavor-per unit dropdown used to be hardcoded
// to, so existing recipes/projects keep showing the same units after the
// switch to a user-editable list instead of losing them.
const DEFAULT_UNIT_SEED = ['g','kg','ml','L','oz','lb','pcs','pack','bag','box','sachet','pouch','tray','carton','case'];

// The trial-code abbreviation (see the Trial Code Format tab) is always the
// first 3 letters of the product type name, uppercased — never typed by
// hand, so two types can never drift out of sync with their own code.
export function productTypeCode(name){
  return (name || '').trim().slice(0, 3).toUpperCase();
}

/* Normalizes a stored list entry to a { id, name, createdBy, createdAt,
   updatedBy, updatedAt } record — older data (or the very first values
   saved before this list tracked activity) may just be a plain string. */
function metaItem(entry){
  if(typeof entry === 'string'){
    return { id: uid(), name: entry, createdBy: '', createdAt: null, updatedBy: '', updatedAt: null };
  }
  return entry;
}
export function metaItemName(entry){
  return typeof entry === 'string' ? entry : (entry.name || '');
}

export function attachMetaListsListener(){
  unsubscribeMetaLists = onSnapshot(metaListsDoc, snap => {
    const data = snap.data() || {};
    // "units" is a field the saved doc never had before — undefined (not
    // just an empty array, which would mean the user deliberately cleared
    // it) means this is the very first load since the switch to an
    // editable list, so seed it with the same values every unit dropdown
    // used to be hardcoded to and persist that seed immediately.
    const needsUnitSeed = data.units === undefined;
    metaLists = {
      customers: (Array.isArray(data.customers) ? data.customers : []).map(metaItem),
      destinationCountries: (Array.isArray(data.destinationCountries) ? data.destinationCountries : []).map(metaItem),
      salesReps: (Array.isArray(data.salesReps) ? data.salesReps : []).map(metaItem),
      responsiblePersons: (Array.isArray(data.responsiblePersons) ? data.responsiblePersons : []).map(metaItem),
      productTypes: (Array.isArray(data.productTypes) ? data.productTypes : []).map(metaItem),
      units: needsUnitSeed
        ? DEFAULT_UNIT_SEED.map(name => ({ id: uid(), name, createdBy: '', createdAt: null, updatedBy: '', updatedAt: null }))
        : (Array.isArray(data.units) ? data.units : []).map(metaItem),
      cookingMethods: (Array.isArray(data.cookingMethods) ? data.cookingMethods : []).map(metaItem)
    };
    if(needsUnitSeed) setDoc(metaListsDoc, metaLists);
    renderMetaDatalists();
    if(mainFeatureView === 'refLists') renderRefListItems();
  }, err => {
    console.error('Forge: meta lists listener error', err);
  });
}

/* New entries can only be added via the Reference Lists modal (not by
   typing a new value straight into a recipe's Customer/Destination/Sales
   Rep field — see bindComboField) so the list stays a deliberately curated
   set instead of accumulating typos from free text. */
/* extra carries fields beyond "name" — currently only Factories use this,
   for their Location field. */
function addMetaListValue(key, value, extra = {}){
  const v = (value || '').trim();
  if(!v || metaLists[key].some(item => metaItemName(item) === v)) return;
  const now = Date.now();
  const who = currentUser?.email || '';
  const updated = [...metaLists[key], { id: uid(), name: v, ...extra, createdBy: who, createdAt: now, updatedBy: who, updatedAt: now }]
    .sort((a,b) => metaItemName(a).localeCompare(metaItemName(b)));
  metaLists = { ...metaLists, [key]: updated };
  setDoc(metaListsDoc, metaLists);
}
/* Renaming in place (rather than delete + re-add) is what lets "edited by /
   when" mean something distinct from "added by / when". Returns false
   without saving if the new name collides with another entry already in
   the same list. */
function renameMetaListItem(key, id, newName, extra = {}){
  const v = (newName || '').trim();
  if(!v) return false;
  if(metaLists[key].some(item => item.id !== id && metaItemName(item) === v)) return false;
  const updated = metaLists[key].map(item => item.id === id
    ? { ...item, name: v, ...extra, updatedBy: currentUser?.email || '', updatedAt: Date.now() }
    : item
  );
  metaLists = { ...metaLists, [key]: updated };
  setDoc(metaListsDoc, metaLists);
  return true;
}
function removeMetaListItem(key, id){
  metaLists = { ...metaLists, [key]: metaLists[key].filter(item => item.id !== id) };
  setDoc(metaListsDoc, metaLists);
}
function renderMetaDatalists(){
  const map = { customers: 'customerDatalist', destinationCountries: 'destinationDatalist', salesReps: 'salesRepDatalist', responsiblePersons: 'responsiblePersonDatalist', productTypes: 'productTypeDatalist', units: 'unitsDatalist', cookingMethods: 'cookingMethodDatalist' };
  Object.entries(map).forEach(([key, listId]) => {
    const el = document.getElementById(listId);
    if(!el) return;
    el.innerHTML = metaLists[key].map(item => `<option value="${escapeHtml(metaItemName(item))}"></option>`).join('');
  });
}

let unsubscribeMetaLists = null;

// Tears down the metaLists Firestore listener and resets the shared
// reference-lists state to empty — called from the shared sign-out handler
// in app.js, kept here so that handler doesn't need write access to
// bindings this module owns (same pattern as resetTrialsState/
// resetMaterialsState). Also fixes a pre-existing bug: the old inline
// sign-out reset only cleared 4 of the 7 keys (productTypes/units/
// cookingMethods were added later and never added to that reset) — harmless
// in practice since the next sign-in's snapshot immediately overwrites it,
// but this resets the complete, current shape instead of a stale one.
export function resetRefListsState(){
  if(unsubscribeMetaLists){ unsubscribeMetaLists(); unsubscribeMetaLists = null; }
  metaLists = { customers: [], destinationCountries: [], salesReps: [], responsiblePersons: [], productTypes: [], units: [], cookingMethods: [] };
}

export { metaLists, unsubscribeMetaLists };
