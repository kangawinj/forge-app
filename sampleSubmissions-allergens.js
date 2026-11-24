// Allergen Statement cell of the samples table: chips for what is selected, and a "+ Add" button that opens a list of the
// Food Allergens categories to tick (several at once) -- anything else can be typed in and added with Enter. The value is kept as
// a comma-joined string, the same shape the Product List uses.
import { escapeHtml, icon, FOOD_ALLERGEN_COLUMNS } from './app.js';

export const splitAllergens = v => String(v || '').split(',').map(a => a.trim()).filter(Boolean);
export function allergenCellHtml(value, editing){
  const list = splitAllergens(value);
  return `<div class="ssub-chips">${list.map(a => `<span class="ssub-chip">${escapeHtml(a)}${editing ? `<button type="button" class="ssub-chip-x" data-name="${escapeHtml(a)}" title="Remove">${icon('x', 11)}</button>` : ''}</span>`).join('')}${list.length || editing ? '' : '-'}${editing ? '<button type="button" class="ssub-allergen-add">+ Add</button>' : ''}</div>`;
}
export function closeAllergenPopover(){ document.getElementById('ssubAllergenPop')?.remove(); }

// anchor: the "+ Add" button; getList/setList read and write the selected names (array)
export function openAllergenPopover(anchor, getList, setList){
  closeAllergenPopover();
  const pop = document.createElement('div');
  pop.id = 'ssubAllergenPop';
  pop.className = 'ssub-allergen-pop';
  const has = (list, a) => list.some(x => x.toLowerCase() === a.toLowerCase());
  const build = (keepSearch) => {
    const sel = getList();
    const all = [...FOOD_ALLERGEN_COLUMNS, ...sel.filter(a => !has(FOOD_ALLERGEN_COLUMNS, a))];
    pop.innerHTML = `<input type="text" class="ssub-allergen-search" value="${escapeHtml(keepSearch || '')}" placeholder="Search, or type your own and press Enter" autocomplete="off">
      <div class="ssub-allergen-list">${all.map(a => `<label class="ssub-allergen-opt" data-name="${escapeHtml(a.toLowerCase())}"><input type="checkbox" value="${escapeHtml(a)}"${has(sel, a) ? ' checked' : ''}> ${escapeHtml(a)}</label>`).join('')}</div>`;
    const search = pop.querySelector('.ssub-allergen-search');
    const filter = () => { const q = search.value.trim().toLowerCase(); pop.querySelectorAll('.ssub-allergen-opt').forEach(l => { l.style.display = !q || l.dataset.name.includes(q) ? '' : 'none'; }); };
    search.addEventListener('input', filter);
    search.addEventListener('keydown', e => {
      if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); closeAllergenPopover(); return; }
      if(e.key !== 'Enter') return;
      e.preventDefault();
      const v = search.value.trim();
      if(!v) return;
      const cur = getList();
      if(!has(cur, v)) setList([...cur, (all.find(a => a.toLowerCase() === v.toLowerCase()) || v)]);
      build('');
      pop.querySelector('.ssub-allergen-search').focus();
    });
    pop.querySelectorAll('.ssub-allergen-opt input').forEach(cb => cb.addEventListener('change', () => {
      const cur = getList();
      setList(cb.checked ? (has(cur, cb.value) ? cur : [...cur, cb.value]) : cur.filter(a => a.toLowerCase() !== cb.value.toLowerCase()));
    }));
    filter();
  };
  build('');
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.left, window.innerWidth - 270) + 'px';
  const below = window.innerHeight - r.bottom;
  if(below < 300 && r.top > below){ pop.style.bottom = (window.innerHeight - r.top + 4) + 'px'; } else { pop.style.top = (r.bottom + 4) + 'px'; }
  pop.querySelector('.ssub-allergen-search').focus();
  const off = e => { if(!pop.contains(e.target) && e.target !== anchor){ closeAllergenPopover(); document.removeEventListener('mousedown', off, true); window.removeEventListener('scroll', closeOnScroll, true); } };
  const closeOnScroll = e => { if(pop.contains(e.target)) return; closeAllergenPopover(); document.removeEventListener('mousedown', off, true); window.removeEventListener('scroll', closeOnScroll, true); };
  setTimeout(() => { document.addEventListener('mousedown', off, true); window.addEventListener('scroll', closeOnScroll, true); }, 0);
}
