/* LuxAlgo 'Smart Money Concepts' engine (default inputs) — JavaScript port.
   Faithful port of smc_engine_py.py / smc-src.pine (CC BY-NC-SA 4.0, (c) LuxAlgo).
   computeSMC(candles) -> {struct, eq, obs, perBar}
   candles: [{t, o, h, l, c}] (t = ms timestamp)
*/
const SMC_GREEN = '#089981', SMC_RED = '#F23645';

function computeSMC(candles) {
  const n = candles.length;
  const O = new Float64Array(n), H = new Float64Array(n),
        L = new Float64Array(n), C = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    O[i] = candles[i].o; H[i] = candles[i].h; L[i] = candles[i].l; C[i] = candles[i].c;
  }

  // ATR(200): ta.rma(ta.tr(true),200), seeded with SMA at bar 200
  const tr = new Float64Array(n);
  tr[0] = H[0] - L[0];
  for (let i = 1; i < n; i++)
    tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - C[i-1]), Math.abs(L[i] - C[i-1]));
  const atr = new Float64Array(n).fill(NaN);
  if (n >= 200) {
    let s = 0; for (let i = 0; i < 200; i++) s += tr[i];
    atr[199] = s / 200;
    for (let i = 200; i < n; i++) atr[i] = (atr[i-1] * 199 + tr[i]) / 200;
  }

  const pH = new Float64Array(n), pL = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const hv = !isNaN(atr[i]) && (H[i] - L[i]) >= 2 * atr[i];
    pH[i] = hv ? L[i] : H[i];
    pL[i] = hv ? H[i] : L[i];
  }

  function makeLeg(size) {
    return { size, leg: 0, prev: 0,
      step(i) {
        this.prev = this.leg;
        const s = this.size;
        if (i >= s) {
          let mx = -Infinity; for (let k = i - s + 1; k <= i; k++) if (H[k] > mx) mx = H[k];
          if (H[i - s] > mx) this.leg = 0;
          else {
            let mn = Infinity; for (let k = i - s + 1; k <= i; k++) if (L[k] < mn) mn = L[k];
            if (L[i - s] < mn) this.leg = 1;
          }
        }
        return this.leg - this.prev;
      } };
  }
  const mkPivot = () => ({ cur: NaN, crossed: false, bi: -1 });
  const swH = mkPivot(), swL = mkPivot(), inH = mkPivot(), inL = mkPivot(),
        eqH = mkPivot(), eqL = mkPivot();
  const swTrend = [0], inTrend = [0];
  const trail = { top: NaN, bot: NaN, top_i: -1, bot_i: -1 };
  const det_sw = makeLeg(50), det_in = makeLeg(5), det_eq = makeLeg(3);

  const struct = [], eq = [], liveOBs = [], masterOBs = [], perBar = [];

  function gcs(i, det, kind) {
    const chg = det.step(i);
    if (chg === 0) return;
    const s = det.size, p = i - s;
    if (chg === 1) {
      const piv = kind === 'equal' ? eqL : (kind === 'internal' ? inL : swL);
      if (kind === 'equal' && !isNaN(piv.cur) && !isNaN(atr[i]) && Math.abs(piv.cur - L[p]) < 0.1 * atr[i])
        eq.push({ tag: 'EQL', x0: piv.bi, x1: p, y0: piv.cur, y1: L[p], color: SMC_GREEN,
                  lx: Math.floor((piv.bi + p) / 2), reveal: i });
      piv.cur = L[p]; piv.crossed = false; piv.bi = p;
      if (kind === 'swing') { trail.bot = piv.cur; trail.bot_i = p; }
    } else {
      const piv = kind === 'equal' ? eqH : (kind === 'internal' ? inH : swH);
      if (kind === 'equal' && !isNaN(piv.cur) && !isNaN(atr[i]) && Math.abs(piv.cur - H[p]) < 0.1 * atr[i])
        eq.push({ tag: 'EQH', x0: piv.bi, x1: p, y0: piv.cur, y1: H[p], color: SMC_RED,
                  lx: Math.floor((piv.bi + p) / 2), reveal: i });
      piv.cur = H[p]; piv.crossed = false; piv.bi = p;
      if (kind === 'swing') { trail.top = piv.cur; trail.top_i = p; }
    }
  }

  function storeOB(piv, bias, i) {
    const arr = bias === -1 ? pH : pL;
    if (piv.bi >= i) return;
    let k = 0;
    if (bias === -1) { let mx = -Infinity; for (let j = piv.bi; j < i; j++) if (arr[j] > mx) { mx = arr[j]; k = j; } }
    else             { let mn = Infinity;  for (let j = piv.bi; j < i; j++) if (arr[j] < mn) { mn = arr[j]; k = j; } }
    const pi = k;
    const ob = { hi: pH[pi], lo: pL[pi], bi: pi, bias, stored: i, mitigated: null };
    masterOBs.push(ob);
    if (liveOBs.length >= 100) liveOBs.pop();
    liveOBs.unshift(ob);
  }

  function deleteOBs(i) {
    let k = 0;
    while (k < liveOBs.length) {
      const ob = liveOBs[k]; let mit = false;
      if (ob.bias === -1 && H[i] > ob.hi) mit = true;
      else if (ob.bias === 1 && L[i] < ob.lo) mit = true;
      if (mit) { ob.mitigated = i; liveOBs.splice(k, 1); } else k++;
    }
  }

  function dispStruct(i, internal, prevH, prevL) {
    const pivH = internal ? inH : swH, pivL = internal ? inL : swL;
    const trend = internal ? inTrend : swTrend;
    let extra_bull, extra_bear;
    if (internal) {
      extra_bull = !isNaN(pivH.cur) && !isNaN(swH.cur) && pivH.cur !== swH.cur;
      extra_bear = !isNaN(pivL.cur) && !isNaN(swL.cur) && pivL.cur !== swL.cur;
    } else extra_bull = extra_bear = true;
    if (i >= 1 && !isNaN(pivH.cur) && !isNaN(prevH) && C[i-1] <= prevH && C[i] > pivH.cur &&
        !pivH.crossed && extra_bull) {
      const tag = trend[0] === -1 ? 'CHoCH' : 'BOS';
      pivH.crossed = true; trend[0] = 1;
      struct.push({ tag, x0: pivH.bi, x1: i, y: pivH.cur, color: SMC_GREEN,
                    dashed: internal, internal, reveal: i });
      if (internal) storeOB(pivH, 1, i);
    }
    if (i >= 1 && !isNaN(pivL.cur) && !isNaN(prevL) && C[i-1] >= prevL && C[i] < pivL.cur &&
        !pivL.crossed && extra_bear) {
      const tag = trend[0] === 1 ? 'CHoCH' : 'BOS';
      pivL.crossed = true; trend[0] = -1;
      struct.push({ tag, x0: pivL.bi, x1: i, y: pivL.cur, color: SMC_RED,
                    dashed: internal, internal, reveal: i });
      if (internal) storeOB(pivL, -1, i);
    }
  }

  for (let i = 0; i < n; i++) {
    const p_swH = swH.cur, p_swL = swL.cur, p_inH = inH.cur, p_inL = inL.cur;
    if (!isNaN(trail.top) && H[i] >= trail.top) { trail.top = H[i]; trail.top_i = i; }
    if (!isNaN(trail.bot) && L[i] <= trail.bot) { trail.bot = L[i]; trail.bot_i = i; }
    gcs(i, det_sw, 'swing');
    gcs(i, det_in, 'internal');
    gcs(i, det_eq, 'equal');
    dispStruct(i, true, p_inH, p_inL);
    dispStruct(i, false, p_swH, p_swL);
    deleteOBs(i);
    perBar.push({ trailTop: trail.top, trailTopI: trail.top_i,
                  trailBot: trail.bot, trailBotI: trail.bot_i, swTrend: swTrend[0] });
  }
  return { struct, eq, obs: masterOBs, perBar };
}
if (typeof module !== 'undefined') module.exports = { computeSMC };
