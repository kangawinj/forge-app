// Every file Forge hands out for download -- and the title a printed page is saved under -- starts with the day it was
// downloaded as YYYYMMDD, e.g. "20261117_Recipe Baby Octopus in Korean Sauce.xlsx". A trailing copy of today's date
// (some exports used to add " 2026-11-17" at the end) is dropped so the date is not there twice; a name that already starts
// with an 8-digit date is left alone.
export function datedFileName(fileName){
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const iso = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const name = String(fileName || 'download');
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && name.length - dot <= 6;   // ".xlsx", ".json", ".zip" ... (not a dot inside a title)
  const base = hasExt ? name.slice(0, dot) : name, ext = hasExt ? name.slice(dot) : '';
  const cleaned = base.replace(new RegExp(`[ _-]*${iso}$`), '').replace(new RegExp(`^${iso}[ _-]*`), '').trim();
  if(/^\d{8}[_ -]/.test(cleaned)) return cleaned + ext;
  return `${stamp}_${cleaned}${ext}`;
}
