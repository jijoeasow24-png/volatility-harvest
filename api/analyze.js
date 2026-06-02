// Stock Analyzer — Entry quality scoring for any ticker
// Combines: EWMA vol, RSI, momentum, trend, volume into a 0-100 entry score

const sigmoid = x => 1 / (1 + Math.exp(-x));

async function fetchData(ticker) {
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };
  const [chart, summary] = await Promise.all([
    fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`, { headers }).then(r => r.json()),
    fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData,defaultKeyStatistics,calendarEvents`, { headers }).then(r => r.json()).catch(() => null),
  ]);
  return { chart, summary };
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function clip(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate');

  const ticker = (req.query.ticker || '').trim().toUpperCase().replace(/[^A-Z0-9.\-^]/g, '');
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });

  try {
    const { chart, summary } = await fetchData(ticker);
    const raw = chart.chart?.result?.[0];
    if (!raw) return res.status(404).json({ error: `No data found for ${ticker}` });

    const closes = (raw.indicators?.quote?.[0]?.close || []).filter(v => v != null);
    const volumes = (raw.indicators?.quote?.[0]?.volume || []).filter(v => v != null);
    const meta = raw.meta || {};

    if (closes.length < 30) return res.status(400).json({ error: 'Not enough price history' });

    const current = closes[closes.length - 1];

    // ── RSI(14) ────────────────────────────────────────────────────────────
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

    // ── Moving averages ────────────────────────────────────────────────────
    const n50 = Math.min(50, closes.length);
    const ma50 = mean(closes.slice(-n50));
    const pctFromMa50 = (current - ma50) / ma50 * 100;

    let ma200 = null, pctFromMa200 = null;
    if (closes.length >= 60) {
      const n200 = Math.min(200, closes.length);
      ma200 = mean(closes.slice(-n200));
      pctFromMa200 = (current - ma200) / ma200 * 100;
    }

    // ── Momentum ───────────────────────────────────────────────────────────
    const ret5d  = closes.length > 5  ? (current - closes[closes.length - 6])  / closes[closes.length - 6]  * 100 : null;
    const ret20d = closes.length > 20 ? (current - closes[closes.length - 21]) / closes[closes.length - 21] * 100 : null;
    const ret60d = closes.length > 60 ? (current - closes[closes.length - 61]) / closes[closes.length - 61] * 100 : null;

    // ── 52-week range ──────────────────────────────────────────────────────
    const high52 = Math.max(...closes);
    const low52  = Math.min(...closes);
    const pos52  = Math.round(((current - low52) / (high52 - low52 || 1)) * 100); // 0–100%

    // ── EWMA Volatility ────────────────────────────────────────────────────
    const LAMBDA = 0.94;
    const logReturns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
    const seed = logReturns.slice(0, 20);
    let ewmaVar = seed.reduce((s, r) => s + r * r, 0) / seed.length;
    const volSeries = [];
    for (let i = 0; i < logReturns.length; i++) {
      if (i >= 20) ewmaVar = LAMBDA * ewmaVar + (1 - LAMBDA) * logReturns[i] ** 2;
      volSeries.push(Math.sqrt(ewmaVar * 252) * 100);
    }
    const annualVol = Math.round(volSeries[volSeries.length - 1] * 10) / 10;
    const dailySigma = Math.sqrt(ewmaVar);
    const sorted = [...volSeries].sort((a, b) => a - b);
    const volPct = Math.round(sorted.filter(v => v <= annualVol).length / sorted.length * 100);

    // ── Volume ratio ───────────────────────────────────────────────────────
    let volRatio = null;
    if (volumes.length >= 21) {
      const avgVol = mean(volumes.slice(-21, -1));
      volRatio = avgVol > 0 ? Math.round(volumes[volumes.length - 1] / avgVol * 100) / 100 : null;
    }

    // ── Entry Score (0–100) ────────────────────────────────────────────────
    // Component 1: Volatility (0–25) — lower vol = better entry window
    // < 30th pct → 25pts, 30–50 → 18pts, 50–70 → 10pts, 70–85 → 4pts, >85 → 0pts
    const volScore = volPct < 30 ? 25 : volPct < 50 ? 18 : volPct < 70 ? 10 : volPct < 85 ? 4 : 0;

    // Component 2: Momentum (0–25) — positive but not overextended
    const mom = ret20d ?? 0;
    const momScore = mom >= 2 && mom <= 12 ? 25
      : mom >= 0 && mom < 2 ? 15
      : mom > 12 && mom <= 20 ? 10
      : mom < 0 && mom >= -5 ? 8
      : mom < -5 && mom >= -12 ? 4
      : 0;

    // Component 3: RSI (0–25) — not overbought or in deep oversold
    const rsiScore = rsi >= 40 && rsi <= 60 ? 25
      : rsi > 60 && rsi <= 70 ? 18
      : rsi >= 30 && rsi < 40 ? 15
      : rsi > 70 && rsi <= 80 ? 8
      : rsi < 30 ? 5
      : 0; // RSI > 80

    // Component 4: Trend (0–25) — aligned with moving averages
    const trendScore = pctFromMa200 !== null
      ? (pctFromMa200 > 0 && pctFromMa50 > 0 ? 25        // above both MAs
        : pctFromMa200 > 0 && pctFromMa50 <= 0 ? 15      // above 200, dipped below 50 (pullback)
        : pctFromMa200 <= 0 && pctFromMa50 > 0 ? 8       // below 200 but recovering
        : 0)                                               // below both MAs
      : (pctFromMa50 > 0 ? 18 : 5);

    const score = volScore + momScore + rsiScore + trendScore;

    // ── Signal label ───────────────────────────────────────────────────────
    const signal = score >= 72 ? 'STRONG ENTRY'
      : score >= 55 ? 'FAVORABLE'
      : score >= 38 ? 'NEUTRAL'
      : score >= 22 ? 'CAUTION'
      : 'AVOID';

    const signalColor = score >= 72 ? '#22c55e'
      : score >= 55 ? '#3b82f6'
      : score >= 38 ? '#f59e0b'
      : '#ef4444';

    // ── Expected price range (30d, 1-sigma ~68%) ───────────────────────────
    const move30pct = dailySigma * Math.sqrt(30) * 100;
    const priceHigh = Math.round(current * (1 + dailySigma * Math.sqrt(30)) * 100) / 100;
    const priceLow  = Math.round(current * (1 - dailySigma * Math.sqrt(30)) * 100) / 100;

    // ── Key factors ────────────────────────────────────────────────────────
    const factors = [];

    if (volPct < 30)      factors.push({ text: `Vol at ${volPct}th pct — cheap window to enter`, bull: true });
    else if (volPct > 75) factors.push({ text: `Vol at ${volPct}th pct — elevated, expect large swings`, bull: false });

    if (pctFromMa200 !== null) {
      if (pctFromMa200 > 0) factors.push({ text: `Above 200DMA by ${pctFromMa200.toFixed(1)}% — uptrend intact`, bull: true });
      else factors.push({ text: `Below 200DMA by ${Math.abs(pctFromMa200).toFixed(1)}% — caution, downtrend`, bull: false });
    }

    if (rsi > 70) factors.push({ text: `RSI ${rsi} — overbought, wait for pullback`, bull: false });
    else if (rsi < 35) factors.push({ text: `RSI ${rsi} — oversold, potential bounce zone`, bull: true });
    else factors.push({ text: `RSI ${rsi} — neutral zone, no extremes`, bull: true });

    if (mom !== null) {
      if (mom >= 2 && mom <= 12) factors.push({ text: `+${mom.toFixed(1)}% 20d momentum — healthy trend`, bull: true });
      else if (mom > 12) factors.push({ text: `+${mom.toFixed(1)}% 20d — extended, chasing risk`, bull: false });
      else if (mom < -5) factors.push({ text: `${mom.toFixed(1)}% 20d — negative momentum`, bull: false });
    }

    if (pos52 > 85) factors.push({ text: `Near 52-week high (${pos52}%) — momentum but limited upside buffer`, bull: false });
    else if (pos52 < 20) factors.push({ text: `Near 52-week low (${pos52}%) — oversold territory`, bull: false });

    // ── Analyst consensus from Yahoo Finance ──────────────────────────────
    const finData  = summary?.quoteSummary?.result?.[0]?.financialData;
    const keyStats = summary?.quoteSummary?.result?.[0]?.defaultKeyStatistics;

    // ── Upcoming earnings date ────────────────────────────────────────────
    const calEvents    = summary?.quoteSummary?.result?.[0]?.calendarEvents;
    const earningsDts  = calEvents?.earnings?.earningsDate || [];
    const nowMs        = Date.now();
    const nextEarnings = earningsDts.find(e => e.raw * 1000 > nowMs - 86400000);
    const daysUntilEarnings = nextEarnings ? Math.round((nextEarnings.raw * 1000 - nowMs) / 86400000) : null;
    const earningsDate      = nextEarnings ? new Date(nextEarnings.raw * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
    const earningsIsEstimate = calEvents?.earnings?.isEarningsDateEstimate ?? false;
    const analystRating = finData?.recommendationKey || 'none'; // strong_buy | buy | hold | sell | strong_sell
    const analystCount  = finData?.numberOfAnalystOpinions?.raw || 0;
    const analystMean   = finData?.recommendationMean?.raw || null; // 1=strong buy → 5=strong sell
    const week52High    = keyStats?.fiftyTwoWeekHigh?.raw || high52;
    const fromHigh52    = Math.round(((current - week52High) / week52High) * 1000) / 10; // negative = below high

    // ── Risk flags ────────────────────────────────────────────────────────
    const riskFlags = [];
    if (fromHigh52 < -30) riskFlags.push(`Down ${Math.abs(fromHigh52)}% from 52-week high — possible distressed situation`);
    if (analystRating === 'sell' || analystRating === 'strong_sell') riskFlags.push(`Analysts rate ${analystRating.replace('_',' ')} — consensus caution`);
    if (analystMean && analystMean > 3.5) riskFlags.push('Analyst consensus below hold — weak conviction');
    if (volPct > 75 && ret20d < 0) riskFlags.push('High vol + negative momentum — avoid for now');

    // ── Analyst score adjustment ──────────────────────────────────────────
    // Strong buy = +8, buy = +4, hold = 0, sell = -15, strong_sell = -25
    const analystBonus = analystRating === 'strong_buy' ? 8
      : analystRating === 'buy' ? 4
      : analystRating === 'hold' ? 0
      : analystRating === 'sell' ? -15
      : analystRating === 'strong_sell' ? -25 : 0;

    const adjustedScore = Math.min(100, Math.max(0, score + analystBonus));

    // ── Suggested action ───────────────────────────────────────────────────
    const action = adjustedScore >= 72
      ? `Conditions are favorable. Consider entering at current price or on any minor dip. Keep position size moderate given ${annualVol}% annual vol.`
      : adjustedScore >= 55
      ? `Decent setup but not ideal. Wait for vol to ease or a small pullback before entering. Risk/reward is acceptable.`
      : adjustedScore >= 38
      ? `Mixed signals — don't rush. Watch for RSI to cool or price to pull back toward MA50 before committing.`
      : adjustedScore >= 22
      ? `Several caution flags. If you want exposure, use a small starter position only and set a clear stop.`
      : `Conditions are poor for entry. High vol, weak trend, and/or overbought — wait for a better setup.`;

    const finalSignal = adjustedScore >= 72 ? 'STRONG ENTRY'
      : adjustedScore >= 55 ? 'FAVORABLE'
      : adjustedScore >= 38 ? 'NEUTRAL'
      : adjustedScore >= 22 ? 'CAUTION'
      : 'AVOID';
    const finalColor = adjustedScore >= 72 ? '#22c55e'
      : adjustedScore >= 55 ? '#3b82f6'
      : adjustedScore >= 38 ? '#f59e0b'
      : '#ef4444';

    res.json({
      ticker,
      name: meta.longName || meta.shortName || ticker,
      current,
      score: adjustedScore,
      baseScore: score,
      signal: finalSignal,
      signalColor: finalColor,
      analystRating,
      analystCount,
      analystMean,
      fromHigh52,
      daysUntilEarnings,
      earningsDate,
      earningsIsEstimate,
      riskFlags,
      components: { volScore, momScore, rsiScore, trendScore, analystBonus },
      factors: factors.slice(0, 5),
      action,
      expectedRange: {
        low: priceLow,
        high: priceHigh,
        movePct: Math.round(move30pct * 10) / 10,
        days: 30,
      },
      metrics: {
        rsi,
        annualVol,
        volPct,
        pctFromMa50: Math.round(pctFromMa50 * 10) / 10,
        pctFromMa200: pctFromMa200 !== null ? Math.round(pctFromMa200 * 10) / 10 : null,
        ret5d: ret5d !== null ? Math.round(ret5d * 10) / 10 : null,
        ret20d: ret20d !== null ? Math.round(ret20d * 10) / 10 : null,
        ret60d: ret60d !== null ? Math.round(ret60d * 10) / 10 : null,
        high52: Math.round(high52 * 100) / 100,
        low52: Math.round(low52 * 100) / 100,
        pos52,
        volRatio,
      },
      timestamp: new Date().toISOString(),
    });

  } catch (e) {
    console.error('analyze error:', e.message);
    res.status(500).json({ error: `Analysis failed: ${e.message}` });
  }
}
