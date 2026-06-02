// api/confirm-delete.js — Suppression définitive du compte
const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token manquant' });

  try {
    const { kv } = require('@vercel/kv');
    const tokenKey = `delete:${token}`;
    const email = await kv.get(tokenKey);

    if (!email) {
      return res.status(400).json({ error: 'Lien invalide ou expiré (1h max).' });
    }

    // Supprimer le compte et le token (usage unique)
    await Promise.all([
      kv.del(`user:${email}`),
      kv.del(tokenKey),
    ]);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Confirm delete error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
