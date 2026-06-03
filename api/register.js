// api/register.js — Inscription utilisateur avec vérification email
// Env requis : KV_REST_API_URL, KV_REST_API_TOKEN, JWT_SECRET, RESEND_API_KEY

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { sendEmail, verifyEmailHtml, SITE_URL } = require('../lib/email');

const CORS_ORIGIN = process.env.SITE_URL || 'https://edenprojecttcg.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Domaines emails jetables connus
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','guerrillamail.net','guerrillamail.org',
  'guerrillamail.de','guerrillamail.biz','guerrillamail.info','grr.la',
  'sharklasers.com','guerrillamailblock.com','spam4.me','yopmail.com',
  'yopmail.fr','cool.fr.nf','jetable.fr.nf','nospam.ze.tc','nomail.xl.cx',
  'mega.zik.dj','speed.1s.fr','courriel.fr.nf','moncourrier.fr.nf',
  'trashmail.com','trashmail.me','trashmail.net','trashmail.at',
  'trashmail.io','trashmail.xyz','wegwerfmail.de','wegwerfmail.net',
  'wegwerfmail.org','10minutemail.com','10minutemail.net','10minutemail.org',
  '10minutemail.us','10minutemail.de','minutemail.com','mailnull.com',
  'spamgourmet.com','spamgourmet.net','spamgourmet.org','maildrop.cc',
  'mintemail.com','fakeinbox.com','mailnesia.com','tempinbox.com',
  'tempr.email','throwam.com','discard.email','mailtemp.net',
  'temp-mail.org','throwaway.email','tmpmail.net','mohmal.com',
  'armyspy.com','cuvox.de','dayrep.com','einrot.com','fleckens.hu',
  'gustr.com','jourrapide.com','kronem.com','rklips.com','rmqkr.net',
  'teleworm.us','spammotel.com','getairmail.com','filzmail.com',
  'dispostable.com','mailboxy.fun','spamboy.com','tempmail.de',
  'getnada.com','mailsac.com','inboxbear.com','spamwc.de',
  'mucinlung.com','tempinbox.net',
]);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, password, deliveryAddress } = req.body || {};

  if (!name?.trim() || name.trim().length < 2)
    return res.status(400).json({ error: 'Nom invalide (minimum 2 caractères)' });
  if (!email?.trim() || !EMAIL_RE.test(email.trim()))
    return res.status(400).json({ error: 'Adresse e-mail invalide' });
  if (!password || password.length < 8)
    return res.status(400).json({ error: 'Mot de passe trop court (minimum 8 caractères)' });

  const normalizedEmail = email.toLowerCase().trim();
  const domain = normalizedEmail.split('@')[1];

  // Blocage emails jetables
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return res.status(400).json({ error: 'Les adresses email temporaires ne sont pas acceptées. Utilisez une adresse permanente.' });
  }

  const key = `user:${normalizedEmail}`;

  try {
    const { kv } = require('@vercel/kv');

    // Rate limiting : max 5 inscriptions / heure par IP
    const ip = (req.headers['x-vercel-forwarded-for'] || '').trim() ||
               (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const ratKey = `ratelimit:register:${ip}`;
    try {
      const attempts = await kv.incr(ratKey);
      await kv.expire(ratKey, 3600);
      if (attempts > 5) {
        return res.status(429).json({ error: 'Trop d\'inscriptions. Réessayez dans 1 heure.' });
      }
    } catch {}

    const existing = await kv.get(key);
    if (existing) return res.status(409).json({ error: 'Cet e-mail est déjà utilisé' });

    const hash = await bcrypt.hash(password, 12);
    const verifyToken = randomUUID();

    // Nettoyer l'adresse de livraison si fournie
    const cleanAddr = deliveryAddress ? {
      line1:       String(deliveryAddress.line1       || '').slice(0, 100).trim(),
      line2:       String(deliveryAddress.line2       || '').slice(0, 100).trim(),
      postal_code: String(deliveryAddress.postal_code || '').slice(0, 10).trim(),
      city:        String(deliveryAddress.city        || '').slice(0, 60).trim(),
      tel:         String(deliveryAddress.tel         || '').slice(0, 20).trim(),
    } : null;

    const user = {
      id: `usr_${randomUUID()}`,
      name: name.trim(),
      email: normalizedEmail,
      hash,
      createdAt: new Date().toISOString(),
      lastSpin: null,
      orders: [],
      loyalty: 0,
      tokenVersion: 0,
      emailVerified: false,
      deliveryAddress: cleanAddr,
    };
    await kv.set(key, user);

    // Stocker le token de vérification (TTL 24h)
    await kv.set(`verify:${verifyToken}`, normalizedEmail, { ex: 86400 });

    // Envoyer l'email de vérification
    const verifyUrl = `${SITE_URL}?verify_token=${verifyToken}`;
    await sendEmail({
      to: normalizedEmail,
      subject: '✦ Confirme ton adresse — Eden Project TCG',
      html: verifyEmailHtml({ name: user.name, verifyUrl }),
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, tokenVersion: 0 },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, lastSpin: null, loyalty: 0, orders: [], emailVerified: false, deliveryAddress: cleanAddr },
      emailSent: true,
    });
  } catch (err) {
    console.error('Register error:', err.message);
    return res.status(500).json({ error: 'Erreur serveur — réessayez' });
  }
};
