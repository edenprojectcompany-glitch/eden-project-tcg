// api/login.js — Connexion utilisateur
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN, JWT_SECRET

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Données invalides' });

  try {
    const { kv } = require('@vercel/kv');

    // Rate limiting : max 10 tentatives / 15 min par IP
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const ratKey = `ratelimit:login:${ip}`;
    try {
      const attempts = await kv.incr(ratKey);
      await kv.expire(ratKey, 900); // toujours reset — évite une clé bloquée si expire a échoué
      if (attempts > 10) {
        return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
      }
    } catch {}

    const key = `user:${email.toLowerCase().trim()}`;
    const user = await kv.get(key);
    if (!user) return res.status(401).json({ error: 'E-mail ou mot de passe incorrect' });

    const ok = await bcrypt.compare(password, user.hash);
    if (!ok) return res.status(401).json({ error: 'E-mail ou mot de passe incorrect' });

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, tokenVersion: user.tokenVersion || 0 },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    return res.status(200).json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email,
        lastSpin: user.lastSpin, loyalty: user.loyalty || 0,
        orders: user.orders || [],
      },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
