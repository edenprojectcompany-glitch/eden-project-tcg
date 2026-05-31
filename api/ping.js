// api/ping.js — Suivi visiteurs en temps réel (ping toutes les 30s depuis le front)
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN
// Env admin : ADMIN_CODE (pour GET)

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const TTL_MS = 90 * 1000; // 90s = visiteur actif

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Code');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { kv } = require('@vercel/kv');
    const now = Date.now();

    // ── POST : ping visiteur ──
    if (req.method === 'POST') {
      const { sessionId, page } = req.body || {};
      if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 64) {
        return res.status(400).json({ error: 'sessionId invalide' });
      }
      const safePage = String(page || 'home').replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'home';
      const member = `${sessionId.slice(0, 32)}|${safePage}`;
      // Sorted set : score = timestamp (ms), member = sessionId|page
      await kv.zadd('visitors:zset', { score: now, member });
      // Cleanup entrées expirées
      await kv.zremrangebyscore('visitors:zset', '-inf', now - TTL_MS);
      return res.status(200).json({ ok: true });
    }

    // ── GET : stats visiteurs (admin uniquement) ──
    if (req.method === 'GET') {
      const code = req.headers['x-admin-code'];
      if (!code || code !== process.env.ADMIN_CODE) {
        return res.status(403).json({ error: 'Accès refusé' });
      }
      await kv.zremrangebyscore('visitors:zset', '-inf', now - TTL_MS);
      const members = await kv.zrange('visitors:zset', 0, -1) || [];
      const count = members.length;
      const pageCounts = {};
      members.forEach(m => {
        const page = (m.split('|')[1] || 'home');
        pageCounts[page] = (pageCounts[page] || 0) + 1;
      });
      return res.status(200).json({ count, pages: pageCounts });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Ping error:', err.message);
    // Ne jamais casser le visiteur si KV est down
    return res.status(200).json({ ok: true });
  }
};
