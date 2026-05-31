// Tier 2: Probabilistic Regime Transition Model
// Logistic regression on 5 standardised market features.
// Outputs P(regime shift in next ~20 sessions) + feature drivers.

const sigmoid = x => 1 / (1 + Math.exp(-x));

async function fetchCloses(ticker, range = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=${range}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
  const d = await r.json();
  const raw = d.chart?.result?.[0];
  if (!raw) return [];
  return (raw.indicators?.quote?.[0]?.close || []).filter(v => v != null);
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function std(arr) { const m = mean(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); }
function ma(arr, n) { const s = arr.slice(-n); return mean(s); }
function pctChange(arr, n) { const l = arr.length; return l > n ? (arr[l - 1] - arr[l - 1 - n]) / arr[l - 1 - n] * 100 : null; }
function clip(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate');

  try {
    // ── Fetch data ─────────────────────────────────────────────────────────
    const [spy, vix, hyg] = await Promise.all([
      fetchCloses('SPY', '1y'),
      fetchCloses('^VIX', '1y'),
      fetchCloses('HYG', '3mo'),
    ]);

    if (spy.length < 30 || vix.length < 30) {
      return res.status(500).json({ error: 'Insufficient market data' });
    }

    // ── Feature 1: SPY vs 200DMA ───────────────────────────────────────────
    const spy200 = ma(spy, Math.min(200, spy.length));
    const spyCurrent = spy[spy.length - 1];
    const spyVsMa200Pct = (spyCurrent - spy200) / spy200 * 100; // e.g. +5.2 or -3.1
    // Normalise: clip to ±15%, divide by 7.5 → range [-2, +2]
    const f1 = clip(spyVsMa200Pct, -15, 15) / 7.5;

    // ── Feature 2: VIX z-score vs trailing year ────────────────────────────
    const vixCurrent = vix[vix.length - 1];
    const vixMean = mean(vix);
    const vixStd = std(vix) || 1;
    const f2 = clip((vixCurrent - vixMean) / vixStd, -3, 3); // z-score

    // ── Feature 3: VIX 5-day momentum ─────────────────────────────────────
    const vix5dChg = pctChange(vix, 5) ?? 0;
    const f3 = clip(vix5dChg / 20, -2, 2); // normalise: ±20% change → ±1

    // ── Feature 4: SPY 20-day price momentum ──────────────────────────────
    const spy20dReturn = pctChange(spy, 20) ?? 0;
    const f4 = clip(spy20dReturn / 8, -2, 2); // normalise: ±8% → ±1

    // ── Feature 5: Credit (HYG 10-day return) ─────────────────────────────
    const hygReturn = hyg.length >= 11 ? pctChange(hyg, 10) ?? 0 : 0;
    const f5 = clip(hygReturn / 3, -2, 2); // normalise: ±3% → ±1

    // ── Logistic regression (P → Risk-Off) ────────────────────────────────
    // Calibrated on empirical relationships:
    //   SPY below 200DMA → strongly bearish
    //   High VIX (vs history) → bearish
    //   VIX rising fast → bearish
    //   Negative price momentum → bearish
    //   Credit stress (HYG falling) → bearish
    const WEIGHTS = {
      intercept: -0.50,
      f1: -1.40,  // SPY vs MA200: lower = more bearish
      f2:  1.30,  // VIX z-score: higher = more bearish
      f3:  0.85,  // VIX momentum: rising = bearish
      f4: -0.95,  // SPY momentum: negative = bearish
      f5: -0.70,  // Credit: falling HYG = bearish
    };

    const logit =
      WEIGHTS.intercept +
      WEIGHTS.f1 * f1 +
      WEIGHTS.f2 * f2 +
      WEIGHTS.f3 * f3 +
      WEIGHTS.f4 * f4 +
      WEIGHTS.f5 * f5;

    const pRiskOff = Math.round(sigmoid(logit) * 100);

    // ── Feature contributions (marginal impact on logit) ──────────────────
    const contribs = [
      { name: 'SPY vs 200-Day MA', value: spyVsMa200Pct.toFixed(1) + '%', contribution: WEIGHTS.f1 * f1, raw: f1, bearish: f1 < 0, label: spyVsMa200Pct >= 0 ? `${spyVsMa200Pct.toFixed(1)}% above MA` : `${Math.abs(spyVsMa200Pct).toFixed(1)}% below MA` },
      { name: 'VIX Level', value: vixCurrent.toFixed(1), contribution: WEIGHTS.f2 * f2, raw: f2, bearish: f2 > 0, label: vixCurrent > vixMean ? `${((vixCurrent - vixMean) / vixStd).toFixed(1)}σ above avg (${vixMean.toFixed(0)})` : `${Math.abs((vixCurrent - vixMean) / vixStd).toFixed(1)}σ below avg` },
      { name: 'VIX 5-Day Change', value: (vix5dChg >= 0 ? '+' : '') + vix5dChg.toFixed(1) + '%', contribution: WEIGHTS.f3 * f3, raw: f3, bearish: vix5dChg > 5, label: vix5dChg > 5 ? 'Rising fast — stress building' : vix5dChg < -5 ? 'Falling — stress easing' : 'Stable' },
      { name: 'SPY 20-Day Return', value: (spy20dReturn >= 0 ? '+' : '') + spy20dReturn.toFixed(1) + '%', contribution: WEIGHTS.f4 * f4, raw: f4, bearish: spy20dReturn < 0, label: spy20dReturn >= 0 ? 'Positive momentum' : 'Negative momentum' },
      { name: 'Credit (HYG 10d)', value: (hygReturn >= 0 ? '+' : '') + hygReturn.toFixed(1) + '%', contribution: WEIGHTS.f5 * f5, raw: f5, bearish: hygReturn < -1, label: hygReturn < -1 ? 'Credit stress — spreads widening' : hygReturn > 1 ? 'Credit strength — spreads tightening' : 'Credit neutral' },
    ].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)); // sort by impact

    // ── Risk level label ───────────────────────────────────────────────────
    const riskLabel = pRiskOff >= 70 ? 'HIGH'
      : pRiskOff >= 45 ? 'ELEVATED'
      : pRiskOff >= 25 ? 'MODERATE'
      : 'LOW';

    const riskColor = pRiskOff >= 70 ? '#ef4444'
      : pRiskOff >= 45 ? '#f59e0b'
      : pRiskOff >= 25 ? '#3b82f6'
      : '#22c55e';

    // ── Dominant driver ────────────────────────────────────────────────────
    const topDriver = contribs[0];
    const summary = pRiskOff >= 60
      ? `Primary driver: ${topDriver.name} — ${topDriver.label}.`
      : pRiskOff <= 25
      ? `Market structure looks resilient. ${topDriver.name} is the main stabiliser.`
      : `Mixed signals. Watch ${contribs.filter(c => c.bearish).map(c => c.name).slice(0, 2).join(' and ')}.`;

    res.json({
      pRiskOff,        // 0–100 integer
      riskLabel,       // LOW | MODERATE | ELEVATED | HIGH
      riskColor,
      logit: Math.round(logit * 100) / 100,
      contribs: contribs.slice(0, 5),
      summary,
      inputs: {
        spyCurrent: Math.round(spyCurrent * 100) / 100,
        spy200: Math.round(spy200 * 100) / 100,
        spyVsMa200Pct: Math.round(spyVsMa200Pct * 10) / 10,
        vixCurrent: Math.round(vixCurrent * 10) / 10,
        vixMean: Math.round(vixMean * 10) / 10,
        vix5dChg: Math.round(vix5dChg * 10) / 10,
        spy20dReturn: Math.round(spy20dReturn * 10) / 10,
        hygReturn: Math.round(hygReturn * 10) / 10,
      },
      timestamp: new Date().toISOString(),
    });

  } catch (e) {
    console.error('regime-probability error:', e.message);
    res.status(500).json({ error: e.message });
  }
}
