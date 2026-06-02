// api/request-delete.js — Demande de suppression de compte (envoie email de confirmation)
const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const { sendEmail, deleteAccountEmailHtml, SITE_URL } = require('../lib/email');
const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!auth) return res.status(401).json({ error: 'Non authentifié' });

  let decoded;
  try { decoded = jwt.verify(auth, process.env.JWT_SECRET); } catch {
    return res.status(401).json({ error: 'Session expirée' });
  }

  try {
    const { kv } = require('@vercel/kv');
    const email = decoded.email.toLowerCase().trim();
    const user = await kv.get(`user:${email}`);
    if (!user) return res.status(404).json({ error: 'Compte introuvable' });

    const token = randomUUID();
    // Token valide 1 heure seulement (action sensible)
    await kv.set(`delete:${token}`, email, { ex: 3600 });

    const confirmUrl = `${SITE_URL}?delete_token=${token}`;
    await sendEmail({
      to: email,
      subject: '⚠️ Confirmation de suppression de compte — Eden Project TCG',
      html: deleteAccountEmailHtml({ name: user.name, confirmUrl }),
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Request delete error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
