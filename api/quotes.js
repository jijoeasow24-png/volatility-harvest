export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'tickers param required' });
  
  const tickerList = tickers.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  const results = {};
  
  await Promise.all(tickerList.map(async (symbol) => {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const json = await resp.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta || !meta.regularMarketPrice) return;
      
      results[symbol] = {
        ticker: symbol,
        price: meta.regularMarketPrice,
        change: meta.regularMarketChange || 0,
        changePct: meta.regularMarketChangePercent || 0,
        preMarketPrice: meta.preMarketPrice || null,
        postMarketPrice: meta.postMarketPrice || null,
        volume: meta.regularMarketVolume || 0,
        avgVolume: meta.averageDailyVolume3Month || 0,
        marketState: meta.marketState || 'CLOSED',
        previousClose: meta.chartPreviousClose || meta.previousClose || 0
      };
    } catch (e) { /* skip failed ticker */ }
  }));
  
  return res.status(200).json(results);
}
