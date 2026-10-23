/* Binance Vision (market-data) klines fetcher. CORS: Access-Control-Allow-Origin: * */
'use strict';
const BinanceData = (() => {
  const BASE = 'https://data-api.binance.vision';
  const TF_MS = {'15m': 15*60e3, '1h': 3600e3, '4h': 4*3600e3, '1d': 86400e3};

  async function klines(symbol, interval, startTime, limit = 1000) {
    const u = new URL(BASE + '/api/v3/klines');
    u.searchParams.set('symbol', symbol);
    u.searchParams.set('interval', interval);
    u.searchParams.set('limit', String(limit));
    if (startTime) u.searchParams.set('startTime', String(startTime));
    const r = await fetch(u.toString());
    if (!r.ok) throw new Error('Binance API error ' + r.status);
    const raw = await r.json();
    return raw.map(k => ({
      t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5],
    }));
  }

  // Fetch up to `want` candles ending before `endTime` (or now), oldest-first.
  async function fetchRange(symbol, interval, {want = 1500, startTime = null, onProgress = null} = {}) {
    const out = [];
    let from = startTime || null;
    // walk forward from startTime; Binance returns oldest-first
    while (out.length < want) {
      const batch = await klines(symbol, interval, from, 1000);
      if (!batch.length) break;
      for (const c of batch) {
        if (!out.length || c.t > out[out.length-1].t) out.push(c);
      }
      if (onProgress) onProgress(out.length);
      if (batch.length < 1000) break;
      from = batch[batch.length-1].t + 1;
      if (out.length >= want) break;
      await new Promise(r => setTimeout(r, 150)); // rate-limit kindness
    }
    return out.slice(0, want);
  }

  return {klines, fetchRange, TF_MS};
})();
