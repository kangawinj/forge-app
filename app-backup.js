/* ---------- Import / Export ----------
   Exports recipes + the ingredient library together so a backup / move to
   another computer restores both. User accounts are deliberately excluded
   (plaintext passwords shouldn't travel in a shareable JSON backup file).
   Split out of app.js -- see app.js's own top-of-file comment for the
   overall file split. */
import { APP_VERSION } from './app-changelog.js';
import {
  uid, db, recipesCol, materialsCol, projectsCol, trialsCol,
  renderSidebar, renderMain, mainFeatureView, setMainFeatureView
} from './app.js';
import {
  writeBatch, doc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { recipes, openRecipe } from './recipes.js';
import { migrateRecipe, recomputeFromWeights } from './recipes-data.js';
import { ingredientMaster } from './materials.js';
import { projects, renderProjectsList } from './projects.js';
import { trials, renderTrialsList } from './trials.js';

export function exportAll(){
  const payload = {
    forgeExport: true,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    recipes: recipes,
    ingredientMaster: ingredientMaster,
    projects: projects,
    trials: trials
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `forge-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importFromFile(file){
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const data = JSON.parse(e.target.result);

      let importedRecipes = [];
      let importedMaterials = [];
      let importedProjects = [];
      let importedTrials = [];

      if(Array.isArray(data)){
        importedRecipes = data; // old format: plain array of recipes
      }else if(data && Array.isArray(data.recipes)){
        importedRecipes = data.recipes; // new format: {recipes, ingredientMaster, projects, trials}
        if(Array.isArray(data.ingredientMaster)) importedMaterials = data.ingredientMaster;
        if(Array.isArray(data.projects)) importedProjects = data.projects;
        if(Array.isArray(data.trials)) importedTrials = data.trials;
      }else if(data && typeof data === 'object'){
        importedRecipes = [data]; // old format: a single recipe object
      }

      const batch = writeBatch(db);

      // Every imported recipe gets a fresh id (so it can't collide with what's
      // already in the library) — recorded here so any imported project's
      // product.recipeId can be rewritten to match, since it was captured
      // against the recipe's old id at export time.
      const recipeIdMap = {};
      importedRecipes.forEach(item => {
        const oldId = item.id;
        item.id = uid();
        if(oldId) recipeIdMap[oldId] = item.id;
        item.updatedAt = Date.now();
        migrateRecipe(item);
        recomputeFromWeights(item);
        recipes.push(item);
        batch.set(doc(recipesCol, item.id), item);
      });

      let addedMaterials = 0;
      importedMaterials.forEach(m => {
        const exists = ingredientMaster.some(x =>
          (x.nameEn||'').trim().toLowerCase() === (m.nameEn||'').trim().toLowerCase() &&
          (x.nameTh||'').trim().toLowerCase() === (m.nameTh||'').trim().toLowerCase()
        );
        if(!exists && (m.nameEn||'').trim() && (m.nameTh||'').trim()){
          const material = {
            id: uid(),
            nameEn: m.nameEn,
            nameTh: m.nameTh,
            vendorCode: m.vendorCode || '',
            vendorName: m.vendorName || '',
            manufacturer: m.manufacturer || '',
            price: m.price || '',
            moq: m.moq || ''
          };
          ingredientMaster.push(material);
          batch.set(doc(materialsCol, material.id), material);
          addedMaterials++;
        }
      });

      importedProjects.forEach(p => {
        p.id = uid();
        p.updatedAt = Date.now();
        if(!Array.isArray(p.products)) p.products = [];
        p.products.forEach(prod => {
          prod.recipeId = recipeIdMap[prod.recipeId] || prod.recipeId;
          if(!Array.isArray(prod.log)) prod.log = [];
        });
        projects.push(p);
        batch.set(doc(projectsCol, p.id), p);
      });

      importedTrials.forEach(t => {
        t.id = uid();
        t.updatedAt = Date.now();
        const legacyIds = Array.isArray(t.recipeIds) ? t.recipeIds : (t.recipeId ? [t.recipeId] : []);
        t.recipeIds = legacyIds.map(rid => recipeIdMap[rid] || rid);
        delete t.recipeId;
        delete t.productName;
        if(!Array.isArray(t.photos)) t.photos = [];
        if(!Array.isArray(t.evaluation)) t.evaluation = [];
        trials.push(t);
        batch.set(doc(trialsCol, t.id), t);
      });

      if(importedRecipes.length){
        openRecipe(recipes[recipes.length-1].id);
        setMainFeatureView(null);
      }
      batch.commit();
      if(mainFeatureView === 'projects') renderProjectsList();
      if(mainFeatureView === 'trials') renderTrialsList();
      renderSidebar();
      renderMain();
      alert(`Import successful: ${importedRecipes.length} recipe(s), added ${addedMaterials} new ingredient(s) to the library (duplicates skipped), ${importedProjects.length} project(s), ${importedTrials.length} test result(s)`);
    }catch(err){
      alert('Could not read file: ' + err.message);
    }
  };
  reader.readAsText(file);
}
