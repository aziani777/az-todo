const TIMEZONE = 'Europe/Paris';

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

function toYMD(isoString) {
  if (!isoString) return null;
  if (isoString.length === 10) return isoString;
  const d = new Date(isoString);
  return new Intl.DateTimeFormat('fr-CA', { timeZone: TIMEZONE, year:'numeric', month:'2-digit', day:'2-digit' }).format(d);
}

function toHHMM(isoString) {
  if (!isoString || isoString.length === 10) return '';
  const d = new Date(isoString);
  const parts = new Intl.DateTimeFormat('fr-FR', { timeZone: TIMEZONE, hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(d);
  const h = parts.find(p => p.type === 'hour')?.value || '00';
  const m = parts.find(p => p.type === 'minute')?.value || '00';
  return `${h}:${m}`;
}

function stripHtml(str) {
  if (!str) return '';
  return str.replace(/<br\s*\/?>/gi,' ').replace(/<li>/gi,'• ').replace(/<\/li>/gi,' ').replace(/<[^>]+>/g,'')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
}

function guessSection(summary, workspaces) {
  if (!workspaces.length) return 'perso';
  const lower = (summary || '').toLowerCase();
  for (const ws of workspaces) { if (lower.includes(ws.label.toLowerCase())) return ws.id; }
  return workspaces[0].id;
}

// Build a GCal event body from a Nowera meeting object
function buildGCalEvent(meeting) {
  const { title, date, time, notes } = meeting;
  if (time) {
    // Timed event
    const [h, m] = time.split(':').map(Number);
    const startDt = new Date(`${date}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);
    const endDt = new Date(startDt.getTime() + 60 * 60 * 1000); // 1 hour default
    return {
      summary: title,
      description: notes || '',
      start: { dateTime: startDt.toISOString().replace('.000Z', '+00:00'), timeZone: TIMEZONE },
      end:   { dateTime: endDt.toISOString().replace('.000Z', '+00:00'),   timeZone: TIMEZONE },
    };
  } else {
    // All-day event
    return {
      summary: title,
      description: notes || '',
      start: { date },
      end:   { date },
    };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not set' });

  const { action = 'fetch', workspaces = [], dateFrom, dateTo, meeting, gcalId } = req.body || {};

  try {
    const accessToken = await getAccessToken();
    const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

    // ── CREATE ──────────────────────────────────────────────────────────────
    if (action === 'create') {
      if (!meeting) return res.status(400).json({ error: 'meeting required' });
      const body = buildGCalEvent(meeting);
      const r = await fetch(CAL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d });
      return res.status(200).json({ gcalId: d.id });
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────
    if (action === 'update') {
      if (!gcalId || !meeting) return res.status(400).json({ error: 'gcalId and meeting required' });
      const body = buildGCalEvent(meeting);
      const r = await fetch(`${CAL}/${gcalId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d });
      return res.status(200).json({ ok: true });
    }

    // ── DELETE ──────────────────────────────────────────────────────────────
    if (action === 'delete') {
      if (!gcalId) return res.status(400).json({ error: 'gcalId required' });
      const r = await fetch(`${CAL}/${gcalId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (r.status === 404 || r.status === 410) return res.status(200).json({ ok: true }); // already gone
      if (!r.ok) return res.status(r.status).json({ error: await r.text() });
      return res.status(200).json({ ok: true });
    }

    // ── FETCH (default) ─────────────────────────────────────────────────────
    const timeMin = new Date(dateFrom || new Date()).toISOString();
    const timeMax = new Date(dateTo || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)).toISOString();
    const calRes = await fetch(
      `${CAL}?` + new URLSearchParams({ timeMin, timeMax, timeZone: TIMEZONE, singleEvents:'true', orderBy:'startTime', maxResults:'50' }),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!calRes.ok) return res.status(calRes.status).json({ error: await calRes.text() });
    const calData = await calRes.json();
    const events = (calData.items || [])
      .filter(ev => ev.status !== 'cancelled')
      .map(ev => {
        const start = ev.start?.dateTime || ev.start?.date || '';
        const date = toYMD(start), time = toHHMM(start);
        const notes = [stripHtml(ev.location||''), stripHtml(ev.description||'')].filter(Boolean).join(' · ').slice(0,120);
        return { title: ev.summary||'(No title)', date, time, section: guessSection(ev.summary, workspaces), notes, gcalId: ev.id };
      })
      .filter(ev => ev.date);
    return res.status(200).json({ events });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
