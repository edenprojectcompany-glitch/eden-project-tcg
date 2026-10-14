// api/spin.js — Booster cadeau (ex-roue de la fortune) : tirage simple, mêmes règles que /vault (lib/gift.js)
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN, JWT_SECRET

const jwt = require('jsonwebtoken');
const { giftTable, pickGift, awardGift } = require('../lib/gift');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

// Ancienne roue remplacée par le booster cadeau : gains et règles dans lib/gift.js

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!auth) return res.status(401).json({ error: 'Non authentifié' });

  let decoded;
  try {
    decoded = jwt.verify(auth, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token invalide' });
  }
  if (!decoded?.email) return res.status(401).json({ error: 'Token invalide' });

  try {
    const { kv } = require('@vercel/kv');
    const key = `user:${decoded.email.toLowerCase().trim()}`;
    const lockKey = `spin:lock:${decoded.email.toLowerCase().trim()}`;

    // Lock atomique anti race-condition (NX = set if not exists, expire 15s)
    const locked = await kv.set(lockKey, '1', { ex: 15, nx: true });
    if (!locked) {
      return res.status(429).json({ error: 'Tirage déjà en cours, réessayez dans quelques secondes.' });
    }

    try {
      const user = await kv.get(key);
      if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

      // Vérification tokenVersion
      if (user.tokenVersion != null && decoded.tokenVersion !== user.tokenVersion) {
        return res.status(401).json({ error: 'Session expirée, reconnectez-vous' });
      }

      // Roue verrouillée jusqu'au premier achat
      if (!user.orders || user.orders.length === 0) {
        return res.status(403).json({ error: 'La roue se débloque après votre premier achat !' });
      }

      // Cooldown basé sur le tier VIP
      const totalSpent = (user.orders || []).reduce((s, o) => s + parseFloat(o.amount || 0), 0);
      let cooldownMs;
      if (totalSpent >= 5000) cooldownMs = 24 * 60 * 60 * 1000;       // Diamond : quotidien
      else if (totalSpent >= 1500) cooldownMs = 7 * 24 * 60 * 60 * 1000;  // Gold : hebdomadaire
      else cooldownMs = 30 * 24 * 60 * 60 * 1000;                      // Silver/Bronze : mensuel

      const now = Date.now();
      if (user.lastSpin) {
        const elapsed = now - new Date(user.lastSpin).getTime();
        if (elapsed < cooldownMs) {
          return res.status(429).json({
            error: 'Prochain tirage disponible le',
            nextSpin: new Date(new Date(user.lastSpin).getTime() + cooldownMs).toISOString(),
            cooldownMs,
          });
        }
      }

      // Gains du booster cadeau (réglables dans l'admin, clé admin:gift) — mêmes règles que /vault
      const wheel = await giftTable(kv);
      const prize = pickGift(wheel, Math.random());
      const winIndex = wheel.indexOf(prize);

      // Code à usage unique, valable 30 jours ; points fidélité inchangés
      awardGift(user, prize);
      user.loyalty = (user.loyalty || 0) + 10 + (prize.code ? 20 : 0);

      await kv.set(key, user);

      return res.status(200).json({ prize, winIndex, wheelConfig: wheel });
    } finally {
      // Libérer le lock dans tous les cas
      await kv.del(lockKey).catch(() => {});
    }
  } catch (err) {
    console.error('Spin error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
