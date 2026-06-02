// technical.js — RSI, MAs, Volume Ratio + EWMA Volatility in one call
// Replaces: technical.js + volatility.js (consolidated to stay within Vercel free-tier 12-function limit)

const LAMBDA = 0.94; // RiskMetrics standard decay factor

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');

  const tickers = (req.query.tickers || '')
    .split(',').map(t => t.trim().toUpperCase()).filter(Boolean).slice(0, 20);
  if (!tickers.length) return res.json({});

  const results = {};

  await Promise.all(tickers.map(async ticker => {
    try {
      // Fetch 1y data — needed for vol percentile; also sufficient for RSI + MAs
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const d = await r.json();
      const raw = d.chart?.result?.[0];
      if (!raw) return;

      const closes  = (raw.indicators?.quote?.[0]?.close  || []).filter(v => v != null);
      const volumes = (raw.indicators?.quote?.[0]?.volume || []).filter(v => v != null);
      if (closes.length < 30) return;

      const current = closes[closes.length - 1];

      // ── RSI(14) — Wilder's smoothing ──────────────────────────────────────
      const changes = closes.slice(1).map((c, i) => c - closes[i]);
      let avgGain = 0, avgLoss = 0;
      for (let i = 0; i < 14; i++) {
        if (changes[i] > 0) avgGain += changes[i]; else avgLoss += Math.abs(changes[i]);
      }
      avgGain /= 14; avgLoss /= 14;
      for (let i = 14; i < changes.length; i++) {
        avgGain = (avgGain * 13 + Math.max(0, changes[i])) / 14;
        avgLoss = (avgLoss * 13 + Math.max(0, -changes[i])) / 14;
      }
      const rsi = Math.round((100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss))) * 10) / 10;

      // ── Moving averages ───────────────────────────────────────────────────
      const n50  = Math.min(50, closes.length);
      const ma50 = closes.slice(-n50).reduce((a, b) => a + b, 0) / n50;
      const pctFromMa50 = Math.round(((current - ma50) / ma50) * 1000) / 10;

      let ma200 = null, pctFromMa200 = null;
      if (closes.length >= 60) {
        const n200 = Math.min(200, closes.length);
        ma200 = closes.slice(-n200).reduce((a, b) => a + b, 0) / n200;
        pctFromMa200 = Math.round(((current - ma200) / ma200) * 1000) / 10;
      }

      // ── Volume ratio (today vs 20-day avg) ───────────────────────────────
      let volRatio = null;
      if (volumes.length >= 21) {
        const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
        volRatio = avgVol > 0 ? Math.round((volumes[volumes.length - 1] / avgVol) * 100) / 100 : null;
      }

      // ── EWMA Volatility ───────────────────────────────────────────────────
      const logReturns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
      const seed = logReturns.slice(0, 20);
      let ewmaVar = seed.reduce((s, r) => s + r * r, 0) / seed.length;
      const volSeries = [];
      for (let i = 0; i < logReturns.length; i++) {
        if (i >= 20) ewmaVar = LAMBDA * ewmaVar + (1 - LAMBDA) * logReturns[i] ** 2;
        volSeries.push(Math.sqrt(ewmaVar * 252) * 100);
      }
      const annualVol    = Math.round(volSeries[volSeries.length - 1] * 10) / 10;
      const dailySigma   = Math.sqrt(ewmaVar);
      const sorted       = [...volSeries].sort((a, b) => a - b);
      const volPct       = Math.round(sorted.filter(v => v <= annualVol).length / sorted.length * 100);
      const recent20avg  = volSeries.slice(-20).reduce((a, b) => a + b, 0) / 20;
      const volTrend     = annualVol > recent20avg * 1.08 ? 'rising' : annualVol < recent20avg * 0.92 ? 'falling' : 'stable';

      const volLabel  = volPct >= 80 ? 'ELEVATED' : volPct >= 60 ? 'ABOVE AVG' : volPct >= 40 ? 'AVERAGE' : volPct >= 20 ? 'BELOW AVG' : 'SUPPRESSED';
      const volSignal = volPct >= 80 ? 'TRIM_REINFORCED' : volPct >= 65 ? 'HOLD_CAUTION' : volPct <= 20 ? 'ADD_REINFORCED' : volPct <= 35 ? 'HOLD_FAVORABLE' : 'NEUTRAL';

      const movePct = n => Math.round(dailySigma * Math.sqrt(n) * 1000) / 10;
      const moveAbs = n => Math.round(current * dailySigma * Math.sqrt(n) * 100) / 100;

      results[ticker] = {
        // ── from old technical.js ──
        rsi,
        ma50:         Math.round(ma50 * 100) / 100,
        pctFromMa50,
        ma200:        ma200 ? Math.round(ma200 * 100) / 100 : null,
        pctFromMa200,
        volRatio,
        currentPrice: Math.round(current * 100) / 100,
        // ── from old volatility.js ──
        annualVol,
        volPct,
        volLabel,
        volTrend,
        volSignal,
        move5:  { pct: movePct(5),  abs: moveAbs(5)  },
        move10: { pct: movePct(10), abs: moveAbs(10) },
        move20: { pct: movePct(20), abs: moveAbs(20) },
        dataPoints: closes.length,
      };
    } catch (e) {
      // silently skip failed tickers
    }
  }));

  res.json(results);
}
