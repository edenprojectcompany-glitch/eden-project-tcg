// api/forgot-password.js — Demande de reset mot de passe
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN, RESEND_API_KEY, SITE_URL

const { randomUUID } = require('crypto');
const { sendEmail, resetPasswordHtml, SITE_URL } = require('../lib/email');
const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  // Toujours répondre OK pour ne pas révéler si l'email existe
  if (!email || !EMAIL_RE.test(email.trim())) {
    return res.status(200).json({ ok: true });
  }

  try {
    const { kv } = require('@vercel/kv');

    // Rate limiting : 3 demandes / heure par IP
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const ratKey = `ratelimit:forgot:${ip}`;
    try {
      const attempts = await kv.incr(ratKey);
      await kv.expire(ratKey, 3600);
      if (attempts > 3) return res.status(200).json({ ok: true }); // silencieux
    } catch {}

    const normalizedEmail = email.toLowerCase().trim();
    const user = await kv.get(`user:${normalizedEmail}`);
    if (!user) return res.status(200).json({ ok: true }); // silencieux

    // Générer un token reset unique, valable 1h
    const token = randomUUID().replace(/-/g, '');
    await kv.set(`reset:${token}`, normalizedEmail, { ex: 3600 });

    const resetUrl = `${SITE_URL}?reset=${token}`;
    await sendEmail({
      to: normalizedEmail,
      subject: 'Réinitialisation de votre mot de passe — Eden Project TCG',
      html: resetPasswordHtml({ name: user.name, resetUrl }),
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Forgot password error:', err.message);
    return res.status(200).json({ ok: true }); // toujours OK pour ne pas leak
  }
};
