// Requirements / Certificate / Cooking Condition / Reference Images --
// the structured shape behind a project's Requirements box, plus the
// small render helpers shared by every place it's edited (Submit Review
// modal, New Project panel, main project edit view). Split out of
// projects.js -- see projects.js's own top-of-file comment for the
// overall file split.
import { escapeHtml, icon, resizeImageFile, uid } from './app.js';

// The 6 field-name prefixes recognized in legacy free-text `requirements`
// blobs (see parseLegacyRequirements) -- the exact labels already typed by
// hand across existing projects, e.g. "Packaging condition: Microwaveable
// black plastic tray".
export const REQUIREMENTS_FIELD_DEFS = [
  { key: 'flavorFilling',      re: /^\s*flavor\s+or\s+filling\s*:/i },
  { key: 'composition',        re: /^\s*composition\s*:/i },
  { key: 'recipe',             re: /^\s*recipe\s*:/i },
  { key: 'packagingCondition', re: /^\s*packaging\s+condition\s*:/i },
  { key: 'cookingCondition',   re: /^\s*cooking\s+condition\s*:/i },
  { key: 'certificate',        re: /^\s*certificate\s*:/i }
];

export function blankRequirements(){
  return { flavorFilling:'', composition:'', recipe:'', packagingCondition:'', storageCondition:'', shelfLife:'', cookingCondition: [blankCookingCondition()], certificate:'', note:'', referenceImages: [], recipeAttachments: [] };
}

// Each entry is { id, dataUrl, caption } -- the "Idea / Reference Images"
// gallery at the top of the Requirements box (up to 3, see
// PROJ_REF_IMAGE_MAX / fileToProjRefImage below). A brand new image starts
// with its own filename (extension stripped) as the caption, since
// that's usually a more useful starting point than a generic label --
// still a plain text input afterward, so it can be retyped to whatever
// the photo actually shows. Falls back to PROJ_REF_IMAGE_DEFAULT_CAPTION
// on the rare file with no usable name.
const PROJ_REF_IMAGE_DEFAULT_CAPTION = 'Idea / Ref. Photo';
export const PROJ_REF_IMAGE_MAX = 6;
const PROJ_REF_IMAGE_MAX_DIM = 640;
export async function fileToProjRefImage(file){
  const dataUrl = await resizeImageFile(file, PROJ_REF_IMAGE_MAX_DIM);
  const caption = (file.name || '').replace(/\.[^./\\]+$/, '').trim() || PROJ_REF_IMAGE_DEFAULT_CAPTION;
  return { id: uid(), dataUrl, caption };
}
// Shared by the read-only card and the editable draft -- `isEditing`
// controls whether each photo gets a remove (x) button and its caption
// renders as a text input instead of plain text.
export function projRefImagesHtml(images, isEditing){
  if(!images || !images.length) return '';
  return `<div class="proj-ref-images-grid">${images.map(img => `
    <div class="proj-ref-image-item">
      <div class="proj-ref-image-thumb-wrap">
        <img src="${escapeHtml(img.dataUrl)}" class="proj-ref-image-thumb" alt="${escapeHtml(img.caption || 'Reference image')}">
        ${isEditing ? `<button type="button" class="proj-ref-image-remove" data-role="remove-ref-image" data-ref-image-id="${escapeHtml(img.id)}" title="Remove">${icon('x', 12)}</button>` : ''}
      </div>
      ${isEditing
        ? `<input type="text" class="proj-ref-image-caption-input" data-ref-image-id="${escapeHtml(img.id)}" value="${escapeHtml(img.caption || '')}" placeholder="Caption">`
        : (img.caption ? `<div class="proj-ref-image-caption">${escapeHtml(img.caption)}</div>` : '')}
    </div>
  `).join('')}</div>`;
}

// One Cooking Guidelines group -- a project/submission can have several
// (e.g. "Stove Top" and "Microwave" each with their own steps), see
// getCookingConditions below.
export function blankCookingCondition(){
  return { id: uid(), method: '', steps: [] };
}

// Normalizes requirements.cookingCondition into an ARRAY of {id, method,
// steps} groups, whatever shape it currently is in -- already an array
// (a project/submission saved under this multi-group shape), a single
// {method, steps} object (every project/submission saved before
// multi-group support, including every submission from the public
// submit.html page, which still only ever writes one group), or a
// legacy plain string (either newline-joined, from
// parseLegacyRequirements' old free-text parsing, or arrow-joined, from
// an earlier iteration of the Cooking Condition autofill that stored one
// flat string). Never drops data, and always returns at least one group
// so the UI always has a first row to render/edit into.
export function getCookingConditions(cc){
  const normalizeGroup = g => ({ id: g?.id || uid(), method: g?.method || '', steps: Array.isArray(g?.steps) ? g.steps : [] });
  if(Array.isArray(cc)) return cc.length ? cc.map(normalizeGroup) : [blankCookingCondition()];
  if(cc && typeof cc === 'object') return [normalizeGroup(cc)];
  const text = (cc || '').trim();
  if(!text) return [blankCookingCondition()];
  return [{ id: uid(), method: '', steps: text.split(/\n|→/).map(s => s.trim()).filter(Boolean) }];
}

// Parses the free-text `requirements` blob that older/unedited projects
// still have in Firestore into the 6 structured fields, plus a `note`
// catch-all for anything that doesn't match a known "Label:" prefix (a
// leading preamble, a typo'd label, etc.) so nothing is ever silently
// dropped. A field's content can span multiple following lines -- each
// line is tested against every known prefix; a non-matching line is
// treated as a continuation of whichever field is currently "open" (or
// falls into `note` if no field is open yet).
export function parseLegacyRequirements(text){
  const result = blankRequirements();
  if(!text) return result;
  const buffers = { flavorFilling:[], composition:[], recipe:[], packagingCondition:[], cookingCondition:[], certificate:[], note:[] };
  let currentKey = null;
  String(text).split(/\r\n|\r|\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if(line === '') return;
    const match = REQUIREMENTS_FIELD_DEFS.find(def => def.re.test(rawLine));
    if(match){
      currentKey = match.key;
      const inline = rawLine.replace(match.re, '').trim();
      if(inline) buffers[currentKey].push(inline);
    } else {
      buffers[currentKey || 'note'].push(line);
    }
  });
  REQUIREMENTS_FIELD_DEFS.forEach(def => { result[def.key] = buffers[def.key].join('\n'); });
  result.note = buffers.note.join('\n');
  return result;
}

// Requirements' Certificate field -- a checklist (per the user's request,
// same idea as Sample Submissions' Docs Request) instead of free text.
// "Other" covers anything not in this fixed list without needing a new
// checkbox added here every time a one-off certificate comes up.
export const CERTIFICATE_TYPES = [
  { key: 'halal', label: 'Halal' },
  { key: 'haccp', label: 'HACCP' },
  { key: 'gmp', label: 'GMP' },
  { key: 'brc', label: 'BRC' },
  { key: 'kosher', label: 'Kosher' },
  { key: 'iso22000', label: 'ISO 22000' }
];
export function blankCertificate(){
  const c = { other: false, otherDetails: '' };
  CERTIFICATE_TYPES.forEach(t => { c[t.key] = false; });
  return c;
}
// A project saved before Certificate became a checklist has it as a plain
// string -- carried forward into the "Other" checkbox/detail field rather
// than dropped, same treatment as Sample Submissions' normalizeDocs gives
// its own pre-checklist Docs value.
export function getCertificate(cert){
  if(cert && typeof cert === 'object') return { ...blankCertificate(), ...cert };
  const blank = blankCertificate();
  if(typeof cert === 'string' && cert.trim()){
    blank.other = true;
    blank.otherDetails = cert;
  }
  return blank;
}
// Plain-text summary for read-only/print-style contexts that expect a
// single string (the detail-view row, CSV-style exports, etc.).
export function certificateSummaryText(cert){
  const picked = CERTIFICATE_TYPES.filter(t => cert[t.key]).map(t => t.label);
  if(cert.other) picked.push(cert.otherDetails || 'Other');
  return picked.join(', ');
}
// Shared markup for all 3 places Certificate is edited (Submit Review
// modal, New Project panel, main project edit view) -- the "Other" detail
// field is always in the DOM (never re-rendered in/out) so a plain
// show/hide listener is enough; see wireCertificateChecklist below.
export function certificateChecklistHtml(cert, isEditing){
  return `
    <div class="proj-cert-wrap">
      <div class="proj-cert-checklist">
        ${CERTIFICATE_TYPES.map(t => `
          <label class="proj-cert-check-label">
            <input type="checkbox" class="proj-cert-check" data-cert="${t.key}" ${cert[t.key] ? 'checked' : ''} ${isEditing ? '' : 'disabled'}>
            ${escapeHtml(t.label)}
          </label>
        `).join('')}
        <label class="proj-cert-check-label">
          <input type="checkbox" class="proj-cert-check proj-cert-other-check" data-cert="other" ${cert.other ? 'checked' : ''} ${isEditing ? '' : 'disabled'}>
          Other
        </label>
      </div>
      <input type="text" class="proj-cert-other-field" value="${escapeHtml(cert.otherDetails || '')}" placeholder="e.g. FSSC 22000" ${isEditing ? '' : 'readonly'} style="margin-top:8px;${cert.other ? '' : 'display:none;'}">
    </div>
  `;
}
// Toggles the "Other" detail field's visibility as its checkbox is
// ticked/unticked -- call once per rendered .proj-cert-wrap (there's
// exactly one per form: Submit Review modal, New Project panel, or one
// per project card in the main edit view).
export function wireCertificateChecklist(root){
  root.querySelectorAll('.proj-cert-wrap').forEach(wrap => {
    wrap.querySelector('.proj-cert-other-check')?.addEventListener('change', e => {
      wrap.querySelector('.proj-cert-other-field').style.display = e.target.checked ? '' : 'none';
    });
  });
}
// Reads a .proj-cert-wrap's current checkbox/text state back into a
// certificate object -- shared by all 3 save handlers.
export function readCertificateChecklist(wrap){
  const cert = blankCertificate();
  wrap.querySelectorAll('.proj-cert-check').forEach(cb => { cert[cb.dataset.cert] = cb.checked; });
  cert.otherDetails = wrap.querySelector('.proj-cert-other-field').value.trim();
  return cert;
}

// Returns p.requirements as the structured object, parsing on the fly if
// it's still the legacy string (or defaulting if missing/blank). Never
// mutates `p` -- called at render time only; the object shape only gets
// persisted to Firestore once the project is next saved (see the save
// handler further down), same deferred-migration approach already used
// by migrateMonthlyUpdate above.
export function getRequirements(p){
  const req = p.requirements;
  const result = (req && typeof req === 'object') ? { ...blankRequirements(), ...req } : parseLegacyRequirements(req);
  result.cookingCondition = getCookingConditions(result.cookingCondition);
  result.referenceImages = Array.isArray(result.referenceImages) ? result.referenceImages : [];
  result.recipeAttachments = Array.isArray(result.recipeAttachments) ? result.recipeAttachments : [];
  result.certificate = getCertificate(result.certificate);
  return result;
}
