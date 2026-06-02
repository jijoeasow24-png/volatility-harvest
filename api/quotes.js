// quotes.js — Real-time quote + sparkline data in one call
// Replaces: quotes.js + sparkline.js (consolidated to stay within Vercel free-tier 12-function limit)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');

  const tickers = (req.query.tickers || '')
    .split(',').map(t => t.trim().toUpperCase()).filter(Boolean).slice(0, 20);
  if (!tickers.length) return res.json({});

  const results = {};

  await Promise.all(tickers.map(async ticker => {
    try {
      // Single 1mo fetch gives sparkline history + live meta in one request
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1mo`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const d = await r.json();
      const raw = d.chart?.result?.[0];
      if (!raw) return;

      const meta = raw.meta || {};
      const closes = raw.indicators?.quote?.[0]?.close || [];
      const timestamps = raw.timestamp || [];

      // ── Sparkline points ──────────────────────────────────────────────────
      const sparkline = [];
      for (let i = 0; i < closes.length; i++) {
        if (closes[i] != null) sparkline.push({ t: timestamps[i], c: Math.round(closes[i] * 100) / 100 });
      }

      // ── Current quote (prefer live meta over last close) ──────────────────
      const price = meta.regularMarketPrice ?? sparkline[sparkline.length - 1]?.c;
      if (!price) return;
      const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? sparkline[sparkline.length - 2]?.c ?? price;
      const change    = Math.round((price - prevClose) * 100) / 100;
      const changePct = prevClose > 0 ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : 0;

      results[ticker] = {
        // Quote fields (same shape as old quotes.js)
        price:           Math.round(price * 100) / 100,
        change,
        changePct,
        preMarketPrice:  meta.preMarketPrice  ? Math.round(meta.preMarketPrice  * 100) / 100 : null,
        postMarketPrice: meta.postMarketPrice ? Math.round(meta.postMarketPrice * 100) / 100 : null,
        // Sparkline field (same shape as old sparkline.js response per ticker)
        sparkline,
      };
    } catch (e) {
      // silently skip failed tickers
    }
  }));

  res.json(results);
}
