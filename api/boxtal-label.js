// api/boxtal-label.js — Proxy PDF bordereau Boxtal (auth serveur-side)
// GET /api/boxtal-label?ref=EDN-XXX  + header X-Admin-Code
// → récupère le label_url depuis KV, le télécharge avec les credentials Boxtal,
//   et le stream en PDF vers l'admin sans exposer l'URL Boxtal.

const https = require('https');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Code');
}

function boxtalAuth() {
  const ak = process.env.BOXTAL_ACCESS_KEY || '';
  const sk = process.env.BOXTAL_SECRET_KEY || '';
  if (!ak || !sk) throw new Error('Credentials Boxtal manquants');
  return 'Basic ' + Buffer.from(`${ak}:${sk}`).toString('base64');
}

// Télécharge une URL en suivant les redirects (max 3), retourne le buffer final
function fetchWithRedirects(url, auth, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl, remaining) => {
      const parsedUrl = new URL(currentUrl);
      const options = {
        hostname: parsedUrl.hostname,
        path:     parsedUrl.pathname + parsedUrl.search,
        method:   'GET',
        headers:  { 'Authorization': auth, 'Accept': 'application/pdf,*/*' },
      };
      const mod = parsedUrl.protocol === 'https:' ? https : require('http');
      const req = mod.request(options, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && remaining > 0) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${parsedUrl.protocol}//${parsedUrl.host}${res.headers.location}`;
          res.resume();
          return attempt(next, remaining - 1);
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    };
    attempt(url, maxRedirects);
  });
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  // Auth admin
  const code = req.headers['x-admin-code'];
  if (!code || code !== process.env.ADMIN_CODE) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  const { ref } = req.query || {};
  if (!ref) return res.status(400).json({ error: 'ref manquante' });

  try {
    const { kv } = require('@vercel/kv');
    const orders = await kv.get('orders:global') || [];
    const order  = orders.find(o => o.ref === ref);

    if (!order) return res.status(404).json({ error: 'Commande introuvable' });
    if (!order.labelUrl) return res.status(404).json({ error: 'Bordereau non encore disponible' });

    // Télécharger le PDF depuis Boxtal avec auth serveur
    const auth = boxtalAuth();
    const result = await fetchWithRedirects(order.labelUrl, auth);

    if (result.status !== 200) {
      return res.status(502).json({ error: `Boxtal a retourné HTTP ${result.status}` });
    }

    // Streamer le PDF vers le navigateur admin
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="bordereau-${ref}.pdf"`);
    res.setHeader('Content-Length', result.body.length);
    return res.status(200).send(result.body);

  } catch (err) {
    console.error('boxtal-label error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur : ' + err.message });
  }
};
