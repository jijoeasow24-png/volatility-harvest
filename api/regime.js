export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const results = {};
  const errors = [];

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

  // 1. SPY vs 200-day MA — fetch 1 year of daily data and calculate MA manually
  try {
    const spy = await fetchYahoo('SPY', '1y');
    const result = spy?.chart?.result?.[0];
    if (result) {
      const meta = result.meta;
      const closes = result.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
      const price = meta?.regularMarketPrice || (closes.length > 0 ? closes[closes.length - 1] : null);
      
      let ma200 = null;
      if (closes.length >= 200) {
        const last200 = closes.slice(-200);
        ma200 = last200.reduce((sum, c) => sum + c, 0) / 200;
      } else if (closes.length >= 50) {
        ma200 = closes.reduce((sum, c) => sum + c, 0) / closes.length;
      }
      
      if (ma200 === null) {
        ma200 = meta?.twoHundredDayAverage || meta?.fiftyDayAverage || null;
      }
      
      if (price != null && ma200 != null) {
        results.spy = {
          price: price,
          ma200: Math.round(ma200 * 100) / 100,
          above: price > ma200,
          pctFromMA: ((price - ma200) / ma200 * 100),
          dataPoints: closes.length
        };
      }
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
          stable: Math.abs(changePct) < 5
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
          shock: Math.abs(changePct) >= 20
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
      
      if (current != null && monthAgo != null) {
        const changePct = ((current - monthAgo) / monthAgo) * 100;
        results.dxy = {
          current: current,
          monthAgo: monthAgo,
          changePct30d: changePct,
          notSpiking: changePct < 3
        };
      }
    }
  } catch (e) { errors.push('DXY fetch failed'); }

  const answers = {
    spy200: results.spy?.above ?? false,
    vix20: results.vix?.below20 ?? false,
    yields: results.yields?.stable ?? false,
    oil: results.oil?.stable ?? false,
    dxy: results.dxy?.notSpiking ?? false,
    oilShock: results.oil?.shock ?? false,
    inflation: false,
    recession: false
  };

  const yesCount = [answers.spy200, answers.vix20, answers.yields, answers.oil, answers.dxy].filter(Boolean).length;

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
