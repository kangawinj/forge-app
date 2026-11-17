// Process steps are typed as one text with both languages in it ("Wash and trim the onions. ล้าง และตัดแต่ง หัวหอม").
// Where a step starts with English and continues in Thai, it is shown as two lines: the English first, the Thai under it.
// A step with only one language (or Thai first) stays a single line.
export function splitStepLanguages(text){
  const s = String(text || '').trim();
  const at = s.search(/[฀-๿]/);
  if(at <= 0) return { en: s, th: '' };
  const en = s.slice(0, at).trim(), th = s.slice(at).trim();
  return en && th ? { en, th } : { en: s, th: '' };
}
export function stepTextHtml(text, escapeHtml){
  const { en, th } = splitStepLanguages(text);
  return th
    ? `<span class="step-en">${escapeHtml(en)}</span><span class="step-th">${escapeHtml(th)}</span>`
    : escapeHtml(en);
}
