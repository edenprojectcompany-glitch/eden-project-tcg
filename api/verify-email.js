// api/verify-email.js — Validation du token de vérification email
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token manquant' });

  try {
    const { kv } = require('@vercel/kv');
    const tokenKey = `verify:${token}`;
    const email = await kv.get(tokenKey);

    if (!email) {
      return res.status(400).json({ error: 'Lien invalide ou expiré. Reconnecte-toi pour recevoir un nouveau lien.' });
    }

    const userKey = `user:${email}`;
    const user = await kv.get(userKey);
    if (!user) return res.status(404).json({ error: 'Compte introuvable' });

    // Marquer l'email comme vérifié
    user.emailVerified = true;
    await kv.set(userKey, user);

    // Supprimer le token (usage unique)
    await kv.del(tokenKey);

    return res.status(200).json({ ok: true, name: user.name });
  } catch (err) {
    console.error('Verify email error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
