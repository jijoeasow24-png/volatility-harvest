// regime.js — Rules-based regime detection + probabilistic pRiskOff model in one call
// Replaces: regime.js + regime-probability.js (consolidated to stay within Vercel free-tier 12-function limit)

const sigmoid = x => 1 / (1 + Math.exp(-x));

async function fetchCloses(ticker, range) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=${range}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
  const d = await r.json();
  const raw = d.chart?.result?.[0];
  if (!raw) return { closes: [], meta: {} };
  return {
    closes: (raw.indicators?.quote?.[0]?.close || []).filter(v => v != null),
    meta:   raw.meta || {},
  };
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr)  { const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); }
function clip(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function pctChange(arr, n) { const l = arr.length; return l > n ? (arr[l - 1] - arr[l - 1 - n]) / arr[l - 1 - n] * 100 : null; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const errors = [];
  const indicators = {};

  // ── Shared fetches (used by both models) ────────────────────────────────
  const [spyData, vixData, hygData, tnxData, oilData, dxyData] = await Promise.all([
    fetchCloses('SPY',      '1y'),
    fetchCloses('^VIX',     '1y'),
    fetchCloses('HYG',      '3mo'),
    fetchCloses('%5ETNX',   '1mo'),
    fetchCloses('CL=F',     '1mo'),
    fetchCloses('DX-Y.NYB', '1mo'),
  ]);

  const spy = spyData.closes;
  const vix = vixData.closes;
  const hyg = hygData.closes;
  const tnx = tnxData.closes;
  const oil = oilData.closes;
  const dxy = dxyData.closes;

  // ════════════════════════════════════════════════════════════════════
  // PART A — Rules-based regime (5-factor checklist → Risk-On / Risk-Off)
  // ════════════════════════════════════════════════════════════════════

  // 1. SPY vs 200DMA
  if (spy.length >= 2) {
    const price = spyData.meta.regularMarketPrice ?? spy[spy.length - 1];
    let ma200 = null;
    if (spy.length >= 200) ma200 = spy.slice(-200).reduce((s, c) => s + c, 0) / 200;
    else if (spy.length >= 50) ma200 = spy.reduce((s, c) => s + c, 0) / spy.length;
    if (ma200 === null) ma200 = spyData.meta.twoHundredDayAverage ?? spyData.meta.fiftyDayAverage ?? null;
    if (price && ma200) {
      indicators.spy = { price, ma200: Math.round(ma200 * 100) / 100, above: price > ma200, pctFromMA: (price - ma200) / ma200 * 100, dataPoints: spy.length };
    }
  }

  // 2. VIX level
  if (vix.length) {
    const level = vixData.meta.regularMarketPrice ?? vix[vix.length - 1];
    indicators.vix = { level, below20: level < 20, zone: level < 15 ? 'very_calm' : level < 20 ? 'calm' : level < 25 ? 'elevated' : level < 35 ? 'high' : 'extreme' };
  }

  // 3. 10Y yields — 30d stability
  if (tnx.length >= 2) {
    const current = tnx[tnx.length - 1], monthAgo = tnx[0];
    const changePct = (current - monthAgo) / monthAgo * 100;
    indicators.yields = { current, monthAgo, change30d: current - monthAgo, changePct30d: changePct, stable: Math.abs(changePct) < 5 };
  }

  // 4. Oil — 30d stability
  if (oil.length >= 2) {
    const current = oil[oil.length - 1], monthAgo = oil[0];
    const changePct = (current - monthAgo) / monthAgo * 100;
    indicators.oil = { current, monthAgo, changePct30d: changePct, stable: Math.abs(changePct) < 15, shock: Math.abs(changePct) >= 20 };
  }

  // 5. DXY — not spiking
  if (dxy.length >= 2) {
    const current = dxy[dxy.length - 1], monthAgo = dxy[0];
    const changePct = (current - monthAgo) / monthAgo * 100;
    indicators.dxy = { current, monthAgo, changePct30d: changePct, notSpiking: changePct < 3 };
  }

  const answers = {
    spy200:    indicators.spy?.above         ?? false,
    vix20:     indicators.vix?.below20       ?? false,
    yields:    indicators.yields?.stable     ?? false,
    oil:       indicators.oil?.stable        ?? false,
    dxy:       indicators.dxy?.notSpiking    ?? false,
    oilShock:  indicators.oil?.shock        ?? false,
    inflation: false,
    recession: false,
  };
  const yesCount = [answers.spy200, answers.vix20, answers.yields, answers.oil, answers.dxy].filter(Boolean).length;
  const regime = answers.oilShock ? 'Oil Shock' : answers.inflation ? 'Inflation Spike' : answers.recession ? 'Recession Scare' : yesCount >= 3 ? 'Risk-On' : 'Risk-Off';

  // ════════════════════════════════════════════════════════════════════
  // PART B — Logistic regression pRiskOff model (from regime-probability.js)
  // ════════════════════════════════════════════════════════════════════

  let pRiskOff = null, riskLabel = null, riskColor = null, contribs = [], summary = '', probInputs = {};

  if (spy.length >= 30 && vix.length >= 30) {
    // Feature 1: SPY vs 200DMA
    const spy200 = spy.slice(-Math.min(200, spy.length)).reduce((s, c) => s + c, 0) / Math.min(200, spy.length);
    const spyCurrent    = spy[spy.length - 1];
    const spyVsMa200Pct = (spyCurrent - spy200) / spy200 * 100;
    const f1 = clip(spyVsMa200Pct, -15, 15) / 7.5;

    // Feature 2: VIX z-score
    const vixCurrent = vix[vix.length - 1];
    const vixMean    = mean(vix);
    const vixStd_    = std(vix) || 1;
    const f2 = clip((vixCurrent - vixMean) / vixStd_, -3, 3);

    // Feature 3: VIX 5d momentum
    const vix5dChg = pctChange(vix, 5) ?? 0;
    const f3 = clip(vix5dChg / 20, -2, 2);

    // Feature 4: SPY 20d momentum
    const spy20dReturn = pctChange(spy, 20) ?? 0;
    const f4 = clip(spy20dReturn / 8, -2, 2);

    // Feature 5: HYG 10d credit return
    const hygReturn = hyg.length >= 11 ? pctChange(hyg, 10) ?? 0 : 0;
    const f5 = clip(hygReturn / 3, -2, 2);

    const WEIGHTS = { intercept: -0.50, f1: -1.40, f2: 1.30, f3: 0.85, f4: -0.95, f5: -0.70 };
    const logit = WEIGHTS.intercept + WEIGHTS.f1*f1 + WEIGHTS.f2*f2 + WEIGHTS.f3*f3 + WEIGHTS.f4*f4 + WEIGHTS.f5*f5;
    pRiskOff = Math.round(sigmoid(logit) * 100);

    riskLabel = pRiskOff >= 70 ? 'HIGH' : pRiskOff >= 45 ? 'ELEVATED' : pRiskOff >= 25 ? 'MODERATE' : 'LOW';
    riskColor = pRiskOff >= 70 ? '#ef4444' : pRiskOff >= 45 ? '#f59e0b' : pRiskOff >= 25 ? '#3b82f6' : '#22c55e';

    contribs = [
      { name: 'SPY vs 200-Day MA', value: spyVsMa200Pct.toFixed(1)+'%', contribution: WEIGHTS.f1*f1, raw: f1, bearish: f1<0, label: spyVsMa200Pct>=0?`${spyVsMa200Pct.toFixed(1)}% above MA`:`${Math.abs(spyVsMa200Pct).toFixed(1)}% below MA` },
      { name: 'VIX Level',          value: vixCurrent.toFixed(1),         contribution: WEIGHTS.f2*f2, raw: f2, bearish: f2>0, label: vixCurrent>vixMean?`${((vixCurrent-vixMean)/vixStd_).toFixed(1)}σ above avg`:`${Math.abs((vixCurrent-vixMean)/vixStd_).toFixed(1)}σ below avg` },
      { name: 'VIX 5-Day Change',   value: (vix5dChg>=0?'+':'')+vix5dChg.toFixed(1)+'%', contribution: WEIGHTS.f3*f3, raw: f3, bearish: vix5dChg>5, label: vix5dChg>5?'Rising fast — stress building':vix5dChg<-5?'Falling — stress easing':'Stable' },
      { name: 'SPY 20-Day Return',  value: (spy20dReturn>=0?'+':'')+spy20dReturn.toFixed(1)+'%', contribution: WEIGHTS.f4*f4, raw: f4, bearish: spy20dReturn<0, label: spy20dReturn>=0?'Positive momentum':'Negative momentum' },
      { name: 'Credit (HYG 10d)',   value: (hygReturn>=0?'+':'')+hygReturn.toFixed(1)+'%',   contribution: WEIGHTS.f5*f5, raw: f5, bearish: hygReturn<-1, label: hygReturn<-1?'Credit stress — spreads widening':hygReturn>1?'Credit strength':'Credit neutral' },
    ].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    const topDriver = contribs[0];
    summary = pRiskOff >= 60
      ? `Primary driver: ${topDriver.name} — ${topDriver.label}.`
      : pRiskOff <= 25
      ? `Market structure looks resilient. ${topDriver.name} is the main stabiliser.`
      : `Mixed signals. Watch ${contribs.filter(c=>c.bearish).map(c=>c.name).slice(0,2).join(' and ')}.`;

    probInputs = {
      spyCurrent: Math.round(spyCurrent*100)/100, spy200: Math.round(spy200*100)/100,
      spyVsMa200Pct: Math.round(spyVsMa200Pct*10)/10,
      vixCurrent: Math.round(vixCurrent*10)/10, vixMean: Math.round(vixMean*10)/10,
      vix5dChg: Math.round(vix5dChg*10)/10, spy20dReturn: Math.round(spy20dReturn*10)/10,
      hygReturn: Math.round(hygReturn*10)/10,
    };
  }

  return res.status(200).json({
    // ── Rules-based output (same shape as old regime.js) ──
    answers, yesCount, regime, indicators,
    // ── Probabilistic output (same shape as old regime-probability.js) ──
    pRiskOff, riskLabel, riskColor, contribs, summary, inputs: probInputs,
    errors: errors.length > 0 ? errors : undefined,
    timestamp: new Date().toISOString(),
  });
}
