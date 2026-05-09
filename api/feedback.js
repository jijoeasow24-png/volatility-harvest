export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, message, rating } = req.body || {};
  if (!name || !message) return res.status(400).json({ error: 'Name and message are required' });

  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.FEEDBACK_EMAIL;
  if (!apiKey || !toEmail) return res.status(500).json({ error: 'Email service not configured' });

  const stars = rating ? '⭐'.repeat(parseInt(rating)) + ` (${rating}/5)` : 'Not rated';
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1e293b;padding:24px;border-radius:12px 12px 0 0">
        <h2 style="color:#fff;margin:0">💬 New Feedback</h2>
        <p style="color:#94a3b8;margin:4px 0 0">VolatilityHarvest App</p>
      </div>
      <div style="background:#f8fafc;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#64748b;font-size:13px;width:80px">From</td><td style="padding:8px 0;font-weight:600">${name}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;font-size:13px">Rating</td><td style="padding:8px 0">${stars}</td></tr>
        </table>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0"/>
        <p style="color:#64748b;font-size:13px;margin:0 0 8px">Message</p>
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;font-size:15px;line-height:1.6;white-space:pre-wrap">${message}</div>
        <p style="color:#94a3b8;font-size:11px;margin:16px 0 0;text-align:center">Sent from VolatilityHarvest · ${new Date().toUTCString()}</p>
      </div>
    </div>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        from: 'VolatilityHarvest <onboarding@resend.dev>',
        to: [toEmail],
        subject: `💬 VH Feedback from ${name}${rating ? ` — ${rating}/5 ⭐` : ''}`,
        html
      })
    });
    if (!r.ok) { const t = await r.text(); throw new Error(t); }
    res.json({ success: true });
  } catch (e) {
    console.error('Feedback send error:', e.message);
    res.status(500).json({ error: 'Failed to send. Please try again.' });
  }
}
