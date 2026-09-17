// Process Flowchart -- the freeform drag/drop node-and-edge editor, the
// alternative view to the numbered Process Steps list. Split out of
// recipes.js (which grew past 3,400 lines even after its first split) --
// see recipes.js's own top-of-file comment for the overall file split.
import { escapeHtml, icon, uid } from './app.js';
import {
  DEFAULT_FLOW_NODE_W, nextFlowNodeLabel, blankFlowNode, computeFlowNodeText,
  rectOf, clipToRectEdge, FLOW_ARROWHEAD_DEFS
} from './recipes-data.js';
// Circular import back to core recipes.js -- safe, same pattern proven
// throughout this session's other splits: every cross-call below happens
// inside an event handler, never at module-evaluation time.
import { scheduleSave, renderParts } from './recipes.js';

/* ---------- Process Flowchart (freeform alternative to the numbered Steps
   list — one shared canvas per recipe, not per Process entry) ----------
   The first freeform/draggable-node/connector-line UI in this app; there's
   no existing precedent to extend, so the drag and edge-drawing mechanics
   below are built from scratch. Everything else (data shape, save-on-edit,
   full-rebuild render style) follows the same conventions as the rest of
   the file. */

// Module-level "what's currently being manipulated" state, same discipline
// as dragPayload in core: always reset to null on every exit path (success
// or cancel) of its gesture, never left dangling.
let flowNodeDrag = null; // { r, node, el, startClientX, startClientY, startX, startY }
let flowEdgeDraw = null; // { r, fromNode, fromEl, currentClientX, currentClientY }

export function addFlowNode(r){
  const scrollEl = document.getElementById('flowchartCanvasScroll');
  let x = 40, y = 40;
  if(scrollEl){
    // Drops the new node inside whatever part of the canvas is currently
    // scrolled into view, cascading slightly on repeated clicks so new
    // nodes don't stack exactly on top of each other.
    const count = r.processFlowchart.nodes.length;
    x = scrollEl.scrollLeft + 40 + (count % 5) * 24;
    y = scrollEl.scrollTop + 40 + (count % 5) * 24;
  }
  r.processFlowchart.nodes.push(blankFlowNode(nextFlowNodeLabel(r.processFlowchart.nodes), x, y));
  renderProcessFlowchart(r);
  renderParts(r); // refreshes every ingredient row's link-selector options
  scheduleSave();
}

// Recursive (mirrors migratePart's own recursion) so a node deleted while
// linked from an ingredient nested inside a Sub-part still gets cleared.
function clearFlowLinksToNode(parts, nodeId){
  (parts || []).forEach(part => {
    (part.ingredients || []).forEach(ing => {
      if(ing.flowNodeId === nodeId) ing.flowNodeId = null;
    });
    clearFlowLinksToNode(part.parts, nodeId);
  });
}

function deleteFlowNode(r, nodeId){
  const idx = r.processFlowchart.nodes.findIndex(n => n.id === nodeId);
  if(idx === -1) return;
  r.processFlowchart.nodes.splice(idx, 1);
  r.processFlowchart.edges = r.processFlowchart.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
  clearFlowLinksToNode(r.parts, nodeId);
  renderProcessFlowchart(r);
  renderParts(r);
  scheduleSave();
}

function addFlowEdge(r, fromId, toId){
  if(!fromId || !toId || fromId === toId) return;
  const exists = r.processFlowchart.edges.some(e => e.from === fromId && e.to === toId);
  if(exists) return;
  r.processFlowchart.edges.push({ id: uid(), from: fromId, to: toId });
}

export function deleteFlowEdge(r, edgeId){
  const idx = r.processFlowchart.edges.findIndex(e => e.id === edgeId);
  if(idx === -1) return;
  r.processFlowchart.edges.splice(idx, 1);
  redrawFlowEdges(r);
  scheduleSave();
}

// Recomputes every edge's SVG path from the CURRENT rendered node
// positions (so a dragged node's edges always follow it, with no separate
// "commit" step) — cheap enough to just redo all of them on every move
// rather than tracking which edges touch the node being dragged. Pass
// `ghost` (the in-progress flowEdgeDraw state) while a new edge is being
// drawn, to also show a dashed preview line following the pointer.
function redrawFlowEdges(r, ghost){
  const svg = document.getElementById('flowEdgesSvg');
  const layer = document.getElementById('flowNodesLayer');
  if(!svg || !layer) return;
  let html = FLOW_ARROWHEAD_DEFS;
  (r.processFlowchart.edges || []).forEach(edge => {
    const fromEl = layer.querySelector(`[data-node-id="${edge.from}"]`);
    const toEl = layer.querySelector(`[data-node-id="${edge.to}"]`);
    if(!fromEl || !toEl) return; // defensive: a dangling edge shouldn't be possible, but never crash on one
    const fromRect = rectOf(fromEl), toRect = rectOf(toEl);
    const fromCenter = { x: fromRect.x + fromRect.w/2, y: fromRect.y + fromRect.h/2 };
    const toCenter = { x: toRect.x + toRect.w/2, y: toRect.y + toRect.h/2 };
    const start = clipToRectEdge(fromRect, toCenter);
    const end = clipToRectEdge(toRect, fromCenter);
    // Two overlapping paths per edge: a wide invisible one first (an easy
    // click target, via CSS pointer-events:stroke) then the thin visible
    // line on top — a CSS ":hover + selector" rule alone highlights the
    // visible line on hover, no JS hover wiring needed.
    html += `<path class="flow-edge-hit" data-edge-id="${edge.id}" d="M${start.x},${start.y} L${end.x},${end.y}"></path>`;
    html += `<path class="flow-edge-line" d="M${start.x},${start.y} L${end.x},${end.y}" marker-end="url(#flowArrowhead)"></path>`;
  });
  if(ghost){
    const scrollEl = document.getElementById('flowchartCanvasScroll');
    const scrollRect = scrollEl.getBoundingClientRect();
    const endX = ghost.currentClientX - scrollRect.left + scrollEl.scrollLeft;
    const endY = ghost.currentClientY - scrollRect.top + scrollEl.scrollTop;
    const start = clipToRectEdge(rectOf(ghost.fromEl), { x: endX, y: endY });
    html += `<path class="flow-ghost-edge" d="M${start.x},${start.y} L${endX},${endY}"></path>`;
  }
  svg.innerHTML = html;
}

// Grows the canvas surface to fit every node + margin. Coordinates never
// go negative (see onFlowPointerMove) so growth is always one-directional
// (right/down) — the surface only re-tightens back down on the next full
// renderProcessFlowchart() rebuild, not instantly as a node is dragged
// back toward the origin.
function resizeFlowCanvasToFitNodes(){
  const canvas = document.getElementById('flowchartCanvas');
  const scrollEl = document.getElementById('flowchartCanvasScroll');
  if(!canvas || !scrollEl) return;
  let maxRight = 0, maxBottom = 0;
  canvas.querySelectorAll('.flow-node').forEach(el => {
    maxRight = Math.max(maxRight, el.offsetLeft + el.offsetWidth);
    maxBottom = Math.max(maxBottom, el.offsetTop + el.offsetHeight);
  });
  canvas.style.width = Math.max(maxRight + 200, scrollEl.clientWidth) + 'px';
  canvas.style.height = Math.max(maxBottom + 200, 400) + 'px';
}

// Full rebuild of the nodes layer + edges — deliberately lazy: bails out
// unless Flowchart view is genuinely visible right now. offsetWidth/
// offsetHeight all read 0 on elements inside a display:none ancestor, so
// building this eagerly while List view is active would silently draw
// every node collapsed at 0x0. refreshProcessViewMode always flips
// visibility BEFORE calling this, so by the time it runs the container is
// real and measurable.
function renderProcessFlowchart(r){
  const layer = document.getElementById('flowNodesLayer');
  if(!layer || r.processViewMode !== 'flowchart') return;

  layer.innerHTML = '';
  (r.processFlowchart.nodes || []).forEach(node => {
    const el = document.createElement('div');
    el.className = 'flow-node';
    el.dataset.nodeId = node.id;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    el.style.width = (node.w || DEFAULT_FLOW_NODE_W) + 'px';
    el.innerHTML = `
      <div class="flow-connector-dot top"></div>
      <div class="flow-connector-dot right"></div>
      <div class="flow-connector-dot bottom"></div>
      <div class="flow-connector-dot left"></div>
      <div class="flow-node-strip">
        ${icon('move', 12)}
        <input type="text" class="flow-node-label" maxlength="6">
        <button type="button" class="icon-btn" title="Delete this node">${icon('x')}</button>
      </div>
      <select class="flow-node-link" title="Link this node to a Process from the List view — its text then stays in sync with that Process's title/steps"></select>
      <textarea class="flow-node-text" rows="1" placeholder="Step / group name..."></textarea>
    `;
    // Appended before any scrollHeight-dependent measurement below — a
    // detached element (not yet in the document) can't report real layout.
    layer.appendChild(el);

    const labelInput = el.querySelector('.flow-node-label');
    labelInput.value = node.label || '';
    labelInput.addEventListener('input', e => {
      node.label = e.target.value;
      renderParts(r); // keeps every ingredient row's link-selector option text in sync
      scheduleSave();
    });

    const textArea = el.querySelector('.flow-node-text');
    function autoGrowFlowTextarea(){
      textArea.style.height = 'auto';
      textArea.style.height = textArea.scrollHeight + 'px';
    }
    // Reflects the node's current linked/unlinked state: linked shows the
    // live-derived text read-only (edit the actual Process in List view
    // instead — editing it here would just be silently overwritten the
    // next render), unlinked is a normal free-typed field.
    function refreshTextAreaFromLinkState(){
      textArea.value = computeFlowNodeText(node, r.processes);
      textArea.disabled = !!node.linkedProcessId;
      autoGrowFlowTextarea();
    }
    refreshTextAreaFromLinkState();
    textArea.addEventListener('input', e => {
      node.text = e.target.value;
      autoGrowFlowTextarea();
      resizeFlowCanvasToFitNodes();
      redrawFlowEdges(r);
      scheduleSave();
    });

    const linkSelect = el.querySelector('.flow-node-link');
    linkSelect.innerHTML = `<option value="">— Free text —</option>` +
      (r.processes || []).map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.title || 'Untitled process')}</option>`).join('');
    linkSelect.value = node.linkedProcessId || '';
    linkSelect.addEventListener('change', e => {
      node.linkedProcessId = e.target.value || null;
      refreshTextAreaFromLinkState();
      resizeFlowCanvasToFitNodes();
      redrawFlowEdges(r);
      scheduleSave();
    });

    el.querySelector('.flow-node-strip').addEventListener('pointerdown', e => {
      if(e.target.closest('.flow-node-label, .icon-btn')) return;
      startFlowNodeDrag(r, node, el, e);
    });
    el.querySelectorAll('.flow-connector-dot').forEach(dot => {
      dot.addEventListener('pointerdown', e => {
        e.stopPropagation(); // don't also start a node-drag from the same pointerdown
        startFlowEdgeDraw(r, node, el, e);
      });
    });
    el.querySelector('.icon-btn').addEventListener('click', () => deleteFlowNode(r, node.id));
  });

  resizeFlowCanvasToFitNodes();
  redrawFlowEdges(r);
}

function startFlowNodeDrag(r, node, el, e){
  flowNodeDrag = { r, node, el, startClientX: e.clientX, startClientY: e.clientY, startX: node.x, startY: node.y };
  el.classList.add('dragging');
}

function startFlowEdgeDraw(r, node, el, e){
  flowEdgeDraw = { r, fromNode: node, fromEl: el, currentClientX: e.clientX, currentClientY: e.clientY };
}

function onFlowPointerMove(e){
  if(flowNodeDrag){
    const d = flowNodeDrag;
    d.node.x = Math.max(0, Math.round(d.startX + (e.clientX - d.startClientX)));
    d.node.y = Math.max(0, Math.round(d.startY + (e.clientY - d.startClientY)));
    d.el.style.left = d.node.x + 'px';
    d.el.style.top = d.node.y + 'px';
    resizeFlowCanvasToFitNodes();
    redrawFlowEdges(d.r);
  } else if(flowEdgeDraw){
    flowEdgeDraw.currentClientX = e.clientX;
    flowEdgeDraw.currentClientY = e.clientY;
    redrawFlowEdges(flowEdgeDraw.r, flowEdgeDraw);
  }
}
function onFlowPointerUp(e){
  if(flowNodeDrag){
    flowNodeDrag.el.classList.remove('dragging');
    flowNodeDrag = null;
    scheduleSave();
  } else if(flowEdgeDraw){
    const { r, fromNode } = flowEdgeDraw;
    const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.flow-node');
    flowEdgeDraw = null; // cleared before branching, so it can never leak on an early return
    const toId = targetEl?.dataset.nodeId;
    if(toId && toId !== fromNode.id) addFlowEdge(r, fromNode.id, toId);
    redrawFlowEdges(r);
    scheduleSave();
  }
}
document.addEventListener('pointermove', onFlowPointerMove);
document.addEventListener('pointerup', onFlowPointerUp);

export function setProcessViewMode(r, mode){
  r.processViewMode = mode;
  refreshProcessViewMode(r);
  scheduleSave();
}

export function refreshProcessViewMode(r){
  const listWrap = document.getElementById('processesListWrap');
  const flowWrap = document.getElementById('flowchartCanvasWrap');
  const toggleWrap = document.getElementById('processViewToggle');
  if(!listWrap || !flowWrap) return;
  const isFlow = r.processViewMode === 'flowchart';
  listWrap.classList.toggle('process-view-hidden', isFlow);
  flowWrap.classList.toggle('process-view-hidden', !isFlow);
  if(toggleWrap){
    toggleWrap.querySelectorAll('.view-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === r.processViewMode);
    });
  }
  if(isFlow) renderProcessFlowchart(r); // container is now genuinely visible — safe to measure/build
}
