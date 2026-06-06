export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { image, mimeType } = req.body || {};
  if (!image) return res.status(400).json({ error: 'Image is required' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API not configured — add GEMINI_API_KEY to Vercel env vars' });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: mimeType || 'image/jpeg',
                  data: image
                }
              },
              {
                text: `Extract stock/ETF position(s) from this investing app screenshot. This could be a holdings/portfolio page OR a single trade confirmation/receipt. Return ONLY a valid JSON array with no extra text or explanation, in this exact format:
[
  {"ticker": "AAPL", "name": "Apple Inc.", "shares": 10, "currentPrice": 195.50}
]

Rules:
- ticker: the stock/ETF symbol in uppercase (e.g. AAPL, MSFT, QQQ). If only a company name is visible (no ticker), infer the correct ticker from the company name (e.g. "UnitedHealth Group" → "UNH", "Apple Inc" → "AAPL", "Tesla" → "TSLA")
- name: full company or fund name if visible, otherwise use the ticker
- shares: number of shares. On a trade receipt, look for fields like "Executed quantity", "Quantity", "Units", "Shares". Can be decimal (e.g. 2.001)
- currentPrice: price per share in USD (numbers only, no $ sign). On a trade receipt, look for "Average price", "Execution price", "Price per share". If only total amount is shown, divide total by shares
- If the screenshot is a BUY trade confirmation, extract the one position purchased
- Skip cash, bonds, money market funds, or non-equity instruments
- If you cannot find any valid position, return exactly: []
- Return ONLY the JSON array, nothing else — no markdown, no explanation`
              }
            ]
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 1024 }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error: ${errText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '[]';

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
    res.status(500).json({ error: e.message || 'Failed to scan image. Please try again.' });
  }
}
