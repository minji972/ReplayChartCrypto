/* Canvas candlestick chart + SMC overlay + Pine outputs + practice markers. */
'use strict';
class ReplayChart {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.candles = [];
    this.cursor = 0;
    this.count = 140;
    this.smc = null;
    this.pineOuts = [];
    this.practice = null;
    this.padL = 8; this.padR = 70; this.padT = 12; this.padB = 26;
    this.hover = null;
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hover = {x: e.clientX - r.left, y: e.clientY - r.top};
      this.draw();
    });
    canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
  }
  setData(candles, smc) { this.candles = candles; this.smc = smc; }
  setPineOuts(arr) { this.pineOuts = arr; }
  setPractice(p) { this.practice = p; }
  resize() {
    const r = this.cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.max(50, r.width * dpr);
    this.cv.height = Math.max(50, r.height * dpr);
    this._dpr = dpr;
  }
  view() {
    const end = this.cursor;
    const start = Math.max(0, end - this.count + 1);
    return {start, end};
  }
  x(i) {
    const s = this.view().start;
    const W = this.cv.width / this._dpr;
    const bw = (W - this.padL - this.padR) / this.count;
    return this.padL + (i - s + 0.5) * bw;
  }
  bw() {
    const W = this.cv.width / this._dpr;
    return (W - this.padL - this.padR) / this.count;
  }
  range() {
    const v = this.view(), start = v.start, end = v.end;
    let mn = Infinity, mx = -Infinity;
    for (let i = start; i <= end; i++) {
      const c = this.candles[i];
      if (c.l < mn) mn = c.l; if (c.h > mx) mx = c.h;
    }
    for (const po of this.pineOuts) {
      const out = po.out; if (!out) continue;
      for (const p of out.plots) for (let i = start; i <= end; i++) {
        const vv = p.values[i - (p.offset || 0)];
        if (vv !== undefined && !isNaN(vv)) { if (vv < mn) mn = vv; if (vv > mx) mx = vv; }
      }
      for (const h of out.hlines) for (let i = start; i <= end; i++) {
        const vv = h.prices[i];
        if (vv !== undefined && !isNaN(vv)) { if (vv < mn) mn = vv; if (vv > mx) mx = vv; }
      }
    }
    if (!isFinite(mn)) { mn = 0; mx = 1; }
    const pad = (mx - mn) * 0.08 || mx * 0.01 || 1;
    return {mn: mn - pad, mx: mx + pad};
  }
  y(p) {
    const mn = this._range.mn, mx = this._range.mx;
    const H = this.cv.height / this._dpr;
    return this.padT + (1 - (p - mn) / (mx - mn)) * (H - this.padT - this.padB);
  }
  fmtP(p) {
    const d = Math.max(0, 5 - Math.floor(Math.log10(Math.max(1e-9, this._range.mx - this._range.mn))));
    return p.toFixed(Math.min(8, d));
  }
  draw() {
    if (!this.candles.length) return;
    this.resize();
    const ctx = this.ctx, dpr = this._dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.cv.width / dpr, H = this.cv.height / dpr;
    ctx.clearRect(0, 0, W, H);
    this._range = this.range();
    const v = this.view(), start = v.start, end = v.end;
    const bw = this.bw();
    ctx.strokeStyle = '#1c2433'; ctx.fillStyle = '#787b86';
    ctx.font = '11px monospace'; ctx.lineWidth = 1; ctx.textAlign = 'left';
    const steps = 6;
    for (let g = 0; g <= steps; g++) {
      const p = this._range.mn + (this._range.mx - this._range.mn) * g / steps;
      const yy = Math.round(this.y(p)) + 0.5;
      ctx.beginPath(); ctx.moveTo(this.padL, yy); ctx.lineTo(W - this.padR, yy); ctx.stroke();
      ctx.fillText(this.fmtP(p), W - this.padR + 6, yy + 4);
    }
    const tfmt = new Intl.DateTimeFormat('id-ID', {timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'});
    ctx.textAlign = 'center';
    const stepT = Math.max(1, Math.floor(this.count / 6));
    for (let i = start; i <= end; i += stepT) {
      ctx.fillText(tfmt.format(new Date(this.candles[i].t)), this.x(i), H - 8);
    }
    ctx.textAlign = 'left';
    for (let i = start; i <= end; i++) {
      const c = this.candles[i];
      const up = c.c >= c.o;
      ctx.strokeStyle = up ? '#089981' : '#f23645';
      ctx.fillStyle = ctx.strokeStyle;
      const x = this.x(i);
      ctx.beginPath(); ctx.moveTo(x, this.y(c.h)); ctx.lineTo(x, this.y(c.l)); ctx.stroke();
      const bw2 = Math.max(1, bw * 0.7);
      const yO = this.y(c.o), yC = this.y(c.c);
      ctx.fillRect(x - bw2/2, Math.min(yO, yC), bw2, Math.max(1, Math.abs(yC - yO)));
    }
    this.drawSMC(ctx);
    this.drawPine(ctx);
    this.drawPractice(ctx);
    this.drawHover(ctx, W, H);
  }
  drawSMC(ctx) {
    if (!this.smc || !document.getElementById('chkSMC').checked) return;
    const k = this.cursor;
    const v = this.view(), start = v.start, end = v.end;
    for (const s of this.smc.struct) {
      if (s.reveal > k || s.x1 < start) continue;
      ctx.strokeStyle = s.color; ctx.lineWidth = s.internal ? 1 : 2;
      ctx.setLineDash(s.dashed ? [4, 3] : []);
      ctx.beginPath(); ctx.moveTo(this.x(s.x0), this.y(s.y));
      ctx.lineTo(this.x(Math.min(s.x1, end)) + this.bw()/2, this.y(s.y)); ctx.stroke();
      ctx.setLineDash([]);
      if (s.x1 <= end && s.x1 >= start) {
        ctx.fillStyle = s.color; ctx.font = '10px sans-serif';
        ctx.fillText(s.tag, this.x(s.x1) + 4, this.y(s.y) - 4);
      }
    }
    for (const e of this.smc.eq) {
      if (e.reveal > k || e.x1 < start) continue;
      ctx.strokeStyle = e.color; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(this.x(e.x0), this.y(e.y0));
      ctx.lineTo(this.x(Math.min(e.x1, end)), this.y(e.y1)); ctx.stroke();
      ctx.setLineDash([]);
    }
    const live = this.smc.obs.filter(o => o.stored <= k && (o.mitigated == null || o.mitigated > k))
      .sort((a, b) => b.stored - a.stored).slice(0, 5);
    for (const o of live) {
      const col = o.bias === 1 ? 'rgba(8,153,129,0.18)' : 'rgba(242,54,69,0.18)';
      const bc = o.bias === 1 ? '#089981' : '#f23645';
      const x1 = this.x(Math.max(o.bi, start)) - this.bw()/2;
      const x2 = this.x(Math.min(k, end)) + this.bw()/2;
      ctx.fillStyle = col;
      ctx.fillRect(x1, this.y(o.hi), x2 - x1, this.y(o.lo) - this.y(o.hi));
      ctx.strokeStyle = bc; ctx.lineWidth = 1;
      ctx.strokeRect(x1, this.y(o.hi), x2 - x1, this.y(o.lo) - this.y(o.hi));
    }
    const pb = this.smc.perBar[k];
    if (pb) {
      const x2 = this.x(Math.min(k + 20, end)) + this.bw()/2;
      ctx.font = '10px sans-serif'; ctx.fillStyle = '#787b86';
      if (!isNaN(pb.trailTop) && pb.trailTopI >= start - 1) {
        ctx.strokeStyle = '#787b86'; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(this.x(Math.max(pb.trailTopI, start)), this.y(pb.trailTop));
        ctx.lineTo(x2, this.y(pb.trailTop)); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillText(pb.swTrend === 1 ? 'Strong High' : 'Weak High', x2 - 70, this.y(pb.trailTop) - 4);
      }
      if (!isNaN(pb.trailBot) && pb.trailBotI >= start - 1) {
        ctx.strokeStyle = '#787b86'; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(this.x(Math.max(pb.trailBotI, start)), this.y(pb.trailBot));
        ctx.lineTo(x2, this.y(pb.trailBot)); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillText(pb.swTrend === -1 ? 'Strong Low' : 'Weak Low', x2 - 70, this.y(pb.trailBot) + 12);
      }
    }
  }
  drawPine(ctx) {
    const k = this.cursor;
    const v = this.view(), start = v.start, end = v.end;
    for (const po of this.pineOuts) {
      const out = po.out; if (!out) continue;
      for (const f of out.fills) {
        const gv1 = (i) => f.p1.plot !== undefined ? out.plots[f.p1.plot].values[i] : out.hlines[f.p1.hline].prices[i];
        const gv2 = (i) => f.p2.plot !== undefined ? out.plots[f.p2.plot].values[i] : out.hlines[f.p2.hline].prices[i];
        ctx.fillStyle = f.color; ctx.beginPath();
        let started = false;
        for (let i = start; i <= end; i++) {
          const a = gv1(i), b = gv2(i);
          if (a === undefined || b === undefined || isNaN(a) || isNaN(b)) { started = false; continue; }
          const xx = this.x(i);
          if (!started) { ctx.moveTo(xx, this.y(a)); started = true; }
          else ctx.lineTo(xx, this.y(a));
        }
        for (let i = end; i >= start; i--) {
          const a = gv1(i), b = gv2(i);
          if (a === undefined || b === undefined || isNaN(a) || isNaN(b)) continue;
          ctx.lineTo(this.x(i), this.y(b));
        }
        ctx.closePath(); ctx.fill();
      }
      for (const p of out.plots) {
        ctx.lineWidth = p.linewidth || 1;
        const isHist = p.style === 'histogram' || p.style === 'columns';
        let started = false;
        for (let i = start; i <= end; i++) {
          const vv = p.values[i - (p.offset || 0)];
          if (vv === undefined || isNaN(vv)) { started = false; continue; }
          const xx = this.x(i), yy = this.y(vv);
          if (isHist) {
            ctx.strokeStyle = p.isSeriesColor ? (p.colors[i] || p.color) : p.color;
            ctx.beginPath(); ctx.moveTo(xx, this.y(0)); ctx.lineTo(xx, yy); ctx.stroke();
          } else if (p.style === 'circles') {
            ctx.fillStyle = p.isSeriesColor ? (p.colors[i] || p.color) : p.color;
            ctx.beginPath(); ctx.arc(xx, yy, 2.5, 0, 7); ctx.fill();
          } else {
            if (!started) { ctx.beginPath(); ctx.moveTo(xx, yy); started = true; }
            else ctx.lineTo(xx, yy);
          }
        }
        if (!isHist && p.style !== 'circles') {
          ctx.strokeStyle = p.isSeriesColor ? (p.colors[k] || p.color) : p.color;
          ctx.stroke();
        }
      }
      for (const h of out.hlines) {
        ctx.strokeStyle = h.color; ctx.lineWidth = 1;
        if (h.style === 'dashed') ctx.setLineDash([5, 4]);
        else if (h.style === 'dotted') ctx.setLineDash([2, 2]);
        ctx.beginPath();
        let started = false;
        for (let i = start; i <= end; i++) {
          const vv = h.prices[i];
          if (vv === undefined || isNaN(vv)) { started = false; continue; }
          const xx = this.x(i), yy = this.y(vv);
          if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy);
        }
        ctx.stroke(); ctx.setLineDash([]);
      }
      for (const s of out.shapes) {
        if (s.bar < start || s.bar > end) continue;
        const xx = this.x(s.bar);
        let yy = s.y;
        if (s.ymode === 'top') yy = this._range.mx;
        else if (s.ymode === 'bottom') yy = this._range.mn;
        ctx.fillStyle = s.color;
        const sz = s.size === 'tiny' ? 5 : s.size === 'small' ? 7 : s.size === 'large' ? 12 : s.size === 'huge' ? 16 : 9;
        const dn = s.style === 'labeldown' || s.style === 'triangledown' || s.style === 'shape_labeldown';
        if (s.style === 'diamond') {
          ctx.beginPath(); ctx.moveTo(xx, yy - sz/2); ctx.lineTo(xx + sz/2, yy); ctx.lineTo(xx, yy + sz/2); ctx.lineTo(xx - sz/2, yy); ctx.closePath(); ctx.fill();
        } else if (dn) {
          ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx - sz/2, yy + sz); ctx.lineTo(xx + sz/2, yy + sz); ctx.closePath(); ctx.fill();
        } else if (s.style === 'circle') {
          ctx.beginPath(); ctx.arc(xx, yy, sz/2, 0, 7); ctx.fill();
        } else {
          ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx - sz/2, yy - sz); ctx.lineTo(xx + sz/2, yy - sz); ctx.closePath(); ctx.fill();
        }
        if (s.text) {
          ctx.fillStyle = s.textcolor || '#fff'; ctx.font = 'bold ' + Math.max(8, sz) + 'px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(s.text, xx, dn ? yy + sz + 10 : yy - sz - 3);
          ctx.textAlign = 'left';
        }
      }
      for (const l of out.lines) {
        if (l.x2 < start || l.x1 > end) continue;
        ctx.strokeStyle = l.color; ctx.lineWidth = l.width || 1;
        if (l.style === 'dashed') ctx.setLineDash([5, 4]);
        else if (l.style === 'dotted') ctx.setLineDash([2, 2]);
        let x1 = this.x(Math.max(l.x1, start)), x2 = this.x(Math.min(l.x2, end));
        if (l.extend === 'right' || l.extend === 'both') x2 = this.x(end) + this.bw();
        if (l.extend === 'left' || l.extend === 'both') x1 = this.x(start) - this.bw();
        ctx.beginPath(); ctx.moveTo(x1, this.y(l.y1)); ctx.lineTo(x2, this.y(l.y2)); ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const b of out.boxes) {
        if (b.right < start || b.left > end) continue;
        const x1 = this.x(Math.max(b.left, start)) - this.bw()/2;
        const x2 = this.x(Math.min(b.right, end)) + this.bw()/2;
        ctx.fillStyle = b.bgcolor; ctx.fillRect(x1, this.y(b.top), x2 - x1, this.y(b.bottom) - this.y(b.top));
        ctx.strokeStyle = b.borderColor; ctx.lineWidth = 1;
        ctx.strokeRect(x1, this.y(b.top), x2 - x1, this.y(b.bottom) - this.y(b.top));
      }
      ctx.font = '11px sans-serif';
      for (const l of out.labels) {
        if (l.x < start || l.x > end) continue;
        const xx = this.x(l.x), yy = this.y(l.y);
        ctx.fillStyle = l.textcolor || '#000';
        ctx.textAlign = 'center';
        ctx.fillText(l.text, xx, l.style === 'label_up' ? yy + 14 : yy - 6);
        ctx.textAlign = 'left';
      }
    }
  }
  drawPractice(ctx) {
    const p = this.practice;
    if (!p) return;
    const v = this.view(), start = v.start, end = v.end;
    ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
    for (const t of p.trades) {
      if (t.entryBar < start || t.entryBar > end) continue;
      const xx = this.x(t.entryBar);
      ctx.fillStyle = t.dir === 'LONG' ? '#089981' : '#f23645';
      const yy = t.dir === 'LONG' ? this.y(this.candles[t.entryBar].l) + 16 : this.y(this.candles[t.entryBar].h) - 16;
      ctx.beginPath();
      if (t.dir === 'LONG') { ctx.moveTo(xx, yy - 9); ctx.lineTo(xx - 5, yy); ctx.lineTo(xx + 5, yy); }
      else { ctx.moveTo(xx, yy + 9); ctx.lineTo(xx - 5, yy); ctx.lineTo(xx + 5, yy); }
      ctx.closePath(); ctx.fill();
      if (t.exitBar != null && t.exitBar >= start && t.exitBar <= end) {
        ctx.fillStyle = t.pnl >= 0 ? '#089981' : '#f23645';
        ctx.fillRect(this.x(t.exitBar) - 4, this.y(t.exitPrice) - 4, 8, 8);
      }
    }
    ctx.textAlign = 'left';
    if (p.openPos) {
      const o = p.openPos;
      const yy = this.y(o.entry);
      ctx.strokeStyle = o.dir === 'LONG' ? '#089981' : '#f23645';
      ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(this.x(Math.max(o.entryBar, start)), yy); ctx.lineTo(this.x(end) + this.bw(), yy); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 1;
      if (o.sl) { ctx.strokeStyle = '#f23645'; ctx.beginPath(); const y2 = this.y(o.sl); ctx.moveTo(this.x(start), y2); ctx.lineTo(this.x(end) + this.bw(), y2); ctx.stroke(); }
      if (o.tp) { ctx.strokeStyle = '#089981'; ctx.beginPath(); const y3 = this.y(o.tp); ctx.moveTo(this.x(start), y3); ctx.lineTo(this.x(end) + this.bw(), y3); ctx.stroke(); }
    }
  }
  drawHover(ctx, W, H) {
    if (!this.hover || !this.candles.length) return;
    const start = this.view().start;
    const bw = this.bw();
    const i = Math.round(start + (this.hover.x - this.padL) / bw - 0.5);
    if (i < start || i > this.cursor || !this.candles[i]) return;
    const c = this.candles[i];
    ctx.strokeStyle = '#4a5568'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(this.x(i), this.padT); ctx.lineTo(this.x(i), H - this.padB); ctx.stroke();
    ctx.setLineDash([]);
    const el = document.getElementById('ohlc-bar');
    if (el) {
      const d = new Intl.DateTimeFormat('id-ID', {timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'}).format(new Date(c.t));
      const chg = ((c.c - c.o) / c.o * 100).toFixed(2);
      const col = chg >= 0 ? '#089981' : '#f23645';
      el.textContent = d + '  O ' + c.o + ' H ' + c.h + ' L ' + c.l + ' C ' + c.c + ' ' + chg + '%';
      el.style.color = col;
    }
  }
}
