export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const errors = [];

  async function fetchChart(symbol, range = '1mo') {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
      return await r.json();
    } catch (e) { errors.push(symbol); return null; }
  }

  function parsePerf(json) {
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    const closes = result.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
    if (closes.length < 2) return null;
    const price = meta?.regularMarketPrice || closes[closes.length - 1];
    const first = closes[0];
    const week1 = closes.length >= 5 ? closes[closes.length - 5] : first;
    const changePct = ((price - first) / first) * 100;
    const weekPct = ((price - week1) / week1) * 100;
    const volume = meta?.regularMarketVolume || 0;
    const avgVolume = meta?.averageDailyVolume3Month || 0;
    const high52 = meta?.fiftyTwoWeekHigh || null;
    const low52 = meta?.fiftyTwoWeekLow || null;
    const ma50 = meta?.fiftyDayAverage || null;
    const ma200 = meta?.twoHundredDayAverage || null;

    // Calculate if near 52-week high or low
    let near52High = false, near52Low = false;
    if (high52) near52High = price >= high52 * 0.95;
    if (low52) near52Low = price <= low52 * 1.05;

    return { price, changePct, weekPct, volume, avgVolume, high52, low52, ma50, ma200, near52High, near52Low, closes };
  }

  // ── 1. SECTOR ETFs ──
  const sectorSymbols = [
    { sym: 'XLK', name: 'Technology', emoji: '💻' },
    { sym: 'XLV', name: 'Healthcare', emoji: '🏥' },
    { sym: 'XLE', name: 'Energy', emoji: '⛽' },
    { sym: 'XLF', name: 'Financials', emoji: '🏦' },
    { sym: 'XLI', name: 'Industrials', emoji: '🏗️' },
    { sym: 'XLY', name: 'Consumer Disc.', emoji: '🛍️' },
    { sym: 'XLP', name: 'Consumer Staples', emoji: '🛒' },
    { sym: 'XLC', name: 'Communication', emoji: '📡' },
    { sym: 'XLRE', name: 'Real Estate', emoji: '🏠' },
    { sym: 'XLU', name: 'Utilities', emoji: '⚡' },
    { sym: 'GLD', name: 'Gold', emoji: '🥇' },
    { sym: 'TLT', name: 'Long Bonds', emoji: '📄' },
  ];

  const sectorData = [];
  await Promise.all(sectorSymbols.map(async (s) => {
    const json = await fetchChart(s.sym, '1mo');
    const perf = parsePerf(json);
    if (perf) {
      sectorData.push({
        ...s,
        price: perf.price,
        monthPct: perf.changePct,
        weekPct: perf.weekPct,
        near52High: perf.near52High,
        near52Low: perf.near52Low,
        volumeRatio: perf.avgVolume > 0 ? perf.volume / perf.avgVolume : 1,
      });
    }
  }));

  // Sort by monthly momentum
  sectorData.sort((a, b) => b.monthPct - a.monthPct);

  // ── 2. WATCHLIST SCAN (unusual volume, breakouts) ──
  const scanSymbols = ['AAPL', 'AMZN', 'META', 'SMH', 'SOXX', 'LLY', 'XBI', 'COPX', 'SLV', 'GDX', 'VNQ', 'IWM'];
  const smartSignals = [];

  await Promise.all(scanSymbols.map(async (sym) => {
    const json = await fetchChart(sym, '3mo');
    const perf = parsePerf(json);
    if (!perf) return;

    const signals = [];
    const volRatio = perf.avgVolume > 0 ? perf.volume / perf.avgVolume : 1;

    if (volRatio >= 1.5) signals.push({ type: 'volume', text: `${volRatio.toFixed(1)}x avg volume — institutional activity` });
    if (perf.near52High) signals.push({ type: 'breakout', text: 'Near 52-week high — momentum breakout' });
    if (perf.near52Low) signals.push({ type: 'breakdown', text: 'Near 52-week low — potential deep value or avoid' });
    if (perf.ma50 && perf.ma200 && perf.ma50 > perf.ma200 && perf.price > perf.ma50) signals.push({ type: 'golden', text: 'Above 50 & 200 MA — bullish structure' });
    if (perf.ma50 && perf.ma200 && perf.ma50 < perf.ma200) signals.push({ type: 'death', text: 'Death cross (50 < 200 MA) — bearish caution' });
    if (perf.changePct <= -10) signals.push({ type: 'dip', text: `Down ${perf.changePct.toFixed(1)}% in 3 months — watch for entry` });
    if (perf.changePct >= 15) signals.push({ type: 'surge', text: `Up ${perf.changePct.toFixed(1)}% in 3 months — consider taking profits if held` });

    if (signals.length > 0) {
      smartSignals.push({
        ticker: sym,
        price: perf.price,
        changePct: perf.changePct,
        weekPct: perf.weekPct,
        signals,
      });
    }
  }));

  // Sort by signal count, then by absolute change
  smartSignals.sort((a, b) => b.signals.length - a.signals.length || Math.abs(b.changePct) - Math.abs(a.changePct));

  // ── 3. GENERATE DAILY BRIEF ──
  const topSectors = sectorData.slice(0, 3);
  const bottomSectors = sectorData.slice(-3).reverse();
  const hotSector = sectorData[0];
  const coldSector = sectorData[sectorData.length - 1];

  // Market breadth
  const bullishSectors = sectorData.filter(s => s.monthPct > 0).length;
  const bearishSectors = sectorData.filter(s => s.monthPct < 0).length;
  const breadth = bullishSectors > 8 ? 'broad_rally' : bullishSectors > 5 ? 'mixed_positive' : bullishSectors > 3 ? 'mixed_negative' : 'broad_selloff';

  // Defensive rotation check
  const defSectors = sectorData.filter(s => ['XLP', 'XLU', 'XLV', 'GLD', 'TLT'].includes(s.sym));
  const offSectors = sectorData.filter(s => ['XLK', 'XLY', 'XLC', 'XLF'].includes(s.sym));
  const defAvg = defSectors.reduce((s, x) => s + x.monthPct, 0) / (defSectors.length || 1);
  const offAvg = offSectors.reduce((s, x) => s + x.monthPct, 0) / (offSectors.length || 1);
  const rotationSignal = defAvg > offAvg + 2 ? 'defensive' : offAvg > defAvg + 2 ? 'risk_on' : 'neutral';

  // Build brief items
  const brief = [];

  // Market breadth insight
  if (breadth === 'broad_selloff') {
    brief.push({ icon: '🔴', title: 'Broad Market Selloff', text: `Only ${bullishSectors}/${sectorData.length} sectors positive. Capital preservation mode — hold cash, avoid new buys.`, priority: 'high' });
  } else if (breadth === 'broad_rally') {
    brief.push({ icon: '🟢', title: 'Broad Market Rally', text: `${bullishSectors}/${sectorData.length} sectors rising. Risk-on environment — deploy per regime plan.`, priority: 'low' });
  } else {
    brief.push({ icon: '🟡', title: 'Mixed Market', text: `${bullishSectors} sectors up, ${bearishSectors} down. Be selective — follow sector momentum.`, priority: 'medium' });
  }

  // Rotation signal
  if (rotationSignal === 'defensive') {
    brief.push({ icon: '🛡️', title: 'Defensive Rotation Underway', text: `Defensive sectors (Staples, Utilities, Healthcare, Gold) outperforming growth by ${(defAvg - offAvg).toFixed(1)}pp. Smart money is de-risking. Consider GLD, XLV, XLP.`, priority: 'high' });
  } else if (rotationSignal === 'risk_on') {
    brief.push({ icon: '🚀', title: 'Risk-On Rotation Active', text: `Growth sectors (Tech, Consumer, Financials) leading by ${(offAvg - defAvg).toFixed(1)}pp. Momentum favors QQQ, XLK, SMH.`, priority: 'medium' });
  }

  // Hot sector opportunity
  if (hotSector && hotSector.monthPct > 3) {
    brief.push({ icon: '🔥', title: `${hotSector.name} Leading (+${hotSector.monthPct.toFixed(1)}%)`, text: `${hotSector.sym} is the strongest sector this month. Consider ${hotSector.sym} if not already exposed. Don't chase — wait for a 2-3% pullback.`, priority: 'medium' });
  }

  // Cold sector warning/opportunity
  if (coldSector && coldSector.monthPct < -5) {
    brief.push({ icon: '❄️', title: `${coldSector.name} Weakest (${coldSector.monthPct.toFixed(1)}%)`, text: `${coldSector.sym} is the worst performer. Avoid new positions here unless you see a catalyst. If held, review stop-loss.`, priority: 'medium' });
  }

  // Smart money highlights
  const breakouts = smartSignals.filter(s => s.signals.some(sig => sig.type === 'breakout'));
  if (breakouts.length > 0) {
    brief.push({ icon: '📈', title: `Breakout Watch: ${breakouts.map(b => b.ticker).join(', ')}`, text: `Near 52-week highs with momentum. These often continue higher — watch for pullback entries.`, priority: 'medium' });
  }

  const deepDips = smartSignals.filter(s => s.signals.some(sig => sig.type === 'dip'));
  if (deepDips.length > 0) {
    brief.push({ icon: '🎯', title: `Dip Opportunities: ${deepDips.map(b => b.ticker).join(', ')}`, text: `Down 10%+ in 3 months. Research these for potential value entries — but verify the thesis hasn't broken.`, priority: 'medium' });
  }

  // Real estate / rate signal
  const xlre = sectorData.find(s => s.sym === 'XLRE');
  const tlt = sectorData.find(s => s.sym === 'TLT');
  if (xlre && tlt) {
    if (xlre.monthPct > 3 && tlt.monthPct > 1) {
      brief.push({ icon: '🏠', title: 'Rate-Sensitive Rally', text: `Real Estate (${xlre.monthPct.toFixed(1)}%) and Bonds (${tlt.monthPct.toFixed(1)}%) both rising — market expects rate cuts. Consider XLRE, VNQ.`, priority: 'medium' });
    } else if (xlre.monthPct < -3 && tlt.monthPct < -1) {
      brief.push({ icon: '📉', title: 'Rate Pressure on Real Estate', text: `XLRE (${xlre.monthPct.toFixed(1)}%) and Bonds (${tlt.monthPct.toFixed(1)}%) both falling — rising rate environment. Avoid REITs for now.`, priority: 'medium' });
    }
  }

  // Gold signal
  const gld = sectorData.find(s => s.sym === 'GLD');
  if (gld && gld.monthPct > 5) {
    brief.push({ icon: '🥇', title: `Gold Surging (+${gld.monthPct.toFixed(1)}%)`, text: `Flight to safety active. If not holding GLD, consider a 5-10% portfolio allocation as hedge.`, priority: 'medium' });
  }

  return res.status(200).json({
    brief,
    sectors: sectorData,
    smartSignals: smartSignals.slice(0, 10),
    rotation: {
      signal: rotationSignal,
      defensiveAvg: Math.round(defAvg * 10) / 10,
      offensiveAvg: Math.round(offAvg * 10) / 10,
    },
    breadth: { bullish: bullishSectors, bearish: bearishSectors, signal: breadth },
    topSectors: topSectors.map(s => ({ sym: s.sym, name: s.name, pct: s.monthPct })),
    bottomSectors: bottomSectors.map(s => ({ sym: s.sym, name: s.name, pct: s.monthPct })),
    errors: errors.length > 0 ? errors : undefined,
    timestamp: new Date().toISOString()
  });
}
