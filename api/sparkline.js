export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'tickers param required' });
  
  const tickerList = tickers.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  const results = {};
  
  await Promise.all(tickerList.map(async (symbol) => {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1mo`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const json = await resp.json();
      const result = json?.chart?.result?.[0];
      if (!result) return;
      
      const closes = result.indicators?.quote?.[0]?.close || [];
      const timestamps = result.timestamp || [];
      
      // Filter out nulls and build clean array
      const points = [];
      for (let i = 0; i < closes.length; i++) {
        if (closes[i] !== null && closes[i] !== undefined) {
          points.push({
            t: timestamps[i],
            c: Math.round(closes[i] * 100) / 100
          });
        }
      }
      
      if (points.length > 0) {
        results[symbol] = points;
      }
    } catch (e) { /* skip */ }
  }));
  
  return res.status(200).json(results);
}
