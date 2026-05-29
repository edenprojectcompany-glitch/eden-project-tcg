// api/admin.js — Panneau admin sécurisé (prix, stocks, roue)
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN, ADMIN_CODE

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Code');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const code = req.headers['x-admin-code'];
  if (!code || code !== process.env.ADMIN_CODE) {
    // Rate limiting sur les tentatives échouées : 10 / 15 min par IP
    try {
      const { kv } = require('@vercel/kv');
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const ratKey = `ratelimit:admin:${ip}`;
      const attempts = await kv.incr(ratKey);
      await kv.expire(ratKey, 900);
      if (attempts > 10) {
        return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
      }
    } catch {}
    return res.status(403).json({ error: 'Accès refusé' });
  }

  try {
    const { kv } = require('@vercel/kv');

    if (req.method === 'GET') {
      const [prices, stocks, wheel, flashsale] = await Promise.all([
        kv.get('admin:prices'),
        kv.get('admin:stocks'),
        kv.get('admin:wheel'),
        kv.get('admin:flashsale'),
      ]);
      return res.status(200).json({
        prices: prices || {},
        stocks: stocks || {},
        wheel: wheel || null,
        flashsale: flashsale || {},
      });
    }

    if (req.method === 'POST') {
      const { action, data } = req.body || {};

      if (action === 'set_prices') {
        if (typeof data !== 'object' || Array.isArray(data)) {
          return res.status(400).json({ error: 'Format invalide' });
        }
        const validated = {};
        for (const [k, v] of Object.entries(data)) {
          const price = parseFloat(v);
          if (!isNaN(price) && price >= 0 && price <= 10000) {
            validated[String(parseInt(k))] = +price.toFixed(2);
          }
        }
        await kv.set('admin:prices', validated);
        return res.status(200).json({ ok: true });
      }

      if (action === 'set_stocks') {
        if (typeof data !== 'object' || Array.isArray(data)) {
          return res.status(400).json({ error: 'Format invalide' });
        }
        const validated = {};
        for (const [k, v] of Object.entries(data)) {
          const stock = parseInt(v);
          if (!isNaN(stock) && stock >= 0 && stock <= 100000) {
            validated[String(parseInt(k))] = stock;
          }
        }
        await kv.set('admin:stocks', validated);
        return res.status(200).json({ ok: true });
      }

      if (action === 'set_flashsale') {
        if (typeof data !== 'object' || Array.isArray(data)) {
          return res.status(400).json({ error: 'Format invalide' });
        }
        const validated = {};
        for (const [k, v] of Object.entries(data)) {
          const id = parseInt(k);
          if (isNaN(id)) continue;
          validated[id] = {
            active: !!v.active,
            salePrice: v.salePrice != null ? +parseFloat(v.salePrice).toFixed(2) : null,
            endTime: v.endTime ? parseInt(v.endTime) : null,
          };
        }
        await kv.set('admin:flashsale', validated);
        return res.status(200).json({ ok: true });
      }

      if (action === 'set_wheel') {
        if (!Array.isArray(data) || data.length < 2 || data.length > 16) {
          return res.status(400).json({ error: 'Format roue invalide' });
        }
        const total = data.reduce((s, p) => s + (parseFloat(p.prob) || 0), 0);
        if (Math.abs(total - 100) > 0.1) {
          return res.status(400).json({ error: `Probabilités = ${total.toFixed(1)}% (doit être 100%)` });
        }
        const validated = data.map(p => ({
          label: String(p.label).slice(0, 50),
          prob: +(parseFloat(p.prob).toFixed(2)),
          code: p.code ? String(p.code).slice(0, 20) : null,
          color: /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : '#1a1a28',
        }));
        await kv.set('admin:wheel', validated);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Action inconnue' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Admin error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
