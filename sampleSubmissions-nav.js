// Excel-like keyboard movement in the samples table: the arrow keys (and Enter, which goes down) move from cell to cell and put
// the cursor in the next box with its text selected, ready to type over. Inside a text box Left / Right only leave it when the
// cursor is already at that end, so the text can still be edited with them; a drop-down keeps Up / Down for its options.
export function wireGridKeys(container){
  container.addEventListener('keydown', e => {
    if(e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const el = e.target;
    if(!el.closest || !el.closest('.ssub-sample-grid')) return;
    const key = e.key;
    if(!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(key)) return;
    const td = el.closest('td');
    if(!td) return;
    const tag = el.tagName, type = el.type;
    if(tag === 'BUTTON') return;
    if(tag === 'SELECT' && (key === 'ArrowUp' || key === 'ArrowDown')) return;
    if(tag === 'TEXTAREA' && key === 'Enter') return;
    if(type === 'date' && (key === 'ArrowLeft' || key === 'ArrowRight')) return;
    const hasCaret = (tag === 'INPUT' && typeof el.selectionStart === 'number') || tag === 'TEXTAREA';
    if(hasCaret && (key === 'ArrowLeft' || key === 'ArrowRight')){
      const len = el.value.length, a = el.selectionStart, b = el.selectionEnd;
      const whole = a === 0 && b === len;
      if(!(whole || (a === b && (key === 'ArrowLeft' ? a === 0 : a === len)))) return;
    }
    if(tag === 'TEXTAREA' && (key === 'ArrowUp' || key === 'ArrowDown')){
      const a = el.selectionStart, b = el.selectionEnd;
      if(a !== b) return;
      const before = el.value.slice(0, a), after = el.value.slice(a);
      if(key === 'ArrowUp' && before.includes('\n')) return;
      if(key === 'ArrowDown' && after.includes('\n')) return;
    }
    const tr = td.parentElement;
    const col = [...tr.children].indexOf(td);
    const focusable = cell => cell && cell.querySelector('input:not([type="hidden"]), textarea, select, .ssub-allergen-add');
    let target = null;
    if(key === 'ArrowLeft' || key === 'ArrowRight'){
      const step = key === 'ArrowLeft' ? -1 : 1;
      for(let c = col + step; c >= 0 && c < tr.children.length && !target; c += step) target = focusable(tr.children[c]);
    }else{
      const row = key === 'ArrowUp' ? tr.previousElementSibling : tr.nextElementSibling;
      target = row ? focusable(row.children[col]) : null;
    }
    e.preventDefault();
    if(!target) return;
    target.focus();
    if(target.tagName === 'INPUT' && target.type !== 'number' && target.type !== 'date' && target.select) target.select();
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}
