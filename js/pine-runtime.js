/* Pine Script v5 subset interpreter (indicator-only) for Trading Replay Tool.
   Self-contained, no dependencies, DOM-free. License: CC BY-NC-SA 4.0.
   Two phases: PineCompiler.compile(source) -> { ast, meta, inputs, errors }
               PineVM runs the compiled script bar-by-bar up to a cursor.
   Honest-replay rule: evaluation at bar i may only read bars 0..i. */
'use strict';

/* ============================== TOKENIZER ============================== */
const KEYWORDS = new Set(['if','else','for','to','by','while','switch','var','varip',
  'and','or','not','true','false','import','export','method','type','in']);

function tokenize(src) {
  const toks = [];
  const lines = src.split('\n');
  const stack = [0];
  let bi = 0;
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    // strip comments (// ...) but not inside strings
    let code = '', inStr = false, qch = '';
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if ((ch === '"' || ch === "'") && (k === 0 || line[k-1] !== '\\')) {
        if (!inStr) { inStr = true; qch = ch; } else if (ch === qch) inStr = false;
      }
      if (!inStr && ch === '/' && line[k+1] === '/') break;
      code += ch;
    }
    if (/^\s*$/.test(code)) continue;
    const indent = code.match(/^\s*/)[0].length;
    // continuation: line ends with operator, open bracket, or and/or/not -> merge with next
    // (kecuali '=>' di akhir baris — itu pembuka blok fungsi/switch-case)
    code = code.trimEnd();
    const needCont = () => (/[+\-*/%,(\[=:<>&|?]$/.test(code) && !code.endsWith('=>')) || /\b(and|or|not)$/.test(code);
    while (needCont() && li + 1 < lines.length) {
      li++;
      code += ' ' + lines[li].trim();
    }
    if (indent > stack[stack.length-1]) { stack.push(indent); toks.push({t:'INDENT', line: li}); }
    while (indent < stack[stack.length-1]) { stack.pop(); toks.push({t:'DEDENT', line: li}); }
    if (indent !== stack[stack.length-1]) throw {line: li+1, msg: 'indentasi tidak konsisten'};
    // tokenize the code part
    let s = code.trim(), i = 0;
    const push = (t, v) => toks.push({t, v, line: li});
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === '"' || c === "'") {
        const q = c;
        let j = i+1, out = '';
        while (j < s.length && s[j] !== q) { out += s[j] === '\\' && j+1 < s.length ? s[++j] : s[j]; j++; }
        i = j+1; push('STR', out); continue;
      }
      if (c === '#' && /^#[0-9a-fA-F]{3,8}\b/.test(s.slice(i))) {
        const m = s.slice(i).match(/^#[0-9a-fA-F]{3,8}\b/)[0]; i += m.length; push('COLOR', m); continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i+1] || ''))) {
        const m = s.slice(i).match(/^(\d+(\.\d*)?|\.\d+)/);
        if (m) { i += m[0].length; push('NUM', parseFloat(m[0])); continue; }
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)[0]; i += m.length;
        push(KEYWORDS.has(m) ? m.toUpperCase() : 'IDENT', m); continue;
      }
      const two = s.substr(i, 2);
      if ([':=','==','!=','<=','>=','=>','+=','-=','*=','/=','%='].includes(two)) { push('OP', two); i += 2; continue; }
      if ('+-*/%<>?:=(),[].'.includes(c)) { push(c === '.' ? 'DOT' : (',()[]?:'.includes(c) ? c : 'OP'), c); i++; continue; }
      throw {line: li+1, msg: 'karakter tak dikenal: ' + c};
    }
    push('NL', null);
    bi++;
  }
  while (stack.length > 1) { stack.pop(); toks.push({t:'DEDENT', line: lines.length}); }
  toks.push({t:'EOF', line: lines.length});
  return toks;
}
/* ============================== PARSER ============================== */
function parse(toks) {
  let pos = 0;
  const peek = (k=0) => toks[pos+k];
  const next = () => toks[pos++];
  const at = (t, k=0) => peek(k).t === t;
  const err = (m, tk) => { throw {line: (tk||peek()).line+1, msg: m}; };

  function parseProgram() {
    const body = [];
    while (!at('EOF')) { if (at('NL')) { next(); continue; } body.push(parseStatement()); }
    return {type:'Program', body};
  }
  function parseStatement() {
    const tk = peek();
    if (tk.t === 'VAR' || tk.t === 'VARIP') {
      next();
      // var line x = na  |  varip int n = 0  |  var x = 1
      let vtype = null, dotted = null;
      if (at('IDENT') && (peek(1).t === 'IDENT' || (peek(1).t === 'DOT'))) {
        // typed declaration like: var line ln = na
        const t1 = next().v;
        if (at('DOT')) { next(); dotted = t1 + '.' + next().v; }
        else vtype = t1;
      }
      return finishVarDecl(tk, vtype || dotted);
    }
    if (tk.t === 'IDENT' && at('IDENT', 1)) {
      // typed declaration without var: line ln = na
      const t1 = next().v; next();
      return finishVarDecl(tk, t1);
    }
    if (tk.t === 'IF') return parseIf();
    if (tk.t === 'FOR') return parseFor();
    if (tk.t === 'WHILE') return parseWhile();
    if (tk.t === 'SWITCH') return parseSwitch();
    // funcdef: name(params) =>
    if (tk.t === 'IDENT' && at('(', 1)) {
      let q = pos + 2, depth = 1;
      while (depth > 0 && toks[q].t !== 'EOF') { if (toks[q].t==='(') depth++; if (toks[q].t===')') depth--; q++; }
      if (toks[q] && toks[q].t === 'OP' && toks[q].v === '=>') return parseFuncDef();
    }
    // destructure: [a, b] = expr
    if (at('[')) {
      let q = pos + 1;
      while (toks[q] && toks[q].t !== ']' && toks[q].t !== 'EOF') q++;
      if (toks[q] && toks[q].t === ']' && toks[q+1] && toks[q+1].t === 'OP' && toks[q+1].v === '=') {
        next(); const names = [];
        while (!at(']')) { names.push(expectIdent()); if (at(',')) next(); }
        next(); expectOp('=');
        const value = parseExpr();
        expectNL();
        return {type:'Destructure', names, value, line: tk.line};
      }
    }
    const e = parseExpr();
    if (at('OP') && [':=','=','+=','-=','*=','/=','%='].includes(peek().v)) {
      const op = next().v, val = parseExpr(); expectNL();
      if (e.type !== 'Ident' && e.type !== 'Index') err('target assignment tidak valid', tk);
      return {type:'Assign', target: e, op, value: val, line: tk.line};
    }
    expectNL();
    return {type:'ExprStmt', expr: e, line: tk.line};
  }
  function expectIdent() { const t = next(); if (t.t !== 'IDENT') err('identifier diharapkan', t); return t.v; }
  function expectOp(v) { const t = next(); if (t.t !== 'OP' || t.v !== v) err(`'${v}' diharapkan`, t); }
  function expectNL() { if (at('NL')) next(); else if (!at('EOF') && !at('DEDENT')) err('akhir baris diharapkan', peek()); }
  function finishVarDecl(tk, vtype) {
    const name = expectIdent();
    let init = null;
    if (at('OP') && peek().v === '=') { next(); init = parseExpr(); }
    expectNL();
    return {type:'VarDecl', name, vtype, init, line: tk.line};
  }
  function parseBlock() {
    // Pine: blok murni indentasi, tanpa ':'
    expectNL();
    if (!at('INDENT')) err('blok indentasi diharapkan', peek());
    next();
    const body = [];
    while (!at('DEDENT') && !at('EOF')) { if (at('NL')) { next(); continue; } body.push(parseStatement()); }
    next(); // DEDENT
    return body;
  }
  function parseIf() {
    const tk = next();
    const cond = parseExpr();
    const thenB = parseBlock();
    const elifs = [];
    let elseB = null;
    while (at('ELSE')) {
      next();
      if (at('IF')) { next(); const c = parseExpr(); elifs.push({cond: c, body: parseBlock()}); }
      else { elseB = parseBlock(); break; }
    }
    return {type:'If', cond, thenB, elifs, elseB, line: tk.line};
  }
  function parseFor() {
    const tk = next();
    const v = expectIdent(); expectOp('=');
    const from = parseExpr();
    if (!at('TO')) err("'to' diharapkan", peek()); next();
    const to = parseExpr();
    let by = null;
    if (at('BY')) { next(); by = parseExpr(); }
    const body = parseBlock();
    return {type:'For', v, from, to, by, body, line: tk.line};
  }
  function parseWhile() {
    const tk = next();
    const cond = parseExpr();
    const body = parseBlock();
    return {type:'While', cond, body, line: tk.line};
  }
  function parseSwitch() {
    const tk = next();
    const expr = parseExpr();
    expectNL();
    if (!at('INDENT')) err('blok switch diharapkan', peek());
    next();
    const cases = []; let def = null;
    const parseCaseBody = (ct) => {
      if (at('OP') && peek().v === '=>') next();
      if (at('NL')) return parseBlock();
      const e = parseExpr(); expectNL();
      return [{type: 'ExprStmt', expr: e, line: ct.line}];
    };
    while (!at('DEDENT') && !at('EOF')) {
      if (at('NL')) { next(); continue; }
      const ct = peek();
      if (ct.t === 'ELSE') { next(); def = parseCaseBody(ct); continue; }
      if (ct.t === 'OP' && ct.v === '=>') { next(); def = parseCaseBody(ct); continue; }
      const vals = [parseExpr()];
      while (at(',')) { next(); vals.push(parseExpr()); }
      cases.push({vals, body: parseCaseBody(ct)});
    }
    next();
    return {type:'Switch', expr, cases, def, line: tk.line};
  }
  function parseFuncDef() {
    const tk = next(); // name
    next(); // (
    const params = [];
    while (!at(')')) {
      // [type] name [= default]
      let pname;
      if (at('IDENT') && peek(1).t === 'IDENT') { next(); pname = next().v; }
      else pname = next().v;
      let def = null;
      if (at('OP') && peek().v === '=') { next(); def = parseExpr(); }
      params.push({name: pname, def});
      if (at(',')) next();
    }
    next(); // )
    expectOp('=>');
    let body;
    if (at('NL')) { next(); if (!at('INDENT')) err('blok fungsi diharapkan', peek()); next();
      body = [];
      while (!at('DEDENT') && !at('EOF')) { if (at('NL')) { next(); continue; } body.push(parseStatement()); }
      next();
    } else body = [{type:'ExprStmt', expr: parseExpr(), line: tk.line}];
    if (at('NL')) next();
    return {type:'FuncDef', name: tk.v, params, body, line: tk.line};
  }
  // ---- expressions (precedence) ----
  function parseExpr() { return parseTernary(); }
  function parseTernary() {
    let e = parseOr();
    if (at('?')) { next(); const a = parseExpr(); if (!at(':')) err("':' diharapkan", peek()); next(); const b = parseTernary(); e = {type:'Ternary', cond: e, a, b}; }
    return e;
  }
  function parseOr() { let e = parseAnd(); while (at('OR')) { const t=next(); e = {type:'Binary', op:'or', l:e, r:parseAnd(), line:t.line}; } return e; }
  function parseAnd() { let e = parseNot(); while (at('AND')) { const t=next(); e = {type:'Binary', op:'and', l:e, r:parseNot(), line:t.line}; } return e; }
  function parseNot() { if (at('NOT')) { const t=next(); return {type:'Unary', op:'not', e:parseNot(), line:t.line}; } return parseCmp(); }
  function parseCmp() {
    let e = parseAdd();
    while (at('OP') && ['==','!=','<','>','<=','>='].includes(peek().v)) { const t=next(); e = {type:'Binary', op:t.v, l:e, r:parseAdd(), line:t.line}; }
    return e;
  }
  function parseAdd() { let e = parseMul(); while (at('OP') && (peek().v==='+'||peek().v==='-')) { const t=next(); e={type:'Binary',op:t.v,l:e,r:parseMul(),line:t.line}; } return e; }
  function parseMul() { let e = parseUnary(); while (at('OP') && (peek().v==='*'||peek().v==='/'||peek().v==='%')) { const t=next(); e={type:'Binary',op:t.v,l:e,r:parseUnary(),line:t.line}; } return e; }
  function parseUnary() {
    if (at('OP') && (peek().v==='-'||peek().v==='+')) { const t=next(); return {type:'Unary', op:t.v, e:parseUnary(), line:t.line}; }
    return parsePostfix();
  }
  function parsePostfix() {
    let e = parsePrimary();
    for (;;) {
      if (at('[')) { next(); const idx = parseExpr(); if (!at(']')) err("']' diharapkan", peek()); next(); e = {type:'Index', e, idx}; }
      else if (at('DOT')) {
        next(); const prop = expectIdent();
        if (at('(')) e = {type:'MethodCall', obj: e, method: prop, args: parseArgs()};
        else e = {type:'Member', obj: e, prop};
      }
      else if (at('(')) e = {type:'Call', fn: e, args: parseArgs()};
      else break;
    }
    return e;
  }
  function parseArgs() {
    next(); // (
    const args = [], kwargs = {};
    while (!at(')')) {
      if (at('IDENT') && peek(1).t === 'OP' && peek(1).v === '=') { const k = next().v; next(); kwargs[k] = parseExpr(); }
      else args.push(parseExpr());
      if (at(',')) next();
    }
    next(); // )
    return {args, kwargs};
  }
  function parsePrimary() {
    const t = next();
    if (t.t === 'NUM') return {type:'Lit', v: t.v};
    if (t.t === 'STR') return {type:'Lit', v: t.v};
    if (t.t === 'COLOR') return {type:'Lit', v: t.v};
    if (t.t === 'TRUE') return {type:'Lit', v: true};
    if (t.t === 'FALSE') return {type:'Lit', v: false};
    if (t.t === 'IDENT') {
      if (t.v === 'na') return {type:'Lit', v: NaN};
      return {type:'Ident', name: t.v};
    }
    if (t.t === '(') { const e = parseExpr(); if (!at(')')) err("')' diharapkan", peek()); next(); return e; }
    if (t.t === '[') { const els = []; while (!at(']')) { els.push(parseExpr()); if (at(',')) next(); } next(); return {type:'Tuple', els}; }
    err('ekspresi tidak valid', t);
  }
  function isCallAhead() { return peek(1).t === '('; }
  return parseProgram();
}
/* ============================== COMPILER ============================== */
function compilePine(source) {
  const errors = [];
  const lines = source.split('\n');
  const vline = lines.find(l => l.trim().startsWith('//@version='));
  if (!vline) errors.push({line: 1, msg: 'header //@version=5 tidak ditemukan'});
  let ast = null;
  try {
    const toks = tokenize(source);
    ast = parse(toks);
  } catch (e) { errors.push({line: e.line || 1, msg: e.msg || String(e)}); }
  const meta = {title: 'Custom Script', overlay: true};
  const inputs = [];
  const funcs = {};
  if (ast) {
    try { collectMeta(ast, meta, inputs, funcs); }
    catch (e) { errors.push({line: e.line || 1, msg: e.msg || String(e)}); }
  }
  return {ok: errors.length === 0, errors, ast, meta, inputs, funcs};
}

function collectMeta(ast, meta, inputs, funcs) {
  let inId = 0;
  const TA_OK = new Set(['tr','atr','sma','ema','rma','wma','hma','vwma','rsi','macd','stdev','variance','highest','lowest','pivothigh','pivotlow','cross','crossover','crossunder','change','mom','roc','linreg','supertrend','cci','mfi','stoch','barssince']);
  const MATH_OK = new Set(['abs','max','min','avg','floor','ceil','round','pow','sqrt','log','exp','sign']);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FuncDef' && !funcs[node.name]) funcs[node.name] = node;
    if (node.type === 'MethodCall' && node.obj.type === 'Ident') {
      const ns = node.obj.name;
      const known = ns === 'ta' ? TA_OK : ns === 'math' ? MATH_OK
        : ns === 'str' ? new Set(['tostring']) : ns === 'color' ? new Set(['new','rgb']) : null;
      if (known && !known.has(node.method))
        throw {line: node.line + 1, msg: `${ns}.${node.method} belum didukung`};
    }
    if (node.type === 'Call' || node.type === 'MethodCall') {
      const nm = node.type === 'Call' ? (node.fn.type === 'Ident' ? node.fn.name : null)
                                     : (node.obj.type === 'Ident' ? node.obj.name + '.' + node.method : null);
      if (nm === 'indicator') {
        const a = node.args.args, kw = node.args.kwargs;
        if (a[0] && a[0].type === 'Lit') meta.title = String(a[0].v);
        if (kw.overlay !== undefined) meta.overlay = !!kw.overlay.v;
        if (kw.shorttitle && kw.shorttitle.type === 'Lit') meta.shorttitle = String(kw.shorttitle.v);
      } else if (nm === 'strategy') {
        throw {line: node.line + 1, msg: 'strategy() belum didukung — pakai indicator()'};
      } else if (nm && nm.startsWith('input.')) {
        const kind = nm.slice(6);
        const a = node.args.args, kw = node.args.kwargs;
        const lit = (n) => n && n.type === 'Lit' ? n.v : undefined;
        const inp = {id: 'in' + (inId++), kind,
          def: lit(a[0]), label: lit(kw.title) ?? lit(a[1]) ?? ('Input ' + inId),
          min: lit(kw.minval), max: lit(kw.maxval), step: lit(kw.step),
          options: kw.options && kw.options.type === 'Tuple' ? kw.options.els.map(e => e.v) : undefined,
          group: lit(kw.group), line: node.line + 1};
        // input.source: pilihan OHLC
        if (kind === 'source') inp.options = ['open','high','low','close','hl2','hlc3','ohlc4'];
        inputs.push(inp);
        node._inputId = inp.id;
      }
    }
    for (const k in node) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        if (v.type) walk(v);
        else { // {args, kwargs}
          if (Array.isArray(v.args)) v.args.forEach(walk);
          if (v.kwargs && typeof v.kwargs === 'object') Object.values(v.kwargs).forEach(walk);
        }
      }
    }
  };
  walk(ast);
}

/* ============================== VM ============================== */
const isNaN_ = (v) => typeof v === 'number' && isNaN(v);

function PineVM(compiled, candles) {
  this.c = compiled;
  this.candles = candles;
  this.n = candles.length;
  this.inputs = {};      // id -> value
  this.inputDefs = {};
  compiled.inputs.forEach(d => { this.inputDefs[d.id] = d; this.inputs[d.id] = d.def; });
  // series data
  this.O = candles.map(c => c.o); this.H = candles.map(c => c.h);
  this.L = candles.map(c => c.l); this.C = candles.map(c => c.c);
  this.V = candles.map(c => c.v || 0); this.T = candles.map(c => c.t);
  this.reset();
}
PineVM.prototype.reset = function () {
  this.slots = new Map();   // name -> {hist: []}
  this.funcScopes = new Map(); // funcName -> Map
  this.callStates = new Map(); // AST node -> stateful builtin state
  this.temps = new Map();    // temp slot per Index/arg node
  this.plots = []; this.shapes = []; this.chars = [];
  this.hlines = []; this.fills = [];
  this.drawLines = []; this.drawBoxes = []; this.drawLabels = []; this.lineFills = [];
  this._drawId = 1;
  this._bg = new Array(this.n).fill(null);
  this._bc = new Array(this.n).fill(null);
  this.bar = 0;
  this.alerts = [];
};
PineVM.prototype.setInputs = function (vals) {
  for (const k in vals) if (k in this.inputs) {
    const d = this.inputDefs[k];
    let v = vals[k];
    if (d.kind === 'int') v = Math.round(Number(v));
    if (d.kind === 'float') v = Number(v);
    if (d.kind === 'bool') v = !!v;
    this.inputs[k] = v;
  }
};
PineVM.prototype.slot = function (name) {
  let s = this.slots.get(name);
  if (!s) { s = {hist: []}; this.slots.set(name, s); }
  return s;
};
PineVM.prototype.cur = function (v) { return v && v.__slot ? this.val(v) : v; };
PineVM.prototype.val = function (ref) { // ref = {__slot}
  const s = ref.__slot;
  if (s.gen) return (this.bar >= 0 && this.bar < this.n) ? s.gen(this.bar) : NaN;
  if (s.hist) { const h = s.hist; return h.length > this.bar ? h[this.bar] : (h.length ? h[h.length-1] : NaN); }
  return s.const;
};
PineVM.prototype.histOf = function (v, k) { // value k bars ago
  if (v && v.__slot) return this.sv(v, this.bar - k);
  return k === 0 ? v : NaN;
};
PineVM.prototype.asSeries = function (v) { // wrap plain value as constant series ref
  if (v && v.__slot) return v;
  return {__slot: {hist: null, const: v}};
};
PineVM.prototype.seriesVal = function (ref, i) {
  const s = ref.__slot;
  if (s.hist) return (i >= 0 && i < s.hist.length) ? s.hist[i] : NaN;
  return s.const;
};
PineVM.prototype.builtinSeries = function (name) {
  const m = {open: this.O, high: this.H, low: this.L, close: this.C, volume: this.V,
             hl2: null, hlc3: null, ohlc4: null, bar_index: null, time: this.T};
  if (!(name in m)) return null;
  if (name === 'hl2') return {__slot: {hist: null, gen: (i) => (this.H[i]+this.L[i])/2}};
  if (name === 'hlc3') return {__slot: {hist: null, gen: (i) => (this.H[i]+this.L[i]+this.C[i])/3}};
  if (name === 'ohlc4') return {__slot: {hist: null, gen: (i) => (this.O[i]+this.H[i]+this.L[i]+this.C[i])/4}};
  if (name === 'bar_index') return {__slot: {hist: null, gen: (i) => i}};
  const arr = m[name];
  return {__slot: {hist: arr}};
};
/* ============================== EVALUATOR ============================== */
PineVM.prototype.truth = function (v) {
  v = this.cur(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return !isNaN(v) && v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return v !== null && v !== undefined;
};
PineVM.prototype.setSlot = function (slot, v) {
  const h = slot.hist, b = this.bar;
  if (h.length <= b) { while (h.length < b) h.push(h.length ? h[h.length-1] : NaN); h.push(v); }
  else h[b] = v;
};
PineVM.prototype.newScope = function (parent) { return {map: new Map(), parent: parent || null}; };
PineVM.prototype.scopeGet = function (scope, name) {
  let s = scope;
  while (s) { if (s.map.has(name)) return s.map.get(name); s = s.parent; }
  return null;
};
PineVM.prototype.lookup = function (name, scope) {
  const sl = this.scopeGet(scope, name);
  // slot yang belum pernah diisi nilai jangan menutupi namespace (mis. display = display.all - ...)
  if (sl && sl.hist.length > 0) return {__slot: sl};
  const gs = this.slots.get(name);
  if (gs && gs.hist.length > 0) return {__slot: gs};
  const bs = this.builtinSeries(name);
  if (bs) return bs;
  const ns = this.namespaces()[name];
  if (ns !== undefined) return ns;
  if (sl || gs) return {__slot: sl || gs};
  throw {line: this._line, msg: 'nama tidak dikenal: ' + name};
};
PineVM.prototype.eval = function (node, scope) {
  if (!node) return NaN;
  switch (node.type) {
    case 'Lit': return node.v;
    case 'Ident': return this.lookup(node.name, scope);
    case 'Tuple': return node.els.map(e => this.eval(e, scope));
    case 'Ternary': {
      const c = this.eval(node.cond, scope);
      return this.truth(c) ? this.eval(node.a, scope) : this.eval(node.b, scope);
    }
    case 'Unary': {
      const v = this.cur(this.eval(node.e, scope));
      if (node.op === 'not') return !this.truth(v);
      if (node.op === '-') return -v;
      return +v;
    }
    case 'Binary': {
      const op = node.op;
      if (op === 'and') return this.truth(this.eval(node.l, scope)) && this.truth(this.eval(node.r, scope));
      if (op === 'or') return this.truth(this.eval(node.l, scope)) || this.truth(this.eval(node.r, scope));
      const l = this.cur(this.eval(node.l, scope)), r = this.cur(this.eval(node.r, scope));
      switch (op) {
        case '+': return l + r; case '-': return l - r;
        case '*': return l * r; case '/': return r === 0 ? NaN : l / r;
        case '%': return l % r;
        case '==': return (isNaN_(l) && isNaN_(r)) ? false : l === r;
        case '!=': return (isNaN_(l) && isNaN_(r)) ? false : l !== r;
        case '<': return l < r; case '>': return l > r;
        case '<=': return l <= r; case '>=': return l >= r;
      }
      throw {line: node.line + 1, msg: 'operator tidak dikenal: ' + op};
    }
    case 'Index': {
      const k = Math.round(this.cur(this.eval(node.idx, scope)));
      if (node.e.type === 'Ident') {
        const ref = this.lookup(node.e.name, scope);
        return this.histOf(ref, k);
      }
      let t = this.temps.get(node);
      if (!t) { t = {hist: []}; this.temps.set(node, t); }
      const v = this.cur(this.eval(node.e, scope));
      this.setSlot(t, v);
      const i = this.bar - k;
      return (i >= 0 && i < t.hist.length) ? t.hist[i] : NaN;
    }
    case 'Call': {
      const fn = node.fn;
      if (fn.type !== 'Ident') throw {line: node.line + 1, msg: 'pemanggilan tidak valid'};
      return this.callNamed(fn.name, node, scope);
    }
    case 'MethodCall': {
      const oNode = node.obj;
      let obj = (oNode.type === 'Ident' && this.isNs(oNode.name)) ? this.nsObj(oNode.name) : this.eval(oNode, scope);
      obj = this.cur(obj); // unwrap slot -> nilai saat ini (penting untuk objek gambar)
      return this.callMethod(obj, node.method, node, scope);
    }
    case 'Member': {
      const oNode = node.obj;
      let obj = (oNode.type === 'Ident' && this.isNs(oNode.name)) ? this.nsObj(oNode.name) : this.eval(oNode, scope);
      obj = this.cur(obj);
      if (obj && obj.__ns === 'barstate') return this.barstateProp(node.prop, node);
      if (obj && obj.__ns) {
        if (node.prop in obj) return obj[node.prop];
        throw {line: node.line + 1, msg: `anggota tidak dikenal: ${obj.__name}.${node.prop}`};
      }
      if (obj && obj.__draw) return this.drawProp(obj, node.prop, node);
      throw {line: node.line + 1, msg: 'member access tidak valid'};
    }
  }
  throw {line: node.line + 1, msg: 'node tidak dikenal: ' + node.type};
};
PineVM.prototype.execStmts = function (stmts, scope) {
  let last = NaN;
  for (const st of stmts) last = this.exec(st, scope);
  return last;
};
PineVM.prototype.exec = function (st, scope) {
  switch (st.type) {
    case 'VarDecl': {
      let sl = this.scopeGet(scope, st.name);
      if (!sl) { sl = {hist: []}; (scope ? scope.map : this.slots).set(st.name, sl); }
      const isVar = true; // var / typed decl: init sekali
      if (sl.hist.length === 0) this.setSlot(sl, st.init ? this.cur(this.eval(st.init, scope)) : NaN);
      return NaN;
    }
    case 'Assign': {
      const t = st.target;
      if (t.type !== 'Ident') throw {line: st.line + 1, msg: 'assignment target harus variabel'};
      let sl = this.scopeGet(scope, t.name);
      if (!sl) {
        if (st.op !== '=') throw {line: st.line + 1, msg: `':=' dipakai sebelum '${t.name}' dideklarasikan`};
        sl = {hist: []}; (scope ? scope.map : this.slots).set(t.name, sl);
      }
      const v = this.cur(this.eval(st.value, scope));
      const prev = sl.hist.length > this.bar ? sl.hist[this.bar] : (sl.hist.length ? sl.hist[sl.hist.length-1] : NaN);
      let nv = v;
      if (st.op === '+=') nv = prev + v;
      else if (st.op === '-=') nv = prev - v;
      else if (st.op === '*=') nv = prev * v;
      else if (st.op === '/=') nv = v === 0 ? NaN : prev / v;
      else if (st.op === '%=') nv = prev % v;
      this.setSlot(sl, nv);
      return nv;
    }
    case 'Destructure': {
      const v = this.eval(st.value, scope);
      if (!Array.isArray(v)) throw {line: st.line + 1, msg: 'destructuring butuh tuple/array'};
      st.names.forEach((nm, i) => {
        let sl = this.scopeGet(scope, nm);
        if (!sl) { sl = {hist: []}; (scope ? scope.map : this.slots).set(nm, sl); }
        this.setSlot(sl, this.cur(v[i]));
      });
      return NaN;
    }
    case 'If': {
      if (this.truth(this.eval(st.cond, scope))) return this.execStmts(st.thenB, scope);
      for (const e of st.elifs) if (this.truth(this.eval(e.cond, scope))) return this.execStmts(e.body, scope);
      if (st.elseB) return this.execStmts(st.elseB, scope);
      return NaN;
    }
    case 'For': {
      const from = Math.round(this.cur(this.eval(st.from, scope)));
      const to = Math.round(this.cur(this.eval(st.to, scope)));
      let by = st.by ? Math.round(this.cur(this.eval(st.by, scope))) : 1;
      if (by === 0) by = 1;
      const lscope = this.newScope(scope);
      const sl = {hist: []}; lscope.map.set(st.v, sl);
      let last = NaN, guard = 0;
      if (by > 0) for (let i = from; i <= to && guard++ < 100000; i += by) { this.setSlot(sl, i); last = this.execStmts(st.body, lscope); }
      else for (let i = from; i >= to && guard++ < 100000; i += by) { this.setSlot(sl, i); last = this.execStmts(st.body, lscope); }
      return last;
    }
    case 'While': {
      let last = NaN, guard = 0;
      while (this.truth(this.eval(st.cond, scope)) && guard++ < 10000) last = this.execStmts(st.body, scope);
      return last;
    }
    case 'Switch': {
      const v = this.cur(this.eval(st.expr, scope));
      for (const c of st.cases) {
        for (const cv of c.vals) if (this.cur(this.eval(cv, scope)) === v) return this.execStmts(c.body, scope);
      }
      if (st.def) return this.execStmts(st.def, scope);
      return NaN;
    }
    case 'FuncDef': return NaN; // sudah dikoleksi saat compile
    case 'ExprStmt': return this.eval(st.expr, scope);
  }
  return NaN;
};
PineVM.prototype.run = function (cursor) {
  this.reset();
  this._cursor = cursor;
  const maxBar = Math.min(cursor, this.n - 1);
  const gscope = this.newScope(null); gscope.map = this.slots;
  for (let b = 0; b <= maxBar; b++) {
    this.bar = b;
    try { this.execStmts(this.c.ast.body, gscope); }
    catch (e) { throw {line: (e.line || 1), msg: e.msg || String(e), bar: b}; }
    // finalize: slot yang tidak di-assign bar ini mewarisi nilai sebelumnya
    const fill = (map) => {
      map.forEach(sl => { if (sl.hist.length <= b) sl.hist.push(sl.hist.length ? sl.hist[sl.hist.length-1] : NaN); });
    };
    fill(this.slots);
    this.funcScopes.forEach(m => fill(m));
  }
  this.bar = maxBar;
  return this.outputs(maxBar);
};
/* ============================== BUILTINS ============================== */
function cssColor(c) {
  if (typeof c !== 'string') return '#808080';
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    if (h.length === 8) {
      const a = parseInt(h.slice(6, 8), 16) / 255;
      h = h.slice(0, 6);
      const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
      return `rgba(${r},${g},${b},${(1-a).toFixed(3)})`;
    }
    const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
    return `rgb(${r},${g},${b})`;
  }
  if (c.startsWith('rgb')) return c;
  return '#808080';
}
function withTransp(css, t) { // t: 0-100
  const m = css.match(/rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)/);
  if (!m) return css;
  const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
  return `rgba(${m[1]},${m[2]},${m[3]},${(a * (1 - t/100)).toFixed(3)})`;
}

PineVM.prototype._ns = null;
PineVM.prototype.isNs = function (name) {
  return !!(this.namespaces()[name] || this.extraNamespaces()[name]);
};
PineVM.prototype.nsObj = function (name) {
  return this.namespaces()[name] || this.extraNamespaces()[name];
};
PineVM.prototype.namespaces = function () {
  if (this._ns) return this._ns;
  const C = (h) => cssColor(h);
  const N = (name, obj) => { obj.__ns = name; obj.__name = name; return obj; };
  this._ns = {
    ta: N('ta', {}), math: N('math', {}), str: N('str', {}), color: N('color', {
      red: C('#ff0000'), green: C('#00ff00'), blue: C('#0000ff'), teal: C('#008080'),
      orange: C('#ff9800'), yellow: C('#ffff00'), purple: C('#800080'), black: C('#000000'),
      white: C('#ffffff'), gray: C('#808080'), silver: C('#c0c0c0'), navy: C('#000080'),
      maroon: C('#800000'), olive: C('#808000'), lime: C('#00ff00'), aqua: C('#00ffff'),
      fuchsia: C('#ff00ff'),
    }),
    input: N('input', {}), barstate: N('barstate', {}), chart: N('chart', {
      bg_color: C('#ffffff'), fg_color: C('#000000'),
    }),
    display: N('display', {all: 3, none: 0, status_line: 1, data_window: 2, price_scale: 4}),
    size: N('size', {tiny: 'tiny', small: 'small', normal: 'normal', large: 'large', huge: 'huge', auto: 'auto'}),
    shape: N('shape', {labelup: 'labelup', labeldown: 'labeldown', diamond: 'diamond', circle: 'circle',
      triangleup: 'triangleup', triangledown: 'triangledown', cross: 'cross', xcross: 'xcross'}),
    location: N('location', {abovebar: 'abovebar', belowbar: 'belowbar', top: 'top', bottom: 'bottom', absolute: 'absolute', auto: 'auto'}),
    plot: N('plot', {style_line: 'line', style_linebr: 'linebr', style_stepline: 'stepline',
      style_histogram: 'histogram', style_columns: 'columns', style_area: 'area',
      style_circles: 'circles', style_cross: 'cross'}),
    extend: N('extend', {none: 'none', right: 'right', left: 'left', both: 'both'}),
    xloc: N('xloc', {bar_index: 'bar_index', bar_time: 'bar_time'}),
    yloc: N('yloc', {price: 'price', abovebar: 'abovebar', belowbar: 'belowbar'}),
    syminfo: N('syminfo', {ticker: 'SYMBOL', tickerid: 'EXCHANGE:SYMBOL', type: 'crypto'}),
  };
  return this._ns;
};
// series value helper
PineVM.prototype.barstateProp = function (prop, node) {
  switch (prop) {
    case 'isfirst': return this.bar === 0;
    case 'islast': return this.bar === (this._cursor || 0);
    case 'isrealtime': return this.bar === (this._cursor || 0);
    case 'isnew': return true;
    case 'isconfirmed': return true;
    case 'ishistory': return this.bar < (this._cursor || 0);
  }
  throw {line: node.line + 1, msg: 'anggota tidak dikenal: barstate.' + prop};
};
PineVM.prototype.sv = function (ref, i) {
  if (!ref || !ref.__slot) return ref;
  const s = ref.__slot;
  if (s.gen) return (i >= 0 && i < this.n) ? s.gen(i) : NaN;
  if (s.hist) return (i >= 0 && i < s.hist.length) ? s.hist[i] : NaN;
  return s.const;
};
PineVM.prototype.callState = function (node) {
  let st = this.callStates.get(node);
  if (!st) { st = {}; this.callStates.set(node, st); }
  return st;
};

PineVM.prototype.callNamed = function (name, node, scope) {
  const A = node.args.args, K = node.args.kwargs;
  const arg = (i, nm, def) => {
    if (K[nm] !== undefined) return this.eval(K[nm], scope);
    if (A[i] !== undefined) return this.eval(A[i], scope);
    return def;
  };
  const argv = (i, nm, def) => this.cur(arg(i, nm, def));
  // user function?
  if (this.c.funcs && this.c.funcs[name]) return this.callUser(this.c.funcs[name], node, scope);
  if (name === 'color' && this.isNs('color')) return this.cur(arg(0, 'x', NaN)); // color(x): identity (pola LuxAlgo)
  switch (name) {
    case 'indicator': return NaN; // metadata sudah diambil saat compile
    case 'nz': { const v = argv(0, 'source'); const r = argv(1, 'replacement', 0); const c = this.cur(v); return isNaN_(c) ? r : c; }
    case 'na': { return isNaN_(this.cur(arg(0, 'x'))); }
    case 'plot': return this.bPlot(arg, scope, node);
    case 'plotshape': return this.bPlotShape(arg, scope, node, false);
    case 'plotchar': return this.bPlotShape(arg, scope, node, true);
    case 'hline': return this.bHline(arg, scope, node);
    case 'fill': return this.bFill(arg, scope, node);
    case 'bgcolor': { const c = argv(1, 'color', argv(0, 'color')); this._bg[this.bar] = cssColor(c); return NaN; }
    case 'barcolor': { const c = argv(1, 'color', argv(0, 'color')); this._bc[this.bar] = cssColor(c); return NaN; }
    case 'alertcondition': return NaN;
    case 'alert': return NaN;
  }
  throw {line: node.line + 1, msg: 'fungsi tidak dikenal: ' + name};
};

PineVM.prototype.callMethod = function (obj, method, node, scope) {
  const A = node.args.args, K = node.args.kwargs;
  const arg = (i, nm, def) => {
    if (K[nm] !== undefined) return this.eval(K[nm], scope);
    if (A[i] !== undefined) return this.eval(A[i], scope);
    return def;
  };
  const argv = (i, nm, def) => this.cur(arg(i, nm, def));
  if (obj && obj.__draw) return this.drawMethod(obj, method, arg, argv, node);
  if (obj && obj.__ns) {
    const ns = obj.__ns;
    if (ns === 'input') {
      const id = node._inputId;
      const v = this.inputs[id];
      return v !== undefined ? v : this.inputDefs[id].def;
    }
    if (ns === 'ta') return this.taCall(method, arg, argv, node, scope);
    if (ns === 'math') return this.mathCall(method, argv, node);
    if (ns === 'str') {
      if (method === 'tostring') { const v = argv(0, 'x'); return v === null || v === undefined ? 'na' : String(isNaN_(v) ? 'na' : v); }
      throw {line: node.line + 1, msg: 'str.' + method + ' belum didukung'};
    }
    if (ns === 'color') {
      if (method === 'new') { const c = argv(0, 'color', '#000000'); const t = argv(1, 'transp', 0); return withTransp(cssColor(c), t); }
      if (method === 'rgb') { const r = argv(0,'r',0), g = argv(1,'g',0), b = argv(2,'b',0), t = argv(3,'transp',0); return withTransp(`rgb(${r|0},${g|0},${b|0})`, t); }
      throw {line: node.line + 1, msg: 'color.' + method + ' belum didukung'};
    }
    throw {line: node.line + 1, msg: `namespace ${ns}.${method} belum didukung`};
  }
  throw {line: node.line + 1, msg: 'method call tidak valid'};
};
/* ---------- ta.* ---------- */
PineVM.prototype.taCall = function (method, arg, argv, node, scope) {
  const vm = this, b = this.bar, n = this.n;
  const S = (v) => vm.asSeries(v);
  const gv = (ref, i) => vm.sv(ref, i);
  const st = this.callState(node);
  const sumN = (ref, len, i) => { let s = 0; for (let k = 0; k < len; k++) { const v = gv(ref, i-k); if (isNaN_(v)) return NaN; s += v; } return s; };
  switch (method) {
    case 'sma': { const src = S(arg(0,'source')), len = Math.max(1, Math.round(argv(1,'length')));
      if (b < len - 1) return NaN; return sumN(src, len, b) / len; }
    case 'wma': { const src = S(arg(0,'source')), len = Math.max(1, Math.round(argv(1,'length')));
      if (b < len - 1) return NaN;
      let s = 0, w = 0;
      for (let k = 0; k < len; k++) { const v = gv(src, b-k); if (isNaN_(v)) return NaN; const wt = len - k; s += v*wt; w += wt; }
      return s / w; }
    case 'ema': case 'rma': {
      const src = S(arg(0,'source')), len = Math.max(1, Math.round(argv(1,'length')));
      const alpha = method === 'ema' ? 2/(len+1) : 1/len;
      if (!st.vals) st.vals = [];
      while (st.vals.length <= b) {
        const i = st.vals.length;
        if (i < len - 1) st.vals.push(NaN);
        else if (i === len - 1) { const s = sumN(src, len, i); st.vals.push(isNaN_(s) ? NaN : s/len); }
        else { const cv = gv(src, i), pv = st.vals[i-1]; st.vals.push(isNaN_(cv)||isNaN_(pv) ? NaN : cv*alpha + pv*(1-alpha)); }
      }
      return st.vals[b]; }
    case 'hma': { const src = S(arg(0,'source')), len = Math.max(2, Math.round(argv(1,'length')));
      const wma = (ref, L, i) => { if (i < L-1) return NaN; let s=0,w=0; for (let k=0;k<L;k++){const v=gv(ref,i-k); if(isNaN_(v))return NaN; const wt=L-k; s+=v*wt; w+=wt;} return s/w; };
      if (!st.raw) st.raw = [];
      while (st.raw.length <= b) { const i = st.raw.length;
        const a = wma(src, Math.floor(len/2), i), c = wma(src, len, i);
        st.raw.push(isNaN_(a)||isNaN_(c) ? NaN : 2*a - c); }
      const sq = Math.max(1, Math.round(Math.sqrt(len)));
      const ref = {__slot: {hist: st.raw}};
      if (b < sq - 1) return NaN;
      let s=0,w=0; for (let k=0;k<sq;k++){const v=st.raw[b-k]; if(isNaN_(v))return NaN; const wt=sq-k; s+=v*wt; w+=wt;}
      return s/w; }
    case 'vwma': { const src = S(arg(0,'source')), len = Math.max(1, Math.round(argv(1,'length')));
      if (b < len - 1) return NaN;
      let sv = 0, vv = 0;
      for (let k = 0; k < len; k++) { const p = gv(src, b-k), v = this.V[b-k]; if (isNaN_(p)||isNaN_(v)) return NaN; sv += p*v; vv += v; }
      return vv === 0 ? NaN : sv/vv; }
    case 'tr': { const h = this.H[b], l = this.L[b], pc = b > 0 ? this.C[b-1] : NaN;
      if (b === 0) return h - l; return Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)); }
    case 'atr': { const len = Math.max(1, Math.round(argv(1,'length')));
      if (!st.vals) st.vals = [];
      while (st.vals.length <= b) { const i = st.vals.length;
        const h=this.H[i], l=this.L[i], pc=i>0?this.C[i-1]:NaN;
        const tr = i===0 ? h-l : Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
        if (i < len-1) st.vals.push(NaN);
        else if (i === len-1) { let s=0; for(let k=0;k<len;k++){const hh=this.H[k],ll=this.L[k],pp=k>0?this.C[k-1]:NaN; s+= k===0?hh-ll:Math.max(hh-ll,Math.abs(hh-pp),Math.abs(ll-pp));} st.vals.push(s/len); }
        else { const pv=st.vals[i-1]; st.vals.push(isNaN_(pv)?NaN: (pv*(len-1)+tr)/len); } }
      return st.vals[b]; }
    case 'rsi': { const src = S(arg(0,'source')), len = Math.max(1, Math.round(argv(1,'length')));
      if (!st.u) { st.u = []; st.d = []; }
      while (st.u.length <= b) { const i = st.u.length;
        if (i < len) { st.u.push(NaN); st.d.push(NaN); continue; }
        if (i === len) { let su=0, sd=0; for(let k=1;k<=len;k++){const ch=gv(src,k)-gv(src,k-1); if(ch>0)su+=ch; else sd-=ch;} st.u.push(su/len); st.d.push(sd/len); }
        else { const ch=gv(src,i)-gv(src,i-1); const up=ch>0?ch:0, dn=ch<0?-ch:0;
          st.u.push((st.u[i-1]*(len-1)+up)/len); st.d.push((st.d[i-1]*(len-1)+dn)/len); } }
      const u=st.u[b], d=st.d[b];
      if (isNaN_(u)||isNaN_(d)) return NaN;
      if (d === 0) return 100;
      return 100 - 100/(1+u/d); }
    case 'macd': { const src=S(arg(0,'source')), f=Math.max(1,Math.round(argv(1,'fastlen',12))), s=Math.max(1,Math.round(argv(2,'slowlen',26))), sig=Math.max(1,Math.round(argv(3,'siglen',9)));
      const ema = (L, i) => { const al=2/(L+1); let e=NaN;
        for (let k=0;k<=i;k++){const v=gv(src,k); if(isNaN_(v))continue;
          if (k<L-1) continue;
          if (k===L-1){let sm=0,ok=true; for(let j=0;j<L;j++){const x=gv(src,j); if(isNaN_(x)){ok=false;break;} sm+=x;} e=ok?sm/L:NaN;}
          else if(!isNaN_(e)) e=v*al+e*(1-al);} return e; };
      const ml = ema(f,b)-ema(s,b);
      if (isNaN_(ml)) return [NaN,NaN,NaN];
      const al=2/(sig+1); let sg=NaN;
      for (let k=s-1;k<=b;k++){const m2=ema(f,k)-ema(s,k); if(isNaN_(m2))continue;
        if(k===s-1){let sm=0,cnt=0; for(let j=s-1;j<=k;j++){const x=ema(f,j)-ema(s,j); if(!isNaN_(x)){sm+=x;cnt++;}} sg=cnt?sm/Math.max(1,cnt):NaN;}
        else if(!isNaN_(sg)) sg=m2*al+sg*(1-al); else sg=m2;}
      return [ml, sg, isNaN_(sg)?NaN:ml-sg]; }
    case 'stdev': case 'variance': { const src=S(arg(0,'source')), len=Math.max(1,Math.round(argv(1,'length')));
      const biased = argv(2,'biased',true) !== false;
      if (b < len-1) return NaN;
      const m = sumN(src,len,b)/len; let s=0;
      for (let k=0;k<len;k++){const d=gv(src,b-k)-m; s+=d*d;}
      const v = s/(biased?len:Math.max(1,len-1));
      return method==='variance'?v:Math.sqrt(v); }
    case 'highest': case 'lowest': { const src=S(arg(0,'source')), len=Math.max(1,Math.round(argv(1,'length')));
      if (b < 0) return NaN;
      let r = method==='highest'?-Infinity:Infinity, found=false;
      for (let k=0;k<len && b-k>=0;k++){const v=gv(src,b-k); if(isNaN_(v))continue; found=true; r=method==='highest'?Math.max(r,v):Math.min(r,v);}
      return found?r:NaN; }
    case 'pivothigh': case 'pivotlow': { const L=Math.round(argv(0,'leftbars')), R=Math.round(argv(1,'rightbars'));
      const isH = method==='pivothigh';
      if (b < L+R) return NaN;
      const c = b - R, arr = isH?this.H:this.L, cv = arr[c];
      for (let k=c-L;k<=c+R;k++){ if(k===c)continue; if(isH?arr[k]>=cv:arr[k]<=cv) return NaN; }
      return cv; }
    case 'cross': { const a=S(arg(0,'a')), c=S(arg(1,'b'));
      const a0=gv(a,b),a1=gv(a,b-1),c0=gv(c,b),c1=gv(c,b-1);
      return ((a1<=c1&&a0>c0)||(a1>=c1&&a0<c0)); }
    case 'crossover': { const a=S(arg(0,'a')), c=S(arg(1,'b'));
      return gv(a,b-1)<=gv(c,b-1)&&gv(a,b)>gv(c,b); }
    case 'crossunder': { const a=S(arg(0,'a')), c=S(arg(1,'b'));
      return gv(a,b-1)>=gv(c,b-1)&&gv(a,b)<gv(c,b); }
    case 'change': case 'mom': { const src=S(arg(0,'source')), len=Math.round(argv(1,'length',1));
      return gv(src,b)-gv(src,b-len); }
    case 'roc': { const src=S(arg(0,'source')), len=Math.round(argv(1,'length'));
      const p=gv(src,b-len); return p===0||isNaN_(p)?NaN:(gv(src,b)-p)/Math.abs(p)*100; }
    case 'linreg': { const src=S(arg(0,'source')), len=Math.max(2,Math.round(argv(1,'length'))), off=Math.round(argv(2,'offset',0));
      if (b < len-1) return NaN;
      let sx=0,sy=0,sxx=0,sxy=0;
      for(let k=0;k<len;k++){const x=k,y=gv(src,b-len+1+k); if(isNaN_(y))return NaN; sx+=x;sy+=y;sxx+=x*x;sxy+=x*y;}
      const dn=len*sxx-sx*sx; if(dn===0)return NaN;
      const sl=(len*sxy-sx*sy)/dn, it=(sy-sl*sx)/len;
      return it+sl*(len-1-off); }
    case 'supertrend': { const f=argv(0,'factor',3), p=Math.max(1,Math.round(argv(1,'atrperiod',10)));
      if (!st.dir) { st.dir=[]; st.st=[]; }
      const hl2=(this.H[b]+this.L[b])/2;
      while (st.st.length<=b){ const i=st.st.length;
        const h=this.H[i],l=this.L[i],pc=i>0?this.C[i-1]:NaN;
        const tr=i===0?h-l:Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));
        let atrv;
        if(!st.atr)st.atr=[];
        if(i<p-1)atrv=NaN;
        else if(i===p-1){let s=0;for(let k=0;k<p;k++){const hh=this.H[k],ll=this.L[k],pp=k>0?this.C[k-1]:NaN;s+=k===0?hh-ll:Math.max(hh-ll,Math.abs(hh-pp),Math.abs(ll-pp));}atrv=s/p;}
        else{const pv=st.atr[i-1];atrv=isNaN_(pv)?NaN:(pv*(p-1)+tr)/p;}
        st.atr.push(atrv);
        const h2=(h+l)/2;
        let up=h2+f*atrv, dn=h2-f*atrv;
        if(i>0&&!isNaN_(st.up?.[i-1])){const pu=st.up[i-1]; up= this.C[i-1]>pu?Math.max(up,pu):up;}
        if(i>0&&!isNaN_(st.dn?.[i-1])){const pd=st.dn[i-1]; dn= this.C[i-1]<pd?Math.min(dn,pd):dn;}
        if(!st.up)st.up=[]; if(!st.dn)st.dn=[];
        st.up.push(up); st.dn.push(dn);
        let dir, svv;
        if(i===0){dir=1;svv=up;}
        else{const pd=st.dir[i-1], ps=st.st[i-1];
          if(ps===st.up[i-1]){ if(this.C[i]>up){dir=-1;svv=dn;} else{dir=1;svv=up;} }
          else { if(this.C[i]<dn){dir=1;svv=up;} else{dir=-1;svv=dn;} } }
        st.dir.push(dir); st.st.push(svv);
      }
      return [st.st[b], st.dir[b]]; }
    case 'cci': { const src=S(arg(0,'source')), len=Math.max(1,Math.round(argv(1,'length')));
      if(b<len-1)return NaN; const m=sumN(src,len,b)/len; let md=0;
      for(let k=0;k<len;k++)md+=Math.abs(gv(src,b-k)-m); md/=len;
      return md===0?NaN:(gv(src,b)-m)/(0.015*md); }
    case 'mfi': { const len=Math.max(1,Math.round(argv(1,'length')));
      if(b<len)return NaN; let pos=0,neg=0;
      for(let k=0;k<len;k++){const i=b-k; const tp=(this.H[i]+this.L[i]+this.C[i])/3, tp1=(this.H[i-1]+this.L[i-1]+this.C[i-1])/3;
        const mf=tp*this.V[i]; if(tp>tp1)pos+=mf; else if(tp<tp1)neg+=mf;}
      if(neg===0)return 100; const mr=pos/neg; return 100-100/(1+mr); }
    case 'stoch': { const src=S(arg(0,'source')), hi=S(arg(1,'high')), lo=S(arg(2,'low')), len=Math.max(1,Math.round(argv(3,'length')));
      let hh=-Infinity,ll=Infinity;
      for(let k=0;k<len&&b-k>=0;k++){const h=gv(hi,b-k),l=gv(lo,b-k); if(!isNaN_(h))hh=Math.max(hh,h); if(!isNaN_(l))ll=Math.min(ll,l);}
      if(!isFinite(hh)||hh===ll)return NaN; return (gv(src,b)-ll)/(hh-ll)*100; }
    case 'barssince': { const c=arg(0,'condition');
      for(let k=0;k<=b;k++){ if(this.truth(this.histCond(c,b-k))) return k; } return NaN; }
  }
  throw {line: node.line + 1, msg: 'ta.' + method + ' belum didukung'};
};
PineVM.prototype.histCond = function (v, i) {
  // truth of a value/expression at bar i (for barssince on complex exprs: approximate with current)
  if (v && v.__slot) { const h=v.__slot.hist; const x=(i>=0&&i<h.length)?h[i]:NaN; return x===true||(typeof x==='number'&&!isNaN(x)&&x!==0); }
  const x = this.cur(v); return x===true||(typeof x==='number'&&!isNaN(x)&&x!==0);
};
/* ---------- math.* ---------- */
PineVM.prototype.mathCall = function (method, argv, node) {
  const nums = [];
  for (let i = 0; i < 10; i++) { const v = argv(i, 'number'+i, undefined); if (v === undefined) break; nums.push(this.cur(v)); }
  const a = nums[0], c = nums[1];
  switch (method) {
    case 'abs': return Math.abs(a); case 'floor': return Math.floor(a); case 'ceil': return Math.ceil(a);
    case 'sqrt': return a < 0 ? NaN : Math.sqrt(a); case 'exp': return Math.exp(a);
    case 'log': return a <= 0 ? NaN : Math.log(a); case 'sign': return a > 0 ? 1 : a < 0 ? -1 : 0;
    case 'round': return Math.round(a);
    case 'pow': return Math.pow(a, c); case 'max': return Math.max(...nums); case 'min': return Math.min(...nums);
    case 'avg': return nums.reduce((s,x)=>s+x,0)/nums.length;
  }
  throw {line: node.line + 1, msg: 'math.' + method + ' belum didukung'};
};
/* ---------- plot / drawings ---------- */
PineVM.prototype.bPlot = function (arg, scope, node) {
  const v = arg(0, 'series');
  const title = String(this.cur(arg(1, 'title', 'plot')));
  const cRaw = arg(2, 'color', '#2962ff');
  const lw = Math.round(this.cur(arg(3, 'linewidth', 1)) || 1);
  const style = String(this.cur(arg(4, 'style', 'line')));
  const offset = Math.round(this.cur(arg(7, 'offset', 0)));
  let p = this.plots.find(p => p._node === node);
  if (!p) { p = {_node: node, title, values: [], colors: [], color: '#2962ff', isSeriesColor: false, linewidth: lw, style, offset}; this.plots.push(p); }
  p.values[this.bar] = this.cur(v);
  if (cRaw && cRaw.__slot) { p.isSeriesColor = true; p.colors[this.bar] = cssColor(this.val(cRaw)); }
  else if (!p.isSeriesColor) p.color = cssColor(this.cur(cRaw));
  Object.assign(p, {title, linewidth: lw, style, offset});
  return {__plot: this.plots.indexOf(p)};
};
PineVM.prototype.bPlotShape = function (arg, scope, node, isChar) {
  const series = arg(0, 'series');
  const title = String(this.cur(arg(1, 'title', 'shape')));
  const style = String(this.cur(arg(2, 'style', 'labelup')));
  const location = String(this.cur(arg(3, 'location', 'auto')));
  const color = cssColor(this.cur(arg(4, 'color', '#000000')));
  const text = String(this.cur(arg(5, 'text', '')));
  const textcolor = cssColor(this.cur(arg(6, 'textcolor', '#ffffff')));
  const size = String(this.cur(arg(7, 'size', 'small')));
  const v = this.cur(series);
  let show;
  if (isChar) show = (typeof v === 'string' && v.length > 0);
  else show = this.truth(v) && !(typeof v === 'number' && v === 0 && false);
  if (isChar && typeof v !== 'string') show = false;
  if (!isChar && typeof v === 'number' && (v === 0 || isNaN_(v))) show = false;
  if (show) {
    const b = this.bar;
    let y = v, ymode = location;
    const pad = (this.H[b] - this.L[b]) * 0.3 + (this.H[b] * 0.002);
    if (location === 'belowbar') y = this.L[b] - pad;
    else if (location === 'abovebar') y = this.H[b] + pad;
    this.shapes.push({bar: b, y, ymode, title, style, color, text: isChar ? String(v) : text, textcolor, size});
  }
  return NaN;
};
PineVM.prototype.bHline = function (arg, scope, node) {
  const price = arg(0, 'price');
  const title = String(this.cur(arg(1, 'title', 'hline')));
  const color = cssColor(this.cur(arg(2, 'color', '#000000')));
  const style = String(this.cur(arg(3, 'linestyle', 'solid')));
  let h = this.hlines.find(h => h._node === node);
  if (!h) { h = {_node: node, title, prices: [], color, style}; this.hlines.push(h); }
  h.prices[this.bar] = this.cur(price);
  Object.assign(h, {title, color, style});
  return {__hline: this.hlines.indexOf(h)};
};
PineVM.prototype.bFill = function (arg, scope, node) {
  const h1 = arg(0, 'hline1'), h2 = arg(1, 'hline2');
  const color = cssColor(this.cur(arg(2, 'color', '#000000')));
  const title = String(this.cur(arg(3, 'title', 'fill')));
  const p1 = h1.__plot !== undefined ? {plot: h1.__plot} : {hline: h1.__hline};
  const p2 = h2.__plot !== undefined ? {plot: h2.__plot} : {hline: h2.__hline};
  const key = JSON.stringify([p1, p2]);
  let f = this.fills.find(f => f._key === key);
  if (!f) { f = {_key: key, p1, p2}; this.fills.push(f); }
  Object.assign(f, {color, title});
  return NaN;
};
PineVM.prototype.timeToIndex = function (t) {
  let lo = 0, hi = this.n - 1, ans = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (this.T[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
};
PineVM.prototype.xToIndex = function (x, xloc) {
  x = this.cur(x);
  if (xloc === 'bar_time') return this.timeToIndex(x);
  return Math.round(x);
};
PineVM.prototype.drawNew = function (kind, p) {
  const o = Object.assign({__draw: kind, id: this._drawId++, kind}, p);
  if (kind === 'line') this.drawLines.push(o);
  else if (kind === 'box') this.drawBoxes.push(o);
  else this.drawLabels.push(o);
  return o;
};
PineVM.prototype.drawDelete = function (o) {
  if (!o || !o.__draw) return;
  const arr = o.kind === 'line' ? this.drawLines : o.kind === 'box' ? this.drawBoxes : this.drawLabels;
  const i = arr.indexOf(o);
  if (i >= 0) arr.splice(i, 1);
};
PineVM.prototype.drawMethod = function (obj, method, arg, argv, node) {
  // namespace-level: line.new / label.new / box.new / linefill.new / line.delete ...
  if (obj.__draw === 'ns-line' || obj.__draw === 'ns-label' || obj.__draw === 'ns-box') {
    const kind = obj.__draw.slice(3);
    if (method === 'new') {
      const xloc = String(argv(4, 'xloc', 'bar_index'));
      if (kind === 'line') {
        return this.drawNew('line', {
          x1: this.xToIndex(arg(0,'x1'), xloc), y1: this.cur(arg(1,'y1')),
          x2: this.xToIndex(arg(2,'x2'), xloc), y2: this.cur(arg(3,'y2')),
          color: cssColor(this.cur(arg(5,'color','#000000'))),
          style: String(this.cur(arg(6,'style','solid'))),
          width: Math.round(this.cur(arg(7,'width',1)) || 1),
          extend: String(this.cur(arg(8,'extend','none')))});
      }
      if (kind === 'label') {
        return this.drawNew('label', {
          x: this.xToIndex(arg(0,'x'), xloc), y: this.cur(arg(1,'y')),
          text: String(this.cur(arg(2,'text',''))),
          style: String(this.cur(arg(5,'style','label_down'))),
          color: cssColor(this.cur(arg(4,'color','rgba(0,0,0,0)'))),
          textcolor: cssColor(this.cur(arg(6,'textcolor','#000000'))),
          size: String(this.cur(arg(7,'size','small'))),
          tooltip: String(this.cur(arg(8,'tooltip','')))});
      }
      if (kind === 'box') {
        return this.drawNew('box', {
          left: this.xToIndex(arg(0,'left'), xloc), top: this.cur(arg(1,'top')),
          right: this.xToIndex(arg(2,'right'), xloc), bottom: this.cur(arg(3,'bottom')),
          borderColor: cssColor(this.cur(arg(4,'border_color','#000000'))),
          bgcolor: cssColor(this.cur(arg(5,'bgcolor','rgba(0,0,0,0.1)')))});
      }
    }
    if (method === 'delete') { this.drawDelete(arg(0, 'id')); return NaN; }
    throw {line: node.line + 1, msg: kind + '.' + method + ' belum didukung'};
  }
  if (obj.__draw === 'ns-linefill') {
    if (method === 'new') { const l1 = arg(0,'line1'), l2 = arg(1,'line2');
      const o = {id: this._drawId++, l1: l1.id, l2: l2.id, color: cssColor(this.cur(arg(2,'color','#000000')))};
      this.lineFills.push(o); return o; }
    throw {line: node.line + 1, msg: 'linefill.' + method + ' belum didukung'};
  }
  // instance methods
  const setX = (v, xloc) => this.xToIndex(v, xloc || 'bar_index');
  switch (obj.kind + '.' + method) {
    case 'line.set_x1': obj.x1 = setX(arg(0,'x1')); return NaN;
    case 'line.set_x2': obj.x2 = setX(arg(0,'x2')); return NaN;
    case 'line.set_y1': obj.y1 = this.cur(arg(0,'y1')); return NaN;
    case 'line.set_y2': obj.y2 = this.cur(arg(0,'y2')); return NaN;
    case 'line.set_xy1': obj.x1 = setX(arg(0,'x')); obj.y1 = this.cur(arg(1,'y')); return NaN;
    case 'line.set_xy2': obj.x2 = setX(arg(0,'x')); obj.y2 = this.cur(arg(1,'y')); return NaN;
    case 'line.set_color': obj.color = cssColor(this.cur(arg(0,'color'))); return NaN;
    case 'line.set_style': obj.style = String(this.cur(arg(0,'style'))); return NaN;
    case 'line.set_width': obj.width = Math.round(this.cur(arg(0,'width')) || 1); return NaN;
    case 'line.set_extend': obj.extend = String(this.cur(arg(0,'extend'))); return NaN;
    case 'line.get_price': { const x = Math.round(this.cur(arg(0,'x')));
      if (obj.x2 === obj.x1) return obj.y1;
      const t = (x - obj.x1) / (obj.x2 - obj.x1); return obj.y1 + t * (obj.y2 - obj.y1); }
    case 'line.get_x1': return obj.x1; case 'line.get_x2': return obj.x2;
    case 'line.get_y1': return obj.y1; case 'line.get_y2': return obj.y2;
    case 'label.set_x': obj.x = setX(arg(0,'x')); return NaN;
    case 'label.set_y': obj.y = this.cur(arg(0,'y')); return NaN;
    case 'label.set_xy': obj.x = setX(arg(0,'x')); obj.y = this.cur(arg(1,'y')); return NaN;
    case 'label.set_text': obj.text = String(this.cur(arg(0,'text'))); return NaN;
    case 'label.set_tooltip': obj.tooltip = String(this.cur(arg(0,'tooltip'))); return NaN;
    case 'label.set_textcolor': obj.textcolor = cssColor(this.cur(arg(0,'textcolor'))); return NaN;
    case 'label.set_color': obj.color = cssColor(this.cur(arg(0,'color'))); return NaN;
    case 'label.set_style': obj.style = String(this.cur(arg(0,'style'))); return NaN;
    case 'label.set_size': obj.size = String(this.cur(arg(0,'size'))); return NaN;
    case 'label.get_x': return obj.x; case 'label.get_y': return obj.y;
    case 'box.set_left': obj.left = setX(arg(0,'left')); return NaN;
    case 'box.set_right': obj.right = setX(arg(0,'right')); return NaN;
    case 'box.set_top': obj.top = this.cur(arg(0,'top')); return NaN;
    case 'box.set_bottom': obj.bottom = this.cur(arg(0,'bottom')); return NaN;
    case 'box.set_bgcolor': obj.bgcolor = cssColor(this.cur(arg(0,'color'))); return NaN;
    case 'box.set_border_color': obj.borderColor = cssColor(this.cur(arg(0,'color'))); return NaN;
    case 'box.get_left': return obj.left; case 'box.get_right': return obj.right;
    case 'box.get_top': return obj.top; case 'box.get_bottom': return obj.bottom;
  }
  throw {line: node.line + 1, msg: `method ${obj.kind}.${method} belum didukung`};
};
PineVM.prototype.drawProp = function (obj, prop, node) {
  throw {line: node.line + 1, msg: 'property drawing tidak didukung: ' + prop};
};
// line / label / box / linefill sebagai namespace untuk .new
PineVM.prototype.extraNamespaces = function () {
  return {
    line: {__ns: 'drawns', __draw: 'ns-line', __name: 'line',
      style_solid: 'solid', style_dashed: 'dashed', style_dotted: 'dotted'},
    label: {__ns: 'drawns', __draw: 'ns-label', __name: 'label',
      style_label_up: 'label_up', style_label_down: 'label_down',
      style_label_left: 'label_left', style_label_right: 'label_right',
      style_label_center: 'label_center', style_none: 'none'},
    box: {__ns: 'drawns', __draw: 'ns-box', __name: 'box'},
    linefill: {__ns: 'drawns', __draw: 'ns-linefill', __name: 'linefill'},
  };
};
const _origLookup = PineVM.prototype.lookup;
PineVM.prototype.lookup = function (name, scope) {
  try { return _origLookup.call(this, name, scope); }
  catch (e) {
    const ex = this.extraNamespaces();
    if (ex[name]) return ex[name];
    throw e;
  }
};
/* ---------- user functions ---------- */
PineVM.prototype.callUser = function (def, node, scope) {
  let fscope = this.funcScopes.get(def);
  if (!fscope) { fscope = new Map(); this.funcScopes.set(def, fscope); }
  const A = node.args.args, K = node.args.kwargs;
  const fscopeWrap = {map: fscope, parent: null};
  def.params.forEach((p, i) => {
    let aval = null;
    if (K[p.name] !== undefined) aval = K[p.name];
    else if (A[i] !== undefined) aval = A[i];
    else if (p.def) aval = p.def;
    else throw {line: node.line + 1, msg: `parameter '${p.name}' tidak ada nilai`};
    if (aval.type === 'Ident') {
      const sl = this.scopeGet(scope, aval.name);
      if (sl) fscope.set(p.name, sl);
      else {
        // builtin series (close/high/...) -> alias ke slot bawaannya
        const ref = this.lookup(aval.name, scope);
        if (ref && ref.__slot) fscope.set(p.name, ref.__slot.hist ? ref.__slot : {hist: []});
        else throw {line: node.line + 1, msg: 'nama tidak dikenal: ' + aval.name};
      }
    } else {
      const key = 'arg$' + (node._uid || (node._uid = Math.random().toString(36).slice(2))) + '$' + i;
      let t = this.temps.get(key);
      if (!t) { t = {hist: []}; this.temps.set(key, t); }
      // evaluasi dengan scope pemanggil; fungsi tidak boleh lihat global
      const prevIn = this._inFunc;
      this._inFunc = false;
      const v = this.cur(this.eval(aval, scope));
      this._inFunc = prevIn;
      this.setSlot(t, v);
      fscope.set(p.name, t);
    }
  });
  const prevIn = this._inFunc;
  this._inFunc = true;
  let ret = NaN;
  try { ret = this.execStmts(def.body, fscopeWrap); }
  finally { this._inFunc = prevIn; }
  return ret;
};
// lookup: di dalam fungsi, jangan fallback ke slot global
const _origLookup2 = PineVM.prototype.lookup;
PineVM.prototype.lookup = function (name, scope) {
  if (this._inFunc) {
    const sl = scope && scope.map.get(name);
    if (sl) return {__slot: sl};
    const bs = this.builtinSeries(name);
    if (bs) return bs;
    const ns = this.namespaces()[name] || this.extraNamespaces()[name];
    if (ns !== undefined) return ns;
    throw {line: this._line, msg: 'nama tidak dikenal di dalam fungsi: ' + name};
  }
  return _origLookup2.call(this, name, scope);
};
/* ---------- outputs ---------- */
PineVM.prototype.outputs = function (maxBar) {
  const sl = (arr) => {
    const o = new Array(maxBar + 1).fill(NaN);
    for (let i = 0; i <= maxBar && i < arr.length; i++) o[i] = arr[i] === undefined ? NaN : arr[i];
    return o;
  };
  return {
    title: this.c.meta.title, overlay: this.c.meta.overlay,
    plots: this.plots.map(p => ({title: p.title, values: sl(p.values),
      colors: p.isSeriesColor ? sl(p.colors) : null, color: p.color,
      linewidth: p.linewidth, style: p.style, offset: p.offset})),
    shapes: this.shapes.filter(s => s.bar <= maxBar),
    hlines: this.hlines.map(h => ({title: h.title, prices: sl(h.prices), color: h.color, style: h.style})),
    fills: this.fills,
    lines: this.drawLines, boxes: this.drawBoxes, labels: this.drawLabels, lineFills: this.lineFills,
    bgcolor: this._bg.slice(0, maxBar + 1), barcolor: this._bc.slice(0, maxBar + 1),
  };
};
// incremental run: lanjut dari bar terakhir bila cursor maju
PineVM.prototype.runTo = function (cursor) {
  cursor = Math.max(0, Math.min(cursor, this.n - 1));
  if (this._ran && cursor >= this._lastBar && this._runKey === this._key()) {
    const gscope = this.newScope(null); gscope.map = this.slots;
    for (let b = this._lastBar + 1; b <= cursor; b++) {
      this.bar = b;
      try { this.execStmts(this.c.ast.body, gscope); }
      catch (e) { throw {line: (e.line || 1), msg: e.msg || String(e), bar: b}; }
      const fill = (map) => { map.forEach(sl2 => { if (sl2.hist.length <= b) sl2.hist.push(sl2.hist.length ? sl2.hist[sl2.hist.length-1] : NaN); }); };
      fill(this.slots);
      this.funcScopes.forEach(m => fill(m));
      this.temps.forEach(t => { if (t.hist && t.hist.length <= b) t.hist.push(t.hist.length ? t.hist[t.hist.length-1] : NaN); });
    }
    this._lastBar = cursor;
    this.bar = cursor;
    return this.outputs(cursor);
  }
  this._runKey = this._key();
  const out = this.run(cursor);
  this._ran = true; this._lastBar = cursor;
  return out;
};
PineVM.prototype._key = function () {
  return JSON.stringify(this.inputs) + '|' + this.n;
};
PineVM.prototype.invalidate = function () { this._ran = false; };
if (typeof module !== 'undefined') { module.exports = {compilePine, PineVM}; }
