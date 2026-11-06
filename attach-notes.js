// A short note under every place where a file or photo can be attached, saying how much it accepts. The pages draw
// their attach buttons in many different templates, so instead of editing each one this watches for file inputs and
// adds the matching note. The limits are the ones the code enforces -- keep both in step when one changes:
//   photos   -> resizeImageFile(file, N) shrinks any photo to N px (so the original size does not matter); the counts
//               are TRIAL_PHOTO_MAX / EVAL_COMMENT_PHOTO_MAX / PROJ_REF_IMAGE_MAX / the per-field checks
//   files    -> MU_ATTACHMENT_MAX_BYTES (projects-attachments.js) = 700 KB each, inside Firestore's 1 MB per document
//   Excel    -> trials-sheets.js (MAX_ROWS / MAX_COLS / MAX_IMAGES / MAX_FILE_JSON)
const photo = (count, px) => `${count}; any size is fine -- photos are shrunk automatically (${px} px).`;
const RULES = [
  ['.mu-attach-input[accept="image/*"]', 'Up to 6 photos; any size is fine -- photos are shrunk automatically (640 px).'],
  ['.mu-attach-input', 'Photos: any size, shrunk automatically (640 px). PDF / Word / Excel / CSV: under 700 KB each. Everything in one project must stay under 1 MB in total.'],
  ['.project-doc-slot-input', 'One file: a PDF under 700 KB, or a photo (any size, shrunk automatically to 640 px).'],
  ['#newProjImageInput, .proj-image-input', photo('1 photo', 400)],
  ['.proj-ref-image-input', photo('Up to 6 photos', 640)],
  ['.trial-product-photo-input', photo('Up to 4 photos per product', 500)],
  ['.review-photo-input', photo('Up to 2 photos', 500)],
  ['.preview-photo-input, .eval-review-photo-input', photo('Up to 5 photos', 500)],
  ['#descPhotoInput', photo('Up to 3 photos', 500)],
  ['.proc-photo-input', photo('Up to 2 photos per step', 500)],
  ['#mf-image', photo('1 photo', 200)],
  ['#pf-rmImage, #pf-ideaMenuImage', photo('1 photo per box', 600)],
  ['#rcfLogoInput, #refListNewImageInput, .reflist-company-logo-input', photo('1 logo', 200)],
  ['#myProfileImageInput', photo('1 photo', 300)],
  ['[data-role="import-trial-sheet"]', '.xlsx only. Up to 500 rows x 40 columns per sheet and 60 pictures (pictures are shrunk automatically); once stored, the file must come to under about 600 KB.']
];

function decorate(){
  document.querySelectorAll('input[type="file"]:not([data-attach-noted])').forEach(input => {
    const rule = RULES.find(([sel]) => input.matches(sel));
    if(!rule) return;
    input.dataset.attachNoted = '1';
    // the visible control: the button-like <label> the input sits in, otherwise the input itself
    const anchor = input.closest('label') || input;
    const note = document.createElement('div');
    note.className = 'attach-note';
    note.textContent = rule[1];
    anchor.insertAdjacentElement('afterend', note);
    // inside a one-line row, give the note a line of its own instead of squeezing the neighbours
    const parent = note.parentElement;
    if(parent){
      const cs = getComputedStyle(parent);
      if(cs.display.includes('flex') && cs.flexDirection.startsWith('row')) parent.style.flexWrap = 'wrap';
    }
  });
}
let queued = false;
new MutationObserver(() => {
  if(queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; decorate(); });
}).observe(document.documentElement, { childList: true, subtree: true });
decorate();
