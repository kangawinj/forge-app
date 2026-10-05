// BD Pricing Workspace -- the pure calculation core (no DOM, no Firebase), so
// the formulas can be unit-tested on their own and bd-pricing.js is only
// ever a view over it.
//
// Per tier (factory -> company -> customer), with
//   C = base cost, F = extra cost in money per serving,
//   o = expense rate as a share of the SELLING price, m = target profit share
//   of the SELLING price (both as decimals):
//     price before rounding = (C + F) / (1 - o - m)
//     price                 = price before rounding, rounded UP to the step
//     actual expenses       = F + price * o
//     actual profit         = price - C - F - price * o
//     actual margin         = actual profit / price
//   Each tier's rounded price is the next tier's C (factory -> company ->
//   customer), so the chain can never disagree with itself.
// Reverse (budget) direction: max base cost = price * (1 - o - m) - F.

export const TIER_KEYS = ['factory', 'company', 'customer'];
export const TIER_LABELS = { factory: 'โรงงาน', company: 'บริษัท', customer: 'ลูกค้า' };

export const isNum = v => typeof v === 'number' && isFinite(v);
// Tiny epsilons so 28.600000000000001 style float noise can never push a
// price up (or a budget down) by a whole step.
export function roundUpToStep(v, step){
  if(!(step > 0)) return v;
  return +(Math.ceil(v / step - 1e-9) * step).toFixed(6);
}
export function floorToStep(v, step){
  if(!(step > 0)) return Math.floor(v * 100 + 1e-9) / 100;
  return +(Math.floor(v / step + 1e-9) * step).toFixed(6);
}

// Extra cost items (packaging, freight, selling cost...) each belong to
// exactly ONE tier and one unit, so an item can never be counted twice:
//   unit 'amount'  -> money per serving, joins F of its tier
//   unit 'percent' -> % of that tier's selling price, joins o of its tier
export function tierAdjustments(extras, tierKey){
  let fixed = 0, pct = 0;
  (extras || []).forEach(e => {
    if(e.tier !== tierKey) return;
    const v = isNum(e.value) ? e.value : 0;
    if(e.unit === 'percent') pct += v; else fixed += v;
  });
  return { fixed, pct };
}

export function calcTier({ base, fixed, oPct, mPct, step }){
  const errors = [];
  if(!isNum(base)) errors.push('ยังไม่มีต้นทุนตั้งต้น');
  else if(base < 0) errors.push('ต้นทุนตั้งต้นต้องไม่ติดลบ');
  if(!isNum(fixed) || fixed < 0) errors.push('ค่าใช้จ่ายเพิ่มเติมต้องเป็นตัวเลขที่ไม่ติดลบ');
  if(!isNum(oPct) || oPct < 0) errors.push('ค่าใช้จ่าย % ต้องเป็นตัวเลขที่ไม่ติดลบ');
  if(!isNum(mPct) || mPct < 0) errors.push('กำไรเป้าหมาย % ต้องเป็นตัวเลขที่ไม่ติดลบ');
  if(!errors.length && oPct + mPct >= 100) errors.push('ค่าใช้จ่าย % + กำไรเป้าหมาย % ต้องน้อยกว่า 100%');
  if(errors.length) return { ok: false, errors };
  const o = oPct / 100, m = mPct / 100;
  const raw = (base + fixed) / (1 - o - m);
  const price = roundUpToStep(raw, step);
  const expenses = fixed + price * o;
  const profit = price - base - fixed - price * o;
  return { ok: true, base, fixed, oPct, mPct, raw, price, expenses, profit, margin: price > 0 ? profit / price : 0 };
}

// scenario: { tiers: [{o, m}, {o, m}, {o, m}], extras: [...] }
export function calcChain(scenario, materialCost, step){
  const out = [];
  let prev = null;
  TIER_KEYS.forEach((key, i) => {
    const adj = tierAdjustments(scenario.extras, key);
    const t = scenario.tiers[i] || {};
    const oBase = isNum(t.o) ? t.o : 0, mBase = isNum(t.m) ? t.m : 0;
    let base;
    if(i === 0) base = materialCost;
    else base = prev && prev.ok ? prev.price : null;
    let res;
    if(i > 0 && !(prev && prev.ok)){
      res = { ok: false, errors: ['แก้ลำดับก่อนหน้าให้คำนวณได้ก่อน'] };
    }else{
      res = calcTier({ base, fixed: adj.fixed, oPct: oBase + adj.pct, mPct: mBase, step });
    }
    res.key = key;
    res.oBasePct = oBase;
    res.oExtraPct = adj.pct;
    res.fixedExtra = adj.fixed;
    out.push(res);
    prev = res;
  });
  return out;
}

// Highest base cost a tier can afford at a given selling price. null when
// the rates alone already use up 100% (or more) of the price.
export function maxBaseCost({ price, fixed, oPct, mPct }){
  if(!isNum(price) || !isNum(fixed) || !isNum(oPct) || !isNum(mPct)) return null;
  if(oPct + mPct >= 100) return null;
  return price * (1 - oPct / 100 - mPct / 100) - fixed;
}

// Walk the target price down from the tier it refers to (refIndex: 1 =
// company's price to the customer, 2 = the customer's resale price) to the
// raw material. Intermediate prices are rounded DOWN to the pricing step
// (a price we pay later gets rounded UP, so the budget must be a price that
// is itself on the step) and the final material budget is floored to 0.01 --
// never up -- so following a budget can't land under the profit target.
export function calcReverse(scenario, targetPrice, refIndex, step){
  const budgets = [];
  let price = targetPrice;
  for(let i = refIndex; i >= 0; i--){
    const key = TIER_KEYS[i];
    const adj = tierAdjustments(scenario.extras, key);
    const t = scenario.tiers[i] || {};
    const max = maxBaseCost({
      price, fixed: adj.fixed,
      oPct: (isNum(t.o) ? t.o : 0) + adj.pct, mPct: isNum(t.m) ? t.m : 0
    });
    if(max == null || max <= 0){
      budgets[i] = { key, ok: false, priceBudget: price, maxBase: max };
      for(let j = i - 1; j >= 0; j--) budgets[j] = { key: TIER_KEYS[j], ok: false, priceBudget: null, maxBase: null };
      return budgets;
    }
    const maxBase = i === 0 ? Math.floor(max * 100 + 1e-9) / 100 : max;
    budgets[i] = { key, ok: true, priceBudget: price, maxBase };
    if(i > 0) price = floorToStep(max, step);
  }
  return budgets;
}
