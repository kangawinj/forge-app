// Recipes list views -- the full-page grid (category tiles → drilled list)
// and the sidebar's compact accordion. Split out of recipes.js (which grew
// past 5,200 lines) -- see recipes.js's own top-of-file comment for the
// overall file split.
import {
  escapeHtml, icon, mainFeatureView, setMainFeatureView, logActivityEvent,
  playContentTransition, renderSidebar, renderMain, guardNavigation, setCompareSeriesPrefilter
} from './app.js';
import { blankRecipe, saveRecipeToCloud, fullCode, recipeDisplayLabel, allIngredientsInRecipe } from './recipes-data.js';
// Circular import back to core recipes.js -- safe, see trials-wizard.js's
// own comment on this same pattern.
import { recipes, currentId, openRecipe, registerNewRecipe } from './recipes.js';

// One recipe row (used by both the flat/filtered list below and the
// sidebar's category accordion) -- same markup, same click-to-open
// behavior, just built once so neither place has to duplicate it.
function appendRecipeItemEl(container, r){
  const div = document.createElement('div');
  div.className = 'recipe-item' + (r.id === currentId ? ' active' : '');
  const allIngredients = allIngredientsInRecipe(r);
  // % is always weight / totalWeight, so it's exactly 100% by construction
  // whenever there's any weight at all (ing.percent is now per-part, so it
  // can't be summed directly to check this).
  const hasWeight = allIngredients.some(i => (parseFloat(i.weight)||0) > 0);
  const totalPct = hasWeight ? 100 : 0;
  const codeDisplay = fullCode(r);
  div.innerHTML = `
    <div class="r-name">${escapeHtml(recipeDisplayLabel(r))}</div>
    <div class="r-meta">${codeDisplay ? escapeHtml(codeDisplay)+' · ' : ''}${totalPct.toFixed(1)}% · ${allIngredients.length} ingredients</div>
  `;
  div.addEventListener('click', () => guardNavigation(() => {
    openRecipe(r.id);
    setMainFeatureView(null);
    renderMain();
    renderSidebar();
  }));
  container.appendChild(div);
}

// Flat (optionally category-filtered) list — used by the full-page Recipes
// view (shown from the "Recipes" tab) to show one Product Type's recipes
// at a time (see recipeCategoryTilesHtml/renderRecipesListGrid below), and
// by the sidebar accordion below as its search-mode fallback.
export function renderRecipeCards(container, query, category){
  if(!container) return;
  const q = (query || '').trim().toLowerCase();
  const sorted = [...recipes].sort((a,b)=>b.updatedAt-a.updatedAt);
  container.innerHTML = '';
  sorted.filter(r => !q || (r.name||'Untitled').toLowerCase().includes(q))
    .filter(r => !category || ((r.productType||'').trim() || 'Uncategorized') === category)
    .forEach(r => appendRecipeItemEl(container, r));
}

// Which Product Type categories are currently expanded in the sidebar's
// compact list -- an accordion rather than the full-page view's separate
// tile screen, since the sidebar's single narrow column has no room for
// two screens. Persists across re-renders (renderSidebar runs constantly,
// on every edit) so toggling a category open doesn't collapse again on
// the next keystroke elsewhere in the app.
let sidebarExpandedCategories = new Set();
// Which Recipe Series sub-groups are expanded within the sidebar — same
// persists-across-re-renders reasoning as sidebarExpandedCategories, one
// level deeper (only Series-enabled recipes ever get this second level;
// legacy recipes render as flat items exactly as before this existed).
let sidebarExpandedSeries = new Set();

// Groups a flat recipe list into "entries" -- either a bare legacy recipe,
// or one collapsed Series entry per distinct seriesId holding every Trial
// that belongs to it (latest Trial first). Shared by the sidebar's
// Product-Type accordion (one call per category) and the full-page
// Recipes view's own category-drilled list below -- both need the exact
// same "group Trials of the same Series together" behavior, just nested
// under a different outer container.
function groupRecipesBySeries(recipeList){
  const entries = [];
  [...recipeList].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).forEach(r => {
    if(r.seriesId){
      let entry = entries.find(e => e.kind === 'series' && e.seriesId === r.seriesId);
      if(!entry){
        entry = { kind: 'series', seriesId: r.seriesId, seriesKey: r.seriesKey, trials: [], updatedAt: 0 };
        entries.push(entry);
      }
      entry.trials.push(r);
      if((r.updatedAt||0) > entry.updatedAt) entry.updatedAt = r.updatedAt || 0;
    } else {
      entries.push({ kind: 'legacy', recipe: r, updatedAt: r.updatedAt || 0 });
    }
  });
  entries.sort((a,b) => b.updatedAt - a.updatedAt);
  entries.forEach(e => { if(e.kind === 'series') e.trials.sort((a,b) => (b.trialNo||0) - (a.trialNo||0)); });
  return entries;
}

export function renderSidebarRecipeCards(container, query){
  if(!container) return;
  const q = (query || '').trim();
  if(q){
    renderRecipeCards(container, q, null);
    return;
  }
  // The currently open recipe's own category (and Series sub-group, if
  // any) always shows expanded, so switching to it (from a link elsewhere,
  // or reopening the app) never leaves it hidden behind a collapsed group.
  const current = recipes.find(r => r.id === currentId);
  if(current){
    sidebarExpandedCategories.add((current.productType||'').trim() || 'Uncategorized');
    if(current.seriesId) sidebarExpandedSeries.add(current.seriesId);
  }

  // Each category's entries are either a bare legacy recipe, or one
  // collapsed "series" entry per distinct seriesId holding every Trial
  // that belongs to it — purely an in-memory regrouping of the same
  // `recipes` array every other view already reads fully into memory via
  // onSnapshot, so this adds no new Firestore read pattern.
  const byCategory = new Map();
  recipes.forEach(r => {
    const cat = (r.productType||'').trim() || 'Uncategorized';
    if(!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(r);
  });
  const groups = new Map([...byCategory.entries()].map(([cat, list]) => [cat, groupRecipesBySeries(list)]));
  const sortedCats = [...groups.keys()].sort((a,b) => a.localeCompare(b, undefined, {sensitivity:'base'}));

  container.innerHTML = '';
  sortedCats.forEach(cat => {
    const entries = groups.get(cat);
    // One count per distinct recipe -- a Series (however many Trials it
    // has) counts as 1, same as the category tile counts on the full-page
    // Recipes view, not "however many Trial documents exist."
    const totalCount = entries.length;
    const expanded = sidebarExpandedCategories.has(cat);
    const group = document.createElement('div');
    group.className = 'recipe-category-group';
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'recipe-category-header' + (expanded ? ' open' : '');
    header.innerHTML = `
      ${icon(expanded ? 'chevron-down' : 'chevron-right', 14)}
      <span class="recipe-category-header-name">${escapeHtml(cat)}</span>
      <span class="recipe-category-header-count">${totalCount}</span>
    `;
    header.addEventListener('click', () => {
      if(sidebarExpandedCategories.has(cat)) sidebarExpandedCategories.delete(cat); else sidebarExpandedCategories.add(cat);
      renderSidebarRecipeCards(container, query);
    });
    group.appendChild(header);
    if(expanded){
      const itemsWrap = document.createElement('div');
      itemsWrap.className = 'recipe-category-items';
      entries.forEach(entry => {
        if(entry.kind === 'legacy'){
          appendRecipeItemEl(itemsWrap, entry.recipe);
          return;
        }
        const seriesExpanded = sidebarExpandedSeries.has(entry.seriesId);
        const seriesGroup = document.createElement('div');
        seriesGroup.className = 'recipe-series-group';
        const seriesHeader = document.createElement('button');
        seriesHeader.type = 'button';
        seriesHeader.className = 'recipe-series-header' + (seriesExpanded ? ' open' : '');
        seriesHeader.innerHTML = `
          ${icon(seriesExpanded ? 'chevron-down' : 'chevron-right', 13)}
          <span class="recipe-series-header-name">${escapeHtml(entry.trials[0]?.name || 'Untitled recipe')}</span>
          <span class="recipe-series-header-meta">${escapeHtml(entry.seriesKey || '')} · ${entry.trials.length} Trial${entry.trials.length === 1 ? '' : 's'}</span>
        `;
        seriesHeader.addEventListener('click', () => {
          if(sidebarExpandedSeries.has(entry.seriesId)) sidebarExpandedSeries.delete(entry.seriesId); else sidebarExpandedSeries.add(entry.seriesId);
          renderSidebarRecipeCards(container, query);
        });
        seriesGroup.appendChild(seriesHeader);
        if(seriesExpanded){
          const seriesItemsWrap = document.createElement('div');
          seriesItemsWrap.className = 'recipe-series-items';
          entry.trials.forEach(t => appendRecipeItemEl(seriesItemsWrap, t));
          seriesGroup.appendChild(seriesItemsWrap);
        }
        itemsWrap.appendChild(seriesGroup);
      });
      group.appendChild(itemsWrap);
    }
    container.appendChild(group);
  });
}

export function createNewRecipe(){
  const r = blankRecipe();
  registerNewRecipe(r);
  setMainFeatureView(null);
  saveRecipeToCloud(r);
  logActivityEvent('created', 'recipe', r.name || 'Untitled recipe');
  renderSidebar();
  renderMain();
}


// Which Product Type category the full-page Recipes view is currently
// drilled into, or null to show the category tiles themselves -- reset on
// every fresh mount (leaving the tab and coming back starts over at the
// top level, same as everything else in this file that opens a full-page
// view). Typing a search query bypasses categories entirely (shows a flat
// filtered list across every recipe) since search already says exactly
// what the user is looking for.
let recipesListCategoryFilter = null;

// Which Series are expanded in the full-page Recipes view's own
// category-drilled list -- same idea as sidebarExpandedSeries, kept
// separate since the two views have entirely different DOM/lifetimes, and
// reset alongside recipesListCategoryFilter on every fresh mount.
let recipesListExpandedSeries = new Set();

// Series-grouped version of renderRecipeCards for the full-page Recipes
// view's own category-drilled list (query-free, one category at a time) --
// mirrors renderSidebarRecipeCards' inner per-category rendering, just
// without the outer Product-Type accordion layer (this list is already
// scoped to one category by the time it's called).
function renderCategoryRecipeList(container, category){
  if(!container) return;
  const current = recipes.find(r => r.id === currentId);
  if(current && current.seriesId && ((current.productType||'').trim() || 'Uncategorized') === category){
    recipesListExpandedSeries.add(current.seriesId);
  }
  const categoryRecipes = recipes.filter(r => ((r.productType||'').trim() || 'Uncategorized') === category);
  const entries = groupRecipesBySeries(categoryRecipes);

  container.innerHTML = '';
  entries.forEach(entry => {
    if(entry.kind === 'legacy'){
      appendRecipeItemEl(container, entry.recipe);
      return;
    }
    const seriesExpanded = recipesListExpandedSeries.has(entry.seriesId);
    const seriesGroup = document.createElement('div');
    seriesGroup.className = 'recipe-series-group';
    const seriesHeader = document.createElement('button');
    seriesHeader.type = 'button';
    seriesHeader.className = 'recipe-series-header' + (seriesExpanded ? ' open' : '');
    seriesHeader.innerHTML = `
      ${icon(seriesExpanded ? 'chevron-down' : 'chevron-right', 13)}
      <span class="recipe-series-header-name">${escapeHtml(entry.trials[0]?.name || 'Untitled recipe')}</span>
      <span class="recipe-series-header-meta">${escapeHtml(entry.seriesKey || '')} · ${entry.trials.length} Trial${entry.trials.length === 1 ? '' : 's'}</span>
    `;
    seriesHeader.addEventListener('click', () => {
      if(recipesListExpandedSeries.has(entry.seriesId)) recipesListExpandedSeries.delete(entry.seriesId); else recipesListExpandedSeries.add(entry.seriesId);
      renderCategoryRecipeList(container, category);
    });
    seriesGroup.appendChild(seriesHeader);
    if(seriesExpanded){
      const seriesItemsWrap = document.createElement('div');
      seriesItemsWrap.className = 'recipe-series-items';
      entry.trials.forEach(t => appendRecipeItemEl(seriesItemsWrap, t));
      seriesGroup.appendChild(seriesItemsWrap);
    }
    container.appendChild(seriesGroup);
  });
}

export function mountRecipesListView(){
  const main = document.getElementById('mainArea');
  main.classList.remove('main-wide');
  recipesListCategoryFilter = null;
  recipesListExpandedSeries = new Set();
  main.innerHTML = `
    <div class="main-header">
      <div class="section-title-display">${icon('file-text', 24)} Recipes</div>
    </div>
    <div class="card">
      <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
        <button class="btn btn-primary" id="btnNewFromRecipesList">+ New Recipe</button>
        <button class="btn" id="btnCompareFromRecipesList">${icon('scale')} Compare Recipes</button>
      </div>
      <div class="search-box" style="margin:0 0 16px;">
        <input type="text" id="recipesListSearchInput" placeholder="Search product name...">
      </div>
      <div id="recipesListCategoryHeader"></div>
      <div class="recipe-category-grid" id="recipesListCategoryGrid"></div>
      <div class="recipe-list" id="recipesListGrid"></div>
    </div>
  `;

  document.getElementById('btnNewFromRecipesList').addEventListener('click', createNewRecipe);
  document.getElementById('btnCompareFromRecipesList').addEventListener('click', () => {
    setCompareSeriesPrefilter(null); // plain "Compare Recipes" entry — unfiltered, unlike "Compare Trials"
    setMainFeatureView('compare');
    renderMain();
    renderSidebar();
  });
  document.getElementById('recipesListSearchInput').addEventListener('input', renderRecipesListGrid);

  renderRecipesListGrid();
  playContentTransition(main);
}

// Product Type tiles (one per distinct r.productType, "Uncategorized" for
// blank) with a recipe count each -- clicking one drills into that
// category's own filtered recipe list via renderRecipeCards.
function recipeCategoryTilesHtml(){
  // A count here means "distinct recipes," not "documents" -- every Trial
  // of the same Series is one recipe, not one each, so this groups by
  // Series (same as the list itself does once drilled in) before counting,
  // instead of just counting every recipe document in the category.
  const byCategory = new Map();
  recipes.forEach(r => {
    const cat = (r.productType||'').trim() || 'Uncategorized';
    if(!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(r);
  });
  const counts = new Map([...byCategory.entries()].map(([cat, list]) => [cat, groupRecipesBySeries(list).length]));
  const sorted = [...counts.entries()].sort((a,b) => a[0].localeCompare(b[0], undefined, {sensitivity:'base'}));
  return sorted.map(([cat, count]) => `
    <button type="button" class="recipe-category-tile" data-category="${escapeHtml(cat)}">
      <div class="recipe-category-tile-name">${escapeHtml(cat)}</div>
      <div class="recipe-category-tile-count">${count} recipe${count === 1 ? '' : 's'}</div>
    </button>
  `).join('');
}

export function renderRecipesListGrid(){
  const query = document.getElementById('recipesListSearchInput')?.value || '';
  const q = query.trim();
  const headerEl = document.getElementById('recipesListCategoryHeader');
  const catGridEl = document.getElementById('recipesListCategoryGrid');
  const listEl = document.getElementById('recipesListGrid');

  const showingCategoryTiles = !q && !recipesListCategoryFilter;
  catGridEl.style.display = showingCategoryTiles ? '' : 'none';
  listEl.style.display = showingCategoryTiles ? 'none' : '';

  if(showingCategoryTiles){
    headerEl.innerHTML = '';
    catGridEl.innerHTML = recipeCategoryTilesHtml();
    catGridEl.querySelectorAll('.recipe-category-tile').forEach(btn => {
      btn.addEventListener('click', () => {
        recipesListCategoryFilter = btn.dataset.category;
        renderRecipesListGrid();
      });
    });
    return;
  }

  headerEl.innerHTML = (!q && recipesListCategoryFilter) ? `
    <button type="button" class="btn btn-sm" id="btnBackToRecipeCategories" style="margin-bottom:10px;">${icon('chevron-left', 14)} All Categories</button>
    <div class="recipe-category-current">${escapeHtml(recipesListCategoryFilter)}</div>
  ` : '';
  const backBtn = document.getElementById('btnBackToRecipeCategories');
  if(backBtn) backBtn.addEventListener('click', () => { recipesListCategoryFilter = null; renderRecipesListGrid(); });

  // Typing a search query stays a flat filtered list across every recipe
  // (matches the sidebar's own search behavior) -- browsing a category with
  // no query groups its recipes by Series instead, so a Series' Trials can
  // be drilled into one at a time rather than all listed loose together.
  if(q){
    renderRecipeCards(listEl, query, null);
  } else {
    renderCategoryRecipeList(listEl, recipesListCategoryFilter);
  }
}
