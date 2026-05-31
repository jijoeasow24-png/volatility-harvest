// Benchmark returns for SPY and QQQ over standard periods
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');

  async function fetchCloses(ticker) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    const d = await r.json();
    const raw = d.chart?.result?.[0];
    if (!raw) return [];
    return (raw.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  }

  function periodReturn(closes, tradingDays) {
    const n = Math.min(tradingDays, closes.length - 1);
    const start = closes[closes.length - 1 - n];
    const end = closes[closes.length - 1];
    return start > 0 ? Math.round(((end - start) / start) * 1000) / 10 : null;
  }

  try {
    const [spy, qqq] = await Promise.all([fetchCloses('SPY'), fetchCloses('QQQ')]);

    const result = {};
    for (const [name, closes] of [['SPY', spy], ['QQQ', qqq]]) {
      result[name] = {
        current: Math.round(closes[closes.length - 1] * 100) / 100,
        ret1M:  periodReturn(closes, 21),
        ret3M:  periodReturn(closes, 63),
        ret6M:  periodReturn(closes, 126),
        ret1Y:  periodReturn(closes, 252),
      };
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
