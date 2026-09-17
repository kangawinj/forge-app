// Monthly Update file attachments (upload/chip-list/preview modal) and
// the project-level Quotation/Specification document slots + their PDF
// first-page preview via pdf.js. Split out of projects.js -- see
// projects.js's own top-of-file comment for the overall file split.
import { escapeHtml, icon, uid, resizeImageFile, wireModalOverlayClose } from './app.js';
import { scheduleProjectSave, migrateMonthlyUpdate } from './projects-data.js';
// Circular import back to core projects.js -- safe, see trials-wizard.js's
// own comment on this same pattern (all cross-calls below happen inside
// event handlers, never at module-evaluation time).
import { renderProjectsList } from './projects.js';

// Activities Updates attachments — same "no Firebase Storage, base64 in the
// Firestore document" approach as every photo elsewhere in Forge. Images go
// through the same resize/compress used for photos so they stay small;
// non-image files (PDF/Word/Excel) can't be resized, so they're capped
// instead — the whole project document (name, products, every update, every
// attachment) has to fit Firestore's 1MB document limit. Raised from
// 300KB after that turned out too tight for real attachments (a 489KB
// .xlsx) -- worth remembering base64 inflates the stored size by ~1.37x,
// so this 700KB cap is really ~960KB inside the document once encoded,
// i.e. most of the whole 1MB budget for a single file. Don't raise this
// further without also reconsidering the per-document budget as a whole.
export const MU_ATTACHMENT_MAX_BYTES = 700 * 1024;
const MU_ATTACHMENT_IMAGE_MAX_DIM = 640;
export function readFileAsDataUrl(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}
export async function fileToMuAttachment(file){
  const isImage = file.type.startsWith('image/');
  if(isImage){
    const dataUrl = await resizeImageFile(file, MU_ATTACHMENT_IMAGE_MAX_DIM);
    return { id: uid(), name: file.name, dataUrl, isImage: true };
  }
  if(file.size > MU_ATTACHMENT_MAX_BYTES){
    throw new Error(`"${file.name}" is too big (${Math.round(file.size/1024)}KB) — files must be under ${Math.round(MU_ATTACHMENT_MAX_BYTES/1024)}KB`);
  }
  const dataUrl = await readFileAsDataUrl(file);
  return { id: uid(), name: file.name, dataUrl, isImage: false };
}

// Project-level Quotation/Specification document slots -- one file each,
// shown in the read-only project summary as an A4-proportioned preview
// (an image renders directly; a PDF's first page renders onto a <canvas>
// via pdf.js -- see renderProjectDocPreview below) rather than a small chip
// you have to click to see, like Activities' attachments below. Always
// interactive (not gated behind the project's own Edit toggle) -- attaching
// a supporting document doesn't need "unlock to edit" the way core project
// fields do, same reasoning as adding an Activities Update.
// Empty state stays a <label> wrapping the file input (click anywhere ->
// file picker). Once filled, the box itself opens the full-size preview
// popup (reusing the same modal Activities' attachments already use, and
// still the browser's own built-in PDF viewer there -- full toolbar is
// exactly what a "properly view this" popup should have) instead --
// re-uploading gets its own small icon so clicking the preview to look at
// it doesn't also risk silently replacing the file.
export function projectDocSlotHtml(attachment, slotKey, label){
  if(!attachment){
    return `
      <div class="project-doc-slot">
        <label class="project-doc-slot-box">
          <input type="file" class="project-doc-slot-input" data-doc-slot="${slotKey}" accept=".pdf,image/*" style="display:none;">
          <div class="project-doc-slot-empty">
            ${icon('upload', 28)}
            <span>Click to upload ${escapeHtml(label)}</span>
          </div>
        </label>
        <div class="project-doc-slot-caption">${escapeHtml(label)}</div>
      </div>
    `;
  }
  const preview = attachment.isImage
    ? `<img src="${escapeHtml(attachment.dataUrl)}" alt="${escapeHtml(attachment.name)}">`
    : `<canvas class="project-doc-slot-canvas" data-doc-slot="${slotKey}"></canvas>`;
  return `
    <div class="project-doc-slot">
      <div class="project-doc-slot-box" data-role="open-project-doc-preview" data-doc-slot="${slotKey}" title="Click to view">
        ${preview}
        <label class="project-doc-slot-replace" title="Replace file">
          <input type="file" class="project-doc-slot-input" data-doc-slot="${slotKey}" accept=".pdf,image/*" style="display:none;">
          ${icon('upload', 12)}
        </label>
        <button type="button" class="project-doc-slot-remove" data-role="remove-project-doc" data-doc-slot="${slotKey}" title="Remove">${icon('x', 12)}</button>
      </div>
      <div class="project-doc-slot-caption">${escapeHtml(label)}: ${escapeHtml(attachment.name)}</div>
    </div>
  `;
}
// `block` is the project's own detail-row element -- re-queried each call
// since renderProjectsList() rebuilds the DOM on every change, same as
// every other per-row wiring in this file.
let pdfJsWorkerInitialized = false;
export function initPdfJsWorker(){
  if(pdfJsWorkerInitialized || typeof pdfjsLib === 'undefined') return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  pdfJsWorkerInitialized = true;
}
// Renders a PDF's first page onto `canvas`, scaled to fully cover the
// canvas's own pixel dimensions (cropping evenly off both edges if the
// page's own aspect ratio isn't exactly the canvas's, same idea as CSS
// object-fit:cover) so the preview always fills the box edge to edge --
// see the pdf.js <script> comment in index.html for why this exists
// instead of just pointing an iframe at the PDF's data: URL (the browser's
// own built-in viewer always leaves a fixed margin around the page that no
// documented open-parameter can remove).
export async function renderProjectDocPreview(canvas, dataUrl){
  initPdfJsWorker();
  if(typeof pdfjsLib === 'undefined') return;
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  if(!cssWidth || !cssHeight) return;
  try{
    const pdf = await pdfjsLib.getDocument({ url: dataUrl }).promise;
    const page = await pdf.getPage(1);
    // Floor of 2x even on standard (dpr:1) screens -- at exactly 1:1 the
    // buffer only has as many pixels as the small on-screen box, which
    // reads soft for fine print like a quotation table; supersampling
    // gives pdf.js's own anti-aliasing more source detail to work with.
    const dpr = Math.max(window.devicePixelRatio || 1, 2);
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.max(canvas.width / baseViewport.width, canvas.height / baseViewport.height);
    const viewport = page.getViewport({ scale });
    const ctx = canvas.getContext('2d');
    // Centers the (necessarily-larger-than-canvas, on the cover axis)
    // rendered page so cropping trims evenly off both edges instead of
    // only the right/bottom.
    ctx.setTransform(1, 0, 0, 1, (canvas.width - viewport.width) / 2, (canvas.height - viewport.height) / 2);
    await page.render({ canvasContext: ctx, viewport }).promise;
  }catch(err){
    console.error('Forge: PDF preview render failed', err);
  }
}
export function wireProjectDocSlots(block, p){
  block.querySelectorAll('.project-doc-slot-canvas').forEach(canvas => {
    const attachment = p[canvas.dataset.docSlot];
    if(attachment) renderProjectDocPreview(canvas, attachment.dataUrl);
  });
  block.querySelectorAll('.project-doc-slot-input').forEach(input => {
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.value = '';
      if(!file) return;
      try{
        p[input.dataset.docSlot] = await fileToMuAttachment(file);
        scheduleProjectSave(p);
        renderProjectsList();
      }catch(err){
        alert(err.message || 'Could not attach that file.');
      }
    });
  });
  // The replace <label> sits inside the box that also opens the preview
  // popup on click -- stop the click from bubbling up to that handler so
  // choosing a new file doesn't also pop the preview open at the same time.
  block.querySelectorAll('.project-doc-slot-replace').forEach(label => {
    label.addEventListener('click', e => e.stopPropagation());
  });
  block.querySelectorAll('[data-role="open-project-doc-preview"]').forEach(boxEl => {
    boxEl.addEventListener('click', () => {
      const attachment = p[boxEl.dataset.docSlot];
      if(attachment) openMuAttachmentPreview([attachment], 0);
    });
  });
  block.querySelectorAll('[data-role="remove-project-doc"]').forEach(btn => {
    // preventDefault/stopPropagation so clicking remove doesn't also open
    // the file picker (empty state's <label>) or the preview popup (filled
    // state's click-to-open box).
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const label = btn.dataset.docSlot === 'quotationAttachment' ? 'Quotation' : 'Specification';
      if(!confirm(`Remove the ${label} document? This can't be undone.`)) return;
      p[btn.dataset.docSlot] = null;
      scheduleProjectSave(p);
      renderProjectsList();
    });
  });
}
// Shared by the popup modal, the inline add form, the inline edit form, and
// the read-only card — `editable` controls whether a remove (✕) button
// shows on each chip.
export function muAttachmentChipsHtml(attachments, editable){
  if(!attachments || !attachments.length) return '';
  return attachments.map(a => `
    <span class="mu-attachment-chip" data-attachment-id="${escapeHtml(a.id)}">
      <button type="button" class="mu-attachment-name" data-role="open-mu-attachment-preview" data-attachment-id="${escapeHtml(a.id)}" title="Click to preview">
        ${a.isImage
          ? `<img src="${escapeHtml(a.dataUrl)}" class="mu-attachment-thumb" alt="${escapeHtml(a.name)}">`
          : `<span class="mu-attachment-file-icon">${icon('file-text', 12)}</span>`}
        <span class="mu-attachment-name-text">${escapeHtml(a.name)}</span>
      </button>
      ${editable ? `<button type="button" class="mu-attachment-remove" data-role="remove-mu-attachment" data-attachment-id="${escapeHtml(a.id)}" title="Remove">${icon('x', 10)}</button>` : ''}
    </span>
  `).join('');
}
// Every attachment across every Activities Update on a project, newest
// entry first — powers the project summary's consolidated "Attachments"
// section, so a file doesn't only turn up by scrolling through each
// individual update looking for it.
export function allProjectAttachments(p){
  return [...(p.monthlyUpdates || [])]
    .sort((a,b) => (b.date||'').localeCompare(a.date||'') || (b.createdAt||0) - (a.createdAt||0))
    .flatMap(mu => migrateMonthlyUpdate(mu).attachments || []);
}

// Wires a file input + its sibling chip-list container so picking files
// stages them into `draftArrayGetter()`'s array and redraws just that
// container — never a full renderProjectsList(), which would wipe out
// whatever the user is mid-typing in the Plan/Action Taken/Next Action
// fields of the very same form.
export function wireMuAttachmentEditor(container, draftArrayGetter, onChange){
  const input = container.querySelector('.mu-attach-input');
  const chipList = container.querySelector('.mu-attachments-chiplist');
  if(!input || !chipList) return;
  const redraw = () => {
    chipList.innerHTML = muAttachmentChipsHtml(draftArrayGetter(), true);
    chipList.querySelectorAll('[data-role="remove-mu-attachment"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const arr = draftArrayGetter();
        const idx = arr.findIndex(a => a.id === btn.dataset.attachmentId);
        if(idx !== -1) arr.splice(idx, 1);
        redraw();
      });
    });
    chipList.querySelectorAll('[data-role="open-mu-attachment-preview"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const arr = draftArrayGetter();
        const idx = arr.findIndex(a => a.id === btn.dataset.attachmentId);
        if(idx !== -1) openMuAttachmentPreview(arr, idx);
      });
    });
  };
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.value = '';
    for(const file of files){
      try{
        draftArrayGetter().push(await fileToMuAttachment(file));
      }catch(err){
        alert(err.message || 'Could not attach that file.');
      }
    }
    redraw();
    onChange?.();
  });
  redraw();
}

// Attachment Preview popup — a click on an attachment chip's name/thumbnail
// (editable draft, popup modal, or the read-only saved card) opens this
// instead of the browser just downloading the data URI straight away.
// Images render inline, PDFs render in an iframe (browsers can display
// those natively), anything else (Word/Excel/CSV) falls back to a plain
// Download button since there's no way to render those in a browser tab.
// Prev/Next cycles through every attachment on the same entry.
let muAttachmentPreviewContext = null; // { attachments, index }
export function openMuAttachmentPreview(attachments, index){
  if(!attachments || !attachments.length) return;
  muAttachmentPreviewContext = { attachments, index: Math.max(0, Math.min(index, attachments.length - 1)) };
  renderMuAttachmentPreview();
  document.getElementById('muAttachmentPreviewModalOverlay').classList.add('open');
}
function closeMuAttachmentPreview(){
  document.getElementById('muAttachmentPreviewModalOverlay').classList.remove('open');
  muAttachmentPreviewContext = null;
}
function renderMuAttachmentPreview(){
  if(!muAttachmentPreviewContext) return;
  const { attachments, index } = muAttachmentPreviewContext;
  const a = attachments[index];
  document.getElementById('muAttachmentPreviewTitle').textContent = a.name;
  const body = document.getElementById('muAttachmentPreviewBody');
  const isPdf = a.dataUrl.startsWith('data:application/pdf');
  if(a.isImage){
    body.innerHTML = `<img src="${escapeHtml(a.dataUrl)}" alt="${escapeHtml(a.name)}" class="mu-attachment-preview-img">`;
  }else if(isPdf){
    body.innerHTML = `<iframe src="${escapeHtml(a.dataUrl)}" class="mu-attachment-preview-frame" title="${escapeHtml(a.name)}"></iframe>`;
  }else{
    body.innerHTML = `<div class="mu-attachment-preview-fallback">${icon('file-text', 40)}<p>This file type can't be previewed here — use Download to open it.</p></div>`;
  }
  document.getElementById('muAttachmentPreviewCounter').textContent = attachments.length > 1 ? `${index + 1} / ${attachments.length}` : '';
  document.getElementById('btnMuAttachmentPreviewPrev').style.visibility = attachments.length > 1 ? 'visible' : 'hidden';
  document.getElementById('btnMuAttachmentPreviewNext').style.visibility = attachments.length > 1 ? 'visible' : 'hidden';
  const downloadBtn = document.getElementById('btnMuAttachmentPreviewDownload');
  downloadBtn.href = a.dataUrl;
  downloadBtn.download = a.name;
}
function muAttachmentPreviewStep(delta){
  if(!muAttachmentPreviewContext) return;
  const { attachments } = muAttachmentPreviewContext;
  muAttachmentPreviewContext.index = (muAttachmentPreviewContext.index + delta + attachments.length) % attachments.length;
  renderMuAttachmentPreview();
}
export function initMuAttachmentPreviewModal(){
  document.getElementById('btnCloseMuAttachmentPreview').addEventListener('click', closeMuAttachmentPreview);
  wireModalOverlayClose('muAttachmentPreviewModalOverlay', closeMuAttachmentPreview);
  document.getElementById('btnMuAttachmentPreviewPrev').addEventListener('click', () => muAttachmentPreviewStep(-1));
  document.getElementById('btnMuAttachmentPreviewNext').addEventListener('click', () => muAttachmentPreviewStep(1));
}
