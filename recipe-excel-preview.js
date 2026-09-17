// Export the measured Preview layout as editable Excel cells. The small grid
// is a layout coordinate system; text/table cells merge over it. No screenshot
// is used for text, numbers, tables, or process-node labels.
function color(value) {
  const rgb = value.match(/[\d.]+/g)?.map(Number);
  if (!rgb || (rgb.length > 3 && rgb[3] === 0)) return null;
  const alpha = rgb.length > 3 ? rgb[3] : 1;
  return 'FF' + rgb.slice(0, 3).map(v => Math.round(v * alpha + 255 * (1 - alpha)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function numericValue(text) {
  const unit = text.match(/^(-?[\d,]+(?:\.\d+)?)\s+(g|kg)$/);
  if (unit) {
    const parsed = numericValue(unit[1]);
    if (typeof parsed.value === 'number') return { ...parsed, numFmt: parsed.numFmt + `" ${unit[2]}"` };
  }
  const currency = text.match(/^฿(-?[\d,]+(?:\.\d+)?)(\*)?$/);
  if (currency) {
    const parsed = numericValue(currency[1]);
    if (typeof parsed.value === 'number') return { ...parsed, numFmt: '"฿"' + parsed.numFmt + (currency[2] ? '"*"' : '') };
  }
  // Keep IDs, dates, currency labels and numbers with leading zeroes as text.
  if (!/^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?%?$/.test(text)) return { value: text };
  const percent = text.endsWith('%');
  const decimals = text.match(/\.(\d+)/)?.[1].length || 0;
  return {
    value: Number(text.replace(/[,%]/g, '')) / (percent ? 100 : 1),
    numFmt: (percent ? '0' : '#,##0') + (decimals ? '.' + '0'.repeat(decimals) : '') + (percent ? '%' : '')
  };
}

async function imageData(source, layout) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = source;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = layout ? Math.max(1, Math.round(layout.width * 2)) : img.naturalWidth;
  canvas.height = layout ? Math.max(1, Math.round(layout.height * 2)) : img.naturalHeight;
  let width = canvas.width, height = canvas.height;
  if (layout && ['cover', 'contain'].includes(layout.fit)) {
    const scale = Math[layout.fit === 'cover' ? 'max' : 'min'](canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
    width = img.naturalWidth * scale; height = img.naturalHeight * scale;
  }
  canvas.getContext('2d').drawImage(img, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  return canvas.toDataURL('image/png');
}

async function previewDocument(source) {
  const snapshot = source.cloneNode(true);
  const currentControls = source.querySelectorAll('input, textarea, select');
  snapshot.querySelectorAll('input, textarea, select').forEach((node, index) => {
    node.value = currentControls[index].value;
    if (node.tagName === 'INPUT') node.checked = currentControls[index].checked;
  });
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;left:-12000px;top:0;width:1000px;height:900px;border:0;pointer-events:none;';
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body class="preview-print-mode"><div class="app"><main class="main" id="excelPreview"></main></div></body></html>');
    doc.close();
    await Promise.all([...document.querySelectorAll('link[rel="stylesheet"], style')].map(node => {
      const copy = node.cloneNode(true);
      if (node.tagName !== 'LINK') { doc.head.appendChild(copy); return; }
      copy.href = node.href;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Preview styles took too long to load. Please retry.')), 15000);
        copy.onload = () => { clearTimeout(timer); resolve(); };
        copy.onerror = () => { clearTimeout(timer); reject(new Error('Could not load Preview styles. Please retry.')); };
        doc.head.appendChild(copy);
      });
    }));
    const root = doc.getElementById('excelPreview');
    root.appendChild(snapshot);
    const style = doc.createElement('style');
    style.textContent = `
      html, body { width:1000px !important; overflow:visible !important; }
      body.preview-print-mode .app { position:static !important; width:1000px; overflow:visible !important; }
      body.preview-print-mode .main { width:794px !important; max-width:794px !important; padding:0 !important; margin:0 !important; }
      *, *::before, *::after { animation:none !important; transition:none !important; }
      button, .view-mode-toggle { display:none !important; }
    `;
    doc.head.appendChild(style);
    await doc.fonts.ready;
    await Promise.all([...root.querySelectorAll('img')].map(img => img.decode()));
    return { frame, root, doc };
  } catch (error) {
    frame.remove();
    throw error;
  }
}

export async function addRecipePreviewSheet(workbook, source) {
  if (!source) throw new Error('Open a recipe before exporting Excel.');
  const { frame, root, doc } = await previewDocument(source);
  try {
    const win = doc.defaultView;
    const origin = root.getBoundingClientRect();
    const paints = [], texts = [], images = [];
    let maxRight = origin.width, maxBottom = root.scrollHeight;
    function rect(box) {
      maxRight = Math.max(maxRight, box.right - origin.left);
      maxBottom = Math.max(maxBottom, box.bottom - origin.top);
      return {
        left: box.left - origin.left, top: box.top - origin.top,
        right: box.right - origin.left, bottom: box.bottom - origin.top
      };
    }
    function visible(el) {
      const css = win.getComputedStyle(el);
      return css.display !== 'none' && css.visibility !== 'hidden' && Number(css.opacity) !== 0;
    }
    function textBlock(el, text, box = el.getBoundingClientRect(), isNumeric = false) {
      text = text.replace(/\u00a0/g, ' ').trim();
      if (!text) return;
      const css = win.getComputedStyle(el);
      const bounds = rect(box);
      // Respect padding (including the ingredient tree's depth indent).
      if (box.width === el.getBoundingClientRect().width) {
        bounds.left += parseFloat(css.paddingLeft) || 0;
        bounds.right -= parseFloat(css.paddingRight) || 0;
        bounds.top += parseFloat(css.paddingTop) || 0;
        bounds.bottom -= parseFloat(css.paddingBottom) || 0;
      }
      if (el.tagName === 'LI') {
        const index = [...el.parentElement.children].indexOf(el) + 1;
        text = (el.parentElement.tagName === 'OL' ? `${index}. ` : '• ') + text;
        bounds.left -= 12;
      }
      const numberBox = el.closest('.overview-num-cell');
      const nameBox = el.closest('.overview-ing-info');
      if (numberBox || nameBox) {
        const parentBounds = (numberBox || nameBox).getBoundingClientRect();
        bounds.left = parentBounds.left - origin.left;
        bounds.right = parentBounds.right - origin.left;
      }
      const td = el.closest('td');
      const lineHeight = parseFloat(css.lineHeight) || parseFloat(css.fontSize) * 1.2;
      const multiline = text.includes('\n') || bounds.bottom - bounds.top > lineHeight * 1.6;
      let richText;
      if (el.querySelector('b, strong')) {
        richText = [];
        const walker = doc.createTreeWalker(el, 4);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const value = node.textContent.replace(/\s+/g, ' ');
          if (!value) continue;
          const font = win.getComputedStyle(node.parentElement);
          richText.push({ text: value, font: { name: 'Segoe UI', size: parseFloat(font.fontSize) * 0.75,
            bold: Number(font.fontWeight) >= 600, color: { argb: color(font.color) || 'FF1C2333' } } });
        }
      }
      texts.push({ bounds, text, css, multiline, richText, numeric: isNumeric || (td && td.cellIndex > 0) });
    }
    async function visit(el) {
      if (!visible(el)) return;
      const css = win.getComputedStyle(el);
      const bounds = rect(el.getBoundingClientRect());
      const fill = color(css.backgroundColor);
      const border = {};
      for (const side of ['top', 'left', 'bottom', 'right']) {
        const cap = side[0].toUpperCase() + side.slice(1);
        if (parseFloat(css['border' + cap + 'Width']) > 0 && css['border' + cap + 'Style'] !== 'none') {
          border[side] = { style: parseFloat(css['border' + cap + 'Width']) >= 2 ? 'medium' : 'thin', color: { argb: color(css['border' + cap + 'Color']) || 'FFDFE3EA' } };
        }
      }
      if (fill || Object.keys(border).length) paints.push({ bounds, fill, border });
      if (el.classList.contains('print-process-flow-node') && el.nextElementSibling) {
        const after = win.getComputedStyle(el, '::after');
        const left = bounds.left + (parseFloat(after.left) || 0);
        const top = bounds.top + (parseFloat(after.top) || 0);
        const bottom = bounds.bottom - (parseFloat(after.bottom) || 0);
        paints.push({ bounds: { left, top, right: left + 2, bottom }, fill: color(after.backgroundColor), border: {} });
      }
      if (el.tagName === 'IMG') {
        images.push({ bounds, data: await imageData(el.currentSrc || el.src, { width: bounds.right - bounds.left, height: bounds.bottom - bounds.top, fit: css.objectFit }) });
        return;
      }
      // Only the diagram's connectors are raster objects. Node text stays cells.
      if (el.tagName.toLowerCase() === 'svg') {
        if (bounds.right > bounds.left && bounds.bottom > bounds.top) {
          const clone = el.cloneNode(true);
          [el, ...el.querySelectorAll('*')].forEach((node, i) => {
            const target = [clone, ...clone.querySelectorAll('*')][i];
            const computed = win.getComputedStyle(node);
            for (const prop of ['fill', 'stroke', 'stroke-width', 'opacity']) target.style.setProperty(prop, computed.getPropertyValue(prop));
          });
          clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          clone.setAttribute('width', bounds.right - bounds.left);
          clone.setAttribute('height', bounds.bottom - bounds.top);
          images.push({ bounds, data: await imageData('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone))) });
        }
        return;
      }
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
        const value = el.tagName === 'SELECT' ? el.selectedOptions[0]?.textContent || '' : el.value;
        textBlock(el, value, el.getBoundingClientRect(), el.type === 'number');
        return;
      }
      if (['TD', 'TH'].includes(el.tagName) && !el.querySelector('div, img, input, select, textarea')) {
        textBlock(el, el.innerText, el.getBoundingClientRect(), el.tagName === 'TD' && el.cellIndex > 0);
        return;
      }
      const children = [...el.children];
      const hasBlockChild = children.some(child => {
        const display = win.getComputedStyle(child).display;
        return display !== 'none' && (!['inline', 'contents'].includes(display) || ['INPUT', 'SELECT', 'TEXTAREA', 'IMG', 'SVG'].includes(child.tagName));
      });
      if (!hasBlockChild && el.textContent.trim()) {
        textBlock(el, el.innerText, el.getBoundingClientRect(), el.classList.contains('batch-stat-value'));
        return;
      }
      for (const node of el.childNodes) {
        if (node.nodeType === 1) await visit(node);
        else if (node.nodeType === 3 && node.textContent.trim()) {
          const range = doc.createRange();
          const start = node.textContent.search(/\S/);
          range.setStart(node, start);
          range.setEnd(node, node.textContent.trimEnd().length);
          textBlock(el, node.textContent, range.getBoundingClientRect());
        }
      }
    }
    await visit(root);
    // Include every text/box boundary, so adjacent cells never overlap after
    // conversion. Excel rounds column widths to physical pixels, so use whole
    // pixel boundaries to prevent cumulative drift across many narrow columns.
    const unique = values => [...new Set(values.map(v => Math.max(0, Math.round(v))))].sort((a, b) => a - b);
    const bounds = [...paints, ...texts, ...images].map(item => item.bounds);
    const xs = unique([0, maxRight, ...bounds.flatMap(b => [b.left, b.right])]);
    const ys = unique([0, maxBottom, ...bounds.flatMap(b => [b.top, b.bottom])]);
    // Subdivide tall rows: Excel limits an individual row to 409 points.
    for (let i = ys.length - 1; i > 0; i--) {
      for (let y = ys[i - 1] + 400; y < ys[i]; y += 400) ys.splice(i++, 0, y);
    }
    ys.sort((a, b) => a - b);
    if (xs.length > 16384 || ys.length > 1048576) throw new Error('This recipe exceeds Excel layout limits.');
    const sheet = workbook.addWorksheet('Recipe Preview', {
      views: [{ showGridLines: false, showRowColHeaders: false, zoomScale: 100 }]
    });
    // OOXML col.width already includes Excel's padding. It is not the same
    // quantity as the ColumnWidth exposed by Excel's UI/COM object model.
    sheet.columns = xs.slice(1).map((x, i) => {
      const pixels = x - xs[i];
      return { width: Math.ceil(pixels / 7 * 256) / 256 };
    });
    ys.slice(1).forEach((y, i) => { sheet.getRow(i + 1).height = (y - ys[i]) * 0.75; });
    function cells(b) {
      const index = (axis, value) => axis.indexOf(Math.max(0, Math.round(value)));
      const left = index(xs, b.left) + 1, top = index(ys, b.top) + 1;
      return { left, top, right: Math.max(left, index(xs, b.right)), bottom: Math.max(top, index(ys, b.bottom)) };
    }
    for (const paint of paints) {
      const box = cells(paint.bounds);
      for (let row = box.top; row <= box.bottom; row++) {
        for (let col = box.left; col <= box.right; col++) {
          if (!paint.fill && row !== box.top && row !== box.bottom && col !== box.left && col !== box.right) continue;
          const cell = sheet.getCell(row, col);
          if (paint.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: paint.fill } };
          const border = { ...cell.border };
          if (row === box.top && paint.border.top) border.top = paint.border.top;
          if (row === box.bottom && paint.border.bottom) border.bottom = paint.border.bottom;
          if (col === box.left && paint.border.left) border.left = paint.border.left;
          if (col === box.right && paint.border.right) border.right = paint.border.right;
          cell.border = border;
        }
      }
    }
    for (const item of texts) {
      const box = cells(item.bounds);
      if (box.right > box.left || box.bottom > box.top) sheet.mergeCellsWithoutStyle(box.top, box.left, box.bottom, box.right);
      const cell = sheet.getCell(box.top, box.left);
      const parsed = item.numeric ? numericValue(item.text) : { value: item.text };
      cell.value = item.richText ? { richText: item.richText } : parsed.value;
      if (parsed.numFmt) cell.numFmt = parsed.numFmt;
      cell.font = {
        name: 'Segoe UI', size: parseFloat(item.css.fontSize) * 0.75,
        bold: Number(item.css.fontWeight) >= 600 || item.css.fontWeight === 'bold',
        italic: item.css.fontStyle === 'italic', color: { argb: color(item.css.color) || 'FF1C2333' }
      };
      cell.alignment = {
        horizontal: ['right', 'center'].includes(item.css.textAlign) ? item.css.textAlign : 'left',
        vertical: 'middle', wrapText: item.multiline, shrinkToFit: !item.multiline
      };
    }
    for (const item of images) {
      const box = cells(item.bounds);
      const imageId = workbook.addImage({ base64: item.data, extension: 'png' });
      sheet.addImage(imageId, {
        tl: { col: box.left - 1, row: box.top - 1 },
        br: { col: box.right, row: box.bottom }, editAs: 'oneCell'
      });
    }
    sheet.pageSetup = {
      paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.2, right: 0.2, top: 0.25, bottom: 0.25, header: 0, footer: 0.1 },
      printArea: `A1:${sheet.getColumn(xs.length - 1).letter}${ys.length - 1}`
    };
    sheet.headerFooter.oddFooter = '&R&P / &N';
    workbook.views = [{ activeTab: 0 }];
    return sheet;
  } finally {
    frame.remove();
  }
}
