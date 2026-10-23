/* Trading Replay Tool — app logic: data, replay, practice, Pine scripts. */
'use strict';
const $ = (id) => document.getElementById(id);
const LS_SCRIPTS = 'trt_scripts_v1';
const LS_SESS = 'trt_sessions_v1';

const App = {
  candles: [], cursor: 0, playing: false, timer: null,
  smc: null, chart: null,
  scripts: [],   // {id, name, code, enabled, compiled, vm, out, inputVals}
  session: null, // {balance, startBalance, trades:[], openPos:null, id}
  sessions: [],
};

function fmtUSDT(x) {
  return (x < 0 ? '-' : '') + '$' + Math.abs(x).toLocaleString('en-US', {maximumFractionDigits: 2, minimumFractionDigits: 2});
}
function fmtT(t) {
  return new Intl.DateTimeFormat('id-ID', {timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'}).format(new Date(t));
}

/* ---------- data loading ---------- */
async function loadData() {
  const coin = $('coin').value, tf = $('tf').value;
  const startInput = $('startDate').value;
  $('btnLoad').disabled = true;
  $('loadStatus').textContent = 'Mengambil data...';
  $('loadStatus').className = 'status';
  try {
    let startTime = null;
    if (startInput) startTime = new Date(startInput).getTime();
    const candles = await BinanceData.fetchRange(coin, tf, {
      want: 1500, startTime,
      onProgress: (n) => { $('loadStatus').textContent = 'Mengambil data... ' + n + ' candle'; },
    });
    if (!candles.length) throw new Error('data kosong');
    App.candles = candles;
    $('loadStatus').textContent = candles.length + ' candle ' + coin + ' ' + tf;
    $('loadStatus').className = 'status ok';
    // SMC (full data; reveal-filtered at render)
    const t0 = performance.now();
    App.smc = computeSMC(candles);
    console.log('SMC compute:', Math.round(performance.now() - t0), 'ms');
    App.chart.setData(candles, App.smc);
    App.cursor = candles.length - 1;
    // (re)create VMs
    for (const s of App.scripts) makeVM(s);
    setCursor(App.cursor);
    const sl = $('slider');
    sl.max = candles.length - 1; sl.value = App.cursor;
  } catch (e) {
    $('loadStatus').textContent = 'Gagal: ' + e.message;
    $('loadStatus').className = 'status err';
  }
  $('btnLoad').disabled = false;
}

/* ---------- replay ---------- */
function setCursor(k) {
  const n = App.candles.length;
  if (!n) return;
  k = Math.max(0, Math.min(k, n - 1));
  const moved = k - App.cursor;
  App.cursor = k;
  App.chart.cursor = k;
  // run Pine scripts (incremental inside runTo)
  for (const s of App.scripts) {
    if (!s.enabled || !s.vm) { s.out = null; continue; }
    try { s.out = s.vm.runTo(k); }
    catch (e) { s.out = null; s.runError = 'bar ' + k + ': ' + (e.msg || e); }
  }
  App.chart.setPineOuts(App.scripts.filter(s => s.enabled).map(s => ({out: s.out})));
  if (moved > 0) checkOpenPosition();
  updatePracticeUI();
  App.chart.setPractice(App.session ? {trades: App.session.trades, openPos: App.session.openPos} : null);
  App.chart.draw();
  $('slider').value = k;
  const c = App.candles[k];
  $('cursorInfo').textContent = fmtT(c.t) + '  C ' + c.c;
  updateOHLCDefault();
}
function updateOHLCDefault() {
  if (App.chart.hover) return;
  const c = App.candles[App.cursor];
  if (!c) return;
  const el = $('ohlc-bar');
  const chg = ((c.c - c.o) / c.o * 100).toFixed(2);
  el.textContent = fmtT(c.t) + '  O ' + c.o + ' H ' + c.h + ' L ' + c.l + ' C ' + c.c + ' ' + chg + '%';
  el.style.color = chg >= 0 ? '#089981' : '#f23645';
}
function step(d) { pause(); setCursor(App.cursor + d); }
function play() {
  if (App.playing || !App.candles.length) return;
  App.playing = true;
  $('btnPlay').textContent = '⏸ Pause';
  const tick = () => {
    if (App.cursor >= App.candles.length - 1) { pause(); return; }
    setCursor(App.cursor + 1);
  };
  App.timer = setInterval(tick, +$('speed').value || 1000);
}
function pause() {
  App.playing = false;
  $('btnPlay').textContent = '▶ Play';
  if (App.timer) { clearInterval(App.timer); App.timer = null; }
}

/* ---------- practice ---------- */
function startSession() {
  const bal = Math.max(1, +$('sessBalance').value || 1000);
  App.session = {
    id: Date.now(), balance: bal, startBalance: bal,
    trades: [], openPos: null,
    coin: $('coin').value, tf: $('tf').value,
  };
  $('btnStartSess').disabled = true; $('btnEndSess').disabled = false;
  $('trade-box').style.display = 'flex';
  $('sessStats').style.display = 'flex';
  $('sessStatus').textContent = 'Sesi berjalan — modal ' + fmtUSDT(bal);
  $('sessStatus').className = 'status ok';
  updatePracticeUI();
}
function endSession() {
  if (!App.session) return;
  if (App.session.openPos) closePosition(App.candles[App.cursor].c, 'manual');
  App.sessions.push({...App.session, endedAt: Date.now()});
  try { localStorage.setItem(LS_SESS, JSON.stringify(App.sessions.slice(-20))); } catch (e) {}
  const pnl = App.session.balance - App.session.startBalance;
  $('sessStatus').textContent = 'Sesi selesai. P/L: ' + fmtUSDT(pnl);
  App.session = null;
  $('btnStartSess').disabled = false; $('btnEndSess').disabled = true;
  $('trade-box').style.display = 'none';
  App.chart.setPractice(null);
  App.chart.draw();
  renderHistory();
}
function openPosition(dir) {
  const s = App.session;
  if (!s || s.openPos || !App.candles.length) return;
  const size = Math.max(1, +$('posSize').value || 100);
  const c = App.candles[App.cursor];
  const sl = parseFloat($('posSL').value), tp = parseFloat($('posTP').value);
  s.openPos = {
    dir, entry: c.c, entryBar: App.cursor, entryT: c.t, size,
    sl: isNaN(sl) ? null : sl, tp: isNaN(tp) ? null : tp,
  };
  $('posStatus').textContent = dir + ' @ ' + c.c;
  $('posStatus').className = 'status ok';
  updatePracticeUI();
  App.chart.setPractice({trades: s.trades, openPos: s.openPos});
  App.chart.draw();
}
function checkOpenPosition() {
  const s = App.session;
  if (!s || !s.openPos) return;
  const o = s.openPos, c = App.candles[App.cursor];
  if (o.dir === 'LONG') {
    if (o.sl != null && c.l <= o.sl) return closePosition(o.sl, 'SL');
    if (o.tp != null && c.h >= o.tp) return closePosition(o.tp, 'TP');
  } else {
    if (o.sl != null && c.h >= o.sl) return closePosition(o.sl, 'SL');
    if (o.tp != null && c.l <= o.tp) return closePosition(o.tp, 'TP');
  }
}
function closePosition(price, reason) {
  const s = App.session, o = s.openPos;
  if (!o) return;
  const pnl = (o.dir === 'LONG' ? price - o.entry : o.entry - price) / o.entry * o.size;
  s.balance += pnl;
  s.trades.push({...o, exitPrice: price, exitBar: App.cursor, exitT: App.candles[App.cursor].t, pnl, reason});
  s.openPos = null;
  $('posStatus').textContent = 'Close @ ' + price + ' (' + reason + ') P/L ' + fmtUSDT(pnl);
  $('posStatus').className = 'status ' + (pnl >= 0 ? 'ok' : 'err');
  updatePracticeUI();
  renderHistory();
  App.chart.setPractice({trades: s.trades, openPos: null});
  App.chart.draw();
}
function updatePracticeUI() {
  const s = App.session;
  if (!s) return;
  let floating = 0;
  if (s.openPos && App.candles.length) {
    const c = App.candles[App.cursor].c, o = s.openPos;
    floating = (o.dir === 'LONG' ? c - o.entry : o.entry - c) / o.entry * o.size;
  }
  const closed = s.trades;
  const wins = closed.filter(t => t.pnl > 0).length;
  const totPnl = s.balance - s.startBalance + floating;
  $('sessStats').innerHTML =
    '<span>Equity <b>' + fmtUSDT(s.balance + floating) + '</b></span>' +
    '<span>Floating <b style="color:' + (floating >= 0 ? '#089981' : '#f23645') + '">' + fmtUSDT(floating) + '</b></span>' +
    '<span>Trade: <b>' + closed.length + '</b> (win ' + wins + ')</b></span>' +
    '<span>Total P/L <b style="color:' + (totPnl >= 0 ? '#089981' : '#f23645') + '">' + fmtUSDT(totPnl) + '</b></span>' +
    (s.openPos ? '<span>Posisi: <b>' + s.openPos.dir + ' @ ' + s.openPos.entry + '</b> <button id="btnClosePos">Close manual</button></span>' : '');
  const bc = $('btnClosePos');
  if (bc) bc.onclick = () => closePosition(App.candles[App.cursor].c, 'manual');
}
function renderHistory() {
  const el = $('tradeHistory');
  const s = App.session;
  const trades = s ? s.trades : [];
  if (!trades.length) { el.innerHTML = ''; return; }
  let h = '<table><tr><th>#</th><th>Arah</th><th>Entry</th><th>Exit</th><th>Alasan</th><th>P/L</th></tr>';
  trades.forEach((t, i) => {
    h += '<tr><td>' + (i+1) + '</td><td>' + t.dir + '</td><td>' + t.entry + '</td><td>' + t.exitPrice + '</td><td>' + t.reason + '</td>' +
         '<td style="color:' + (t.pnl >= 0 ? '#089981' : '#f23645') + '">' + fmtUSDT(t.pnl) + '</td></tr>';
  });
  el.innerHTML = h + '</table>';
}

/* ---------- Pine scripts ---------- */
function makeVM(s) {
  try {
    s.vm = new PineVM(s.compiled, App.candles);
    s.vm.setInputs(s.inputVals || {});
    s.runError = null;
  } catch (e) { s.vm = null; s.runError = e.msg || String(e); }
}
function testScript() {
  const code = $('scriptCode').value;
  const msg = $('scriptMsg');
  $('scriptInputs').innerHTML = '';
  if (!code.trim()) { msg.textContent = 'Tempel dulu script Pine-nya.'; msg.className = 'status err'; return; }
  const compiled = compilePine(code);
  if (!compiled.ok) {
    msg.textContent = 'Compile gagal: ' + compiled.errors.map(e => 'baris ' + e.line + ': ' + e.msg).join(' · ');
    msg.className = 'status err';
    $('btnSaveScript').disabled = true;
    App._tested = null;
    return;
  }
  // coba jalan di data yang ada (atau data sintetis kalau belum load)
  let candles = App.candles;
  if (!candles.length) {
    candles = [];
    let p = 100;
    for (let i = 0; i < 300; i++) {
      const o = p, c = p + (Math.sin(i/10) * 2);
      candles.push({t: i * 3600000, o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 10});
      p = c;
    }
  }
  try {
    const vm = new PineVM(compiled, candles);
    const out = vm.runTo(candles.length - 1);
    const nPlots = out.plots.length, nShapes = out.shapes.length;
    msg.textContent = 'OK — "' + compiled.meta.title + '": ' + nPlots + ' plot, ' + nShapes + ' marker, ' +
      out.lines.length + ' garis, ' + out.labels.length + ' label, ' + out.boxes.length + ' box.' +
      (compiled.inputs.length ? ' Ada ' + compiled.inputs.length + ' input.' : '');
    msg.className = 'status ok';
    App._tested = {compiled, inputVals: {}};
    renderTestInputs(compiled);
    $('btnSaveScript').disabled = false;
  } catch (e) {
    msg.textContent = 'Runtime gagal: ' + (e.msg || e) + (e.bar != null ? ' (bar ' + e.bar + ')' : '');
    msg.className = 'status err';
    $('btnSaveScript').disabled = true;
    App._tested = null;
  }
}
function renderTestInputs(compiled) {
  const box = $('scriptInputs');
  box.innerHTML = '';
  for (const inp of compiled.inputs) {
    const lab = document.createElement('label');
    lab.textContent = inp.label + ': ';
    let el;
    if (inp.kind === 'bool') {
      el = document.createElement('input'); el.type = 'checkbox'; el.checked = !!inp.def;
      el.onchange = () => { App._tested.inputVals[inp.id] = el.checked; };
      App._tested.inputVals[inp.id] = !!inp.def;
    } else if (inp.options) {
      el = document.createElement('select');
      inp.options.forEach(o => { const op = document.createElement('option'); op.value = o; op.textContent = o; el.appendChild(op); });
      el.value = inp.def;
      el.onchange = () => { App._tested.inputVals[inp.id] = el.value; };
      App._tested.inputVals[inp.id] = inp.def;
    } else if (inp.kind === 'color') {
      el = document.createElement('input'); el.type = 'color';
      el.value = toHex(inp.def);
      el.onchange = () => { App._tested.inputVals[inp.id] = el.value; };
      App._tested.inputVals[inp.id] = el.value;
    } else {
      el = document.createElement('input'); el.type = 'number';
      el.value = inp.def; el.step = inp.step || 'any';
      if (inp.min != null) el.min = inp.min;
      if (inp.max != null) el.max = inp.max;
      el.onchange = () => { App._tested.inputVals[inp.id] = +el.value; };
      App._tested.inputVals[inp.id] = inp.def;
    }
    lab.appendChild(el);
    box.appendChild(lab);
  }
}
function toHex(c) {
  if (typeof c === 'string' && c.startsWith('#')) return c.slice(0, 7);
  const m = String(c).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return '#' + [1, 2, 3].map(i => (+m[i]).toString(16).padStart(2, '0')).join('');
  return '#000000';
}
function saveScript() {
  const t = App._tested;
  if (!t) return;
  const name = $('scriptName').value.trim() || t.compiled.meta.title;
  const s = {
    id: 's' + Date.now(), name,
    code: $('scriptCode').value, enabled: true,
    compiled: t.compiled, inputVals: t.inputVals || {},
  };
  makeVM(s);
  App.scripts.push(s);
  persistScripts();
  renderScriptList();
  if (App.candles.length) setCursor(App.cursor);
  $('scriptMsg').textContent = 'Tersimpan: ' + name;
  $('scriptMsg').className = 'status ok';
  $('btnSaveScript').disabled = true;
  App._tested = null;
}
function persistScripts() {
  try {
    localStorage.setItem(LS_SCRIPTS, JSON.stringify(App.scripts.map(s => ({
      id: s.id, name: s.name, code: s.code, enabled: s.enabled, inputVals: s.inputVals,
    }))));
  } catch (e) {}
}
function loadScripts() {
  App.scripts = [];
  try {
    const raw = JSON.parse(localStorage.getItem(LS_SCRIPTS) || '[]');
    for (const r of raw) {
      const compiled = compilePine(r.code);
      if (!compiled.ok) continue;
      const s = {id: r.id, name: r.name, code: r.code, enabled: !!r.enabled, compiled, inputVals: r.inputVals || {}};
      App.scripts.push(s);
    }
  } catch (e) {}
  renderScriptList();
}
function renderScriptList() {
  const el = $('scriptList');
  if (!App.scripts.length) {
    el.innerHTML = '<p class="hint">Belum ada script. Daftar ini memang dikosongkan — tambah script Pine milikmu sendiri.</p>';
    return;
  }
  el.innerHTML = '';
  App.scripts.forEach((s) => {
    const d = document.createElement('div');
    d.className = 'script-item';
    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.checked = s.enabled; chk.title = 'Aktif/nonaktif';
    chk.onchange = () => { s.enabled = chk.checked; persistScripts(); if (App.candles.length) setCursor(App.cursor); };
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = s.name;
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = s.compiled.meta.title + (s.runError ? ' — ERROR: ' + s.runError : '');
    const btnInp = document.createElement('button'); btnInp.textContent = 'Input';
    btnInp.onclick = () => { App._tested = {compiled: s.compiled, inputVals: {...s.inputVals}}; renderTestInputs(s.compiled);
      $('scriptMsg').textContent = 'Ubah input untuk "' + s.name + '", lalu klik Terapkan.'; $('scriptMsg').className = 'status';
      const ap = document.createElement('button'); ap.textContent = 'Terapkan'; ap.className = 'primary';
      ap.onclick = () => { s.inputVals = {...App._tested.inputVals}; makeVM(s); persistScripts(); if (App.candles.length) setCursor(App.cursor); $('scriptMsg').textContent = 'Input diterapkan.'; $('scriptMsg').className = 'status ok'; };
      $('scriptInputs').appendChild(ap);
    };
    const btnDel = document.createElement('button'); btnDel.textContent = 'Hapus';
    btnDel.onclick = () => {
      if (!confirm('Hapus script "' + s.name + '"?')) return;
      App.scripts = App.scripts.filter(x => x !== s);
      persistScripts(); renderScriptList();
      if (App.candles.length) setCursor(App.cursor);
    };
    d.append(chk, nm, meta, btnInp, btnDel);
    el.appendChild(d);
  });
}

/* ---------- init ---------- */
function init() {
  App.chart = new ReplayChart($('chart'));
  loadScripts();
  try { App.sessions = JSON.parse(localStorage.getItem(LS_SESS) || '[]'); } catch (e) {}
  // default start date: 90 hari lalu
  const d = new Date(Date.now() - 90 * 86400e3);
  const pad = (x) => String(x).padStart(2, '0');
  $('startDate').value = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());

  $('btnLoad').onclick = loadData;
  $('btnPlay').onclick = () => App.playing ? pause() : play();
  $('btnBack1').onclick = () => step(-1);
  $('btnBack10').onclick = () => step(-10);
  $('btnFwd1').onclick = () => step(1);
  $('btnFwd10').onclick = () => step(10);
  $('slider').oninput = (e) => { pause(); setCursor(+e.target.value); };
  $('speed').onchange = () => { if (App.playing) { pause(); play(); } };
  $('zoom').oninput = (e) => { App.chart.count = +e.target.value; App.chart.draw(); };
  $('chkSMC').onchange = () => App.chart.draw();
  $('tf').onchange = () => {}; $('coin').onchange = () => {};

  $('btnStartSess').onclick = startSession;
  $('btnEndSess').onclick = endSession;
  $('btnLong').onclick = () => openPosition('LONG');
  $('btnShort').onclick = () => openPosition('SHORT');

  $('btnTestScript').onclick = testScript;
  $('btnSaveScript').onclick = saveScript;
  $('scriptCode').oninput = () => { $('btnSaveScript').disabled = true; };

  window.addEventListener('resize', () => App.chart.draw());
  loadData();
}
document.addEventListener('DOMContentLoaded', init);
