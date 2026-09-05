/* ---------- Recipe Series Migration (admin-only) ----------
   A deliberately minimal one-off tool for assigning EXISTING recipes to a
   new Recipe Series — never automatic (no matching by product name or
   code), always an explicit admin-supplied Record ID -> Trial No. mapping,
   always previewed (dry run) before anything is written, and safely
   re-runnable (a recipe that already has a seriesId is skipped, not
   re-migrated). Kept in its own file rather than folded into recipes.js
   (already ~4000+ lines) since this is a rare admin action, not a
   maintained end-user feature surface.

   Gated client-side only (see app.js's isAdminUser toggle on
   #btnOpenSeriesMigration) -- the underlying recipes/recipeSeries writes
   themselves use the same Firestore rules as every other approved-user
   write in this app (see firestore.rules), matching how every other
   "admin" feature in this codebase already works (only recipe DELETION is
   rules-enforced). See the plan's "Cautions" section for the full
   reasoning. */
import {
  recipes, escapeHtml, icon, uid, currentUser, recipesCol, recipeSeriesCol,
  fullCode, playContentTransition
} from './app.js';
import { setDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// The most recent dry-run report — Apply only ever acts on this, never on
// a freshly re-parsed textarea, so what gets written always matches
// exactly what the admin reviewed on screen.
let dryRunReport = null;

export function mountSeriesMigrationView(){
  const main = document.getElementById('mainArea');
  main.classList.remove('main-wide');
  dryRunReport = null;
  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('git-branch', 24)} Recipe Series Migration</div>
    </div>
    <div class="card">
      <div class="card-title">Find Recipe IDs</div>
      <p class="series-migration-help">
        The JSON mapping below needs each recipe's actual Firestore Document ID (not its name or code) —
        search by product name here to find it, then copy it into <code>recipeId</code> below.
      </p>
      <input type="text" id="seriesMigrationSearch" class="series-migration-input" placeholder="Search recipes by name...">
      <div id="seriesMigrationSearchResults"></div>
    </div>
    <div class="card">
      <div class="card-title">Assign existing recipes to a Recipe Series</div>
      <p class="series-migration-help">
        Paste a JSON mapping of existing recipe IDs to Trial numbers under one Series, then click
        <b>Preview (Dry Run)</b> — nothing is written to the database until you review the report and click
        <b>Apply</b>. A recipe that's already in a Series is skipped automatically, so re-running the same
        mapping twice is safe.
      </p>
      <textarea id="seriesMigrationInput" class="series-migration-input" rows="12" placeholder='{
  "seriesKey": "AU26-SAU06",
  "countryCode": "AU",
  "year": "26",
  "productTypeCode": "SAU",
  "recipeSeq": "06",
  "productType": "Sauce",
  "recordIds": [
    { "recipeId": "r1a2b3c4d5", "trialNo": 8 },
    { "recipeId": "r6e7f8g9h0", "trialNo": 21 }
  ]
}'></textarea>
      <div class="series-migration-actions">
        <button class="btn" id="btnSeriesMigrationPreview">Preview (Dry Run)</button>
        <button class="btn btn-primary series-migration-btn-inactive" id="btnSeriesMigrationApply">Apply</button>
      </div>
      <div id="seriesMigrationReport"></div>
    </div>
  `;

  document.getElementById('btnSeriesMigrationPreview').addEventListener('click', runDryRun);
  document.getElementById('btnSeriesMigrationApply').addEventListener('click', applyMigration);
  document.getElementById('seriesMigrationSearch').addEventListener('input', renderSearchResults);
  playContentTransition(main);
}

// The free-text legacy "Trial/Reference Code" (r.code) usually already
// holds the intended Trial number as a human typed it (e.g. code="21" for
// what should become T21) -- used only as a starting guess for the Trial
// No. input next to each checkbox below, never written anywhere by itself.
function guessTrialNo(r){
  const n = parseInt((r.code || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : '';
}

function renderSearchResults(){
  const q = document.getElementById('seriesMigrationSearch').value.trim().toLowerCase();
  const resultsEl = document.getElementById('seriesMigrationSearchResults');
  if(!q){ resultsEl.innerHTML = ''; return; }
  const matches = recipes.filter(r => (r.name || '').toLowerCase().includes(q)).slice(0, 25);
  if(matches.length === 0){
    resultsEl.innerHTML = '<div class="series-migration-help">No recipes match that name.</div>';
    return;
  }
  resultsEl.innerHTML = `
    <div style="overflow-x:auto;">
      <table class="compare-table series-migration-table">
        <thead><tr><th></th><th>Name</th><th>Current Code</th><th>Series</th><th>Recipe ID</th><th></th><th>Trial No.</th></tr></thead>
        <tbody>
          ${matches.map(r => `
            <tr>
              <td><input type="checkbox" class="series-migration-select-cb" data-id="${escapeHtml(r.id)}" ${r.seriesId ? 'disabled title="Already in a Series"' : ''}></td>
              <td>${escapeHtml(r.name || 'Untitled recipe')}</td>
              <td>${escapeHtml(fullCode(r) || '—')}</td>
              <td>${r.seriesId ? escapeHtml(r.seriesKey || 'yes') : '—'}</td>
              <td><code class="series-migration-id">${escapeHtml(r.id)}</code></td>
              <td><button type="button" class="btn btn-sm series-migration-copy-btn" data-id="${escapeHtml(r.id)}">Copy</button></td>
              <td><input type="number" class="series-migration-trialno-input num-input" data-id="${escapeHtml(r.id)}" value="${guessTrialNo(r)}" style="width:64px;" ${r.seriesId ? 'disabled' : ''}></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="series-migration-actions">
      <button type="button" class="btn" id="btnSeriesMigrationSelectAll">Select All</button>
      <button type="button" class="btn btn-primary" id="btnSeriesMigrationAddSelected">+ Add Selected to Mapping</button>
    </div>
  `;
  resultsEl.querySelectorAll('.series-migration-copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try{
        await navigator.clipboard.writeText(btn.dataset.id);
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = original; }, 1200);
      } catch(err){
        // Clipboard API can be blocked (permissions, non-HTTPS, etc.) --
        // the ID is already shown as selectable text right next to the
        // button, so this is a graceful degrade, not a dead end.
        alert('Could not copy automatically — select the ID text next to this button and copy it manually.');
      }
    });
  });
  document.getElementById('btnSeriesMigrationSelectAll').addEventListener('click', () => {
    resultsEl.querySelectorAll('.series-migration-select-cb:not(:disabled)').forEach(cb => { cb.checked = true; });
  });
  document.getElementById('btnSeriesMigrationAddSelected').addEventListener('click', addSelectedToMapping);
}

// Merges every checked search result (recipeId + its Trial No. input) into
// the JSON textarea's recordIds array -- never touches seriesKey/
// countryCode/year/productTypeCode/recipeSeq (those stay whatever the admin
// already typed, or blank in a fresh mapping), since which Series identity
// to use is a deliberate admin decision this tool shouldn't guess at.
function addSelectedToMapping(){
  const resultsEl = document.getElementById('seriesMigrationSearchResults');
  const checked = [...resultsEl.querySelectorAll('.series-migration-select-cb:checked')];
  if(checked.length === 0){
    alert('Check at least one recipe in the results above first.');
    return;
  }
  const picks = [];
  const badTrialNoNames = [];
  checked.forEach(cb => {
    const id = cb.dataset.id;
    const trialInput = resultsEl.querySelector(`.series-migration-trialno-input[data-id="${CSS.escape(id)}"]`);
    const trialNo = parseInt(trialInput.value, 10);
    const r = recipes.find(x => x.id === id);
    if(!Number.isFinite(trialNo) || trialNo <= 0){
      badTrialNoNames.push(r ? (r.name || id) : id);
      return;
    }
    picks.push({ recipeId: id, trialNo });
  });
  if(badTrialNoNames.length){
    alert(`Enter a valid Trial No. (a positive number) for: ${badTrialNoNames.join(', ')}`);
    return;
  }

  const textarea = document.getElementById('seriesMigrationInput');
  const raw = textarea.value.trim();
  let current;
  if(raw){
    try{ current = JSON.parse(raw); }
    catch(err){ alert('The mapping box already has text in it that isn\'t valid JSON — fix or clear it first, then add selected recipes again.'); return; }
  } else {
    current = { seriesKey: '', countryCode: '', year: '', productTypeCode: '', recipeSeq: '', productType: '', recordIds: [] };
  }
  if(!Array.isArray(current.recordIds)) current.recordIds = [];

  let addedCount = 0, skippedCount = 0;
  picks.forEach(pick => {
    if(current.recordIds.some(e => e.recipeId === pick.recipeId)){ skippedCount++; return; }
    current.recordIds.push(pick);
    addedCount++;
  });

  textarea.value = JSON.stringify(current, null, 2);
  checked.forEach(cb => { cb.checked = false; });

  const needsSeriesKey = !current.seriesKey;
  const fillInReminder = needsSeriesKey ? ' Fill in seriesKey/countryCode/year/productTypeCode/recipeSeq at the top before Preview — the box below has jumped there for you.' : '';
  alert(`Added ${addedCount} recipe(s) to the mapping${skippedCount ? ` (${skippedCount} already in the list, skipped)` : ''}.${fillInReminder}`);

  if(needsSeriesKey) focusSeriesKeyField();
}

// Scrolls the mapping box to the top and drops the cursor right inside the
// (empty) seriesKey value -- used both right after Add Selected (which
// otherwise leaves the box scrolled down to the recordIds it just
// appended) and after a Preview that failed specifically because
// seriesKey was never filled in, so either way the next keystroke can go
// straight to fixing it.
function focusSeriesKeyField(){
  const textarea = document.getElementById('seriesMigrationInput');
  textarea.focus();
  textarea.scrollTop = 0;
  const marker = '"seriesKey": "';
  const idx = textarea.value.indexOf(marker);
  if(idx !== -1){
    const pos = idx + marker.length;
    textarea.setSelectionRange(pos, pos);
  }
}

function parseInput(){
  const raw = document.getElementById('seriesMigrationInput').value;
  try{
    return JSON.parse(raw);
  } catch(err){
    alert('Invalid JSON: ' + err.message);
    return null;
  }
}

function runDryRun(){
  const reportEl = document.getElementById('seriesMigrationReport');
  const applyBtn = document.getElementById('btnSeriesMigrationApply');
  applyBtn.classList.add('series-migration-btn-inactive');
  dryRunReport = null;
  reportEl.innerHTML = '';

  const input = parseInput();
  if(!input) return;

  const errors = [];
  const missingSeriesKey = !(input.seriesKey || '').trim();
  if(missingSeriesKey) errors.push('Missing seriesKey');
  if(!Array.isArray(input.recordIds) || input.recordIds.length === 0) errors.push('recordIds must be a non-empty array');

  const seenTrialNos = new Set();
  const rows = (input.recordIds || []).map(entry => {
    const r = recipes.find(x => x.id === entry.recipeId);
    const trialNo = parseInt(entry.trialNo, 10);
    const row = { recipeId: entry.recipeId, trialNo, recipe: r, before: r ? fullCode(r) : null, after: null, status: 'ok', reason: '' };
    if(!r){
      row.status = 'error'; row.reason = 'Recipe ID not found';
      errors.push(`${entry.recipeId}: recipe not found`);
    } else if(r.seriesId){
      // Already migrated -- reported, but never blocks the rest of the
      // batch, and never re-touched by Apply. This is what makes re-running
      // the exact same mapping a safe no-op.
      row.status = 'skip'; row.reason = `Already in Series ${r.seriesKey}`;
    } else if(!Number.isFinite(trialNo) || trialNo <= 0){
      row.status = 'error'; row.reason = 'trialNo must be a positive integer';
      errors.push(`${entry.recipeId}: invalid trialNo`);
    } else if(seenTrialNos.has(trialNo)){
      row.status = 'error'; row.reason = `Duplicate trialNo ${trialNo} within this mapping`;
      errors.push(`Duplicate trialNo ${trialNo} in this mapping`);
    } else {
      seenTrialNos.add(trialNo);
      row.after = `${input.countryCode||''}${input.year||'YY'}-${input.productTypeCode||'XXX'}${input.recipeSeq||'XX'}-T${String(trialNo).padStart(2,'0')}`;
    }
    return row;
  });

  // Collision check: does a Series with this exact key already exist
  // (i.e. some other, already-migrated recipe already carries it)?
  const existingSameKey = recipes.find(x => x.seriesId && x.seriesKey === input.seriesKey);
  if(existingSameKey){
    errors.push(`A Series with key "${input.seriesKey}" already exists (recipe "${existingSameKey.name || existingSameKey.id}") — pick a different seriesKey, or confirm this mapping is meant to add more Trials to that same Series (not supported by this tool yet — add them one at a time via the recipe's own "+ New Trial" instead once the first batch is migrated).`);
  }

  dryRunReport = { input, rows, errors };
  reportEl.innerHTML = renderReportHtml(dryRunReport);
  const okCount = rows.filter(r => r.status === 'ok').length;
  const canApply = errors.length === 0 && okCount > 0;
  applyBtn.classList.toggle('series-migration-btn-inactive', !canApply);
  // The report (below the box) already flags "Missing seriesKey," but the
  // fix is scrolled out of view above it -- jump straight to the field
  // that needs typing into, same as Add Selected does.
  if(missingSeriesKey) focusSeriesKeyField();
}

function renderReportHtml(report){
  const rowsHtml = report.rows.map(row => `
    <tr class="series-migration-row-${row.status}">
      <td>${escapeHtml(row.recipeId)}</td>
      <td>${escapeHtml(row.recipe ? (row.recipe.name || 'Untitled recipe') : '—')}</td>
      <td>${escapeHtml(row.before || '—')}</td>
      <td>${escapeHtml(row.after || '—')}</td>
      <td>${Number.isFinite(row.trialNo) ? row.trialNo : '—'}</td>
      <td>${row.status.toUpperCase()}${row.reason ? ' — ' + escapeHtml(row.reason) : ''}</td>
    </tr>
  `).join('');
  return `
    ${report.errors.length ? `<div class="series-migration-errors">${report.errors.map(e => `<div>${escapeHtml(e)}</div>`).join('')}</div>` : ''}
    <div style="overflow-x:auto;">
      <table class="compare-table series-migration-table">
        <thead><tr><th>Record ID</th><th>Name</th><th>Before</th><th>After</th><th>Trial No.</th><th>Status</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function applyMigration(){
  // Apply is always clickable (never a native `disabled` button) so it can
  // never just silently do nothing — every reason it can't proceed yet is
  // explained here instead.
  if(!dryRunReport){
    alert('Click "Preview (Dry Run)" first — Apply only ever acts on a mapping you\'ve already previewed.');
    return;
  }
  if(dryRunReport.errors.length){
    alert('Fix the errors shown in the Preview report first, then click "Preview (Dry Run)" again before Apply.');
    return;
  }
  const { input, rows } = dryRunReport;
  const okRows = rows.filter(r => r.status === 'ok');
  if(okRows.length === 0){
    alert('Nothing to apply — every recipe in this mapping is already in a Series (see the report above).');
    return;
  }

  const typed = prompt(`Type APPLY to confirm migrating ${okRows.length} recipe(s) into Series "${input.seriesKey}". This changes Recipe Code / Trial numbering for those recipes and is not easily undone.`);
  if(typed !== 'APPLY') return;

  const seriesId = uid();
  const maxTrialNo = Math.max(...okRows.map(r => r.trialNo));
  const firstRow = okRows.reduce((min, r) => (r.trialNo < min.trialNo ? r : min), okRows[0]);
  const seriesDoc = {
    id: seriesId, seriesKey: input.seriesKey, countryCode: input.countryCode || '',
    year: input.year || '', productTypeCode: input.productTypeCode || '',
    productType: input.productType || '', recipeSeq: input.recipeSeq || '',
    maxTrialNo, firstTrialId: firstRow.recipeId,
    createdAt: Date.now(), createdBy: currentUser?.email || ''
  };
  setDoc(doc(recipeSeriesCol, seriesId), seriesDoc);

  okRows.forEach(row => {
    const r = row.recipe;
    // Captured BEFORE mutating anything, per spec, so the pre-migration
    // code is preserved for audit even though this recipe's own r.code
    // (the old free-text field) is left in place, untouched, alongside it.
    r.legacyRecipeCode = fullCode(r);
    r.seriesId = seriesId;
    r.seriesKey = input.seriesKey;
    r.countryCode = input.countryCode || '';
    r.year = input.year || '';
    r.productTypeCode = input.productTypeCode || '';
    r.recipeSeq = input.recipeSeq || '';
    r.trialNo = row.trialNo;
    setDoc(doc(recipesCol, r.id), r); // r.id is never touched -- existing Test Results references stay valid
  });

  alert(`Migrated ${okRows.length} recipe(s) into Series "${input.seriesKey}".`);
  mountSeriesMigrationView();
}
