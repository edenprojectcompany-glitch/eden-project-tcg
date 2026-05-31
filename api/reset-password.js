// api/reset-password.js — Application du nouveau mot de passe
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN, JWT_SECRET

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, password } = req.body || {};
  if (!token || typeof token !== 'string' || token.length > 64) {
    return res.status(400).json({ error: 'Token invalide' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Mot de passe trop court (minimum 8 caractères)' });
  }

  try {
    const { kv } = require('@vercel/kv');

    // Rate limiting : 10 tentatives / 15 min par IP
    const ip = (req.headers['x-vercel-forwarded-for'] || '').trim() || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    try {
      const attempts = await kv.incr(`ratelimit:reset:${ip}`);
      await kv.expire(`ratelimit:reset:${ip}`, 900);
      if (attempts > 10) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
    } catch {}

    // Récupérer l'email lié au token (TTL 1h géré par KV)
    const email = await kv.get(`reset:${token}`);
    if (!email) {
      return res.status(400).json({ error: 'Lien expiré ou invalide. Faites une nouvelle demande.' });
    }

    // Verrou atomique NX : seule la première requête peut consommer ce token
    // Protège contre la race condition (deux requêtes simultanées avec le même lien)
    const lockKey = `reset:lock:${token}`;
    const locked = await kv.set(lockKey, 1, { nx: true, ex: 60 });
    if (!locked) {
      return res.status(409).json({ error: 'Requête déjà en cours, veuillez patienter.' });
    }

    // Supprimer le token reset immédiatement (usage unique, avant toute écriture)
    await kv.del(`reset:${token}`);

    const key = `user:${email}`;
    const user = await kv.get(key);
    if (!user) return res.status(404).json({ error: 'Compte introuvable' });

    // Mettre à jour le hash + incrémenter tokenVersion (invalide tous les JWT existants)
    user.hash = await bcrypt.hash(password, 12);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await kv.set(key, user);

    // Retourner un nouveau JWT valide immédiatement
    const newToken = jwt.sign(
      { id: user.id, email: user.email, name: user.name, tokenVersion: user.tokenVersion },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.status(200).json({
      ok: true,
      token: newToken,
      user: { id: user.id, name: user.name, email: user.email, lastSpin: user.lastSpin, loyalty: user.loyalty || 0, orders: user.orders || [] },
    });
  } catch (err) {
    console.error('Reset password error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
