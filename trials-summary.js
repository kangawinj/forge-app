// "Summary Test" (a read-only, body-appended overlay showing a condensed
// per-product readout) and the "Summary Table" view (a read-only,
// scannable overview across every test) plus its Excel export. Split out
// of trials.js (which grew past 2,600 lines) -- see trials.js's own
// top-of-file comment for the overall file split.
import { icon, escapeHtml, formatDateLong, projects } from './app.js';
import {
  getEvaluationCriteria, trialEvalTargets, getTrialProductData,
  summarizeTrialProduct, groupTrialsByProject, TRIAL_SUMMARY_VERDICT_CLASSES
} from './trials-data.js';
// Circular import back to core trials.js -- safe, see trials-wizard.js's
// own comment on this same pattern.
import { trials } from './trials.js';

// Holds the trial id while the Summary Test modal is open, null when
// closed.
let trialSummaryId = null;

// Opens the Summary Test modal for a trial -- replaces trials.js's old
// inline `trialSummaryId = id` assignment, since an imported `let`
// binding is read-only to importers in ES modules.
export function openTrialSummaryModal(trialId){
  trialSummaryId = trialId;
}

function renderTrialSummaryModal(){
  const existing = document.getElementById('trialSummaryOverlay');
  if(!trialSummaryId){ existing?.remove(); return; }
  const t = trials.find(x => x.id === trialSummaryId);
  if(!t){ trialSummaryId = null; existing?.remove(); return; }
  // Only a product explicitly marked "Continue Development" (see the new
  // row at the bottom of Improvement Guidelines) belongs here -- per
  // request, a sample nobody's decided to carry forward (or one flagged
  // Discontinue) shouldn't keep showing up on a page meant for a quick
  // read of where things stand.
  const evalTargets = trialEvalTargets(t).filter(p => getTrialProductData(t, p.id).continueDevelopment === 'continue');
  const criteria = getEvaluationCriteria(t);

  const overlay = existing || document.createElement('div');
  overlay.id = 'trialSummaryOverlay';
  overlay.className = 'eval-wizard-overlay';
  if(!existing){
    document.body.appendChild(overlay);
    // Read-only content, nothing typed here to accidentally lose -- so
    // (unlike the Perform Evaluation wizard above) a click on the
    // backdrop closes this one, same mousedown+click-both-on-overlay
    // guard as wireModalOverlayClose (app.js) uses, just inlined since
    // this overlay is built dynamically rather than living in index.html.
    let mousedownOnOverlay = false;
    overlay.addEventListener('mousedown', e => { mousedownOnOverlay = e.target === overlay; });
    overlay.addEventListener('click', e => {
      if(mousedownOnOverlay && e.target === overlay){ trialSummaryId = null; renderTrialSummaryModal(); }
      mousedownOnOverlay = false;
    });
  }

  overlay.innerHTML = `
    <div class="eval-wizard-card">
      <div class="eval-wizard-header">
        <div class="eval-wizard-title">Forge · Test Summary</div>
        <button type="button" class="eval-wizard-close" data-role="summary-close" title="Close">${icon('x')}</button>
      </div>
      ${evalTargets.length === 0 ? '<div class="overview-empty">No products marked "Continue Development" yet — mark one in Improvement Guidelines to see it here</div>' : evalTargets.map(p => {
        const { label, verdict, improvements, justRight } = summarizeTrialProduct(t, criteria, p);
        return `
          <div class="trial-summary-product">
            <div class="trial-summary-product-head">
              <div class="trial-summary-product-name">${escapeHtml(label)}</div>
              ${verdict
                ? `<span class="trial-summary-verdict ${TRIAL_SUMMARY_VERDICT_CLASSES[verdict] || ''}">${escapeHtml(verdict)}</span>`
                : '<span class="overview-empty">Not yet evaluated</span>'}
            </div>
            ${improvements.length ? `
              <div class="trial-summary-improve-title">Suggested Improvements</div>
              <ul class="trial-summary-improve-list">${improvements.map(x => `<li><b>${escapeHtml(x.label)}:</b> ${escapeHtml(x.suggestion)}${x.note ? `<span class="trial-summary-item-note"> — ${escapeHtml(x.note)}</span>` : ''}</li>`).join('')}</ul>
            ` : (verdict ? '<div class="trial-summary-ok">✓ All criteria are Just Right — no changes suggested</div>' : '')}
            ${justRight.length ? `
              <div class="trial-summary-improve-title">Just Right (พอดี)</div>
              <ul class="trial-summary-justright-list">${justRight.map(c => `<li>${escapeHtml(c.label)}${c.note ? `<span class="trial-summary-item-note"> — ${escapeHtml(c.note)}</span>` : ''}</li>`).join('')}</ul>
            ` : ''}
          </div>
        `;
      }).join('')}
      ${(t.note || '').trim() ? `
        <div class="trial-summary-note">
          <div class="trial-summary-improve-title">Note</div>
          <div class="trial-summary-note-text">${escapeHtml(t.note)}</div>
        </div>
      ` : ''}
    </div>
  `;
  overlay.querySelector('[data-role="summary-close"]')?.addEventListener('click', () => {
    trialSummaryId = null;
    renderTrialSummaryModal();
  });
}
export { renderTrialSummaryModal };

// Same ExcelJS pattern as Recipes' own Export Excel (see xlArgb/XL_COLORS/
// xlThinBorder/addSectionTitleBar in recipes.js) -- kept as its own copy
// here rather than imported, since trials.js doesn't otherwise depend on
// recipes.js internals (same reasoning as the Translate button helpers
// above). Colors are pulled straight from :root's CSS custom properties in
// style.css so the workbook matches the on-screen Summary Table exactly,
// not an approximation of it.
function xlArgb(hex){
  return 'FF' + hex.replace('#','').toUpperCase();
}
const XL_COLORS = {
  headerFill: xlArgb('#16294a'),
  headerText: xlArgb('#ffffff'),
  groupFill: xlArgb('#e8ecf5'),
  groupText: xlArgb('#0c1830'),
  primaryDark: xlArgb('#0c1830'),
  border: xlArgb('#dfe3ea'),
  dim: xlArgb('#6b7280'),
  text: xlArgb('#1c2333'),
  ok: xlArgb('#2e8b3d'),
  accent: xlArgb('#ef7f24'),
  danger: xlArgb('#c0392b')
};
function xlThinBorder(){
  return { style: 'thin', color: { argb: XL_COLORS.border } };
}
function addSectionTitleBar(ws, title, colSpan){
  ws.mergeCells(1, 1, 1, colSpan);
  const cell = ws.getCell(1, 1);
  cell.value = title;
  cell.font = { bold: true, size: 13, color: { argb: XL_COLORS.headerText } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.headerFill } };
  cell.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 26;
}
// One worksheet, one row per test (matching the on-screen table's own tr
// exactly, including Project/PD merged down the same way rowspan groups
// them on screen), built as ExcelJS richText so a single Summary Test cell
// can carry the product name (bold), its verdict badge (colored, matching
// TRIAL_SUMMARY_VERDICT_CLASSES), and its Improve/Just Right bullet lines
// (Just Right colored the same green as on screen) all in one wrapped cell,
// same as the live page's own layout.
function buildTrialsSummarySheet(wb, groups){
  const ws = wb.addWorksheet('Summary Table');
  ws.columns = [{ width: 26 }, { width: 22 }, { width: 18 }, { width: 74 }];
  addSectionTitleBar(ws, 'Test Results — Summary Table', 4);

  const headerRow = ws.addRow(['Project', 'PD / Responsible Person', 'Tested Date', 'Summary Test']);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, size: 11, color: { argb: XL_COLORS.groupText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLORS.groupFill } };
    cell.border = { top: xlThinBorder(), bottom: xlThinBorder(), left: xlThinBorder(), right: xlThinBorder() };
    cell.alignment = { vertical: 'middle' };
  });

  groups.forEach(g => {
    const linkedProject = g.projectId ? projects.find(pr => pr.id === g.projectId) : null;
    const startRow = ws.rowCount + 1;
    g.trials.forEach((t, i) => {
      const criteria = getEvaluationCriteria(t);
      const evalTargets = trialEvalTargets(t).filter(p => getTrialProductData(t, p.id).continueDevelopment === 'continue');
      const products = evalTargets.map(p => summarizeTrialProduct(t, criteria, p));

      const runs = [];
      if(!products.length){
        runs.push({ text: 'No products marked "Continue Development"', font: { italic: true, size: 11, color: { argb: XL_COLORS.dim } } });
      } else {
        products.forEach((pr, pi) => {
          if(pi > 0) runs.push({ text: '\n', font: { size: 4 } });
          runs.push({ text: pr.label, font: { bold: true, size: 12, color: { argb: XL_COLORS.text } } });
          if(pr.verdict){
            const vColor = pr.verdict === 'Accepted' ? XL_COLORS.ok : pr.verdict === 'Not accepted' ? XL_COLORS.danger : XL_COLORS.accent;
            runs.push({ text: '  [' + pr.verdict + ']\n', font: { bold: true, size: 10, color: { argb: vColor } } });
          } else {
            runs.push({ text: '  [Not yet evaluated]\n', font: { italic: true, size: 10, color: { argb: XL_COLORS.dim } } });
          }
          if(pr.improvements.length){
            runs.push({ text: 'Improve:\n', font: { bold: true, size: 9, color: { argb: XL_COLORS.primaryDark } } });
            pr.improvements.forEach(x => {
              runs.push({ text: `• ${x.suggestion}`, font: { size: 11, color: { argb: XL_COLORS.text } } });
              if(x.note) runs.push({ text: `  — ${x.note}`, font: { italic: true, size: 10, color: { argb: XL_COLORS.dim } } });
              runs.push({ text: '\n' });
            });
          }
          if(pr.justRight.length){
            runs.push({ text: 'Just Right:\n', font: { bold: true, size: 9, color: { argb: XL_COLORS.primaryDark } } });
            pr.justRight.forEach(c => {
              runs.push({ text: `• ${c.label}`, font: { size: 11, color: { argb: XL_COLORS.ok } } });
              if(c.note) runs.push({ text: `  — ${c.note}`, font: { italic: true, size: 10, color: { argb: XL_COLORS.dim } } });
              runs.push({ text: '\n' });
            });
          }
        });
      }

      const row = ws.addRow([
        i === 0 ? (linkedProject?.name || '-') : '',
        i === 0 ? (linkedProject?.responsiblePerson || '-') : '',
        t.testDate ? formatDateLong(t.testDate).toUpperCase() : 'NO TEST DATE',
        { richText: runs }
      ]);
      [1, 2, 3, 4].forEach(col => {
        row.getCell(col).alignment = { wrapText: true, vertical: 'top' };
        row.getCell(col).border = { top: xlThinBorder(), bottom: xlThinBorder(), left: xlThinBorder(), right: xlThinBorder() };
      });
      row.getCell(1).font = { size: 11, color: { argb: XL_COLORS.text } };
      row.getCell(2).font = { size: 11, color: { argb: XL_COLORS.text } };
      row.getCell(3).font = { bold: true, size: 9, color: { argb: XL_COLORS.dim } };
      const fullText = runs.map(r => r.text).join('');
      const lineCount = (fullText.match(/\n/g) || []).length + 1;
      row.height = Math.max(30, lineCount * 15);
    });
    const endRow = ws.rowCount;
    if(g.trials.length > 1){
      ws.mergeCells(startRow, 1, endRow, 1);
      ws.mergeCells(startRow, 2, endRow, 2);
    }
  });
}
export async function exportTrialsSummaryToExcel(){
  if(!window.ExcelJS){
    alert('Excel export isn\'t available right now (ExcelJS failed to load) -- check your connection and try again.');
    return;
  }
  const sorted = [...trials].sort((a,b) => (b.testDate || '').localeCompare(a.testDate || '') || (b.updatedAt - a.updatedAt));
  const groups = groupTrialsByProject(sorted);

  const wb = new window.ExcelJS.Workbook();
  wb.creator = 'Forge';
  wb.created = new Date();
  buildTrialsSummarySheet(wb, groups);

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Test Results Summary ${new Date().toISOString().slice(0,10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
export function renderTrialsSummaryTable(container, sortedTrials){
  const groups = groupTrialsByProject(sortedTrials);

  container.innerHTML = `
    <div style="overflow-x:auto;">
    <table class="compare-table trial-summary-table">
      <thead><tr><th>Project</th><th>PD / Responsible Person</th><th>Tested Date</th><th>Summary Test</th></tr></thead>
      <tbody>
        ${groups.map(g => {
          const linkedProject = g.projectId ? projects.find(pr => pr.id === g.projectId) : null;
          return g.trials.map((t, i) => {
            const criteria = getEvaluationCriteria(t);
            // Only products marked "Continue Development" (see the new row
            // at the bottom of Improvement Guidelines) -- same rule as the
            // Summary Test modal, so the two never disagree about what
            // counts as "worth showing on a summary".
            const evalTargets = trialEvalTargets(t).filter(p => getTrialProductData(t, p.id).continueDevelopment === 'continue');
            const products = evalTargets.map(p => summarizeTrialProduct(t, criteria, p));
            return `
              <tr>
                ${i === 0 ? `
                  <td rowspan="${g.trials.length}">${escapeHtml(linkedProject?.name || '-')}</td>
                  <td rowspan="${g.trials.length}">${escapeHtml(linkedProject?.responsiblePerson || '-')}</td>
                ` : ''}
                <td class="trial-table-summary-date-cell">${t.testDate ? escapeHtml(formatDateLong(t.testDate)) : 'No test date'}</td>
                <td>
                  ${products.length === 0 ? '<span class="overview-empty">No products marked "Continue Development"</span>' : products.map(pr => `
                    <div class="trial-table-summary-product">
                      <div class="trial-table-summary-head">
                        <b>${escapeHtml(pr.label)}</b>
                        ${pr.verdict ? `<span class="trial-summary-verdict ${TRIAL_SUMMARY_VERDICT_CLASSES[pr.verdict] || ''}">${escapeHtml(pr.verdict)}</span>` : '<span class="overview-empty">Not yet evaluated</span>'}
                      </div>
                      ${pr.improvements.length ? `
                        <div class="trial-table-summary-line-title">Improve:</div>
                        <ul class="trial-table-summary-list">${pr.improvements.map(x => `<li>${escapeHtml(x.suggestion)}${x.note ? ` <span class="trial-summary-item-note">— ${escapeHtml(x.note)}</span>` : ''}</li>`).join('')}</ul>
                      ` : ''}
                      ${pr.justRight.length ? `
                        <div class="trial-table-summary-line-title">Just Right:</div>
                        <ul class="trial-table-summary-list trial-table-summary-ok">${pr.justRight.map(c => `<li>${escapeHtml(c.label)}${c.note ? ` <span class="trial-summary-item-note">— ${escapeHtml(c.note)}</span>` : ''}</li>`).join('')}</ul>
                      ` : ''}
                    </div>
                  `).join('')}
                </td>
              </tr>
            `;
          }).join('');
        }).join('')}
      </tbody>
    </table>
    </div>
  `;
}
