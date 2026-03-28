export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const results = {};
  const errors = [];

  // Helper to fetch Yahoo Finance data
  async function fetchYahoo(symbol, range = '1d') {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      return await resp.json();
    } catch (e) {
      errors.push(`Failed to fetch ${symbol}`);
      return null;
    }
  }

  // 1. SPY vs 200-day MA
  try {
    const spy = await fetchYahoo('SPY', '1d');
    const meta = spy?.chart?.result?.[0]?.meta;
    if (meta) {
      const price = meta.regularMarketPrice;
      const ma200 = meta.twoHundredDayAverage;
      results.spy = {
        price: price,
        ma200: ma200,
        above: price > ma200,
        pctFromMA: ma200 > 0 ? ((price - ma200) / ma200 * 100) : 0
      };
    }
  } catch (e) { errors.push('SPY fetch failed'); }

  // 2. VIX level
  try {
    const vix = await fetchYahoo('%5EVIX', '1d');
    const meta = vix?.chart?.result?.[0]?.meta;
    if (meta) {
      results.vix = {
        level: meta.regularMarketPrice,
        below20: meta.regularMarketPrice < 20,
        zone: meta.regularMarketPrice < 15 ? 'very_calm' :
              meta.regularMarketPrice < 20 ? 'calm' :
              meta.regularMarketPrice < 25 ? 'elevated' :
              meta.regularMarketPrice < 35 ? 'high' : 'extreme'
      };
    }
  } catch (e) { errors.push('VIX fetch failed'); }

  // 3. 10-Year Treasury Yield (^TNX) — check 30-day stability
  try {
    const tnx = await fetchYahoo('%5ETNX', '1mo');
    const result = tnx?.chart?.result?.[0];
    if (result) {
      const closes = result.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
      const current = closes.length > 0 ? closes[closes.length - 1] : null;
      const monthAgo = closes.length > 0 ? closes[0] : null;
      
      if (current != null && monthAgo != null) {
        const change = current - monthAgo;
        const changePct = (change / monthAgo) * 100;
        results.yields = {
          current: current,
          monthAgo: monthAgo,
          change30d: change,
          changePct30d: changePct,
          stable: Math.abs(changePct) < 5  // <5% relative change in yields = stable
        };
      }
    }
  } catch (e) { errors.push('TNX fetch failed'); }

  // 4. Oil (CL=F) — check ±15% in 30 days
  try {
    const oil = await fetchYahoo('CL=F', '1mo');
    const result = oil?.chart?.result?.[0];
    if (result) {
      const closes = result.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
      const current = closes.length > 0 ? closes[closes.length - 1] : null;
      const monthAgo = closes.length > 0 ? closes[0] : null;
      
      if (current != null && monthAgo != null) {
        const changePct = ((current - monthAgo) / monthAgo) * 100;
        results.oil = {
          current: current,
          monthAgo: monthAgo,
          changePct30d: changePct,
          stable: Math.abs(changePct) < 15,
          shock: Math.abs(changePct) >= 20  // ±20% = oil shock override
        };
      }
    }
  } catch (e) { errors.push('Oil fetch failed'); }

  // 5. DXY (US Dollar Index) — check if NOT spiking
  try {
    const dxy = await fetchYahoo('DX-Y.NYB', '1mo');
    const result = dxy?.chart?.result?.[0];
    if (result) {
      const closes = result.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
      const current = closes.length > 0 ? closes[closes.length - 1] : null;
      const monthAgo = closes.length > 0 ? closes[0] : null;
      const meta = result.meta;
      
      if (current != null && monthAgo != null) {
        const changePct = ((current - monthAgo) / monthAgo) * 100;
        // DXY is "not spiking" if it hasn't risen more than 3% in 30 days
        results.dxy = {
          current: current,
          monthAgo: monthAgo,
          changePct30d: changePct,
          notSpiking: changePct < 3
        };
      }
    }
  } catch (e) { errors.push('DXY fetch failed'); }

  // Compute regime answers
  const answers = {
    spy200: results.spy?.above ?? false,
    vix20: results.vix?.below20 ?? false,
    yields: results.yields?.stable ?? false,
    oil: results.oil?.stable ?? false,
    dxy: results.dxy?.notSpiking ?? false,
    // Override modifiers
    oilShock: results.oil?.shock ?? false,
    inflation: false,  // Cannot be reliably auto-detected from price data alone
    recession: false   // Cannot be reliably auto-detected from price data alone
  };

  const yesCount = [answers.spy200, answers.vix20, answers.yields, answers.oil, answers.dxy].filter(Boolean).length;

  // Compute regime
  let regime;
  if (answers.oilShock) regime = 'Oil Shock';
  else if (answers.inflation) regime = 'Inflation Spike';
  else if (answers.recession) regime = 'Recession Scare';
  else regime = yesCount >= 3 ? 'Risk-On' : 'Risk-Off';

  return res.status(200).json({
    answers,
    yesCount,
    regime,
    indicators: results,
    errors: errors.length > 0 ? errors : undefined,
    timestamp: new Date().toISOString()
  });
}
