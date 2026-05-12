export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { image, mimeType } = req.body || {};
  if (!image) return res.status(400).json({ error: 'Image is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API not configured — add ANTHROPIC_API_KEY to Vercel env vars' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType || 'image/jpeg',
                data: image
              }
            },
            {
              type: 'text',
              text: `Extract all stock/ETF portfolio positions from this investing app screenshot. Return ONLY a valid JSON array with no extra text or explanation, in this exact format:
[
  {"ticker": "AAPL", "name": "Apple Inc.", "shares": 10, "currentPrice": 195.50}
]

Rules:
- ticker: the stock/ETF symbol in uppercase (e.g. AAPL, MSFT, QQQ)
- name: full company or fund name if visible, otherwise just use the ticker
- shares: number of shares owned (can be a decimal like 2.5)
- currentPrice: current price per share in USD numbers only (no $ sign)
- If the screenshot shows total market value but not price per share, divide total by shares
- Skip cash, cash equivalents, bonds, money market funds, or anything non-equity
- If you cannot find any valid positions, return exactly: []
- Return ONLY the JSON array, nothing else — no markdown, no explanation`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error: ${errText}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text?.trim() || '[]';

    // Extract JSON array (guard against any stray text)
    let positions = [];
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) positions = JSON.parse(match[0]);
    } catch (e) {
      positions = [];
    }

    // Validate and sanitize
    positions = positions
      .filter(p => p && p.ticker && parseFloat(p.shares) > 0 && parseFloat(p.currentPrice) > 0)
      .map(p => ({
        ticker: String(p.ticker).toUpperCase().replace(/[^A-Z0-9.]/g, ''),
        name: String(p.name || p.ticker).trim().slice(0, 60),
        shares: Math.round(parseFloat(p.shares) * 10000) / 10000,
        currentPrice: Math.round(parseFloat(p.currentPrice) * 100) / 100
      }))
      .filter(p => p.ticker.length >= 1 && p.ticker.length <= 6);

    res.json({ positions, count: positions.length });

  } catch (e) {
    console.error('parse-portfolio error:', e.message);
    res.status(500).json({ error: 'Failed to scan image. Please try a clearer screenshot.' });
  }
}
