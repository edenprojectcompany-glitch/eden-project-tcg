// api/register.js — Inscription utilisateur (Vercel KV + bcrypt + JWT)
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN, JWT_SECRET

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, password } = req.body || {};

  if (!name?.trim() || name.trim().length < 2) {
    return res.status(400).json({ error: 'Nom invalide (minimum 2 caractères)' });
  }
  if (!email?.trim() || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Adresse e-mail invalide' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Mot de passe trop court (minimum 8 caractères)' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const key = `user:${normalizedEmail}`;

  try {
    const { kv } = require('@vercel/kv');

    // Rate limiting : max 5 inscriptions / heure par IP
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const ratKey = `ratelimit:register:${ip}`;
    try {
      const attempts = await kv.incr(ratKey);
      await kv.expire(ratKey, 3600); // toujours reset — évite une clé bloquée si expire a échoué
      if (attempts > 5) {
        return res.status(429).json({ error: 'Trop d\'inscriptions. Réessayez dans 1 heure.' });
      }
    } catch {}

    const existing = await kv.get(key);
    if (existing) return res.status(409).json({ error: 'Cet e-mail est déjà utilisé' });

    const hash = await bcrypt.hash(password, 12);
    const user = {
      id: `usr_${randomUUID()}`,
      name: name.trim(),
      email: normalizedEmail,
      hash,
      createdAt: new Date().toISOString(),
      lastSpin: null,
      orders: [],
      loyalty: 0,
    };
    await kv.set(key, user);

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    return res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, lastSpin: null, loyalty: 0 },
    });
  } catch (err) {
    console.error('Register error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur — réessayez' });
  }
};
