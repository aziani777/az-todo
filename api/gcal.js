const TIMEZONE = 'Europe/Paris'; // UTC+1 winter, UTC+2 summer (same as Oslo/Brussels)

async function getAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(d));
  return d.access_token;
}

// Extract date in Paris timezone
function toYMD(isoString) {
  if (!isoString) return null;
  // All-day events already have YYYY-MM-DD format
  if (isoString.length === 10) return isoString;
  const d = new Date(isoString);
  // Format in Paris timezone
  const parts = new Intl.DateTimeFormat('fr-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
  return parts; // returns YYYY-MM-DD
}

// Extract HH:MM in Paris timezone
function toHHMM(isoString) {
  if (!isoString || isoString.length === 10) return ''; // all-day
  const d = new Date(isoString);
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: TIMEZONE,
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(d);
  const h = parts.find(p => p.type === 'hour')?.value || '00';
  const m = parts.find(p => p.type === 'minute')?.value || '00';
  return `${h}:${m}`;
}

// Strip HTML tags and decode common entities
function stripHtml(str) {
  if (!str) return '';
  return str
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<li>/gi, '• ')
    .replace(/<\/li>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function guessSection(summary, workspaces) {
  if (!workspaces.length) return 'perso';
  const lower = (summary || '').toLowerCase();
  for (const ws of workspaces) {
    if (lower.includes(ws.label.toLowerCase())) return ws.id;
  }
  return workspaces[0].id;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not set' });

  const { workspaces = [], dateFrom, dateTo } = req.body || {};

  try {
    const accessToken = await getAccessToken();

    const timeMin = new Date(dateFrom || new Date()).toISOString();
    const timeMax = new Date(dateTo || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)).toISOString();

    const calRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
      new URLSearchParams({
        timeMin,
        timeMax,
        timeZone: TIMEZONE,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '50',
      }),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!calRes.ok) {
      const e = await calRes.text();
      return res.status(calRes.status).json({ error: e });
    }

    const calData = await calRes.json();
    const items = calData.items || [];

    const events = items
      .filter(ev => ev.status !== 'cancelled')
      .map(ev => {
        const start = ev.start?.dateTime || ev.start?.date || '';
        const date = toYMD(start);
        const time = toHHMM(start);
        // Clean HTML from description, combine with location
        const location = stripHtml(ev.location || '');
        const description = stripHtml(ev.description || '');
        const notes = [location, description].filter(Boolean).join(' · ').slice(0, 120);
        return {
          title: ev.summary || '(No title)',
          date,
          time,
          section: guessSection(ev.summary, workspaces),
          notes,
          gcalId: ev.id,
        };
      })
      .filter(ev => ev.date);

    return res.status(200).json({ events });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
