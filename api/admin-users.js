// api/admin-users.js — Liste des clients inscrits (lecture admin)
// Env requis : ADMIN_CODE, KV_REST_API_URL, KV_REST_API_TOKEN

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Code');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const code = req.headers['x-admin-code'];
  if (!code || code !== process.env.ADMIN_CODE) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  try {
    const { kv } = require('@vercel/kv');
    const keys = await kv.keys('user:*');
    if (!keys.length) return res.status(200).json({ users: [] });

    const records = await kv.mget(...keys);
    const users = records.filter(Boolean).map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      createdAt: u.createdAt,
      emailVerified: !!u.emailVerified,
      lastLoginAt: u.lastLoginAt || null,
      loginCount: u.loginCount || 0,
      loyalty: u.loyalty || 0,
      deliveryAddress: u.deliveryAddress || null,
      orders: (u.orders || []).map(o => ({
        ref: o.ref,
        amount: o.amount,
        status: o.status,
        provider: o.provider,
        createdAt: o.createdAt,
        promoCode: o.promoCode || '',
        items: o.items || [],
      })),
      wonCodes: u.wonCodes || [],
    }));

    users.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.status(200).json({ users });
  } catch (err) {
    console.error('Admin users error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
