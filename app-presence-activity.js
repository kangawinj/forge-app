// What the signed-in person is looking at right now -- shared through their presence document so that clicking
// someone's avatar in the top bar can say "Editing recipe: Tuna Gyoza". Only the page and the name of the open item
// are shared (never what is being typed), and nothing is read here that the screen does not already show.
import { mainFeatureView, recipeDisplayLabel } from './app.js';
import { currentId, unlockedRecipeId, recipes } from './recipes.js';
import { presenceProjectActivity } from './projects.js';
import { presenceTrialActivity } from './trials.js';

const PAGE_LABELS = {
  recipesList: 'Recipes', compare: 'Compare Recipes', materials: 'Ingredients', productList: 'Products',
  sampleSubmissions: 'Sample Submissions', refLists: 'Reference Lists', projects: 'Projects', trials: 'Test Results',
  bdPricing: 'BD Pricing', seriesMigration: 'Recipe Series tool'
};

// { page, item, mode: 'viewing' | 'editing', away }  -- `away` when this tab is in the background
export function computeMyActivity(){
  let page = 'Home';
  let item = '';
  let mode = 'viewing';
  try{
    if(mainFeatureView){
      page = PAGE_LABELS[mainFeatureView] || String(mainFeatureView);
      const found = mainFeatureView === 'projects' ? presenceProjectActivity()
        : mainFeatureView === 'trials' ? presenceTrialActivity() : null;
      if(found){ item = found.item; mode = found.mode; }
    }else if(currentId){
      const r = recipes.find(x => x.id === currentId);
      if(r){
        page = 'Recipes';
        item = recipeDisplayLabel(r);
        mode = unlockedRecipeId === currentId ? 'editing' : 'viewing';
      }
    }
  }catch(err){
    console.warn('Forge: could not work out the current activity', err);
  }
  return { page, item: String(item || '').slice(0, 120), mode, away: document.visibilityState !== 'visible' };
}
