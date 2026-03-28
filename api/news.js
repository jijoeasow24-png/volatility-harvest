export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker param required' });
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${ticker.toUpperCase()}&newsCount=6&enableFuzzyQuery=false`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
    const json = await resp.json();
    const news = (json?.news || []).map(item => ({
      id: item.uuid, ticker: ticker.toUpperCase(), title: item.title,
      publisher: item.publisher, url: item.link, publishedAt: item.providerPublishTime
    })).filter(n => n.id && n.title);
    return res.status(200).json(news);
  } catch (e) { return res.status(200).json([]); }
}
