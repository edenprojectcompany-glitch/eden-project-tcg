// api/relay-points.js — Proxy Boxtal GET /listpoints pour relais Chronopost
// Appelé par le frontend checkout quand le client remplit son code postal + ville
// GET /api/relay-points?cp=75001&ville=Paris
// Retourne les 7 relais Chronopost les plus proches, au format simplifié

const https = require('https');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Jours de la semaine en français
const JOURS = ['', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

// Pays desservis par le réseau de relais Chronopost (Chrono Relais Europe)
const ALLOWED_COUNTRIES = new Set(['FR', 'DE', 'BE', 'LU', 'NL', 'ES', 'PT']);

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { cp, ville, pays } = req.query || {};
  if (!cp || !ville) return res.status(400).json({ error: 'cp et ville requis' });

  const paysCode = ALLOWED_COUNTRIES.has(String(pays || '').toUpperCase())
    ? String(pays).toUpperCase()
    : 'FR';

  const ak = process.env.BOXTAL_ACCESS_KEY || '';
  const sk = process.env.BOXTAL_SECRET_KEY || '';
  if (!ak || !sk) return res.status(500).json({ error: 'Clés Boxtal manquantes' });

  const auth = 'Basic ' + Buffer.from(`${ak}:${sk}`).toString('base64');

  const params = new URLSearchParams({
    'pays':        paysCode,
    'cp':          cp.trim(),
    'ville':       ville.trim(),
    'carriers[0]': 'CHRP', // Chronopost uniquement
  });

  const url = `https://www.envoimoinscher.com/api/v1/listpoints?${params.toString()}`;

  try {
    const data = await new Promise((resolve, reject) => {
      const req2 = https.request(url, {
        method:  'GET',
        headers: { 'Authorization': auth, 'Accept': 'application/xml' },
      }, (r) => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => resolve({ status: r.statusCode, body }));
      });
      req2.on('error', reject);
      req2.end();
    });

    if (data.status !== 200) {
      return res.status(200).json({ points: [] }); // pas d'erreur côté client si pas de relais
    }

    // Parsing XML — structure : <carriers><carrier><points><point>…</point></points></carrier></carriers>
    // ou  <points><point>…</point></points> directement selon l'endpoint utilisé
    const xml = data.body;

    const extractAll = (src, tag) => {
      const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
      const out = []; let m;
      while ((m = re.exec(src)) !== null) out.push(m[1]);
      return out;
    };
    const extractVal = (src, tag) => {
      const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)<\\/${tag}>`, 'i');
      const m = src.match(re);
      return m ? m[1].trim() : '';
    };

    const pointBlocks = extractAll(xml, 'point');
    const points = pointBlocks.slice(0, 7).map(block => {
      // Horaires simplifiés : on prend Lun–Sam matin/après-midi
      const days = extractAll(block, 'day');
      const schedule = days.map(d => {
        const weekday  = parseInt(extractVal(d, 'weekday') || '0');
        const openAm   = extractVal(d, 'open_am');
        const closeAm  = extractVal(d, 'close_am');
        const openPm   = extractVal(d, 'open_pm');
        const closePm  = extractVal(d, 'close_pm');
        if (!openAm) return null;
        const horaire  = openPm
          ? `${openAm}–${closeAm} / ${openPm}–${closePm}`
          : `${openAm}–${closeAm}`;
        return `${JOURS[weekday] || ''} ${horaire}`;
      }).filter(Boolean);

      return {
        code:     extractVal(block, 'code'),    // ex: "CHRP-00123"
        name:     extractVal(block, 'name'),
        address:  extractVal(block, 'address'),
        zipcode:  extractVal(block, 'zipcode'),
        city:     extractVal(block, 'city'),
        schedule: schedule.slice(0, 3),          // max 3 lignes d'horaires
      };
    }).filter(p => p.code && p.name);

    return res.status(200).json({ points });

  } catch (err) {
    console.error('relay-points error:', err.message);
    return res.status(200).json({ points: [] }); // fail silently côté client
  }
};
