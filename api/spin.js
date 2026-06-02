// api/spin.js — Roue de la fortune (30 jours entre chaque tirage)
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN, JWT_SECRET

const jwt = require('jsonwebtoken');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

const DEFAULT_WHEEL = [
  { label: '-5% CODE: EDEN5',     prob: 35,  code: 'EDEN5',        color: '#7fd9ff' },
  { label: '-10% CODE: EDEN10',   prob: 28,  code: 'EDEN10',       color: '#c9a8ff' },
  { label: 'Livraison offerte',   prob: 15,  code: 'SHIP0',        color: '#a8ffd4' },
  { label: '-15% CODE: TCG15',    prob: 10,  code: 'TCG15',        color: '#ffb3e6' },
  { label: 'Booster offert',      prob: 7,   code: 'BOOSTER',      color: '#ffd97f' },
  { label: '-20% CODE: EDEN20',   prob: 4,   code: 'EDEN20',       color: '#ff9fa8' },
  { label: '🎁 Display gratuite', prob: 1,   code: 'FREE_DISPLAY', color: '#ff7a7a' },
];

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

      // Wheel config (admin-overridable)
      const wheelRaw = await kv.get('admin:wheel');
      const wheel = wheelRaw || DEFAULT_WHEEL;

      // Validation : si la somme des probs != 100, on repasse sur la roue par défaut
      // (évite que le dernier segment soit systématiquement favorisé en cas de mauvaise config)
      const probSum = wheel.reduce((s, seg) => s + (seg.prob || 0), 0);
      const safeWheel = Math.abs(probSum - 100) < 0.01 ? wheel : DEFAULT_WHEEL;
      if (Math.abs(probSum - 100) >= 0.01) {
        console.warn(`admin:wheel prob sum = ${probSum} (expected 100) — fallback DEFAULT_WHEEL`);
      }

      // Weighted random draw
      const rand = Math.random() * 100;
      let cumul = 0, winIndex = safeWheel.length - 1;
      for (let i = 0; i < safeWheel.length; i++) {
        cumul += safeWheel[i].prob;
        if (rand <= cumul) { winIndex = i; break; }
      }
      const prize = safeWheel[winIndex];

      // Persist lastSpin + loyalty points
      user.lastSpin = new Date().toISOString();
      user.loyalty = (user.loyalty || 0) + 10;
      if (prize.code) user.loyalty += 20;

      // Stocker tous les codes gagnés (pour affichage dashboard + validation WHEEL_ONLY)
      if (prize.code) {
        user.wonCodes = user.wonCodes || [];
        user.wonCodes.push({ code: prize.code, wonAt: new Date().toISOString(), used: false, reserved: false });
        if (user.wonCodes.length > 30) user.wonCodes = user.wonCodes.slice(-30);
      }

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
