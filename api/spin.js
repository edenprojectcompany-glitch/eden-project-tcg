// api/spin.js — Roue de la fortune (30 jours entre chaque tirage)
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN, JWT_SECRET

const jwt = require('jsonwebtoken');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

const DEFAULT_WHEEL = [
  { label: 'Tentez encore',       prob: 44,  code: null,           color: '#1a1a28' },
  { label: '-5% CODE: EDEN5',     prob: 21,  code: 'EDEN5',        color: '#7fd9ff' },
  { label: '-10% CODE: EDEN10',   prob: 14,  code: 'EDEN10',       color: '#c9a8ff' },
  { label: 'Livraison offerte',   prob: 9,   code: 'SHIP0',        color: '#a8ffd4' },
  { label: '-15% CODE: TCG15',    prob: 6,   code: 'TCG15',        color: '#ffb3e6' },
  { label: 'Booster offert',      prob: 3.5, code: 'BOOSTER',      color: '#ffd97f' },
  { label: '-20% CODE: EDEN20',   prob: 2,   code: 'EDEN20',       color: '#ff9fa8' },
  { label: '🎁 Display gratuite', prob: 0.5, code: 'FREE_DISPLAY', color: '#ff7a7a' },
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

  try {
    const { kv } = require('@vercel/kv');
    const key = `user:${decoded.email}`;
    const user = await kv.get(key);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    if (user.lastSpin) {
      const elapsed = now - new Date(user.lastSpin).getTime();
      if (elapsed < THIRTY_DAYS) {
        return res.status(429).json({
          error: 'Prochain tirage disponible le',
          nextSpin: new Date(new Date(user.lastSpin).getTime() + THIRTY_DAYS).toISOString(),
        });
      }
    }

    // Wheel config (admin-overridable)
    const wheelRaw = await kv.get('admin:wheel');
    const wheel = wheelRaw || DEFAULT_WHEEL;

    // Weighted random draw — fallback sur dernier segment si les probs < 100 par drift float
    const rand = Math.random() * 100;
    let cumul = 0, winIndex = wheel.length - 1;
    for (let i = 0; i < wheel.length; i++) {
      cumul += wheel[i].prob;
      if (rand <= cumul) { winIndex = i; break; }
    }
    const prize = wheel[winIndex];

    // Persist lastSpin + loyalty points
    user.lastSpin = new Date().toISOString();
    user.loyalty = (user.loyalty || 0) + 10;
    if (prize.code) user.loyalty += 20;
    await kv.set(key, user);

    return res.status(200).json({ prize, winIndex, wheelConfig: wheel });
  } catch (err) {
    console.error('Spin error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
