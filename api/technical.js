export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

  const tickers = (req.query.tickers || '')
    .split(',').map(t => t.trim().toUpperCase()).filter(Boolean).slice(0, 20);
  if (!tickers.length) return res.json({});

  const results = {};

  await Promise.all(tickers.map(async ticker => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=6mo`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      const d = await r.json();
      const raw = d.chart?.result?.[0];
      if (!raw) return;

      const closes = (raw.indicators?.quote?.[0]?.close || []).filter(v => v != null);
      const volumes = (raw.indicators?.quote?.[0]?.volume || []).filter(v => v != null);
      if (closes.length < 15) return;

      // ── RSI(14) using Wilder's smoothing ───────────────────────────────────
      const changes = closes.slice(1).map((c, i) => c - closes[i]);
      let avgGain = 0, avgLoss = 0;
      // seed with simple average of first 14
      for (let i = 0; i < 14; i++) {
        if (changes[i] > 0) avgGain += changes[i];
        else avgLoss += Math.abs(changes[i]);
      }
      avgGain /= 14; avgLoss /= 14;
      // smooth the rest
      for (let i = 14; i < changes.length; i++) {
        const g = changes[i] > 0 ? changes[i] : 0;
        const l = changes[i] < 0 ? Math.abs(changes[i]) : 0;
        avgGain = (avgGain * 13 + g) / 14;
        avgLoss = (avgLoss * 13 + l) / 14;
      }
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      const rsi = Math.round((100 - 100 / (1 + rs)) * 10) / 10;

      // ── 50-day MA ─────────────────────────────────────────────────────────
      const n50 = Math.min(50, closes.length);
      const ma50 = closes.slice(-n50).reduce((a, b) => a + b, 0) / n50;
      const current = closes[closes.length - 1];
      const pctFromMa50 = Math.round(((current - ma50) / ma50) * 1000) / 10;

      // ── 200-day MA (if enough data) ───────────────────────────────────────
      let ma200 = null, pctFromMa200 = null;
      if (closes.length >= 150) {
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

      results[ticker] = { rsi, ma50: Math.round(ma50 * 100) / 100, pctFromMa50, ma200: ma200 ? Math.round(ma200 * 100) / 100 : null, pctFromMa200, volRatio, currentPrice: Math.round(current * 100) / 100 };
    } catch (e) {
      // silently skip failed tickers
    }
  }));

  res.json(results);
}
