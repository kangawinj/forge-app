// A small spreadsheet formula engine for the attached Excel tables (Excel Sheets > Edit table): a cell that starts
// with "=" is a formula, e.g. =SUM(B2:B10)*2, =IF(C3>100,"high","low"), =COUNTIF(A1:A20,">5").
// Supported: numbers, "text", TRUE/FALSE, cell references (A1, $A$1) and ranges (A1:B5), + - * / ^ & % , comparisons
// (= <> < > <= >=), parentheses and the functions listed in FUNCS below. References stay inside the same sheet.
// Pure functions, no DOM: the table editor calls recalc(draft) after every change.

export function colToNum(s){ return [...String(s).toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0); }
export function numToCol(n){ let s = ''; for(n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; }   // 0 -> A

const ERRV = e => ({ e });
const isErr = v => v !== null && typeof v === 'object' && !Array.isArray(v) && 'e' in v;

// ---- tokenizer ----
function tokenize(src){
  const out = [];
  let i = 0;
  while(i < src.length){
    const ch = src[i];
    if(/\s/.test(ch)){ i++; continue; }
    if(ch === '"'){
      let j = i + 1, s = '';
      while(j < src.length){ if(src[j] === '"'){ if(src[j + 1] === '"'){ s += '"'; j += 2; continue; } break; } s += src[j++]; }
      if(j >= src.length) throw new Error('#VALUE!');
      out.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if(num){ out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[$]?[A-Za-z_][A-Za-z0-9_.$]*/.exec(src.slice(i));
    if(id){
      const word = id[0];
      const ref = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(word);
      const after = src[i + word.length];
      if(ref && after !== '('){ out.push({ t: 'ref', c: colToNum(ref[2]) - 1, r: Number(ref[4]) - 1, ac: !!ref[1], ar: !!ref[3] }); }
      else out.push({ t: 'id', v: word.toUpperCase() });
      i += word.length; continue;
    }
    const two = src.slice(i, i + 2);
    if(['<>', '<=', '>='].includes(two)){ out.push({ t: 'op', v: two }); i += 2; continue; }
    if('+-*/^&=<>%'.includes(ch)){ out.push({ t: 'op', v: ch }); i++; continue; }
    if(ch === '(' || ch === ')' || ch === ',' || ch === ';' || ch === ':'){ out.push({ t: ch }); i++; continue; }
    throw new Error('#NAME?');
  }
  return out;
}

// ---- parser (recursive descent) -> AST ----
function parse(tokens){
  let p = 0;
  const peek = () => tokens[p], next = () => tokens[p++];
  const isOp = (...vs) => peek() && peek().t === 'op' && vs.includes(peek().v);
  function expr(){ return comparison(); }
  function comparison(){
    let l = concat();
    while(isOp('=', '<>', '<', '>', '<=', '>=')){ const op = next().v; l = { k: 'bin', op, l, r: concat() }; }
    return l;
  }
  function concat(){
    let l = additive();
    while(isOp('&')){ next(); l = { k: 'bin', op: '&', l, r: additive() }; }
    return l;
  }
  function additive(){
    let l = term();
    while(isOp('+', '-')){ const op = next().v; l = { k: 'bin', op, l, r: term() }; }
    return l;
  }
  function term(){
    let l = power();
    while(isOp('*', '/')){ const op = next().v; l = { k: 'bin', op, l, r: power() }; }
    return l;
  }
  function power(){
    let l = unary();
    while(isOp('^')){ next(); l = { k: 'bin', op: '^', l, r: unary() }; }
    return l;
  }
  function unary(){
    if(isOp('-')){ next(); return { k: 'un', op: '-', v: unary() }; }
    if(isOp('+')){ next(); return unary(); }
    return postfix();
  }
  function postfix(){
    let v = primary();
    while(isOp('%')){ next(); v = { k: 'pct', v }; }
    return v;
  }
  function primary(){
    const t = next();
    if(!t) throw new Error('#VALUE!');
    if(t.t === 'num') return { k: 'num', v: t.v };
    if(t.t === 'str') return { k: 'str', v: t.v };
    if(t.t === 'ref'){
      if(peek() && peek().t === ':'){
        next();
        const b = next();
        if(!b || b.t !== 'ref') throw new Error('#REF!');
        return { k: 'range', r1: Math.min(t.r, b.r), c1: Math.min(t.c, b.c), r2: Math.max(t.r, b.r), c2: Math.max(t.c, b.c) };
      }
      return { k: 'ref', r: t.r, c: t.c };
    }
    if(t.t === '('){ const e = expr(); if(!peek() || peek().t !== ')') throw new Error('#VALUE!'); next(); return e; }
    if(t.t === 'id'){
      if(t.v === 'TRUE') return { k: 'bool', v: true };
      if(t.v === 'FALSE') return { k: 'bool', v: false };
      if(peek() && peek().t === '('){
        next();
        const args = [];
        if(peek() && peek().t === ')'){ next(); return { k: 'call', name: t.v, args }; }
        for(;;){
          args.push(peek() && (peek().t === ',' || peek().t === ';' || peek().t === ')') ? { k: 'empty' } : expr());
          const sep = next();
          if(!sep) throw new Error('#VALUE!');
          if(sep.t === ')') break;
          if(sep.t !== ',' && sep.t !== ';') throw new Error('#VALUE!');
        }
        return { k: 'call', name: t.v, args };
      }
      throw new Error('#NAME?');
    }
    throw new Error('#VALUE!');
  }
  const ast = expr();
  if(p < tokens.length) throw new Error('#VALUE!');
  return ast;
}

// ---- evaluation ----
const toNum = v => {
  if(isErr(v)) return v;
  if(v === null || v === '') return 0;
  if(typeof v === 'number') return v;
  if(typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(String(v).trim().replace(/,/g, ''));
  return String(v).trim() !== '' && isFinite(n) ? n : ERRV('#VALUE!');
};
const toStr = v => isErr(v) ? v : (v === null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
const toBool = v => {
  if(isErr(v)) return v;
  if(typeof v === 'boolean') return v;
  if(typeof v === 'number') return v !== 0;
  if(v === null || v === '') return false;
  const s = String(v).toUpperCase();
  return s === 'TRUE' ? true : s === 'FALSE' ? false : ERRV('#VALUE!');
};
const compare = (a, b) => {   // numbers < text < booleans, text compared without case
  const rank = v => v === null ? 0 : typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2;
  if(a === null) a = typeof b === 'string' ? '' : (typeof b === 'boolean' ? false : 0);
  if(b === null) b = typeof a === 'string' ? '' : (typeof a === 'boolean' ? false : 0);
  if(rank(a) !== rank(b)) return rank(a) - rank(b);
  if(typeof a === 'string') return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
};
// a COUNTIF-style criterion: 5, ">5", "<=3", "<>x", "text*" ...
function matcher(crit){
  let op = '=', rest = crit;
  if(typeof crit === 'string'){
    const m = /^(>=|<=|<>|>|<|=)(.*)$/.exec(crit);
    if(m){ op = m[1]; rest = m[2]; }
  }
  const num = typeof rest === 'number' ? rest : (rest !== '' && isFinite(Number(rest)) ? Number(rest) : null);
  return v => {
    if(isErr(v)) return false;
    if(num !== null){
      const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null);
      if(n === null) return op === '<>';
      return op === '=' ? n === num : op === '<>' ? n !== num : op === '>' ? n > num : op === '<' ? n < num : op === '>=' ? n >= num : n <= num;
    }
    const s = String(rest).toLowerCase(), t = v === null ? '' : String(v).toLowerCase();
    const re = new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const eq = re.test(t);
    return op === '<>' ? !eq : eq;
  };
}
const flatNums = (args, ctx, direct) => {   // numbers from scalar and range arguments (ranges skip text / blanks / booleans)
  const out = [];
  for(const a of args){
    const v = ctx.eval(a);
    if(isErr(v)) return v;
    if(v && v.range){ for(const row of v.range) for(const x of row){ if(isErr(x)) return x; if(typeof x === 'number') out.push(x); } }
    else if(!(a.k === 'empty')){ const n = toNum(v); if(isErr(n)) return n; out.push(n); }
  }
  return out;
};
const flatAll = (args, ctx) => {
  const out = [];
  for(const a of args){
    const v = ctx.eval(a);
    if(v && v.range) for(const row of v.range) for(const x of row) out.push(x); else out.push(v);
  }
  return out;
};
const round = (x, d, mode) => {
  const f = Math.pow(10, d);
  const y = x * f;
  const r = mode === 'up' ? (y < 0 ? -Math.ceil(-y - 1e-9) : Math.ceil(y - 1e-9)) : mode === 'down' ? (y < 0 ? -Math.floor(-y + 1e-9) : Math.floor(y + 1e-9)) : (y < 0 ? -Math.round(-y + 1e-9) : Math.round(y + 1e-9));
  return r / f;
};
const FUNCS = {
  SUM: (a, c) => { const n = flatNums(a, c); return isErr(n) ? n : n.reduce((s, x) => s + x, 0); },
  PRODUCT: (a, c) => { const n = flatNums(a, c); return isErr(n) ? n : n.reduce((s, x) => s * x, 1); },
  AVERAGE: (a, c) => { const n = flatNums(a, c); return isErr(n) ? n : n.length ? n.reduce((s, x) => s + x, 0) / n.length : ERRV('#DIV/0!'); },
  MIN: (a, c) => { const n = flatNums(a, c); return isErr(n) ? n : n.length ? Math.min(...n) : 0; },
  MAX: (a, c) => { const n = flatNums(a, c); return isErr(n) ? n : n.length ? Math.max(...n) : 0; },
  MEDIAN: (a, c) => { const n = flatNums(a, c); if(isErr(n)) return n; if(!n.length) return ERRV('#NUM!'); n.sort((x, y) => x - y); const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; },
  COUNT: (a, c) => { let k = 0; for(const v of flatAll(a, c)) if(typeof v === 'number') k++; return k; },
  COUNTA: (a, c) => flatAll(a, c).filter(v => v !== null && v !== '').length,
  COUNTBLANK: (a, c) => flatAll(a, c).filter(v => v === null || v === '').length,
  ABS: (a, c) => { const n = toNum(c.eval(a[0])); return isErr(n) ? n : Math.abs(n); },
  SQRT: (a, c) => { const n = toNum(c.eval(a[0])); return isErr(n) ? n : n < 0 ? ERRV('#NUM!') : Math.sqrt(n); },
  INT: (a, c) => { const n = toNum(c.eval(a[0])); return isErr(n) ? n : Math.floor(n); },
  MOD: (a, c) => { const x = toNum(c.eval(a[0])), y = toNum(c.eval(a[1])); if(isErr(x)) return x; if(isErr(y)) return y; return y === 0 ? ERRV('#DIV/0!') : x - y * Math.floor(x / y); },
  POWER: (a, c) => { const x = toNum(c.eval(a[0])), y = toNum(c.eval(a[1])); return isErr(x) ? x : isErr(y) ? y : Math.pow(x, y); },
  ROUND: (a, c) => { const x = toNum(c.eval(a[0])), d = a[1] ? toNum(c.eval(a[1])) : 0; return isErr(x) ? x : isErr(d) ? d : round(x, d, ''); },
  ROUNDUP: (a, c) => { const x = toNum(c.eval(a[0])), d = a[1] ? toNum(c.eval(a[1])) : 0; return isErr(x) ? x : isErr(d) ? d : round(x, d, 'up'); },
  ROUNDDOWN: (a, c) => { const x = toNum(c.eval(a[0])), d = a[1] ? toNum(c.eval(a[1])) : 0; return isErr(x) ? x : isErr(d) ? d : round(x, d, 'down'); },
  IF: (a, c) => { const t = toBool(c.eval(a[0])); if(isErr(t)) return t; return t ? (a[1] ? c.eval(a[1]) : true) : (a[2] ? c.eval(a[2]) : false); },
  IFERROR: (a, c) => { const v = c.eval(a[0]); return isErr(v) ? c.eval(a[1]) : v; },
  AND: (a, c) => { for(const v of flatAll(a, c)){ if(v === null || v === '') continue; const b = toBool(v); if(isErr(b)) return b; if(!b) return false; } return true; },
  OR: (a, c) => { for(const v of flatAll(a, c)){ if(v === null || v === '') continue; const b = toBool(v); if(isErr(b)) return b; if(b) return true; } return false; },
  NOT: (a, c) => { const b = toBool(c.eval(a[0])); return isErr(b) ? b : !b; },
  LEN: (a, c) => { const s = toStr(c.eval(a[0])); return isErr(s) ? s : s.length; },
  UPPER: (a, c) => { const s = toStr(c.eval(a[0])); return isErr(s) ? s : s.toUpperCase(); },
  LOWER: (a, c) => { const s = toStr(c.eval(a[0])); return isErr(s) ? s : s.toLowerCase(); },
  TRIM: (a, c) => { const s = toStr(c.eval(a[0])); return isErr(s) ? s : s.trim().replace(/\s+/g, ' '); },
  LEFT: (a, c) => { const s = toStr(c.eval(a[0])), n = a[1] ? toNum(c.eval(a[1])) : 1; return isErr(s) ? s : isErr(n) ? n : s.slice(0, n); },
  RIGHT: (a, c) => { const s = toStr(c.eval(a[0])), n = a[1] ? toNum(c.eval(a[1])) : 1; return isErr(s) ? s : isErr(n) ? n : (n ? s.slice(-n) : ''); },
  MID: (a, c) => { const s = toStr(c.eval(a[0])), st = toNum(c.eval(a[1])), n = toNum(c.eval(a[2])); return isErr(s) ? s : isErr(st) ? st : isErr(n) ? n : s.substr(st - 1, n); },
  CONCAT: (a, c) => flatAll(a, c).map(toStr).reduce((s, x) => isErr(s) ? s : isErr(x) ? x : s + x, ''),
  CONCATENATE: (a, c) => FUNCS.CONCAT(a, c),
  TODAY: () => { const d = new Date(); return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000); },
  NOW: () => (Date.now() / 86400000) + 25569,
  COUNTIF: (a, c) => { const r = c.eval(a[0]), crit = c.eval(a[1]); if(!r || !r.range) return ERRV('#VALUE!'); const m = matcher(crit); let k = 0; for(const row of r.range) for(const x of row) if(m(x)) k++; return k; },
  SUMIF: (a, c) => {
    const r = c.eval(a[0]), crit = c.eval(a[1]), s = a[2] ? c.eval(a[2]) : r;
    if(!r || !r.range || !s || !s.range) return ERRV('#VALUE!');
    const m = matcher(crit); let sum = 0;
    r.range.forEach((row, i) => row.forEach((x, j) => { if(m(x)){ const y = s.range[i] && s.range[i][j]; if(typeof y === 'number') sum += y; } }));
    return sum;
  },
  AVERAGEIF: (a, c) => {
    const r = c.eval(a[0]), crit = c.eval(a[1]), s = a[2] ? c.eval(a[2]) : r;
    if(!r || !r.range || !s || !s.range) return ERRV('#VALUE!');
    const m = matcher(crit); let sum = 0, k = 0;
    r.range.forEach((row, i) => row.forEach((x, j) => { if(m(x)){ const y = s.range[i] && s.range[i][j]; if(typeof y === 'number'){ sum += y; k++; } } }));
    return k ? sum / k : ERRV('#DIV/0!');
  },
  VLOOKUP: (a, c) => {   // exact match only (the 4th argument is ignored)
    const key = c.eval(a[0]), t = c.eval(a[1]), col = toNum(c.eval(a[2]));
    if(!t || !t.range) return ERRV('#VALUE!');
    if(isErr(col)) return col;
    for(const row of t.range){ if(compare(row[0], key) === 0){ return col >= 1 && col <= row.length ? row[col - 1] : ERRV('#REF!'); } }
    return ERRV('#N/A');
  }
};
export const FORMULA_FUNCTIONS = Object.keys(FUNCS);

function evalNode(n, ctx){
  switch(n.k){
    case 'num': case 'str': case 'bool': return n.v;
    case 'empty': return null;
    case 'ref': return ctx.get(n.r, n.c);
    case 'range': {
      const rows = [];
      for(let r = n.r1; r <= n.r2; r++){ const line = []; for(let c = n.c1; c <= n.c2; c++) line.push(ctx.get(r, c)); rows.push(line); }
      return { range: rows };
    }
    case 'pct': { const v = toNum(evalNode(n.v, ctx)); return isErr(v) ? v : v / 100; }
    case 'un': { const v = toNum(evalNode(n.v, ctx)); return isErr(v) ? v : -v; }
    case 'bin': {
      let a = evalNode(n.l, ctx), b = evalNode(n.r, ctx);
      if(a && a.range) return ERRV('#VALUE!');
      if(b && b.range) return ERRV('#VALUE!');
      if(isErr(a)) return a;
      if(isErr(b)) return b;
      if(n.op === '&') return toStr(a) + toStr(b);
      if(['=', '<>', '<', '>', '<=', '>='].includes(n.op)){
        const k = compare(a, b);
        return n.op === '=' ? k === 0 : n.op === '<>' ? k !== 0 : n.op === '<' ? k < 0 : n.op === '>' ? k > 0 : n.op === '<=' ? k <= 0 : k >= 0;
      }
      a = toNum(a); b = toNum(b);
      if(isErr(a)) return a;
      if(isErr(b)) return b;
      if(n.op === '+') return a + b;
      if(n.op === '-') return a - b;
      if(n.op === '*') return a * b;
      if(n.op === '/') return b === 0 ? ERRV('#DIV/0!') : a / b;
      const p = Math.pow(a, b);
      return isFinite(p) ? p : ERRV('#NUM!');
    }
    case 'call': {
      const f = FUNCS[n.name];
      if(!f) return ERRV('#NAME?');
      return f(n.args, ctx);
    }
  }
  return ERRV('#VALUE!');
}

// ---- one formula, against a getter for plain cell values ----
export function evalFormula(formula, get){
  let ast;
  try{ ast = parse(tokenize(String(formula).replace(/^=/, ''))); }
  catch(e){ return ERRV(/^#[A-Z/0!?]+$/.test(e.message) ? e.message : '#NAME?'); }
  const ctx = { get, eval: n => evalNode(n, ctx) };
  const v = evalNode(ast, ctx);
  if(v && v.range) return ERRV('#VALUE!');
  if(typeof v === 'number' && !isFinite(v)) return ERRV('#NUM!');
  return v;
}

// ---- a whole sheet draft: d.rows[r].c[c] holds what a cell shows, d.fx[key] its formula, d.fxv[key] the computed value ----
// fmtNumber(n, numberFormat) turns a number into the text the cell shows
export function recalc(d, fmtNumber){
  const fx = d.fx;
  d.fxv = {};
  if(!fx || !Object.keys(fx).length) return;
  const cache = new Map(), busy = new Set();
  const plain = (r, c) => {
    const text = (d.rows[r] && d.rows[r].c[c]) || '';
    const k = `${r},${c}`;
    if(d.vals && typeof d.vals[k] === 'number') return d.vals[k];
    if(text === '') return null;
    return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
  };
  const get = (r, c) => {
    if(r < 0 || c < 0 || r >= d.rows.length || c >= d.colw.length) return r < 0 || c < 0 ? ERRV('#REF!') : null;
    const k = `${r},${c}`;
    if(!fx[k]) return plain(r, c);
    if(cache.has(k)) return cache.get(k);
    if(busy.has(k)) return ERRV('#REF!');   // a formula that depends on itself
    busy.add(k);
    const v = evalFormula(fx[k], get);
    busy.delete(k);
    cache.set(k, v);
    return v;
  };
  Object.keys(fx).forEach(k => {
    const [r, c] = k.split(',').map(Number);
    if(!d.rows[r] || c >= d.colw.length){ delete fx[k]; return; }
    const v = get(r, c);
    const nf = d.styles && d.styles[k] && d.styles[k].nf;
    d.fxv[k] = isErr(v) ? { e: v.e } : v;
    d.rows[r].c[c] = isErr(v) ? v.e : typeof v === 'number' ? (fmtNumber ? fmtNumber(v, nf) : String(Number(v.toPrecision(12)))) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : v === null ? '' : String(v);
  });
}

// ---- moving references when a formula is copied, or rows / columns are inserted or deleted ----
const REFRE = /(?<![A-Za-z0-9_.$])(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?(?![A-Za-z0-9_(])/g;
function splitRef(s){ const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(s); return { ac: !!m[1], c: colToNum(m[2]) - 1, ar: !!m[3], r: Number(m[4]) - 1 }; }
const refText = x => `${x.ac ? '$' : ''}${numToCol(x.c)}${x.ar ? '$' : ''}${x.r + 1}`;
// fn(a, b) gets the parsed reference(s) of each match (b = null for a single cell) and returns the new text, or null for #REF!
function mapRefs(formula, fn){
  return String(formula).split(/("(?:[^"]|"")*")/).map((part, i) => i % 2 ? part : part.replace(REFRE, (all, a, b) => {
    const out = fn(splitRef(a), b ? splitRef(b) : null);
    return out === null ? '#REF!' : out;
  })).join('');
}
// a formula copied / filled `dr` rows and `dc` columns away: relative references move with it
export function shiftFormula(formula, dr, dc){
  return mapRefs(formula, (a, b) => {
    const mv = x => ({ ...x, r: x.ar ? x.r : x.r + dr, c: x.ac ? x.c : x.c + dc });
    const na = mv(a), nb = b ? mv(b) : null;
    if(na.r < 0 || na.c < 0 || (nb && (nb.r < 0 || nb.c < 0))) return null;
    return refText(na) + (nb ? ':' + refText(nb) : '');
  });
}
// rows (axis 'r') or columns (axis 'c') inserted before `at`
export function insertRefs(formula, axis, at, n){
  return mapRefs(formula, (a, b) => {
    const mv = x => ({ ...x, [axis]: x[axis] >= at ? x[axis] + n : x[axis] });
    return refText(mv(a)) + (b ? ':' + refText(mv(b)) : '');
  });
}
// rows / columns `from`..`to` deleted: references inside vanish (a range just shrinks)
export function deleteRefs(formula, axis, from, to){
  const n = to - from + 1;
  return mapRefs(formula, (a, b) => {
    const gone = x => x[axis] >= from && x[axis] <= to, mv = x => ({ ...x, [axis]: x[axis] > to ? x[axis] - n : x[axis] });
    if(!b) return gone(a) ? null : refText(mv(a));
    let lo = Math.min(a[axis], b[axis]), hi = Math.max(a[axis], b[axis]);
    if(hi < from || lo > to){ return refText(mv(a)) + ':' + refText(mv(b)); }
    const nlo = lo < from ? lo : from, nhi = hi > to ? hi - n : from - 1;
    if(nhi < nlo) return null;
    const first = a[axis] <= b[axis] ? a : b, last = first === a ? b : a;
    return refText({ ...first, [axis]: nlo }) + ':' + refText({ ...last, [axis]: nhi });
  });
}
