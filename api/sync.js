const BIN_URL = 'https://api.jsonbin.io/v3/b';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const API_KEY = process.env.JSONBIN_API_KEY;
  const BIN_ID  = process.env.JSONBIN_BIN_ID;

  if (!API_KEY || !BIN_ID) {
    return res.status(500).json({ error: 'Server not configured. Add JSONBIN_API_KEY and JSONBIN_BIN_ID in Vercel environment variables.' });
  }

  // GET → pull latest data
  if (req.method === 'GET') {
    try {
      const r = await fetch(`${BIN_URL}/${BIN_ID}/latest`, {
        headers: { 'X-Master-Key': API_KEY }
      });
      const data = await r.json();
      return res.status(r.status).json(data.record || {});
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // PUT → push data
  if (req.method === 'PUT') {
    try {
      const r = await fetch(`${BIN_URL}/${BIN_ID}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': API_KEY,
          'X-Bin-Versioning': 'false'
        },
        body: JSON.stringify(req.body)
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
