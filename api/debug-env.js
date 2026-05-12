export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    hasResendKey: !!process.env.RESEND_API_KEY,
    hasFeedbackEmail: !!process.env.FEEDBACK_EMAIL,
    geminiLength: process.env.GEMINI_API_KEY?.length || 0,
    geminiPrefix: process.env.GEMINI_API_KEY?.substring(0, 6) || 'none',
    nodeEnv: process.env.NODE_ENV,
    customEnvKeys: Object.keys(process.env).filter(k => !k.startsWith('npm_') && !k.startsWith('VERCEL') && !k.startsWith('NODE') && !k.startsWith('PATH')),
    timestamp: new Date().toISOString()
  });
}
