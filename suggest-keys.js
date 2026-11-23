// Keyboard control for the custom suggestion dropdowns (.ing-suggestions): Arrow Down / Up move the highlight,
// Enter picks the highlighted one, Esc closes the list. Picking dispatches the same `mousedown` the mouse uses, so each
// dropdown's own selection code runs unchanged. `getBox` returns the dropdown element; `open` re-opens it on Arrow Down.
export function wireSuggestKeys(input, getBox, open){
  input.addEventListener('keydown', e => {
    if(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if(e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter' && e.key !== 'Escape') return;
    let box = getBox();
    let items = box && box.classList.contains('open') ? [...box.querySelectorAll('.ing-suggestion-item')] : [];
    if(!items.length){
      if(e.key === 'ArrowDown' && open){ e.preventDefault(); open(); box = getBox(); items = box && box.classList.contains('open') ? [...box.querySelectorAll('.ing-suggestion-item')] : []; if(items.length) mark(items, 0); }
      return;
    }
    const at = items.findIndex(i => i.classList.contains('active'));
    if(e.key === 'Escape'){
      e.preventDefault(); e.stopPropagation();
      box.classList.remove('open'); box.innerHTML = '';
      return;
    }
    if(e.key === 'Enter'){
      if(at < 0) return;   // nothing highlighted: Enter keeps doing what it did before
      e.preventDefault(); e.stopPropagation();
      items[at].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return;
    }
    e.preventDefault();
    const n = items.length;
    mark(items, e.key === 'ArrowDown' ? (at + 1) % n : (at <= 0 ? n - 1 : at - 1));
  });
}
function mark(items, idx){
  items.forEach((it, i) => it.classList.toggle('active', i === idx));
  items[idx].scrollIntoView({ block: 'nearest' });
}
