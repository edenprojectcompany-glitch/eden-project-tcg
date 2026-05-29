// api/me.js — Profil utilisateur frais depuis KV (JWT requis)
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN, JWT_SECRET

const jwt = require('jsonwebtoken');
const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!auth) return res.status(401).json({ error: 'Non authentifié' });

  let decoded;
  try {
    decoded = jwt.verify(auth, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token invalide' });
  }

  try {
    const { kv } = require('@vercel/kv');
    const user = await kv.get(`user:${decoded.email}`);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    if (user.tokenVersion != null && decoded.tokenVersion !== user.tokenVersion) {
      return res.status(401).json({ error: 'Session expirée, reconnectez-vous' });
    }

    return res.status(200).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        lastSpin: user.lastSpin,
        loyalty: user.loyalty || 0,
        orders: user.orders || [],
        totalSpent: (user.orders || []).reduce((s, o) => s + parseFloat(o.amount || 0), 0),
      },
    });
  } catch (err) {
    console.error('Me error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
