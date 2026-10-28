// Two people (or two tabs) edited the same recipe: Forge noticed that the stored version is no longer the one this
// tab started from (see observeRemoteRecipe / saveRecipeToCloud in recipes-data.js), paused saving that recipe and
// shows this bar so nothing is overwritten by accident. The choice is the person's:
//   * Load their version  -- take what was saved by the other person, drop the unsaved edits made here;
//   * Keep mine           -- save this tab's version over it, after putting THEIR version into Version History
//                            (and keeping their history entries) so it can be restored.
import { getDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { recipesCol, escapeHtml, renderMain, showCloudError } from './app.js';
import {
  migrateRecipe, recomputeFromWeights, setRecipeConflictHandler, clearRecipeConflict, markServerVersion
} from './recipes-data.js';
import { snapshotRecipeCore, pushVersionFromSnapshot } from './recipes-versions.js';
import { performSave } from './recipes.js';

function removeBar(){
  document.getElementById('recipeConflictBar')?.remove();
}

async function fetchRemote(id){
  const snap = await getDoc(doc(recipesCol, id));
  return snap.exists() ? snap.data() : null;
}

async function loadTheirs(local){
  try{
    const data = await fetchRemote(local.id);
    if(!data){ showCloudError('That recipe no longer exists (someone deleted it).'); return; }
    // replace the contents of the open object in place: the editor keeps a reference to it
    Object.keys(local).forEach(k => delete local[k]);
    Object.assign(local, data);
    migrateRecipe(local);
    recomputeFromWeights(local);
    markServerVersion(local.id, data.updatedAt);
    clearRecipeConflict(local.id);
    removeBar();
    renderMain();
  }catch(err){
    showCloudError('Could not load their version: ' + err.message);
  }
}

async function keepMine(local){
  try{
    const data = await fetchRemote(local.id);
    if(data){
      const who = data.updatedBy || 'someone else';
      const when = data.updatedAt ? new Date(data.updatedAt).toLocaleString() : '';
      const theirs = migrateRecipe(JSON.parse(JSON.stringify(data)));
      pushVersionFromSnapshot(local, `Before overwrite (edited by ${who}, ${when})`, snapshotRecipeCore(theirs), data.updatedAt);
      // keep the history entries they added meanwhile
      const have = new Set((local.versionsMeta || []).map(m => m.id));
      (Array.isArray(data.versionsMeta) ? data.versionsMeta : []).forEach(m => { if(!have.has(m.id)) local.versionsMeta.push(m); });
      local.versionsMeta.sort((a, b) => a.savedAt - b.savedAt);
      markServerVersion(local.id, data.updatedAt);
    }
    clearRecipeConflict(local.id);
    removeBar();
    performSave(local);
  }catch(err){
    showCloudError('Could not save your version: ' + err.message);
  }
}

function showConflictBar(local, remote){
  let bar = document.getElementById('recipeConflictBar');
  if(!bar){
    bar = document.createElement('div');
    bar.id = 'recipeConflictBar';
    bar.className = 'recipe-conflict-bar';
    bar.setAttribute('role', 'alert');
    document.body.appendChild(bar);
  }
  const who = remote.updatedBy || 'someone else';
  const when = remote.updatedAt ? new Date(remote.updatedAt).toLocaleTimeString() : '';
  bar.innerHTML = `
    <div><b>&#9888; &ldquo;${escapeHtml(local.name || 'This recipe')}&rdquo; was changed by ${escapeHtml(who)}${when ? ' at ' + escapeHtml(when) : ''} while you were editing it.</b></div>
    <div style="margin-top:4px;">Saving this recipe is paused so their changes are not overwritten. Choose which version to continue with:</div>
    <div class="recipe-conflict-actions">
      <button type="button" class="btn btn-sm" data-role="conflict-load">Load their version (my unsaved edits are dropped)</button>
      <button type="button" class="btn btn-sm btn-primary" data-role="conflict-keep">Keep mine (their version is saved in Version History)</button>
    </div>
  `;
  bar.querySelector('[data-role="conflict-load"]').addEventListener('click', () => loadTheirs(local));
  bar.querySelector('[data-role="conflict-keep"]').addEventListener('click', () => keepMine(local));
}

setRecipeConflictHandler(showConflictBar);
