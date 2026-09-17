// Static reference charts -- Trial Code Guide and the Food Allergens
// regulatory chart, both plain documentation tabs (not backed by
// metaLists CRUD like every other Reference Lists tab). Split out of
// reflists.js -- see that file's own top-of-file comment for the overall
// file split.
import { escapeHtml } from './app.js';

// Static reference/documentation — not backed by metaLists like the other
// tabs, since there's nothing to add/edit/delete here. It exists purely so
// staff have the trial-code structure to look up while typing one in.
const TRIAL_CODE_GUIDE_ROWS = [
  { part: 'TH', meaning: "Customer's destination country (ประเทศลูกค้าปลายทาง)", example: 'Thailand' },
  { part: '26', meaning: 'Recipe creation year, 2 digits, YY (ปีที่สร้างสูตร 2 หลัก)', example: '2026' },
  { part: 'SAU', meaning: 'Product type code (รหัสประเภทสินค้า)', example: 'Sauce' },
  { part: '01', meaning: 'Recipe sequence number, counted separately per product type (ลำดับสูตร นับแยกเฉพาะประเภทสินค้านั้น)', example: '1st Sauce recipe (สูตรซอสลำดับที่ 1)' },
  { part: 'T01', meaning: 'Trial sequence number for the recipe (ลำดับการทดลองของสูตร)', example: 'Trial #1 (การทดลองครั้งที่ 1)' }
];
export function renderTrialCodeGuide(container){
  container.innerHTML = `
    <div class="reflist-code-guide">
      <div class="reflist-code-guide-example">TH26-SAU01-T01</div>
      <div class="reflist-code-guide-structure">Code structure: [Country][Year]-[Product Type][Recipe No.]-Trial No. — no dash within a group, only between the 3 groups (โครงสร้างรหัส: [ประเทศ][ปี]-[ประเภทสินค้า][ลำดับสูตร]-ลำดับทดลอง — ไม่มีขีดคั่นภายในกลุ่ม มีขีดคั่นเฉพาะระหว่าง 3 กลุ่มหลัก)</div>
      <table>
        <thead><tr><th>Component (ส่วนประกอบ)</th><th>Meaning (ความหมาย)</th><th>Example (ตัวอย่าง)</th></tr></thead>
        <tbody>
          ${TRIAL_CODE_GUIDE_ROWS.map(row => `
            <tr><td><b>${escapeHtml(row.part)}</b></td><td>${escapeHtml(row.meaning)}</td><td>${escapeHtml(row.example)}</td></tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// Food Allergens -- a country x allergen-category regulatory labeling
// chart, same "static reference tab" pattern as Trial Code Format above
// (renderTrialCodeGuide), not the metaLists CRUD pattern every other tab
// uses: this is a snapshot of an external, third-party chart (FARRP's
// International Regulatory Chart), not something a Forge admin edits row
// by row. It cannot be kept "live" -- this is a static-hosted app with no
// backend, and the source site doesn't send CORS headers that would let a
// browser fetch() it cross-origin anyway -- so it's a periodically
// refreshed snapshot instead, same idea as WORLD_COUNTRIES in app.js.
// Extracted directly from the source page's own DOM (table cell text +
// computed background-color + title attribute, which the site already
// uses for the exact footnote text on colored cells) on FOOD_ALLERGEN_CAPTURED.
const FOOD_ALLERGEN_CAPTURED = '2026-09-10';
export const FOOD_ALLERGEN_COLUMNS = [
  'Crustacean Shellfish', 'Egg', 'Fish', 'Milk', 'Peanut', 'Soy', 'Tree Nuts', 'Sesame', 'Wheat',
  'Cereals w/ Gluten', 'Sulfites', 'Buckwheat', 'Celery', 'Lupin', 'Molluscan Shellfish', 'Mustard',
  'Bee Pollen/ Propolis', 'Beef', 'Chicken', 'Latex (Natural Rubber)', 'Mango', 'Peach', 'Pork',
  'Royal Jelly', 'Tomato'
];
// One entry per legend color from the source chart's own key table --
// `label` is a representative note (a cell's own `note` in FOOD_ALLERGEN_ROWS
// overrides this with the exact wording for that specific country/allergen).
const ALLERGEN_COLOR_KEY = {
  shellfish: { hex: '#f5b7b1', label: 'Crab, shrimp (species vary by country — see cell for exact wording)' },
  poultry: { hex: '#ffecb3', label: 'From domesticated fowl / all farmed birds / from poultry' },
  fish: { hex: '#dcedc8', label: 'Mackerel' },
  dairyAnimal: { hex: '#c5cae9', label: 'From domesticated ruminants / mammary gland of farmed animals / milking animals' },
  dairySpecies: { hex: '#ffd4f7', label: 'All mammal species / cow, goat, buffalo (species vary by country — see cell)' },
  treenut: { hex: '#edbb99', label: 'Specific tree nuts only — see cell for exact species' },
  threshold: { hex: '#b3e5fc', label: '≥10 mg/kg, or directly added' },
  mollusk: { hex: '#e0ffff', label: 'Clams / abalone, mussel, oyster, squid (species vary by country — see cell)' }
};
const FOOD_ALLERGEN_FOOTNOTES = {
  1: 'For updated information on U.S. allergen regulations see Guidance for Industry: Questions and Answers Regarding Food Allergen Labeling (Edition 5)',
  2: 'EU member states: Austria, Belgium, Bulgaria, Croatia, Cyprus, Czech Republic, Denmark, Estonia, Finland, France, Germany, Greece, Hungary, Ireland, Italy, Latvia, Lithuania, Luxembourg, Malta, Netherlands, Poland, Portugal, Romania, Slovakia, Slovenia, Spain, Sweden. Non-EU countries adopting EU allergen labeling regulations: Iceland, Liechtenstein, Norway, Macedonia, Switzerland, United Kingdom (UK)',
  3: 'CARICOM (caricom.org) is an organization of Caribbean countries with the aims to promote economic integration and cooperation among its members and to coordinate foreign policy. Member states include Antigua and Barbuda, Bahamas, Barbados, Belize, Dominica, Grenada, Guyana, Haiti, Jamaica, Montserrat, Saint Kitts and Nevis, Saint Lucia, Saint Vincent and the Grenadines, Suriname, Trinidad and Tobago, Anguilla, Bermuda, British Virgin Islands, Cayman Islands, Turks and Caicos Islands',
  4: 'Central American Technical Regulation produced by and for Costa Rica, Guatemala, Honduras, El Salvador and Nicaragua.',
  5: 'GSO countries of Saudi Arabia, UAE, Kuwait, Bahrain, Oman, Qatar, Yemen (Abu Dhabi, the capital of UAE, follows the GSO regulations except regulates tree nuts rather than walnut only).',
  6: 'Japan recommends labeling of abalone, neritic squid, mackerel, salmon, salmon roe, beef, chicken, pork, apple, banana, kiwi, orange, peach, wild yam, gelatin, sesame, soybean, almond, macadamia nut, pistachio (will be added to recommended list), cashew (will be added to mandatory labeling list)',
  7: 'Taiwan has recommended labeling for cuttlefish (calamari), neritic squid, octopus, takoyaki, escargot, mussel, clam, oyster, scallop, mytilus, meretrix lusoria, abalone, sunflower seed, melon seed, kiwi'
};
// Each row: 25 cells in the same order as FOOD_ALLERGEN_COLUMNS.
// true = required, plain X | null = not required | {color, note} = required
// with a country-specific exception (color keys into ALLERGEN_COLOR_KEY,
// note is the exact wording from the source chart's own tooltip).
const FOOD_ALLERGEN_ROWS = [
  { country: "USA", footnote: 1, cells: [true, {color:'poultry', note:"From domesticated fowl"}, true, {color:'dairyAnimal', note:"From domesticated ruminants"}, true, true, true, true, true, null, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Canada", footnote: null, cells: [true, true, true, true, true, true, true, true, true, true, {color:'threshold', note:"Directly added or ≥10 mg/kg"}, null, null, null, true, true, null, null, null, null, null, null, null, null, null] },
  { country: "EU", footnote: 2, cells: [true, {color:'poultry', note:"All farmed birds"}, true, {color:'dairyAnimal', note:"From mammary gland of farmed animals"}, true, true, true, true, true, true, {color:'threshold', note:"≥10 mg/kg"}, null, true, true, true, true, null, null, null, null, null, null, null, null, null] },
  { country: "Australia/NZ", footnote: null, cells: [true, true, true, {color:'dairyAnimal', note:"Milking animals"}, true, true, true, true, true, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, true, true, null, true, null, null, null, null, null, null, true, null] },
  { country: "Argentina", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Bangladesh", footnote: null, cells: [true, true, true, true, true, true, true, true, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, true, null, null, true, null, null, null, null, null, null, null, null, null] },
  { country: "Belarus", footnote: null, cells: [true, true, true, true, true, true, true, true, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, true, true, true, true, null, null, null, null, null, null, null, null, null] },
  { country: "Bolivia", footnote: null, cells: [true, true, true, true, true, true, true, null, true, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Botswana", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Brazil", footnote: null, cells: [true, true, true, {color:'dairySpecies', note:"All mammal species"}, true, true, {color:'treenut', note:"Almond, hazelnut, cashew, Brazil nut, macadamia, walnut, pecan, pistachio, chestnut"}, null, true, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, true, null, null, null, null, null] },
  { country: "Caricom Std.", footnote: 3, cells: [true, true, true, true, true, true, true, null, true, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Central America", footnote: 4, cells: [true, true, true, true, true, true, true, null, true, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Chile", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "China", footnote: null, cells: [true, true, true, true, true, true, true, null, true, true, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Colombia", footnote: null, cells: [true, true, true, true, true, true, true, null, true, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Cuba", footnote: null, cells: [true, true, true, true, true, true, true, null, true, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Egypt", footnote: null, cells: [true, true, true, true, true, true, true, null, true, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Fiji", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "GSO", footnote: 5, cells: [true, true, true, true, true, true, true, true, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, true, true, {color:'mollusk', note:"Clams"}, true, null, null, null, null, null, null, null, null, null] },
  { country: "Hong Kong", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "India", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Indonesia", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Israel", footnote: null, cells: [true, {color:'poultry', note:"All farmed birds"}, true, {color:'dairyAnimal', note:"From mammary gland of farmed animals"}, true, true, true, true, true, true, {color:'threshold', note:"≥10 mg/kg"}, null, true, true, true, true, null, null, null, null, null, null, null, null, null] },
  { country: "Japan", footnote: 6, cells: [{color:'shellfish', note:"Crab, shrimp"}, true, null, true, true, null, {color:'treenut', note:"Walnut, cashew"}, null, true, null, null, true, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Kazakhstan", footnote: null, cells: [true, true, true, true, true, true, true, true, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, true, true, true, true, null, null, null, null, null, null, null, null, null] },
  { country: "Malawi", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Malaysia", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Mexico", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, true, null, null, null, null, null, null, null, null, null, null] },
  { country: "Morocco", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Nigeria", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Philippines", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Russia", footnote: null, cells: [true, true, true, true, true, true, true, true, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, true, true, true, true, null, null, null, null, null, null, null, null, null] },
  { country: "Singapore", footnote: null, cells: [true, true, true, {color:'dairySpecies', note:"Cow, buffalo, goat"}, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, true, null, null, null, null, null, null, null, null, null, null] },
  { country: "South Africa", footnote: null, cells: [true, true, true, {color:'dairySpecies', note:"Cow, goat"}, true, true, true, null, true, null, null, null, null, null, true, null, null, null, null, null, null, null, null, null, null] },
  { country: "South Korea", footnote: null, cells: [{color:'shellfish', note:"Crab, shrimp"}, {color:'poultry', note:"From poultry"}, {color:'fish', note:"Mackerel"}, true, true, true, {color:'treenut', note:"Pine nut, walnut"}, null, true, null, {color:'threshold', note:"≥10 mg/kg"}, true, null, null, {color:'mollusk', note:"Abalone, mussel, oyster, squid"}, null, null, true, true, null, null, true, true, null, true] },
  { country: "Taiwan", footnote: 7, cells: [{note:"Crab, shrimp"}, true, true, {color:'dairySpecies', note:"Cow, goat"}, true, true, true, true, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, true, null, null, null, null] },
  { country: "Thailand", footnote: null, cells: [{color:'shellfish', note:"Crab, shrimp, Mantis shrimp, lobster"}, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, true, null, null, null, null, null, null, null, null, null, null] },
  { country: "Tunisia", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Turkey", footnote: null, cells: [true, {color:'poultry', note:"All farmed birds"}, true, {color:'dairyAnimal', note:"From mammary gland of farmed animals"}, true, true, true, true, true, true, {color:'threshold', note:"≥10 mg/kg"}, null, true, true, true, true, null, null, null, null, null, null, null, null, null] },
  { country: "Ukraine", footnote: null, cells: [true, {color:'poultry', note:"All farmed birds"}, true, {color:'dairyAnimal', note:"From mammary gland of farmed animals"}, true, true, true, true, true, true, {color:'threshold', note:"≥10 mg/kg"}, null, true, true, true, true, null, null, null, null, null, null, null, null, null] },
  { country: "Venezuela", footnote: null, cells: [true, true, true, true, true, true, true, null, true, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] },
  { country: "Vietnam", footnote: null, cells: [true, true, true, true, true, true, true, null, null, true, {color:'threshold', note:"≥10 mg/kg"}, null, null, null, null, null, null, null, null, null, null, null, null, null, null] }
];
export function renderFoodAllergensChart(container){
  const usedFootnotes = [...new Set(FOOD_ALLERGEN_ROWS.map(r => r.footnote).filter(Boolean))].sort((a,b) => a - b);
  container.innerHTML = `
    <div class="food-allergen-caption">
      Source: <a href="https://farrp.unl.edu/IRChart/" target="_blank" rel="noopener">FARRP International Regulatory Chart</a> (University of Nebraska–Lincoln) · Snapshot captured ${FOOD_ALLERGEN_CAPTURED} · Not a live feed — ask to re-check the source for updates
    </div>
    <div class="food-allergen-chart">
      <div class="food-allergen-scroll">
        <table>
          <thead>
            <tr>
              <th class="food-allergen-corner">Food Allergens</th>
              ${FOOD_ALLERGEN_COLUMNS.map(c => `<th><span>${escapeHtml(c)}</span></th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${FOOD_ALLERGEN_ROWS.map(row => `
              <tr>
                <td class="food-allergen-country">${escapeHtml(row.country)}${row.footnote ? `<sup>${row.footnote}</sup>` : ''}</td>
                ${row.cells.map(cell => {
                  if(!cell) return '<td></td>';
                  if(cell === true) return '<td class="food-allergen-hit">X</td>';
                  const swatch = cell.color ? ALLERGEN_COLOR_KEY[cell.color].hex : '';
                  const style = swatch ? ` style="background:${swatch};"` : '';
                  const title = cell.note ? ` title="${escapeHtml(cell.note)}"` : '';
                  return `<td class="food-allergen-hit"${style}${title}>X</td>`;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="food-allergen-legend">
        ${Object.values(ALLERGEN_COLOR_KEY).map(c => `
          <div class="food-allergen-legend-item"><span class="food-allergen-swatch" style="background:${c.hex};"></span>${escapeHtml(c.label)}</div>
        `).join('')}
      </div>
      ${usedFootnotes.length ? `
        <div class="food-allergen-footnotes">
          ${usedFootnotes.map(n => `<div><sup>${n}</sup> ${escapeHtml(FOOD_ALLERGEN_FOOTNOTES[n])}</div>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
}
