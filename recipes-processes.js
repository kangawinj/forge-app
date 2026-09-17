// Process Steps editor -- the grouped "process title + numbered steps"
// blocks, their Components snapshot table, and the read-only two-column
// preview mirrored in the recipe editor's section 3. Split out of
// recipes.js (which grew past 3,400 lines even after its first split) --
// see recipes.js's own top-of-file comment for the overall file split.
import { escapeHtml, icon, uid, resizeImageFile } from './app.js';
import {
  partTotalWeight, allIngredientsInPart, findPartByName, collectPartsFlat,
  collectIngredientsFlat, round2, formatWeight
} from './recipes-data.js';
// Circular import back to core recipes.js -- safe, same pattern proven
// throughout this session's other splits: every cross-call below happens
// inside an event handler, never at module-evaluation time.
import { scheduleSave } from './recipes.js';

/* ---------- Process Steps (grouped: a process title + its own numbered steps) ---------- */
export function renderProcesses(r){
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

      <div class="process-actual-yield">
        <div class="process-components-title">Actual Yield</div>
        <div class="process-actual-yield-fields">
          <div class="process-yield-photos">
            <div class="trial-photos-row proc-photos-row"></div>
            <label class="btn btn-sm mu-attach-btn proc-photo-add-label">${icon('paperclip', 14)} Add Photo<input type="file" class="proc-photo-input" accept="image/*" style="display:none;"></label>
          </div>
          <div class="process-actual-yield-data">
            <div class="process-actual-yield-weight-row">
              <label>Weight Before (g)<input type="number" class="proc-wt-before num-input" step="0.01" min="0" placeholder="—"></label>
              <label>Weight After (g)<input type="number" class="proc-wt-after num-input" step="0.01" min="0" placeholder="—"></label>
              <div class="process-actual-yield-result">
                <span>Yield</span>
                <span class="proc-actual-yield-display">—</span>
              </div>
            </div>
            <div class="process-qc-groups">
            ${['brix','salt','ph'].map(field => `
              <div class="process-qc-group">
                <span class="process-qc-label">${field === 'brix' ? '°Brix' : field === 'salt' ? '%Salt' : 'pH'}</span>
                <div class="process-qc-reps">
                  <input type="number" class="proc-${field} num-input" data-idx="0" step="0.01" placeholder="Rep 1">
                  <input type="number" class="proc-${field} num-input" data-idx="1" step="0.01" placeholder="Rep 2">
                  <input type="number" class="proc-${field} num-input" data-idx="2" step="0.01" placeholder="Rep 3">
                </div>
                <div class="process-qc-avg"><span>Avg</span><span class="proc-${field}-avg-display">—</span></div>
              </div>
            `).join('')}
            </div>
          </div>
        </div>
      </div>

      <div class="process-steps-list"></div>
      <button class="btn btn-sm add-row-btn" data-role="add-step">+ Add Step</button>
    `;

    const titleInput = block.querySelector('.process-title');
    titleInput.value = proc.title || '';
    titleInput.addEventListener('input', e => { proc.title = e.target.value; scheduleSave(); });

    // Actual Yield -- real measured weight going into/out of this whole
    // Process (e.g. weigh the batch before and after Mixing), distinct from
    // every other Yield figure in this app (those are all planned/
    // theoretical, computed from the recipe's own data): this one is a
    // manual production measurement, so it's just two plain numbers with a
    // read-only Yield% derived from them -- After ÷ Before -- never
    // touching any recipe weight/cost figure elsewhere.
    const wtBeforeInput = block.querySelector('.proc-wt-before');
    const wtAfterInput = block.querySelector('.proc-wt-after');
    const actualYieldDisplay = block.querySelector('.proc-actual-yield-display');
    wtBeforeInput.value = proc.weightBefore != null ? proc.weightBefore : '';
    wtAfterInput.value = proc.weightAfter != null ? proc.weightAfter : '';
    function updateActualYieldDisplay(){
      const before = parseFloat(proc.weightBefore);
      const after = parseFloat(proc.weightAfter);
      if(!isFinite(before) || before <= 0 || !isFinite(after)){
        actualYieldDisplay.textContent = '—';
        return;
      }
      actualYieldDisplay.textContent = (after / before * 100).toFixed(2) + '%';
    }
    updateActualYieldDisplay();
    wtBeforeInput.addEventListener('input', e => {
      proc.weightBefore = e.target.value === '' ? null : (parseFloat(e.target.value) || null);
      updateActualYieldDisplay();
      scheduleSave();
    });
    wtAfterInput.addEventListener('input', e => {
      proc.weightAfter = e.target.value === '' ? null : (parseFloat(e.target.value) || null);
      updateActualYieldDisplay();
      scheduleSave();
    });

    // Up to 2 reference photos for this process's Actual Yield measurement
    // -- same resize-on-upload/thumbnail/remove pattern as the Description
    // photos above, just a smaller cap and its own array so the two photo
    // sets never mix.
    if(!Array.isArray(proc.photos)) proc.photos = [];
    const procPhotosRow = block.querySelector('.proc-photos-row');
    const procPhotoInput = block.querySelector('.proc-photo-input');
    const procPhotoAddLabel = block.querySelector('.proc-photo-add-label');
    function renderProcPhotos(){
      procPhotosRow.innerHTML = proc.photos.map((photo, idx) => `
        <div class="trial-photo-thumb" data-idx="${idx}">
          <img src="${escapeHtml(photo)}" alt="Process photo ${idx+1}">
          <button type="button" title="Remove this photo">${icon('x')}</button>
        </div>
      `).join('');
      procPhotosRow.querySelectorAll('.trial-photo-thumb button').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.closest('.trial-photo-thumb').dataset.idx, 10);
          proc.photos.splice(idx, 1);
          renderProcPhotos();
          scheduleSave();
        });
      });
      if(procPhotoAddLabel) procPhotoAddLabel.style.display = proc.photos.length >= 2 ? 'none' : '';
    }
    renderProcPhotos();
    procPhotoInput.addEventListener('change', async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if(!file || proc.photos.length >= 2) return;
      proc.photos.push(await resizeImageFile(file, 500));
      renderProcPhotos();
      scheduleSave();
    });

    // Quality Control readings -- °Brix, %Salt, pH -- each with up to 3
    // replicate measurements (proc[field] = [rep1, rep2, rep3]) and an
    // average shown alongside, computed from whichever reps actually have a
    // value (blanks skipped rather than treated as 0, so 1 or 2 filled-in
    // reps still average correctly while the recipe's waiting on the rest).
    ['brix','salt','ph'].forEach(field => {
      const repInputs = [...block.querySelectorAll(`.proc-${field}`)];
      const avgDisplay = block.querySelector(`.proc-${field}-avg-display`);
      if(!Array.isArray(proc[field])) proc[field] = [null, null, null];
      repInputs.forEach((input, idx) => {
        input.value = proc[field][idx] != null ? proc[field][idx] : '';
      });
      function updateAvgDisplay(){
        const vals = proc[field].map(v => parseFloat(v)).filter(v => isFinite(v));
        avgDisplay.textContent = vals.length > 0 ? (vals.reduce((s,v)=>s+v,0) / vals.length).toFixed(2) : '—';
      }
      updateAvgDisplay();
      repInputs.forEach((input, idx) => {
        input.addEventListener('input', e => {
          proc[field][idx] = e.target.value === '' ? null : (parseFloat(e.target.value) || null);
          updateAvgDisplay();
          scheduleSave();
        });
      });
    });

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

        // If this Component is a whole Part (not a single ingredient),
        // show what's actually inside it -- read-only, one row per
        // ingredient with its own Weight/% (the ingredient's own stored
        // weight/percent -- % of the whole recipe, same figures already
        // shown in the Recipe Overview table and the printed ingredient
        // table, not a separately-computed %-of-this-part) lined up under
        // the same Weight/% columns as the main row above, so "Vegan
        // Tartar Sauce" as one lumped-together 500g Component still lets
        // you see at a glance what that 500g is actually made of, without
        // duplicating the main ingredient tree's own editable fields here.
        const matchedPart = findPartByName(r.parts, (comp.name || '').trim());
        const innerIngredients = matchedPart
          ? allIngredientsInPart(matchedPart).filter(i => (i.name||'').trim() !== '')
          : [];
        innerIngredients.forEach(ing => {
          const subTr = document.createElement('tr');
          subTr.className = 'comp-sublist-row';
          subTr.innerHTML = `
            <td></td>
            <td class="comp-sublist-name">${escapeHtml(ing.name)}</td>
            <td class="col-wt comp-sublist-num">${formatWeight(parseFloat(ing.weight) || 0)}</td>
            <td class="col-tol"></td>
            <td class="col-range"></td>
            <td class="col-pct comp-sublist-num">${(parseFloat(ing.percent) || 0).toFixed(2)}%</td>
            <td class="col-del"></td>
          `;
          compBody.appendChild(subTr);
        });
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
      r.processes.splice(pIdx, 1);
      if(r.processes.length === 0) r.processes.push({ id: uid(), title: '', steps: [''], components: [] });
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
// section 4's List view — this just mirrors whatever's there right now,
// refreshed on every renderProcesses(r) call
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
