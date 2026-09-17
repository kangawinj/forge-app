// Trash -- a 30-day recoverable safety net for a deleted Recipe/
// Ingredient/Product/Project/Test Result/Sample Submission, plus its own
// modal UI. Split out of app.js -- see app.js's own top-of-file comment
// for the overall file split.
//
// trashCol/TRASH_COLLECTION_MAP/TRASH_RETENTION_DAYS stay declared in core
// app.js (not moved here) alongside every other Firestore collection ref --
// they're plain top-level `const`s built immediately from `db`/the other
// collection refs at module-evaluation time, not deferred inside a
// function, so moving them into a module that app.js itself imports back
// from would hit a real temporal-dead-zone hazard (this file would be
// evaluated, as part of resolving app.js's own import of it, before app.js
// has reached its own `db`/collection-ref lines further down the file).
// Every function below only ever touches them from inside a call, well
// after all modules have finished initializing, so importing them here is
// safe -- it's only immediate top-level use that isn't.
import {
  trashCol, TRASH_COLLECTION_MAP, TRASH_RETENTION_DAYS,
  escapeHtml, uid, currentUser, logActivityEvent, formatActivityDateTime, wireModalOverlayClose
} from './app.js';
import {
  setDoc, doc, deleteDoc, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Called right before each entity's own deleteDoc, with the exact
// in-memory object about to be deleted (already proven Firestore-safe --
// it's the same shape that collection's own save function writes). Runs
// under the CURRENT user's normal session even when called from inside an
// admin-approver flow (Recipes/Ingredients/Products) -- trashCol only
// ever needs isAllowedUser(), a completely separate Firebase App/auth
// instance from the isolated approver one, so this never depends on
// (or interferes with) whichever session is active at the call site.
export function moveToTrash(sourceCollection, id, data, label){
  return setDoc(doc(trashCol, uid()), {
    sourceCollection,
    originalId: id,
    label: label || 'Untitled',
    data,
    deletedBy: currentUser?.email || '',
    deletedAt: Date.now()
  });
}
export async function restoreFromTrash(trashDoc){
  const target = TRASH_COLLECTION_MAP[trashDoc.sourceCollection];
  if(!target) throw new Error(`Unknown Trash source collection "${trashDoc.sourceCollection}"`);
  await setDoc(doc(target.col, trashDoc.originalId), trashDoc.data);
  await deleteDoc(doc(trashCol, trashDoc.id));
  logActivityEvent('restored', target.label.toLowerCase(), trashDoc.label);
}
// Lazy cleanup -- this app has no scheduled Cloud Function to run this on
// a timer, so it just runs whenever the Trash screen is opened (see
// initTrashModal below), which is exactly when stale entries would
// otherwise be seen anyway.
export async function purgeExpiredTrash(items){
  const cutoff = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const expired = items.filter(t => (t.deletedAt || 0) < cutoff);
  await Promise.all(expired.map(t => deleteDoc(doc(trashCol, t.id))));
  return expired.map(t => t.id);
}

/* ---------- Trash (recover a deleted Recipe/Ingredient/Product/Project/
   Test Result/Sample Submission within 30 days) ----------
   Fetched fresh with a plain getDocs every time the modal opens rather
   than a persistent onSnapshot listener -- Trash is checked rarely, so
   there's no reason for every session to carry an always-on listener for
   it the way recipes/materials/etc. need. */
let trashItemsCache = [];
async function loadAndRenderTrash(){
  const listEl = document.getElementById('trashList');
  listEl.innerHTML = '<div class="overview-empty">Loading…</div>';
  try{
    const snap = await getDocs(trashCol);
    let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const purgedIds = await purgeExpiredTrash(items);
    if(purgedIds.length) items = items.filter(t => !purgedIds.includes(t.id));
    items.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    trashItemsCache = items;
    renderTrashList(items);
  }catch(err){
    console.error('Forge: loading Trash failed', err);
    listEl.innerHTML = `<div class="overview-empty">Could not load Trash: ${escapeHtml(err.message)}</div>`;
  }
}
function renderTrashList(items){
  const listEl = document.getElementById('trashList');
  if(!items.length){
    listEl.innerHTML = '<div class="overview-empty">Trash is empty</div>';
    return;
  }
  listEl.innerHTML = items.map(t => {
    const typeLabel = (TRASH_COLLECTION_MAP[t.sourceCollection] || {}).label || t.sourceCollection;
    const daysLeft = Math.max(0, Math.ceil((TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000 - (Date.now() - (t.deletedAt || 0))) / (24 * 60 * 60 * 1000)));
    return `
      <div class="trash-row" data-trash-id="${escapeHtml(t.id)}">
        <div class="trash-row-main">
          <div class="trash-row-label"><b>${escapeHtml(t.label)}</b> <span class="trash-row-type">${escapeHtml(typeLabel)}</span></div>
          <div class="trash-row-meta">Deleted by ${escapeHtml(t.deletedBy || 'Unknown')} · ${escapeHtml(formatActivityDateTime(t.deletedAt) || '')} · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left</div>
        </div>
        <button type="button" class="btn btn-sm" data-role="restore-trash">Restore</button>
      </div>
    `;
  }).join('');
  listEl.querySelectorAll('[data-role="restore-trash"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-trash-id]')?.dataset.trashId;
      const t = trashItemsCache.find(x => x.id === id);
      if(!t) return;
      btn.disabled = true;
      btn.textContent = 'Restoring…';
      try{
        await restoreFromTrash(t);
        trashItemsCache = trashItemsCache.filter(x => x.id !== id);
        renderTrashList(trashItemsCache);
      }catch(err){
        console.error('Forge: restore from Trash failed', err);
        alert('Could not restore this item: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Restore';
      }
    });
  });
}
export function initTrashModal(){
  function openTrashModal(){
    document.getElementById('navbarAccount').classList.remove('open');
    document.getElementById('trashModalOverlay').classList.add('open');
    loadAndRenderTrash();
  }
  function closeTrashModal(){
    document.getElementById('trashModalOverlay').classList.remove('open');
  }
  document.getElementById('btnOpenTrash').addEventListener('click', openTrashModal);
  document.getElementById('btnCloseTrash').addEventListener('click', closeTrashModal);
  wireModalOverlayClose('trashModalOverlay', closeTrashModal);
}

// Runs once per session right when the app unlocks, rather than only when
// someone happens to open the Trash screen (see purgeExpiredTrash's own
// comment about that being the only other trigger) -- Trash is opened
// rarely, so without this, items past their 30-day retention could sit
// around indefinitely on an install nobody ever manually checks Trash on.
// Fire-and-forget: doesn't touch trashItemsCache/renderTrashList, since
// the Trash modal isn't necessarily open when this runs.
export async function purgeExpiredTrashOnLoad(){
  try{
    const snap = await getDocs(trashCol);
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    await purgeExpiredTrash(items);
  }catch(err){
    console.error('Forge: background Trash purge failed', err);
  }
}
