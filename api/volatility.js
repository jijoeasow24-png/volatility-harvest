export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');

  const tickers = (req.query.tickers || '')
    .split(',').map(t => t.trim().toUpperCase()).filter(Boolean).slice(0, 20);
  if (!tickers.length) return res.json({});

  const LAMBDA = 0.94; // RiskMetrics standard decay factor

  const results = {};

  await Promise.all(tickers.map(async ticker => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      const d = await r.json();
      const raw = d.chart?.result?.[0];
      if (!raw) return;

      const closes = (raw.indicators?.quote?.[0]?.close || []).filter(v => v != null);
      if (closes.length < 30) return;

      const current = closes[closes.length - 1];

      // ── Log returns ────────────────────────────────────────────────────────
      const logReturns = [];
      for (let i = 1; i < closes.length; i++) {
        logReturns.push(Math.log(closes[i] / closes[i - 1]));
      }

      // ── EWMA variance series ───────────────────────────────────────────────
      // Seed with average squared return of first 20 observations
      const seed = logReturns.slice(0, 20);
      let ewmaVar = seed.reduce((s, r) => s + r * r, 0) / seed.length;

      // Build full vol series (annualised, in %)
      const volSeries = [];
      for (let i = 0; i < logReturns.length; i++) {
        if (i >= 20) ewmaVar = LAMBDA * ewmaVar + (1 - LAMBDA) * logReturns[i] * logReturns[i];
        volSeries.push(Math.sqrt(ewmaVar * 252) * 100); // annualised %
      }

      const currentVol = volSeries[volSeries.length - 1];
      const dailySigma = Math.sqrt(ewmaVar); // today's daily sigma (fraction)

      // ── Vol percentile vs trailing year ───────────────────────────────────
      const sorted = [...volSeries].sort((a, b) => a - b);
      const rank = sorted.filter(v => v <= currentVol).length;
      const volPct = Math.round((rank / sorted.length) * 100);

      // ── Vol regime label ──────────────────────────────────────────────────
      const volLabel = volPct >= 80 ? 'ELEVATED'
        : volPct >= 60 ? 'ABOVE AVG'
        : volPct >= 40 ? 'AVERAGE'
        : volPct >= 20 ? 'BELOW AVG'
        : 'SUPPRESSED';

      // ── Vol trend (vs 20-day mean vol) ────────────────────────────────────
      const recent20 = volSeries.slice(-20);
      const avgRecent = recent20.reduce((a, b) => a + b, 0) / recent20.length;
      const volTrend = currentVol > avgRecent * 1.08 ? 'rising'
        : currentVol < avgRecent * 0.92 ? 'falling'
        : 'stable';

      // ── Expected ±move over N days (1-sigma, ~68% confidence) ─────────────
      const movePct = n => Math.round(dailySigma * Math.sqrt(n) * 1000) / 10;
      const moveAbs = n => Math.round(current * dailySigma * Math.sqrt(n) * 100) / 100;

      // ── Signal implication ────────────────────────────────────────────────
      // High vol → reinforce TRIM (expensive to hold risk)
      // Low vol  → supports ADD (cheap to build position)
      const volSignal = volPct >= 80 ? 'TRIM_REINFORCED'
        : volPct >= 65 ? 'HOLD_CAUTION'
        : volPct <= 20 ? 'ADD_REINFORCED'
        : volPct <= 35 ? 'HOLD_FAVORABLE'
        : 'NEUTRAL';

      results[ticker] = {
        annualVol: Math.round(currentVol * 10) / 10,   // e.g. 28.4 (%)
        volPct,                                          // 0–100
        volLabel,                                        // ELEVATED | ABOVE AVG | AVERAGE | BELOW AVG | SUPPRESSED
        volTrend,                                        // rising | falling | stable
        volSignal,                                       // TRIM_REINFORCED | ADD_REINFORCED | NEUTRAL | ...
        move5:  { pct: movePct(5),  abs: moveAbs(5)  },
        move10: { pct: movePct(10), abs: moveAbs(10) },
        move20: { pct: movePct(20), abs: moveAbs(20) },
        currentPrice: Math.round(current * 100) / 100,
        dataPoints: closes.length,
      };
    } catch (e) {
      // silently skip failed tickers
    }
  }));

  res.json(results);
}
