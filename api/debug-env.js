export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    keyLength: process.env.GEMINI_API_KEY?.length || 0,
    keyPrefix: process.env.GEMINI_API_KEY?.substring(0, 6) || 'none',
    nodeEnv: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
}
