// api/resend-verify.js — Renvoi email de vérification
const { randomUUID } = require('crypto');
const { sendEmail, verifyEmailHtml, SITE_URL } = require('../lib/email');
const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email requis' });

  try {
    const { kv } = require('@vercel/kv');
    const normalizedEmail = email.toLowerCase().trim();
    const user = await kv.get(`user:${normalizedEmail}`);
    if (!user || user.emailVerified) return res.status(200).json({ ok: true }); // silencieux

    const token = randomUUID();
    await kv.set(`verify:${token}`, normalizedEmail, { ex: 86400 });
    const verifyUrl = `${SITE_URL}?verify_token=${token}`;
    await sendEmail({
      to: normalizedEmail,
      subject: '✦ Confirme ton adresse — Eden Project TCG',
      html: verifyEmailHtml({ name: user.name, verifyUrl }),
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};
