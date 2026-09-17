// Shared finishing pass for the editable recipe worksheets.
// Excel does not auto-fit wrapped text in merged cells, so size rows explicitly.
export function finishRecipeWorksheets(workbook) {
  const measure = document.createElement('canvas').getContext('2d');
  for (const sheet of workbook.worksheets) {
    if (sheet.name === 'Recipe Preview') continue;
    sheet.properties.defaultRowHeight = 21;
    sheet.views = (sheet.views.length ? sheet.views : [{}]).map(view => ({
      ...view, showGridLines: false, zoomScale: 90
    }));
    sheet.pageSetup = {
      paperSize: 9, orientation: 'portrait', fitToPage: true,
      fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
      margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 },
      printArea: `A1:${sheet.getColumn(sheet.columnCount).letter}${sheet.rowCount}`
    };
    sheet.headerFooter.oddFooter = '&LForge&RPage &P of &N';
    if (sheet.name === '2. Recipe Overview' || sheet.name === '4. Ingredients') {
      sheet.pageSetup.printTitlesRow = '1:2';
    }
    const merges = (sheet.model.merges || []).map(address => {
      const [first, last] = address.split(':');
      return { first: sheet.getCell(first), last: sheet.getCell(last || first) };
    });
    sheet.eachRow(row => {
      let height = row.height || 21;
      row.eachCell(cell => {
        if (cell.isMerged && cell.master.address !== cell.address) return;
        cell.font = { name: 'Leelawadee UI', size: 10, color: { argb: 'FF1C2333' }, ...cell.font };
        cell.alignment = { ...cell.alignment, vertical: 'middle', wrapText: true };
        const merged = merges.find(range => range.first.address === cell.address);
        let width = 0;
        for (let col = cell.col; col <= (merged?.last.col || cell.col); col++) {
          width += Math.floor((sheet.getColumn(col).width || 9) * 7 + 5);
        }
        width = Math.max(20, width - 12 - (cell.alignment.indent || 0) * 12);
        const size = cell.font.size || 10;
        measure.font = `${cell.font.bold ? 'bold ' : ''}${size * 96 / 72}px "${cell.font.name}"`;
        let lines = 0;
        for (const paragraph of cell.text.split('\n')) {
          let lineWidth = 0;
          lines++;
          for (const char of paragraph) {
            const charWidth = measure.measureText(char).width;
            if (lineWidth && lineWidth + charWidth > width) { lines++; lineWidth = 0; }
            lineWidth += charWidth;
          }
        }
        height = Math.max(height, lines * size * 1.45 + 8);
      });
      row.height = Math.min(409, height);
    });
  }
}
