// earnings.js — Bulk upcoming earnings dates for portfolio positions
// Uses Yahoo Finance calendarEvents module via quoteSummary

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

  const tickers = (req.query.tickers || '')
    .split(',').map(t => t.trim().toUpperCase()).filter(Boolean).slice(0, 20);
  if (!tickers.length) return res.json({});

  const results = {};
  const now = Date.now();

  await Promise.all(tickers.map(async ticker => {
    try {
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=calendarEvents`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      const d = await r.json();
      const cal = d?.quoteSummary?.result?.[0]?.calendarEvents;
      const earningsDates = cal?.earnings?.earningsDate || [];

      // Find next earnings date (allow up to 1 day in the past to catch same-day events)
      const next = earningsDates.find(e => e.raw * 1000 > now - 86400000);

      if (next) {
        const daysUntil = Math.round((next.raw * 1000 - now) / (1000 * 60 * 60 * 24));
        const dateStr   = new Date(next.raw * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        results[ticker] = {
          daysUntil,
          date: dateStr,
          isEstimate: cal?.earnings?.isEarningsDateEstimate ?? false,
        };
      } else {
        results[ticker] = null;
      }
    } catch (e) {
      results[ticker] = null;
    }
  }));

  return res.json(results);
}
