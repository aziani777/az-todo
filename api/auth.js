import crypto from 'crypto';

const USERS_BIN_URL = 'https://api.jsonbin.io/v3/b';
const USERS_BIN_ID = process.env.USERS_BIN_ID;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'aztodo-secret-change-me';

function hashPassword(password) {
  return crypto.createHmac('sha256', JWT_SECRET).update(password).digest('hex');
}

function createToken(email) {
  const payload = { email, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }; // 30 days
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('hex');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  try {
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('hex');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

async function getUsers() {
  if (!USERS_BIN_ID) return {};
  try {
    const r = await fetch(`${USERS_BIN_URL}/${USERS_BIN_ID}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_API_KEY }
    });
    const d = await r.json();
    return d.record?.users || {};
  } catch { return {}; }
}

async function saveUsers(users) {
  if (!USERS_BIN_ID) return;
  await fetch(`${USERS_BIN_URL}/${USERS_BIN_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY, 'X-Bin-Versioning': 'false' },
    body: JSON.stringify({ users })
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, email, password, token } = req.body || {};

  // Verify token
  if (action === 'verify') {
    if (!token) return res.status(401).json({ ok: false });
    const payload = verifyToken(token);
    return res.status(200).json({ ok: !!payload, email: payload?.email });
  }

  // Google Sign-In
  if (action === 'google') {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: 'Missing Google credential' });
    try {
      // Verify ID token with Google's tokeninfo endpoint
      const gr = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
      const info = await gr.json();
      if (info.error) return res.status(401).json({ error: 'Invalid Google token' });
      // Verify audience matches our client ID
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (clientId && info.aud !== clientId) return res.status(401).json({ error: 'Token audience mismatch' });
      const googleEmail = info.email?.toLowerCase();
      if (!googleEmail) return res.status(401).json({ error: 'No email in Google token' });
      // Create user if not exists (no password needed for Google users)
      if (USERS_BIN_ID) {
        const users = await getUsers();
        if (!users[googleEmail]) {
          users[googleEmail] = { email: googleEmail, provider: 'google', created: new Date().toISOString() };
          saveUsers(users).catch(()=>{}); // fire-and-forget
        }
      }
      const t = createToken(googleEmail);
      return res.status(200).json({ ok: true, token: t, email: googleEmail });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const emailLower = email.toLowerCase().trim();
  const hashed = hashPassword(password);

  if (action === 'signup') {
    if (!USERS_BIN_ID) return res.status(500).json({ error: 'USERS_BIN_ID not configured' });
    const users = await getUsers();
    if (users[emailLower]) return res.status(409).json({ error: 'Account already exists' });
    users[emailLower] = { email: emailLower, password: hashed, created: new Date().toISOString() };
    saveUsers(users).catch(()=>{}); // fire-and-forget — token is self-contained
    const t = createToken(emailLower);
    return res.status(200).json({ ok: true, token: t, email: emailLower });
  }

  if (action === 'login') {
    if (!USERS_BIN_ID) return res.status(500).json({ error: 'USERS_BIN_ID not configured' });
    const users = await getUsers();
    const user = users[emailLower];
    if (!user || user.password !== hashed) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const t = createToken(emailLower);
    return res.status(200).json({ ok: true, token: t, email: emailLower });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
